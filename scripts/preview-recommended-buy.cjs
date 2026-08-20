/**
 * Renders the Recommended Buy UI states to text, from saved fixtures.
 *
 * Compiles the client component, server-renders it with real classified data,
 * and reports what a reader would actually see. No Apify calls, no dev server.
 *
 *   node scripts/preview-recommended-buy.cjs
 *
 * Requires a compiled lib:
 *   npx tsc lib/*.ts --outDir .eval-build --module commonjs --target es2022 \
 *     --moduleResolution node --skipLibCheck --esModuleInterop
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, ".eval-build");
const TMP = path.join(ROOT, ".ui-preview");

/* ---- compile the client component against the same lib the app uses ---- */
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(
  path.join(TMP, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      outDir: ".", rootDir: "..", jsx: "react-jsx", module: "commonjs",
      target: "es2022", moduleResolution: "node", skipLibCheck: true,
      esModuleInterop: true, baseUrl: "..", paths: { "@/*": ["./*"] },
    },
    include: [
      "../app/components/SoldListingGroups.tsx",
      "../app/components/DealRating.tsx",
      "../app/components/DealChecker.tsx",
      "../lib/**/*.ts",
    ],
  }),
);
execFileSync("npx", ["tsc", "-p", path.join(TMP, "tsconfig.json")], {
  cwd: ROOT, shell: true, stdio: "inherit",
});

