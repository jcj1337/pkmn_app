/**
 * Fixed-window collection of eBay sold listings, for liquidity measurement.
 *
 * Separate from `getSoldListings`, which serves the card page. That path asks
 * for the 20 newest sales and is right to: it renders a short "recent sold"
 * list. This path asks a different question — "everything that traded in the
 * last N days" — and must be able to say when it did not get it.
 *
 * ## Why the old data could not measure liquidity
 *
 * The live query sends `daysToScrape: 90` with `count: 20` and
 * `sortOrder: endedRecently`. The window was never the binding constraint;
 * the count was. Every saved fixture came back with exactly 20 rows, so the
 * observation period silently became "however long those 20 sales took" —
 * one day for a fast card, 62 for a slow one. Rates computed across cards
 * were therefore not comparable, and a card with no recent sales could not
 * exist in the sample at all.
 *
 * ## What this module adds
 *
 * A collection is recorded with the window that was REQUESTED and the window
 * that was actually OBSERVED, plus a completeness verdict linking them. The
 * analysis can then divide by a window it can trust.
 *
 * Nothing here runs automatically. It is driven by
 * scripts/collect-ebay-history.cjs, never by a page render.
 */

import {
  buildEbayQuery,
  MAX_LOOKBACK_DAYS,
  type EbayQueryCard,
  type SoldListing,
} from "./ebay-sold";
import type { SoldListingsProvider } from "./sold-listings-provider";

/**
 * COMPLETE  — the source ran out of results before the cap, so every sale in
 *             the requested window is present.
 * TRUNCATED — the cap was reached first. Sales older than `observedFrom`
 *             exist but were not returned; the requested window is NOT the
 *             observed window.
 * EMPTY     — the search returned nothing. Still evidence: a genuinely dead
 *             market for the whole window.
 */
export type Completeness = "COMPLETE" | "TRUNCATED" | "EMPTY";

/**
 * A stored sale. `firstSeenAt` records when we first observed it, which is
 * what makes repeated collections idempotent and lets a merge be audited.
 */
export interface StoredSale extends SoldListing {
  firstSeenAt: string;
}

export interface CollectionRun {
  collectedAt: string;
  query: string;
  requestedDays: number;
  requestedCount: number;
  /** Requested window: [collectedAt - requestedDays, collectedAt]. */
  requestedFrom: string;
  requestedTo: string;
  returned: number;
  newSales: number;
  earliestSale: string | null;
  latestSale: string | null;
  completeness: Completeness;
  /**
   * Start of the window this run can actually vouch for. Equals
   * `requestedFrom` when COMPLETE; the oldest returned sale when TRUNCATED.
   * Liquidity must divide by this, never by `requestedFrom`.
   */
  observedFrom: string;
  observedTo: string;
}

