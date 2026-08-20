/**
 * Semantic fallback classifier (LangChain + Anthropic).
 *
 * The ONLY place that talks to a model, and it answers exactly one question:
 * does this listing appear to be for the exact target card?
 *
 * Deliberate non-goals — all of these stay deterministic:
 *  - condition, language, grading company/grade
 *  - set matching
 *  - anything involving price
 *
 * The model is never given a price, so price cannot leak into relevance.
 */

import { ChatAnthropic } from "@langchain/anthropic";
import * as z from "zod";
import type { ClassifiedListing, ClassifierCard } from "./listing-classifier";
import type { CompetingCard } from "./tcgdex";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const REQUEST_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const RELEVANT_VALUES = ["YES", "NO", "UNCERTAIN"] as const;
const TARGET_MATCH_VALUES = ["EXACT", "LIKELY", "UNLIKELY", "UNKNOWN"] as const;

/** The model may only answer in this shape; prose never reaches the app. */
export const SemanticVerdictSchema = z.object({
  relevant: z
    .enum(RELEVANT_VALUES)
    .describe(
      'Exactly one of "YES", "NO", "UNCERTAIN". Did this listing sell the exact target card? Use "UNCERTAIN" when the title cannot settle it.',
    ),
  targetMatch: z
    .enum(TARGET_MATCH_VALUES)
    .describe(
      'Exactly one of "EXACT", "LIKELY", "UNLIKELY", "UNKNOWN". How well the title identifies the target card specifically. Use "UNKNOWN" when unsure — never "UNCERTAIN", which is not valid here.',
    ),
  reason: z
    .string()
    .max(400)
    .describe("One short sentence (aim for under 200 characters) citing only words present in the listing title."),
  confidence: z.number().min(0).max(1).describe("Confidence in this verdict, 0 to 1."),
});

export type SemanticVerdict = z.infer<typeof SemanticVerdictSchema>;

const SYSTEM_PROMPT = `You decide whether an eBay listing sold one exact Pokémon card.

A deterministic rule engine has already run and handles condition, language,
grading, set matching and pricing. You are consulted only when it could not
settle the card's identity, and you answer only the identity question.

Hard rules:
- Judge ONLY from the listing title and the card facts given.
- NEVER infer or report condition, language, grade, or price. They are not
  your job and are not in your answer.
- The target card is not privileged. It is one candidate among those listed.
  If the title fits another candidate as well as (or better than) the target,
  say so. Do not select the target just because it was named first.
- If exactly one candidate exists and the title matches its name and set, the
  title does identify it — absence of competitors is real evidence.
- If several candidates fit and the title lacks a distinguishing number, the
  correct answer is relevant UNCERTAIN with targetMatch UNKNOWN. Abstaining is
  a correct, useful answer — prefer it to a guess.
- A number that is clearly a grade ("PSA 3", "CGC 8") is not a card number.
- Reject listings selling something other than the single card (raffles, lots,
  proxies, custom art, accessories, empty slabs, novelty metal/jumbo versions).

Field vocabularies are fixed and closed. Use exactly these values:
- relevant: YES | NO | UNCERTAIN
- targetMatch: EXACT | LIKELY | UNLIKELY | UNKNOWN
"UNCERTAIN" is valid ONLY for relevant. For targetMatch, unsure is UNKNOWN.
Never invent a value outside these lists. relevant and targetMatch must agree:
do not answer EXACT alongside NO, or UNLIKELY alongside YES.`;

export interface SemanticRequest {
  card: ClassifierCard;
  listing: ClassifiedListing;
  /** Other cards a listing could plausibly mean instead. */
  competing: CompetingCard[];
  /** Why the rules could not settle it. */
  ambiguityReason: string;
}

function describeCandidates(
  card: ClassifierCard,
  competing: CompetingCard[],
): string {
  const printed = (number: string, total: number | null) =>
    total ? `${number}/${total}` : number;

  const lines = [
    `  - ${card.name} — ${card.setName} — #${printed(card.number, card.printedTotal)}  [TARGET]`,
    ...competing.map(
      (entry) =>
        `  - ${entry.name} — ${entry.setName} — #${printed(entry.number, entry.printedTotal)}  [other card in the same set]`,
    ),
  ];

  if (competing.length === 0) {
    lines.push("  (no other card in this set shares the target's name)");
  }

  return lines.join("\n");
}

function buildUserPrompt(request: SemanticRequest): string {
  const { card, listing, competing, ambiguityReason } = request;

  return [
    "CANDIDATE CARDS",
    describeCandidates(card, competing),
    "",
    "LISTING TITLE",
    `  ${listing.title}`,
    "",
    "DETECTED LANGUAGE (determined deterministically — treat as given, do not revise)",
    `  listing: ${listing.language}   target printing: EN`,
    "",
    "WHY THE RULES COULD NOT SETTLE IT",
    `  ${ambiguityReason}`,
    "",
    "Answer: does the title uniquely identify the TARGET card, identify a",
    "different candidate, or provide insufficient evidence to tell?",
  ].join("\n");
}

function buildModel() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const model = new ChatAnthropic({
    model: process.env.LLM_MODEL || DEFAULT_MODEL,
    apiKey,
    temperature: 0,
    maxRetries: 1,
  });

  return model.withStructuredOutput(SemanticVerdictSchema, {
    name: "listing_identity_verdict",
  });
}

let cachedModel: ReturnType<typeof buildModel> | undefined;

function getModel() {
  if (cachedModel === undefined) cachedModel = buildModel();
  return cachedModel;
}

interface CacheEntry {
  expiresAt: number;
  value: Promise<SemanticVerdict | null>;
}

/** The same listing must not be re-sent to the model on every page view. */
const cache = new Map<string, CacheEntry>();

export function isSemanticReviewConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function semanticModelName(): string {
  return process.env.LLM_MODEL || DEFAULT_MODEL;
}

async function requestVerdict(request: SemanticRequest): Promise<SemanticVerdict | null> {
  const model = getModel();
  if (!model) return null;

  try {
    const result = await model.invoke(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(request) },
      ],
      { timeout: REQUEST_TIMEOUT_MS },
    );

    // Parse again so an out-of-vocabulary value can never widen the app's
    // interface — a failure here returns null and the rules stand.
    return SemanticVerdictSchema.parse(result);
  } catch (error) {
    console.warn("Semantic review failed:", error);
    return null;
  }
}

/** Returns null on any failure so callers keep the deterministic result. */
export async function classifySemantically(
  request: SemanticRequest,
): Promise<SemanticVerdict | null> {
  const key = `${request.card.setName}|${request.card.number}|${request.listing.title}`;

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const value = requestVerdict(request);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  value.catch(() => cache.delete(key));

  return value;
}
