/**
 * Renders the comparable groups the card page would show, from saved eBay
 * fixtures. Exercises the real classifier and the real grouping function, so
 * the UI can be validated without an Apify request.
 *
 *   node scripts/preview-listing-groups.cjs                 # every fixture
 *   node scripts/preview-listing-groups.cjs neo1-9 xy12-11  # selected cards
 *
 * Requires a compiled lib:
 *   npx tsc lib/*.ts --outDir .eval-build --module commonjs --target es2022 \
 *     --moduleResolution node --skipLibCheck --esModuleInterop
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, ".eval-build");
const { classifyListings, groupClassified } = require(path.join(BUILD, "listing-classifier.js"));
const { getSetNames } = require(path.join(BUILD, "tcgdex.js"));

const SALES_DIR = path.join(ROOT, "analysis", "data", "ebay-sold");
const CARD_FILES = ["cards-dev.json", "cards-holdout.json"];

function loadCards() {
  const cards = [];
  for (const file of CARD_FILES) {
    const full = path.join(ROOT, "analysis", "data", file);
    if (!fs.existsSync(full)) continue;
    for (const card of JSON.parse(fs.readFileSync(full, "utf8"))) {
      if (!cards.some((c) => c.id === card.id)) cards.push(card);
    }
  }
  return cards;
}

const money = (value) =>
  value === null || value === undefined ? "—" : `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

(async () => {
  const wanted = process.argv.slice(2);
  const knownSetNames = await getSetNames().catch(() => undefined);
  const cards = loadCards().filter((c) => wanted.length === 0 || wanted.includes(c.id));

  for (const card of cards) {
    const file = path.join(SALES_DIR, `${card.id}.json`);
    if (!fs.existsSync(file)) continue;

    const listings = JSON.parse(fs.readFileSync(file, "utf8")).map((row, index) => ({
      itemId: String(row.itemId ?? index),
      title: row.title ?? "",
      soldPrice: row.soldPrice == null ? null : Number(row.soldPrice),
      currency: row.soldCurrency ?? "USD",
      soldDate: row.endedAt ?? null,
      condition: row.condition ?? null,
      imageUrl: row.thumbnailUrl ?? null,
      url: row.url ?? null,
    }));

    const classified = classifyListings(listings, card, { knownSetNames });
    const groups = groupClassified(classified);
    const excluded = classified.filter((l) => !l.relevant);

    console.log("=".repeat(78));
    console.log(`${card.name} ${card.number}  ·  ${card.setName}   [${card.id}]`);
    console.log(
      `${classified.length} listings · ${classified.length - excluded.length} accepted · ${groups.length} comparable groups`,
    );

    for (const group of groups) {
      console.log(`\n  ┌ ${group.label}`);
      console.log(`  │ ${group.count} comparable ${group.count === 1 ? "sale" : "sales"}   [key ${group.key}]`);
      for (const listing of group.listings) {
        console.log(`  │   ${money(listing.soldPrice).padStart(11)}  ${listing.title.slice(0, 56)}`);
      }
    }

    if (excluded.length > 0) {
      console.log(`\n  Excluded (${excluded.length}):`);
      const byReason = new Map();
      for (const listing of excluded) {
        byReason.set(listing.relevanceReason, (byReason.get(listing.relevanceReason) ?? 0) + 1);
      }
      for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${String(count).padStart(3)}  ${reason}`);
      }
    }
    console.log();
  }
})();
