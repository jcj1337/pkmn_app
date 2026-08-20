/**
 * TCGdex API client (https://api.tcgdex.net) — the primary data source.
 *
 * TCGdex search returns lightweight stubs (id, localId, name) with no set,
 * rarity, image or pricing, so a search is a name lookup followed by a
 * parallel fetch of the individual cards we intend to show.
 */

const API_BASE = "https://api.tcgdex.net/v2/en";
const MAX_RESULTS = 10;

/**
 * When a printed number is supplied we must fetch candidates before we can
 * read their set totals, so allow a wider net before narrowing to MAX_RESULTS.
 */
const NUMBER_LOOKUP_CAP = 25;

/**
 * TCGplayer exposes two unrelated kinds of number, and they must not be mixed:
 *
 * - `market` is derived from recent completed sales.
 * - `low`/`mid`/`high` describe what sellers are currently asking.
 *
 * A card with no recent sales has a null market price while still carrying
 * live listings, so the two are modelled as separate states rather than
 * falling back from one to the other.
 */
export interface ListingPrices {
  low: number | null;
  mid: number | null;
  high: number | null;
}

export type CardPricing =
  /** Listings accompany a market price for context; they never replace it. */
  | { kind: "market"; market: number; listings: ListingPrices | null }
  | { kind: "listings"; low: number | null; mid: number | null; high: number | null }
  | { kind: "none" };

/** Which upstream supplied the displayed pricing. */
export type PriceSource = "tcgdex" | "tcgcsv";

export interface CardResult {
  id: string;
  name: string;
  setName: string;
  number: string;
  printedTotal: number | null;
  rarity: string | null;
  imageUrl: string | null;
  pricing: CardPricing;
  priceUpdatedAt: string | null;
  priceSource: PriceSource | null;
}

/** Which physical prints exist for a card, used to disambiguate price variants. */
export interface CardVariants {
  firstEdition: boolean;
  holo: boolean;
  normal: boolean;
  reverse: boolean;
}

/** Structured identity carried alongside a card for fallback matching. */
export interface CardIdentity {
  name: string;
  setName: string;
  localId: string;
  printedTotal: number | null;
  rarity: string | null;
  variants: CardVariants;
}

export interface TcgdexCard {
  card: CardResult;
  identity: CardIdentity;
}

export class TcgdexError extends Error {}

interface RawCardStub {
  id: string;
  localId?: string;
  name: string;
}

interface RawPriceVariant {
  marketPrice?: number | null;
  lowPrice?: number | null;
  midPrice?: number | null;
  highPrice?: number | null;
}

interface RawTcgplayerPricing {
  unit?: string;
  updated?: string;
  [variant: string]: unknown;
}

interface RawCard {
  id: string;
  name: string;
  localId?: string;
  rarity?: string;
  image?: string;
  variants?: Partial<CardVariants>;
  set?: {
    name?: string;
    cardCount?: { official?: number; total?: number };
  };
  pricing?: { tcgplayer?: RawTcgplayerPricing | null };
}

/**
 * Printed numbers are alphanumeric across subsets: "199", "TG17", "GG69",
 * "SWSH062". The letter prefix is capped so ordinary words containing digits
 * ("Porygon2") are not mistaken for card numbers.
 */
const NUMBER_TOKEN = String.raw`[A-Za-z]{0,4}\d{1,4}[A-Za-z]?`;
const CARD_NUMBER_FRACTION = new RegExp(
  String.raw`\b(${NUMBER_TOKEN})\s*/\s*(${NUMBER_TOKEN})\b`,
);
/** A bare number must carry a letter prefix, so set names like "151" stay text. */
const BARE_CARD_NUMBER = new RegExp(String.raw`\b([A-Za-z]{1,4}\d{1,4}[A-Za-z]?)\b`);

interface ParsedQuery {
  name: string;
  number: string | null;
  printedTotal: number | null;
}

/**
 * Splits free text into a name and an optional printed number.
 *
 * "Charizard"                -> { name: "Charizard" }
 * "Charizard 199/165"        -> { name: "Charizard", number: "199", printedTotal: 165 }
 * "Pikachu VMAX TG17/TG30"   -> { name: "Pikachu VMAX", number: "TG17", printedTotal: 30 }
 * "Pikachu VMAX TG17"        -> { name: "Pikachu VMAX", number: "TG17" }
 */
export function parseQuery(input: string): ParsedQuery {
  let text = input.trim();
  let number: string | null = null;
  let printedTotal: number | null = null;

  const fraction = text.match(CARD_NUMBER_FRACTION);

  if (fraction) {
    number = fraction[1];
    // The denominator may be prefixed too ("TG30"); only its digits matter.
    const digits = fraction[2].replace(/\D/g, "");
    printedTotal = digits ? Number(digits) : null;
    text = text.replace(CARD_NUMBER_FRACTION, " ");
  } else {
    const bare = text.match(BARE_CARD_NUMBER);
    if (bare) {
      number = bare[1];
      text = text.replace(BARE_CARD_NUMBER, " ");
    }
  }

  return { name: text.trim().replace(/\s+/g, " "), number, printedTotal };
}

