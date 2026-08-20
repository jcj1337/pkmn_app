"""
Exploratory liquidity analysis for card + comparable group.

Answers "how often does this exact kind of card actually transact?" — and,
just as importantly, when the saved data cannot answer it.

The central fact about this dataset, established in section 1 below: every
card fixture holds exactly 20 sold listings ending on the scrape date. The
sample is censored by COUNT, not by time. So the 62-day figure quoted
elsewhere is not a collection window — it is the span the slowest card needed
to accumulate 20 sales. The fastest cards needed one day.

That inverts the usual problem. The observation window is per card, it is
itself the liquidity signal, and for fast-moving cards every rate we can
compute is a lower bound rather than an estimate.

Reads only saved fixtures. No network calls, no Apify requests.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path(__file__).parent / "data"
OUT = Path(__file__).parent / "out"
FIXTURES = DATA / "ebay-sold"

# --- policy constants, justified in the report, none fitted to results ----
# Relative standard error of a Poisson count is 1/sqrt(n): 8 sales gives ~35%,
# 4 gives 50%, 3 gives 58%. 8 is the smallest count where a rate is worth
# printing as a number rather than as a count.
MIN_SALES_FOR_RATE = 8
# A window shorter than this cannot resolve a gap at day-level date precision.
MIN_WINDOW_FOR_RATE = 7
MIN_INTERVALS_FOR_GAP = 4
RECENT_DAYS = 30


# ------------------------------------------------------------ observation
def card_windows() -> pd.DataFrame:
    """Observation window per card, from ALL raw listings in the fixture.

    Rejected listings still count toward the window: they are query matches,
    so they mark how far back the scrape could see. Using only accepted comps
    would shorten the window and inflate every rate computed from it.
    """
    rows = []
    for file in sorted(FIXTURES.glob("*.json")):
        listings = json.loads(file.read_text(encoding="utf8"))
        dates = pd.to_datetime(
            [row.get("endedAt") for row in listings if row.get("endedAt")],
            errors="coerce",
        ).dropna()
        if len(dates) == 0:
            continue
        rows.append(
            {
                "cardId": file.stem,
                "rawListings": len(listings),
                "windowStart": dates.min(),
                "windowEnd": dates.max(),
                # Inclusive day count: 20 sales all on one date span one day.
                "windowDays": int((dates.max() - dates.min()).days) + 1,
                "countCensored": len(listings) >= 20,
            }
        )
    return pd.DataFrame(rows)


def date_quality(sales: pd.DataFrame, windows: pd.DataFrame, out: list[str]) -> None:
    say = out.append
    say("=" * 72)
    say("1. DATE QUALITY")
    say("=" * 72)

    raw_total = int(windows["rawListings"].sum())
    dated = sales["soldDate"].notna().sum()

    say(f"raw listings in fixtures        : {raw_total} across {len(windows)} cards")
    say(f"comparable sales (English)      : {len(sales)}")
    say(f"  ...with a usable sold date    : {dated}")
    say(f"date range                      : {sales['soldDate'].min().date()} .. {sales['soldDate'].max().date()}")
    say(f"unique sale dates (all cards)   : {sales['soldDate'].nunique()}")

    # Resolution: are these dates or timestamps?
    times = sales["soldDate"].dt.time
    say(f"date resolution                 : {'DAY-LEVEL (all times 00:00:00)' if (times == pd.Timestamp('00:00').time()).all() else 'timestamped'}")

    per_date = sales.groupby(["cardId", "soldDate"]).size()
    say(f"card+date cells                 : {len(per_date)}")
    say(f"  cells with >1 sale            : {int((per_date > 1).sum())}  ({(per_date > 1).mean():.0%})")
    say(f"  largest single-day cluster    : {int(per_date.max())} sales")

    dupes = sales["itemId"].duplicated().sum()
    say(f"duplicate itemIds within comps  : {dupes}")

    say("")
    say("-- IS 62 DAYS A COLLECTION WINDOW? --")
    say(f"fixtures holding exactly 20 listings : {int((windows['rawListings'] == 20).sum())} / {len(windows)}")
    say(f"distinct scrape end dates            : {windows['windowEnd'].dt.date.nunique()}"
        f"  ({', '.join(str(d) for d in sorted(windows['windowEnd'].dt.date.unique()))})")
    say(f"per-card window span, days           : min {windows['windowDays'].min()}, "
        f"median {int(windows['windowDays'].median())}, max {windows['windowDays'].max()}")
    say("")
    say("NO. Every fixture holds exactly 20 listings and every one ends at the")
    say("scrape date. The actor returned 'the 20 most recent sold listings' per")
    say("card, so the sample is censored by COUNT, not by time. 62 days is simply")
    say("how long the slowest card took to accumulate 20 sales; the fastest took")
    say("one day. There is no common observation window, and nothing older than")
    say("each card's 20th-most-recent sale is visible at all.")
    say("")
    say("Consequences that shape everything below:")
    say("  * the observation window is PER CARD and is itself a liquidity signal")
    say("  * for cards whose 20 sales landed in <=2 days, every rate is a LOWER")
    say("    BOUND - the true count in that window may be far above 20")
    say("  * days-since-last-sale is ~0 for every card by construction, because")
    say("    the sample is anchored to the scrape date")
    say("")
    say("per-card observation windows (all 20 raw listings):")
    say(f"  {'card':<16}{'window':>8}{'days':>6}{'>= sales/day':>14}")
    for _, row in windows.sort_values("windowDays").iterrows():
        say(f"  {row['cardId']:<16}"
            f"{row['windowStart'].strftime('%m-%d'):>8}"
            f"{row['windowDays']:>6}"
            f"{row['rawListings'] / row['windowDays']:>14.1f}")


# ---------------------------------------------------------------- evidence
def group_evidence(sales: pd.DataFrame, windows: pd.DataFrame) -> pd.DataFrame:
    """Per card+comparable-group liquidity evidence.

    The observation window is the CARD's, never the group's own first-to-last
    span. A group that sold on days 1 and 3 of a 55-day window was observed for
    55 days, not 3 — using its own span would report it as wildly liquid.
    """
    window_by_card = windows.set_index("cardId")
    rows = []

    for (card_id, group), frame in sales.groupby(["cardId", "comparableGroup"]):
        if card_id not in window_by_card.index:
            continue
        window = window_by_card.loc[card_id]
        dates = frame["soldDate"].dropna().sort_values()
        if dates.empty:
            continue

        gaps = dates.diff().dropna().dt.days.to_numpy()
        window_days = int(window["windowDays"])

        rows.append(
            {
                "cardId": card_id,
                "card": f"{frame['cardName'].iloc[0]} {frame['cardNumber'].iloc[0]}",
                "group": group,
                "sales": len(dates),
                "uniqueDates": dates.nunique(),
                "firstSale": dates.min(),
                "lastSale": dates.max(),
                "groupSpanDays": int((dates.max() - dates.min()).days),
                "windowDays": window_days,
                "windowStart": window["windowStart"],
                "observedEnd": window["windowEnd"],
                "daysSinceLast": int((window["windowEnd"] - dates.max()).days),
                "salesPerWindowDay": len(dates) / window_days,
                "salesPer30Window": len(dates) / window_days * 30,
                "medianGap": float(np.median(gaps)) if len(gaps) else np.nan,
                "meanGap": float(np.mean(gaps)) if len(gaps) else np.nan,
                "intervals": len(gaps),
                "countCensored": bool(window["countCensored"]),
                # A rate from a 1-2 day window is a floor, not a measurement.
                "rateIsLowerBound": window_days < MIN_WINDOW_FOR_RATE,
            }
        )

    return pd.DataFrame(rows)


def evidence_mode(row: pd.Series) -> str:
    """Which of the two display modes a group qualifies for, and why."""
    if row["sales"] < MIN_SALES_FOR_RATE:
        return "SPARSE"
    if row["windowDays"] < MIN_WINDOW_FOR_RATE:
        # Plenty of sales, but the window is too short to divide by.
        return "CENSORED_FAST"
    if row["intervals"] < MIN_INTERVALS_FOR_GAP:
        return "SPARSE"
    return "SUFFICIENT"


# ------------------------------------------------------------------ report
def candidate_measures(evidence: pd.DataFrame, out: list[str]) -> None:
    say = out.append
    say("")
    say("=" * 72)
    say("3. CANDIDATE LIQUIDITY MEASURES")
    say("=" * 72)

    say("A. recent sale count (sales in the observed window)")
    say(f"   available for {len(evidence)}/{len(evidence)} groups — always computable")
    say(f"   distribution: min {evidence['sales'].min()}, median {int(evidence['sales'].median())}, max {evidence['sales'].max()}")
    say("   VERDICT: keep. Never misleading, needs no assumptions.")
    say("")

    gap_ok = evidence[evidence["intervals"] >= MIN_INTERVALS_FOR_GAP]
    degenerate = gap_ok[gap_ok["medianGap"] == 0]
    say("B. median days between sales")
    say(f"   computable with >={MIN_INTERVALS_FOR_GAP} intervals: {len(gap_ok)}/{len(evidence)} groups")
    say(f"   of those, median gap == 0 days: {len(degenerate)}  ({len(degenerate) / max(len(gap_ok), 1):.0%})")
    say("   VERDICT: fails exactly where liquidity is highest. Dates are day-level,")
    say("   so a group selling several times a day reports a 'typical gap' of 0.")
    say("   Usable only as a secondary figure on slow-moving groups.")
    say("")

    say("C. days since latest sale")
    say(f"   distribution: min {evidence['daysSinceLast'].min()}, median {int(evidence['daysSinceLast'].median())}, max {evidence['daysSinceLast'].max()}")
    say(f"   groups with 0 days since last sale: {int((evidence['daysSinceLast'] == 0).sum())}")
    say("   VERDICT: keep, but read it against the card's window. It is bounded")
    say("   above by that window, so it can never reveal a months-dead market here.")
    say("")

    say("D. normalized frequency (sales / observed day)")
    lower = evidence[evidence["rateIsLowerBound"]]
    say(f"   groups where the window is <{MIN_WINDOW_FOR_RATE} days, making this a floor: {len(lower)}/{len(evidence)}")
    say(f"   distribution: min {evidence['salesPerWindowDay'].min():.3f}, "
        f"median {evidence['salesPerWindowDay'].median():.3f}, max {evidence['salesPerWindowDay'].max():.3f}")
    say("   VERDICT: the most comparable measure across cards, because it divides")
    say("   by each card's own window. Must carry a '>=' marker when the window is")
    say("   short, and a count-based confidence interval always.")
    say("")
    say("RECOMMENDATION: report A + C always, D with an explicit >= where censored,")
    say("and B only when the window is long enough to resolve gaps. Do not compress")
    say("them into one number (see section 9).")


def poisson_interval(count: int, window_days: int) -> tuple[float, float]:
    """Rough 95% interval for a rate from a raw count.

    Normal approximation on sqrt(count); crude at small n, which is the point —
    it shows how wide the honest range is rather than hiding it.
    """
    if count == 0:
        return 0.0, 0.0
    se = np.sqrt(count)
    lo = max(0.0, (count - 1.96 * se)) / window_days
    hi = (count + 1.96 * se) / window_days
    return lo, hi


def describe(row: pd.Series) -> list[str]:
    """The display a card page could eventually render for one group."""
    mode = row["mode"]
    lines = []

    if mode == "SUFFICIENT":
        per30 = row["salesPer30Window"]
        lo, hi = poisson_interval(int(row["sales"]), int(row["windowDays"]))
        gap = 1 / row["salesPerWindowDay"]
        lines.append("  🟢/🟡  SUFFICIENT EVIDENCE")
        lines.append(f"     Typical observed sale every ~{gap:.0f} days")
        lines.append(f"     {per30:.1f} comparable sales per 30 observed days"
                     f"  (95% range {lo * 30:.1f}–{hi * 30:.1f})")
        lines.append(f"     Last observed sale {row['daysSinceLast']} days ago")
    elif mode == "CENSORED_FAST":
        lines.append("  ⚡  HIGH, BUT UNMEASURED")
        lines.append(f"     At least {row['sales']} comparable sales in {row['windowDays']} observed day(s)")
        lines.append("     The scrape stopped at 20 listings, so the true rate is higher")
        lines.append(f"     Last observed sale {row['daysSinceLast']} days ago")
    else:
        lines.append("  🔴  SPARSE EVIDENCE")
        lines.append(f"     {row['sales']} comparable sale(s) observed over {row['windowDays']} days")
        lines.append(f"     Last observed sale {row['daysSinceLast']} days ago")
        lines.append("     Not enough evidence to estimate a stable sale frequency")

    return lines


def main() -> None:
    OUT.mkdir(exist_ok=True)
    out: list[str] = []

    sales = pd.read_csv(OUT / "comparable_sales.csv", parse_dates=["soldDate"])
    windows = card_windows()

    # Reuse the pricing analysis exactly as-is to label each group priced or
    # refused. Imported, never modified — no constant is touched.
    from recommended_buy_analysis import evaluate as price_evaluate, load as price_load

    price_sales, price_current, price_history = price_load()
    price_asof = price_sales["soldDate"].max()
    verdicts: dict[tuple[str, str], str] = {}
    for (card_id, group), _ in price_sales.groupby(["cardId", "comparableGroup"]):
        result = price_evaluate(card_id, group, price_sales, price_current,
                                price_history, price_asof)
        verdicts[(card_id, group)] = (
            result["refusalCode"] if result["refused"]
            else f"priced, margin {result['margin']:.0%}"
        )

    date_quality(sales, windows, out)

    evidence = group_evidence(sales, windows)
    evidence["mode"] = evidence.apply(evidence_mode, axis=1)
    evidence.sort_values(["sales", "salesPerWindowDay"], ascending=False).to_csv(
        OUT / "liquidity-groups.csv", index=False
    )

    say = out.append
    say("")
    say("=" * 72)
    say("2. GROUP INVENTORY")
    say("=" * 72)
    say(f"comparable groups with usable dates : {len(evidence)}")
    say(f"distinct cards                      : {evidence['cardId'].nunique()}")
    say("")
    say("group size distribution:")
    for size, count in evidence["sales"].value_counts().sort_index().items():
        say(f"  {size:>3} sale(s) : {'#' * count} {count}")
    say("")
    say(f"groups with >= {MIN_SALES_FOR_RATE} sales : {int((evidence['sales'] >= MIN_SALES_FOR_RATE).sum())}")
    say(f"groups with >= 3 sales : {int((evidence['sales'] >= 3).sum())}")
    say(f"groups with 1 sale     : {int((evidence['sales'] == 1).sum())}")

    candidate_measures(evidence, out)

    # ---- sufficiency
    say("")
    say("=" * 72)
    say("4. SUFFICIENT-EVIDENCE RULE")
    say("=" * 72)
    say("A rate is a count divided by a window, so its relative standard error is")
    say("1/sqrt(count): 3 sales -> 58%, 4 -> 50%, 8 -> 35%, 12 -> 29%. Eight is the")
    say("smallest count where a printed frequency is not mostly noise. Nothing here")
    say("is fitted to the data; the rule comes from the estimator, not the results.")
    say("")
    say(f"  SUFFICIENT     : sales >= {MIN_SALES_FOR_RATE} AND window >= {MIN_WINDOW_FOR_RATE}d AND intervals >= {MIN_INTERVALS_FOR_GAP}")
    say(f"  CENSORED_FAST  : sales >= {MIN_SALES_FOR_RATE} but window < {MIN_WINDOW_FOR_RATE}d  (report a floor, not a rate)")
    say("  SPARSE         : anything else — counts and recency only")
    say("")
    for mode, count in evidence["mode"].value_counts().items():
        say(f"  {mode:<14} {count:>3} groups")

    # ---- distributions among groups that qualify
    say("")
    say("=" * 72)
    say("5. EMPIRICAL DISTRIBUTIONS (threshold calibration attempt)")
    say("=" * 72)
    qualified = evidence[evidence["mode"] != "SPARSE"]
    say(f"groups with enough evidence to rank : {len(qualified)}")
    if len(qualified) > 0:
        say("")
        say(f"  {'card':<22}{'mode':<15}{'n':>3}{'win':>5}{'/30d':>8}{'medGap':>8}{'since':>7}")
        for _, row in qualified.sort_values("salesPerWindowDay", ascending=False).iterrows():
            say(f"  {row['card'][:21]:<22}{row['mode']:<15}{row['sales']:>3}"
                f"{row['windowDays']:>5}{row['salesPer30Window']:>8.1f}"
                f"{row['medianGap']:>8.1f}{row['daysSinceLast']:>7}")
        say("")
        say(f"sales per 30 observed days: min {qualified['salesPer30Window'].min():.1f}, "
            f"median {qualified['salesPer30Window'].median():.1f}, max {qualified['salesPer30Window'].max():.1f}")
    say("")
    say(f"VERDICT ON HIGH/MODERATE/LOW THRESHOLDS: {len(qualified)} calibration points")
    say("is far too few to place two cut lines. Any threshold chosen here would be")
    say("drawn through single observations and would move if one card were added.")
    say("Ship the evidence lines now; calibrate colours after a wider collection.")

    # ---- inactivity
    say("")
    say("=" * 72)
    say("10. MARKET INACTIVITY")
    say("=" * 72)
    multi = evidence[evidence["sales"] >= 3]
    say("The pattern you described — many sales early, then nothing for weeks —")
    say("DOES NOT OCCUR in this dataset, and cannot. The scrape returns the 20 most")
    say("recent sales as of the scrape date, so every card's newest sale is at the")
    say("right edge by construction.")
    say("")
    say(f"  max days-since-last-sale, groups with >=3 sales : {int(multi['daysSinceLast'].max())}")
    say(f"  max days-since-last-sale, groups with >=2 sales : {int(evidence[evidence['sales'] >= 2]['daysSinceLast'].max())}")
    say(f"  groups with >=3 sales whose last sale is >=7d old: {int((multi['daysSinceLast'] >= 7).sum())}")
    say("")
    say("I am not going to manufacture an example that the data does not contain.")
    say("Detecting a stalled market needs a fixed-time query, not a fixed-count one.")
    say("")
    say("What the data DOES contain is the same statistical hazard in mirror image:")
    say("groups whose sales cluster into a small part of a long window. Dividing by")
    say("the group's own first-to-last span instead of the card's window would")
    say("report these as extremely liquid.")
    say("")
    clustered = multi[(multi["windowDays"] >= 10) & (multi["groupSpanDays"] * 3 < multi["windowDays"])]
    say(f"  {'card':<22}{'n':>3}{'grpSpan':>8}{'window':>8}{'own-span rate':>15}{'true rate':>11}")
    for _, row in clustered.sort_values("windowDays", ascending=False).iterrows():
        own = row["sales"] / max(row["groupSpanDays"], 1)
        say(f"  {row['card'][:21]:<22}{row['sales']:>3}{row['groupSpanDays']:>8}{row['windowDays']:>8}"
            f"{own * 30:>13.1f}/mo{row['salesPerWindowDay'] * 30:>9.1f}/mo")
    say("")
    say("Iono 185 is the clearest case: 3 sales inside 3 days of a 63-day window.")
    say("Its own span implies 30 sales a month; the card's window says 1.4. The")
    say("second figure is the honest one, and it is why every rate here divides by")
    say("the card's observation window rather than the group's.")
    say("")
    say("Recency must still be shown beside frequency rather than folded into it —")
    say("this dataset just cannot demonstrate the failure it protects against.")

    # ---- 0-100 score
    say("")
    say("=" * 72)
    say("9. IS A 0-100 LIQUIDITY SCORE USEFUL?")
    say("=" * 72)
    say("Built one to test it. Score = 100 * min(1, salesPer30Window / 40), which is")
    say("as defensible as any other monotone squashing of the one rate we have.")
    say("Propagating the count's own 1/sqrt(n) error through it:")
    say("")
    say(f"  {'card':<22}{'n':>3}{'/30d':>8}{'score':>7}{'95% score range':>20}")
    for _, row in qualified.sort_values("salesPer30Window", ascending=False).iterrows():
        lo, hi = poisson_interval(int(row["sales"]), int(row["windowDays"]))
        score = min(1.0, row["salesPer30Window"] / 40) * 100
        say(f"  {row['card'][:21]:<22}{row['sales']:>3}{row['salesPer30Window']:>8.1f}"
            f"{score:>7.0f}{min(100, lo * 30 / 40 * 100):>10.0f} - {min(100, hi * 30 / 40 * 100):<8.0f}")
    say("")
    say("The intervals are 30-60 points wide. A score of '68 / 100' presented next")
    say("to a price implies a precision the evidence cannot support, and it also")
    say("erases the distinction between a measured rate and a censored lower bound —")
    say("Charizard ex would score 100 when what we actually know is 'at least 9")
    say("sales in 4 days, ceiling unknown'.")
    say("")
    say("RECOMMENDATION: do not ship a 0-100 score. Two plain lines carry the same")
    say("information without the false precision:")
    say("    High liquidity - typical sale every ~1 day")
    say("    17 comparable sales in the last 14 observed days")
    say("A score would be worth revisiting only if it ever combined genuinely")
    say("independent inputs; right now it is one number wearing a costume.")

    # ---- recommended buy connection
    say("")
    say("=" * 72)
    say("11. HOW LIQUIDITY COULD EVENTUALLY INFORM RECOMMENDED BUY")
    say("=" * 72)
    say("Analysis only — no formula constant is changed here.")
    say("")
    say(f"  {'card':<22}{'n':>3}{'/30d':>8}{'median $':>10}{'pricing verdict':>32}")
    for _, row in qualified.sort_values("salesPer30Window", ascending=False).iterrows():
        verdict = verdicts.get((row["cardId"], row["group"]), "not evaluated")
        price = sales[(sales["cardId"] == row["cardId"]) &
                      (sales["comparableGroup"] == row["group"])]["soldPrice"].median()
        say(f"  {row['card'][:21]:<22}{row['sales']:>3}{row['salesPer30Window']:>8.1f}"
            f"{price:>10,.0f}{verdict:>32}")
    say("")
    say("Two things this table settles:")
    say("")
    fastest_row = qualified.loc[qualified["salesPer30Window"].idxmax()]
    slowest_row = qualified.loc[qualified["salesPer30Window"].idxmin()]
    price_of = lambda r: sales[(sales["cardId"] == r["cardId"]) &
                               (sales["comparableGroup"] == r["group"])]["soldPrice"].median()
    say("1. Liquidity is not a price level. The most liquid group here trades at")
    say(f"   ~${price_of(fastest_row):,.0f} and the least liquid at ~${price_of(slowest_row):,.0f};")
    say("   the $2,244 Umbreon groups are not in the qualifying set at all.")
    say("   They are unrelated axes, exactly as you said.")
    say("")
    say("2. Liquidity is not the same as priceability. Rayquaza GX has 11 comps in")
    say("   18 days — genuinely liquid — yet the pricing gate refuses it because")
    say("   those comps are a mixed population. A liquid market can still be")
    say("   unpriceable, so liquidity must never override a refusal gate.")
    say("")
    say("Where it could legitimately enter the margin, later:")
    say("  * the thin-evidence term already scales with comp count, which is the")
    say("    part of liquidity that speaks to price confidence — adding a separate")
    say("    liquidity term risks counting the same evidence twice")
    say("  * the genuinely new signal is TIME: comps spread over 56 days are weaker")
    say("    evidence about today's price than the same count inside 4 days, and")
    say("    nothing in the current margin captures that")
    say("  * a stalled market should widen the margin or trigger refusal, but this")
    say("    dataset cannot detect one (section 10), so that must wait")
    say("RECOMMENDATION: do not wire liquidity into the margin yet. The one term it")
    say("would justify — staleness of the comp window — cannot be calibrated until")
    say("collection is time-based rather than count-based.")

    # ---- worked examples
    say("")
    say("=" * 72)
    say("12. WORKED EXAMPLES")
    say("=" * 72)
    picks = (
        evidence[evidence["mode"] != "SPARSE"].sort_values("sales", ascending=False).head(5)
    )
    sparse_picks = evidence[evidence["mode"] == "SPARSE"].sort_values(
        ["daysSinceLast", "sales"], ascending=[False, False]
    ).head(3)

    for _, row in pd.concat([picks, sparse_picks]).iterrows():
        say("")
        say("-" * 72)
        say(f"Card   : {row['card']}")
        say(f"Group  : {row['group']}")
        say(f"  sales {row['sales']}   unique dates {row['uniqueDates']}   intervals {row['intervals']}")
        say(f"  card observation window : {row['windowDays']} days "
            f"({row['windowStart'].date()} .. {row['observedEnd'].date()})")
        say(f"  group first/last sale   : {row['firstSale'].date()} .. {row['lastSale'].date()}")
        say(f"  median gap {row['medianGap']:.1f}d   mean gap {row['meanGap']:.1f}d"
            if row["intervals"] > 0 else "  no intervals (single sale)")
        say(f"  sales / 30 observed days: {row['salesPer30Window']:.1f}")
        say(f"  days since last sale    : {row['daysSinceLast']}")
        say("")
        say("  possible display:")
        out.extend(describe(row))

    # ---- annualization
    say("")
    say("=" * 72)
    say("5b. ANNUALIZATION")
    say("=" * 72)
    fastest = evidence.loc[evidence["salesPerWindowDay"].idxmax()]
    slowest = qualified.loc[qualified["salesPerWindowDay"].idxmin()] if len(qualified) else None
    say(f"Naively annualizing the fastest group ({fastest['card']}, "
        f"{fastest['sales']} sales / {fastest['windowDays']}d) gives "
        f"{fastest['salesPerWindowDay'] * 365:,.0f} sales per year.")
    if slowest is not None:
        say(f"The slowest qualifying group gives {slowest['salesPerWindowDay'] * 365:,.0f}.")
    say("Both are artefacts. The numerator is capped at 20 by the scrape and the")
    say("denominator is whatever span those 20 sales happened to occupy, so the")
    say("ratio is bounded by the sampling procedure rather than by the market.")
    say("RECOMMENDATION: do not annualize. Report observed windows only.")

    report = OUT / "liquidity-report.txt"
    report.write_text("\n".join(out) + "\n", encoding="utf8")
    # The report carries emoji; the Windows console is cp1252, so the file is
    # the deliverable and stdout only confirms it was written.
    print(f"wrote {report} ({len(out)} lines) and {OUT / 'liquidity-groups.csv'}")
    print(f"groups: {len(evidence)}  modes: {evidence['mode'].value_counts().to_dict()}")


if __name__ == "__main__":
    main()
