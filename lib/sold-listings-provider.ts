/**
 * Provider abstraction for sold-listing collection.
 *
 * Everything downstream — the classifier, comparableGroup(), the pricing
 * engine, historical storage — consumes `SoldListing` and must never learn
 * where a listing came from. This module is the only place that knows.
 *
 * ## Why this exists
 *
 * Historical collection currently depends on a paid Apify actor. Swapping or
 * adding a source should be a change here and nowhere else, so that a provider
 * decision is a configuration question rather than a refactor.
 *
 * ## On direct eBay scraping
 *
 * A direct collector was investigated and NOT built. eBay's robots.txt
 * disallows the sold-search endpoint for all user agents:
 *
 *   Disallow: /sch/i.html?_nkw=
 *   Disallow: /sch/i.html?*_nkw=*&
 *   Disallow: /sch/
 *
 * The sold search is /sch/i.html?_nkw=...&LH_Sold=1&LH_Complete=1, which every
 * one of those rules matches. The only /sch/ allowances are the advanced-search
 * form, the category index, tracking-parameter variants, and an affiliate
 * channel parameter — none of which return keyword sold results.
 *
 * `directEbayProvider` therefore exists as a documented refusal rather than as
 * an implementation, so the reason lives where the next person will look for it.
 * The sanctioned route to the same data is eBay's Marketplace Insights API
 * (sold items, 90-day history), which is a Limited Release API requiring
 * approval; see the report in docs, not a scraper.
 */

import { runSoldSearch, type SoldListing } from "./ebay-sold";

export type ProviderId = "APIFY" | "DIRECT_EBAY";

export interface ProviderSearchOptions {
  /** Days of history requested. Providers may cap this. */
  days: number;
  /** Maximum listings requested. Providers may return fewer. */
  count: number;
}

export type ProviderResult =
  | {
      status: "ok";
      listings: SoldListing[];
      /**
       * True when the provider stopped at its own limit rather than at the
       * end of the data. Completeness assessment needs this to distinguish
       * "nothing older exists" from "we were not shown anything older".
       */
      cappedByProvider: boolean;
    }
  | { status: "not-configured"; reason: string }
  | { status: "unavailable"; reason: string };

export interface SoldListingsProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Whether this provider can run at all (credentials, policy, etc.). */
  isConfigured(): boolean;
  search(query: string, options: ProviderSearchOptions): Promise<ProviderResult>;
}

/* ------------------------------------------------------------------ Apify */

/** The working provider: the `caffein.dev/ebay-sold-listings` actor. */
export function apifyProvider(token: string | undefined): SoldListingsProvider {
  return {
    id: "APIFY",
    label: "Apify (caffein.dev/ebay-sold-listings)",
    isConfigured: () => Boolean(token),

    async search(query, options) {
      if (!token) {
        return { status: "not-configured", reason: "APIFY_API_TOKEN is not set." };
      }

      try {
        const listings = await runSoldSearch(query, token, {
          days: options.days,
          count: options.count,
        });
        return {
          status: "ok",
          listings,
          // The actor sorts newest-first and stops at `count`, so hitting the
          // requested count means older sales exist that we were not shown.
          cappedByProvider: listings.length >= options.count,
        };
      } catch (error) {
        return {
          status: "unavailable",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/* ------------------------------------------------------------ direct eBay */

/**
 * Deliberately unimplemented. See the module header: eBay's robots.txt
 * disallows the sold-search endpoint, so there is no compliant way to fetch
 * these pages automatically. Registered anyway so the abstraction has a real
 * second member and the reason is discoverable in code.
 */
export function directEbayProvider(): SoldListingsProvider {
  return {
    id: "DIRECT_EBAY",
    label: "Direct eBay sold search (not available)",
    isConfigured: () => false,

    async search() {
      return {
        status: "not-configured",
        reason:
          "eBay robots.txt disallows /sch/ keyword search for all user agents, " +
          "so the sold-search pages cannot be collected automatically. The " +
          "sanctioned source is eBay's Marketplace Insights API (Limited Release).",
      };
    },
  };
}

/* ---------------------------------------------------------------- registry */

export function getProvider(id: ProviderId, token?: string): SoldListingsProvider {
  switch (id) {
    case "APIFY":
      return apifyProvider(token);
    case "DIRECT_EBAY":
      return directEbayProvider();
  }
}

/**
 * The provider historical collection uses unless told otherwise.
 * Apify remains the only working source.
 */
export const DEFAULT_PROVIDER: ProviderId = "APIFY";
