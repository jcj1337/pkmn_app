/**
 * Selects where server-side reads come from, so the file-backed and
 * database-backed paths can run side by side and be compared before either is
 * removed.
 *
 *   TCGRACKER_DATA_SOURCE=FILE       (default) read the local JSON caches
 *   TCGRACKER_DATA_SOURCE=DATABASE   read PostgreSQL
 *
 * The database module is imported DYNAMICALLY and only when selected. PGlite
 * ships a WASM PostgreSQL build, and pulling that into the Next.js server
 * bundle for a path that is not in use would be a large cost for nothing.
 */

import {
  getPriceHistory as getPriceHistoryFromFiles,
  type HistoryRange,
  type PriceHistoryPoint,
  type PriceHistory,
} from "./tcg-price-history";
import type { CardIdentity } from "./tcgdex";

export type DataSource = "FILE" | "DATABASE";

export function activeDataSource(): DataSource {
  return process.env.TCGRACKER_DATA_SOURCE === "DATABASE" ? "DATABASE" : "FILE";
}

/**
 * Price history for a card, from whichever source is configured.
 *
 * Both paths return the same `PriceHistoryPoint[]` — including nulls for days
 * with no market price, which the chart draws as gaps.
 */
export async function loadPriceHistory(
  cardId: string,
  identity: CardIdentity,
  range: HistoryRange = "ALL",
): Promise<PriceHistory | null> {
  if (activeDataSource() === "DATABASE") {
    return loadPriceHistoryFromDatabase(cardId, range);
  }

  return getPriceHistoryFromFiles(
    {
      name: identity.name,
      setName: identity.setName,
      localId: identity.localId,
      printedTotal: identity.printedTotal,
      rarity: identity.rarity,
      variants: identity.variants,
    },
    range,
  );
}

async function loadPriceHistoryFromDatabase(
  cardId: string,
  range: HistoryRange,
): Promise<PriceHistory | null> {
  const [{ getDb }, { getCard, getPriceHistory }] = await Promise.all([
    import("./db/client"),
    import("./db/repository"),
  ]);

  const db = await getDb();
  const card = await getCard(db, cardId);
  if (!card) return null;

  const points = await getPriceHistory(db, cardId);
  if (points.length === 0) return null;

  return {
    points: clampRange(points, range),
    subType: card.tcgplayerSubType ?? "Unknown",
    productId: card.tcgplayerProductId ?? 0,
    // Coverage is the earliest date actually stored, not the range asked for.
    coverageStart: points[0].date,
    range,
  };
}

/** Mirrors the file path's range filtering so the two stay comparable. */
function clampRange(points: PriceHistoryPoint[], range: HistoryRange): PriceHistoryPoint[] {
  if (range === "ALL" || points.length === 0) return points;

  const days = { "1M": 30, "3M": 90, "6M": 182, "1Y": 365 }[range];
  const newest = points[points.length - 1].date;
  const cutoff = new Date(new Date(newest).getTime() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);

  return points.filter((point) => point.date >= cutoff);
}
