/**
 * Data access for TCGracker.
 *
 * The only place that writes SQL. Server components, scripts and the pricing
 * engine call these functions and receive domain types — `SoldListing`,
 * `PriceHistoryPoint` — identical to the ones the file-backed path returns, so
 * a caller cannot tell which storage it is talking to.
 *
 * The pricing engine stays a pure calculation over inputs; nothing here
 * computes a price. Snapshots are written by whoever ran the engine.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client";
import {
  cards,
  collectionRuns,
  listingClassifications,
  priceHistory,
  recommendedBuySnapshots,
  soldListings,
} from "./schema";
import type { SoldListing } from "../ebay-sold";
import type { PriceHistoryPoint } from "../tcg-price-history";

/** Postgres NUMERIC arrives as a string to avoid float loss; convert at the edge. */
const toNumber = (value: string | null): number | null =>
  value === null || value === "" ? null : Number(value);

const toNumeric = (value: number | null | undefined): string | null =>
  value === null || value === undefined || !Number.isFinite(value) ? null : String(value);

/* ------------------------------------------------------------------ cards */

export interface CardInput {
  id: string;
  name: string;
  setName: string;
  cardNumber: string;
  printedTotal: number | null;
  rarity?: string | null;
  imageUrl?: string | null;
  ebayQuery?: string | null;
  tcgplayerGroupId?: number | null;
  tcgplayerProductId?: number | null;
  tcgplayerSubType?: string | null;
  tcgplayerMarketPrice?: number | null;
  tcgplayerPriceUpdatedAt?: Date | null;
}

export async function getCard(db: Database, cardId: string) {
  const [row] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
  return row ?? null;
}

export async function listCards(db: Database) {
  return db.select().from(cards).orderBy(asc(cards.id));
}

/**
 * Inserts or updates a card. Idempotent by primary key, so re-running an
 * import refreshes metadata instead of failing or duplicating.
 */
export async function saveCard(db: Database, card: CardInput): Promise<void> {
  await db
    .insert(cards)
    .values({
      id: card.id,
      name: card.name,
      setName: card.setName,
      cardNumber: card.cardNumber,
      printedTotal: card.printedTotal,
      rarity: card.rarity ?? null,
      imageUrl: card.imageUrl ?? null,
      ebayQuery: card.ebayQuery ?? null,
      tcgplayerGroupId: card.tcgplayerGroupId ?? null,
      tcgplayerProductId: card.tcgplayerProductId ?? null,
      tcgplayerSubType: card.tcgplayerSubType ?? null,
      tcgplayerMarketPrice: toNumeric(card.tcgplayerMarketPrice),
      tcgplayerPriceUpdatedAt: card.tcgplayerPriceUpdatedAt ?? null,
    })
    .onConflictDoUpdate({
      target: cards.id,
      set: {
        name: card.name,
        setName: card.setName,
        cardNumber: card.cardNumber,
        printedTotal: card.printedTotal,
        rarity: card.rarity ?? null,
        imageUrl: card.imageUrl ?? null,
        ebayQuery: card.ebayQuery ?? null,
        tcgplayerGroupId: card.tcgplayerGroupId ?? null,
        tcgplayerProductId: card.tcgplayerProductId ?? null,
        tcgplayerSubType: card.tcgplayerSubType ?? null,
        tcgplayerMarketPrice: toNumeric(card.tcgplayerMarketPrice),
        tcgplayerPriceUpdatedAt: card.tcgplayerPriceUpdatedAt ?? null,
        updatedAt: new Date(),
      },
    });
}

/* ---------------------------------------------------------- sold listings */

/** Row shape used when importing raw observations. */
export interface SoldListingInput extends SoldListing {
  firstSeenAt: string;
}

/**
 * Stores raw observations, deduplicated by eBay's own item id.
 *
 * `onConflictDoNothing` is the important part: the FIRST observation wins.
 * A later collection re-reporting the same sale must not overwrite the
 * original title, price or `firstSeenAt` — that would rewrite history and
 * break the "when did we first see this" provenance.
 *
 * Returns how many rows were genuinely new, which is what makes an import
 * verifiably idempotent.
 */
