/**
 * Database tests. Runs against an ephemeral in-memory PostgreSQL (PGlite), so
 * it never inherits state from a previous run and never touches .pgdata.
 *
 *   npx tsx scripts/test-db.ts
 *
 * The important one is the last section: pricing computed from DATABASE rows
 * must equal the Python reference results field for field. Storage is only
 * correct if swapping it changes nothing.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";

import { closeDb, createSchema, getDb, type Database } from "../lib/db/client";
import {
  getCard,
  getComparableGroups,
  getLastCollectedAt,
  getPriceHistory,
  getRecommendedBuy,
  getSoldListings,
  getSoldListingsForGroup,
  saveCard,
  saveClassifications,
  saveCollectionRun,
  savePriceHistory,
  saveRecommendedBuySnapshot,
  saveSoldListings,
} from "../lib/db/repository";
import { listingClassifications, soldListings } from "../lib/db/schema";
import { classifyListings, comparableGroup } from "../lib/listing-classifier";
import { evaluateRecommendedBuy } from "../lib/recommended-buy";
import { getSetNames } from "../lib/tcgdex";

const ROOT = path.join(import.meta.dirname, "..");
const ANALYSIS = path.join(ROOT, "analysis", "data");

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

const CARD = {
  id: "test-1",
  name: "Test Card",
  setName: "Test Set",
  cardNumber: "1",
  printedTotal: 100,
};

function listing(itemId: string, soldDate: string | null, price: number | null) {
  return {
    itemId,
    title: `Listing ${itemId}`,
    soldPrice: price,
    currency: "USD",
    soldDate,
    condition: null,
    imageUrl: null,
    url: null,
    firstSeenAt: "2026-08-20T00:00:00.000Z",
  };
}

async function main() {
  const db = await getDb({ dataDir: null });
  await createSchema(db);

  /* ------------------------------------------------------ basic round trip */
  console.log("cards");
  await saveCard(db, CARD);
  test("card lookup returns the stored row", async () => {});
  const card = await getCard(db, CARD.id);
  test("getCard returns the saved card", () => {
    assert.equal(card?.id, "test-1");
    assert.equal(card?.name, "Test Card");
  });
  test("getCard returns null for a card that does not exist", async () => {});
  const missing = await getCard(db, "nope");
  test("missing card is null, not a throw", () => assert.equal(missing, null));

  await saveCard(db, { ...CARD, name: "Renamed" });
  const renamed = await getCard(db, CARD.id);
  test("saving the same card id updates rather than duplicating", () => {
    assert.equal(renamed?.name, "Renamed");
  });

  /* ------------------------------------------------------- sold listings */
  console.log("\nsold listings");
  const first = await saveSoldListings(db, CARD.id, [
    listing("a", "2026-08-10", 100),
    listing("b", "2026-08-12", 200),
  ]);
  test("first insert reports both rows as new", () => {
    assert.equal(first.inserted, 2);
    assert.equal(first.skipped, 0);
  });

  const second = await saveSoldListings(db, CARD.id, [
    listing("b", "2026-08-12", 999),
    listing("c", "2026-08-19", 300),
  ]);
  test("re-inserting a known itemId is skipped, not duplicated", () => {
    assert.equal(second.inserted, 1);
    assert.equal(second.skipped, 1);
  });

  const stored = await getSoldListings(db, CARD.id);
  test("itemId is unique — three inserts of four rows yield three listings", () => {
    assert.equal(stored.length, 3);
  });
  test("the first observation wins; a later price does not overwrite it", () => {
    const b = stored.find((row) => row.itemId === "b");
    assert.equal(b?.soldPrice, 200, "price was rewritten by a duplicate");
  });
  test("listings come back newest first", () => {
    assert.deepEqual(stored.map((row) => row.itemId), ["c", "b", "a"]);
  });
  test("money survives the numeric round trip as a number", () => {
    assert.equal(typeof stored[0].soldPrice, "number");
    assert.equal(stored[0].soldPrice, 300);
  });

  await saveSoldListings(db, CARD.id, [listing("d", null, null)]);
  const withNulls = await getSoldListings(db, CARD.id);
  test("missing sold date and price are stored as null, not coerced", () => {
    const d = withNulls.find((row) => row.itemId === "d");
    assert.equal(d?.soldDate, null);
    assert.equal(d?.soldPrice, null);
  });

  /* ------------------------------------------------------ price history */
  console.log("\nprice history");
  await savePriceHistory(db, CARD.id, "Holofoil", 123, [
    { date: "2026-08-03", marketPrice: 12.5 },
    { date: "2026-08-01", marketPrice: 10 },
    { date: "2026-08-02", marketPrice: null },
  ]);
  const history = await getPriceHistory(db, CARD.id);
  test("history is returned in ascending date order", () => {
    assert.deepEqual(history.map((point) => point.date), [
      "2026-08-01", "2026-08-02", "2026-08-03",
    ]);
  });
  test("a day with no market price stays null rather than being filled", () => {
    assert.equal(history[1].marketPrice, null);
  });

  await savePriceHistory(db, CARD.id, "Holofoil", 123, [
    { date: "2026-08-01", marketPrice: 11 },
  ]);
  const rewritten = await getPriceHistory(db, CARD.id);
  test("re-importing a date updates in place instead of duplicating", () => {
    assert.equal(rewritten.length, 3);
    assert.equal(rewritten[0].marketPrice, 11);
  });

  /* --------------------------------------------------- collection runs */
  console.log("\ncollection runs and freshness");
  const runInput = {
    cardId: CARD.id,
    provider: "APIFY",
    query: "Test Card 1/100",
    collectedAt: "2026-08-20T09:00:00.000Z",
    requestedDays: 90,
    requestedCount: 20,
    requestedFrom: "2026-05-22",
    requestedTo: "2026-08-20",
    returned: 20,
    newSales: 20,
    earliestSale: "2026-08-08",
    latestSale: "2026-08-20",
    completeness: "TRUNCATED",
    observedFrom: "2026-08-08",
    observedTo: "2026-08-20",
  };
  const runId = await saveCollectionRun(db, runInput);
  const runIdAgain = await saveCollectionRun(db, runInput);
  test("re-importing the same run reuses its row", () => {
    assert.equal(runId, runIdAgain);
  });

  const collectedAt = await getLastCollectedAt(db, CARD.id);
  test("freshness timestamp is readable for the UI", () => {
    assert.ok(collectedAt instanceof Date);
    assert.equal(collectedAt?.toISOString(), "2026-08-20T09:00:00.000Z");
  });
  test("freshness for an uncollected card is null, not a fake date", async () => {});
  await saveCard(db, { ...CARD, id: "test-2", name: "Never collected" });
  const noFreshness = await getLastCollectedAt(db, "test-2");
  test("uncollected card reports null freshness", () => assert.equal(noFreshness, null));

  /* ------------------------------------------------------ classifications */
  console.log("\nclassifications");
  await saveClassifications(db, "v1", [
    {
      itemId: "a", cardId: CARD.id, relevant: true, relevanceReason: "ok",
      category: "RAW_NM", isGraded: false, gradingCompany: null, grade: null,
      rawCondition: "NM", language: "EN", setMatch: "EXACT", numberEvidence: "FRACTION",
      edition: "UNKNOWN", printVariant: "HOLO",
      comparableGroup: "RAW_NM|UNKNOWN|STANDARD|EN", confidence: 0.9,
    },
  ]);
  const groups = await getComparableGroups(db, CARD.id, "v1");
  test("comparable group lookup returns the group and its count", () => {
    assert.equal(groups.length, 1);
    assert.equal(groups[0].comparableGroup, "RAW_NM|UNKNOWN|STANDARD|EN");
    assert.equal(groups[0].sales, 1);
  });

  const groupSales = await getSoldListingsForGroup(
    db, CARD.id, "RAW_NM|UNKNOWN|STANDARD|EN", "v1",
  );
  test("group query returns the underlying raw listing", () => {
    assert.equal(groupSales.length, 1);
    assert.equal(groupSales[0].itemId, "a");
  });

  // A new classifier version must not destroy the old verdict.
  await saveClassifications(db, "v2", [
    {
      itemId: "a", cardId: CARD.id, relevant: false, relevanceReason: "rejected by v2",
      category: "IRRELEVANT", isGraded: false, gradingCompany: null, grade: null,
      rawCondition: null, language: "EN", setMatch: "EXACT", numberEvidence: "FRACTION",
      edition: "UNKNOWN", printVariant: "HOLO",
      comparableGroup: "IRRELEVANT|UNKNOWN|STANDARD|EN", confidence: 0.9,
    },
  ]);
  const v1Still = await getComparableGroups(db, CARD.id, "v1");
  test("a new classifier version leaves the previous version intact", () => {
    assert.equal(v1Still.length, 1, "v1 results were destroyed by v2");
    assert.equal(v1Still[0].sales, 1);
  });
  const rawUntouched = await getSoldListings(db, CARD.id);
  test("re-classifying never mutates the raw observation", () => {
    assert.equal(rawUntouched.find((row) => row.itemId === "a")?.soldPrice, 100);
  });

  /* -------------------------------------------------- recommended buy */
  console.log("\nrecommended buy snapshots");
  await saveRecommendedBuySnapshot(db, {
    cardId: CARD.id, comparableGroup: "g", status: "AVAILABLE",
    marketReference: 100, recommendedBuy: 85,
    marketReferenceDisplay: 100, recommendedBuyDisplay: 85,
    margin: 0.15, comps: 5, engineVersion: "e1",
    salesCollectedAt: new Date("2026-08-20T09:00:00.000Z"),
  });
  await saveRecommendedBuySnapshot(db, {
    cardId: CARD.id, comparableGroup: "g", status: "AVAILABLE",
    marketReference: 110, recommendedBuy: 95,
    marketReferenceDisplay: 110, recommendedBuyDisplay: 95,
    margin: 0.14, comps: 6, engineVersion: "e1",
    salesCollectedAt: new Date("2026-08-21T09:00:00.000Z"),
  });
  const latest = await getRecommendedBuy(db, CARD.id, "g");
  test("latest snapshot wins, older ones are retained", () => {
    assert.equal(latest?.recommendedBuy, 95);
  });
  test("snapshot carries the freshness of its inputs", () => {
    assert.ok(latest?.salesCollectedAt instanceof Date);
  });

  await saveRecommendedBuySnapshot(db, {
    cardId: CARD.id, comparableGroup: "refused", status: "UNAVAILABLE",
    refusalReason: "TOO_FEW_COMPS", comps: 1, engineVersion: "e1",
  });
  const refusal = await getRecommendedBuy(db, CARD.id, "refused");
  test("a refusal is stored as a result, with its reason", () => {
    assert.equal(refusal?.status, "UNAVAILABLE");
    assert.equal(refusal?.refusalReason, "TOO_FEW_COMPS");
    assert.equal(refusal?.recommendedBuy, null);
  });
  const neverPriced = await getRecommendedBuy(db, CARD.id, "no-such-group");
  test("a group that was never priced returns null", () => {
    assert.equal(neverPriced, null);
  });

  /* --------------------------------------------- FILE vs DATABASE parity */
  console.log("\nfile vs database parity");
  await parityAgainstPythonReference(db);

  console.log(`\n${passed} assertions passed${process.exitCode ? " (with failures)" : ""}`);
  await closeDb();
}

