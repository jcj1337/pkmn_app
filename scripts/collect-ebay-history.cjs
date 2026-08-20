/**
 * Offline collection of eBay sold history into a persistent, deduplicated
 * dataset that supports real liquidity measurement.
 *
 * This is a MANUAL data-ingestion task. Nothing in the app calls it, and
 * opening a card page never triggers it.
 *
 *   # always start here — makes zero requests and prints the cost
 *   node scripts/collect-ebay-history.cjs --all --days=90 --count=100 --dry-run
 *
 *   node scripts/collect-ebay-history.cjs --card=swsh7-215 --days=90
 *   node scripts/collect-ebay-history.cjs --cards=neo1-9,base1-10 --days=90
 *   node scripts/collect-ebay-history.cjs --all --days=30        # incremental
 *
 * Output: data/ebay-sales/<cardId>/raw-sales.json
 *
 * Requires APIFY_API_TOKEN in the environment or .env.local, and a compiled
 * lib (the same build the eval scripts use):
 *   npx tsc lib/*.ts --outDir .eval-build --module commonjs --target es2022 \
 *     --moduleResolution node --skipLibCheck --esModuleInterop
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, ".eval-build");
const OUT_ROOT = path.join(ROOT, "data", "ebay-sales");

const {
  collectSoldHistory,
  mergeSales,
  coverage,
  emptyFile,
} = require(path.join(BUILD, "ebay-history.js"));
const { buildEbayQuery } = require(path.join(BUILD, "ebay-sold.js"));

/* ---------------------------------------------------------------- config */

/**
 * Apify bills per returned result. At the actor's current rate a 100-result
 * run costs about 20 cents, so a 23-card backfill is a few dollars — small,
 * but not small enough to spend by accident.
 */
const USD_PER_RESULT = 0.002;
const USD_PER_RUN = 0.00005;

/** Refuse to spend more than this in one invocation without --force. */
const COST_CEILING_USD = 5;

/** A card collected this recently is skipped; re-running costs money. */
const DEFAULT_MIN_AGE_HOURS = 20;

/** Actor-enforced. There is no absolute start/end date input. */
const MAX_DAYS = 90;

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const args = { days: 90, count: 100, dryRun: false, force: false, all: false,
                 minAgeHours: DEFAULT_MIN_AGE_HOURS, cards: [] };

  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    switch (key) {
      case "card": args.cards.push(value); break;
      case "cards": args.cards.push(...value.split(",").map((c) => c.trim()).filter(Boolean)); break;
      case "all": args.all = true; break;
      case "days": args.days = Number(value); break;
      case "count": args.count = Number(value); break;
      case "min-age-hours": args.minAgeHours = Number(value); break;
      case "dry-run": args.dryRun = true; break;
      case "force": args.force = true; break;
      default: throw new Error(`Unknown option --${key}`);
    }
  }

  if (!args.all && args.cards.length === 0) {
    throw new Error("Specify --card=<id>, --cards=<a,b,c> or --all");
  }
  if (!Number.isFinite(args.days) || args.days < 1 || args.days > MAX_DAYS) {
    throw new Error(`--days must be 1..${MAX_DAYS} (actor limit)`);
  }
  if (!Number.isFinite(args.count) || args.count < 1) {
    throw new Error("--count must be >= 1");
  }
  return args;
}

/* --------------------------------------------------------------- catalog */

/**
 * Cards to collect for. Reuses the saved analysis card list so the collector
 * needs no network call just to learn what to ask for.
 */
