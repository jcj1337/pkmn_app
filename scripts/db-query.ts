/**
 * Ad-hoc read-only inspection of the local database.
 *
 *   npx tsx scripts/db-query.ts               # summary counts
 *   npx tsx scripts/db-query.ts "SELECT ..."  # arbitrary read query
 *
 * Wrapped in main() rather than using top-level await: package.json has no
 * "type": "module", so tsx compiles these scripts as CJS.
 */

import { closeDb, getDb } from "../lib/db/client";

async function main() {
  const db = await getDb();
  const custom = process.argv[2];

  if (custom) {
    const result = await db.execute(custom);
    console.table(result.rows);
  } else {
    const counts = await db.execute(`
      SELECT 'cards' AS table_name, count(*)::int AS rows FROM cards
      UNION ALL SELECT 'collection_runs', count(*)::int FROM collection_runs
      UNION ALL SELECT 'sold_listings', count(*)::int FROM sold_listings
      UNION ALL SELECT 'listing_classifications', count(*)::int FROM listing_classifications
      UNION ALL SELECT 'price_history', count(*)::int FROM price_history
      UNION ALL SELECT 'recommended_buy_snapshots', count(*)::int FROM recommended_buy_snapshots
    `);
    console.table(counts.rows);
  }

  await closeDb();
}

main().catch(async (error) => {
  console.error(error);
  await closeDb();
  process.exitCode = 1;
});