// The compiled output keeps the "@/lib/..." specifiers Next resolves for us.
for (const file of ["SoldListingGroups.js", "DealRating.js", "DealChecker.js"]) {
  const full = path.join(TMP, "app", "components", file);
  fs.writeFileSync(
    full,
    fs.readFileSync(full, "utf8").replace(/require\("@\/lib\//g, 'require("../../lib/'),
  );
}

const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { SoldListingGroups, RecommendedBuyPanel, evidenceLines } =
  require(path.join(TMP, "app", "components", "SoldListingGroups.js"));
const { DealRatingBadge, DEAL_RATING_STYLES } =
  require(path.join(TMP, "app", "components", "DealRating.js"));

const { classifyListings, groupClassified } = require(path.join(BUILD, "listing-classifier.js"));
const { getSetNames } = require(path.join(BUILD, "tcgdex.js"));
const { evaluateRecommendedBuy, salesUnavailable, noSalesFound } =
  require(path.join(BUILD, "recommended-buy.js"));

const AS_OF = new Date("2026-08-17T00:00:00Z");

/** Strips tags so the output shows reading order, not markup. */
function readable(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, "")
    .replace(/<\/(div|p|li|h3|ul|dl|button|section)>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
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
  const csv = path.join(ROOT, "analysis", "out", "tcgplayer_history.csv");
  if (!fs.existsSync(csv)) return byCard;

  // Python writes CRLF on Windows. Splitting on "\n" alone leaves a carriage
  // return on the last header cell, indexOf misses it, and every cached price
  // silently becomes NaN - which reads as "this card has no history".
  const lines = fs.readFileSync(csv, "utf8").trim().split(/\r?\n/);
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

  function build(cardId) {
    const card = cards.find((c) => c.id === cardId);
    const rows = JSON.parse(
      fs.readFileSync(path.join(ROOT, "analysis", "data", "ebay-sold", `${cardId}.json`), "utf8"),
    );
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

    const metrics = {};
    for (const group of groups) {
      metrics[group.key] = evaluateRecommendedBuy({
        groupKey: group.key,
        sales: group.listings
          .filter((l) => l.soldPrice !== null)
          .map((l) => ({
            itemId: l.itemId, title: l.title, soldPrice: l.soldPrice,
            soldDate: l.soldDate, isGraded: l.isGraded,
          })),
        tcgMarketPrice,
        history: historyByCard.get(cardId) ?? null,
        asOf: AS_OF,
      });
    }
    return { card, groups, metrics };
  }

  /** Renders the panel exactly as the section would, for one group. */
  function show(title, cardId, groupKey) {
    const { groups, metrics } = build(cardId);
    const group = groups.find((g) => g.key === groupKey);
    if (!group) {
      console.log(`\n### ${title}\n  (group ${groupKey} not present)`);
      return;
    }
    const html = renderToStaticMarkup(
      React.createElement(RecommendedBuyPanel, {
        result: metrics[groupKey],
        groupLabel: group.label,
      }),
    );
    console.log(`\n### ${title}`);
    readable(html).forEach((line) => console.log(`  ${line}`));
  }

  const RAW = "RAW_UNKNOWN|UNKNOWN|STANDARD|EN";

  console.log("=".repeat(72));
  console.log("RECOMMENDED BUY — UI STATES");
  console.log("=".repeat(72));

  show("A. AVAILABLE, raw — Umbreon VMAX 215/203", "swsh7-215", RAW);
  show("B. AVAILABLE, graded — Umbreon VMAX PSA 10", "swsh7-215", "PSA_10|UNKNOWN|STANDARD|EN");
  show("C. AVAILABLE, low value — Giratina VSTAR 212/196", "swsh11-212", "RAW_NM|UNKNOWN|STANDARD|EN");
  show("D. TOO_FEW_COMPS — Umbreon VMAX PSA 9", "swsh7-215", "PSA_9|UNKNOWN|STANDARD|EN");
  show("E. MIXED_POPULATION — Lugia 9/111 1st Edition", "neo1-9", "RAW_UNKNOWN|FIRST_EDITION|STANDARD|EN");
  show("F. SOURCE_CONFLICT — Base Set Charizard 4/102", "base1-4", RAW);
  show("G. COMPS_DISAGREE — Charizard 11/108", "xy12-11", RAW);

  console.log("\n### H. SALES_UNAVAILABLE — Apify quota exhausted");
  readable(
    renderToStaticMarkup(
      React.createElement(RecommendedBuyPanel, { result: salesUnavailable("") }),
    ),
  ).forEach((line) => console.log(`  ${line}`));

  /* ---- group switching ------------------------------------------------ */
  console.log(`\n${"=".repeat(72)}`);
  console.log("GROUP SWITCHING — Umbreon VMAX 215/203");
  console.log("=".repeat(72));
  const umbreon = build("swsh7-215");
  console.log(`  ${"group".padEnd(38)}${"n".padStart(3)}   recommendation`);
  for (const group of umbreon.groups) {
    const result = umbreon.metrics[group.key];
    const shown =
      result.status === "AVAILABLE"
        ? `<= $${result.recommendedBuyDisplay}  (ref $${result.marketReferenceDisplay})`
        : `Unavailable — ${result.message}`;
    console.log(`  ${group.label.padEnd(38)}${String(group.count).padStart(3)}   ${shown}`);
  }

  /* ---- the default selected group actually renders --------------------- */
  const full = renderToStaticMarkup(
    React.createElement(SoldListingGroups, {
      groups: umbreon.groups,
      metrics: umbreon.metrics,
    }),
  );
  console.log("\n### Section reading order (default group)");
  readable(full).slice(0, 16).forEach((line) => console.log(`  ${line}`));

  /* ---- expanded "Why this price?" ------------------------------------- */
  console.log("");
  console.log(`${"=".repeat(72)}`);
  console.log('"WHY THIS PRICE?" EXPANDED - Umbreon VMAX 215/203 raw');
  console.log("=".repeat(72));
  const detail = umbreon.metrics[RAW];
  evidenceLines(detail).forEach((line) => console.log(`  - ${line}`));
  console.log(`  A ${Math.round(detail.margin * 100)}% safety margin was applied:`);
  for (const component of detail.marginComponents) {
    console.log(`      ${component.label.padEnd(46)} +${Math.round(component.amount * 100)}%`);
  }

  /* ---- deal checker ---------------------------------------------------- */
  const { DealChecker } = require(path.join(TMP, "app", "components", "DealChecker.js"));
  console.log("");
  console.log(`${"=".repeat(72)}`);
  console.log("DEAL CHECKER");
  console.log("=".repeat(72));

  console.log("");
  console.log("### available group (Umbreon raw) - initial render");
  readable(renderToStaticMarkup(
    React.createElement(DealChecker, { result: umbreon.metrics[RAW] }),
  )).forEach((line) => console.log(`  ${line}`));

  const psa9 = umbreon.metrics["PSA_9|UNKNOWN|STANDARD|EN"];
  console.log("");
  console.log("### refused group (Umbreon PSA 9)");
  readable(renderToStaticMarkup(
    React.createElement(DealChecker, { result: psa9 }),
  )).forEach((line) => console.log(`  ${line}`));

  console.log("");
  console.log("### zero listings");
  readable(renderToStaticMarkup(
    React.createElement(DealChecker, { result: noSalesFound("") }),
  )).forEach((line) => console.log(`  ${line}`));

  console.log("");
  console.log("### apify failure");
  readable(renderToStaticMarkup(
    React.createElement(DealChecker, { result: salesUnavailable("") }),
  )).forEach((line) => console.log(`  ${line}`));

  console.log("");
  console.log("### accessibility markers on the input");
  const form = renderToStaticMarkup(
    React.createElement(DealChecker, { result: umbreon.metrics[RAW] }),
  );
  console.log("  <label for=...>      :", /<label[^>]*for="/.test(form));
  console.log("  matching input id    :", (() => {
    const forAttr = (form.match(/<label[^>]*for="([^"]+)"/) || [])[1];
    return forAttr ? form.includes(`id="${forAttr}"`) : false;
  })());
  console.log("  inputmode=decimal    :", /inputmode="decimal"/i.test(form));
  console.log("  submit button        :", /type="submit"/.test(form));
  console.log("  wrapped in a form    :", /<form/.test(form));

  /* ---- deal rating styles --------------------------------------------- */
  console.log(`\n${"=".repeat(72)}`);
  console.log("DEAL RATING PRESENTATION (not yet wired to any input)");
  console.log("=".repeat(72));
  for (const rating of Object.keys(DEAL_RATING_STYLES)) {
    const badge = renderToStaticMarkup(React.createElement(DealRatingBadge, { rating }));
    console.log(`  ${rating.padEnd(14)} -> ${readable(badge).join(" ")}`);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
})();
