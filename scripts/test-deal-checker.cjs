/**
 * Tests the Deal Checker's pure logic against real fixture-derived prices.
 *
 * Boundaries are computed from whatever the engine produces for each card —
 * nothing is hardcoded, so retuning the formula later moves the tests with it
 * instead of breaking them for the wrong reason.
 *
 *   node scripts/test-deal-checker.cjs
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
  noSalesFound,
  rateDeal,
  rateDealAgainst,
} = require(path.join(BUILD, "recommended-buy.js"));
const {
  parseAskingPrice,
  assessAskingPrice,
  dealCheckUnavailableReason,
} = require(path.join(BUILD, "deal-check.js"));

const FIXTURES = path.join(ROOT, "analysis", "data", "ebay-sold");
const HISTORY_CSV = path.join(ROOT, "analysis", "out", "tcgplayer_history.csv");
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

  function priceGroups(cardId) {
    const card = cards.find((c) => c.id === cardId);
    const rows = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${cardId}.json`), "utf8"));
    const listings = rows.map((row, index) => ({
      itemId: String(row.itemId ?? index),
      title: row.title ?? "",
      soldPrice: row.soldPrice == null ? null : Number(row.soldPrice),
      currency: row.soldCurrency ?? "USD",
      soldDate: row.endedAt ?? null,
      condition: null, imageUrl: null, url: null,
    }));

    const groups = groupClassified(classifyListings(listings, card, { knownSetNames }));
    const tcgMarketPrice =
      card.pricing && card.pricing.kind === "market" ? card.pricing.market : null;

    const byGroup = new Map();
    for (const group of groups) {
      byGroup.set(group.key, evaluateRecommendedBuy({
        groupKey: group.key,
        sales: group.listings.filter((l) => l.soldPrice !== null).map((l) => ({
          itemId: l.itemId, title: l.title, soldPrice: l.soldPrice,
          soldDate: l.soldDate, isGraded: l.isGraded,
        })),
        tcgMarketPrice,
        history: historyByCard.get(cardId) ?? null,
        asOf: AS_OF,
      }));
    }
    return byGroup;
  }

  const RAW = "RAW_UNKNOWN|UNKNOWN|STANDARD|EN";

  /* ------------------------------------------------------------ parsing */
  console.log("input parsing");

  test("accepts the documented formats", () => {
    assert.equal(parseAskingPrice("1500"), 1500);
    assert.equal(parseAskingPrice("1575.50"), 1575.5);
    assert.equal(parseAskingPrice("$1575"), 1575);
    assert.equal(parseAskingPrice("$1,575.50"), 1575.5);
    assert.equal(parseAskingPrice("  1575  "), 1575);
    assert.equal(parseAskingPrice(".5"), 0.5);
  });

  test("rejects everything that must never reach pricing logic", () => {
    for (const bad of ["", "   ", "0", "0.00", "-5", "-$5", "abc", "1e9", "Infinity",
                       "NaN", "1.2.3", "1,,5", "$", "12px", "1 500"]) {
      assert.equal(parseAskingPrice(bad), null, `"${bad}" should be rejected`);
    }
  });

  test("no accepted value is ever NaN, Infinity or non-positive", () => {
    for (const raw of ["1", "0.01", "999999", "$1,000,000.99"]) {
      const value = parseAskingPrice(raw);
      assert.ok(Number.isFinite(value) && value > 0, raw);
    }
  });

  /* ------------------------------------------------- Umbreon boundaries */
  console.log("\nboundaries — Umbreon VMAX 215/203 raw");

  const umbreon = priceGroups("swsh7-215");
  const raw = umbreon.get(RAW);
  assert.equal(raw.status, "AVAILABLE");

  const buy = raw.recommendedBuyDisplay;
  const reference = raw.marketReferenceDisplay;
  console.log(`  (derived: Recommended Buy $${buy}, Market Reference $${reference})`);

  const cases = [
    ["below 95% of Recommended Buy", buy * 0.9, "GREAT BUY"],
    ["exactly 95% of Recommended Buy", buy * 0.95, "GREAT BUY"],
    ["just above 95%", buy * 0.95 + 0.01, "GOOD BUY"],
    ["between 95% and Recommended Buy", (buy * 0.95 + buy) / 2, "GOOD BUY"],
    ["exactly Recommended Buy", buy, "GOOD BUY"],
    ["just above Recommended Buy", buy + 0.01, "FAIR"],
    ["between Recommended Buy and Market Reference", (buy + reference) / 2, "FAIR"],
    ["exactly Market Reference", reference, "FAIR"],
    ["just above Market Reference", reference + 0.01, "ABOVE MARKET"],
    ["well above Market Reference", reference * 1.25, "ABOVE MARKET"],
  ];

  for (const [label, asking, expected] of cases) {
    test(`${label} -> ${expected}`, () => {
      const assessment = assessAskingPrice(asking, raw);
      assert.equal(assessment.rating, expected);
      // The badge and the sentence must never contradict each other.
      if (expected === "GREAT BUY" || expected === "GOOD BUY") {
        assert.ok(/below our Recommended Buy|Exactly at our Recommended Buy/.test(assessment.explanation),
          assessment.explanation);
      }
      if (expected === "FAIR") {
        assert.ok(/above our Recommended Buy price, but still below/.test(assessment.explanation),
          assessment.explanation);
      }
      if (expected === "ABOVE MARKET") {
        assert.ok(/above the current Market Reference/.test(assessment.explanation),
          assessment.explanation);
      }
    });
  }

  test("explanation reports the difference the reader can verify on screen", () => {
    const assessment = assessAskingPrice(buy - 75, raw);
    assert.match(assessment.explanation, /\$75 below our Recommended Buy price\./);
    assert.equal(assessment.recommendedBuy, buy);
    assert.equal(assessment.marketReference, reference);
  });

  test("cents survive where they are real", () => {
    const assessment = assessAskingPrice(buy - 74.5, raw);
    assert.match(assessment.explanation, /\$74\.50 below/);
  });

  test("thresholds are not duplicated — rateDeal agrees with the checker", () => {
    for (const [, asking] of cases) {
      assert.equal(assessAskingPrice(asking, raw).rating, rateDeal(asking, buy, reference));
    }
  });

  /* ------------------------------------- the displayed value is the rule */
  // The number the reader is shown is the number they are held to. These
  // assertions are only meaningful when rounding actually moved something, so
  // the fixture is guarded rather than assumed.
  console.log("\ndisplayed threshold is authoritative");

  test("this fixture actually exercises rounding (exact != displayed)", () => {
    assert.notEqual(raw.recommendedBuy, raw.recommendedBuyDisplay,
      "exact and displayed Recommended Buy must differ for this test to mean anything");
    assert.notEqual(raw.marketReference, raw.marketReferenceDisplay,
      "exact and displayed Market Reference must differ for this test to mean anything");
    // Rounded down and up respectively, so both directions are covered.
    assert.ok(raw.recommendedBuyDisplay < raw.recommendedBuy);
    assert.ok(raw.marketReferenceDisplay > raw.marketReference);
  });

  test("exactly the displayed Recommended Buy is still a GOOD BUY", () => {
    assert.equal(assessAskingPrice(buy, raw).rating, "GOOD BUY");
  });

  test("one cent above the displayed Recommended Buy is FAIR", () => {
    assert.equal(assessAskingPrice(buy + 0.01, raw).rating, "FAIR");
  });

  test("between displayed and exact Recommended Buy is FAIR, not GOOD BUY", () => {
    // The case that distinguishes the two rules: below the exact threshold,
    // above the printed one. The printed one wins.
    const between = (buy + raw.recommendedBuy) / 2;
    assert.ok(between > buy && between < raw.recommendedBuy);
    assert.equal(assessAskingPrice(between, raw).rating, "FAIR");
    assert.equal(rateDeal(between, raw.recommendedBuy, raw.marketReference), "GOOD BUY",
      "sanity: the exact-value rule would have said GOOD BUY here");
  });

  test("exactly the displayed Market Reference is still FAIR", () => {
    assert.equal(assessAskingPrice(reference, raw).rating, "FAIR");
  });

  test("one cent above the displayed Market Reference is ABOVE MARKET", () => {
    assert.equal(assessAskingPrice(reference + 0.01, raw).rating, "ABOVE MARKET");
  });

  test("between exact and displayed Market Reference is FAIR, not ABOVE MARKET", () => {
    const between = (raw.marketReference + reference) / 2;
    assert.ok(between > raw.marketReference && between < reference);
    assert.equal(assessAskingPrice(between, raw).rating, "FAIR");
    assert.equal(rateDeal(between, raw.recommendedBuy, raw.marketReference), "ABOVE MARKET",
      "sanity: the exact-value rule would have said ABOVE MARKET here");
  });

  test("rateDealAgainst agrees with the checker at every boundary", () => {
    // Both public helpers must answer to the same rule, or a future caller
    // picking the other one silently gets a different verdict.
    for (const asking of [
      buy - 0.01, buy, buy + 0.01,
      (buy + raw.recommendedBuy) / 2,
      reference - 0.01, reference, reference + 0.01,
      (raw.marketReference + reference) / 2,
    ]) {
      assert.equal(rateDealAgainst(asking, raw), assessAskingPrice(asking, raw).rating,
        `disagreement at ${asking}`);
    }
  });

  /* ------------------------------------------------------- other groups */
  console.log("\nother groups");

  const psa10 = umbreon.get("PSA_10|UNKNOWN|STANDARD|EN");
  test("Umbreon PSA 10 rates against its own, higher threshold", () => {
    const asking = buy;
    assert.equal(assessAskingPrice(asking, raw).rating, "GOOD BUY");
    assert.equal(assessAskingPrice(asking, psa10).rating, "GREAT BUY",
      "the raw recommendation is far below PSA 10's");
    assert.notEqual(
      assessAskingPrice(asking, raw).recommendedBuy,
      assessAskingPrice(asking, psa10).recommendedBuy,
    );
  });

  const giratina = priceGroups("swsh11-212").get("RAW_NM|UNKNOWN|STANDARD|EN");
  test("Giratina VSTAR rates a low-value card without fake precision", () => {
    const assessment = assessAskingPrice(giratina.recommendedBuyDisplay - 2, giratina);
    assert.equal(assessment.rating, "GREAT BUY");
    assert.match(assessment.explanation, /^\$2 below our Recommended Buy price\.$/);
  });

  /* ------------------------------------------------- unavailable groups */
  console.log("\nunavailable groups");

  const refusals = [
    ["TOO_FEW_COMPS", umbreon.get("PSA_9|UNKNOWN|STANDARD|EN")],
    ["MIXED_POPULATION", priceGroups("neo1-9").get("RAW_UNKNOWN|FIRST_EDITION|STANDARD|EN")],
    ["SOURCE_CONFLICT", priceGroups("base1-4").get(RAW)],
    ["COMPS_DISAGREE", priceGroups("xy12-11").get(RAW)],
    ["SALES_UNAVAILABLE", salesUnavailable("")],
    ["NO_SALES_FOUND", noSalesFound("")],
  ];

  for (const [reason, result] of refusals) {
    test(`${reason}: never rates a deal, always explains`, () => {
      assert.equal(result.status, "UNAVAILABLE");
      assert.equal(result.reason, reason);
      assert.equal(assessAskingPrice(1000, result), null, "must not produce a rating");
      const message = dealCheckUnavailableReason(result);
      assert.ok(message.startsWith("Deal rating unavailable — "), message);
      assert.ok(!message.includes("_"), `"${message}" leaks an enum name`);
    });
  }

  test("zero-listings is worded differently from a failed lookup", () => {
    assert.equal(noSalesFound("").message, "No comparable sales were found.");
    assert.equal(salesUnavailable("").message, "Comparable sales could not be loaded.");
    assert.notEqual(
      dealCheckUnavailableReason(noSalesFound("")),
      dealCheckUnavailableReason(salesUnavailable("")),
    );
  });

  test("an available group is never treated as unavailable", () => {
    assert.equal(dealCheckUnavailableReason(raw), null);
  });

  /* -------------------------------------------------------- robustness */
  console.log("\nrobustness");

  test("invalid amounts cannot reach the rating logic", () => {
    for (const bad of [NaN, Infinity, -Infinity, 0, -100]) {
      assert.equal(assessAskingPrice(bad, raw), null, String(bad));
    }
  });

  test("parse then assess never throws for arbitrary input", () => {
    for (const raw_input of ["", "abc", "$", "-1", "0", "1e5", "99999999999", "0.001"]) {
      const parsed = parseAskingPrice(raw_input);
      const assessment = parsed === null ? null : assessAskingPrice(parsed, raw);
      assert.ok(assessment === null || typeof assessment.rating === "string");
    }
  });

  console.log(`\n${passed} assertions passed${process.exitCode ? " (with failures)" : ""}`);
})();
