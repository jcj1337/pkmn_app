/**
 * Recommended Buy Price.
 *
 * A direct port of the methodology in analysis/recommended_buy_analysis.py,
 * which remains the source of truth. Constants and gate order are reproduced
 * exactly; scripts/check-pricing-parity.cjs asserts the two agree on every
 * group in the saved dataset.
 *
 * Two deliberately separate stages:
 *
 *   Stage A  Market Reference  — where comparable cards are currently trading
 *   Stage B  Recommended Buy   — reference minus an evidence-based margin
 *
 * Stage A is gated. A group of comps that disagrees with itself gets no price
 * at all, only a named reason. That matters more than the formula: the saved
 * data contains groups whose sales range from $9.85 to $2,152 for the same
 * nominal card, and averaging those produces a confident number that is wrong.
 *
 * Nothing here knows about React, eBay or Apify. It receives one comparable
 * group's sales — already selected and grouped by comparableGroup() — plus
 * the TCGplayer figures, and returns a decision.
 */

import type { PriceHistoryPoint } from "./tcg-price-history";

/* --- policy constants: ported verbatim, not re-tuned ------------------- */
const MIN_COMPS = 3; // below this we refuse to publish a price
const MAX_SPREAD = 1.0; // IQR/median above this means the comps disagree
const MAX_SPLIT_RATIO = 3.0; // upper-half / lower-half median => two products
const MAX_DISAGREEMENT = 0.5; // beyond this the sources describe different cards
const BLEND_K = 5.0; // eBay earns half the weight at 5 comps
const RECENT_DAYS = 30; // "recent" window for recency
const BASE_MARGIN = 0.05; // floor: fee/shipping friction on a resale
const MAX_MARGIN = 0.25; // cap: never recommend below 75% of reference

const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ types */

/** One comparable sale. Already filtered to a single comparable group. */
export interface ComparableSale {
  itemId: string;
  title: string;
  soldPrice: number;
  soldDate: string | null;
  isGraded: boolean;
}

export interface RecommendedBuyInput {
  /** comparableGroup() key, carried through for traceability. */
  groupKey: string;
  sales: ComparableSale[];
  tcgMarketPrice: number | null;
  history: PriceHistoryPoint[] | null;
  /** Evaluation date. Injectable so parity tests can pin the dataset's date. */
  asOf: Date;
}

export type RefusalReason =
  | "TOO_FEW_COMPS"
  | "MIXED_POPULATION"
  | "COMPS_DISAGREE"
  | "SOURCE_CONFLICT"
  /** The lookup worked and returned nothing comparable. */
  | "NO_SALES_FOUND"
  /** The lookup itself failed — we do not know what is out there. */
  | "SALES_UNAVAILABLE";

export type MarginKey =
  | "base"
  | "spread"
  | "disagreement"
  | "thinEvidence"
  | "stale"
  | "volatility";

export interface MarginComponent {
  key: MarginKey;
  /** Fraction of the reference this component added. */
  amount: number;
  /** Collector-facing phrasing. */
  label: string;
}

export interface RecommendedBuyEvidence {
  comps: number;
  isRaw: boolean;
  /** Median after IQR-fence outliers are set aside. Drives the reference. */
  ebayMedian: number;
  /** Median of every comp, including flagged ones. Shown for contrast. */
  ebayMedianAll: number;
  ebayMedianRecent: number | null;
  outliersExcluded: number;
  tcgMarketPrice: number | null;
  /** Share of the reference taken from eBay; null when only one source exists. */
  ebayWeight: number | null;
  sourceNote: string;
  dispersion: number | null;
  disagreement: number | null;
  daysSinceLastSale: number | null;
  weeklyVolatility: number | null;
}

export type RecommendedBuyResult =
  | {
      status: "AVAILABLE";
      groupKey: string;
      /** Unrounded. Round only at the point of display. */
      marketReference: number;
      recommendedBuy: number;
      /** Rounded for display, per roundMoney below. */
      marketReferenceDisplay: number;
      recommendedBuyDisplay: number;
      margin: number;
      marginCapped: boolean;
      marginComponents: MarginComponent[];
      evidence: RecommendedBuyEvidence;
      /** Short collector-facing bullets for a "why this price?" panel. */
      explanation: string[];
    }
  | {
      status: "UNAVAILABLE";
      groupKey: string;
      reason: RefusalReason;
      /** Collector-facing. Never leaks the enum name. */
      message: string;
      comps: number;
    };