export async function saveSoldListings(
  db: Database,
  cardId: string,
  listings: SoldListingInput[],
  runId?: number,
): Promise<{ inserted: number; skipped: number }> {
  if (listings.length === 0) return { inserted: 0, skipped: 0 };

  const rows = listings.map((listing) => ({
    itemId: listing.itemId,
    cardId,
    title: listing.title,
    soldPrice: toNumeric(listing.soldPrice),
    currency: listing.currency || "USD",
    soldDate: listing.soldDate ? listing.soldDate.slice(0, 10) : null,
    condition: listing.condition ?? null,
    imageUrl: listing.imageUrl ?? null,
    url: listing.url ?? null,
    firstSeenAt: new Date(listing.firstSeenAt),
    firstSeenRunId: runId ?? null,
  }));

  const inserted = await db
    .insert(soldListings)
    .values(rows)
    .onConflictDoNothing({ target: soldListings.itemId })
    .returning({ itemId: soldListings.itemId });

  return { inserted: inserted.length, skipped: rows.length - inserted.length };
}

/** Raw sales for a card, newest first. Classification is not applied here. */
export async function getSoldListings(
  db: Database,
  cardId: string,
): Promise<SoldListing[]> {
  const rows = await db
    .select()
    .from(soldListings)
    .where(eq(soldListings.cardId, cardId))
    .orderBy(desc(soldListings.soldDate));

  return rows.map((row) => ({
    itemId: row.itemId,
    title: row.title,
    soldPrice: toNumber(row.soldPrice),
    currency: row.currency,
    soldDate: row.soldDate,
    condition: row.condition,
    imageUrl: row.imageUrl,
    url: row.url,
  }));
}

/**
 * Sales belonging to one comparable group, via the stored classification.
 *
 * Joined at query time rather than denormalised onto the listing, so
 * re-classifying under a new version changes what this returns without any
 * raw row being rewritten.
 */
export async function getSoldListingsForGroup(
  db: Database,
  cardId: string,
  comparableGroup: string,
  classifierVersion: string,
): Promise<SoldListing[]> {
  const rows = await db
    .select({ listing: soldListings })
    .from(listingClassifications)
    .innerJoin(soldListings, eq(soldListings.itemId, listingClassifications.itemId))
    .where(
      and(
        eq(listingClassifications.cardId, cardId),
        eq(listingClassifications.comparableGroup, comparableGroup),
        eq(listingClassifications.classifierVersion, classifierVersion),
        eq(listingClassifications.relevant, true),
      ),
    )
    .orderBy(desc(soldListings.soldDate));

  return rows.map(({ listing }) => ({
    itemId: listing.itemId,
    title: listing.title,
    soldPrice: toNumber(listing.soldPrice),
    currency: listing.currency,
    soldDate: listing.soldDate,
    condition: listing.condition,
    imageUrl: listing.imageUrl,
    url: listing.url,
  }));
}

/* --------------------------------------------------------- classifications */

export interface ClassificationInput {
  itemId: string;
  cardId: string;
  relevant: boolean;
  relevanceReason: string;
  category: string;
  isGraded: boolean;
  gradingCompany: string | null;
  grade: number | null;
  rawCondition: string | null;
  language: string;
  setMatch: string;
  numberEvidence: string;
  edition: string;
  printVariant: string;
  comparableGroup: string;
  confidence: number;
}

/**
 * Stores derived classifier output under a version label.
 *
 * Re-running the same version updates in place; running a NEW version writes a
 * parallel set of rows, leaving the previous results intact for comparison.
 */
