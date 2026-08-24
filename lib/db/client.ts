/**
 * Database connection.
 *
 * Two drivers, one schema:
 *
 *   PGlite  — real PostgreSQL compiled to WASM, running in-process. Used for
 *             local development and tests. No server, no container, no cost.
 *   node-postgres — used when DATABASE_URL points at a real server
 *             (Neon, Supabase, RDS). Not installed yet; the branch exists so
 *             deployment is a dependency install rather than a rewrite.
 *
 * Because PGlite is genuine PostgreSQL rather than an emulation, the SQL and
 * the schema validated locally are the same ones that will run in production.
 */

import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema";

export type Database = ReturnType<typeof drizzlePglite<typeof schema>>;

/** Where the local database lives. A directory; delete it to start clean. */
export const LOCAL_DB_DIR = process.env.TCGRACKER_DB_DIR ?? ".pgdata";

let instance: Database | null = null;
let client: PGlite | null = null;

/**
 * Opens (or reuses) the database.
 *
 * `dataDir: undefined` gives an ephemeral in-memory instance, which is what the
 * tests use so they never inherit state from a previous run.
 */
export async function getDb(options: { dataDir?: string | null } = {}): Promise<Database> {
  if (instance) return instance;

  const dataDir = options.dataDir === null ? undefined : (options.dataDir ?? LOCAL_DB_DIR);
  client = new PGlite(dataDir);
  await client.waitReady;
  instance = drizzlePglite(client, { schema });
  return instance;
}

/** Closes the connection. Tests call this so the process can exit. */
export async function closeDb(): Promise<void> {
  await client?.close();
  client = null;
  instance = null;
}

/**
 * Creates the schema.
 *
 * Written as plain DDL rather than generated migrations: the schema is small,
 * this keeps it readable next to schema.ts, and it avoids adding a migration
 * runner before there is anything to migrate. A real deployment would switch to
 * drizzle-kit migrations — that is a deployment task, not a modelling one.
 */
export async function createSchema(db: Database): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS cards (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       set_name TEXT NOT NULL,
       card_number TEXT NOT NULL,
       printed_total INTEGER,
       rarity TEXT,
       image_url TEXT,
       ebay_query TEXT,
       tcgplayer_group_id INTEGER,
       tcgplayer_product_id INTEGER,
       tcgplayer_sub_type TEXT,
       tcgplayer_market_price NUMERIC(12,2),
       tcgplayer_price_updated_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,

    `CREATE TABLE IF NOT EXISTS collection_runs (
       id SERIAL PRIMARY KEY,
       card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
       provider TEXT NOT NULL,
       query TEXT NOT NULL,
       collected_at TIMESTAMPTZ NOT NULL,
       requested_days INTEGER NOT NULL,
       requested_count INTEGER NOT NULL,
       requested_from DATE NOT NULL,
       requested_to DATE NOT NULL,
       returned INTEGER NOT NULL,
       new_sales INTEGER NOT NULL,
       earliest_sale DATE,
       latest_sale DATE,
       completeness TEXT NOT NULL,
       observed_from DATE NOT NULL,
       observed_to DATE NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS collection_runs_card_idx
       ON collection_runs (card_id, collected_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS collection_runs_natural_key
       ON collection_runs (card_id, provider, collected_at)`,

    `CREATE TABLE IF NOT EXISTS sold_listings (
       item_id TEXT PRIMARY KEY,
       card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
       title TEXT NOT NULL,
       sold_price NUMERIC(12,2),
       currency TEXT NOT NULL DEFAULT 'USD',
       sold_date DATE,
       condition TEXT,
       image_url TEXT,
       url TEXT,
       first_seen_at TIMESTAMPTZ NOT NULL,
       first_seen_run_id INTEGER REFERENCES collection_runs(id) ON DELETE SET NULL
     )`,
    `CREATE INDEX IF NOT EXISTS sold_listings_card_idx ON sold_listings (card_id)`,
    `CREATE INDEX IF NOT EXISTS sold_listings_card_date_idx
       ON sold_listings (card_id, sold_date)`,

    `CREATE TABLE IF NOT EXISTS listing_classifications (
       id SERIAL PRIMARY KEY,
       item_id TEXT NOT NULL REFERENCES sold_listings(item_id) ON DELETE CASCADE,
       card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
       classifier_version TEXT NOT NULL,
       relevant BOOLEAN NOT NULL,
       relevance_reason TEXT NOT NULL,
       category TEXT NOT NULL,
       is_graded BOOLEAN NOT NULL,
       grading_company TEXT,
       grade NUMERIC(3,1),
       raw_condition TEXT,
       language TEXT NOT NULL,
       set_match TEXT NOT NULL,
       number_evidence TEXT NOT NULL,
       edition TEXT NOT NULL,
       print_variant TEXT NOT NULL,
       comparable_group TEXT NOT NULL,
       confidence NUMERIC(4,2) NOT NULL,
       classified_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS listing_classifications_item_card_version
       ON listing_classifications (item_id, card_id, classifier_version)`,
    `CREATE INDEX IF NOT EXISTS listing_classifications_group_idx
       ON listing_classifications (card_id, comparable_group, classifier_version)`,

    `CREATE TABLE IF NOT EXISTS price_history (
       id SERIAL PRIMARY KEY,
       card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
       tcgplayer_product_id INTEGER,
       sub_type TEXT NOT NULL,
       date DATE NOT NULL,
       market_price NUMERIC(12,2)
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS price_history_natural_key
       ON price_history (card_id, sub_type, date)`,
    `CREATE INDEX IF NOT EXISTS price_history_card_date_idx
       ON price_history (card_id, date)`,

    `CREATE TABLE IF NOT EXISTS recommended_buy_snapshots (
       id SERIAL PRIMARY KEY,
       card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
       comparable_group TEXT NOT NULL,
       status TEXT NOT NULL,
       refusal_reason TEXT,
       market_reference NUMERIC(12,2),
       recommended_buy NUMERIC(12,2),
       market_reference_display NUMERIC(12,2),
       recommended_buy_display NUMERIC(12,2),
       margin NUMERIC(5,4),
       comps INTEGER NOT NULL,
       evidence JSONB,
       margin_components JSONB,
       engine_version TEXT NOT NULL,
       pricing_calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       sales_collected_at TIMESTAMPTZ
     )`,
    `CREATE INDEX IF NOT EXISTS recommended_buy_latest_idx
       ON recommended_buy_snapshots (card_id, comparable_group, pricing_calculated_at DESC)`,
  ];

  for (const statement of statements) {
    await db.execute(statement);
  }
}
