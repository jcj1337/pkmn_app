"""
Exploratory analysis toward a Recommended Buy Price.

Two deliberately separate stages:

  Stage A  Market Reference     — where comparable cards are currently trading
  Stage B  Recommended Buy      — reference minus an evidence-based margin

Everything here is descriptive statistics. No model is trained, nothing is
predicted, and every number a user would see traces back to a count, a median
or a percentage change.

Stage A is gated. A group of comps that disagrees with itself does not get a
price at all — it gets a refusal with a named reason. That matters more than
the formula: the dataset contains groups whose sales range from $9.85 to
$2,152 for the same nominal card, and averaging those produces a confident
number that is simply wrong.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

OUT = Path(__file__).parent / "out"

# --- policy constants: chosen to be defensible, not tuned to a target -----
MIN_COMPS = 3           # below this we refuse to publish a price
MAX_SPREAD = 1.00       # IQR/median above this means the comps disagree
MAX_SPLIT_RATIO = 3.0   # upper-half median / lower-half median => two products
MAX_DISAGREEMENT = 0.50 # beyond this the two sources are not describing one card
BLEND_K = 5.0           # eBay earns half the weight at 5 comps
RECENT_DAYS = 30        # "recent" window for liquidity and recency
HALF_LIFE_DAYS = 21.0   # recency weighting half-life
BASE_MARGIN = 0.05      # floor: fee/shipping friction on a resale
MAX_MARGIN = 0.25       # cap: never recommend below 75% of reference


def load() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    sales = pd.read_csv(OUT / "comparable_sales.csv", parse_dates=["soldDate"])
    current = pd.read_csv(OUT / "tcgplayer_current.csv")
    history = pd.read_csv(OUT / "tcgplayer_history.csv", parse_dates=["date"])
    return sales, current, history


# ------------------------------------------------------------ descriptive
def describe_group(prices: pd.Series) -> dict:
    q1, q3 = prices.quantile(0.25), prices.quantile(0.75)
    return {
        "count": int(prices.count()),
        "mean": float(prices.mean()),
        "median": float(prices.median()),
        "min": float(prices.min()),
        "max": float(prices.max()),
        "std": float(prices.std(ddof=1)) if prices.count() > 1 else 0.0,
        "q1": float(q1),
        "q3": float(q3),
        "iqr": float(q3 - q1),
    }


def iqr_bounds(prices: pd.Series) -> tuple[float, float]:
    q1, q3 = prices.quantile(0.25), prices.quantile(0.75)
    iqr = q3 - q1
    return float(q1 - 1.5 * iqr), float(q3 + 1.5 * iqr)


def mad_bounds(prices: pd.Series, threshold: float = 3.5) -> tuple[float, float]:
    """Median Absolute Deviation bounds, scaled to compare against sigma.

    Kept as a second opinion only. MAD collapses to zero whenever a majority of
    sales share an identical price — which happens in this dataset — so it
    cannot be the primary rule.
    """
    median = prices.median()
    mad = (prices - median).abs().median()
    if mad == 0:
        return iqr_bounds(prices)
    scaled = 1.4826 * mad
    return float(median - threshold * scaled), float(median + threshold * scaled)


def split_ratio(prices: pd.Series) -> float | None:
    """Upper-half median divided by lower-half median.

    A single population of comps for one card sits near 1.0-2.0. A large value
    means the group holds two different things — 1st Edition next to Unlimited,
    Holo next to Reverse Holo, or a real sale next to a bad scrape.

    At n=3 each half is a single sale, so this reduces to max/min. That is
    intentionally strict: three comps spanning 3x tell you nothing usable.
    """
    ordered = prices.sort_values().to_numpy()
    if len(ordered) < MIN_COMPS:
        return None
    half = max(1, len(ordered) // 2)
    lower = float(np.median(ordered[:half]))
    upper = float(np.median(ordered[-half:]))
    return upper / lower if lower > 0 else None


def repeated_prices(prices: pd.Series) -> tuple[float, int] | None:
    """Largest cluster of byte-identical prices — a bad-scrape fingerprint."""
    counts = prices.value_counts()
    if counts.empty or counts.iloc[0] < 3:
        return None
    return float(counts.index[0]), int(counts.iloc[0])


def recency_weighted_median(frame: pd.DataFrame, asof: pd.Timestamp) -> float | None:
    """Weighted median with exponential decay — recent sales count for more.

    A weighted *median* rather than a weighted mean, so one stale extreme sale
    cannot drag the answer.
    """
    data = frame.dropna(subset=["soldPrice", "soldDate"]).sort_values("soldPrice")
    if data.empty:
        return None

    age_days = (asof - data["soldDate"]).dt.total_seconds() / 86400.0
    weights = np.power(0.5, age_days / HALF_LIFE_DAYS)
    if weights.sum() <= 0:
        return None

    cumulative = weights.cumsum() / weights.sum()
    idx = min(int(np.searchsorted(cumulative.to_numpy(), 0.5)), len(data) - 1)
    return float(data["soldPrice"].iloc[idx])


# -------------------------------------------------------- tcgplayer trend
def history_stats(history: pd.DataFrame, card_id: str) -> dict | None:
    series = (
        history[history["cardId"] == card_id]
        .dropna(subset=["marketPrice"])
        .sort_values("date")
    )
    if len(series) < 5:
        return None

    prices = series["marketPrice"].to_numpy()
    dates = series["date"]
    latest = float(prices[-1])

    def change_since(days: int) -> float | None:
        cutoff = dates.iloc[-1] - pd.Timedelta(days=days)
        window = series[series["date"] <= cutoff]
        if window.empty:
            return None
        past = float(window["marketPrice"].iloc[-1])
        return (latest - past) / past if past else None

    returns = np.diff(prices) / prices[:-1]
    recent_returns = returns[-26:] if len(returns) >= 26 else returns
    # Samples are weekly, so this is week-over-week dispersion, not annualised.
    volatility = float(np.std(recent_returns, ddof=1)) if len(recent_returns) > 1 else 0.0

    recent = prices[-26:] if len(prices) >= 26 else prices
    recent_median = float(np.median(recent))

    return {
        "latest": latest,
        "latestDate": dates.iloc[-1].date().isoformat(),
        "change30d": change_since(30),
        "change90d": change_since(90),
        "weeklyVolatility": volatility,
        "recentMedian": recent_median,
        "distanceFromRecentMedian": (latest - recent_median) / recent_median if recent_median else None,
        "observations": len(prices),
    }


def liquidity_stats(frame: pd.DataFrame, asof: pd.Timestamp) -> dict:
    dates = frame["soldDate"].dropna()
    recent = frame[frame["soldDate"] >= asof - pd.Timedelta(days=RECENT_DAYS)]
    return {
        "comps": int(len(frame)),
        "compsRecent": int(len(recent)),
        "daysSinceLastSale": int((asof - dates.max()).days) if not dates.empty else None,
        "spanDays": int((dates.max() - dates.min()).days) if len(dates) > 1 else 0,
    }


# ------------------------------------------------- stage A and stage B
def market_reference(
    ebay_center: float | None,
    n_comps: int,
    tcg_price: float | None,
    is_raw: bool,
) -> tuple[float | None, str, float | None]:
    """Stage A. Returns (reference, explanation, ebay_weight).

    TCGplayer's market price is an *ungraded* price, so it is a comparable only
    for raw groups. Graded groups are priced from eBay alone.
    """
    if not is_raw:
        if ebay_center is None:
            return None, "no graded comps", None
        return ebay_center, "eBay graded comps only (TCGplayer prices ungraded cards)", 1.0

    if ebay_center is None and tcg_price is None:
        return None, "no eBay comps and no TCGplayer price", None
    if ebay_center is None:
        return tcg_price, "TCGplayer only (no usable eBay comps)", 0.0
    if tcg_price is None:
        return ebay_center, "eBay only (no TCGplayer market price)", 1.0

    weight = n_comps / (n_comps + BLEND_K)
    return (
        weight * ebay_center + (1 - weight) * tcg_price,
        f"blend of eBay ({weight:.0%}) and TCGplayer ({1 - weight:.0%})",
        weight,
    )


def safety_margin(
    dispersion: float | None,
    disagreement: float | None,
    n_comps: int,
    days_since_last: int | None,
    volatility: float | None,
) -> tuple[float, list[str]]:
    """Stage B. Each component is a separate, nameable reason."""
    parts = [f"base {BASE_MARGIN:.0%} for resale friction"]
    margin = BASE_MARGIN

    if dispersion is not None and dispersion > 0:
        # Half the robust spread: wide comps mean a fuzzier true price.
        add = min(0.5 * dispersion, 0.10)
        margin += add
        parts.append(f"+{add:.1%} for comp spread (robust CV {dispersion:.0%})")

    if disagreement is not None and disagreement > 0.05:
        add = min(0.5 * (disagreement - 0.05), 0.06)
        margin += add
        parts.append(f"+{add:.1%} for TCGplayer/eBay disagreement ({disagreement:.0%})")

    if n_comps < 10:
        add = 0.01 * (10 - n_comps) / 2
        margin += add
        parts.append(f"+{add:.1%} for thin evidence ({n_comps} comps)")

    if days_since_last is not None and days_since_last > RECENT_DAYS:
        add = min(0.02 * (days_since_last - RECENT_DAYS) / 30, 0.04)
        margin += add
        parts.append(f"+{add:.1%} for stale comps (last sale {days_since_last}d ago)")

    if volatility is not None and volatility > 0.03:
        add = min((volatility - 0.03) * 2, 0.05)
        margin += add
        parts.append(f"+{add:.1%} for price volatility ({volatility:.1%}/wk)")

    if margin > MAX_MARGIN:
        parts.append(f"capped at {MAX_MARGIN:.0%}")
        margin = MAX_MARGIN

    return margin, parts


def round_money(value: float) -> float:
    """Round to a precision the evidence actually supports."""
    if value >= 500:
        return float(round(value / 10) * 10)
    if value >= 100:
        return float(round(value / 5) * 5)
    if value >= 20:
        return float(round(value))
    return float(round(value, 1))


def deal_rating(asking: float, recommended: float, reference: float) -> str:
    if asking <= recommended * 0.95:
        return "GREAT BUY"
    if asking <= recommended:
        return "GOOD BUY"
    if asking <= reference:
        return "FAIR"
    return "ABOVE MARKET"


# ------------------------------------------------------------ evaluation
def evaluate(card_id: str, group: str, sales: pd.DataFrame, current: pd.DataFrame,
             history: pd.DataFrame, asof: pd.Timestamp) -> dict:
    frame = sales[(sales["cardId"] == card_id) & (sales["comparableGroup"] == group)]
    meta = current[current["cardId"] == card_id]

    result = {
        "cardId": card_id,
        "card": f"{frame['cardName'].iloc[0]} {frame['cardNumber'].iloc[0]}" if not frame.empty else card_id,
        "set": frame["setName"].iloc[0] if not frame.empty else "",
        "group": group,
        "refused": False,
        "refusalCode": None,
    }

    prices = frame["soldPrice"].dropna()
    n = int(prices.count())
    result["stats"] = describe_group(prices) if n else None

    tcg_price = None
    if not meta.empty and pd.notna(meta["currentMarketPrice"].iloc[0]):
        tcg_price = float(meta["currentMarketPrice"].iloc[0])
    result["tcgPrice"] = tcg_price

    result["history"] = history_stats(history, card_id)
    result["liquidity"] = liquidity_stats(frame, asof) if n else None

    # ---- Stage A gate 1: is there enough evidence at all?
    if n < MIN_COMPS:
        result["refused"] = True
        result["refusalCode"] = "TOO_FEW_COMPS"
        result["refusalReason"] = f"only {n} comparable sale(s) in {group}; minimum is {MIN_COMPS}"
        return result

    stats = result["stats"]
    spread = stats["iqr"] / stats["median"] if stats["median"] else None
    ratio = split_ratio(prices)
    result["spread"] = spread
    result["splitRatio"] = ratio
    result["duplicates"] = repeated_prices(prices)

    # ---- Stage A gate 2: do the comps look like two different products?
    if ratio is not None and ratio > MAX_SPLIT_RATIO:
        result["refused"] = True
        result["refusalCode"] = "MIXED_POPULATION"
        result["refusalReason"] = (
            f"comps split into two price levels ({ratio:.1f}x apart); "
            "the group is mixing different printings or a bad comp"
        )
        result["examples"] = (
            frame.nsmallest(2, "soldPrice")[["title", "soldPrice"]].to_dict("records")
            + frame.nlargest(2, "soldPrice")[["title", "soldPrice"]].to_dict("records")
        )
        return result

    # ---- Stage A gate 3: do the comps simply disagree too much?
    if spread is not None and spread > MAX_SPREAD:
        result["refused"] = True
        result["refusalCode"] = "COMPS_DISAGREE"
        result["refusalReason"] = f"interquartile range is {spread:.0%} of the median; comps do not agree"
        return result

    lo_iqr, hi_iqr = iqr_bounds(prices)
    lo_mad, hi_mad = mad_bounds(prices)
    suspicious = frame[(frame["soldPrice"] < lo_iqr) | (frame["soldPrice"] > hi_iqr)]
    result["outliers"] = {
        "iqrBounds": (lo_iqr, hi_iqr),
        "madBounds": (lo_mad, hi_mad),
        "suspicious": suspicious[["title", "soldPrice"]].to_dict("records"),
        "madOnlyCount": int(((prices < lo_mad) | (prices > hi_mad)).sum() - len(suspicious)),
    }

    median_all = float(prices.median())
    kept = prices[(prices >= lo_iqr) & (prices <= hi_iqr)]
    median_trimmed = float(kept.median()) if kept.count() else median_all
    result["medianAll"] = median_all
    result["medianTrimmed"] = median_trimmed
    result["recencyWeighted"] = recency_weighted_median(frame, asof)

    recent = frame[frame["soldDate"] >= asof - pd.Timedelta(days=RECENT_DAYS)]["soldPrice"].dropna()
    result["medianRecent"] = float(recent.median()) if recent.count() else None

    # Robust dispersion: MAD relative to the median, i.e. a robust CV.
    mad = float((prices - prices.median()).abs().median())
    dispersion = (1.4826 * mad / median_trimmed) if median_trimmed else None
    result["dispersion"] = dispersion

    is_raw = bool(frame["isRaw"].iloc[0])

    disagreement = None
    if tcg_price and median_trimmed and is_raw:
        disagreement = abs(tcg_price - median_trimmed) / ((tcg_price + median_trimmed) / 2)
    result["disagreement"] = disagreement

    # ---- Stage A gate 4: do the two sources even describe the same card?
    # Blending here would invent a price that neither source supports.
    if disagreement is not None and disagreement > MAX_DISAGREEMENT:
        result["refused"] = True
        result["refusalCode"] = "SOURCE_CONFLICT"
        result["refusalReason"] = (
            f"TCGplayer says ${tcg_price:,.2f} and the eBay median says "
            f"${median_trimmed:,.2f} ({disagreement:.0%} apart); blending them would "
            "invent a price neither source supports"
        )
        return result

    reference, blend_note, weight = market_reference(median_trimmed, n, tcg_price, is_raw)
    result["reference"] = reference
    result["blendNote"] = blend_note
    result["ebayWeight"] = weight

    margin, parts = safety_margin(
        dispersion,
        disagreement,
        n,
        result["liquidity"]["daysSinceLastSale"],
        result["history"]["weeklyVolatility"] if result["history"] else None,
    )
    result["margin"] = margin
    result["marginParts"] = parts
    result["referenceRounded"] = round_money(reference) if reference else None
    result["recommendedBuy"] = round_money(reference * (1 - margin)) if reference else None
    return result


def render(result: dict) -> str:
    lines = ["-" * 70]
    lines.append(f"Card      : {result['card']}  ({result['set']})")
    lines.append(f"Category  : {result['group']}")

    stats = result["stats"]
    if stats:
        lines.append(
            f"Comps     : n={stats['count']}  median=${stats['median']:,.2f}  "
            f"mean=${stats['mean']:,.2f}  std=${stats['std']:,.2f}"
        )
        lines.append(
            f"            min=${stats['min']:,.2f}  Q1=${stats['q1']:,.2f}  "
            f"Q3=${stats['q3']:,.2f}  max=${stats['max']:,.2f}  IQR=${stats['iqr']:,.2f}"
        )
    else:
        lines.append("Comps     : none")

    lines.append(f"TCGplayer : {'$%.2f' % result['tcgPrice'] if result['tcgPrice'] else 'n/a'}")

    hist = result["history"]
    if hist:
        c30 = f"{hist['change30d']:+.1%}" if hist["change30d"] is not None else "n/a"
        c90 = f"{hist['change90d']:+.1%}" if hist["change90d"] is not None else "n/a"
        lines.append(
            f"Trend     : 30d {c30}   90d {c90}   volatility {hist['weeklyVolatility']:.1%}/wk"
            f"   vs 6mo median {hist['distanceFromRecentMedian']:+.1%}"
        )

    if result["refused"]:
        lines.append("")
        lines.append(f"Recommended Buy : INSUFFICIENT DATA  [{result['refusalCode']}]")
        lines.append(f"  {result['refusalReason']}")
        for row in result.get("examples", []):
            lines.append(f"    ${row['soldPrice']:>9,.2f}  {row['title'][:56]}")
        if result.get("duplicates"):
            price, count = result["duplicates"]
            lines.append(f"    note: {count} sales at an identical ${price:,.2f}")
        return "\n".join(lines)

    liq = result["liquidity"]
    lines.append(
        f"Liquidity : {liq['comps']} comps, {liq['compsRecent']} in last {RECENT_DAYS}d, "
        f"last sale {liq['daysSinceLastSale']}d ago, span {liq['spanDays']}d"
    )
    if result["disagreement"] is not None:
        lines.append(f"Disagree  : {result['disagreement']:.1%} between TCGplayer and eBay")
    recent = f"${result['medianRecent']:,.2f}" if result["medianRecent"] else "n/a"
    lines.append(
        f"Centre    : all ${result['medianAll']:,.2f} | trimmed ${result['medianTrimmed']:,.2f} "
        f"| last {RECENT_DAYS}d {recent} | decay-weighted ${result['recencyWeighted']:,.2f}"
    )

    lines.append("")
    lines.append(f"Market Reference : ${result['referenceRounded']:,.2f}   ({result['blendNote']})")
    lines.append(f"Recommended Buy  : <= ${result['recommendedBuy']:,.2f}   (margin {result['margin']:.1%})")
    lines.append("")
    lines.append("Why:")
    for part in result["marginParts"]:
        lines.append(f"  - {part}")

    suspicious = result["outliers"]["suspicious"]
    if suspicious:
        lines.append(f"  - {len(suspicious)} sale(s) flagged as suspicious and excluded from the centre:")
        for row in suspicious[:3]:
            lines.append(f"      ${row['soldPrice']:,.2f}  {row['title'][:56]}")
    extra = result["outliers"]["madOnlyCount"]
    if extra > 0:
        lines.append(f"  - MAD would flag {extra} more; kept, because IQR is the gentler ruler")

    ref, rec = result["reference"], result["recommendedBuy"]
    lines.append("")
    lines.append("Deal rating at sample asking prices:")
    for asking in [rec * 0.9, rec * 0.98, (rec + ref) / 2, ref * 1.1]:
        lines.append(f"  ${asking:>9,.2f}  ->  {deal_rating(asking, rec, ref)}")

    return "\n".join(lines)


# ----------------------------------------------------------------- plots
def make_plots(sales: pd.DataFrame, history: pd.DataFrame, targets: list[tuple[str, str]]) -> None:
    fig, axes = plt.subplots(2, 2, figsize=(13, 8))
    for ax, (card_id, group) in zip(axes.flat, targets):
        frame = sales[(sales["cardId"] == card_id) & (sales["comparableGroup"] == group)]
        prices = frame["soldPrice"].dropna()
        if prices.empty:
            ax.set_visible(False)
            continue
        ax.hist(prices, bins=min(12, max(3, len(prices))), color="#94a3b8", edgecolor="white")
        ax.axvline(prices.median(), color="#dc2626", label=f"median ${prices.median():,.0f}")
        ax.axvline(prices.mean(), color="#2563eb", linestyle="--", label=f"mean ${prices.mean():,.0f}")
        ax.set_title(f"{frame['cardName'].iloc[0]} - {group} (n={len(prices)})", fontsize=10)
        ax.legend(fontsize=8)
    fig.suptitle("eBay sold-price distributions: mean vs median")
    fig.tight_layout()
    fig.savefig(OUT / "distributions.png", dpi=110)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(11, 4.5))
    for card_id in history["cardId"].unique()[:6]:
        series = history[history["cardId"] == card_id].dropna(subset=["marketPrice"])
        if series.empty:
            continue
        base = series["marketPrice"].iloc[0]
        ax.plot(series["date"], series["marketPrice"] / base, label=card_id, linewidth=1.4)
    ax.axhline(1.0, color="#94a3b8", linewidth=0.8)
    ax.set_title("TCGplayer market price, normalised to first cached observation")
    ax.set_ylabel("x first value")
    ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(OUT / "tcgplayer_trends.png", dpi=110)
    plt.close(fig)


# ------------------------------------------------------------------ main
def main() -> None:
    sales, current, history = load()
    asof = sales["soldDate"].max()

    print("=" * 70)
    print(f"RECOMMENDED BUY PRICE - EXPLORATORY ANALYSIS (as of {asof.date()})")
    print("=" * 70)

    results = []
    for (card_id, group), _ in sales.groupby(["cardId", "comparableGroup"]):
        results.append(evaluate(card_id, group, sales, current, history, asof))
    priced = [r for r in results if not r["refused"]]
    refused = [r for r in results if r["refused"]]

    # ---- mean vs median
    rows = []
    for r in results:
        s = r["stats"]
        if not s or s["count"] < MIN_COMPS:
            continue
        rows.append({
            "cardId": r["cardId"], "group": r["group"], "n": s["count"],
            "mean": s["mean"], "median": s["median"],
            "skew": (s["mean"] - s["median"]) / s["median"] if s["median"] else np.nan,
            "iqrOverMedian": s["iqr"] / s["median"] if s["median"] else np.nan,
            "splitRatio": r.get("splitRatio"),
            "priced": not r["refused"],
        })
    summary = pd.DataFrame(rows).sort_values("n", ascending=False)
    summary.to_csv(OUT / "group_summary.csv", index=False)

    print("\n--- 1. MEAN VS MEDIAN " + "-" * 47)
    print(f"groups with >= {MIN_COMPS} comps      : {len(summary)}")
    print(f"mean exceeds median in      : {(summary['skew'] > 0).sum()} / {len(summary)} groups")
    print(f"median |mean-median|/median : {summary['skew'].abs().median():.1%}")
    print(f"90th percentile of that gap : {summary['skew'].abs().quantile(0.9):.1%}")
    print("Conclusion: sold prices are right-skewed. The median is the centre; the")
    print("mean is reported only as a skew diagnostic.")

    print("\n--- 2. EVIDENCE BY GROUP " + "-" * 44)
    print(summary.head(12).to_string(index=False, float_format=lambda v: f"{v:,.2f}"))

    # ---- recency
    print("\n--- 3. RECENCY " + "-" * 54)
    rec = pd.DataFrame([
        {"median": r["medianTrimmed"], "recent": r["medianRecent"], "decay": r["recencyWeighted"]}
        for r in priced if r["medianRecent"]
    ])
    print(f"groups compared          : {len(rec)}")
    print(f"|recent - median|/median : {((rec['recent'] - rec['median']).abs() / rec['median']).median():.1%} (median)")
    print(f"|decay  - median|/median : {((rec['decay'] - rec['median']).abs() / rec['median']).median():.1%} (median)")
    span = (sales["soldDate"].max() - sales["soldDate"].min()).days
    print(f"LIMITATION: the eBay data spans only {span} days, so recency weighting")
    print("cannot yet be validated. It is implemented but has near-zero effect here.")

    # ---- source disagreement
    print("\n--- 4. SOURCE DISAGREEMENT " + "-" * 42)
    dis = pd.Series([r["disagreement"] for r in priced if r["disagreement"] is not None])
    print(f"raw groups with both sources : {len(dis)}")
    print(f"median disagreement          : {dis.median():.1%}")
    print(f"max disagreement             : {dis.max():.1%}")
    print(f"groups over 25% apart        : {(dis > 0.25).sum()}")
    print("TCGplayer is not ground truth: it is a different marketplace with")
    print("different fees, so a gap is information, not an error to average away.")

    # ---- tcgplayer trend
    print("\n--- 5. TCGPLAYER TREND AND VOLATILITY " + "-" * 31)
    hist_rows = []
    for card_id in history["cardId"].unique():
        h = history_stats(history, card_id)
        if h:
            hist_rows.append({"cardId": card_id, **h})
    hframe = pd.DataFrame(hist_rows)
    if not hframe.empty:
        print(hframe[["cardId", "latest", "change30d", "change90d",
                      "weeklyVolatility", "distanceFromRecentMedian", "observations"]]
              .to_string(index=False, float_format=lambda v: f"{v:,.3f}"))
        print(f"\ncards with usable history : {len(hframe)} / {current.shape[0]}")

    # ---- internal consistency
    # There is no ground truth to score against, but the answers must at least
    # obey the orderings the hobby guarantees: a graded copy is worth more than
    # a raw one, PSA 10 more than PSA 9, and a known-NM card more than one whose
    # condition nobody stated. Violations would mean the comps are still dirty.
    print("\n--- 6. INTERNAL CONSISTENCY " + "-" * 41)
    # Compare only within one card AND one printing, so an ordering violation
    # cannot be an artefact of comparing a holo against a reverse holo.
    by_card: dict[str, dict[str, float]] = {}
    for r in priced:
        category, edition, printing, language = r["group"].split("|")
        key = f"{r['cardId']} {edition}/{printing}/{language}"
        by_card.setdefault(key, {})[category] = r["reference"]

    checks = [
        ("PSA_10 > PSA_9", "PSA_10", "PSA_9"),
        ("PSA_10 > RAW_NM", "PSA_10", "RAW_NM"),
        ("RAW_NM >= RAW_UNKNOWN", "RAW_NM", "RAW_UNKNOWN"),
    ]
    violations = []
    for label, high, low in checks:
        pairs = [(c, g[high], g[low]) for c, g in by_card.items() if high in g and low in g]
        bad = [(c, h, l) for c, h, l in pairs if h < l]
        violations.extend((label, c, h, l) for c, h, l in bad)
        print(f"  {label:<24} {len(pairs) - len(bad)}/{len(pairs)} hold")
    for label, card_id, high_v, low_v in violations:
        print(f"    VIOLATION  {label}: {card_id} has ${high_v:,.2f} vs ${low_v:,.2f} "
              f"({(low_v - high_v) / high_v:+.1%})")
    print("This is a weak check — it cannot catch a price that is uniformly too")
    print("high — but it would have caught the mixed-population groups the gates")
    print("now reject.")

    # ---- worked examples
    print("\n" + "=" * 70)
    print("WORKED EXAMPLES")
    print("=" * 70)
    examples = [
        ("swsh7-215", "RAW_UNKNOWN|UNKNOWN|STANDARD|EN"),   # modern chase, both sources
        ("swsh7-215", "PSA_10|UNKNOWN|STANDARD|EN"),        # graded, eBay only
        ("me05-116", "RAW_UNKNOWN|UNKNOWN|STANDARD|EN"),    # best evidence in the set
        ("xy12-11", "RAW_UNKNOWN|UNKNOWN|STANDARD|EN"),     # holo, now split from reverse
        ("xy12-11", "RAW_UNKNOWN|UNKNOWN|REVERSE_HOLO|EN"), # the reverse holo market
        ("neo1-9", "RAW_UNKNOWN|UNKNOWN|STANDARD|EN"),      # vintage, edition unstated
        ("neo1-9", "RAW_UNKNOWN|FIRST_EDITION|STANDARD|EN"),# vintage 1st ed, still refuses
        ("base1-4", "RAW_UNKNOWN|UNKNOWN|STANDARD|EN"),     # vintage, sources far apart
    ]
    for card_id, group in examples:
        print(render(evaluate(card_id, group, sales, current, history, asof)))

    # ---- refusals
    print("\n" + "=" * 70)
    print("REFUSALS")
    print("=" * 70)
    print(f"card+category combinations : {len(results)}")
    print(f"  price produced           : {len(priced)}")
    print(f"  refused                  : {len(refused)}")
    print()
    for code, count in pd.Series([r["refusalCode"] for r in refused]).value_counts().items():
        print(f"  {count:4d}  {code}")
    print()
    print("Every group that DID produce a price:")
    priced_table = pd.DataFrame([
        {
            "card": r["card"], "group": r["group"], "n": r["stats"]["count"],
            "ebay": r["medianTrimmed"], "tcg": r["tcgPrice"],
            "reference": r["referenceRounded"], "buy": r["recommendedBuy"],
            "margin": r["margin"],
        }
        for r in priced
    ]).sort_values("reference", ascending=False)
    print(priced_table.to_string(index=False, float_format=lambda v: f"{v:,.2f}"))
    print()
    print("Every refusal that was NOT simply a comp shortage:")
    for r in refused:
        if r["refusalCode"] == "TOO_FEW_COMPS":
            continue
        s = r["stats"]
        print(f"  {r['card']:<26} {r['group']:<12} {r['refusalCode']:<17} "
              f"n={s['count']:<3} ${s['min']:,.2f} .. ${s['max']:,.2f}")

    plot_targets = [t for t in examples
                    if not sales[(sales["cardId"] == t[0]) & (sales["comparableGroup"] == t[1])].empty][:4]
    make_plots(sales, history, plot_targets)
    print(f"\nwrote distributions.png, tcgplayer_trends.png, group_summary.csv into {OUT}")


if __name__ == "__main__":
    main()
