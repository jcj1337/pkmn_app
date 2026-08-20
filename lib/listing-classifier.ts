/**
 * Deterministic classification of eBay sold listings.
 *
 * Rule-based on purpose: every decision must be inspectable and explainable
 * before any model is involved. No pricing signals are used — a listing is
 * never rejected for being cheap or expensive.
 */

import { numberKey } from "./tcgdex";
import type { SoldListing } from "./ebay-sold";

export type GradingCompany = "PSA" | "BGS" | "CGC" | "SGC" | "ACE" | "OTHER";
export type RawCondition = "NM" | "LP" | "MP" | "HP" | "DMG";

export type Language =
  | "EN" | "JP" | "DE" | "FR" | "ES" | "IT" | "KO" | "ZH" | "UNKNOWN";

/**
 * EXACT   — the title names the target set.
 * CONFLICT— the title names a different set.
 * UNKNOWN — no set named; never a reason to reject.
 */
export type SetMatch = "EXACT" | "CONFLICT" | "UNKNOWN";

/**
 * How strongly the printed number was evidenced in the title.
 * FRACTION/DECLARED are explicit; BARE is a loose token match.
 */
export type NumberEvidence = "FRACTION" | "DECLARED" | "BARE" | "NONE";

/**
 * Print run a listing claims. Read from explicit title evidence only — never
 * from price, and never assumed from the era. A vintage card with no edition
 * word stays UNKNOWN, because it genuinely could be either.
 */
export type Edition =
  | "FIRST_EDITION" | "SHADOWLESS" | "UNLIMITED" | "OTHER" | "UNKNOWN";

/**
 * Physical printing of the card. Holo and Reverse Holo are different products
 * that trade at different prices, so they are never collapsed.
 */
export type PrintVariant =
  | "HOLO" | "REVERSE_HOLO" | "NON_HOLO" | "OTHER" | "UNKNOWN";

export interface ClassifiedListing extends SoldListing {
  relevant: boolean;
  relevanceReason: string;
  gradingCompany: GradingCompany | null;
  grade: number | null;
  isGraded: boolean;
  rawCondition: RawCondition | null;
  language: Language;
  setMatch: SetMatch;
  numberEvidence: NumberEvidence;
  edition: Edition;
  printVariant: PrintVariant;
  category: string;
  confidence: number;
}

export interface ClassifyOptions {
  /**
   * Vocabulary of known set names (from TCGdex) used to detect set conflicts.
   * Without it, set matching can only ever be EXACT or UNKNOWN.
   */
  knownSetNames?: string[];
}