export async function saveClassifications(
  db: Database,
  classifierVersion: string,
  rows: ClassificationInput[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const values = rows.map((row) => ({
    itemId: row.itemId,
    cardId: row.cardId,
    classifierVersion,
    relevant: row.relevant,
    relevanceReason: row.relevanceReason,
    category: row.category,
    isGraded: row.isGraded,
    gradingCompany: row.gradingCompany,
    grade: toNumeric(row.grade),
    rawCondition: row.rawCondition,
    language: row.language,
    setMatch: row.setMatch,
    numberEvidence: row.numberEvidence,
    edition: row.edition,
    printVariant: row.printVariant,
    comparableGroup: row.comparableGroup,
    confidence: toNumeric(row.confidence) ?? "0",
  }));

  await db
    .insert(listingClassifications)
    .values(values)
    .onConflictDoUpdate({
      target: [
        listingClassifications.itemId,
        listingClassifications.cardId,
        listingClassifications.classifierVersion,
      ],
      set: {
        relevant: sql`excluded.relevant`,
        relevanceReason: sql`excluded.relevance_reason`,
        category: sql`excluded.category`,
        isGraded: sql`excluded.is_graded`,
        gradingCompany: sql`excluded.grading_company`,
        grade: sql`excluded.grade`,
        rawCondition: sql`excluded.raw_condition`,
        language: sql`excluded.language`,
        setMatch: sql`excluded.set_match`,
        numberEvidence: sql`excluded.number_evidence`,
        edition: sql`excluded.edition`,
        printVariant: sql`excluded.print_variant`,
        comparableGroup: sql`excluded.comparable_group`,
        confidence: sql`excluded.confidence`,
        classifiedAt: new Date(),
      },
    });

  return values.length;
}

/** Distinct comparable groups for a card, with their sale counts. */
export async function getComparableGroups(
  db: Database,
  cardId: string,
  classifierVersion: string,
) {
  return db
    .select({
      comparableGroup: listingClassifications.comparableGroup,
      sales: sql<number>`count(*)::int`,
    })
    .from(listingClassifications)
    .where(
      and(
        eq(listingClassifications.cardId, cardId),
        eq(listingClassifications.classifierVersion, classifierVersion),
        eq(listingClassifications.relevant, true),
      ),
    )
    .groupBy(listingClassifications.comparableGroup)
    .orderBy(desc(sql`count(*)`));
}

/* ----------------------------------------------------------- price history */

export async function savePriceHistory(
  db: Database,
  cardId: string,
  subType: string,
  productId: number | null,
  points: PriceHistoryPoint[],
): Promise<number> {
  if (points.length === 0) return 0;

  const values = points.map((point) => ({
    cardId,
    tcgplayerProductId: productId,
    subType,
    date: point.date.slice(0, 10),
    marketPrice: toNumeric(point.marketPrice),
  }));

  await db
    .insert(priceHistory)
    .values(values)
    .onConflictDoUpdate({
      target: [priceHistory.cardId, priceHistory.subType, priceHistory.date],
      set: { marketPrice: sql`excluded.market_price` },
    });

  return values.length;
}

/**
 * Price history in date order.
 *
 * Nulls are preserved rather than filtered: a day with no market price is a
 * real gap and the chart depends on seeing it.
 */
export async function getPriceHistory(
  db: Database,
  cardId: string,
): Promise<PriceHistoryPoint[]> {
  const rows = await db
    .select()
    .from(priceHistory)
    .where(eq(priceHistory.cardId, cardId))
    .orderBy(asc(priceHistory.date));

  return rows.map((row) => ({
    date: row.date,
    marketPrice: toNumber(row.marketPrice),
  }));
}

/* ------------------------------------------------------- collection runs */

export interface CollectionRunInput {
  cardId: string;
  provider: string;
  query: string;
  collectedAt: string;
  requestedDays: number;
  requestedCount: number;
  requestedFrom: string;
  requestedTo: string;
  returned: number;
  newSales: number;
  earliestSale: string | null;
  latestSale: string | null;
  completeness: string;
  observedFrom: string;
  observedTo: string;
}

/** Returns the run id, reusing an existing row when the same run is re-imported. */
export async function saveCollectionRun(
  db: Database,
  run: CollectionRunInput,
): Promise<number> {
  const [inserted] = await db
    .insert(collectionRuns)
    .values({ ...run, collectedAt: new Date(run.collectedAt) })
    .onConflictDoNothing({
      target: [collectionRuns.cardId, collectionRuns.provider, collectionRuns.collectedAt],
    })
    .returning({ id: collectionRuns.id });

  if (inserted) return inserted.id;

  const [existing] = await db
    .select({ id: collectionRuns.id })
    .from(collectionRuns)
    .where(
      and(
        eq(collectionRuns.cardId, run.cardId),
        eq(collectionRuns.provider, run.provider),
        eq(collectionRuns.collectedAt, new Date(run.collectedAt)),
      ),
    )
    .limit(1);

  return existing.id;
}

/**
 * When this card's sales were last collected — the number behind
 * "Comparable sales updated Aug 23".
 */
export async function getLastCollectedAt(
  db: Database,
  cardId: string,
): Promise<Date | null> {
  const [row] = await db
    .select({ collectedAt: collectionRuns.collectedAt })
    .from(collectionRuns)
    .where(eq(collectionRuns.cardId, cardId))
    .orderBy(desc(collectionRuns.collectedAt))
    .limit(1);

  return row?.collectedAt ?? null;
}

/* ------------------------------------------------- recommended buy snapshots */

export interface RecommendedBuySnapshotInput {
  cardId: string;
  comparableGroup: string;
  status: "AVAILABLE" | "UNAVAILABLE";
  refusalReason?: string | null;
  marketReference?: number | null;
  recommendedBuy?: number | null;
  marketReferenceDisplay?: number | null;
  recommendedBuyDisplay?: number | null;
  margin?: number | null;
  comps: number;
  evidence?: unknown;
  marginComponents?: unknown;
  engineVersion: string;
  salesCollectedAt?: Date | null;
}

export async function saveRecommendedBuySnapshot(
  db: Database,
  snapshot: RecommendedBuySnapshotInput,
): Promise<number> {
  const [row] = await db
    .insert(recommendedBuySnapshots)
    .values({
      cardId: snapshot.cardId,
      comparableGroup: snapshot.comparableGroup,
      status: snapshot.status,
      refusalReason: snapshot.refusalReason ?? null,
      marketReference: toNumeric(snapshot.marketReference),
      recommendedBuy: toNumeric(snapshot.recommendedBuy),
      marketReferenceDisplay: toNumeric(snapshot.marketReferenceDisplay),
      recommendedBuyDisplay: toNumeric(snapshot.recommendedBuyDisplay),
      margin: toNumeric(snapshot.margin),
      comps: snapshot.comps,
      evidence: snapshot.evidence ?? null,
      marginComponents: snapshot.marginComponents ?? null,
      engineVersion: snapshot.engineVersion,
      salesCollectedAt: snapshot.salesCollectedAt ?? null,
    })
    .returning({ id: recommendedBuySnapshots.id });

  return row.id;
}

/** The most recent snapshot for a card+group, or null if never priced. */
export async function getRecommendedBuy(
  db: Database,
  cardId: string,
  comparableGroup: string,
) {
  const [row] = await db
    .select()
    .from(recommendedBuySnapshots)
    .where(
      and(
        eq(recommendedBuySnapshots.cardId, cardId),
        eq(recommendedBuySnapshots.comparableGroup, comparableGroup),
      ),
    )
    .orderBy(desc(recommendedBuySnapshots.pricingCalculatedAt), desc(recommendedBuySnapshots.id))
    .limit(1);

  if (!row) return null;

  return {
    ...row,
    marketReference: toNumber(row.marketReference),
    recommendedBuy: toNumber(row.recommendedBuy),
    marketReferenceDisplay: toNumber(row.marketReferenceDisplay),
    recommendedBuyDisplay: toNumber(row.recommendedBuyDisplay),
    margin: toNumber(row.margin),
  };
}
