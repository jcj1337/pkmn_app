/**
 * PostgreSQL schema for TCGracker.
 *
 * The domain model already exists in lib/*.ts; this mirrors it rather than
 * inventing a parallel one. Two principles drive the shape:
 *
 * 1. RAW OBSERVATIONS ARE IMMUTABLE AND REPLAYABLE.
 *    `sold_listings` holds exactly what a provider reported and nothing a
 *    classifier decided. Classifier output lives in `listing_classifications`,
 *    keyed by version, so changing a rule means re-running classification over
 *    stored rows — never re-collecting from a paid provider.
 *
 * 2. FRESHNESS IS PART OF THE DATA.
 *    Marketplace data is collected in batches, not streamed. Every derived row
 *    records when it was computed and how old its inputs were, so the app can
 *    say "comparable sales updated Aug 23" instead of implying live prices.
 *
 * Deliberately NOT modelled: a `pricing_groups` table. A comparable group is a
 * derived attribute of a classification, not an entity with its own lifecycle,
 * and its display label is context-dependent — "Raw" becomes "Raw · 1st
 * Edition" only when a sibling group exists for that card. Storing a label per
 * group would therefore be wrong as often as it was right. Grouping is served
 * by an index on (card_id, comparable_group) instead.
 */

import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ cards */

/**
 * One row per card we track. `id` is the TCGdex card id ("swsh7-215"), which
 * is already the identifier used throughout the app and the fixtures.
 */
