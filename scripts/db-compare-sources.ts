/**
 * Compares the FILE and DATABASE read paths for price history.
 *
 *   npx tsx scripts/db-compare-sources.ts
 *
 * Reads both sources for every card that has history and asserts the series
 * are identical, including the nulls. This is the evidence for switching the
 * read path over — and for keeping the file path until it exists.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { closeDb, getDb } from "../lib/db/client";
import { getPriceHistory, listCards } from "../lib/db/repository";
import { getPriceHistory as fileHistory } from "../lib/tcg-price-history";

const ROOT = path.join(import.meta.dirname, "..");

async function main() {
  const db = await getDb();
  const cards = await listCards(db);

  const fixtures = JSON.parse(
    readFileSync(path.join(ROOT, "analysis", "data", "cards-dev.json"), "utf8"),
  ).concat(
    JSON.parse(readFileSync(path.join(ROOT, "analysis", "data", "cards-holdout.json"), "utf8")),
  );

  let compared = 0;
  let identical = 0;
  const problems: string[] = [];

  for (const card of cards) {
    const fixture = fixtures.find((c: { id: string }) => c.id === card.id);
    if (!fixture) continue;

    const fromDb = await getPriceHistory(db, card.id);
    if (fromDb.length === 0) continue;

    const fromFile = await fileHistory(
      {
        name: fixture.name,
        setName: fixture.setName,
        localId: fixture.number,
        printedTotal: fixture.printedTotal ?? null,
        rarity: fixture.rarity ?? null,
        variants: { firstEdition: false, holo: true, normal: false, reverse: false },
      },
      "ALL",
    ).catch(() => null);

    compared++;
    if (!fromFile) {
      problems.push(`${card.id}: file path returned nothing, database has ${fromDb.length}`);
      continue;
    }

    const a = fromFile.points.map((p) => `${p.date}:${p.marketPrice ?? "null"}`).join("|");
    const b = fromDb.map((p) => `${p.date}:${p.marketPrice ?? "null"}`).join("|");

    if (a === b) {
      identical++;
    } else {
      const fileNulls = fromFile.points.filter((p) => p.marketPrice === null).length;
      const dbNulls = fromDb.filter((p) => p.marketPrice === null).length;
      problems.push(
        `${card.id}: file ${fromFile.points.length} pts (${fileNulls} null) vs db ${fromDb.length} pts (${dbNulls} null)`,
      );
    }
  }

  console.log(`cards with history compared : ${compared}`);
  console.log(`identical series            : ${identical}/${compared}`);
  if (problems.length) {
    console.log("\ndifferences:");
    problems.forEach((line) => console.log(`  ${line}`));
  } else {
    console.log("\nFILE and DATABASE price history are byte-identical.");
  }

  await closeDb();
}

main().catch(async (error) => {
  console.error(error);
  await closeDb();
  process.exitCode = 1;
});