/* -------------------------------------------------------------- statistics */

/**
 * Quantile with linear interpolation — pandas' default (type 7).
 *
 * Reproduced explicitly because the refusal gates compare against quantiles;
 * a different interpolation would move IQR and silently change which groups
 * get a price.
 */
function quantile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];

  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

const median = (sorted: number[]): number => quantile(sorted, 0.5);

const ascending = (values: number[]): number[] => [...values].sort((a, b) => a - b);

function iqrBounds(sorted: number[]): [number, number] {
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  return [q1 - 1.5 * iqr, q3 + 1.5 * iqr];
}

/**
 * Upper-half median divided by lower-half median.
 *
 * A single population sits near 1.0-2.0. A large value means the group holds
 * two different things — 1st Edition beside Unlimited, Holo beside Reverse
 * Holo, or a real sale beside a bad scrape.
 *
 * At n=3 each half is one sale, so this reduces to max/min. Intentionally
 * strict: three comps spanning 3x tell you nothing usable.
 */
function splitRatio(sorted: number[]): number | null {
  if (sorted.length < MIN_COMPS) return null;

  const half = Math.max(1, Math.floor(sorted.length / 2));
  const lower = median(sorted.slice(0, half));
  const upper = median(sorted.slice(sorted.length - half));
  return lower > 0 ? upper / lower : null;
}

/** Week-over-week dispersion of the TCGplayer series; null when too short. */
function weeklyVolatility(history: PriceHistoryPoint[] | null): number | null {
  if (!history) return null;

  const prices = history
    .filter((point) => point.marketPrice !== null)
    .map((point) => point.marketPrice as number);
  if (prices.length < 5) return null;

  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] !== 0) returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  const recent = returns.length >= 26 ? returns.slice(-26) : returns;
  if (recent.length < 2) return 0;

  const mean = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  const variance =
    recent.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (recent.length - 1);
  return Math.sqrt(variance);
}

/* ---------------------------------------------------------------- display */

/**
 * Display rounding. The calculation stays unrounded; only presentation snaps.
 *
 * Precision tracks magnitude, because a $4,000 card is not priced to the
 * dollar and a $12 card is not priced to the ten:
 *   >= $500  ->  nearest $10     ($2,113.79 -> $2,110)
 *   >= $100  ->  nearest $5      ($357.42   -> $355)
 *   >= $20   ->  nearest $1      ($47.31    -> $47)
 *   else         one decimal     ($11.27    -> $11.3)
 */
export function roundMoney(value: number): number {
  if (value >= 500) return Math.round(value / 10) * 10;
  if (value >= 100) return Math.round(value / 5) * 5;
  if (value >= 20) return Math.round(value);
  return Math.round(value * 10) / 10;
}

export type DealRating = "GREAT BUY" | "GOOD BUY" | "FAIR" | "ABOVE MARKET";

/**
 * Rates an asking price against a recommendation.
 *
 * Recommended Buy already carries the safety margin, so anything at or below
 * it is a good buy and a further 5% under is a great one. Between the
 * recommendation and the reference you are paying market but not above it.
 */
export function rateDeal(
  asking: number,
  recommendedBuy: number,
  marketReference: number,
): DealRating {
  if (asking <= recommendedBuy * 0.95) return "GREAT BUY";
  if (asking <= recommendedBuy) return "GOOD BUY";
  if (asking <= marketReference) return "FAIR";
  return "ABOVE MARKET";
}

/**
 * Convenience wrapper: rates against a result, or null when unavailable.
 *
 * Compares against the DISPLAYED figures, deliberately. The page tells the
 * reader "Recommended Buy ≤ $1,650", so $1,650 must be a good buy and
 * $1,650.01 must not — even though the unrounded threshold is $1,653.27.
 * The printed number is the promise; rating against the hidden one would let
 * a price the reader can see is over the line still come back GOOD BUY.
 *
 * The engine's own values stay unrounded; rounding is a display concern that
 * this comparison inherits on purpose.
 */
