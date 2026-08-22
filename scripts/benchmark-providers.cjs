/**
 * Measures card-data provider coverage across the 23-card evaluation set.
 *
 * The original provider comparison that motivated the TCGdex migration was run
 * ad hoc and never written to disk, so this regenerates it reproducibly.
 * All three sources are free and read-only; no Apify credit is involved.
 *
 *   node scripts/benchmark-providers.cjs
 *
 * Writes analysis/data/provider-benchmark.json.
 *
 * Latency is wall-clock from one machine on one run and is NOT a fair
 * benchmark of the services — it is recorded only for completeness and should
 * not be quoted as a performance result.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, ".eval-build");
const { lookupCard } = require(path.join(BUILD, "tcgcsv.js"));

const OUT = path.join(ROOT, "analysis", "data", "provider-benchmark.json");
const UA = "TCGracker/0.1 (provider benchmark)";
const PAUSE_MS = 350;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * Runs a provider probe, retrying transient failures.
 *
 * Retries matter for correctness here, not politeness: a 500 that is counted
 * as "card not found" turns a reliability problem into a fake coverage
 * number. `attempts` and `failed` are recorded separately from `found` so the
 * two can never be conflated in the report.
 */
async function timed(fn, maxAttempts = 3) {
  const started = Date.now();
  let last = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await fn();
      if (!value.error) {
        return { ...value, ms: Date.now() - started, attempts: attempt, failed: false };
      }
      last = value;
    } catch (error) {
      last = { found: false, hasMarketPrice: false, error: String(error.message ?? error) };
    }
    if (attempt < maxAttempts) await sleep(800 * attempt);
  }

  // Every attempt failed: the provider did not answer, which is not the same
  // as answering "no such card".
  return { ...last, found: false, hasMarketPrice: false, ms: Date.now() - started, attempts: maxAttempts, failed: true };
}

/** TCGdex: direct lookup by the card id the app already stores. */
async function tcgdex(card) {
  const response = await fetch(`https://api.tcgdex.net/v2/en/cards/${card.id}`, {
    headers: { "User-Agent": UA },
  });
  if (!response.ok) return { found: false, hasMarketPrice: false, error: `HTTP ${response.status}` };

  const body = await response.json();
  const tcgplayer = body?.pricing?.tcgplayer ?? null;
  const hasMarketPrice = Boolean(
    tcgplayer &&
      Object.values(tcgplayer).some(
        (variant) => variant && typeof variant === "object" && typeof variant.marketPrice === "number",
      ),
  );
  return { found: Boolean(body?.id), hasMarketPrice };
}

/** PokemonTCG API v2: the provider this project migrated away from. */
async function pokemontcg(card) {
  const query = `name:"${card.name}" number:"${card.number}"`;
  const response = await fetch(
    `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(query)}&pageSize=10`,
    { headers: { "User-Agent": UA } },
  );
  if (!response.ok) return { found: false, hasMarketPrice: false, error: `HTTP ${response.status}` };

  const body = await response.json();
  const matches = body?.data ?? [];
  if (matches.length === 0) return { found: false, hasMarketPrice: false };

  // Prefer a set-name match; otherwise accept the first name+number hit.
  const norm = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const hit =
    matches.find((m) => norm(m?.set?.name) === norm(card.setName)) ?? matches[0];

  const prices = hit?.tcgplayer?.prices ?? null;
  const hasMarketPrice = Boolean(
    prices &&
      Object.values(prices).some(
        (variant) => variant && typeof variant.market === "number",
      ),
  );
  return { found: true, hasMarketPrice, setMatched: norm(hit?.set?.name) === norm(card.setName) };
}

/** TCGCSV: the fallback the app uses when TCGdex has no TCGplayer mapping. */
async function tcgcsv(card) {
  const result = await lookupCard({
    name: card.name,
    setName: card.setName,
    localId: card.number,
    printedTotal: card.printedTotal,
    rarity: card.rarity ?? null,
    variants: { firstEdition: false, holo: true, normal: false, reverse: false },
  });
  if (result.status !== "matched") return { found: false, hasMarketPrice: false, status: result.status };

  return {
    found: true,
    hasMarketPrice: typeof result.match?.prices?.market === "number",
  };
}

(async () => {
  const cards = loadCards();
  console.log(`benchmarking ${cards.length} cards across 3 providers\n`);
  console.log(`${"card".padEnd(16)}${"tcgdex".padEnd(18)}${"pokemontcg".padEnd(18)}tcgcsv`);

  const rows = [];
  for (const card of cards) {
    const a = await timed(() => tcgdex(card));
    await sleep(PAUSE_MS);
    const b = await timed(() => pokemontcg(card));
    await sleep(PAUSE_MS);
    const c = await timed(() => tcgcsv(card));

    const badge = (r) =>
      `${r.found ? "found" : "MISS "}/${r.hasMarketPrice ? "price" : "  -  "}`;
    console.log(
      `${card.id.padEnd(16)}${badge(a).padEnd(18)}${badge(b).padEnd(18)}${badge(c)}`,
    );

    rows.push({ cardId: card.id, name: card.name, setName: card.setName, tcgdex: a, pokemontcg: b, tcgcsv: c });
  }

  const summarize = (key) => {
    const results = rows.map((row) => row[key]);
    // Coverage is only meaningful over requests that actually answered.
    const answered = results.filter((r) => !r.failed);
    const latencies = answered.map((r) => r.ms).sort((x, y) => x - y);
    return {
      cards: results.length,
      requestsFailed: results.filter((r) => r.failed).length,
      retriedAtLeastOnce: results.filter((r) => r.attempts > 1).length,
      answered: answered.length,
      found: answered.filter((r) => r.found).length,
      withMarketPrice: answered.filter((r) => r.hasMarketPrice).length,
      coveragePct: answered.length ? (100 * answered.filter((r) => r.found).length) / answered.length : null,
      pricePct: answered.length ? (100 * answered.filter((r) => r.hasMarketPrice).length) / answered.length : null,
      medianMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    };
  };

  const output = {
    ranAt: new Date().toISOString(),
    note:
      "Coverage measured over the 23-card evaluation set. Latency is single-run, " +
      "single-location wall clock and is not a fair service benchmark.",
    providers: {
      tcgdex: summarize("tcgdex"),
      pokemontcg: summarize("pokemontcg"),
      tcgcsv: summarize("tcgcsv"),
    },
    rows,
  };

  fs.writeFileSync(OUT, JSON.stringify(output, null, 2) + "\n");
  console.log(`\n${JSON.stringify(output.providers, null, 2)}`);
  console.log(`\nwrote ${OUT}`);
})();
