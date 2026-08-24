/**
 * Imports the project's saved datasets into PostgreSQL.
 *
 *   npx tsx scripts/db-import.ts            # import into .pgdata
 *   npx tsx scripts/db-import.ts --reset    # drop and rebuild first
 *
 * Makes NO provider requests. Everything comes from files already in the repo.
 *
 * The import is idempotent by construction, not by convention: cards upsert on
 * their primary key, sold listings rely on `item_id` being the primary key, and
 * runs/history/classifications have unique natural keys. Running it twice is a
 * no-op, which the test suite asserts by running it twice and comparing counts.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import { closeDb, createSchema, getDb, LOCAL_DB_DIR } from "../lib/db/client";
import {
  saveCard,
  saveClassifications,
  saveCollectionRun,
  savePriceHistory,
  saveSoldListings,
} from "../lib/db/repository";
import { classifyListings, comparableGroup } from "../lib/listing-classifier";
import { assessCompleteness } from "../lib/ebay-history";
import { buildEbayQuery } from "../lib/ebay-sold";
import { getSetNames } from "../lib/tcgdex";

const ROOT = path.join(import.meta.dirname, "..");
const ANALYSIS = path.join(ROOT, "analysis", "data");
const FIXTURES = path.join(ANALYSIS, "ebay-sold");

/** The scrape returned at most this many rows per card; see the liquidity report. */
const FIXTURE_COUNT_CAP = 20;
const FIXTURE_REQUESTED_DAYS = 90;

/**
 * Version labels derived from the source itself, so a rule change produces a
 * new label automatically and stored results stay attributable.
 */
function versionOf(file: string): string {
  const hash = createHash("sha256").update(readFileSync(path.join(ROOT, file))).digest("hex");
  return `${path.basename(file, ".ts")}@${hash.slice(0, 12)}`;
}

interface CardFixture {
  id: string;
  name: string;
  setName: string;
  number: string;
  printedTotal: number | null;
  rarity?: string | null;
  imageUrl?: string | null;
  ebayQuery?: string;
  pricing?: { kind: string; market?: number };
  priceUpdatedAt?: string | null;
}

function loadCards(): CardFixture[] {
  const cards: CardFixture[] = [];
  for (const file of ["cards-dev.json", "cards-holdout.json"]) {
    const full = path.join(ANALYSIS, file);
    if (!existsSync(full)) continue;
    for (const card of JSON.parse(readFileSync(full, "utf8"))) {
      if (!cards.some((c) => c.id === card.id)) cards.push(card);
    }
  }
  return cards;
}

interface TcgplayerEntry {
  cardId: string;
  groupId: number | null;
  productId: number | null;
  subType: string | null;
  history: { date: string; marketPrice: number | null }[];
}

function loadTcgplayer(): Map<string, TcgplayerEntry> {
  const file = path.join(ANALYSIS, "tcgplayer.json");
  if (!existsSync(file)) return new Map();
  const rows: TcgplayerEntry[] = JSON.parse(readFileSync(file, "utf8"));
  return new Map(rows.map((row) => [row.cardId, row]));
}

