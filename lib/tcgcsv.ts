/**
 * TCGCSV fallback client (https://tcgcsv.com).
 *
 * Used only when TCGdex has no TCGplayer pricing for a card. TCGCSV has no
 * search API — it serves static per-group files — so lookups resolve the set's
 * group first and then scan that one group's products. Group listings and
 * per-group data are cached so repeated searches do not refetch them.
 */

import { numberKey, type CardVariants } from "./tcgdex";

const API_BASE = "https://tcgcsv.com/tcgplayer";
const POKEMON_CATEGORY_ID = 3;

const GROUPS_TTL_MS = 6 * 60 * 60 * 1000;
const GROUP_DATA_TTL_MS = 60 * 60 * 1000;

export interface TcgcsvQuery {
  name: string;
  setName: string;
  localId: string;
  printedTotal: number | null;
  rarity: string | null;
  variants: CardVariants;
}

export interface TcgcsvPrices {
  market: number | null;
  low: number | null;
  mid: number | null;
  high: number | null;
}

export interface TcgcsvMatch {
  productId: number;
  imageUrl: string | null;
  /**
   * Pricing for the matched print, or null when no rows exist or the variant
   * cannot be identified. A matched product still carries a usable image even
   * when its price is undeterminable.
   */
  prices: TcgcsvPrices | null;
  subType: string | null;
}

export type TcgcsvLookup =
  | { status: "matched"; match: TcgcsvMatch }
  | { status: "missing"; reason: string }
  | { status: "ambiguous"; reason: string };

interface RawGroup {
  groupId: number;
  name: string;
}

interface RawProduct {
  productId: number;
  name: string;
  imageUrl?: string;
  extendedData?: { name: string; value: string }[];
}

interface RawPriceRow {
  productId: number;
  subTypeName?: string;
  marketPrice?: number | null;
  lowPrice?: number | null;
  midPrice?: number | null;
  highPrice?: number | null;
}

interface GroupData {
  products: RawProduct[];
  prices: RawPriceRow[];
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

let groupsCache: CacheEntry<RawGroup[]> | null = null;
const groupDataCache = new Map<number, CacheEntry<GroupData>>();

const norm = (value: string) =>
  String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function nameMatches(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return Boolean(x) && Boolean(y) && (x.includes(y) || y.includes(x));
}

/** TCGCSV rejects requests without a User-Agent with a 401. */
const USER_AGENT = "pkmn-app/0.1 (Pokemon card price checker)";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": USER_AGENT },
  });

  if (!response.ok) throw new Error(`TCGCSV returned ${response.status}`);
  return (await response.json()) as T;
}

async function loadGroups(): Promise<RawGroup[]> {
  if (groupsCache && groupsCache.expiresAt > Date.now()) return groupsCache.value;

  const body = await getJson<{ results: RawGroup[] }>(
    `${API_BASE}/${POKEMON_CATEGORY_ID}/groups`,
  );

  groupsCache = { value: body.results, expiresAt: Date.now() + GROUPS_TTL_MS };
  return body.results;
}