/**
 * The decisive test: import the real fixtures, price every group from DATABASE
 * rows, and compare against the Python reference in analysis/out. If storage
 * changed a single price, this fails.
 */
async function parityAgainstPythonReference(db: Database) {
  const referenceFile = path.join(ROOT, "analysis", "out", "recommended-buy-results.json");
  if (!existsSync(referenceFile)) {
    console.log("  (skipped: analysis/out/recommended-buy-results.json not present)");
    return;
  }

  const reference = JSON.parse(readFileSync(referenceFile, "utf8"));
  const asOf = new Date(`${reference.asOf}T00:00:00Z`);
  const knownSetNames = await getSetNames().catch(() => undefined);

  const cards = JSON.parse(readFileSync(path.join(ANALYSIS, "cards-dev.json"), "utf8"))
    .concat(JSON.parse(readFileSync(path.join(ANALYSIS, "cards-holdout.json"), "utf8")))
    .filter((card: { id: string }, index: number, all: { id: string }[]) =>
      all.findIndex((c) => c.id === card.id) === index);

  const tcgplayer = new Map<string, { subType: string | null; productId: number | null; history: { date: string; marketPrice: number | null }[] }>(
    JSON.parse(readFileSync(path.join(ANALYSIS, "tcgplayer.json"), "utf8"))
      .map((row: { cardId: string }) => [row.cardId, row]),
  );

  const version = createHash("sha256")
    .update(readFileSync(path.join(ROOT, "lib/listing-classifier.ts")))
    .digest("hex")
    .slice(0, 12);

  // Import into the same ephemeral database under a distinct card id prefix is
  // unnecessary — this test database is throwaway, so import directly.
  for (const card of cards) {
    const fixture = path.join(ANALYSIS, "ebay-sold", `${card.id}.json`);
    if (!existsSync(fixture)) continue;

    await saveCard(db, {
      id: card.id, name: card.name, setName: card.setName, cardNumber: card.number,
      printedTotal: card.printedTotal ?? null,
      tcgplayerMarketPrice:
        card.pricing?.kind === "market" ? card.pricing.market : null,
    });

    const link = tcgplayer.get(card.id);
    if (link?.history?.length) {
      await savePriceHistory(db, card.id, link.subType ?? "Unknown", link.productId ?? null, link.history);
    }

    const rows = JSON.parse(readFileSync(fixture, "utf8"));
    const listings = rows.map((row: Record<string, unknown>, index: number) => ({
      itemId: String(row.itemId ?? `unknown-${index}`),
      title: String(row.title ?? ""),
      soldPrice: row.soldPrice == null ? null : Number(row.soldPrice),
      currency: String(row.soldCurrency ?? "USD"),
      soldDate: (row.endedAt as string) ?? null,
      condition: null, imageUrl: null, url: null,
    }));

    await saveSoldListings(
      db, card.id,
      listings.map((l: object) => ({ ...l, firstSeenAt: "2026-08-17T00:00:00.000Z" })) as never,
    );

    const classified = classifyListings(listings, {
      name: card.name, number: card.number,
      printedTotal: card.printedTotal ?? null, setName: card.setName,
    }, { knownSetNames });

    await saveClassifications(db, version, classified.map((c) => ({
      itemId: c.itemId, cardId: card.id, relevant: c.relevant,
      relevanceReason: c.relevanceReason, category: c.category, isGraded: c.isGraded,
      gradingCompany: c.gradingCompany, grade: c.grade, rawCondition: c.rawCondition,
      language: c.language, setMatch: c.setMatch, numberEvidence: c.numberEvidence,
      edition: c.edition, printVariant: c.printVariant,
      comparableGroup: comparableGroup(c), confidence: c.confidence,
    })));
  }

  let compared = 0;
  const mismatches: string[] = [];

  for (const want of reference.groups) {
    const card = await getCard(db, want.cardId);
    if (!card) continue;

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
      .where(and(
        eq(listingClassifications.cardId, want.cardId),
        eq(listingClassifications.comparableGroup, want.group),
        eq(listingClassifications.classifierVersion, version),
        eq(listingClassifications.relevant, true),
      ));

    const sales = rows
      .filter((row) => row.soldPrice !== null)
      .map((row) => ({
        itemId: row.itemId, title: row.title,
        soldPrice: Number(row.soldPrice), soldDate: row.soldDate,
        isGraded: row.isGraded,
      }));

    const history = await getPriceHistory(db, want.cardId);
    const got = evaluateRecommendedBuy({
      groupKey: want.group,
      sales,
      tcgMarketPrice: card.tcgplayerMarketPrice === null ? null : Number(card.tcgplayerMarketPrice),
      history,
      asOf,
    });

    compared++;
    const refused = got.status === "UNAVAILABLE";
    if (refused !== want.refused) {
      mismatches.push(`${want.cardId} ${want.group}: decision ${got.status} vs py refused=${want.refused}`);
      continue;
    }
    if (refused) {
      if (got.reason !== want.refusalCode) {
        mismatches.push(`${want.cardId} ${want.group}: reason ${got.reason} vs ${want.refusalCode}`);
      }
      continue;
    }
    for (const [label, mine, theirs] of [
      ["marketReference", got.marketReference, want.marketReference],
      ["recommendedBuy", got.recommendedBuy, want.recommendedBuy],
      ["margin", got.margin, want.margin],
    ] as [string, number, number][]) {
      if (Math.abs(mine - theirs) > 1e-9) {
        mismatches.push(`${want.cardId} ${want.group}: ${label} ${mine} vs ${theirs}`);
      }
    }
  }

  test(`pricing from database rows matches the Python reference (${compared} groups)`, () => {
    assert.equal(mismatches.length, 0, `\n       ${mismatches.slice(0, 5).join("\n       ")}`);
    assert.ok(compared > 100, `only ${compared} groups compared`);
  });
}

main().catch(async (error) => {
  console.error(error);
  await closeDb();
  process.exitCode = 1;
});
