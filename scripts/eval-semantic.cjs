/**
 * Evaluates the semantic fallback against eval/listings.json.
 *
 *   Policy A = deterministic classifier only
 *   Policy B = deterministic + conservative LLM fallback
 *
 * Optimises for avoiding wrong comps, not for coverage: a correct abstention
 * beats a confident wrong answer.
 *
 *   node scripts/eval-semantic.cjs          # dry run, no API calls
 *   node scripts/eval-semantic.cjs --live   # calls the model
 *
 * Requires a compiled lib first:
 *   npx tsc lib/*.ts --outDir .eval-build --module commonjs --target es2022 \
 *     --moduleResolution node --skipLibCheck --esModuleInterop
 */
const fs = require("node:fs");
const path = require("node:path");

const BUILD = path.join(__dirname, "..", ".eval-build");
const { reviewListings, semanticReviewReason } = require(path.join(BUILD, "listing-review.js"));
const { classifyListings } = require(path.join(BUILD, "listing-classifier.js"));
const { getSetNames } = require(path.join(BUILD, "tcgdex.js"));
const { isSemanticReviewConfigured, semanticModelName } =
  require(path.join(BUILD, "llm-listing-classifier.js"));

const live = process.argv.includes("--live");
const datasetArg = process.argv.find((a) => a.startsWith("--dataset="));
const datasetFile = datasetArg ? datasetArg.split("=")[1] : "listings.json";
const dataset = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "eval", datasetFile), "utf8"),
);

const asListing = (entry) => ({
  itemId: entry.id,
  title: entry.title,
  soldPrice: null,
  currency: "USD",
  soldDate: null,
  condition: null,
  imageUrl: null,
  url: null,
});

/** A listing should end up accepted only when it is genuinely the target. */
const shouldAccept = (expected) => expected === "TARGET";

function score(rows, label) {
  const total = rows.length;
  const correctTarget = rows.filter((r) => r.expected === "TARGET" && r.accepted).length;
  const correctReject = rows.filter((r) => r.expected === "NOT_TARGET" && !r.accepted).length;
  const correctAbstain = rows.filter(
    (r) => r.expected === "INSUFFICIENT_EVIDENCE" && !r.accepted,
  ).length;
  const falseNeg = rows.filter((r) => r.expected === "TARGET" && !r.accepted).length;
  const falsePos = rows.filter((r) => r.expected !== "TARGET" && r.accepted).length;
  const correct = correctTarget + correctReject + correctAbstain;

  console.log(`\n=== POLICY ${label} ===`);
  console.log(`  correct target identifications : ${correctTarget} / ${rows.filter((r) => r.expected === "TARGET").length}`);
  console.log(`  correct rejections             : ${correctReject} / ${rows.filter((r) => r.expected === "NOT_TARGET").length}`);
  console.log(`  correct abstentions            : ${correctAbstain} / ${rows.filter((r) => r.expected === "INSUFFICIENT_EVIDENCE").length}`);
  console.log(`  false negatives (missed target): ${falseNeg}`);
  console.log(`  FALSE POSITIVES (bad comps)    : ${falsePos}`);
  console.log(`  overall correct                : ${correct}/${total}  ${((correct / total) * 100).toFixed(1)}%`);
  return { correctTarget, correctReject, correctAbstain, falseNeg, falsePos, correct, total };
}

