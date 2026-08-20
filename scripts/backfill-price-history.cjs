/**
 * Downloads TCGCSV daily archives and extracts per-group TCGplayer market-price
 * history into data/price-history/<groupId>.json.
 *
 * The download dominates the cost (~3.5 MB per archive) and is shared across
 * every group, so pass all the groups you want in one run rather than invoking
 * this per card.
 *
 *   node scripts/backfill-price-history.cjs --groups=604,3172 --cadence=7
 *   node scripts/backfill-price-history.cjs --groups=604 --from=2025-01-01 --cadence=7
 *
 *   --groups   required, comma-separated TCGCSV group ids
 *   --from     default 2024-02-08 (first archive TCGCSV published)
 *   --to       default today
 *   --cadence  days between samples, default 7 (weekly)
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const _7z = require("7zip-min");

const ARCHIVE_BASE = "https://tcgcsv.com/archive/tcgplayer";
const USER_AGENT = "pkmn-app/0.1 (Pokemon card price checker)";
const CATEGORY = 3; // Pokémon
const EPOCH = "2024-02-08";
const OUT_DIR = path.join(__dirname, "..", "data", "price-history");

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};

const groups = (arg("groups", "") || "")
  .split(",")
  .map((g) => g.trim())
  .filter(Boolean)
  .map(Number);

if (groups.length === 0) {
  console.error("Pass --groups=<id>[,<id>...]  (TCGCSV group ids)");
  process.exit(1);
}

const from = arg("from", EPOCH);
const to = arg("to", new Date().toISOString().slice(0, 10));
const cadence = Number(arg("cadence", "7"));

function sampleDates(start, end, stepDays) {
  const dates = [];
  const cursor = new Date(`${start < EPOCH ? EPOCH : start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + stepDays);
  }
  return dates;
}

function extractOne(archivePath, innerPath, outDir) {
  return new Promise((resolve, reject) => {
    _7z.cmd(["x", archivePath, `-o${outDir}`, innerPath, "-y"], (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

(async () => {
  const dates = sampleDates(from, to, cadence);
  console.log(`groups   : ${groups.join(", ")}`);
  console.log(`range    : ${dates[0]} .. ${dates[dates.length - 1]}  (cadence ${cadence}d)`);
  console.log(`samples  : ${dates.length}  (~${((dates.length * 3.5) / 1024).toFixed(2)} GB of downloads avoided at render time)\n`);

  // groupId -> productId -> subType -> { date: price }
  const collected = new Map(groups.map((g) => [g, new Map()]));
  const usedDates = [];
  let downloaded = 0;
  let missing = 0;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tcgcsv-"));

  for (const [index, date] of dates.entries()) {
    const url = `${ARCHIVE_BASE}/prices-${date}.ppmd.7z`;
    const archivePath = path.join(tmpRoot, `${date}.7z`);

    let response;
    try {
      response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    } catch (error) {
      console.log(`  ${date}  network error, skipped (${error.message})`);
      missing += 1;
      continue;
    }
    if (!response.ok) {
      console.log(`  ${date}  HTTP ${response.status}, skipped`);
      missing += 1;
      continue;
    }

    fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
    downloaded += 1;

    const outDir = path.join(tmpRoot, "x", date);
    let any = false;

    for (const groupId of groups) {
      const inner = `${date}/${CATEGORY}/${groupId}/prices`;
      try {
        await extractOne(archivePath, inner, outDir);
      } catch {
        continue; // group absent that day (set not released yet)
      }

      const file = path.join(outDir, date, String(CATEGORY), String(groupId), "prices");
      if (!fs.existsSync(file)) continue;

      const rows = JSON.parse(fs.readFileSync(file, "utf8")).results ?? [];
      const perProduct = collected.get(groupId);

      for (const row of rows) {
        const pid = String(row.productId);
        const sub = row.subTypeName ?? "Unknown";
        if (!perProduct.has(pid)) perProduct.set(pid, new Map());
        const perSub = perProduct.get(pid);
        if (!perSub.has(sub)) perSub.set(sub, new Map());
        // Preserve nulls exactly — never substitute low/mid/high.
        perSub.get(sub).set(date, typeof row.marketPrice === "number" ? row.marketPrice : null);
      }
      any = true;
    }

    if (any) usedDates.push(date);
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(outDir, { recursive: true, force: true });

    if ((index + 1) % 10 === 0 || index === dates.length - 1) {
      console.log(`  ${index + 1}/${dates.length}  (${date})  downloaded=${downloaded} missing=${missing}`);
    }
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  usedDates.sort();
  for (const groupId of groups) {
    const perProduct = collected.get(groupId);
    const series = {};
    for (const [pid, perSub] of perProduct) {
      series[pid] = {};
      for (const [sub, byDate] of perSub) {
        series[pid][sub] = usedDates.map((d) => (byDate.has(d) ? byDate.get(d) : null));
      }
    }
    const out = path.join(OUT_DIR, `${groupId}.json`);
    fs.writeFileSync(out, JSON.stringify({ groupId, generatedAt: new Date().toISOString(), dates: usedDates, series }));
    const kb = (fs.statSync(out).size / 1024).toFixed(0);
    console.log(`\nwrote ${path.relative(process.cwd(), out)}  products=${Object.keys(series).length}  dates=${usedDates.length}  ${kb} KB`);
  }
})();