export const cards = pgTable("cards", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  setName: text("set_name").notNull(),
  cardNumber: text("card_number").notNull(),
  printedTotal: integer("printed_total"),
  rarity: text("rarity"),
  imageUrl: text("image_url"),
  /** The eBay search string this card resolves to; stored so it is auditable. */
  ebayQuery: text("ebay_query"),

  /** TCGCSV/TCGplayer linkage, resolved once by the existing matcher. */
  tcgplayerGroupId: integer("tcgplayer_group_id"),
  tcgplayerProductId: integer("tcgplayer_product_id"),
  tcgplayerSubType: text("tcgplayer_sub_type"),

  /**
   * Current TCGplayer market price, as the app resolves it from TCGdex/TCGCSV.
   * Stored rather than derived from the newest price_history row: history is a
   * weekly archive sample, and using it here would silently price cards off a
   * different number than the file-backed path does.
   */
  tcgplayerMarketPrice: numeric("tcgplayer_market_price", { precision: 12, scale: 2 }),
  tcgplayerPriceUpdatedAt: timestamp("tcgplayer_price_updated_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------- collection runs */

/**
 * One row per provider call. Mirrors `CollectionRun` in lib/ebay-history.ts.
 *
 * `completeness` plus `observed_from` is the pair that stops the analysis from
 * over-claiming: a TRUNCATED run only vouches for the span it actually reached.
 */
export const collectionRuns = pgTable(
  "collection_runs",
  {
    id: serial("id").primaryKey(),
    cardId: text("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),

    /** Matches ProviderId in lib/sold-listings-provider.ts. */
    provider: text("provider").notNull(),
    query: text("query").notNull(),

    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
    requestedDays: integer("requested_days").notNull(),
    requestedCount: integer("requested_count").notNull(),
    requestedFrom: date("requested_from").notNull(),
    requestedTo: date("requested_to").notNull(),

    returned: integer("returned").notNull(),
    newSales: integer("new_sales").notNull(),
    earliestSale: date("earliest_sale"),
    latestSale: date("latest_sale"),

    /** COMPLETE | TRUNCATED | EMPTY */
    completeness: text("completeness").notNull(),
    /** The window this run can actually vouch for. */
    observedFrom: date("observed_from").notNull(),
    observedTo: date("observed_to").notNull(),
  },
  (table) => [
    index("collection_runs_card_idx").on(table.cardId, table.collectedAt),
    // Re-importing the same run must not duplicate it.
    uniqueIndex("collection_runs_natural_key").on(
      table.cardId,
      table.provider,
      table.collectedAt,
    ),
  ],
);

/* ---------------------------------------------------------- sold listings */

/**
 * RAW provider observations. Nothing here is a judgement.
 *
 * `item_id` is eBay's own primary key and is the deduplication key across every
 * collection — it is the PRIMARY KEY here, which makes duplicate imports a
 * no-op at the database level rather than a matter of application discipline.
 *
 * `card_id` is PROVENANCE: the card search that first surfaced this listing.
 * It is not an exclusive claim. Overlapping searches can surface the same sale,
 * so the listing-to-card relationship that matters for pricing is carried by
 * `listing_classifications`, which is keyed per target card.
 */
export const soldListings = pgTable(
  "sold_listings",
  {
    itemId: text("item_id").primaryKey(),
    cardId: text("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),

    title: text("title").notNull(),
    /** numeric, not float: these are money. Null when the provider had none. */
    soldPrice: numeric("sold_price", { precision: 12, scale: 2 }),
    currency: text("currency").notNull().default("USD"),
    soldDate: date("sold_date"),
    condition: text("condition"),
    imageUrl: text("image_url"),
    url: text("url"),

    /** When WE first observed it — not when it sold. */
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    /** The run that first surfaced it, for provenance. */
    firstSeenRunId: integer("first_seen_run_id").references(() => collectionRuns.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    index("sold_listings_card_idx").on(table.cardId),
    index("sold_listings_card_date_idx").on(table.cardId, table.soldDate),
  ],
);

/* -------------------------------------------------- listing classifications */

/**
 * DERIVED. One row per (listing, classifier version).
 *
 * Versioning is what makes a classifier change safe: a new version writes new
 * rows beside the old ones, results can be compared, and no raw observation is
 * touched. `card_id` is denormalised from sold_listings purely so that
 * "sales for one comparable group" is a single-table index scan.
 */
export const listingClassifications = pgTable(
  "listing_classifications",
  {
    id: serial("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => soldListings.itemId, { onDelete: "cascade" }),
    cardId: text("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),

    classifierVersion: text("classifier_version").notNull(),

    relevant: boolean("relevant").notNull(),
    relevanceReason: text("relevance_reason").notNull(),
    category: text("category").notNull(),
    isGraded: boolean("is_graded").notNull(),
    gradingCompany: text("grading_company"),
    grade: numeric("grade", { precision: 3, scale: 1 }),
    rawCondition: text("raw_condition"),
    language: text("language").notNull(),
    setMatch: text("set_match").notNull(),
    numberEvidence: text("number_evidence").notNull(),
    edition: text("edition").notNull(),
    printVariant: text("print_variant").notNull(),
    /** The full comparableGroup() key: category|edition|printing|language. */
    comparableGroup: text("comparable_group").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 2 }).notNull(),

    classifiedAt: timestamp("classified_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Keyed by target card as well as item: one eBay listing can be surfaced
    // by several card searches, and it is relevant to at most one of them.
    // Without card_id here, the second card's verdict silently overwrites the
    // first and a real classification is lost.
    uniqueIndex("listing_classifications_item_card_version").on(
      table.itemId,
      table.cardId,
      table.classifierVersion,
    ),
    index("listing_classifications_group_idx").on(
      table.cardId,
      table.comparableGroup,
      table.classifierVersion,
    ),
  ],
);

/* ----------------------------------------------------------- price history */

/**
 * TCGplayer market price over time, from the TCGCSV archive cache.
 *
 * `market_price` is nullable ON PURPOSE. A day with no market price is a real
 * observation of absence, and the chart draws a gap rather than interpolating;
 * writing a substitute value here would destroy that.
 */
export const priceHistory = pgTable(
  "price_history",
  {
    id: serial("id").primaryKey(),
    cardId: text("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    tcgplayerProductId: integer("tcgplayer_product_id"),
    subType: text("sub_type").notNull(),
    date: date("date").notNull(),
    marketPrice: numeric("market_price", { precision: 12, scale: 2 }),
  },
  (table) => [
    uniqueIndex("price_history_natural_key").on(table.cardId, table.subType, table.date),
    index("price_history_card_date_idx").on(table.cardId, table.date),
  ],
);

/* ------------------------------------------------ recommended buy snapshots */

/**
 * DERIVED pricing output, appended not overwritten.
 *
 * Snapshots rather than current-state rows: the price a user was shown last
 * week is a fact worth keeping, and an append-only table makes "why did this
 * change?" answerable. The app reads the newest row per (card, group).
 *
 * Refusals are stored too — "we declined to price this, and why" is a result.
 */
export const recommendedBuySnapshots = pgTable(
  "recommended_buy_snapshots",
  {
    id: serial("id").primaryKey(),
    cardId: text("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    comparableGroup: text("comparable_group").notNull(),

    /** AVAILABLE | UNAVAILABLE */
    status: text("status").notNull(),
    /** Set only when UNAVAILABLE; the named gate that refused. */
    refusalReason: text("refusal_reason"),

    marketReference: numeric("market_reference", { precision: 12, scale: 2 }),
    recommendedBuy: numeric("recommended_buy", { precision: 12, scale: 2 }),
    marketReferenceDisplay: numeric("market_reference_display", { precision: 12, scale: 2 }),
    recommendedBuyDisplay: numeric("recommended_buy_display", { precision: 12, scale: 2 }),
    margin: numeric("margin", { precision: 5, scale: 4 }),
    comps: integer("comps").notNull(),

    /** Full evidence and margin breakdown, for the "why this price?" panel. */
    evidence: jsonb("evidence"),
    marginComponents: jsonb("margin_components"),

    /** Which engine produced this, so a formula change is traceable. */
    engineVersion: text("engine_version").notNull(),
    pricingCalculatedAt: timestamp("pricing_calculated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Freshness of the INPUTS, which is what a user actually cares about. */
    salesCollectedAt: timestamp("sales_collected_at", { withTimezone: true }),
  },
  (table) => [
    // Serves "latest Recommended Buy for a card/group" as an index-only scan.
    index("recommended_buy_latest_idx").on(
      table.cardId,
      table.comparableGroup,
      table.pricingCalculatedAt,
    ),
  ],
);

export type CardRow = typeof cards.$inferSelect;
export type SoldListingRow = typeof soldListings.$inferSelect;
export type CollectionRunRow = typeof collectionRuns.$inferSelect;
export type ClassificationRow = typeof listingClassifications.$inferSelect;
export type PriceHistoryRow = typeof priceHistory.$inferSelect;
export type RecommendedBuySnapshotRow = typeof recommendedBuySnapshots.$inferSelect;