export function rateDealAgainst(
  asking: number,
  result: RecommendedBuyResult,
): DealRating | null {
  if (result.status !== "AVAILABLE") return null;
  return rateDeal(asking, result.recommendedBuyDisplay, result.marketReferenceDisplay);
}

/* ------------------------------------------------------- refusal messages */

/**
 * Collector-facing wording. Internal enum names never reach the page: a
 * shopper should read why the number is missing, not a constant.
 */
const REFUSAL_MESSAGES: Record<RefusalReason, string> = {
  TOO_FEW_COMPS: "Not enough comparable sales yet.",
  MIXED_POPULATION: "Recent sales appear to describe more than one market.",
  COMPS_DISAGREE: "Recent sales vary too widely to price confidently.",
  SOURCE_CONFLICT: "TCGplayer and eBay data disagree too strongly.",
  NO_SALES_FOUND: "No comparable sales were found.",
  SALES_UNAVAILABLE: "Comparable sales could not be loaded.",
};

function refuse(
  groupKey: string,
  reason: RefusalReason,
  comps: number,
): RecommendedBuyResult {
  return { status: "UNAVAILABLE", groupKey, reason, message: REFUSAL_MESSAGES[reason], comps };
}

/** For callers whose upstream sales lookup failed outright (e.g. Apify down). */
export function salesUnavailable(groupKey: string): RecommendedBuyResult {
  return refuse(groupKey, "SALES_UNAVAILABLE", 0);
}

/**
 * For callers whose lookup succeeded but yielded nothing comparable — either
 * no listings at all, or none that survived classification.
 *
 * Kept distinct from `salesUnavailable`: "nothing sold" is evidence about the
 * market, "we could not look" is evidence about us.
 */
export function noSalesFound(groupKey: string): RecommendedBuyResult {
  return refuse(groupKey, "NO_SALES_FOUND", 0);
}

/* ------------------------------------------------------------- evaluation */