async function main() {
  const reset = process.argv.includes("--reset");
  if (reset && existsSync(path.join(ROOT, LOCAL_DB_DIR))) {
    rmSync(path.join(ROOT, LOCAL_DB_DIR), { recursive: true, force: true });
    console.log(`removed ${LOCAL_DB_DIR}`);
  }

  const db = await getDb();
  await createSchema(db);

  const classifierVersion = versionOf("lib/listing-classifier.ts");
  console.log(`classifier version : ${classifierVersion}`);

  const knownSetNames = await getSetNames().catch(() => undefined);
  const cards = loadCards();
  const tcgplayer = loadTcgplayer();

  const totals = {
    cards: 0,
    runs: 0,
    listings: 0,
    listingsSkipped: 0,
    classifications: 0,
    historyPoints: 0,
  };

  for (const card of cards) {
    const linkage = tcgplayer.get(card.id);

    await saveCard(db, {
      id: card.id,
      name: card.name,
      setName: card.setName,
      cardNumber: card.number,
      printedTotal: card.printedTotal ?? null,
      rarity: card.rarity ?? null,
      imageUrl: card.imageUrl ?? null,
      ebayQuery: card.ebayQuery ?? buildEbayQuery({
        name: card.name,
        number: card.number,
        printedTotal: card.printedTotal ?? null,
      }),
      tcgplayerGroupId: linkage?.groupId ?? null,
      tcgplayerProductId: linkage?.productId ?? null,
      tcgplayerSubType: linkage?.subType ?? null,
      tcgplayerMarketPrice:
        card.pricing && card.pricing.kind === "market" ? (card.pricing.market ?? null) : null,
      tcgplayerPriceUpdatedAt: card.priceUpdatedAt ? new Date(card.priceUpdatedAt) : null,
    });
    totals.cards++;

    // ---- price history -------------------------------------------------
    if (linkage?.history?.length) {
      totals.historyPoints += await savePriceHistory(
        db,
        card.id,
        linkage.subType ?? "Unknown",
        linkage.productId ?? null,
        linkage.history,
      );
    }

    // ---- raw sold observations ------------------------------------------
    const fixture = path.join(FIXTURES, `${card.id}.json`);
    if (!existsSync(fixture)) continue;

    const raw = JSON.parse(readFileSync(fixture, "utf8"));
    const listings = raw.map((row: Record<string, unknown>, index: number) => ({
      itemId: String(row.itemId ?? `unknown-${index}`),
      title: String(row.title ?? ""),
      soldPrice: row.soldPrice == null ? null : Number(row.soldPrice),
      currency: String(row.soldCurrency ?? "USD"),
      soldDate: (row.endedAt as string) ?? null,
      condition: (row.condition as string) ?? null,
      imageUrl: (row.thumbnailUrl as string) ?? null,
      url: (row.url as string) ?? null,
    }));

    // The fixtures are bare arrays with no run metadata, so the run is
    // RECONSTRUCTED from what the data itself proves: the scrape asked for 90
    // days, stopped at 20 rows, and ended on the newest sale it returned.
    const dates = listings
      .map((l: { soldDate: string | null }) => l.soldDate)
      .filter((d: string | null): d is string => Boolean(d))
      .sort();
    const earliest = dates[0] ?? null;
    const latest = dates[dates.length - 1] ?? null;
    const collectedAt = latest ? `${latest}T00:00:00.000Z` : new Date().toISOString();
    const requestedFrom = new Date(
      new Date(collectedAt).getTime() - FIXTURE_REQUESTED_DAYS * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const requestedTo = collectedAt.slice(0, 10);
    const completeness = assessCompleteness(
      listings.length,
      FIXTURE_COUNT_CAP,
      requestedFrom,
      earliest,
    );

    const runId = await saveCollectionRun(db, {
      cardId: card.id,
      provider: "APIFY",
      query: card.ebayQuery ?? "",
      collectedAt,
      requestedDays: FIXTURE_REQUESTED_DAYS,
      requestedCount: FIXTURE_COUNT_CAP,
      requestedFrom,
      requestedTo,
      returned: listings.length,
      newSales: listings.length,
      earliestSale: earliest,
      latestSale: latest,
      completeness,
      observedFrom: completeness === "TRUNCATED" && earliest ? earliest : requestedFrom,
      observedTo: requestedTo,
    });
    totals.runs++;

    const saved = await saveSoldListings(
      db,
      card.id,
      listings.map((l: Record<string, unknown>) => ({
        ...l,
        firstSeenAt: collectedAt,
      })) as never,
      runId,
    );
    totals.listings += saved.inserted;
    totals.listingsSkipped += saved.skipped;

    // ---- derived classification ------------------------------------------
    // Run the real classifier over the stored raw rows rather than importing
    // a saved analysis artifact: that is the replay path the architecture
    // depends on, so it should be exercised by the import itself.
    const classified = classifyListings(listings, {
      name: card.name,
      number: card.number,
      printedTotal: card.printedTotal ?? null,
      setName: card.setName,
    }, { knownSetNames });

    totals.classifications += await saveClassifications(
      db,
      classifierVersion,
      classified.map((c) => ({
        itemId: c.itemId,
        cardId: card.id,
        relevant: c.relevant,
        relevanceReason: c.relevanceReason,
        category: c.category,
        isGraded: c.isGraded,
        gradingCompany: c.gradingCompany,
        grade: c.grade,
        rawCondition: c.rawCondition,
        language: c.language,
        setMatch: c.setMatch,
        numberEvidence: c.numberEvidence,
        edition: c.edition,
        printVariant: c.printVariant,
        comparableGroup: comparableGroup(c),
        confidence: c.confidence,
      })),
    );
  }

  console.log("");
  console.log(`cards            : ${totals.cards}`);
  console.log(`collection runs  : ${totals.runs}`);
  console.log(`sold listings    : ${totals.listings} inserted, ${totals.listingsSkipped} already present`);
  console.log(`classifications  : ${totals.classifications}`);
  console.log(`price history    : ${totals.historyPoints} points`);
  console.log("");
  console.log(`database         : ${LOCAL_DB_DIR}`);

  await closeDb();
}

main().catch(async (error) => {
  console.error(error);
  await closeDb();
  process.exitCode = 1;
});