/**
 * Comparable form of a printed number. Drops any "/total" suffix (TCGCSV
 * stores "TG17/TG30" where TCGdex stores "TG17") and zero padding ("022").
 */
export function numberKey(value: string): string {
  const local = String(value ?? "").trim().toUpperCase().split("/")[0].trim();
  return /^\d+$/.test(local) ? String(Number(local)) : local;
}

/** Display form: drop zero padding on numeric ids, leave "TG17" untouched. */
function displayNumber(value: string): string {
  const trimmed = String(value ?? "").trim();
  return /^\d+$/.test(trimmed) ? String(Number(trimmed)) : trimmed;
}

/**
 * The number as printed on the card: "199/165", "TG17/TG30".
 *
 * Set totals are stored as plain numbers, so a subset prefix on the card
 * number is reapplied to the denominator — subset numbering uses the same
 * prefix on both sides.
 */
export function printedNumber(number: string, printedTotal: number | null): string {
  if (!printedTotal) return number;

  const prefix = number.match(/^[A-Za-z]+/)?.[0] ?? "";
  return `${number}/${prefix}${printedTotal}`;
}

/** TCGdex image fields omit the quality and extension; a bare URL 404s. */
function buildImageUrl(image?: string): string | null {
  return image ? `${image}/high.png` : null;
}

/** TCGdex reports the literal string "None" for cards that have no rarity. */
function normalizeRarity(rarity?: string): string | null {
  if (!rarity) return null;
  return rarity.trim().toLowerCase() === "none" ? null : rarity;
}

/** Preferred print variants first, then anything else the card carries. */
const PRICE_VARIANT_ORDER = ["normal", "holofoil", "reverse-holofoil"];

function priceVariants(pricing?: RawTcgplayerPricing | null): RawPriceVariant[] {
  if (!pricing) return [];

  const entries = Object.entries(pricing).filter(
    (entry): entry is [string, RawPriceVariant] =>
      entry[0] !== "unit" &&
      entry[0] !== "updated" &&
      typeof entry[1] === "object" &&
      entry[1] !== null,
  );

  const rank = (name: string) => {
    const index = PRICE_VARIANT_ORDER.indexOf(name);
    return index === -1 ? PRICE_VARIANT_ORDER.length : index;
  };

  return entries.sort((a, b) => rank(a[0]) - rank(b[0])).map(([, variant]) => variant);
}

function numberOrNull(value?: number | null): number | null {
  return typeof value === "number" ? value : null;
}

function toListings(variant: RawPriceVariant): ListingPrices | null {
  const low = numberOrNull(variant.lowPrice);
  const mid = numberOrNull(variant.midPrice);
  const high = numberOrNull(variant.highPrice);

  return low !== null || mid !== null || high !== null ? { low, mid, high } : null;
}

function pickPricing(pricing?: RawTcgplayerPricing | null): CardPricing {
  const variants = priceVariants(pricing);

  // A real market price always wins. Listings come from the same variant so
  // the two describe the same physical print.
  for (const variant of variants) {
    const market = numberOrNull(variant.marketPrice);
    if (market !== null) {
      return { kind: "market", market, listings: toListings(variant) };
    }
  }

  // Otherwise fall back to describing the current listings — never to
  // presenting one of them as though it were a market price.
  for (const variant of variants) {
    const listings = toListings(variant);
    if (listings) return { kind: "listings", ...listings };
  }

  return { kind: "none" };
}

function toVariants(raw?: Partial<CardVariants>): CardVariants {
  return {
    firstEdition: Boolean(raw?.firstEdition),
    holo: Boolean(raw?.holo),
    normal: Boolean(raw?.normal),
    reverse: Boolean(raw?.reverse),
  };
}

function toTcgdexCard(card: RawCard): TcgdexCard {
  const tcgplayer = card.pricing?.tcgplayer;
  const pricing = pickPricing(tcgplayer);
  const setName = card.set?.name ?? "Unknown set";
  const localId = card.localId ?? "";

  return {
    card: {
      id: card.id,
      name: card.name,
      setName,
      number: localId ? displayNumber(localId) : "—",
      printedTotal: card.set?.cardCount?.official ?? null,
      rarity: normalizeRarity(card.rarity),
      imageUrl: buildImageUrl(card.image),
      pricing,
      priceUpdatedAt: pricing.kind === "none" ? null : (tcgplayer?.updated ?? null),
      priceSource: pricing.kind === "none" ? null : "tcgdex",
    },
    identity: {
      name: card.name,
      setName,
      localId,
      printedTotal: card.set?.cardCount?.official ?? null,
      rarity: normalizeRarity(card.rarity),
      variants: toVariants(card.variants),
    },
  };
}

async function getJson<T>(url: string): Promise<T | null> {
  let response: Response;

  try {
    response = await fetch(url, { cache: "no-store" });
  } catch {
    throw new TcgdexError("Could not reach TCGdex.");
  }

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new TcgdexError(`TCGdex is temporarily unavailable (${response.status}).`);
  }

  return (await response.json()) as T;
}