export function evaluateRecommendedBuy(
  input: RecommendedBuyInput,
): RecommendedBuyResult {
  const { groupKey, tcgMarketPrice, asOf } = input;

  const priced = input.sales.filter((sale) => Number.isFinite(sale.soldPrice));
  const sorted = ascending(priced.map((sale) => sale.soldPrice));
  const n = sorted.length;

  // ---- Stage A gate 1: is there enough evidence at all?
  if (n < MIN_COMPS) return refuse(groupKey, "TOO_FEW_COMPS", n);

  const medianAll = median(sorted);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const spread = medianAll ? (q3 - q1) / medianAll : null;
  const ratio = splitRatio(sorted);

  // ---- Stage A gate 2: do the comps look like two different products?
  if (ratio !== null && ratio > MAX_SPLIT_RATIO) {
    return refuse(groupKey, "MIXED_POPULATION", n);
  }

  // ---- Stage A gate 3: do the comps simply disagree too much?
  if (spread !== null && spread > MAX_SPREAD) {
    return refuse(groupKey, "COMPS_DISAGREE", n);
  }

  const [loFence, hiFence] = iqrBounds(sorted);
  const kept = sorted.filter((price) => price >= loFence && price <= hiFence);
  const ebayMedian = kept.length > 0 ? median(kept) : medianAll;

  // Robust dispersion: MAD relative to the median, i.e. a robust CV.
  const deviations = ascending(sorted.map((price) => Math.abs(price - medianAll)));
  const mad = median(deviations);
  const dispersion = ebayMedian ? (1.4826 * mad) / ebayMedian : null;

  const isRaw = !priced[0].isGraded;

  // TCGplayer publishes an UNGRADED market price, so it is a comparable only
  // for raw groups. Graded groups are priced from eBay alone.
  let disagreement: number | null = null;
  if (tcgMarketPrice && ebayMedian && isRaw) {
    disagreement =
      Math.abs(tcgMarketPrice - ebayMedian) / ((tcgMarketPrice + ebayMedian) / 2);
  }

  // ---- Stage A gate 4: do the two sources even describe the same card?
  if (disagreement !== null && disagreement > MAX_DISAGREEMENT) {
    return refuse(groupKey, "SOURCE_CONFLICT", n);
  }

  // ---- Stage A: the reference itself
  let marketReference: number;
  let ebayWeight: number | null;
  let sourceNote: string;

  if (!isRaw) {
    marketReference = ebayMedian;
    ebayWeight = 1;
    sourceNote = "Graded sales only — TCGplayer prices ungraded cards";
  } else if (tcgMarketPrice === null) {
    marketReference = ebayMedian;
    ebayWeight = 1;
    sourceNote = "eBay sales only — no TCGplayer market price";
  } else {
    const weight = n / (n + BLEND_K);
    marketReference = weight * ebayMedian + (1 - weight) * tcgMarketPrice;
    ebayWeight = weight;
    sourceNote = `Blend of eBay (${Math.round(weight * 100)}%) and TCGplayer (${Math.round((1 - weight) * 100)}%)`;
  }

  // ---- Stage B: safety margin, one nameable reason at a time
  const dates = priced
    .map((sale) => sale.soldDate)
    .filter((date): date is string => Boolean(date))
    .sort();
  const daysSinceLastSale =
    dates.length > 0
      ? Math.floor((asOf.getTime() - new Date(dates[dates.length - 1]).getTime()) / DAY_MS)
      : null;

  const recentCutoff = asOf.getTime() - RECENT_DAYS * DAY_MS;
  const recentPrices = ascending(
    priced
      .filter((sale) => sale.soldDate && new Date(sale.soldDate).getTime() >= recentCutoff)
      .map((sale) => sale.soldPrice),
  );

  const volatility = weeklyVolatility(input.history);

  const components: MarginComponent[] = [
    { key: "base", amount: BASE_MARGIN, label: "Base allowance for resale costs" },
  ];
  let margin = BASE_MARGIN;

  if (dispersion !== null && dispersion > 0) {
    // Half the robust spread: wide comps mean a fuzzier true price.
    const add = Math.min(0.5 * dispersion, 0.1);
    margin += add;
    components.push({
      key: "spread",
      amount: add,
      label: "Sale prices vary, so the estimate is less precise",
    });
  }

  if (disagreement !== null && disagreement > 0.05) {
    const add = Math.min(0.5 * (disagreement - 0.05), 0.06);
    margin += add;
    components.push({
      key: "disagreement",
      amount: add,
      label: "eBay and TCGplayer disagree on the price",
    });
  }

  if (n < 10) {
    const add = (0.01 * (10 - n)) / 2;
    margin += add;
    components.push({
      key: "thinEvidence",
      amount: add,
      label: `Only ${n} comparable ${n === 1 ? "sale" : "sales"} to go on`,
    });
  }

  if (daysSinceLastSale !== null && daysSinceLastSale > RECENT_DAYS) {
    const add = Math.min((0.02 * (daysSinceLastSale - RECENT_DAYS)) / 30, 0.04);
    margin += add;
    components.push({
      key: "stale",
      amount: add,
      label: `Most recent sale was ${daysSinceLastSale} days ago`,
    });
  }

  if (volatility !== null && volatility > 0.03) {
    const add = Math.min((volatility - 0.03) * 2, 0.05);
    margin += add;
    components.push({
      key: "volatility",
      amount: add,
      label: "This card's price has been moving recently",
    });
  }

  const marginCapped = margin > MAX_MARGIN;
  if (marginCapped) margin = MAX_MARGIN;

  const recommendedBuy = marketReference * (1 - margin);

  return {
    status: "AVAILABLE",
    groupKey,
    marketReference,
    recommendedBuy,
    marketReferenceDisplay: roundMoney(marketReference),
    recommendedBuyDisplay: roundMoney(recommendedBuy),
    margin,
    marginCapped,
    marginComponents: components,
    evidence: {
      comps: n,
      isRaw,
      ebayMedian,
      ebayMedianAll: medianAll,
      ebayMedianRecent: recentPrices.length > 0 ? median(recentPrices) : null,
      outliersExcluded: n - kept.length,
      tcgMarketPrice,
      ebayWeight,
      sourceNote,
      dispersion,
      disagreement,
      daysSinceLastSale,
      weeklyVolatility: volatility,
    },
    explanation: components
      .filter((component) => component.key !== "base")
      .map((component) => component.label),
  };
}
