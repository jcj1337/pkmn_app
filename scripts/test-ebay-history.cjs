/**
 * Fixture tests for the eBay history collection layer.
 *
 * Makes no network calls: `collectSoldHistory` is exercised against a stubbed
 * global fetch that replays canned actor responses, so completeness detection
 * and merge behaviour can be verified while the Apify quota is exhausted.
 *
 *   node scripts/test-ebay-history.cjs
 *
 * Requires a compiled lib:
 *   npx tsc lib/*.ts --outDir .eval-build --module commonjs --target es2022 \
 *     --moduleResolution node --skipLibCheck --esModuleInterop
 */
const path = require("node:path");
const assert = require("node:assert/strict");

const BUILD = path.join(__dirname, "..", ".eval-build");
const {
  assessCompleteness,
  mergeSales,
  coverage,
  collectSoldHistory,
} = require(path.join(BUILD, "ebay-history.js"));

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

/** Builds a fake actor row `n` days before 2026-08-20. */
function row(id, daysAgo, price = 100) {
  const date = new Date(Date.UTC(2026, 7, 20) - daysAgo * 86400000);
  return {
    itemId: id,
    title: `Test card ${id}`,
    soldPrice: String(price),
    soldCurrency: "USD",
    endedAt: date.toISOString().slice(0, 10),
    url: `https://ebay.com/itm/${id}`,
  };
}

/** Runs collectSoldHistory against a canned response, with no network. */
async function collectWith(rows, options) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => rows });
  try {
    return await collectSoldHistory(
      { name: "Test", number: "1", printedTotal: 100 },
      { days: 90, count: 100, token: "test", now: new Date("2026-08-20T00:00:00Z"), ...options },
    );
  } finally {
    globalThis.fetch = original;
  }
}

console.log("assessCompleteness");
test("fewer results than the cap means the window was exhausted", () => {
  assert.equal(assessCompleteness(4, 100, "2026-05-22", "2026-06-08"), "COMPLETE");
});
test("hitting the cap well inside the window is TRUNCATED", () => {
  assert.equal(assessCompleteness(100, 100, "2026-05-22", "2026-08-08"), "TRUNCATED");
});
test("hitting the cap at the window edge still counts as COMPLETE", () => {
  assert.equal(assessCompleteness(100, 100, "2026-05-22", "2026-05-22"), "COMPLETE");
});
test("no results is EMPTY, not COMPLETE", () => {
  assert.equal(assessCompleteness(0, 100, "2026-05-22", null), "EMPTY");
});

console.log("\nmergeSales");
test("deduplicates by itemId across collections", () => {
  const first = mergeSales([], [
    { itemId: "a", soldDate: "2026-08-10" },
    { itemId: "b", soldDate: "2026-08-12" },
  ], "2026-08-12T00:00:00Z");
  assert.equal(first.added, 2);

  const second = mergeSales(first.sales, [
    { itemId: "b", soldDate: "2026-08-12" },
    { itemId: "c", soldDate: "2026-08-19" },
  ], "2026-08-20T00:00:00Z");
  assert.equal(second.added, 1, "only the unseen itemId should be added");
  assert.equal(second.sales.length, 3);
});
test("keeps the earliest observation of a repeated sale", () => {
  const first = mergeSales([], [{ itemId: "a", title: "original", soldDate: "2026-08-10" }], "2026-08-10T00:00:00Z");
  const second = mergeSales(first.sales, [{ itemId: "a", title: "revised", soldDate: "2026-08-10" }], "2026-08-20T00:00:00Z");
  assert.equal(second.sales[0].title, "original");
  assert.equal(second.sales[0].firstSeenAt, "2026-08-10T00:00:00Z");
});
test("same-day distinct sales are both kept", () => {
  const merged = mergeSales([], [
    { itemId: "a", soldDate: "2026-08-17" },
    { itemId: "b", soldDate: "2026-08-17" },
  ], "2026-08-17T00:00:00Z");
  assert.equal(merged.sales.length, 2, "identical dates must not collapse");
});
test("sorts newest first", () => {
  const merged = mergeSales([], [
    { itemId: "old", soldDate: "2026-06-01" },
    { itemId: "new", soldDate: "2026-08-19" },
  ], "2026-08-20T00:00:00Z");
  assert.equal(merged.sales[0].itemId, "new");
});

console.log("\ncoverage");
test("contiguous collections report no gap", () => {
  const c = coverage([
    { completeness: "COMPLETE", observedFrom: "2026-05-22", observedTo: "2026-08-20" },
    { completeness: "COMPLETE", observedFrom: "2026-08-01", observedTo: "2026-09-01" },
  ]);
  assert.equal(c.hasGap, false);
  assert.equal(c.observedFrom, "2026-05-22");
  assert.equal(c.observedTo, "2026-09-01");
});
test("a lapse between collections is flagged as a gap", () => {
  const c = coverage([
    { completeness: "COMPLETE", observedFrom: "2026-01-01", observedTo: "2026-02-01" },
    { completeness: "COMPLETE", observedFrom: "2026-06-01", observedTo: "2026-07-01" },
  ]);
  assert.equal(c.hasGap, true, "a five-month lapse must not be reported as covered");
});
test("truncation anywhere is surfaced", () => {
  const c = coverage([
    { completeness: "COMPLETE", observedFrom: "2026-05-22", observedTo: "2026-08-20" },
    { completeness: "TRUNCATED", observedFrom: "2026-08-08", observedTo: "2026-08-20" },
  ]);
  assert.equal(c.anyTruncated, true);
});
test("EMPTY runs do not widen coverage", () => {
  const c = coverage([{ completeness: "EMPTY", observedFrom: "2026-01-01", observedTo: "2026-08-20" }]);
  assert.equal(c.observedFrom, null);
});

(async () => {
  console.log("\ncollectSoldHistory (stubbed actor)");

  const slow = await collectWith([row("a", 73), row("b", 40), row("c", 12), row("d", 2)]);
  test("sparse market: 4 results in 90 days is COMPLETE, window preserved", () => {
    assert.equal(slow.run.completeness, "COMPLETE");
    assert.equal(slow.run.returned, 4);
    assert.equal(slow.run.observedFrom, slow.run.requestedFrom,
      "a complete run vouches for the whole requested window");
  });

  const fastRows = Array.from({ length: 100 }, (_, i) => row(`f${i}`, i % 12));
  const fast = await collectWith(fastRows, { count: 100 });
  test("fast market: cap reached after 12 days is TRUNCATED", () => {
    assert.equal(fast.run.completeness, "TRUNCATED");
    assert.equal(fast.run.returned, 100);
  });
  test("truncated run narrows observedFrom to the oldest sale seen", () => {
    assert.equal(fast.run.observedFrom, fast.run.earliestSale);
    assert.notEqual(fast.run.observedFrom, fast.run.requestedFrom);
  });

  const dead = await collectWith([]);
  test("dead market records EMPTY rather than vanishing", () => {
    assert.equal(dead.run.completeness, "EMPTY");
    assert.equal(dead.run.returned, 0);
  });

  const capped = await collectWith([row("a", 1)], { days: 365 });
  test("days above the actor limit is clamped to 90", () => {
    assert.equal(capped.run.requestedDays, 90);
  });

  console.log(`\n${passed} assertions passed${process.exitCode ? " (with failures)" : ""}`);
})();