(async () => {
  console.log(`model: ${semanticModelName()}   configured: ${isSemanticReviewConfigured()}`);
  console.log(`dataset: ${dataset.entries.length} entries (${path.join("eval", datasetFile)})`);

  const knownSetNames = await getSetNames().catch(() => undefined);

  // ---- Policy A: deterministic only -------------------------------
  const rowsA = dataset.entries.map((entry) => {
    const [c] = classifyListings([asListing(entry)], entry.target, { knownSetNames });
    return { entry, expected: entry.expected, accepted: c.relevant, category: c.category };
  });

  const triggers = dataset.entries.filter((entry) => {
    const [c] = classifyListings([asListing(entry)], entry.target, { knownSetNames });
    return Boolean(semanticReviewReason(c));
  });
  console.log(`listings that trigger semantic review: ${triggers.length}`);

  const statsA = score(rowsA, "A — deterministic only");

  if (!live) {
    console.log("\nDRY RUN — no API calls. Re-run with --live for policy B.");
    return;
  }
  if (!isSemanticReviewConfigured()) {
    console.error("ANTHROPIC_API_KEY not set.");
    process.exit(1);
  }

  // ---- Policy B: deterministic + conservative LLM fallback ---------
  const rowsB = [];
  let calls = 0;
  let schemaFailures = 0;
  const started = Date.now();

  for (const entry of dataset.entries) {
    const [reviewed] = await reviewListings([asListing(entry)], entry.target, {
      knownSetNames,
      enableSemanticReview: true,
    });
    const consulted = reviewed.decidedBy === "rules+llm";
    const attempted = Boolean(reviewed.ambiguityReason);
    if (attempted) calls += 1;
    if (attempted && !consulted) schemaFailures += 1;

    rowsB.push({
      entry,
      expected: entry.expected,
      accepted: reviewed.relevant,
      category: reviewed.category,
      verdict: reviewed.semanticVerdict,
      rescued: reviewed.relevant && !reviewed.deterministic.relevant,
      reinforced: !reviewed.relevant && reviewed.deterministic.relevant,
    });
  }

  const statsB = score(rowsB, "B — deterministic + conservative LLM");

  // ---- Rescue precision -------------------------------------------
  const rescues = rowsB.filter((r) => r.rescued);
  const goodRescues = rescues.filter((r) => r.expected === "TARGET");
  console.log(`\n=== RESCUE PRECISION ===`);
  console.log(`  rescues attempted : ${rescues.length}`);
  console.log(`  genuinely correct : ${goodRescues.length}`);
  console.log(
    `  precision         : ${rescues.length ? ((goodRescues.length / rescues.length) * 100).toFixed(1) + "%" : "n/a (no rescues)"}`,
  );
  for (const r of rescues) {
    console.log(`   ${r.expected === "TARGET" ? "OK  " : "BAD "} [${r.expected}] ${r.entry.title.slice(0, 74)}`);
  }

  const reinforced = rowsB.filter((r) => r.reinforced);
  console.log(`\n  rejections reinforced by model: ${reinforced.length}`);
  for (const r of reinforced) {
    console.log(`   ${r.expected !== "TARGET" ? "OK  " : "BAD "} [${r.expected}] ${r.entry.title.slice(0, 74)}`);
  }

  // ---- Abstentions -------------------------------------------------
  const consulted = rowsB.filter((r) => r.verdict);
  const abstained = consulted.filter(
    (r) => r.verdict.relevant === "UNCERTAIN" || r.verdict.targetMatch === "UNKNOWN",
  );
  console.log(`\n=== ABSTENTION ===`);
  console.log(`  consulted            : ${consulted.length}`);
  console.log(`  abstained            : ${abstained.length}  ${consulted.length ? ((abstained.length / consulted.length) * 100).toFixed(1) + "%" : ""}`);
  console.log(`  schema failures      : ${schemaFailures}`);
  console.log(`  total LLM calls      : ${calls}`);
  console.log(`  elapsed              : ${((Date.now() - started) / 1000).toFixed(1)}s`);

  console.log(`\n=== A vs B ===`);
  console.log(`  false positives : ${statsA.falsePos} -> ${statsB.falsePos}`);
  console.log(`  false negatives : ${statsA.falseNeg} -> ${statsB.falseNeg}`);
  console.log(`  overall correct : ${statsA.correct}/${statsA.total} -> ${statsB.correct}/${statsB.total}`);

  fs.writeFileSync(
    path.join(__dirname, "..", "eval", datasetFile.replace(/.json$/, "") + "-last-run.json"),
    JSON.stringify({ ranAt: new Date().toISOString(), model: semanticModelName(), statsA, statsB, rows: rowsB }, null, 2),
  );
})();
