/**
 * Card lookup orchestration.
 *
 *   TCGdex  ->  normalized card  ->  TCGplayer pricing / image available?
 *                                      yes -> keep TCGdex data
 *                                      no  -> TCGCSV fallback
 *                                -> normalized card -> UI
 *
 * TCGdex stays the primary source for identity, pricing and images. TCGCSV is
 * only consulted for the gaps, which happens for subset releases such as
 * Trainer Gallery. Search and single-card lookup share the same fallback so
 * normalization never diverges between them.
 */

import { lookupCard, type TcgcsvPrices } from "./tcgcsv";
import {
  getTcgdexCard,
  searchTcgdexCards,
  type CardIdentity,
  type CardPricing,
  type CardResult,
  type TcgdexCard,
} from "./tcgdex";

export { TcgdexError, printedNumber } from "./tcgdex";
export type { CardPricing, CardResult, ListingPrices, PriceSource } from "./tcgdex";

/** Same market-vs-listings rule as the primary source: `mid` is never a market price. */
function toPricing(prices: TcgcsvPrices): CardPricing {
  const listings =
    prices.low !== null || prices.mid !== null || prices.high !== null
      ? { low: prices.low, mid: prices.mid, high: prices.high }
      : null;

  if (prices.market !== null) {
    return { kind: "market", market: prices.market, listings };
  }

  if (listings) return { kind: "listings", ...listings };

  return { kind: "none" };
}

/** Fills pricing and/or image gaps from TCGCSV using a single product match. */
async function withFallback({ card, identity }: TcgdexCard): Promise<CardResult> {
  const needsPricing = card.pricing.kind === "none";
  const needsImage = !card.imageUrl;

  // TCGdex covered everything, or there is no number to match on.
  if ((!needsPricing && !needsImage) || !identity.localId) return card;

  try {
    const lookup = await lookupCard(identity);
    if (lookup.status !== "matched") return card;

    let filled = card;

    if (needsPricing && lookup.match.prices) {
      const pricing = toPricing(lookup.match.prices);
      if (pricing.kind !== "none") {
        filled = { ...filled, pricing, priceSource: "tcgcsv" };
      }
    }

    if (needsImage && lookup.match.imageUrl) {
      filled = { ...filled, imageUrl: lookup.match.imageUrl };
    }

    return filled;
  } catch (error) {
    // The fallback is best-effort; a failure must not fail the lookup.
    console.warn(`TCGCSV fallback failed for ${card.id}:`, error);
    return card;
  }
}

export async function searchCards(rawQuery: string): Promise<CardResult[]> {
  const results = await searchTcgdexCards(rawQuery);
  return Promise.all(results.map(withFallback));
}

export async function getCardById(id: string): Promise<CardResult | null> {
  const result = await getCardWithIdentity(id);
  return result ? result.card : null;
}

/**
 * Card plus the structured identity used for TCGCSV matching. The price-history
 * layer needs the identity to resolve the exact TCGplayer product and print,
 * and reuses the same matcher as the pricing fallback rather than its own.
 */
export async function getCardWithIdentity(
  id: string,
): Promise<{ card: CardResult; identity: CardIdentity } | null> {
  const result = await getTcgdexCard(id);
  if (!result) return null;

  return { card: await withFallback(result), identity: result.identity };
}
