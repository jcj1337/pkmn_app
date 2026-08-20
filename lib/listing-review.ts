/**
 * Orchestration: deterministic rules first, semantic fallback only where the
 * rules genuinely could not decide.
 *
 *   listing -> deterministic classifier
 *           -> confident?  keep it
 *           -> ambiguous?  optional LLM second opinion -> merged result
 *
 * The deterministic classifier stays primary and knows nothing about LangChain.
 */

import {
  classifyListings,
  describeAccepted,
  type ClassifiedListing,
  type ClassifierCard,
  type ClassifyOptions,
} from "./listing-classifier";
import {
  classifySemantically,
  isSemanticReviewConfigured,
  type SemanticVerdict,
} from "./llm-listing-classifier";
import { getCompetingCards } from "./tcgdex";
import type { SoldListing } from "./ebay-sold";

export interface ReviewedListing extends ClassifiedListing {
  /** Verdict source. "rules" means the model was never consulted. */
  decidedBy: "rules" | "rules+llm";
  semanticVerdict: SemanticVerdict | null;
  /** Why the listing was sent for semantic review, if it was. */
  ambiguityReason: string | null;
  /** Deterministic verdict, retained for comparison. */
  deterministic: { relevant: boolean; category: string; relevanceReason: string };
}

/**
 * Rejections the rules make on explicit evidence. These are never re-litigated
 * by the model — the title states a conflicting number/set, or the item plainly
 * is not a single card.
 */
const HARD_REJECTIONS = new Set([
  "Raffle or chance-to-win listing",
  "Mystery / random-contents listing",
  "Proxy, replica or custom card",
  "Digital item or online code",
  "Pick-your-card listing",
  "Lot or bundle",
  "Novelty or non-standard product",
  "Accessory or non-card item",
  "Empty case or holder only",
  "Title names a different card number",
  "Title names a different set",
]);

/** Soft rejections: plausible false negatives worth a second opinion. */
const SOFT_REJECTIONS = new Set([
  "Card name not found in title",
  "Printed card number not found in title",
]);

/**
 * Non-Latin script is real evidence of a non-English printing. Accented Latin
 * is not: "Pokémon" is spelled with an accent in ordinary English listings.
 */
const NON_LATIN_SCRIPT = /[Ѐ-ӿ぀-ヿ㐀-鿿가-힯]/u;

/**
 * Returns why a listing needs semantic review, or null if the rules already
 * settled it. Deliberately does NOT trigger on missing condition: absent
 * condition is absent data, and no model should invent it.
 */
export function semanticReviewReason(listing: ClassifiedListing): string | null {
  if (!listing.relevant) {
    if (HARD_REJECTIONS.has(listing.relevanceReason)) return null;
    if (SOFT_REJECTIONS.has(listing.relevanceReason)) {
      return `Rules rejected it ("${listing.relevanceReason}") but the evidence is weak, so it may be a false negative.`;
    }
    return null;
  }

  if (listing.numberEvidence === "BARE") {
    return "The printed number matched only as a loose token, so card identity is uncertain.";
  }

  if (listing.setMatch === "UNKNOWN" && listing.confidence < 0.75) {
    return "No set named and overall confidence is low, so the exact printing is uncertain.";
  }

  const title = listing.title ?? "";
  if (listing.language === "UNKNOWN" && NON_LATIN_SCRIPT.test(title)) {
    return "Title uses a non-Latin script but states no language.";
  }

  return null;
}

export interface ReviewOptions extends ClassifyOptions {
  /** Consult the model. Off unless explicitly enabled. */
  enableSemanticReview?: boolean;
  /** Safety valve on spend per batch. */
  maxSemanticCalls?: number;
}

/**
 * Rescues are the dangerous direction: a wrong rescue injects a bad comp into
 * pricing, while a missed rescue only loses one data point. So a rescue needs
 * the model's strongest answer, and LIKELY deliberately does not qualify.
 */
const RESCUE_MIN_CONFIDENCE = 0.8;
const REJECT_MIN_CONFIDENCE = 0.7;

/** Applies a verdict on top of the deterministic result, conservatively. */
function merge(
  listing: ClassifiedListing,
  verdict: SemanticVerdict,
  ambiguityReason: string,
): ReviewedListing {
  const base: ReviewedListing = {
    ...listing,
    decidedBy: "rules+llm",
    semanticVerdict: verdict,
    ambiguityReason,
    deterministic: {
      relevant: listing.relevant,
      category: listing.category,
      relevanceReason: listing.relevanceReason,
    },
    // language, setMatch, grading and condition are NOT taken from the model.
  };

  // A non-English printing is a different product from the English card we
  // price, and the deterministic detector already knows which it is. The model
  // is explicitly not asked about language, so it cannot be trusted to catch
  // this — block the rescue here instead.
  const foreignPrinting = listing.language !== "EN" && listing.language !== "UNKNOWN";

  // Rescue only on the strongest possible answer: YES *and* EXACT.
  // LIKELY is recorded for evaluation but never acts.
  if (
    !foreignPrinting &&
    !listing.relevant &&
    verdict.relevant === "YES" &&
    verdict.targetMatch === "EXACT" &&
    verdict.confidence >= RESCUE_MIN_CONFIDENCE
  ) {
    const accepted = describeAccepted(listing.title ?? "");
    return {
      ...base,
      relevant: true,
      gradingCompany: accepted.gradingCompany,
      grade: accepted.grade,
      isGraded: accepted.isGraded,
      rawCondition: accepted.rawCondition,
      category: accepted.category,
      relevanceReason: `Semantic review: ${verdict.reason}`,
      confidence: Math.min(0.9, verdict.confidence),
    };
  }

  // Reinforcing a rejection is the safe direction, so it needs less.
  if (
    listing.relevant &&
    (verdict.relevant === "NO" || verdict.targetMatch === "UNLIKELY") &&
    verdict.confidence >= REJECT_MIN_CONFIDENCE
  ) {
    return {
      ...base,
      relevant: false,
      category: "IRRELEVANT",
      relevanceReason: `Semantic review: ${verdict.reason}`,
      confidence: Math.min(0.9, verdict.confidence),
    };
  }

  // UNCERTAIN / UNKNOWN / LIKELY, or not confident enough: rules stand.
  return base;
}

export async function reviewListings(
  listings: SoldListing[],
  card: ClassifierCard,
  options: ReviewOptions = {},
): Promise<ReviewedListing[]> {
  const classified = classifyListings(listings, card, options);

  const asReviewed = (listing: ClassifiedListing): ReviewedListing => ({
    ...listing,
    decidedBy: "rules",
    semanticVerdict: null,
    ambiguityReason: semanticReviewReason(listing),
    deterministic: {
      relevant: listing.relevant,
      category: listing.category,
      relevanceReason: listing.relevanceReason,
    },
  });

  if (!options.enableSemanticReview || !isSemanticReviewConfigured()) {
    return classified.map(asReviewed);
  }

  const budget = options.maxSemanticCalls ?? classified.length;
  let spent = 0;

  return Promise.all(
    classified.map(async (listing) => {
      const reason = semanticReviewReason(listing);
      if (!reason || spent >= budget) return asReviewed(listing);

      spent += 1;
      // Competing cards come from one cached set fetch; failure just means
      // the model sees the target alone.
      const competing = await getCompetingCards(card).catch(() => []);
      const verdict = await classifySemantically({
        card,
        listing,
        competing,
        ambiguityReason: reason,
      });

      // Any failure leaves the deterministic result untouched.
      return verdict ? merge(listing, verdict, reason) : asReviewed(listing);
    }),
  );
}