function loadCatalog() {
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

/* --------------------------------------------------------------- storage */

const fileFor = (cardId) => path.join(OUT_ROOT, cardId, "raw-sales.json");

function loadFile(card) {
  const file = fileFor(card.id);
  if (!fs.existsSync(file)) return emptyFile(card);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveFile(record) {
  const file = fileFor(record.cardId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
}

function hoursSince(iso) {
  return iso ? (Date.now() - new Date(iso).getTime()) / 3_600_000 : Infinity;
}

/* ------------------------------------------------------------------ main */

function loadToken() {
  if (process.env.APIFY_API_TOKEN) return process.env.APIFY_API_TOKEN;

  // .env.local is not loaded outside Next, so read it directly.
  const envFile = path.join(ROOT, ".env.local");
  if (!fs.existsSync(envFile)) return null;
  const match = fs.readFileSync(envFile, "utf8").match(/^APIFY_API_TOKEN=(.+)$/m);
  return match ? match[1].trim() : null;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog();

  const selected = args.all
    ? catalog
    : args.cards.map((id) => {
        const card = catalog.find((c) => c.id === id);
        if (!card) throw new Error(`Unknown card id "${id}" (not in analysis/data/cards-*.json)`);
        return card;
      });

  // ---- planning pass: decide what would run, before touching the network
  const plan = selected.map((card) => {
    const record = loadFile(card);
    const last = record.collections[record.collections.length - 1];
    const age = hoursSince(last?.collectedAt);
    const cover = coverage(record.collections);
    return {
      card,
      record,
      skip: age < args.minAgeHours,
      ageHours: age,
      storedSales: record.sales.length,
      cover,
    };
  });

  const due = plan.filter((entry) => !entry.skip);
  const estimate = due.length * (USD_PER_RUN + args.count * USD_PER_RESULT);

  console.log(`window     : last ${args.days} days   (actor max ${MAX_DAYS}, relative only)`);
  console.log(`count cap  : ${args.count} results per card`);
  console.log(`cards      : ${selected.length} selected, ${due.length} due, ${plan.length - due.length} skipped (< ${args.minAgeHours}h old)`);
  console.log(`est. cost  : $${estimate.toFixed(2)}  (${due.length} runs x ${args.count} results @ $${USD_PER_RESULT}/result)`);
  console.log("");

  for (const entry of plan) {
    const state = entry.skip
      ? `skip (collected ${entry.ageHours.toFixed(0)}h ago)`
      : "DUE";
    const covered = entry.cover.observedFrom
      ? `${entry.cover.observedFrom}..${entry.cover.observedTo}${entry.cover.hasGap ? " GAP" : ""}`
      : "no history";
    console.log(
      `  ${entry.card.id.padEnd(15)} ${String(entry.storedSales).padStart(4)} stored  ` +
        `${covered.padEnd(26)} ${state}`,
    );
  }

  if (args.dryRun) {
    console.log("\nDRY RUN — no Apify requests made, nothing written.");
    return;
  }

  if (due.length === 0) {
    console.log("\nNothing due. Use --min-age-hours=0 to force a refresh.");
    return;
  }

  if (estimate > COST_CEILING_USD && !args.force) {
    console.error(
      `\nRefusing to spend an estimated $${estimate.toFixed(2)} (ceiling $${COST_CEILING_USD}).` +
        `\nReduce --count or --cards, or pass --force if this is intended.`,
    );
    process.exitCode = 1;
    return;
  }

  const token = loadToken();
  if (!token) {
    console.error("\nAPIFY_API_TOKEN not set (env or .env.local). Nothing collected.");
    process.exitCode = 1;
    return;
  }

  console.log("");
  let spent = 0;

  for (const entry of due) {
    const { card, record } = entry;
    process.stdout.write(`${card.id.padEnd(15)} `);

    let result;
    try {
      result = await collectSoldHistory(card, {
        days: args.days,
        count: args.count,
        token,
      });
    } catch (error) {
      console.log(`FAILED — ${error.message}`);
      // Stop on the first failure: a quota error would otherwise repeat 22 more
      // times, and a partial dataset is easier to reason about than a noisy one.
      console.error("\nStopping. Nothing further collected.");
      process.exitCode = 1;
      return;
    }

    const merged = mergeSales(record.sales, result.listings, result.run.collectedAt);
    record.sales = merged.sales;
    record.query = result.run.query;
    record.collections.push({ ...result.run, newSales: merged.added });
    saveFile(record);

    spent += USD_PER_RUN + result.run.returned * USD_PER_RESULT;

    console.log(
      `${String(result.run.returned).padStart(4)} returned  ` +
        `${String(merged.added).padStart(4)} new  ` +
        `${result.run.completeness.padEnd(9)} ` +
        `observed ${result.run.observedFrom}..${result.run.observedTo}  ` +
        `total ${record.sales.length}`,
    );
  }

  console.log(`\nCollected ${due.length} card(s). Actual cost ~$${spent.toFixed(2)}.`);
  console.log(`Stored under ${OUT_ROOT}`);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
