# eBay sold-sales history

Persistent, deduplicated sold listings collected over **fixed time windows**, for
liquidity and pricing analysis.

Written only by `scripts/collect-ebay-history.cjs`. Never written by the app —
opening a card page does not collect anything.

```
data/ebay-sales/<cardId>/raw-sales.json
```

## Why this exists

The card page's live lookup asks for the **20 most recent** sold listings. That
is the right shape for a "recent sales" list and the wrong shape for measuring
how often something trades: with `sortOrder: endedRecently`, a count of 20
returns the 20 newest sales inside the window and discards the rest. The
observation period then becomes "however long those 20 sales happened to take"
— one day for a fast card, 62 for a slow one — so rates are not comparable
across cards, and a card with no recent sales cannot appear in the sample at
all. See `analysis/out/liquidity-report.txt` section 1.

This dataset fixes the window instead of the count, and records when it failed
to get one.

## File format

```jsonc
{
  "cardId": "swsh7-215",
  "cardName": "Umbreon VMAX",
  "setName": "Evolving Skies",
  "cardNumber": "215",
  "query": "Umbreon VMAX 215/203",

  // Newest first. Deduplicated by eBay itemId, never overwritten.
  "sales": [
    {
      "itemId": "306...",           // eBay's primary key — the dedupe key
      "title": "Umbreon VMAX 215/203 Alt Art ...",
      "soldPrice": 1950,
      "currency": "USD",
      "soldDate": "2026-08-17",     // day resolution; eBay exposes no time
      "condition": null,
      "imageUrl": "https://...",
      "url": "https://ebay.com/itm/...",
      "firstSeenAt": "2026-08-20T09:14:03.221Z"   // when WE first saw it
    }
  ],

  // Append-only. One entry per collection run; earlier runs are never rewritten.
  "collections": [
    {
      "collectedAt": "2026-08-20T09:14:03.221Z",
      "query": "Umbreon VMAX 215/203",
      "requestedDays": 90,
      "requestedCount": 100,
      "requestedFrom": "2026-05-22",   // window we ASKED for
      "requestedTo": "2026-08-20",
      "returned": 100,
      "newSales": 100,
      "earliestSale": "2026-08-08",
      "latestSale": "2026-08-20",
      "completeness": "TRUNCATED",
      "observedFrom": "2026-08-08",    // window we can VOUCH for
      "observedTo": "2026-08-20"
    }
  ]
}
```

## Completeness

The single most important field. It distinguishes "nothing sold" from
"we stopped looking".

| Value | Meaning | How it is decided |
|---|---|---|
| `COMPLETE` | Every sale in the requested window is present | `returned < requestedCount` — the source ran out before the cap |
| `TRUNCATED` | The cap was hit first; older sales exist but were not returned | `returned == requestedCount` and `earliestSale` is still well inside the window |
| `EMPTY` | Nothing sold in the window | `returned == 0` — evidence, not absence of evidence |

`observedFrom` is the field analysis must divide by:

- `COMPLETE` → `observedFrom == requestedFrom` (the full window)
- `TRUNCATED` → `observedFrom == earliestSale` (only the span actually reached)

A run that hits the cap *exactly at* the window edge is still `COMPLETE`; a
one-day tolerance absorbs timezone skew between eBay's end timestamps and ours.

## What `analysis/liquidity_analysis.py` will consume

The methodology is unchanged. Only the source of the observation window moves:
today it is inferred per card from the fixtures (`card_windows()`); with this
dataset it is read directly.

| Field it needs | Where it comes from |
|---|---|
| Observation window start | `coverage(collections).observedFrom` |
| Observation window end | `coverage(collections).observedTo` |
| Window length in days | `coverage(collections).observedDays` |
| Whether the window is trustworthy | `coverage(collections).anyTruncated` |
| Whether the window has holes | `coverage(collections).hasGap` |
| Sales in the window | `sales[]` filtered to the window, then classified and grouped by `comparableGroup()` |

The target calculation stays: **same card + same comparableGroup + same fixed
observation window.** With a real window, `sales / observedDays` becomes
comparable across cards, and `daysSinceLast` stops being pinned near zero by
the sampling method.

Groups whose card has `anyTruncated: true` still cannot report an upper bound
on their rate — that is a source limitation, not an analysis one, and the flag
is what lets the analysis say so.

## Incremental collection

Runs are additive. Collect a wide window once, then narrow windows regularly:

```bash
# once, to seed
node scripts/collect-ebay-history.cjs --all --days=90 --count=100

# thereafter, e.g. weekly — cheap, and only unseen itemIds are stored
node scripts/collect-ebay-history.cjs --all --days=14 --count=100
```

Each run merges by `itemId`, so repeated collection over the same period costs
credit but never duplicates or loses a sale. Over months this accumulates a
longitudinal dataset far longer than the actor's 90-day reach.

Keep the cadence shorter than the window. If collections lapse further apart
than `requestedDays`, `coverage().hasGap` goes true and the intervening period
is genuinely missing.