/** Card context the classifier matches listings against. */
export interface ClassifierCard {
  name: string;
  number: string;
  printedTotal: number | null;
  setName: string;
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

/** Words, lowercased, with punctuation and emoji stripped. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/* ------------------------------------------------------------------ */
/* Language                                                            */
/* ------------------------------------------------------------------ */

/**
 * Language is read from explicit title evidence only — never from price and
 * never assumed. A non-English card is a real sale, just not an English comp,
 * so this classifies rather than rejects.
 */
const LANGUAGE_RULES: { pattern: RegExp; language: Language }[] = [
  // Kana are unique to Japanese; kanji alone are shared with Chinese.
  { pattern: /[぀-ヿ]|\bjapan(?:ese)?\b|\bjpn\b|\bjp\b/i, language: "JP" },
  { pattern: /[가-힯]|\bkorean?\b/i, language: "KO" },
  { pattern: /\bchinese\b|\bsimplified\b/i, language: "ZH" },
  { pattern: /\bgerman[ye]?\b|\bdeutsch\b/i, language: "DE" },
  { pattern: /\bfrench\b|\bfran[cç]ais\b/i, language: "FR" },
  { pattern: /\bspanish\b|\bespa[nñ]ol\b/i, language: "ES" },
  { pattern: /\bitalian[o]?\b/i, language: "IT" },
  { pattern: /\benglish\b|\beng\b/i, language: "EN" },
];

export function parseLanguage(title: string): Language {
  for (const rule of LANGUAGE_RULES) {
    if (rule.pattern.test(title)) return rule.language;
  }
  return "UNKNOWN";
}

/* ------------------------------------------------------------------ */
/* Edition                                                             */
/* ------------------------------------------------------------------ */

/**
 * Order matters. Every 1st Edition Base Set card is also shadowless, so the
 * more specific claim wins; "Unlimited" is only reached when neither of the
 * earlier two is stated.
 */
const EDITION_RULES: { pattern: RegExp; edition: Edition }[] = [
  { pattern: /\b(?:1st|first)\s*[-.]?\s*ed(?:ition|tion|n)?\b/i, edition: "FIRST_EDITION" },
  { pattern: /\bshadow\s*-?\s*less\b/i, edition: "SHADOWLESS" },
  { pattern: /\bunlimited\b/i, edition: "UNLIMITED" },
  // Stated print runs we do not model separately, but which are still not
  // interchangeable with the three above.
  { pattern: /\b(?:2nd|second|3rd|third|4th)\s*(?:ed(?:ition)?|print(?:ing)?)\b/i, edition: "OTHER" },
];

/**
 * No era gate is applied. Across the 460 saved listings, edition words appear
 * in vintage titles only (40 first-edition, 29 unlimited, 12 shadowless) and
 * in zero modern ones, so title evidence is already era-correct and a
 * hardcoded set list would add risk without changing an answer.
 */
export function parseEdition(title: string): Edition {
  for (const rule of EDITION_RULES) {
    if (rule.pattern.test(title)) return rule.edition;
  }
  return "UNKNOWN";
}

/* ------------------------------------------------------------------ */
/* Print variant                                                       */
/* ------------------------------------------------------------------ */

/**
 * Order matters: "non-holo" and "reverse holo" both contain "holo", so the
 * qualified forms must be tested before the bare one.
 *
 * A lone "foil" is deliberately not evidence of anything — it shows up in
 * "gold foil" novelty prints as often as in real holo cards, so it is only
 * read when qualified by "reverse" or "holo".
 */
const VARIANT_RULES: { pattern: RegExp; variant: PrintVariant }[] = [
  { pattern: /\bnon[\s-]*holo\w*\b|\bnot\s+holo\w*\b/i, variant: "NON_HOLO" },
  { pattern: /\brev(?:erse)?\.?\s*-?\s*(?:holo\w*|foil)\b/i, variant: "REVERSE_HOLO" },
  // Scarlet & Violet ball-pattern reverses are their own market.
  { pattern: /\b(?:master|poke|great|ultra)\s*-?\s*ball\b(?:\s*(?:pattern|holo|reverse|rev))?/i, variant: "OTHER" },
  { pattern: /\bholo(?:foil|graphic)?\b/i, variant: "HOLO" },
];

export function parsePrintVariant(title: string): PrintVariant {
  for (const rule of VARIANT_RULES) {
    if (rule.pattern.test(title)) return rule.variant;
  }
  return "UNKNOWN";
}

/* ------------------------------------------------------------------ */
/* Set matching                                                        */
/* ------------------------------------------------------------------ */

/**
 * Short set names ("151", "Gym") collide with ordinary title text, so only
 * reasonably distinctive names are used as conflict evidence.
 */
const MIN_SET_NAME_LENGTH = 6;

export function matchSet(
  title: string,
  card: ClassifierCard,
  knownSetNames?: string[],
): SetMatch {
  const squashedTitle = squash(title);
  const target = squash(card.setName);

  if (target.length > 0 && squashedTitle.includes(target)) return "EXACT";

  if (!knownSetNames) return "UNKNOWN";

  const conflicting = knownSetNames.some((name) => {
    const candidate = squash(name);
    if (candidate.length < MIN_SET_NAME_LENGTH || candidate === target) return false;

    // Overlapping names are not evidence of a different set in either
    // direction: a subset ("Lost Origin Trainer Gallery") legitimately
    // mentions its parent ("Lost Origin"), and vice versa.
    if (candidate.includes(target) || target.includes(candidate)) return false;

    return squashedTitle.includes(candidate);
  });

  return conflicting ? "CONFLICT" : "UNKNOWN";
}

/* ------------------------------------------------------------------ */
/* Grading                                                             */
/* ------------------------------------------------------------------ */

const COMPANY_ALIASES: Record<string, GradingCompany> = {
  psa: "PSA",
  bgs: "BGS",
  beckett: "BGS",
  cgc: "CGC",
  sgc: "SGC",
  ace: "ACE",
};

/**
 * Company followed by an optional qualifier and a numeric grade.
 *
 * Matches "PSA 10", "PSA10", "BGS 9.5", "Beckett 9.5", "CGC Pristine 10".
 * There is deliberately no word boundary after the company so the unspaced
 * form ("PSA10") still parses.
 */
const GRADED_BY_COMPANY =
  /\b(psa|bgs|beckett|cgc|sgc|ace)[\s.:#-]*(?:pristine|gem\s*mint|gem|mint|black\s*label|perfect)?[\s.:#-]*(10(?:\.0)?|\d(?:\.5)?)\b/i;

/** "GRADE 10" / "GRADED 9.5" with no company named. */
const GRADED_GENERIC = /\bgraded?\b[\s.:#-]*(10(?:\.0)?|\d(?:\.5)?)\b/i;

/** Bare "graded" with no number at all. */
const GRADED_BARE = /\bgraded\b/i;

/** A company named without a grade, as in "PSA Graded". */
const COMPANY_ONLY = /\b(psa|bgs|beckett|cgc|sgc|ace)\b/i;

export interface GradeInfo {
  company: GradingCompany | null;
  grade: number | null;
  isGraded: boolean;
}

/** Reusable grade parser — add companies by extending COMPANY_ALIASES. */
export function parseGrade(title: string): GradeInfo {
  const byCompany = title.match(GRADED_BY_COMPANY);
  if (byCompany) {
    const grade = Number(byCompany[2]);
    return {
      company: COMPANY_ALIASES[byCompany[1].toLowerCase()] ?? "OTHER",
      grade: Number.isFinite(grade) && grade >= 1 && grade <= 10 ? grade : null,
      isGraded: true,
    };
  }

  const generic = title.match(GRADED_GENERIC);
  if (generic) {
    const grade = Number(generic[1]);
    return {
      company: "OTHER",
      grade: Number.isFinite(grade) && grade >= 1 && grade <= 10 ? grade : null,
      isGraded: true,
    };
  }

  if (GRADED_BARE.test(title)) {
    // "PSA Graded" names the company even though no grade is given; keeping it
    // is strictly better than reporting an unknown grader.
    const named = title.match(COMPANY_ONLY);
    return {
      company: named ? (COMPANY_ALIASES[named[1].toLowerCase()] ?? "OTHER") : "OTHER",
      grade: null,
      isGraded: true,
    };
  }

  return { company: null, grade: null, isGraded: false };
}

/* ------------------------------------------------------------------ */
/* Raw condition                                                       */
/* ------------------------------------------------------------------ */

const CONDITION_RULES: { pattern: RegExp; condition: RawCondition }[] = [
  { pattern: /\bdamaged?\b|\bdmg\b|\bpoor\b/i, condition: "DMG" },
  // "HP" only counts when it is not a hit-point value ("310 HP").
  { pattern: /\bheav(?:y|ily)\s*play(?:ed)?\b|(?<![\d]\s?)\bhp\b/i, condition: "HP" },
  { pattern: /\bmoderate(?:ly)?\s*play(?:ed)?\b|\bmp\b/i, condition: "MP" },
  { pattern: /\blight(?:ly)?\s*play(?:ed)?\b|\blp\b/i, condition: "LP" },
  { pattern: /\bnear\s*mint\b|\bnm\b|\bmint\b/i, condition: "NM" },
];

/** Most-damaged wins, so "NM/LP" is treated conservatively as LP. */
export function parseRawCondition(title: string): RawCondition | null {
  for (const rule of CONDITION_RULES) {
    if (rule.pattern.test(title)) return rule.condition;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Relevance                                                           */
/* ------------------------------------------------------------------ */

/** Phrases that mark an item as thrown in rather than being the product. */
const INCLUSION_PREFIX =
  /\b(?:with|w\/|includes?|included|including|free|plus|bonus|comes?\s+with|\+)\s+(?:a\s+|an\s+|the\s+|\d+\s*)?$/i;

/**
 * True when the term appears as the thing being sold, rather than as an
 * accessory bundled with it ("card with toploader" stays a card sale).
 */
function mentionedAsProduct(title: string, pattern: RegExp): boolean {
  const match = title.match(pattern);
  if (!match || match.index === undefined) return false;

  return !INCLUSION_PREFIX.test(title.slice(0, match.index));
}

interface ExclusionRule {
  pattern: RegExp;
  reason: string;
  /** Only exclude when the term is the product, not an included extra. */
  productOnly?: boolean;
  /** Normalized code recorded as the category; defaults to IRRELEVANT. */
  category?: string;
}

const EXCLUSIONS: ExclusionRule[] = [
  {
    /**
     * Signed, sketched or otherwise personalized copies. These are genuine
     * cards, but the signature is the product — an Arita-signed Charizard
     * sold for 22x the unsigned median in the saved data — so they can never
     * be comps for a standard copy.
     *
     * "Stamped" is deliberately absent: every stamped listing in the saved
     * data is a factory or event stamp (E3 stamp, gray stamp, thick stamp,
     * regional stamped promo), which are ordinary printings.
     */
    pattern:
      /\bsigned\b|\bautograph\w*\b|\bauto\b|\bsketch(?:ed|es)?\b|\bartist\s*proof\b|\binscribed\b|\baltered\b|\bhand[\s-]*(?:drawn|painted|numbered)\b/i,
    reason: "Altered, signed or personalized copy",
    category: "ALTERED_OR_SIGNED_COPY",
  },
  {
    /**
     * Aftermarket "art card" prints that copy a card's artwork. Guarded so
     * the legitimate "alternate art" / "illustration" vocabulary is untouched.
     */
    pattern:
      /(?<!\b(?:alt|alternate|full|special|character|trainer|illustration|secret)\s)\bart\s*card\b/i,
    reason: "Art card / novelty print, not the TCG card",
    category: "NOVELTY_PRINT",
  },
  {
    /**
     * Replica cards sold as gold-foil or gold-plated collectibles.
     *
     * Narrow on purpose. Gold Secret Rares and Gold Hyper Rares are real,
     * valuable cards, and sellers describe them as "Gold Secret Rare",
     * "Gold Hyper Rare" or plain "Gold Card" — none of which match here,
     * because the material word (foil/plated/metal) must sit between "gold"
     * and "card". Colour alone is never evidence.
     */
    pattern:
      /\bgold\s*(?:foil|plated|metal(?:lic)?)\s*(?:pok[eé]mon\s*)?card\b|\bgold[\s-]*plated\b|\b24\s*-?\s*k(?:t|arat)?\s*gold\b/i,
    reason: "Gold foil / plated replica, not the TCG card",
    category: "NOVELTY_PRINT",
  },
  {
    pattern:
      /\braffle\b|\brazz\b|\bgiveaway\b|\btest\s*(?:your\s*)?luck\b|\bchance\s*(?:to\s*win|at\b)|\b\d+\s*[-–]\s*\d+\s*chance\b|\bmystery\s*chance\b|\bpick\s*a\s*number\b/i,
    reason: "Raffle or chance-to-win listing",
  },
  {
    pattern: /\bmystery\b|\bgrab\s*bag\b|\bgrab\b|\brandom\b|\bsurprise\b|\brepack\b/i,
    reason: "Mystery / random-contents listing",
  },
  {
    pattern: /\bprox(?:y|ies)\b|\bprxy\b|\breplica\b|\breplik\b|\bcustom\b|\borica\b|\bfan\s*(?:art|made)\b/i,
    reason: "Proxy, replica or custom card",
  },
  {
    pattern: /\bdigital\b|\bcode\s*card\b|\bonline\s*code\b|\bptcgo\b|\bptcgl\b/i,
    reason: "Digital item or online code",
  },
  {
    pattern: /\b(?:choose|pick)\s+(?:your|a|an)\b|\bcomplete\s+your\s+set\b|\byou\s+pick\b|\byour\s+choice\b/i,
    reason: "Pick-your-card listing",
  },
  {
    pattern: /\blots?\b|\bbundle\b|\bplaysets?\b/i,
    reason: "Lot or bundle",
  },
  {
    // "Metal energy" and "metal type" are ordinary card text, not novelties.
    pattern:
      /\bmetal\b(?!\s*(?:energy|type))|\bbox\s*topper\b|\bjumbo\b|\boversiz(?:e|ed)\b|\bbinder\s*insert\b|\bplaque\b/i,
    reason: "Novelty or non-standard product",
  },
  {
    pattern: /\bplaymat\b|\bsleeves?\b|\btoploader\b|\bposter\b|\bsticker\b|\bplush\b/i,
    reason: "Accessory or non-card item",
    productOnly: true,
  },
  {
    pattern: /\bempty\b|\bcase\s*only\b|\bgraded\s*case\b|\bslab\s*only\b|\bnot\s+a\s+card\b/i,
    reason: "Empty case or holder only",
  },
];

/** Any "<number>/<total>" style token, including subset forms like TG17/TG30. */
const FRACTION_PATTERN = /\b([A-Za-z]{0,4}\d{1,4}[A-Za-z]?)\s*\/\s*([A-Za-z]{0,4}\d{1,4}[A-Za-z]?)\b/g;

/**
 * A card number stated without a denominator: "#146", "No.006", "No 249".
 * Treated as an explicit declaration, so a title that names a different one is
 * a different card — otherwise a stray digit elsewhere in the title (a set
 * name like "Gym 2", a year) can masquerade as a match.
 */
const DECLARED_NUMBER = /(?:#|\bno\.?\s*)([A-Za-z]{0,4}\d{1,4}[A-Za-z]?)\b/gi;

interface NumberCheck {
  matched: boolean;
  /** True when the title names a different card number than ours. */
  conflicting: boolean;
  evidence: NumberEvidence;
}

/**
 * The denominator of "10/130" names the set's card count, so it separates
 * reprints that share a number with the original: Base Set 2 Mewtwo is
 * 10/130 while Base Set Mewtwo is 10/102.
 *
 * Only purely numeric denominators are checked. Subset numbering carries the
 * subset prefix ("TG17/TG30") and would not match a printed total.
 */
function denominatorAgrees(denominator: string, card: ClassifierCard): boolean {
  if (card.printedTotal === null) return true;
  if (!/^\d+$/.test(denominator)) return true;
  return Number(denominator) === card.printedTotal;
}

function checkCardNumber(title: string, card: ClassifierCard): NumberCheck {
  const wanted = numberKey(card.number);
  const fractions = [...title.matchAll(FRACTION_PATTERN)];

  if (fractions.length > 0) {
    const matched = fractions.some(
      (match) => numberKey(match[1]) === wanted && denominatorAgrees(match[2], card),
    );
    return { matched, conflicting: !matched, evidence: "FRACTION" };
  }

  const declared = [...title.matchAll(DECLARED_NUMBER)].map((match) =>
    numberKey(match[1]),
  );
  if (declared.length > 0) {
    const matched = declared.includes(wanted);
    return { matched, conflicting: !matched, evidence: "DECLARED" };
  }

  // Nothing declared — accept a bare occurrence of the local number.
  const matched = tokenize(title).includes(wanted.toLowerCase());
  return { matched, conflicting: false, evidence: matched ? "BARE" : "NONE" };
}

/** Every significant word of the card name must appear somewhere in the title. */
function checkCardName(title: string, card: ClassifierCard): boolean {
  const titleTokens = new Set(tokenize(title));
  const squashedTitle = squash(title);

  return tokenize(card.name).every(
    (token) => titleTokens.has(token) || squashedTitle.includes(token),
  );
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

function gradeSlug(grade: number): string {
  return String(grade).replace(".", "_");
}

function clamp(value: number): number {
  return Math.round(Math.min(0.99, Math.max(0.05, value)) * 100) / 100;
}

/**
 * Grading / condition / category for a listing already judged relevant.
 * Shared so a listing rescued by semantic review is described exactly the
 * same way as one accepted by the rules alone.
 */
export function describeAccepted(title: string): {
  gradingCompany: GradingCompany | null;
  grade: number | null;
  isGraded: boolean;
  rawCondition: RawCondition | null;
  category: string;
  relevanceReason: string;
  confidenceAdjustment: number;
} {
  const { company, grade, isGraded } = parseGrade(title);
  // A graded card is not a raw card, so raw condition words are ignored.
  const rawCondition = isGraded ? null : parseRawCondition(title);

  let category: string;
  let confidenceAdjustment: number;

  if (isGraded) {
    if (company && company !== "OTHER" && grade !== null) {
      category = `${company}_${gradeSlug(grade)}`;
      confidenceAdjustment = 0.15;
    } else {
      category = "OTHER_GRADED";
      confidenceAdjustment = -0.15;
    }
  } else if (rawCondition) {
    category = `RAW_${rawCondition}`;
    confidenceAdjustment = 0.1;
  } else {
    category = "RAW_UNKNOWN";
    confidenceAdjustment = -0.1;
  }

  return {
    gradingCompany: company,
    grade,
    isGraded,
    rawCondition,
    category,
    relevanceReason: isGraded
      ? `Graded listing (${company ?? "unknown"}${grade !== null ? ` ${grade}` : ""})`
      : `Raw listing (${rawCondition ?? "condition not stated"})`,
    confidenceAdjustment,
  };
}

export function classifyListing(
  listing: SoldListing,
  card: ClassifierCard,
  options: ClassifyOptions = {},
): ClassifiedListing {
  const title = listing.title ?? "";
  const language = parseLanguage(title);
  const setMatch = matchSet(title, card, options.knownSetNames);
  const numberCheck = checkCardNumber(title, card);

  const base = {
    ...listing,
    gradingCompany: null as GradingCompany | null,
    grade: null as number | null,
    isGraded: false,
    rawCondition: null as RawCondition | null,
    language,
    setMatch,
    numberEvidence: numberCheck.evidence,
    edition: parseEdition(title),
    printVariant: parsePrintVariant(title),
  };

  // --- rejection: explicit non-card listings -----------------------
  for (const rule of EXCLUSIONS) {
    const hit = rule.productOnly
      ? mentionedAsProduct(title, rule.pattern)
      : rule.pattern.test(title);

    if (hit) {
      return {
        ...base,
        relevant: false,
        relevanceReason: rule.reason,
        category: rule.category ?? "IRRELEVANT",
        confidence: 0.9,
      };
    }
  }

  // --- rejection: wrong card ---------------------------------------
  if (!checkCardName(title, card)) {
    return {
      ...base,
      relevant: false,
      relevanceReason: "Card name not found in title",
      category: "IRRELEVANT",
      confidence: 0.8,
    };
  }

  if (numberCheck.conflicting) {
    return {
      ...base,
      relevant: false,
      relevanceReason: "Title names a different card number",
      category: "IRRELEVANT",
      confidence: 0.85,
    };
  }
  if (!numberCheck.matched) {
    return {
      ...base,
      relevant: false,
      relevanceReason: "Printed card number not found in title",
      category: "IRRELEVANT",
      confidence: 0.6,
    };
  }

  // --- rejection: the title names a different set -------------------
  if (setMatch === "CONFLICT") {
    return {
      ...base,
      relevant: false,
      relevanceReason: "Title names a different set",
      category: "IRRELEVANT",
      confidence: 0.8,
    };
  }

  // --- accepted: grading vs raw ------------------------------------
  const accepted = describeAccepted(title);
  let confidence = 0.75 + accepted.confidenceAdjustment; // number confirmed
  if (setMatch === "EXACT") confidence += 0.1;

  return {
    ...base,
    gradingCompany: accepted.gradingCompany,
    grade: accepted.grade,
    isGraded: accepted.isGraded,
    rawCondition: accepted.rawCondition,
    relevant: true,
    relevanceReason: accepted.relevanceReason,
    category: accepted.category,
    confidence: clamp(confidence),
  };
}

export function classifyListings(
  listings: SoldListing[],
  card: ClassifierCard,
  options: ClassifyOptions = {},
): ClassifiedListing[] {
  return listings.map((listing) => classifyListing(listing, card, options));
}

/* ------------------------------------------------------------------ */
/* Comparable groups                                                   */
/* ------------------------------------------------------------------ */

/**
 * Print variants that a seller reliably states.
 *
 * Reverse holo and non-holo are always spelled out, because they are what
 * makes the listing worth distinguishing. "Holo" is not: for a holo rare it
 * is the default printing, so half of genuine listings simply omit it. Those
 * two therefore share a bucket, while the explicit deviations do not.
 *
 * The listing's own `printVariant` field stays faithful either way; this only
 * decides what counts as the same market.
 */
function printGroup(variant: PrintVariant): string {
  switch (variant) {
    case "REVERSE_HOLO":
    case "NON_HOLO":
    case "OTHER":
      return variant;
    default:
      return "STANDARD";
  }
}

/**
 * Language axis of a comparable market.
 *
 * A German or Japanese printing is a different product trading in a different
 * market, so it never counts toward an English comparable. UNKNOWN goes the
 * other way and joins the English group: the detector reports a language only
 * on explicit evidence, so "no language stated" is the ordinary state of an
 * English listing — 133 of the 308 saved comps — and treating it as foreign
 * would empty the main group rather than clean it.
 *
 * This mirrors the Python analysis' ENGLISH_COMPATIBLE set exactly.
 */
function languageGroup(language: Language): string {
  return language === "UNKNOWN" ? "EN" : language;
}

/**
 * Identity of the market a sale belongs to: same card, same condition or
 * grade, same print run, same physical printing, same language.
 *
 * UNKNOWN edition stays its own group. A vintage card with no edition word
 * could be 1st Edition or Unlimited, and those differ by several multiples,
 * so folding it into either would be a guess.
 */
export function comparableGroup(listing: ClassifiedListing): string {
  return [
    listing.category,
    listing.edition,
    printGroup(listing.printVariant),
    languageGroup(listing.language),
  ].join("|");
}
/* ------------------------------------------------------------------ */
/* Grouping for display                                                 */
/* ------------------------------------------------------------------ */

/**
 * One comparable market: same card, same condition or grade, same print run,
 * same physical printing. Keyed by `comparableGroup`, so what the page shows
 * and what the pricing analysis measures can never drift apart.
 */
export interface ListingGroup {
  key: string;
  label: string;
  /** Normalized values, unchanged — for pricing metrics attached later. */
  category: string;
  edition: Edition;
  printGrouping: string;
  /** "EN" (English or unstated) or an explicitly detected foreign language. */
  languageGrouping: string;
  count: number;
  listings: ClassifiedListing[];
}

const COMPANY_ORDER: GradingCompany[] = ["PSA", "BGS", "CGC", "SGC", "ACE"];

const CONDITION_LABELS: Record<RawCondition, string> = {
  NM: "Near Mint",
  LP: "Lightly Played",
  MP: "Moderately Played",
  HP: "Heavily Played",
  DMG: "Damaged",
};

const EDITION_LABELS: Record<Edition, string> = {
  FIRST_EDITION: "1st Edition",
  SHADOWLESS: "Shadowless",
  UNLIMITED: "Unlimited",
  OTHER: "Other edition",
  UNKNOWN: "Edition not stated",
};

const PRINT_LABELS: Record<string, string> = {
  STANDARD: "Standard",
  REVERSE_HOLO: "Reverse Holo",
  NON_HOLO: "Non-Holo",
  OTHER: "Special print",
};

const LANGUAGE_LABELS: Record<string, string> = {
  EN: "English",
  JP: "Japanese",
  DE: "German",
  FR: "French",
  ES: "Spanish",
  IT: "Italian",
  KO: "Korean",
  ZH: "Chinese",
};

/** Condition order for display: best first, unknown last. */
const CONDITION_ORDER: RawCondition[] = ["NM", "LP", "MP", "HP", "DMG"];

/** "PSA 10", "BGS 9.5", "Raw · Near Mint", "Raw". */
function conditionLabel(listing: ClassifiedListing): string {
  if (listing.isGraded) {
    if (listing.gradingCompany && listing.gradingCompany !== "OTHER" && listing.grade !== null) {
      return `${listing.gradingCompany} ${listing.grade}`;
    }
    return listing.grade !== null ? `Graded ${listing.grade}` : "Graded, grade unknown";
  }

  return listing.rawCondition
    ? `Raw · ${CONDITION_LABELS[listing.rawCondition]}`
    : "Raw";
}

/**
 * Raw first, then each grading company by descending grade, then anything
 * that could not be pinned down.
 */
function groupRank(listing: ClassifiedListing): [number, number] {
  if (!listing.isGraded) return [0, 0];

  const companyIndex = listing.gradingCompany
    ? COMPANY_ORDER.indexOf(listing.gradingCompany)
    : -1;

  if (companyIndex === -1 || listing.grade === null) return [99, 0];

  // Negative grade so 10 sorts above 9.
  return [1 + companyIndex, -listing.grade];
}

function conditionRank(listing: ClassifiedListing): number {
  if (listing.isGraded || !listing.rawCondition) return CONDITION_ORDER.length;
  return CONDITION_ORDER.indexOf(listing.rawCondition);
}

/**
 * Splits accepted listings into comparable markets and labels each one.
 *
 * Labels are context-aware: an axis is named only when it carries information
 * for this card. A modern card whose sales are all unqualified reads "Raw",
 * not "Raw · Edition not stated · Standard". As soon as a second edition or a
 * reverse holo shows up, every sibling group names that axis so the
 * distinction is visible rather than implied.
 *
 * Normalized values are never altered to make a label read better.
 */
export function groupClassified(listings: ClassifiedListing[]): ListingGroup[] {
  const accepted = listings.filter((listing) => listing.relevant);
  const groups = new Map<string, ListingGroup>();

  for (const listing of accepted) {
    const key = comparableGroup(listing);
    const group = groups.get(key) ?? {
      key,
      label: "",
      category: listing.category,
      edition: listing.edition,
      printGrouping: printGroup(listing.printVariant),
      languageGrouping: languageGroup(listing.language),
      count: 0,
      listings: [],
    };

    group.listings.push(listing);
    group.count = group.listings.length;
    groups.set(key, group);
  }

  // English markets first, then raw before graded and higher grades first,
  // but within one tier the best-evidenced market leads — that is the group a
  // reader wants by default, and it is what the selector opens on.
  const foreignRank = (group: ListingGroup) => (group.languageGrouping === "EN" ? 0 : 1);

  const ordered = [...groups.values()].sort((a, b) => {
    const [aCompany, aGrade] = groupRank(a.listings[0]);
    const [bCompany, bGrade] = groupRank(b.listings[0]);
    return (
      foreignRank(a) - foreignRank(b) ||
      aCompany - bCompany ||
      aGrade - bGrade ||
      b.count - a.count ||
      conditionRank(a.listings[0]) - conditionRank(b.listings[0]) ||
      a.key.localeCompare(b.key)
    );
  });

  const editionVaries = new Set(ordered.map((group) => group.edition)).size > 1;
  const printVaries = new Set(ordered.map((group) => group.printGrouping)).size > 1;

  for (const group of ordered) {
    const parts = [conditionLabel(group.listings[0])];

    if (editionVaries || group.edition !== "UNKNOWN") {
      parts.push(EDITION_LABELS[group.edition]);
    }
    if (printVaries || group.printGrouping !== "STANDARD") {
      parts.push(PRINT_LABELS[group.printGrouping] ?? group.printGrouping);
    }
    // Named only when foreign. Every English group would otherwise carry a
    // label that says nothing, and the English market is the default reading.
    if (group.languageGrouping !== "EN") {
      parts.push(LANGUAGE_LABELS[group.languageGrouping] ?? group.languageGrouping);
    }

    group.label = parts.join(" · ");
  }

  return ordered;
}