export interface CardSalesFile {
  cardId: string;
  cardName: string;
  setName: string;
  cardNumber: string;
  query: string;
  /** Newest first. Deduplicated by eBay itemId. */
  sales: StoredSale[];
  /** Append-only, newest last. Never rewritten. */
  collections: CollectionRun[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Slack when deciding whether a capped run still covered its window.
 *
 * If the cap was hit but the oldest result is already at the window edge, the
 * run is complete in every way that matters. A day absorbs timezone skew
 * between eBay's end timestamps and our clock.
 */
const WINDOW_EDGE_TOLERANCE_DAYS = 1;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Completeness is decided by whether the CAP or the WINDOW stopped the run.
 *
 * Fewer results than requested means the source was exhausted. Hitting the cap
 * means there is more we did not see — unless the oldest result already sits
 * at the window edge.
 */
export function assessCompleteness(
  returned: number,
  requestedCount: number,
  requestedFrom: string,
  earliestSale: string | null,
): Completeness {
  if (returned === 0 || earliestSale === null) return "EMPTY";
  if (returned < requestedCount) return "COMPLETE";

  const reachedEdge =
    new Date(earliestSale).getTime() <=
    new Date(requestedFrom).getTime() + WINDOW_EDGE_TOLERANCE_DAYS * DAY_MS;

  return reachedEdge ? "COMPLETE" : "TRUNCATED";
}

export function emptyFile(
  card: EbayQueryCard & { id: string; name: string; setName: string; number: string },
): CardSalesFile {
  return {
    cardId: card.id,
    cardName: card.name,
    setName: card.setName,
    cardNumber: card.number,
    query: buildEbayQuery(card),
    sales: [],
    collections: [],
  };
}

/**
 * Merges a fresh run into stored history.
 *
 * Deduplication is by eBay itemId alone. It is the source's own primary key,
 * it is stable across re-scrapes, and it is the only field guaranteed unique —
 * title, price and date all legitimately repeat across different sales of the
 * same card, so matching on them would silently delete real transactions.
 *
 * Existing rows win on conflict: the first observation is the one closest to
 * the sale, and later scrapes can revise a title or thumbnail.
 */
export function mergeSales(
  existing: StoredSale[],
  incoming: SoldListing[],
  observedAt: string,
): { sales: StoredSale[]; added: number } {
  const byId = new Map(existing.map((sale) => [sale.itemId, sale]));
  let added = 0;

  for (const listing of incoming) {
    if (byId.has(listing.itemId)) continue;
    byId.set(listing.itemId, { ...listing, firstSeenAt: observedAt });
    added++;
  }

  const sales = [...byId.values()].sort((a, b) =>
    (b.soldDate ?? "").localeCompare(a.soldDate ?? ""),
  );

  return { sales, added };
}

/**
 * Union of the windows the stored collections can vouch for.
 *
 * `hasGap` is the one thing the analysis must not ignore: if collections were
 * run 120 days apart with a 90-day window, the middle is simply missing, and
 * a rate computed across the whole span would be wrong.
 */
export function coverage(collections: CollectionRun[]): {
  observedFrom: string | null;
  observedTo: string | null;
  observedDays: number;
  hasGap: boolean;
  anyTruncated: boolean;
} {
  const usable = collections.filter((run) => run.completeness !== "EMPTY");
  if (usable.length === 0) {
    return {
      observedFrom: null,
      observedTo: null,
      observedDays: 0,
      hasGap: false,
      anyTruncated: false,
    };
  }

  const ordered = [...usable].sort((a, b) =>
    a.observedFrom.localeCompare(b.observedFrom),
  );

  let hasGap = false;
  let reach = new Date(ordered[0].observedTo).getTime();
  for (const run of ordered.slice(1)) {
    if (new Date(run.observedFrom).getTime() > reach + DAY_MS) hasGap = true;
    reach = Math.max(reach, new Date(run.observedTo).getTime());
  }

  const observedFrom = ordered[0].observedFrom;
  const observedTo = ordered.reduce(
    (latest, run) => (run.observedTo > latest ? run.observedTo : latest),
    ordered[0].observedTo,
  );

  return {
    observedFrom,
    observedTo,
    observedDays:
      Math.round((new Date(observedTo).getTime() - new Date(observedFrom).getTime()) / DAY_MS) + 1,
    hasGap,
    anyTruncated: usable.some((run) => run.completeness === "TRUNCATED"),
  };
}

export interface CollectOptions {
  days: number;
  count: number;
  /** Where the listings come from. This module never knows which one. */
  provider: SoldListingsProvider;
  now?: Date;
}

/**
 * Runs one collection for a card and returns the run record plus its listings.
 * Storage is the caller's concern, so this stays testable without a filesystem.
 */
export async function collectSoldHistory(
  card: EbayQueryCard,
  options: CollectOptions,
): Promise<{ run: Omit<CollectionRun, "newSales">; listings: SoldListing[] }> {
  const days = Math.min(options.days, MAX_LOOKBACK_DAYS);
  const now = options.now ?? new Date();
  const query = buildEbayQuery(card);

  const requestedFrom = isoDay(new Date(now.getTime() - days * DAY_MS));
  const requestedTo = isoDay(now);

  const result = await options.provider.search(query, { days, count: options.count });
  if (result.status !== "ok") {
    // A provider that could not run tells us nothing about the market, so the
    // caller must not record this as an observation.
    throw new Error(`${options.provider.label}: ${result.reason}`);
  }
  const listings = result.listings;

  const dates = listings
    .map((listing) => listing.soldDate)
    .filter((date): date is string => Boolean(date))
    .sort();

  const earliestSale = dates[0] ?? null;
  const latestSale = dates[dates.length - 1] ?? null;
  const completeness = assessCompleteness(
    listings.length,
    options.count,
    requestedFrom,
    earliestSale,
  );

  return {
    listings,
    run: {
      collectedAt: now.toISOString(),
      query,
      requestedDays: days,
      requestedCount: options.count,
      requestedFrom,
      requestedTo,
      returned: listings.length,
      earliestSale,
      latestSale,
      completeness,
      // A truncated run only vouches for the span it actually reached.
      observedFrom:
        completeness === "TRUNCATED" && earliestSale ? earliestSale : requestedFrom,
      observedTo: requestedTo,
    },
  };
}
