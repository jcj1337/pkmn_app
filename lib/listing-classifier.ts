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

export interface ClassifiedListing extends SoldListing {
  relevant: boolean;
  relevanceReason: string;
  gradingCompany: GradingCompany | null;
  grade: number | null;
  isGraded: boolean;
  rawCondition: RawCondition | null;
  language: Language;
  setMatch: SetMatch;
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
}

const EXCLUSIONS: ExclusionRule[] = [
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
}

function checkCardNumber(title: string, card: ClassifierCard): NumberCheck {
  const wanted = numberKey(card.number);
  const fractions = [...title.matchAll(FRACTION_PATTERN)];

  if (fractions.length > 0) {
    const matched = fractions.some((match) => numberKey(match[1]) === wanted);
    return { matched, conflicting: !matched };
  }

  const declared = [...title.matchAll(DECLARED_NUMBER)].map((match) =>
    numberKey(match[1]),
  );
  if (declared.length > 0) {
    const matched = declared.includes(wanted);
    return { matched, conflicting: !matched };
  }

  // Nothing declared — accept a bare occurrence of the local number.
  const matched = tokenize(title).includes(wanted.toLowerCase());
  return { matched, conflicting: false };
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

export function classifyListing(
  listing: SoldListing,
  card: ClassifierCard,
  options: ClassifyOptions = {},
): ClassifiedListing {
  const title = listing.title ?? "";
  const language = parseLanguage(title);
  const setMatch = matchSet(title, card, options.knownSetNames);

  const base = {
    ...listing,
    gradingCompany: null as GradingCompany | null,
    grade: null as number | null,
    isGraded: false,
    rawCondition: null as RawCondition | null,
    language,
    setMatch,
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
        category: "IRRELEVANT",
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

  const numberCheck = checkCardNumber(title, card);
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
  const { company, grade, isGraded } = parseGrade(title);
  // A graded card is not a raw card, so raw condition words are ignored.
  const rawCondition = isGraded ? null : parseRawCondition(title);

  let confidence = 0.5;
  confidence += 0.25; // printed number confirmed
  if (setMatch === "EXACT") confidence += 0.1;

  let category: string;

  if (isGraded) {
    if (company && company !== "OTHER" && grade !== null) {
      category = `${company}_${gradeSlug(grade)}`;
      confidence += 0.15;
    } else {
      category = "OTHER_GRADED";
      confidence -= 0.15;
    }
  } else if (rawCondition) {
    category = `RAW_${rawCondition}`;
    confidence += 0.1;
  } else {
    category = "RAW_UNKNOWN";
    confidence -= 0.1;
  }

  return {
    ...base,
    gradingCompany: company,
    grade,
    isGraded,
    rawCondition,
    relevant: true,
    relevanceReason: isGraded
      ? `Graded listing (${company ?? "unknown"}${grade !== null ? ` ${grade}` : ""})`
      : `Raw listing (${rawCondition ?? "condition not stated"})`,
    category,
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
/* Grouping for display                                                */
/* ------------------------------------------------------------------ */

export interface ListingGroup {
  key: string;
  label: string;
  listings: ClassifiedListing[];
}

const COMPANY_ORDER: GradingCompany[] = ["PSA", "BGS", "CGC", "SGC", "ACE"];

/** "PSA_10" -> "PSA 10", "BGS_9_5" -> "BGS 9.5", "OTHER_GRADED" -> "Other Graded". */
function categoryLabel(category: string): string {
  if (category === "OTHER_GRADED") return "Other Graded";

  const [company, ...grade] = category.split("_");
  return grade.length > 0 ? `${company} ${grade.join(".")}` : company;
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

export function groupClassified(listings: ClassifiedListing[]): ListingGroup[] {
  const accepted = listings.filter((listing) => listing.relevant);
  const groups = new Map<string, ListingGroup>();

  for (const listing of accepted) {
    // Key off the category so grouping can never disagree with classification.
    const key = listing.isGraded ? listing.category : "RAW";
    const label = listing.isGraded ? categoryLabel(key) : "Raw / Ungraded";

    const group = groups.get(key) ?? { key, label, listings: [] };
    group.listings.push(listing);
    groups.set(key, group);
  }

  return [...groups.values()].sort((a, b) => {
    const [aCompany, aGrade] = groupRank(a.listings[0]);
    const [bCompany, bGrade] = groupRank(b.listings[0]);
    return aCompany - bCompany || aGrade - bGrade;
  });
}
