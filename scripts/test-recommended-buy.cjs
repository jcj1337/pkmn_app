/**
 * Tests the production Recommended Buy engine end to end from saved fixtures:
 * raw eBay JSON -> real classifier -> real grouping -> pricing engine.
 *
 * Makes no Apify calls. This is the harness that exercises what the card page
 * renders, while the quota is exhausted.
 *
 *   node scripts/test-recommended-buy.cjs
 *
 * Requires a compiled lib:
 *   npx tsc lib/*.ts --outDir .eval-build --module commonjs --target es2022 \
 *     --moduleResolution node --skipLibCheck --esModuleInterop
 */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, ".eval-build");

const { classifyListings, groupClassified } = require(path.join(BUILD, "listing-classifier.js"));
const { getSetNames } = require(path.join(BUILD, "tcgdex.js"));
const {
  evaluateRecommendedBuy,
  salesUnavailable,
  rateDeal,
  roundMoney,
} = require(path.join(BUILD, "recommended-buy.js"));

const FIXTURES = path.join(ROOT, "analysis", "data", "ebay-sold");
const HISTORY_CSV = path.join(ROOT, "analysis", "out", "tcgplayer_history.csv");

/** The dataset's own latest sale date, so results match the Python run. */
const AS_OF = new Date("2026-08-17T00:00:00Z");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error.message}`);
    process.exitCode = 1;
  }
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

function loadHistory() {
  const byCard = new Map();
  if (!fs.existsSync(HISTORY_CSV)) return byCard;

  // Python writes CRLF on Windows. Splitting on "\n" alone leaves a carriage
  // return on the last header cell, indexOf misses it, and every cached price
  // silently becomes NaN - which reads as "this card has no history".
  const lines = fs.readFileSync(HISTORY_CSV, "utf8").trim().split(/\r?\n/);
  const header = lines.shift().split(",");
  const [ci, di, mi] = ["cardId", "date", "marketPrice"].map((k) => header.indexOf(k));

  for (const line of lines) {
    const cols = line.split(",");
    if (!byCard.has(cols[ci])) byCard.set(cols[ci], []);
    byCard.get(cols[ci]).push({
      date: cols[di].slice(0, 10),
      marketPrice: cols[mi] === "" ? null : Number(cols[mi]),
    });
  }
  for (const points of byCard.values()) points.sort((a, b) => a.date.localeCompare(b.date));
  return byCard;
}

(async () => {
  const knownSetNames = await getSetNames().catch(() => undefined);
  const cards = loadCards();
  const historyByCard = loadHistory();

  /** Reproduces exactly what EbaySoldSection computes for one card. */
  function priceCard(cardId) {
    const card = cards.find((c) => c.id === cardId);
    assert.ok(card, `missing card ${cardId}`);

    const rows = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${cardId}.json`), "utf8"));
    const listings = rows.map((row, index) => ({
      itemId: String(row.itemId ?? index),
      title: row.title ?? "",
      soldPrice: row.soldPrice == null ? null : Number(row.soldPrice),
      currency: row.soldCurrency ?? "USD",
      soldDate: row.endedAt ?? null,
      condition: null,
      imageUrl: null,
      url: null,
    }));

    const groups = groupClassified(classifyListings(listings, card, { knownSetNames }));
    const tcgMarketPrice =
      card.pricing && card.pricing.kind === "market" ? card.pricing.market : null;

    const byGroup = new Map();
    for (const group of groups) {
      byGroup.set(
        group.key,
        evaluateRecommendedBuy({
          groupKey: group.key,
          sales: group.listings
            .filter((l) => l.soldPrice !== null)
            .map((l) => ({
              itemId: l.itemId,
              title: l.title,
              soldPrice: l.soldPrice,
              soldDate: l.soldDate,
              isGraded: l.isGraded,
            })),
          tcgMarketPrice,
          history: historyByCard.get(cardId) ?? null,
          asOf: AS_OF,
        }),
      );
    }
    return { card, groups, byGroup };
  }

  const RAW_STANDARD = "RAW_UNKNOWN|UNKNOWN|STANDARD|EN";

  console.log("named test cards");

  const umbreon = priceCard("swsh7-215");
  const umbreonRaw = umbreon.byGroup.get(RAW_STANDARD);
  test("Umbreon VMAX 215/203 raw prices from the saved data", () => {
    assert.equal(umbreonRaw.status, "AVAILABLE");
    assert.equal(umbreonRaw.evidence.comps, 5);
    // Derived, never asserted against a hardcoded target: check the value is
    // the reference minus the computed margin, and that it is below market.
    assert.ok(
      Math.abs(umbreonRaw.recommendedBuy - umbreonRaw.marketReference * (1 - umbreonRaw.margin)) < 1e-9,
    );
    assert.ok(umbreonRaw.recommendedBuy < umbreonRaw.marketReference);
    assert.equal(umbreonRaw.recommendedBuyDisplay, roundMoney(umbreonRaw.recommendedBuy));
  });
  test("Umbreon raw blends both sources at 5 comps", () => {
    assert.equal(umbreonRaw.evidence.isRaw, true);
    assert.ok(Math.abs(umbreonRaw.evidence.ebayWeight - 5 / (5 + 5)) < 1e-9);
    assert.ok(umbreonRaw.evidence.tcgMarketPrice > 0);
  });

  const umbreonPsa10 = umbreon.byGroup.get("PSA_10|UNKNOWN|STANDARD|EN");
  test("Umbreon PSA 10 never blends the ungraded TCGplayer price", () => {
    assert.equal(umbreonPsa10.status, "AVAILABLE");
    assert.equal(umbreonPsa10.evidence.isRaw, false);
    assert.equal(umbreonPsa10.evidence.ebayWeight, 1, "graded must be eBay-only");
    assert.equal(umbreonPsa10.evidence.disagreement, null);
    assert.equal(umbreonPsa10.marketReference, umbreonPsa10.evidence.ebayMedian);
  });
  test("Umbreon PSA 10 prices far above its raw group", () => {
    assert.ok(umbreonPsa10.recommendedBuy > umbreonRaw.recommendedBuy * 1.5);
  });

  for (const [cardId, label] of [
    ["me05-116", "Mega Darkrai ex"],
    ["sv03.5-199", "Charizard ex 199/165"],
    ["swsh7-211", "Sylveon VMAX 211/203"],
  ]) {
    const priced = priceCard(cardId).byGroup.get(RAW_STANDARD);
    test(`${label} raw produces a recommendation`, () => {
      assert.equal(priced.status, "AVAILABLE");
      assert.ok(priced.recommendedBuy > 0);
      assert.ok(priced.recommendedBuy < priced.marketReference);
      assert.ok(priced.margin >= 0.05 && priced.margin <= 0.25);
    });
  }

  const giratina = priceCard("swsh11-212").byGroup.get("RAW_NM|UNKNOWN|STANDARD|EN");
  test("Giratina VSTAR 212/196 NM produces a recommendation", () => {
    assert.equal(giratina.status, "AVAILABLE");
    assert.ok(giratina.marginComponents.some((c) => c.key === "base"));
  });

  console.log("\nrefusal cases");

  test("TOO_FEW_COMPS: a single-sale group is refused", () => {
    const result = evaluateRecommendedBuy({
      groupKey: RAW_STANDARD,
      sales: [{ itemId: "a", title: "t", soldPrice: 100, soldDate: "2026-08-17", isGraded: false }],
      tcgMarketPrice: 100,
      history: null,
      asOf: AS_OF,
    });
    assert.equal(result.status, "UNAVAILABLE");
    assert.equal(result.reason, "TOO_FEW_COMPS");
    assert.equal(result.message, "Not enough comparable sales yet.");
  });

  const lugia = priceCard("neo1-9").byGroup.get("RAW_UNKNOWN|FIRST_EDITION|STANDARD|EN");
  test("MIXED_POPULATION: Lugia 1st Edition comps span too far", () => {
    assert.equal(lugia.status, "UNAVAILABLE");
    assert.equal(lugia.reason, "MIXED_POPULATION");
    assert.equal(lugia.message, "Recent sales appear to describe more than one market.");
  });

  const baseCharizard = priceCard("base1-4").byGroup.get(RAW_STANDARD);
  test("SOURCE_CONFLICT: Base Set Charizard sources disagree over 50%", () => {
    assert.equal(baseCharizard.status, "UNAVAILABLE");
    assert.equal(baseCharizard.reason, "SOURCE_CONFLICT");
    assert.equal(baseCharizard.message, "TCGplayer and eBay data disagree too strongly.");
  });

  const evolutions = priceCard("xy12-11").byGroup.get(RAW_STANDARD);
  test("COMPS_DISAGREE: Charizard 11/108 holo IQR exceeds its median", () => {
    assert.equal(evolutions.status, "UNAVAILABLE");
    assert.equal(evolutions.reason, "COMPS_DISAGREE");
  });

  test("SALES_UNAVAILABLE is distinct from having too few comps", () => {
    const result = salesUnavailable("x");
    assert.equal(result.reason, "SALES_UNAVAILABLE");
    assert.equal(result.message, "Comparable sales could not be loaded.");
  });

  test("no refusal message leaks an internal enum name", () => {
    for (const reason of ["TOO_FEW_COMPS", "MIXED_POPULATION", "COMPS_DISAGREE",
                          "SOURCE_CONFLICT", "SALES_UNAVAILABLE"]) {
      const result = evaluateRecommendedBuy({
        groupKey: "g", sales: [], tcgMarketPrice: null, history: null, asOf: AS_OF,
      });
      assert.ok(!result.message.includes("_"), `"${result.message}" looks like an enum`);
      assert.ok(!result.message.includes(reason.split("_")[0].toUpperCase()));
    }
  });

  console.log("\ngroup independence");

  test("each comparable group is priced from its own sales only", () => {
    const charizardVmax = priceCard("swsh3.5-74");
    const psa10 = charizardVmax.byGroup.get("PSA_10|UNKNOWN|STANDARD|EN");
    const psa9 = charizardVmax.byGroup.get("PSA_9|UNKNOWN|STANDARD|EN");
    assert.equal(psa10.status, "AVAILABLE");
    assert.equal(psa9.status, "AVAILABLE");
    assert.notEqual(psa10.recommendedBuy, psa9.recommendedBuy);
    assert.ok(psa10.recommendedBuy > psa9.recommendedBuy, "PSA 10 must exceed PSA 9");
  });

  test("every group key in the map matches a rendered group", () => {
    const { groups, byGroup } = priceCard("neo1-9");
    assert.equal(byGroup.size, groups.length);
    for (const group of groups) {
      assert.ok(byGroup.has(group.key));
      assert.equal(byGroup.get(group.key).groupKey, group.key);
    }
  });

  console.log("\ndisplay rounding");
  test("rounding tracks magnitude", () => {
    assert.equal(roundMoney(2113.79), 2110);
    assert.equal(roundMoney(1653.27), 1650);
    assert.equal(roundMoney(357.42), 355);
    assert.equal(roundMoney(47.31), 47);
    assert.equal(roundMoney(11.27), 11.3);
  });
  test("no displayed value carries fake precision", () => {
    for (const cardId of ["swsh7-215", "me05-116", "swsh11-212"]) {
      for (const result of priceCard(cardId).byGroup.values()) {
        if (result.status !== "AVAILABLE") continue;
        assert.equal(result.recommendedBuyDisplay, roundMoney(result.recommendedBuy));
        assert.equal(result.marketReferenceDisplay, roundMoney(result.marketReference));
      }
    }
  });

  console.log("\ndeal rating");
  test("thresholds follow the exploratory rule", () => {
    const buy = 100;
    const reference = 130;
    assert.equal(rateDeal(94, buy, reference), "GREAT BUY");
    assert.equal(rateDeal(95, buy, reference), "GREAT BUY", "boundary is inclusive");
    assert.equal(rateDeal(96, buy, reference), "GOOD BUY");
    assert.equal(rateDeal(100, buy, reference), "GOOD BUY", "at the recommendation");
    assert.equal(rateDeal(101, buy, reference), "FAIR");
    assert.equal(rateDeal(130, buy, reference), "FAIR", "at the reference");
    assert.equal(rateDeal(131, buy, reference), "ABOVE MARKET");
  });
  test("rates a real recommendation", () => {
    const buy = umbreonRaw.recommendedBuy;
    const reference = umbreonRaw.marketReference;
    assert.equal(rateDeal(buy * 0.9, buy, reference), "GREAT BUY");
    assert.equal(rateDeal(reference * 1.2, buy, reference), "ABOVE MARKET");
  });

  console.log(`\n${passed} assertions passed${process.exitCode ? " (with failures)" : ""}`);
})();
