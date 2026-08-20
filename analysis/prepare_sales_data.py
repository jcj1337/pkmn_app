"""
Normalizes already-saved eBay sold listings into a comparable-sales dataframe.

Input comes from analysis/export_sales.cjs, which runs the existing
deterministic classifier over fixtures already on disk. No network calls here.

Exclusion rules are deliberately strict, because the output feeds a price
recommendation and a bad comp is worse than a missing one:

  * listings the classifier rejected are dropped entirely
  * raw and graded sales never share a comparable group
  * RAW_UNKNOWN is its own group; it is never folded into RAW_NM
  * PSA 10 / PSA 9 / BGS / CGC are all separate groups
  * condition is never inferred
  * non-English printings are excluded from English comps, matching the
    deterministic pipeline's own rule
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

DATA_DIR = Path(__file__).parent / "data"
OUT_DIR = Path(__file__).parent / "out"

# The deterministic detector only reports a language on explicit evidence, so
# UNKNOWN is the normal state for an English listing. Anything it positively
# identified as another language is a different printing.
ENGLISH_COMPATIBLE = {"EN", "UNKNOWN"}


def load_sales() -> pd.DataFrame:
    rows = json.loads((DATA_DIR / "classified-sales.json").read_text(encoding="utf8"))
    frame = pd.DataFrame(rows)
    frame["soldDate"] = pd.to_datetime(frame["soldDate"], errors="coerce")
    frame["soldPrice"] = pd.to_numeric(frame["soldPrice"], errors="coerce")
    return frame


def load_tcgplayer() -> tuple[pd.DataFrame, pd.DataFrame]:
    rows = json.loads((DATA_DIR / "tcgplayer.json").read_text(encoding="utf8"))

    current = pd.DataFrame(
        [
            {
                "cardId": r["cardId"],
                "cardName": r["cardName"],
                "setName": r["setName"],
                "cardNumber": r["cardNumber"],
                "productId": r["productId"],
                "subType": r["subType"],
                "currentMarketPrice": r["currentMarketPrice"],
                "historyPoints": len(r["history"]),
            }
            for r in rows
        ]
    )

    history = pd.DataFrame(
        [
            {"cardId": r["cardId"], "date": h["date"], "marketPrice": h["marketPrice"]}
            for r in rows
            for h in r["history"]
        ]
    )
    if not history.empty:
        history["date"] = pd.to_datetime(history["date"])
        history["marketPrice"] = pd.to_numeric(history["marketPrice"], errors="coerce")

    return current, history


def comparable_sales(frame: pd.DataFrame) -> pd.DataFrame:
    """Keeps only rows usable as comps, and records why rows were dropped."""
    usable = frame.copy()

    usable["dropReason"] = None
    usable.loc[~usable["relevant"], "dropReason"] = "classifier rejected"
    usable.loc[
        usable["dropReason"].isna() & usable["soldPrice"].isna(), "dropReason"
    ] = "no sold price"
    usable.loc[
        usable["dropReason"].isna() & (usable["currency"] != "USD"), "dropReason"
    ] = "non-USD sale"
    usable.loc[
        usable["dropReason"].isna() & ~usable["language"].isin(ENGLISH_COMPATIBLE),
        "dropReason",
    ] = "non-English printing"

    kept = usable[usable["dropReason"].isna()].copy()

    # comparableGroup arrives from the classifier itself (category + edition +
    # printing), so Python never re-derives grouping rules the app might change.
    kept["isRaw"] = ~kept["isGraded"]

    return kept, usable[usable["dropReason"].notna()]


def main() -> None:
    OUT_DIR.mkdir(exist_ok=True)

    sales = load_sales()
    kept, dropped = comparable_sales(sales)
    current, history = load_tcgplayer()

    kept.to_csv(OUT_DIR / "comparable_sales.csv", index=False)
    current.to_csv(OUT_DIR / "tcgplayer_current.csv", index=False)
    history.to_csv(OUT_DIR / "tcgplayer_history.csv", index=False)

    print("=" * 68)
    print("SALES DATA INVENTORY")
    print("=" * 68)
    print(f"raw listings loaded      : {len(sales)}")
    print(f"usable comparable sales  : {len(kept)}")
    print(f"excluded                 : {len(dropped)}")
    print()
    print("exclusion reasons:")
    for reason, count in dropped["dropReason"].value_counts().items():
        print(f"  {count:4d}  {reason}")

    print()
    print(f"date span                : {kept['soldDate'].min().date()} .. {kept['soldDate'].max().date()}")
    print(f"distinct cards           : {kept['cardId'].nunique()}")
    print()
    print("edition distribution:")
    for value, count in kept["edition"].value_counts().items():
        print(f"  {count:4d}  {value}")

    print()
    print("printVariant distribution:")
    for value, count in kept["printVariant"].value_counts().items():
        print(f"  {count:4d}  {value}")

    print()
    print(f"comparable groups: {kept['comparableGroup'].nunique()} distinct")
    for group, count in kept["comparableGroup"].value_counts().head(15).items():
        print(f"  {count:4d}  {group}")

    print()
    print("raw vs graded:")
    print(f"  raw    : {int((~kept['isGraded']).sum())}")
    print(f"  graded : {int(kept['isGraded'].sum())}")

    print()
    print("grading companies:")
    graded = kept[kept["isGraded"]]
    if graded.empty:
        print("  (none)")
    else:
        for company, count in graded["gradingCompany"].value_counts().items():
            print(f"  {count:4d}  {company}")

    print()
    print(f"cards with cached TCGplayer history : {int((current['historyPoints'] > 0).sum())} / {len(current)}")
    print(f"cards with a current market price   : {int(current['currentMarketPrice'].notna().sum())} / {len(current)}")
    print()
    print(f"wrote {OUT_DIR / 'comparable_sales.csv'}")


if __name__ == "__main__":
    main()
