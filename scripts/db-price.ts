/**
 * Recomputes Recommended Buy from stored data and writes snapshots.
 *
 *   npx tsx scripts/db-price.ts
 *
 * This is the "pricing" stage of the pipeline:
 *
 *   raw observation -> classification -> comparable group -> pricing result
 *
 * It reads only from the database and makes no provider requests, which is the
 * whole point of persisting raw observations: a pricing or classifier change is
 * a recompute, not a re-collection.
 *
 * The engine itself stays pure — it is handed inputs and returns a result. This
 * script does the I/O.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { closeDb, getDb } from "../lib/db/client";
import {
  getComparableGroups,
  getLastCollectedAt,
  getPriceHistory,
  getSoldListingsForGroup,
  listCards,
  saveRecommendedBuySnapshot,
} from "../lib/db/repository";
import { listingClassifications, soldListings } from "../lib/db/schema";
import { evaluateRecommendedBuy } from "../lib/recommended-buy";
import { and, eq } from "drizzle-orm";

const ROOT = path.join(import.meta.dirname, "..");

function versionOf(file: string): string {
  const hash = createHash("sha256").update(readFileSync(path.join(ROOT, file))).digest("hex");
  return `${path.basename(file, ".ts")}@${hash.slice(0, 12)}`;
}

async function main() {
  const db = await getDb();
  const classifierVersion = versionOf("lib/listing-classifier.ts");
  const engineVersion = versionOf("lib/recommended-buy.ts");

  console.log(`classifier : ${classifierVersion}`);
  console.log(`engine     : ${engineVersion}`);
  console.log("");

  const cards = await listCards(db);
  let priced = 0;
  let refused = 0;

  for (const card of cards) {
    const history = await getPriceHistory(db, card.id);
    const collectedAt = await getLastCollectedAt(db, card.id);
    const groups = await getComparableGroups(db, card.id, classifierVersion);

    // The engine needs isGraded per sale, which lives on the classification.
    for (const group of groups) {
      const rows = await db
        .select({
          itemId: soldListings.itemId,
          title: soldListings.title,
          soldPrice: soldListings.soldPrice,
          soldDate: soldListings.soldDate,
          isGraded: listingClassifications.isGraded,
        })
        .from(listingClassifications)
        .innerJoin(soldListings, eq(soldListings.itemId, listingClassifications.itemId))
        .where(
          and(
            eq(listingClassifications.cardId, card.id),
            eq(listingClassifications.comparableGroup, group.comparableGroup),
            eq(listingClassifications.classifierVersion, classifierVersion),
            eq(listingClassifications.relevant, true),
          ),
        );

      const sales = rows
        .filter((row) => row.soldPrice !== null)
        .map((row) => ({
          itemId: row.itemId,
          title: row.title,
          soldPrice: Number(row.soldPrice),
          soldDate: row.soldDate,
          isGraded: row.isGraded,
        }));

      const result = evaluateRecommendedBuy({
        groupKey: group.comparableGroup,
        sales,
        // The card's stored TCGplayer market price — the same figure the
        // file-backed path uses. Not the newest history sample, which is a
        // weekly archive value and would price differently.
        tcgMarketPrice: card.tcgplayerMarketPrice === null ? null : Number(card.tcgplayerMarketPrice),
        history,
        asOf: new Date(),
      });

      await saveRecommendedBuySnapshot(db, {
        cardId: card.id,
        comparableGroup: group.comparableGroup,
        status: result.status,
        refusalReason: result.status === "UNAVAILABLE" ? result.reason : null,
        marketReference: result.status === "AVAILABLE" ? result.marketReference : null,
        recommendedBuy: result.status === "AVAILABLE" ? result.recommendedBuy : null,
        marketReferenceDisplay:
          result.status === "AVAILABLE" ? result.marketReferenceDisplay : null,
        recommendedBuyDisplay:
          result.status === "AVAILABLE" ? result.recommendedBuyDisplay : null,
        margin: result.status === "AVAILABLE" ? result.margin : null,
        comps: result.status === "AVAILABLE" ? result.evidence.comps : result.comps,
        evidence: result.status === "AVAILABLE" ? result.evidence : null,
        marginComponents: result.status === "AVAILABLE" ? result.marginComponents : null,
        engineVersion,
        salesCollectedAt: collectedAt,
      });

      if (result.status === "AVAILABLE") priced++;
      else refused++;
    }
  }

  console.log(`groups priced  : ${priced}`);
  console.log(`groups refused : ${refused}`);
  console.log(`snapshots      : ${priced + refused}`);

  await closeDb();
}

main().catch(async (error) => {
  console.error(error);
  await closeDb();
  process.exitCode = 1;
});
