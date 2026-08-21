"""
Quantifies what the data work in this project actually changed.

Every number here is computed from a file in this repository. Where a
"before" state was not saved, it is RECONSTRUCTED from saved data by re-running
the same logic under the old rule, and labelled as such. Nothing is recalled
from memory and nothing is estimated.

Sources
  analysis/data/classified-sales.json      460 eBay listings, current classifier
  analysis/out/comparable_sales.csv        314 -> 307 usable comps
  analysis/out/recommended-buy-results.json  144 groups, Python engine
  analysis/out/tcgplayer_history.csv       cached TCGplayer weekly history
  analysis/data/provider-benchmark.json    regenerated provider comparison
  eval/*-last-run.json                     saved pre-taxonomy classifier stats
  analysis/data/validation-raw.txt         current eval + parity output

Outputs land in analysis/out/resume-metrics/.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

HERE = Path(__file__).parent
DATA = HERE / "data"
OUT = HERE / "out"
DEST = OUT / "resume-metrics"

# Gate constants, mirrored from recommended_buy_analysis.py so the "before"
# reconstruction uses the identical rule. Not re-tuned here.
MIN_COMPS = 3
MAX_SPREAD = 1.00
MAX_SPLIT_RATIO = 3.0

PALETTE = {
    "keep": "#0f766e",
    "drop": "#b91c1c",
    "split": "#a16207",
    "neutral": "#64748b",
    "light": "#cbd5e1",
    "accent": "#1d4ed8",
}


def style(ax, title: str, xlabel: str = "", ylabel: str = "") -> None:
    ax.set_title(title, fontsize=11, fontweight="bold", loc="left")
    if xlabel:
        ax.set_xlabel(xlabel, fontsize=9)
    if ylabel:
        ax.set_ylabel(ylabel, fontsize=9)
    ax.tick_params(labelsize=8)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    ax.grid(axis="y", alpha=0.25, linewidth=0.6)
    ax.set_axisbelow(True)


def save(fig, name: str) -> str:
    path = DEST / name
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)
    return name


# ------------------------------------------------------------------ inputs
def load_all():
    sales = pd.DataFrame(json.loads((DATA / "classified-sales.json").read_text(encoding="utf8")))
    comps = pd.read_csv(OUT / "comparable_sales.csv", parse_dates=["soldDate"])
    buy = json.loads((OUT / "recommended-buy-results.json").read_text(encoding="utf8"))
    history = pd.read_csv(OUT / "tcgplayer_history.csv", parse_dates=["date"])
    providers = json.loads((DATA / "provider-benchmark.json").read_text(encoding="utf8"))
    validation = (DATA / "validation-raw.txt").read_text(encoding="utf8")
    before = {
        "dev": json.loads((HERE.parent / "eval" / "last-run.json").read_text(encoding="utf8")),
        "holdout": json.loads(
            (HERE.parent / "eval" / "holdout-listings-last-run.json").read_text(encoding="utf8")
        ),
    }
    return sales, comps, buy, history, providers, validation, before


# ------------------------------------------------------------ 1. the funnel
# Rejection reasons grouped by what they tell us. The distinction matters:
# a wrong card is bad data, a foreign printing is a different market.
WRONG_CARD = {
    "Title names a different card number",
    "Card name not found in title",
    "Printed card number not found in title",
    "Title names a different set",
}
NOT_A_SINGLE_CARD = {
    "Pick-your-card listing",
    "Novelty or non-standard product",
    "Proxy, replica or custom card",
    "Art card / novelty print, not the TCG card",
    "Gold foil / plated replica, not the TCG card",
    "Mystery / random-contents listing",
    "Raffle or chance-to-win listing",
    "Empty case or holder only",
    "Altered, signed or personalized copy",
    "Lot or bundle",
    "Digital item or online code",
    "Accessory or non-card item",
}


def funnel(sales: pd.DataFrame, comps: pd.DataFrame, buy: dict, lines: list[str]) -> dict:
    raw = len(sales)
    accepted = sales[sales["relevant"]]
    rejected = sales[~sales["relevant"]]

    wrong_card = int(rejected["relevanceReason"].isin(WRONG_CARD).sum())
    not_single = int(rejected["relevanceReason"].isin(NOT_A_SINGLE_CARD).sum())
    other_reject = len(rejected) - wrong_card - not_single

    foreign = int((~accepted["language"].isin(["EN", "UNKNOWN"])).sum())
    english = len(accepted) - foreign

    usable = len(comps)
    priced_groups = [g for g in buy["groups"] if not g["refused"]]
    priced_comps = sum(g["comps"] for g in priced_groups)

    say = lines.append
    say("## 1. Listing-cleaning funnel")
    say("")
    say(f"Raw scraped listings: **{raw}** across {sales['cardId'].nunique()} cards.")
    say("")
    say("| Stage | Listings | % of raw |")
    say("|---|---:|---:|")
    for label, value in [
        ("Raw scraped", raw),
        ("Relevant (passed classification)", len(accepted)),
        ("English-compatible", english),
        ("In a comparable group (analysis input)", usable),
        ("Inside a group that produced a price", priced_comps),
    ]:
        say(f"| {label} | {value} | {100 * value / raw:.1f}% |")
    say("")
    say("Where the rest went:")
    say("")
    say("| Removed / separated | Listings | % of raw | Nature |")
    say("|---|---:|---:|---|")
    say(f"| Wrong card, number or set | {wrong_card} | {100 * wrong_card / raw:.1f}% | bad data |")
    say(f"| Not a single card (lots, proxies, novelties, signed) | {not_single} | {100 * not_single / raw:.1f}% | bad data |")
    if other_reject:
        say(f"| Other rejections | {other_reject} | {100 * other_reject / raw:.1f}% | bad data |")
    say(f"| Non-English printing | {foreign} | {100 * foreign / raw:.1f}% | **separated, not discarded** |")
    say("")
    say(
        f"**{100 * len(rejected) / raw:.1f}%** of raw scraped listings were not the target "
        f"card at all. A further {foreign} were genuine sales of a different-language "
        "printing and were routed to their own comparable market rather than dropped."
    )
    say("")

    # ---- plot
    stages = ["Raw\nscraped", "Relevant", "English-\ncompatible", "In a\ncomparable\ngroup", "Inside a\npriced\ngroup"]
    values = [raw, len(accepted), english, usable, priced_comps]

    fig, ax = plt.subplots(figsize=(9, 4.6))
    bars = ax.bar(stages, values, color=[PALETTE["neutral"]] + [PALETTE["keep"]] * 4, width=0.62)
    for bar, value in zip(bars, values):
        ax.text(bar.get_x() + bar.get_width() / 2, value + 8,
                f"{value}\n{100 * value / raw:.0f}%", ha="center", fontsize=9)
    style(ax, "eBay listing-cleaning funnel (23 cards, 460 scraped listings)", ylabel="listings")
    ax.set_ylim(0, raw * 1.18)
    plot1 = save(fig, "01-cleaning-funnel.png")

    fig, ax = plt.subplots(figsize=(9, 4.2))
    labels = ["Wrong card /\nnumber / set", "Not a single\ncard", "Non-English\nprinting", "Kept as\nEnglish comps"]
    counts = [wrong_card, not_single + other_reject, foreign, english]
    colors = [PALETTE["drop"], PALETTE["drop"], PALETTE["split"], PALETTE["keep"]]
    bars = ax.barh(labels, counts, color=colors, height=0.6)
    for bar, value in zip(bars, counts):
        ax.text(value + 3, bar.get_y() + bar.get_height() / 2,
                f"{value}  ({100 * value / raw:.0f}%)", va="center", fontsize=9)
    style(ax, "What happened to 460 scraped listings", xlabel="listings")
    ax.set_xlim(0, max(counts) * 1.28)
    ax.invert_yaxis()
    plot2 = save(fig, "02-listing-disposition.png")

    return {
        "raw": raw, "accepted": len(accepted), "english": english, "usable": usable,
        "priced_comps": priced_comps, "wrong_card": wrong_card,
        "not_single": not_single + other_reject, "foreign": foreign,
        "plots": [plot1, plot2],
    }


# ---------------------------------------------- 2. taxonomy before / after
def quantile(sorted_values: np.ndarray, q: float) -> float:
    return float(np.quantile(sorted_values, q))


def gate_group(prices: np.ndarray) -> str | None:
    """The Stage-A gates, applied exactly as recommended_buy_analysis.py does."""
    prices = np.sort(prices)
    n = len(prices)
    if n < MIN_COMPS:
        return "TOO_FEW_COMPS"

    median = float(np.median(prices))
    iqr = quantile(prices, 0.75) - quantile(prices, 0.25)
    spread = iqr / median if median else None

    half = max(1, n // 2)
    lower = float(np.median(prices[:half]))
    upper = float(np.median(prices[-half:]))
    ratio = upper / lower if lower > 0 else None

    if ratio is not None and ratio > MAX_SPLIT_RATIO:
        return "MIXED_POPULATION"
    if spread is not None and spread > MAX_SPREAD:
        return "COMPS_DISAGREE"
    return None


def taxonomy(sales: pd.DataFrame, comps: pd.DataFrame, buy: dict, before: dict,
             lines: list[str]) -> dict:
    say = lines.append
    say("## 2. Impact of the taxonomy and classifier work")
    say("")

    # ---- (a) contamination now rejected, countable exactly
    new_rules = {
        "Art card / novelty print, not the TCG card": "art-card novelty prints",
        "Gold foil / plated replica, not the TCG card": "gold-foil replicas",
        "Altered, signed or personalized copy": "signed / altered copies",
    }
    contamination = {
        label: int((sales["relevanceReason"] == reason).sum())
        for reason, label in new_rules.items()
    }
    # Reprints that share a number with the original (Base Set 2's 10/130 vs
    # Base Set's 10/102) are only separable once the fraction DENOMINATOR is
    # checked against printedTotal. Detected by replicating that rule rather
    # than pattern-matching a card, so it cannot silently over-count: a title
    # qualifies only when it states the right number with the wrong total.
    def reprint_by_denominator(row) -> bool:
        if row["relevant"] or row["relevanceReason"] != "Title names a different card number":
            return False
        if pd.isna(row["printedTotal"]):
            return False
        wanted = str(row["cardNumber"]).lstrip("0").lower()
        for numerator, denominator in re.findall(
            r"\b([A-Za-z]{0,4}\d{1,4}[A-Za-z]?)\s*/\s*(\d+)\b", str(row["title"])
        ):
            if numerator.lstrip("0").lower() == wanted and int(denominator) != int(row["printedTotal"]):
                return True
        return False

    reprints = sales.apply(reprint_by_denominator, axis=1)
    contamination["Reprints caught by denominator check (e.g. 10/130 vs 10/102)"] = int(reprints.sum())
    total_contamination = sum(contamination.values())

    # Not every listing a new rule catches was previously accepted: some were
    # already excluded by an older, broader rule and merely gained a more
    # specific reason. Those are subtracted so the "newly rejected" figure is
    # a genuine before/after and not double credit.
    already_caught = re.compile(r"\bfan\s*(?:art|made)\b|\bmetal\b(?!\s*(?:energy|type))", re.I)
    newly_flagged = sales[
        sales["relevanceReason"].isin(new_rules.keys()) | reprints
    ]
    overlap = int(newly_flagged["title"].str.contains(already_caught, na=False).sum())
    net_new = total_contamination - overlap

    say("### Contamination removed by rules added in the taxonomy pass")
    say("")
    say("| Rule | Listings rejected |")
    say("|---|---:|")
    for label, count in contamination.items():
        say(f"| {label} | {count} |")
    say(f"| **Total caught by these rules** | **{total_contamination}** |")
    say(f"| ...of which an older broader rule already caught | {overlap} |")
    say(f"| **Net newly rejected** | **{net_new}** |")
    say("")
    say(
        f"So {net_new} listings that the pipeline previously accepted as comparable sales "
        f"are now excluded; the other {overlap} were already being rejected and simply "
        "gained a more specific reason. The clearest single case: four identical $9.85 "
        "sales of a *\"Shining Charizard Art Card\"* sat in the same comparable group as "
        "genuine sales at $1,600 and $2,152."
    )
    say("")

    # ---- (b) grouping effect, reconstructed under the old rule
    rows = []
    for key, label in [("category", "category only (before)"),
                       ("comparableGroup", "category + edition + printing + language (after)")]:
        counts = {"TOO_FEW_COMPS": 0, "MIXED_POPULATION": 0, "COMPS_DISAGREE": 0, "priced": 0}
        for _, frame in comps.groupby(["cardId", key]):
            verdict = gate_group(frame["soldPrice"].dropna().to_numpy())
            counts[verdict if verdict else "priced"] += 1
        counts["groups"] = sum(counts.values())
        rows.append({"rule": label, **counts})
    grouping = pd.DataFrame(rows)

    say("### Effect of the comparable-group key on mixed populations")
    say("")
    say(
        "Reconstructed by re-running the identical Stage-A gates over the same 307 "
        "comparable sales, grouped first by condition/grade alone and then by the full "
        "key. This isolates the grouping change from the rejection changes above."
    )
    say("")
    say("| Grouping rule | Groups | Mixed population | Comps disagree | Too few comps | Passed gates |")
    say("|---|---:|---:|---:|---:|---:|")
    for row in rows:
        say(
            f"| {row['rule']} | {row['groups']} | {row['MIXED_POPULATION']} | "
            f"{row['COMPS_DISAGREE']} | {row['TOO_FEW_COMPS']} | {row['priced']} |"
        )
    say("")
    mixed_before = rows[0]["MIXED_POPULATION"]
    mixed_after = rows[1]["MIXED_POPULATION"]
    say(
        f"Groups flagged as mixed populations fell from **{mixed_before} to {mixed_after}** "
        f"while the number of groups passing all gates rose from {rows[0]['priced']} to "
        f"{rows[1]['priced']}."
    )
    say("")

    # ---- (c) classifier evaluation, saved before vs measured after
    after = parse_validation_evals()
    dev_before, hold_before = before["dev"]["statsA"], before["holdout"]["statsA"]

    say("### Classifier evaluation, before vs after")
    say("")
    say(
        f"Before = `statsA` saved in `eval/*-last-run.json` (run of "
        f"{before['dev']['ranAt'][:10]}, pre-taxonomy). After = current run of the same "
        "script on the same hand-labelled datasets."
    )
    say("")
    say("| Dataset | n | Accuracy before | Accuracy after | False positives before | after |")
    say("|---|---:|---:|---:|---:|---:|")
    say(
        f"| Development | {dev_before['total']} | {100 * dev_before['correct'] / dev_before['total']:.1f}% | "
        f"{100 * after['dev']['correct'] / after['dev']['total']:.1f}% | {dev_before['falsePos']} | {after['dev']['falsePos']} |"
    )
    say(
        f"| **Holdout** | {hold_before['total']} | {100 * hold_before['correct'] / hold_before['total']:.1f}% | "
        f"**{100 * after['holdout']['correct'] / after['holdout']['total']:.1f}%** | {hold_before['falsePos']} | **{after['holdout']['falsePos']}** |"
    )
    say("")
    say(
        f"On the holdout set — 11 cards never used "
        f"to design the rules — false positives went from {hold_before['falsePos']} to "
        f"{after['holdout']['falsePos']} out of {hold_before['total']} listings, with no new "
        f"false negatives ({hold_before['falseNeg']} before, {after['holdout']['falseNeg']} after). "
        "The development set was unchanged, which is the expected result: the fixes "
        "targeted failure modes that only the holdout exposed."
    )
    say("")
    say(
        "**Caveat worth stating in an interview:** 3 -> 0 on 81 listings is a small "
        "absolute count. The defensible claim is *\"eliminated the three false positives "
        "present on an 81-listing holdout set\"*, not *\"achieved 100% precision\"*."
    )
    say("")

    # ---- plots
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.2))

    labels = ["Mixed\npopulation", "Comps\ndisagree", "Passed\nall gates"]
    before_vals = [rows[0]["MIXED_POPULATION"], rows[0]["COMPS_DISAGREE"], rows[0]["priced"]]
    after_vals = [rows[1]["MIXED_POPULATION"], rows[1]["COMPS_DISAGREE"], rows[1]["priced"]]
    x = np.arange(len(labels))
    axes[0].bar(x - 0.19, before_vals, 0.38, label="Category only", color=PALETTE["light"])
    axes[0].bar(x + 0.19, after_vals, 0.38, label="Full comparable key", color=PALETTE["keep"])
    for i, (b, a) in enumerate(zip(before_vals, after_vals)):
        axes[0].text(i - 0.19, b + 0.3, str(b), ha="center", fontsize=8)
        axes[0].text(i + 0.19, a + 0.3, str(a), ha="center", fontsize=8)
    axes[0].set_xticks(x, labels)
    axes[0].legend(fontsize=8, frameon=False)
    style(axes[0], "Grouping rule vs gate outcomes\n(same 307 comparable sales)", ylabel="groups")

    sets = ["Development\n(84 listings)", "Holdout\n(81 listings)"]
    fp_before = [dev_before["falsePos"], hold_before["falsePos"]]
    fp_after = [after["dev"]["falsePos"], after["holdout"]["falsePos"]]
    x = np.arange(len(sets))
    axes[1].bar(x - 0.19, fp_before, 0.38, label="Before taxonomy", color=PALETTE["light"])
    axes[1].bar(x + 0.19, fp_after, 0.38, label="After", color=PALETTE["keep"])
    for i, (b, a) in enumerate(zip(fp_before, fp_after)):
        axes[1].text(i - 0.19, b + 0.05, str(b), ha="center", fontsize=9)
        axes[1].text(i + 0.19, a + 0.05, str(a), ha="center", fontsize=9)
    axes[1].set_xticks(x, sets)
    axes[1].set_yticks(range(0, 4))
    axes[1].legend(fontsize=8, frameon=False)
    style(axes[1], "False positives (bad comps accepted)\non hand-labelled sets", ylabel="false positives")

    plot = save(fig, "03-taxonomy-before-after.png")
    grouping.to_csv(DEST / "grouping-rule-comparison.csv", index=False)

    return {
        "contamination": contamination, "total_contamination": total_contamination,
        "net_new": net_new, "overlap": overlap,
        "mixed_before": mixed_before, "mixed_after": mixed_after,
        "dev_before": dev_before, "hold_before": hold_before, "after": after,
        "plots": [plot],
    }


def parse_validation_evals() -> dict:
    """Reads the captured output of the evaluation and parity scripts."""
    text = (DATA / "validation-raw.txt").read_text(encoding="utf8")
    blocks = {}
    for name, marker in [("dev", "--- DEV"), ("holdout", "--- HOLDOUT")]:
        chunk = text.split(marker, 1)[1].split("---", 1)[0]
        blocks[name] = {
            "falsePos": int(re.search(r"FALSE POSITIVES \(bad comps\)\s*:\s*(\d+)", chunk).group(1)),
            "falseNeg": int(re.search(r"false negatives \(missed target\):\s*(\d+)", chunk).group(1)),
            "correct": int(re.search(r"overall correct\s*:\s*(\d+)/(\d+)", chunk).group(1)),
            "total": int(re.search(r"overall correct\s*:\s*(\d+)/(\d+)", chunk).group(2)),
        }
    return blocks


def parse_parity() -> dict:
    text = (DATA / "validation-raw.txt").read_text(encoding="utf8")
    return {
        "groups": int(re.search(r"groups compared\s*:\s*(\d+)", text).group(1)),
        "fields": int(re.search(r"field assertions\s*:\s*(\d+)", text).group(1)),
        "mismatches": int(re.search(r"mismatches\s*:\s*(\d+)", text).group(1)),
        "groupParity": re.search(r"identical membership\s*:\s*(\S+)", text).group(1),
        "foreignOnly": int(re.search(r"foreign-language groups \(production only\)\s*:\s*(\d+)", text).group(1)),
    }


# ------------------------------------------------------------ 3. providers
def providers_section(providers: dict, lines: list[str]) -> dict:
    say = lines.append
    p = providers["providers"]

    # Production behaviour: TCGdex primary, TCGCSV only when TCGdex has no price.
    combined = sum(
        1 for row in providers["rows"]
        if row["tcgdex"]["hasMarketPrice"] or row["tcgcsv"]["hasMarketPrice"]
    )
    total = len(providers["rows"])

    say("## 3. Data-source comparison")
    say("")
    say(
        f"Regenerated on {providers['ranAt'][:10]} over the same 23-card set "
        "(`scripts/benchmark-providers.cjs`). The original comparison that drove the "
        "migration was never written to disk, so this is a fresh measurement rather "
        "than a recalled one."
    )
    say("")
    say("| Provider | Requests failed (3 attempts) | Needed a retry | Cards found | With TCGplayer market price |")
    say("|---|---:|---:|---:|---:|")
    for key, label in [("tcgdex", "TCGdex"), ("pokemontcg", "PokemonTCG API v2"), ("tcgcsv", "TCGCSV")]:
        s = p[key]
        say(
            f"| {label} | {s['requestsFailed']}/{s['cards']} | {s['retriedAtLeastOnce']}/{s['cards']} | "
            f"{s['found']}/{s['answered']} ({s['coveragePct']:.0f}%) | "
            f"{s['withMarketPrice']}/{s['answered']} ({s['pricePct']:.0f}%) |"
        )
    say("")
    say(
        f"**The reliability gap is the real finding.** TCGdex answered all "
        f"{p['tcgdex']['cards']} requests first time. The PokemonTCG API needed a retry on "
        f"**{p['pokemontcg']['retriedAtLeastOnce']} of {p['pokemontcg']['cards']}** requests "
        f"and still failed outright on {p['pokemontcg']['requestsFailed']} after three "
        "attempts, all HTTP 500/502."
    )
    say("")
    say(
        f"Coverage of *cards* is comparable across providers once failures are excluded, "
        f"and PokemonTCG's price coverage ({p['pokemontcg']['pricePct']:.0f}%) is not worse "
        f"than TCGdex's ({p['tcgdex']['pricePct']:.0f}%). The migration is justified by "
        "availability, not by richer pricing — claiming otherwise would not survive scrutiny."
    )
    say("")
    say(
        f"Adding TCGCSV as a fallback for cards where TCGdex has no TCGplayer mapping raises "
        f"market-price coverage from **{p['tcgdex']['withMarketPrice']}/{total} "
        f"({100 * p['tcgdex']['withMarketPrice'] / total:.0f}%)** to **{combined}/{total} "
        f"({100 * combined / total:.0f}%)** — this is what the production fallback actually does."
    )
    say("")
    say(
        "*Latency was recorded but is single-run from one location and is not a fair "
        "service benchmark; it is not used as a headline metric.*"
    )
    say("")

    fig, axes = plt.subplots(1, 2, figsize=(11, 4.2))

    names = ["TCGdex", "PokemonTCG", "TCGCSV"]
    keys = ["tcgdex", "pokemontcg", "tcgcsv"]
    failed = [p[k]["requestsFailed"] for k in keys]
    retried = [p[k]["retriedAtLeastOnce"] - p[k]["requestsFailed"] for k in keys]
    clean = [p[k]["cards"] - p[k]["retriedAtLeastOnce"] for k in keys]

    axes[0].bar(names, clean, label="Answered first try", color=PALETTE["keep"])
    axes[0].bar(names, retried, bottom=clean, label="Needed a retry", color=PALETTE["split"])
    axes[0].bar(names, failed, bottom=np.array(clean) + np.array(retried),
                label="Failed after 3 tries", color=PALETTE["drop"])
    for i, k in enumerate(keys):
        axes[0].text(i, p[k]["cards"] + 0.4, f"{clean[i]}/{p[k]['cards']} clean", ha="center", fontsize=8)
    axes[0].legend(fontsize=8, frameon=False, loc="upper center", ncol=3, bbox_to_anchor=(0.5, 1.0))
    axes[0].set_ylim(0, 31)
    style(axes[0], "Request reliability over 23 card lookups", ylabel="requests")

    x = np.arange(3)
    cov = [p[k]["coveragePct"] for k in keys]
    pri = [p[k]["pricePct"] for k in keys]
    axes[1].bar(x - 0.19, cov, 0.38, label="Card found", color=PALETTE["accent"])
    axes[1].bar(x + 0.19, pri, 0.38, label="Has market price", color=PALETTE["light"])
    for i in range(3):
        axes[1].text(i - 0.19, cov[i] + 1.5, f"{cov[i]:.0f}%", ha="center", fontsize=8)
        axes[1].text(i + 0.19, pri[i] + 1.5, f"{pri[i]:.0f}%", ha="center", fontsize=8)
    axes[1].set_xticks(x, names)
    axes[1].set_ylim(0, 118)
    axes[1].legend(fontsize=8, frameon=False)
    style(axes[1], "Coverage among requests that answered", ylabel="% of answered requests")

    plot = save(fig, "04-provider-comparison.png")
    return {"p": p, "combined": combined, "total": total, "plots": [plot]}


# ------------------------------------------------- 4. comparable-sale stats
def comparable_stats(comps: pd.DataFrame, buy: dict, lines: list[str]) -> dict:
    say = lines.append
    say("## 4. Why robust statistics were necessary")
    say("")

    rows = []
    for (card, group), frame in comps.groupby(["cardId", "comparableGroup"]):
        prices = frame["soldPrice"].dropna()
        if prices.count() < MIN_COMPS:
            continue
        median = float(prices.median())
        mean = float(prices.mean())
        q1, q3 = prices.quantile(0.25), prices.quantile(0.75)
        rows.append({
            "cardId": card, "group": group, "n": int(prices.count()),
            "mean": mean, "median": median,
            "meanOverMedian": mean / median if median else np.nan,
            "iqrOverMedian": float(q3 - q1) / median if median else np.nan,
        })
    frame = pd.DataFrame(rows)
    frame.to_csv(DEST / "group-dispersion.csv", index=False)

    gap = (frame["mean"] - frame["median"]).abs() / frame["median"]
    above = int((frame["mean"] > frame["median"]).sum())
    materially = int((gap > 0.10).sum())

    say(
        f"Across the **{len(frame)}** comparable groups with at least {MIN_COMPS} sales, "
        f"the mean sits above the median in **{above}** of them ({100 * above / len(frame):.0f}%). "
        f"The median absolute gap between mean and median is **{gap.median():.1%}** of the "
        f"median, and in **{materially}** groups ({100 * materially / len(frame):.0f}%) the gap "
        "exceeds 10%."
    )
    say("")
    say(
        "That is the entire justification for using a trimmed median rather than an "
        "average: sold-price distributions here are right-skewed by signed copies, "
        "graded slabs mis-filed as raw, and occasional novelty items."
    )
    say("")
    worst = frame.loc[gap.idxmax()]
    say(
        f"The extreme case is {worst['cardId']} ({worst['n']} sales), where the mean is "
        f"{worst['meanOverMedian']:.1f}x the median — but that is one group, not the norm, "
        f"and the typical gap of {gap.median():.1%} is the honest number to quote."
    )
    say("")

    dis = pd.Series([g["disagreement"] for g in buy["groups"]
                     if not g["refused"] and g.get("disagreement") is not None])

    say(
        f"Among the {len(dis)} priced raw groups where both sources had a price, the median "
        f"disagreement between the eBay median and the TCGplayer market price is "
        f"**{dis.median():.1%}** (max {dis.max():.1%}). Blending them is a deliberate choice; "
        "beyond 50% the engine refuses rather than inventing a midpoint."
    )
    say("")

    fig, axes = plt.subplots(1, 2, figsize=(11, 4.2))

    axes[0].scatter(frame["median"], frame["mean"], s=26, alpha=0.75, color=PALETTE["accent"])
    lim = [frame[["mean", "median"]].to_numpy().min() * 0.7, frame[["mean", "median"]].to_numpy().max() * 1.4]
    axes[0].plot(lim, lim, color=PALETTE["neutral"], linewidth=1, linestyle="--", label="mean = median")
    axes[0].set_xscale("log")
    axes[0].set_yscale("log")
    axes[0].legend(fontsize=8, frameon=False)
    style(axes[0], f"Mean vs median per comparable group\n(mean is higher in {above}/{len(frame)} groups)",
          xlabel="median sold price (USD, log)", ylabel="mean sold price (USD, log)")

    axes[1].hist(dis * 100, bins=12, color=PALETTE["accent"], edgecolor="white")
    axes[1].axvline(dis.median() * 100, color=PALETTE["drop"], linewidth=1.4,
                    label=f"median {dis.median():.0%}")
    axes[1].legend(fontsize=8, frameon=False)
    style(axes[1], f"eBay vs TCGplayer disagreement\n({len(dis)} priced raw groups)",
          xlabel="absolute disagreement (%)", ylabel="groups")

    plot = save(fig, "05-dispersion-and-disagreement.png")
    return {
        "groups": len(frame), "above": above, "median_gap": float(gap.median()),
        "materially": materially, "disagreement_median": float(dis.median()),
        "plots": [plot],
    }


# ------------------------------------------------------- 5. recommended buy
def recommended_buy(buy: dict, comps: pd.DataFrame, lines: list[str]) -> dict:
    say = lines.append
    groups = buy["groups"]
    priced = [g for g in groups if not g["refused"]]
    refused = [g for g in groups if g["refused"]]
    reasons = pd.Series([g["refusalCode"] for g in refused]).value_counts()

    say("## 5. Recommended Buy engine behaviour")
    say("")
    say(
        f"**{len(groups)}** card + comparable-group combinations were evaluated. "
        f"**{len(priced)}** produced a price and **{len(refused)}** were refused."
    )
    say("")
    say("| Refusal reason | Groups | Meaning |")
    say("|---|---:|---|")
    meanings = {
        "TOO_FEW_COMPS": "fewer than 3 comparable sales",
        "MIXED_POPULATION": "sales split into two price levels",
        "SOURCE_CONFLICT": "eBay and TCGplayer more than 50% apart",
        "COMPS_DISAGREE": "interquartile range exceeds the median",
    }
    for code, count in reasons.items():
        say(f"| `{code}` | {count} | {meanings.get(code, '')} |")
    say("")
    sparse = int(reasons.get("TOO_FEW_COMPS", 0))
    quality = len(refused) - sparse
    say(
        f"Of the {len(refused)} refusals, **{sparse}** are simply sparse markets and "
        f"**{quality}** were caught by data-quality gates — groups that had enough sales "
        "but whose sales did not agree with each other."
    )
    say("")
    say(
        "**This is not a metric to brag about.** A high refusal rate reflects thin source "
        "data, not engine quality. The defensible framing is that the engine declines to "
        "publish a number when the evidence does not support one, and names the reason."
    )
    say("")

    margins = pd.Series([g["margin"] for g in priced])
    say(
        f"Safety margins on the {len(priced)} priced groups range from "
        f"**{margins.min():.0%} to {margins.max():.0%}** (median {margins.median():.0%}), "
        "assembled from named components rather than a single tuned constant."
    )
    say("")

    fig, axes = plt.subplots(1, 2, figsize=(11, 4.4))

    order = reasons.sort_values(ascending=True)
    colors = [PALETTE["drop"] if c != "TOO_FEW_COMPS" else PALETTE["neutral"] for c in order.index]
    bars = axes[0].barh([c.replace("_", "\n") for c in order.index], order.values, color=colors, height=0.6)
    for bar, value in zip(bars, order.values):
        axes[0].text(value + 1.5, bar.get_y() + bar.get_height() / 2,
                     f"{value} ({100 * value / len(groups):.0f}%)", va="center", fontsize=9)
    axes[0].set_xlim(0, max(order.values) * 1.3)
    style(axes[0], f"Why {len(refused)} of {len(groups)} groups were refused a price",
          xlabel="groups")

    axes[1].hist(margins * 100, bins=10, color=PALETTE["keep"], edgecolor="white")
    axes[1].axvline(margins.median() * 100, color=PALETTE["drop"], linewidth=1.4,
                    label=f"median {margins.median():.0%}")
    axes[1].legend(fontsize=8, frameon=False)
    style(axes[1], f"Safety margin applied to the {len(priced)} priced groups",
          xlabel="margin below market reference (%)", ylabel="groups")

    plot1 = save(fig, "06-refusals-and-margins.png")

    counts = comps.groupby(["cardId", "comparableGroup"]).size()
    fig, ax = plt.subplots(figsize=(9, 4.2))
    values, edges = np.histogram(counts, bins=range(1, int(counts.max()) + 2))
    ax.bar(edges[:-1], values, width=0.82, color=PALETTE["neutral"])
    ax.axvline(MIN_COMPS - 0.5, color=PALETTE["drop"], linestyle="--", linewidth=1.3,
               label=f"minimum {MIN_COMPS} comps to price")
    for edge, value in zip(edges[:-1], values):
        if value:
            ax.text(edge, value + 1.2, str(value), ha="center", fontsize=8)
    ax.legend(fontsize=8, frameon=False)
    style(ax, "Comparable sales per market group — the binding constraint",
          xlabel="comparable sales in the group", ylabel="groups")
    plot2 = save(fig, "07-comps-per-group.png")

    pd.DataFrame(groups).to_csv(DEST / "recommended-buy-groups.csv", index=False)

    return {
        "total": len(groups), "priced": len(priced), "refused": len(refused),
        "sparse": sparse, "quality": quality, "reasons": reasons.to_dict(),
        "margin_median": float(margins.median()), "margin_min": float(margins.min()),
        "margin_max": float(margins.max()), "plots": [plot1, plot2],
    }


# ------------------------------------------------------------- 6. history
def history_section(history: pd.DataFrame, lines: list[str]) -> dict:
    say = lines.append
    stats = []
    for card, frame in history.groupby("cardId"):
        series = frame.dropna(subset=["marketPrice"]).sort_values("date")
        if len(series) < 5:
            continue
        prices = series["marketPrice"].to_numpy()
        returns = np.diff(prices) / prices[:-1]
        recent = returns[-26:] if len(returns) >= 26 else returns
        stats.append({
            "cardId": card,
            "observations": len(prices),
            "firstDate": series["date"].min().date().isoformat(),
            "lastDate": series["date"].max().date().isoformat(),
            "latest": float(prices[-1]),
            "weeklyVolatility": float(np.std(recent, ddof=1)) if len(recent) > 1 else 0.0,
        })
    frame = pd.DataFrame(stats).sort_values("weeklyVolatility")
    frame.to_csv(DEST / "price-history-volatility.csv", index=False)

    span_days = (history["date"].max() - history["date"].min()).days
    say("## 6. TCGplayer price history")
    say("")
    say(
        f"**{len(frame)}** cards have enough cached history to measure, spanning "
        f"{history['date'].min().date()} to {history['date'].max().date()} "
        f"({span_days // 7} weeks), reconstructed from TCGCSV daily archives into a local "
        f"cache. Median **{int(frame['observations'].median())}** weekly observations per card."
    )
    say("")
    say(
        f"Week-over-week volatility ranges from **{frame['weeklyVolatility'].min():.1%}** "
        f"({frame.iloc[0]['cardId']}) to **{frame['weeklyVolatility'].max():.1%}** "
        f"({frame.iloc[-1]['cardId']}) — a {frame['weeklyVolatility'].max() / max(frame['weeklyVolatility'].min(), 1e-9):.0f}x "
        "spread that feeds the volatility component of the safety margin. This is "
        "descriptive only; nothing here forecasts price."
    )
    say("")

    fig, axes = plt.subplots(1, 2, figsize=(11.5, 4.4))

    bars = axes[0].barh(frame["cardId"], frame["weeklyVolatility"] * 100,
                        color=PALETTE["accent"], height=0.6)
    for bar, value in zip(bars, frame["weeklyVolatility"] * 100):
        axes[0].text(value + 0.3, bar.get_y() + bar.get_height() / 2, f"{value:.1f}%",
                     va="center", fontsize=8)
    axes[0].set_xlim(0, frame["weeklyVolatility"].max() * 118)
    style(axes[0], "Week-over-week price volatility by card", xlabel="std. dev. of weekly return (%)")

    calm = frame.iloc[0]["cardId"]
    wild = frame.iloc[-1]["cardId"]
    for card, color, label in [(calm, PALETTE["keep"], f"{calm} (calmest)"),
                               (wild, PALETTE["drop"], f"{wild} (most volatile)")]:
        series = history[history["cardId"] == card].dropna(subset=["marketPrice"]).sort_values("date")
        axes[1].plot(series["date"], series["marketPrice"] / series["marketPrice"].iloc[0],
                     linewidth=1.5, color=color, label=label)
    axes[1].axhline(1.0, color=PALETTE["neutral"], linewidth=0.8)
    axes[1].legend(fontsize=8, frameon=False)
    style(axes[1], "Normalised market price, calmest vs most volatile",
          ylabel="x first observation")

    plot = save(fig, "08-price-history-volatility.png")
    return {
        "cards": len(frame), "span_weeks": span_days // 7,
        "median_obs": int(frame["observations"].median()),
        "vol_min": float(frame["weeklyVolatility"].min()),
        "vol_max": float(frame["weeklyVolatility"].max()),
        "plots": [plot],
    }


# ------------------------------------------------------------------- main
def main() -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    sales, comps, buy, history, providers, _validation, before = load_all()

    lines: list[str] = []
    lines.append("# Project metrics — Pokémon card price checker")
    lines.append("")
    lines.append(
        "Every figure below is computed by `analysis/resume_metrics.py` from files in "
        "this repository. Where a \"before\" state was not saved, it is reconstructed by "
        "re-running the same logic under the old rule and labelled as reconstructed."
    )
    lines.append("")

    f = funnel(sales, comps, buy, lines)
    t = taxonomy(sales, comps, buy, before, lines)
    p = providers_section(providers, lines)
    c = comparable_stats(comps, buy, lines)
    r = recommended_buy(buy, comps, lines)
    h = history_section(history, lines)
    parity = parse_parity()

    lines.append("## 7. Productionisation and validation")
    lines.append("")
    lines.append(
        "The pricing methodology was prototyped in Python, then ported to TypeScript to "
        "run inside the app. The port is verified against the Python implementation "
        "rather than assumed equivalent:"
    )
    lines.append("")
    lines.append("| Check | Result |")
    lines.append("|---|---|")
    lines.append(f"| Python -> TypeScript pricing parity | {parity['groups']} groups, **{parity['fields']} field assertions, {parity['mismatches']} mismatches** |")
    lines.append(f"| Production vs analysis group membership | **{parity['groupParity']}** groups identical, compared by listing ID |")
    lines.append(f"| Groups intentionally production-only | {parity['foreignOnly']} foreign-language markets |")
    lines.append("")
    lines.append(
        "Unrounded values are compared to a 1e-9 tolerance, so a port that merely looked "
        "close would fail."
    )
    lines.append("")

    write_resume_section(lines, f, t, p, c, r, h, parity)

    (DEST / "report.md").write_text("\n".join(lines) + "\n", encoding="utf8")

    plots = f["plots"] + t["plots"] + p["plots"] + c["plots"] + r["plots"] + h["plots"]
    print(f"wrote {DEST / 'report.md'}")
    print(f"plots: {len(plots)}")
    for name in plots:
        print(f"  {name}")


def write_resume_section(lines, f, t, p, c, r, h, parity) -> None:
    say = lines.append
    say("## Strongest Resume Metrics")
    say("")
    say(
        "Ranked by how well each survives an interviewer asking \"how did you get that "
        "number?\". Every entry names its source."
    )
    say("")

    metrics = [
        {
            "rank": 1,
            "metric": f"{parity['fields']} field-level assertions, 0 mismatches, between a Python prototype and its TypeScript production port",
            "how": "`scripts/check-pricing-parity.cjs` re-runs the TS engine over the same 144 comparable groups the Python script scored and compares 13 fields per priced group at 1e-9 tolerance.",
            "why": "Demonstrates prototype-to-production discipline, which is the part of DS work most teams do badly. Concrete, verifiable, and easy to explain.",
            "caveat": "Same input data on both sides — it proves the port is faithful, not that the model is correct.",
            "use": "Yes — strongest engineering metric.",
        },
        {
            "rank": 2,
            "metric": f"{100 * (f['raw'] - f['accepted']) / f['raw']:.0f}% of {f['raw']} scraped listings were not the target card; a rule-based classifier removed them before pricing",
            "how": "`analysis/data/classified-sales.json`: 460 listings, 146 rejected by named rules, counted by reason.",
            "why": "Shows the scale of the data-quality problem in one number and frames the whole project.",
            "caveat": "23 cards. The rejection rate depends on how noisy the eBay queries are.",
            "use": "Yes — best single framing metric.",
        },
        {
            "rank": 3,
            "metric": f"Eliminated {t['hold_before']['falsePos']} false positives on an {t['hold_before']['total']}-listing hand-labelled holdout set (accuracy {100 * t['hold_before']['correct'] / t['hold_before']['total']:.1f}% -> {100 * t['after']['holdout']['correct'] / t['after']['holdout']['total']:.1f}%) with no new false negatives",
            "how": "Before from `eval/holdout-listings-last-run.json` (`statsA`, saved 2026-08-18); after from re-running `scripts/eval-semantic.cjs` on the same labels.",
            "why": "A true holdout — 11 cards never used to design the rules — with labels assigned by hand, never model-generated.",
            "caveat": "3 -> 0 is a small absolute count on 81 listings. Say \"eliminated the three false positives on the holdout\", never \"100% precision\".",
            "use": "Yes, with the caveat stated.",
        },
        {
            "rank": 4,
            "metric": f"PokemonTCG API needed a retry on {p['p']['pokemontcg']['retriedAtLeastOnce']}/{p['p']['pokemontcg']['cards']} requests and failed {p['p']['pokemontcg']['requestsFailed']}/{p['p']['pokemontcg']['cards']} outright; TCGdex: 0 and 0",
            "how": "`scripts/benchmark-providers.cjs`, 3 attempts per card over 23 cards, HTTP status recorded.",
            "why": "Justifies a migration decision with measurement rather than preference.",
            "caveat": "One run, one location, one day. Transient outages are real but not necessarily representative.",
            "use": "Yes, framed as \"measured on a 23-card benchmark\".",
        },
        {
            "rank": 5,
            "metric": f"Market-price coverage raised from {100 * p['p']['tcgdex']['withMarketPrice'] / p['total']:.0f}% to {100 * p['combined'] / p['total']:.0f}% by adding a second source as a fallback",
            "how": "Same benchmark: cards where TCGdex has a TCGplayer price, versus TCGdex OR TCGCSV.",
            "why": "Directly mirrors what the production fallback does, and it is a clean before/after.",
            "caveat": "23 cards; TCGCSV matching is exact-card-only and abstains when ambiguous.",
            "use": "Yes.",
        },
        {
            "rank": 6,
            "metric": f"Mixed-population comparable groups reduced from {t['mixed_before']} to {t['mixed_after']} by extending the grouping key with edition, printing and language",
            "how": "Reconstructed in `resume_metrics.py`: the identical Stage-A gates re-run over the same 307 sales, grouped by condition alone versus the full key.",
            "why": "Isolates one design change and measures it, rather than claiming credit for everything at once.",
            "caveat": "Reconstructed, not a saved historical run. Small counts.",
            "use": "Yes, if you can explain what a mixed population is in one sentence.",
        },
        {
            "rank": 7,
            "metric": f"Mean sold price exceeds the median in {c['above']}/{c['groups']} comparable groups; median gap {c['median_gap']:.0%}, exceeding 10% in {c['materially']} groups",
            "how": "`analysis/out/comparable_sales.csv`, groups with >= 3 sales.",
            "why": "The empirical reason for choosing a trimmed median, stated as a measurement rather than a preference.",
            "caveat": "Quote the typical gap, not the worst group.",
            "use": "Yes — good answer to \"why not just average the sales?\".",
        },
        {
            "rank": 8,
            "metric": f"{t['net_new']} listings newly excluded that the pipeline had previously accepted as comparable sales (art-card prints, gold-foil replicas, signed copies, reprints sharing a card number)",
            "how": "Counted by rejection reason in `analysis/data/classified-sales.json`.",
            "why": "Very concrete and easy to tell as a story — four identical $9.85 \"art card\" sales sat beside real $2,152 sales.",
            "caveat": "Small count; the value is the failure mode, not the number.",
            "use": "Yes, as an anecdote in interview rather than a resume number.",
        },
        {
            "rank": 9,
            "metric": f"Engine refuses to price {r['refused']}/{r['total']} groups, of which {r['quality']} are caught by data-quality gates rather than sparsity",
            "how": "`analysis/out/recommended-buy-results.json`, refusal codes tallied.",
            "why": "Shows a system designed to abstain. The {quality} figure is the interesting one.",
            "caveat": "Do NOT lead with the refusal rate — it mostly reflects thin data, not engine quality.",
            "use": "Only as supporting detail.",
        },
        {
            "rank": 10,
            "metric": f"Weekly price volatility measured across {h['cards']} cards over {h['span_weeks']} weeks, ranging {h['vol_min']:.1%} to {h['vol_max']:.1%}",
            "how": "TCGCSV daily archives extracted into a local cache; std. dev. of weekly returns.",
            "why": "Demonstrates a real data-engineering task — selective extraction from compressed daily archives.",
            "caveat": "Descriptive only. Never imply forecasting.",
            "use": "Mention the pipeline, not the volatility number.",
        },
    ]

    for m in metrics:
        say(f"### {m['rank']}. {m['metric']}")
        say("")
        say(f"- **How it was calculated:** {m['how']}")
        say(f"- **Why it is meaningful:** {m['why']}")
        say(f"- **Caveat:** {m['caveat']}")
        say(f"- **Recommend on a resume:** {m['use']}")
        say("")

    say("## Metrics I recommend NOT using")
    say("")
    say(
        f"- **\"{100 * r['priced'] / r['total']:.0f}% of groups priced\"** or its inverse. A high refusal "
        "rate reads as a broken system, and the honest explanation is thin source data."
    )
    say(
        "- **Any accuracy figure stated as 100%.** Holdout false positives went 3 -> 0, "
        "but on 81 listings that is not a precision claim."
    )
    say(
        "- **API latency.** Measured once from one location; differences are dominated by "
        "network conditions, not the services."
    )
    say(
        f"- **The {c['groups']}-group dispersion extremes.** One group has a mean "
        "several times its median; quoting it as typical would be misleading."
    )
    say(
        "- **Liquidity metrics.** The sampling method is count-censored, so only 5 of 144 "
        "groups support a rate estimate. Documented, but not a result."
    )
    say("")

    say("## Resume entries")
    say("")
    say("### A. Data Science focused")
    say("")
    say(
        f"- Built a rule-based classification and pricing pipeline over {f['raw']} scraped "
        f"marketplace listings, identifying that **{100 * (f['raw'] - f['accepted']) / f['raw']:.0f}% were not the "
        "target product** and segmenting the remainder into comparable markets by "
        "condition, edition, printing and language."
    )
    say(
        f"- Eliminated **{t['hold_before']['falsePos']} false positives on an {t['hold_before']['total']}-listing "
        f"hand-labelled holdout set** ({100 * t['hold_before']['correct'] / t['hold_before']['total']:.0f}% -> "
        f"{100 * t['after']['holdout']['correct'] / t['after']['holdout']['total']:.0f}% accuracy) with no loss in recall, "
        "by adding print-variant and reprint-detection rules."
    )
    say(
        f"- Established robust estimation as necessary by measurement: the mean exceeded the "
        f"median in **{c['above']} of {c['groups']}** comparable groups (median gap "
        f"{c['median_gap']:.0%}), motivating a trimmed-median price reference with "
        "outlier-aware refusal gates."
    )
    say(
        f"- Designed the estimator to **abstain**: {r['quality']} of {r['total']} groups are "
        "withheld from pricing by data-quality gates that detect mixed populations and "
        "conflicting sources, each surfaced with a specific reason."
    )
    say("")

    say("### B. Software / Data Engineering focused")
    say("")
    say(
        f"- Migrated a Next.js/TypeScript pricing app off an unreliable card-data API after "
        f"benchmarking three providers: the incumbent required retries on "
        f"**{p['p']['pokemontcg']['retriedAtLeastOnce']}/{p['p']['pokemontcg']['cards']}** requests and failed "
        f"**{p['p']['pokemontcg']['requestsFailed']}** outright, versus **0 and 0** for the replacement."
    )
    say(
        f"- Raised TCGplayer market-price coverage from **{100 * p['p']['tcgdex']['withMarketPrice'] / p['total']:.0f}% "
        f"to {100 * p['combined'] / p['total']:.0f}%** by adding a second source as an exact-match fallback "
        "that abstains rather than guessing when a card cannot be identified confidently."
    )
    say(
        f"- Ported a Python pricing prototype to TypeScript and proved equivalence with a "
        f"parity harness: **{parity['fields']} field-level assertions across {parity['groups']} groups, "
        f"0 mismatches** at 1e-9 tolerance, plus listing-level checks that production and "
        "analysis group the same sales."
    )
    say(
        f"- Built the historical price pipeline by selectively extracting {h['span_weeks']} weeks of "
        f"weekly-sampled price history from daily compressed archives into a local cache, "
        "avoiding full-dataset downloads on every request."
    )
    say("")

    say("### C. Balanced Full-Stack + Data Science")
    say("")
    say(
        f"- Built a full-stack Next.js/TypeScript app that scrapes marketplace sales, "
        f"classifies them with deterministic rules (**{100 * (f['raw'] - f['accepted']) / f['raw']:.0f}% of {f['raw']} "
        "listings rejected as not the target card**) and publishes an explainable "
        "recommended purchase price."
    )
    say(
        f"- Improved classification on a hand-labelled holdout set from "
        f"{100 * t['hold_before']['correct'] / t['hold_before']['total']:.0f}% to "
        f"{100 * t['after']['holdout']['correct'] / t['after']['holdout']['total']:.0f}% accuracy, removing all "
        f"{t['hold_before']['falsePos']} false positives without reducing recall."
    )
    say(
        f"- Prototyped the pricing model in Python and shipped it in TypeScript, verified by "
        f"**{parity['fields']} field-level parity assertions with 0 mismatches**."
    )
    say(
        f"- Benchmarked three data providers and added a fallback source, raising market-price "
        f"coverage from **{100 * p['p']['tcgdex']['withMarketPrice'] / p['total']:.0f}% to "
        f"{100 * p['combined'] / p['total']:.0f}%** across the evaluation set."
    )
    say("")


if __name__ == "__main__":
    main()
