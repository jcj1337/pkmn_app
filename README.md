# Pokémon Price Checker

**Motivation**: Collectr sucks. There is a lack of a real one and done source for card prices. TCGPlayer works well for modern/liquid cards, but it can be hard to accurately comp older ones. This app will aim to solve this problem by providing transparent, explainable market data.
**check *documentation* folder for docs**

The app *currently* combines:

1. **Card data + primary TCGplayer pricing** — via TCGdex
2. **Fallback TCGplayer pricing/images** — via TCGCSV
3. **Recent eBay sold listings** — via Apify
4. **Rule-based listing classification** — raw, graded, irrelevant, language, set match, etc.

The long-term goal is to build a pricing system that can explain *why* a card is worth a given amount rather than showing a single opaque market value (gc Collectr). 

---

## Card Search

Search runs through `/api/cards`, keeping upstream API response formats out of the browser.

TCGdex is the primary card source and provides:

* card name
* set
* printed card number
* rarity
* image
* TCGplayer pricing
* Cardmarket pricing

Supported search examples:

| Query                    | Behaviour                              |
| ------------------------ | -------------------------------------- |
| `Charizard`              | Name search                            |
| `Mega Gengar ex`         | Name search                            |
| `Charizard 199/165`      | Name + printed number                  |
| `Pikachu VMAX TG17/TG30` | Supports alphanumeric subset numbering |

A card name is currently required.

---

## Pricing Architecture

TCGdex is currently the primary pricing source.

Some cards and subsets have incomplete TCGplayer mappings, so TCGCSV is used as a fallback.

```text
Card search
    ↓
  TCGdex
    ↓
TCGplayer pricing available?
    ├── Yes → use TCGdex
    └── No  → TCGCSV fallback
```

The same fallback can supply missing card images.

Both providers are normalized into the same internal card structure so the frontend does not depend directly on either API.

---

## Card Detail Pages

Each search result links to a dedicated card page:

```text
/card/[id]
```

The page currently displays:

* card image and metadata
* TCGplayer market price
* current listing range
* recent eBay sold listings

This page will later also contain historical price charts and pricing analytics.

---

## eBay Sold Listings

Recent sold listings are retrieved through the Apify actor:

`caffein.dev/ebay-sold-listings`

The app generates the search query from the exact selected card.

Requires:

```env
APIFY_API_TOKEN=your-apify-token
```

Add this to `.env.local`.

Without the token, the rest of the card page still works and the eBay section displays an unavailable-state message.

Because Apify usage can incur costs, identical searches are cached server-side for 6 hours.

---

## eBay Listing Classifier

Raw eBay results contain many listings that should not be treated as equivalent comps.

We thus use a deterministic classifier that groups listings into categories such as:

```text
RAW_NM
RAW_LP
RAW_UNKNOWN

PSA_10
PSA_9

BGS_9_5
CGC_10

OTHER_GRADED
IRRELEVANT
```

The classifier also identifies:

* grading company and grade
* explicitly stated raw condition
* language
* card-number conflicts
* set/reprint conflicts
* mystery and raffle listings
* proxies, custom cards and novelty products
* accessories and non-card products

Foreign-language sales are kept as legitimate sales but tagged separately so they are not mixed with English comps.

---

## Planned AI Layer

The next classifier stage will use an LLM only for listings still ambiguous after deterministic processing.

General flow is gonna go like this:

```text
eBay listing
    ↓
Deterministic rules
    ↓
Confident?
   ├── Yes → use result
   └── No
        ↓
Is information actually present?
   ├── No → UNKNOWN
   └── Yes → LLM semantic fallback
```

LangChain is planned for structured LLM outputs, with LangSmith potentially used later for tracing and evaluation.

AI will not be used to invent raw condition when the listing provides no evidence.

---

## Setup

Requires Node.js 18.18+.

```bash
npm install
npm run dev
```

Then open:

```text
http://localhost:3000
```

---

## Stack (current, will be updated as we go)

* Next.js — App Router
* TypeScript
* Tailwind CSS v4
* TCGdex
* TCGCSV
* Apify


