/**
 * Comparing a seller's asking price against a Recommended Buy result.
 *
 * No thresholds live here. The verdict comes from `rateDeal` in
 * lib/recommended-buy.ts; this module only parses user input and turns the
 * verdict into a sentence. Kept out of React so every case can be asserted
 * without rendering anything.
 */

import { formatUsd } from "./currency";
import { rateDeal, type DealRating, type RecommendedBuyResult } from "./recommended-buy";

/**
 * Reads a hand-typed USD amount.
 *
 * Accepts "1500", "1575.50", "$1,575". Rejects anything that would put a
 * NaN, an Infinity, or a non-positive number into a price comparison —
 * returning null rather than throwing, so the caller decides the wording.
 */
export function parseAskingPrice(raw: string): number | null {
  // Only the currency symbol and surrounding space are removed. Internal
  // whitespace ("1 500") is left to fail validation: in a US price field that
  // is far more likely a typo than a thousands separator, and a rejected entry
  // invites a correction where a guessed one does not.
  const cleaned = raw.trim().replace(/\$/g, "").trim();
  if (cleaned === "") return null;

  // Commas are validated before being removed rather than simply stripped:
  // stripping first turns "1,,5" into a confident $15, which is worse than
  // rejecting it. No exponents and no signs — this is a shop price.
  const plain = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
  const grouped = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
  if (!plain.test(cleaned) && !grouped.test(cleaned)) return null;

  const value = Number(cleaned.replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

export interface DealAssessment {
  rating: DealRating;
  /** The figures being compared, already rounded for display. */
  askingPrice: number;
  recommendedBuy: number;
  marketReference: number;
  /** Plain-English justification, derived from the actual difference. */
  explanation: string;
}

/**
 * Rates an asking price against a group's recommendation.
 *
 * Comparison uses the DISPLAYED figures rather than the unrounded ones. The
 * two differ by at most the rounding step, and using them keeps the panel
 * self-consistent: a reader who subtracts the numbers on screen gets the
 * number in the sentence. Rounding stays a display concern — the engine's own
 * values are untouched.
 *
 * Returns null when the engine refused the group; a refusal must never be
 * turned into a buy signal.
 */
export function assessAskingPrice(
  askingPrice: number,
  result: RecommendedBuyResult,
): DealAssessment | null {
  if (result.status !== "AVAILABLE") return null;
  if (!Number.isFinite(askingPrice) || askingPrice <= 0) return null;

  const recommendedBuy = result.recommendedBuyDisplay;
  const marketReference = result.marketReferenceDisplay;
  const rating = rateDeal(askingPrice, recommendedBuy, marketReference);

  // Rounded to cents so a typed "1575.50" reports "$74.50", not "$74.4999…".
  const round = (value: number) => Math.round(value * 100) / 100;
  const belowBuy = round(recommendedBuy - askingPrice);
  const aboveBuy = round(askingPrice - recommendedBuy);
  const aboveReference = round(askingPrice - marketReference);

  let explanation: string;
  switch (rating) {
    case "GREAT BUY":
    case "GOOD BUY":
      explanation =
        belowBuy > 0
          ? `${formatUsd(belowBuy)} below our Recommended Buy price.`
          : "Exactly at our Recommended Buy price.";
      break;
    case "FAIR":
      explanation =
        `${formatUsd(aboveBuy)} above our Recommended Buy price, but still below ` +
        `the ${formatUsd(marketReference)} Market Reference.`;
      break;
    case "ABOVE MARKET":
      explanation = `${formatUsd(aboveReference)} above the current Market Reference.`;
      break;
  }

  return { rating, askingPrice, recommendedBuy, marketReference, explanation };
}

/**
 * Why the checker cannot rate anything for this group.
 *
 * Reuses the panel's own refusal message so the two can never drift into
 * saying different things about the same group.
 */
export function dealCheckUnavailableReason(
  result: RecommendedBuyResult,
): string | null {
  if (result.status === "AVAILABLE") return null;
  return `Deal rating unavailable — ${result.message.charAt(0).toLowerCase()}${result.message.slice(1)}`;
}