async function loadGroupData(groupId: number): Promise<GroupData> {
  const cached = groupDataCache.get(groupId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [products, prices] = await Promise.all([
    getJson<{ results: RawProduct[] }>(`${API_BASE}/${POKEMON_CATEGORY_ID}/${groupId}/products`),
    getJson<{ results: RawPriceRow[] }>(`${API_BASE}/${POKEMON_CATEGORY_ID}/${groupId}/prices`),
  ]);

  const value = { products: products.results, prices: prices.results };
  groupDataCache.set(groupId, { value, expiresAt: Date.now() + GROUP_DATA_TTL_MS });
  return value;
}

/**
 * TCGCSV prefixes group names with an era code ("SWSH11: Lost Origin"), so the
 * set name is matched as a substring. The shortest containing name wins, which
 * keeps "Lost Origin" from resolving to "Lost Origin Trainer Gallery".
 */
function resolveGroup(groups: RawGroup[], setName: string): RawGroup | "ambiguous" | null {
  const target = norm(setName);
  if (!target) return null;

  const matches = groups
    .filter((group) => norm(group.name).includes(target))
    .sort((a, b) => norm(a.name).length - norm(b.name).length);

  if (matches.length === 0) return null;
  if (
    matches.length > 1 &&
    norm(matches[0].name).length === norm(matches[1].name).length
  ) {
    return "ambiguous";
  }

  return matches[0];
}

const extended = (product: RawProduct, field: string) =>
  product.extendedData?.find((entry) => entry.name === field)?.value ?? null;

/**
 * TCGCSV stores the full printed number ("TG17/TG30", "004/102") while TCGdex
 * stores only the local part ("TG17", "4"); numberKey reduces both to the same
 * comparable form.
 */
function findProducts(products: RawProduct[], query: TcgcsvQuery): RawProduct[] {
  const wanted = numberKey(query.localId);

  const byNumber = products.filter(
    (product) => numberKey(extended(product, "Number") ?? "") === wanted,
  );
  if (byNumber.length === 0) return [];

  const exact = byNumber.filter((product) => norm(product.name) === norm(query.name));
  if (exact.length > 0) return exact;

  return byNumber.filter((product) => nameMatches(product.name, query.name));
}

/** TCGdex variant flags mapped onto TCGCSV subtype names. */
function expectedSubTypes(variants: CardVariants): string[] {
  const expected: string[] = [];

  if (variants.holo) expected.push("Holofoil");
  if (variants.reverse) expected.push("Reverse Holofoil");
  if (variants.normal) expected.push("Normal");
  if (variants.firstEdition) {
    expected.push("1st Edition Holofoil", "1st Edition Normal");
  }

  return expected.map(norm);
}

function toPrices(row: RawPriceRow): TcgcsvPrices {
  const value = (input?: number | null) => (typeof input === "number" ? input : null);

  return {
    market: value(row.marketPrice),
    low: value(row.lowPrice),
    mid: value(row.midPrice),
    high: value(row.highPrice),
  };
}

/**
 * Picks the price row matching the card's actual print. A single row is
 * unambiguous; otherwise the card's declared variants must select exactly one.
 * Anything else is reported rather than guessed.
 */
function selectRow(
  rows: RawPriceRow[],
  variants: CardVariants,
): { row: RawPriceRow } | { ambiguous: string } {
  if (rows.length === 1) return { row: rows[0] };

  const expected = expectedSubTypes(variants);
  const candidates = rows.filter((row) => expected.includes(norm(row.subTypeName ?? "")));

  if (candidates.length === 1) return { row: candidates[0] };

  const available = rows.map((row) => row.subTypeName ?? "unknown").join(", ");
  if (candidates.length === 0) {
    return { ambiguous: `no variant matched the card's print (available: ${available})` };
  }

  return { ambiguous: `multiple variants matched (${available})` };
}

/**
 * Resolves the TCGCSV product for a TCGdex card. One lookup serves both the
 * pricing and image fallbacks — callers use whichever fields they are missing.
 */
export async function lookupCard(query: TcgcsvQuery): Promise<TcgcsvLookup> {
  const groups = await loadGroups();
  const group = resolveGroup(groups, query.setName);

  if (group === null) {
    return { status: "missing", reason: `no TCGCSV group for set “${query.setName}”` };
  }
  if (group === "ambiguous") {
    return { status: "ambiguous", reason: `set “${query.setName}” matched several groups` };
  }

  const { products, prices } = await loadGroupData(group.groupId);
  let matches = findProducts(products, query);

  if (matches.length === 0) {
    return { status: "missing", reason: `no product ${query.localId} in ${group.name}` };
  }

  // Rarity is only needed to break ties between same-name, same-number prints.
  if (matches.length > 1 && query.rarity) {
    const byRarity = matches.filter((product) =>
      nameMatches(extended(product, "Rarity") ?? "", query.rarity as string),
    );
    if (byRarity.length > 0) matches = byRarity;
  }

  if (matches.length > 1) {
    return {
      status: "ambiguous",
      reason: `${matches.length} products matched ${query.localId} in ${group.name}`,
    };
  }

  const product = matches[0];
  const rows = prices.filter((row) => row.productId === product.productId);
  const selected = rows.length > 0 ? selectRow(rows, query.variants) : null;

  // An undeterminable price does not invalidate the match: the image is still
  // the right card's image.
  const priced = selected !== null && "row" in selected ? selected : null;

  return {
    status: "matched",
    match: {
      productId: product.productId,
      imageUrl: product.imageUrl ?? null,
      prices: priced ? toPrices(priced.row) : null,
      subType: priced ? (priced.row.subTypeName ?? "unknown") : null,
    },
  };
}
