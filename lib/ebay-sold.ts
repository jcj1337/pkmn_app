/**
 * eBay sold-listings provider, backed by the Apify actor
 * `caffein.dev/ebay-sold-listings`.
 *
 * This module is the only place that knows about Apify. Everything else
 * consumes `SoldListing`, so the provider can be swapped later without
 * touching the UI.
 *
 * Results are RAW: no relevance filtering, no condition classification, no
 * aggregation. Graded slabs, lots, Japanese prints and mismatched cards are
 * all expected to appear.
 */

import { printedNumber } from "./tcgdex";

const APIFY_ACTOR = "caffein.dev~ebay-sold-listings";
const APIFY_ENDPOINT = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items`;

/**
 * Apify bills per result. All fetched rows are returned so the classifier can
 * group them and show what was excluded — they are already paid for.
 *
 * This is the LIVE page budget, deliberately small. It is not a statement
 * about how many sales exist: because the actor sorts by `endedRecently`, a
 * count of 20 returns the 20 newest sales inside the window and silently
 * discards the rest. That is fine for "recent sold listings" on a card page
 * and useless for measuring how often a card trades — see
 * `collectSoldHistory` and scripts/collect-ebay-history.cjs for the
 * fixed-window collection path.
 */
const RESULT_COUNT = 20;

/** Widest window the actor allows; slow-moving vintage cards need it. */
const LOOKBACK_DAYS = 90;

/** Actor-enforced ceiling on `daysToScrape`; there is no absolute-date input. */
export const MAX_LOOKBACK_DAYS = 90;

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 120_000;

export interface SoldListing {
  itemId: string;
  title: string;
  soldPrice: number | null;
  currency: string;
  soldDate: string | null;
  condition: string | null;
  imageUrl: string | null;
  url: string | null;
}

export type SoldListingsResult =
  | { status: "ok"; listings: SoldListing[]; query: string }
  | { status: "not-configured"; query: string }
  | { status: "error"; query: string; message: string };

/** Minimal card shape needed to build a query — not tied to the full model. */
export interface EbayQueryCard {
  name: string;
  number: string;
  printedTotal: number | null;
}

/**
 * Builds the eBay search from structured card data.
 *
 * "Mega Darkrai ex" + 116/84  -> "Mega Darkrai ex 116/84"
 * "Pikachu VMAX"    + TG17/30 -> "Pikachu VMAX TG17/TG30"
 *
 * The set name is deliberately omitted: sellers write it inconsistently (or
 * not at all), and requiring it drops legitimate listings. Card name plus
 * printed number is the combination that appears in nearly every title.
 */
export function buildEbayQuery(card: EbayQueryCard): string {
  return [card.name, printedNumber(card.number, card.printedTotal)]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

interface RawSoldItem {
  itemId?: string | number;
  url?: string;
  title?: string;
  condition?: string;
  endedAt?: string;
  soldPrice?: string | number;
  soldCurrency?: string;
  thumbnailUrl?: string;
  fullResThumbnailUrl?: string;
}

/** The actor returns prices as strings ("215", "1,066.24"). */
function toNumber(value?: string | number): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const parsed = Number(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function toSoldListing(item: RawSoldItem, index: number): SoldListing {
  return {
    itemId: String(item.itemId ?? `unknown-${index}`),
    title: item.title ?? "Untitled listing",
    soldPrice: toNumber(item.soldPrice),
    currency: item.soldCurrency ?? "USD",
    soldDate: item.endedAt ?? null,
    condition: item.condition ?? null,
    imageUrl: item.thumbnailUrl ?? item.fullResThumbnailUrl ?? null,
    url: item.url ?? null,
  };
}

export interface SoldSearchOptions {
  /** Days back to search. The actor caps this at 90 and has no date inputs. */
  days?: number;
  /** Maximum results. The actor's own default is 100; ours is deliberately 20. */
  count?: number;
  timeoutMs?: number;
}

/**
 * One actor run. The only function in the codebase that spends Apify credit.
 *
 * Newest-first ordering is guaranteed by `sortOrder`, and re-applied locally
 * because completeness detection downstream depends on knowing the oldest
 * sale actually returned.
 */
export async function runSoldSearch(
  query: string,
  token: string,
  options: SoldSearchOptions = {},
): Promise<SoldListing[]> {
  const days = Math.min(options.days ?? LOOKBACK_DAYS, MAX_LOOKBACK_DAYS);
  const count = options.count ?? RESULT_COUNT;

  const response = await fetch(APIFY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      keywords: [query],
      ebaySite: "ebay.com",
      daysToScrape: days,
      count,
      sortOrder: "endedRecently",
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Apify returned ${response.status}`);
  }

  const items = (await response.json()) as RawSoldItem[];
  if (!Array.isArray(items)) return [];

  return items
    .map(toSoldListing)
    .sort((a, b) => (b.soldDate ?? "").localeCompare(a.soldDate ?? ""));
}

function runActor(query: string, token: string): Promise<SoldListing[]> {
  return runSoldSearch(query, token, { days: LOOKBACK_DAYS, count: RESULT_COUNT });
}

interface CacheEntry {
  expiresAt: number;
  value: Promise<SoldListing[]>;
}

/**
 * Each Apify run costs money, so identical queries are served from memory for
 * six hours. The promise itself is cached, which also collapses concurrent
 * requests for the same card into a single run.
 */
const cache = new Map<string, CacheEntry>();

function cachedRun(query: string, token: string): Promise<SoldListing[]> {
  const hit = cache.get(query);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const value = runActor(query, token);
  cache.set(query, { value, expiresAt: Date.now() + CACHE_TTL_MS });

  // A transient failure must not be cached for hours.
  value.catch(() => cache.delete(query));

  return value;
}

export async function getSoldListings(
  card: EbayQueryCard,
): Promise<SoldListingsResult> {
  const query = buildEbayQuery(card);

  if (!query) {
    return { status: "error", query, message: "Could not build a search for this card." };
  }

  const token = process.env.APIFY_API_TOKEN;
  if (!token) return { status: "not-configured", query };

  try {
    const listings = await cachedRun(query, token);
    return { status: "ok", listings, query };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? "The eBay lookup timed out."
        : "Could not load eBay sold listings.";

    console.warn(`eBay sold lookup failed for “${query}”:`, error);
    return { status: "error", query, message };
  }
}
