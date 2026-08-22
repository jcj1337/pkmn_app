# TCGracker

**Motivation**: The current go-to app is Collectr, but it has many issues. There is a lack of a real one and done source for card prices. TCGPlayer works well for modern/liquid cards, but it can be hard to accurately comp older ones. This app will aim to solve this problem by providing transparent, explainable market data.

**check *documentation* folder for docs**

**Current Next-Steps**: Make a web-scraper for ebay last sold since
Apify is too limiting. This should include pagination, allow for limits, etc. Store the data historically somewhere, probably *AWS*. 

The app *currently* combines:

1. **Card data + primary TCGplayer pricing** — via TCGdex
2. **Fallback TCGplayer pricing/images** — via TCGCSV
3. **Recent eBay sold listings** — via Apify
4. **Rule-based listing classification** — raw, graded, irrelevant, language, set match, etc.

The long-term goal is to build a pricing system that can explain *why* a card is worth a given amount rather than showing a single and very questionable market value. 

Something like: 

                    USERS
                      │
                      ▼
              Next.js Web App
                 (Vercel)
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
     Card/Search   Pricing     Deal Checker
       APIs        Engine
          │           │
          └───────┬───┘
                  ▼
             Database
       PostgreSQL / Supabase
                  │
        cleaned cards + sales
        recommendations/history
                  ▲
                  │
         Data Processing Jobs
                  ▲
          ┌───────┴────────┐
          │                │
      TCGdex/TCGCSV    eBay collector
          │                │
          └───────┬────────┘
                  ▼
             Raw Storage
                S3

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
