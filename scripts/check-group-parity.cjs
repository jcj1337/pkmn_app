/**
 * Verifies that a production comparable group holds exactly the sales the
 * Python pricing analysis uses for that same group key.
 *
 * Production side : classifyListings + groupClassified (the card page path)
 * Analysis side   : analysis/out/comparable_sales.csv (the pandas input)
 *
 * Compares itemId sets, not counts, so a coincidental size match cannot pass.
 *
 *   node scripts/check-group-parity.cjs
 *   node scripts/check-group-parity.cjs neo1-9 base1-10
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, ".eval-build");
const { classifyListings, groupClassified } = require(path.join(BUILD, "listing-classifier.js"));
const { getSetNames } = require(path.join(BUILD, "tcgdex.js"));

const SALES_DIR = path.join(ROOT, "analysis", "data", "ebay-sold");
const CSV = path.join(ROOT, "analysis", "out", "comparable_sales.csv");

/** Minimal CSV reader: our export quotes fields containing commas or quotes. */
function readCsv(file) {
  const text = fs.readFileSync(file, "utf8");
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (char !== "\r") field += char;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  const header = rows.shift();
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

function loadCards() {
  const cards = [];
  for (const file of ["cards-dev.json", "cards-holdout.json"]) {
    const full = path.join(ROOT, "analysis", "data", file);
    if (!fs.existsSync(full)) continue;
    for (const card of JSON.parse(fs.readFileSync(full, "utf8"))) {
      if (!cards.some((c) => c.id === card.id)) cards.push(card);
    }
  }
  return cards;
}

(async () => {
  const wanted = process.argv.slice(2);
  const knownSetNames = await getSetNames().catch(() => undefined);
  const analysisRows = readCsv(CSV);
  const cards = loadCards().filter((c) => wanted.length === 0 || wanted.includes(c.id));

  let checked = 0;
  let mismatched = 0;
  let foreignOnly = 0;

  for (const card of cards) {
    const file = path.join(SALES_DIR, `${card.id}.json`);
    if (!fs.existsSync(file)) continue;

    const listings = JSON.parse(fs.readFileSync(file, "utf8")).map((row, index) => ({
      itemId: String(row.itemId ?? index),
      title: row.title ?? "",
      soldPrice: row.soldPrice == null ? null : Number(row.soldPrice),
      currency: row.soldCurrency ?? "USD",
      soldDate: row.endedAt ?? null,
      condition: null,
      imageUrl: null,
      url: null,
    }));

    const production = groupClassified(classifyListings(listings, card, { knownSetNames }));

    const analysis = new Map();
    for (const row of analysisRows.filter((r) => r.cardId === card.id)) {
      if (!analysis.has(row.comparableGroup)) analysis.set(row.comparableGroup, new Set());
      analysis.get(row.comparableGroup).add(row.itemId);
    }

    const lines = [];
    for (const group of production) {
      const theirs = analysis.get(group.key);
      const mine = new Set(group.listings.map((l) => l.itemId));

      if (!theirs) {
        // Expected only for foreign-language markets, which the analysis
        // deliberately does not price yet.
        const tag = group.languageGrouping === "EN" ? "MISSING" : "foreign-only";
        if (group.languageGrouping === "EN") mismatched++;
        else foreignOnly++;
        lines.push(`    ${tag.padEnd(13)} ${group.key}  (production ${mine.size})`);
        continue;
      }

      checked++;
      const onlyMine = [...mine].filter((id) => !theirs.has(id));
      const onlyTheirs = [...theirs].filter((id) => !mine.has(id));
      if (onlyMine.length || onlyTheirs.length) {
        mismatched++;
        lines.push(
          `    MISMATCH      ${group.key}  prod ${mine.size} / py ${theirs.size}` +
            `  +${onlyMine.length} -${onlyTheirs.length}`,
        );
      }
      analysis.delete(group.key);
    }

    for (const [key, theirs] of analysis) {
      mismatched++;
      lines.push(`    PY-ONLY       ${key}  (analysis ${theirs.size})`);
    }

    if (lines.length > 0) {
      console.log(`${card.name} ${card.number}  [${card.id}]`);
      lines.forEach((l) => console.log(l));
    }
  }

  console.log(`\ngroups compared with identical membership : ${checked - mismatched}/${checked}`);
  console.log(`foreign-language groups (production only) : ${foreignOnly}`);
  console.log(mismatched === 0 ? "PARITY OK" : `PARITY FAILED (${mismatched})`);
  process.exitCode = mismatched === 0 ? 0 : 1;
})();