interface RawSetStub {
  name?: string;
}

interface RawSetStub2 {
  id?: string;
  name?: string;
}

const squashName = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

let setNamesCache: { value: string[]; expiresAt: number } | null = null;
const SET_NAMES_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Set names usable as evidence that a listing names a *different* set.
 *
 * Names that are also series names ("Scarlet & Violet", "Sword & Shield") are
 * excluded: sellers use them as era labels on cards from any set in that era,
 * so their presence proves nothing. Sourced from the API rather than
 * hard-coded so new sets and series are covered automatically.
 */
export async function getSetNames(): Promise<string[]> {
  if (setNamesCache && setNamesCache.expiresAt > Date.now()) {
    return setNamesCache.value;
  }

  const [sets, series] = await Promise.all([
    getJson<RawSetStub[]>(`${API_BASE}/sets`),
    getJson<RawSetStub[]>(`${API_BASE}/series`),
  ]);

  const eraNames = new Set(
    (series ?? []).map((entry) => (entry.name ?? "").toLowerCase()),
  );

  const value = (sets ?? [])
    .map((set) => set.name ?? "")
    .filter((name) => name.length > 0 && !eraNames.has(name.toLowerCase()));

  setNamesCache = { value, expiresAt: Date.now() + SET_NAMES_TTL_MS };
  return value;
}

/** A different card that a listing could plausibly be referring to instead. */
export interface CompetingCard {
  name: string;
  number: string;
  printedTotal: number | null;
  setName: string;
}

interface RawSetDetail {
  name?: string;
  cardCount?: { official?: number };
  cards?: { localId?: string; name?: string }[];
}

const setDetailCache = new Map<string, RawSetDetail | null>();
const MAX_COMPETING = 6;

/**
 * Cards in the same set whose name overlaps the target's.
 *
 * Scoped deliberately: one cached set fetch, same-set only. The point is to
 * tell a model that (say) Lost Origin Trainer Gallery holds Pikachu, Pikachu V
 * and two Pikachu VMAX, so a title naming none of the numbers is genuinely
 * ambiguous — and conversely that Skyridge holds exactly one Charizard, so
 * there is nothing to confuse it with.
 */
export async function getCompetingCards(card: {
  name: string;
  number: string;
  setName: string;
}): Promise<CompetingCard[]> {
  const sets = await getJson<RawSetStub2[]>(`${API_BASE}/sets`);
  const target = squashName(card.setName);
  const match = (sets ?? []).find((entry) => squashName(entry.name ?? "") === target);
  if (!match?.id) return [];

  if (!setDetailCache.has(match.id)) {
    setDetailCache.set(
      match.id,
      await getJson<RawSetDetail>(`${API_BASE}/sets/${match.id}`).catch(() => null),
    );
  }
  const detail = setDetailCache.get(match.id);
  if (!detail?.cards) return [];

  const wantedName = squashName(card.name);
  const wantedNumber = numberKey(card.number);

  return detail.cards
    .filter((entry) => {
      if (numberKey(entry.localId ?? "") === wantedNumber) return false;
      const other = squashName(entry.name ?? "");
      if (!other || !wantedName) return false;
      return other.includes(wantedName) || wantedName.includes(other);
    })
    .slice(0, MAX_COMPETING)
    .map((entry) => ({
      name: entry.name ?? "",
      number: entry.localId ? displayNumber(entry.localId) : "",
      printedTotal: detail.cardCount?.official ?? null,
      setName: detail.name ?? card.setName,
    }));
}

/** Single-card lookup by TCGdex id, normalized identically to search results. */
export async function getTcgdexCard(id: string): Promise<TcgdexCard | null> {
  const card = await getJson<RawCard>(`${API_BASE}/cards/${encodeURIComponent(id)}`);
  return card ? toTcgdexCard(card) : null;
}

export async function searchTcgdexCards(rawQuery: string): Promise<TcgdexCard[]> {
  const { name, number, printedTotal } = parseQuery(rawQuery);

  // TCGdex has no number-only search endpoint, so a name is always required.
  if (!name) {
    throw new TcgdexError(
      "Include a card name in your search, for example “Charizard 199/165”.",
    );
  }

  const params = new URLSearchParams({ name });
  const stubs = (await getJson<RawCardStub[]>(`${API_BASE}/cards?${params}`)) ?? [];

  const candidates = number
    ? stubs.filter((stub) => numberKey(stub.localId ?? "") === numberKey(number))
    : stubs;

  const fetched = await Promise.all(
    candidates
      .slice(0, number ? NUMBER_LOOKUP_CAP : MAX_RESULTS)
      .map((stub) => getJson<RawCard>(`${API_BASE}/cards/${stub.id}`)),
  );

  let cards = fetched.filter((card): card is RawCard => card !== null);

  // The printed total is only known once the full card is loaded.
  if (printedTotal !== null) {
    cards = cards.filter((card) => card.set?.cardCount?.official === printedTotal);
  }

  return cards.slice(0, MAX_RESULTS).map(toTcgdexCard);
}
