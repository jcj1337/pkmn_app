/**
 * Bridges the TypeScript pipeline into the Python workspace.
 *
 * Runs the EXISTING deterministic classifier over already-saved eBay fixtures
 * and pairs each card with its locally cached TCGplayer history. Nothing here
 * modifies the classifier, and no Apify request is made — the fixtures are the
 * ones already on disk.
 *
 *   node analysis/export_sales.cjs
 *
 * Requires a compiled lib:
 *   npx tsc lib/*.ts --outDir .eval-build --module commonjs --target es2022 \
 *     --moduleResolution node --skipLibCheck --esModuleInterop
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, ".eval-build");
const { classifyListings, comparableGroup } = require(path.join(BUILD, "listing-classifier.js"));
const { getSetNames } = require(path.join(BUILD, "tcgdex.js"));
const { lookupCard } = require(path.join(BUILD, "tcgcsv.js"));

const SALES_DIR = path.join(__dirname, "data", "ebay-sold");
const HISTORY_DIR = path.join(ROOT, "data", "price-history");
const OUT_DIR = path.join(__dirname, "data");

function loadCards() {
  const cards = [];
  for (const file of ["cards-dev.json", "cards-holdout.json"]) {
    const full = path.join(OUT_DIR, file);
    if (!fs.existsSync(full)) continue;
    for (const card of JSON.parse(fs.readFileSync(full, "utf8"))) {
      if (!cards.some((c) => c.id === card.id)) cards.push(card);
    }
  }
  return cards;
}

const historyCache = new Map();
function loadHistory(groupId) {
  if (!historyCache.has(groupId)) {
    const file = path.join(HISTORY_DIR, `${groupId}.json`);
    historyCache.set(
      groupId,
      fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null,
    );
  }
  return historyCache.get(groupId);
}

(async () => {
  const knownSetNames = await getSetNames().catch(() => undefined);
  const cards = loadCards();

  const sales = [];
  const tcgplayer = [];

  for (const card of cards) {
    const file = path.join(SALES_DIR, `${card.id}.json`);
    if (!fs.existsSync(file)) continue;

    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const listings = raw.map((row, index) => ({
      itemId: String(row.itemId ?? index),
      title: row.title ?? "",
      soldPrice: row.soldPrice == null ? null : Number(row.soldPrice),
      currency: row.soldCurrency ?? "USD",
      soldDate: row.endedAt ?? null,
      condition: row.condition ?? null,
      imageUrl: row.thumbnailUrl ?? null,
      url: row.url ?? null,
    }));

    for (const c of classifyListings(listings, card, { knownSetNames })) {
      sales.push({
        cardId: card.id,
        cardName: card.name,
        setName: card.setName,
        cardNumber: card.number,
        printedTotal: card.printedTotal,
        itemId: c.itemId,
        title: c.title,
        soldPrice: c.soldPrice,
        currency: c.currency,
        soldDate: c.soldDate,
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
        // Composite identity: category + edition + printing. Computed here so
        // Python and the app can never disagree about what a comp group is.
        comparableGroup: comparableGroup(c),
        confidence: c.confidence,
      });
    }

    // Link the card to its TCGplayer product so the cached history can be
    // attached. Uses the same matcher as the pricing fallback.
    const lookup = await lookupCard({
      name: card.name,
      setName: card.setName,
      localId: card.number,
      printedTotal: card.printedTotal,
      rarity: card.rarity ?? null,
      variants: { firstEdition: false, holo: true, normal: false, reverse: false },
    }).catch(() => null);

    const entry = {
      cardId: card.id,
      cardName: card.name,
      setName: card.setName,
      cardNumber: card.number,
      currentMarketPrice:
        card.pricing && card.pricing.kind === "market" ? card.pricing.market : null,
      currentPriceSource: card.priceSource ?? null,
      groupId: null,
      productId: null,
      subType: null,
      history: [],
    };

    if (lookup && lookup.status === "matched") {
      entry.groupId = lookup.match.groupId;
      entry.productId = lookup.match.productId;
      entry.subType = lookup.match.subType;

      const file = loadHistory(entry.groupId);
      const series = file?.series?.[String(entry.productId)]?.[entry.subType];
      if (file && series) {
        entry.history = file.dates.map((date, index) => ({
          date,
          marketPrice: series[index] ?? null,
        }));
      }
    }

    tcgplayer.push(entry);
  }

  fs.writeFileSync(path.join(OUT_DIR, "classified-sales.json"), JSON.stringify(sales, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "tcgplayer.json"), JSON.stringify(tcgplayer, null, 2));

  const withHistory = tcgplayer.filter((t) => t.history.length > 0).length;
  console.log(`cards            : ${cards.length}`);
  console.log(`sales rows       : ${sales.length}`);
  console.log(`cards w/ history : ${withHistory}`);
  console.log(`wrote analysis/data/classified-sales.json and tcgplayer.json`);
})();
