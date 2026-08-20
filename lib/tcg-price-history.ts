/**
 * TCGplayer market-price history, sourced from TCGCSV's daily archives.
 *
 * TCGCSV publishes one 7z per day at
 *   https://tcgcsv.com/archive/tcgplayer/prices-YYYY-MM-DD.ppmd.7z
 * containing `{date}/{categoryId}/{groupId}/prices` — the same JSON shape as
 * the live endpoint. There is no per-date HTTP endpoint (a `?date=` query is
 * silently ignored), so history can only come from those archives.
 *
 * Downloading them at render time would be absurd (~3.5 MB per day, ~925 days),
 * so `scripts/backfill-price-history.cjs` does that offline and writes one
 * compact file per group. This module only reads that cache — the UI never
 * learns anything about archives.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { lookupCard, type TcgcsvQuery } from "./tcgcsv";

/** First day TCGCSV published an archive. Nothing exists before this. */
export const HISTORY_EPOCH = "2024-02-08";

export interface PriceHistoryPoint {
  date: string;
  /** null where TCGplayer published no market price that day. Never substituted. */
  marketPrice: number | null;
}

export type HistoryRange = "1M" | "3M" | "6M" | "1Y" | "ALL";

export interface PriceHistory {
  points: PriceHistoryPoint[];
  productId: number;
  /** The exact TCGplayer print the series belongs to, e.g. "Holofoil". */
  subType: string;
  /** Earliest date present in the cache for this group. */
  coverageStart: string;
  range: HistoryRange;
}

/** On-disk shape written by the backfill script. Parallel arrays keep it small. */
interface GroupHistoryFile {
  groupId: number;
  generatedAt: string;
  dates: string[];
  /** productId -> subTypeName -> price per date index (null = no market price). */
  series: Record<string, Record<string, (number | null)[]>>;
}

const CACHE_DIR = path.join(process.cwd(), "data", "price-history");

const RANGE_DAYS: Record<Exclude<HistoryRange, "ALL">, number> = {
  "1M": 30,
  "3M": 91,
  "6M": 183,
  "1Y": 365,
};

const fileCache = new Map<number, GroupHistoryFile | null>();

async function loadGroupHistory(groupId: number): Promise<GroupHistoryFile | null> {
  if (fileCache.has(groupId)) return fileCache.get(groupId) ?? null;

  let parsed: GroupHistoryFile | null = null;
  try {
    const raw = await readFile(path.join(CACHE_DIR, `${groupId}.json`), "utf8");
    parsed = JSON.parse(raw) as GroupHistoryFile;
  } catch {
    // No backfill for this group yet — not an error, just no history to show.
    parsed = null;
  }

  fileCache.set(groupId, parsed);
  return parsed;
}

function cutoffFor(range: HistoryRange): string | null {
  if (range === "ALL") return null;

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RANGE_DAYS[range]);
  return cutoff.toISOString().slice(0, 10);
}

/**
 * Series for the exact card, matched with the same `lookupCard` used by the
 * pricing fallback so the history belongs to the same product and print.
 *
 * Returns null when the card cannot be matched or the group has no backfill.
 */
export async function getPriceHistory(
  query: TcgcsvQuery,
  range: HistoryRange = "1Y",
): Promise<PriceHistory | null> {
  const lookup = await lookupCard(query).catch(() => null);
  if (!lookup || lookup.status !== "matched") return null;

  const { groupId, productId, subType } = lookup.match;
  if (!subType) return null;

  const file = await loadGroupHistory(groupId);
  if (!file) return null;

  const byProduct = file.series[String(productId)];
  const prices = byProduct?.[subType];
  if (!prices) return null;

  const cutoff = cutoffFor(range);

  const points: PriceHistoryPoint[] = [];
  for (const [index, date] of file.dates.entries()) {
    if (cutoff && date < cutoff) continue;
    points.push({ date, marketPrice: prices[index] ?? null });
  }

  // A card printed after the archive epoch simply has no earlier rows, so its
  // series starts at release rather than being padded backwards.
  const observed = points.filter((point) => point.marketPrice !== null);
  if (observed.length === 0) return null;

  return {
    points,
    productId,
    subType,
    coverageStart: file.dates[0] ?? HISTORY_EPOCH,
    range,
  };
}
