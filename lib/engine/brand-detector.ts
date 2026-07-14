// Brand-mention detection — trimmed from geo's lib/services/brand-detector.ts
// (ES-059). The engine needs exactly one entry point: detectMention, plus the
// domain-stem alias fallback it uses when a client has no stored BrandKeywords.
// Keyword EXTRACTION (extractBrandKeywords, competitor keyword maps, the Haiku
// humanizer) stays in geo — this service builds its keyword sets in
// lib/tracker-db.ts at brand creation.
//
// detectMention's logic DIVERGES from geo (2026-07-14): geo's no-knowledge
// guard is global (any hedge phrase anywhere → no mention), which zeroed real
// Perplexity/Claude mentions; here it is sentence-scoped. Do NOT re-sync this
// file from geo. Unchanged from geo: longest-first keyword scan with the
// ambiguity proximity check, domain-URL fallback, lexical sentiment window,
// and numbered-list position detection.

import type { BrandKeywords } from "@/lib/types/tracker";
export type { BrandKeywords };

// ── Common domain compound splits ─────────────────────────────────────────────

const COMMON_SUFFIXES = [
  "hospitals", "health", "finance", "india", "tech", "labs", "solutions",
  "services", "group", "global", "care", "medical", "clinic", "dental",
];
const COMMON_PREFIXES = ["the", "my", "go", "get", "try", "use"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function getDomainStem(domain: string): string {
  return domain
    .replace(/^www\./, "")
    // Strip known two-part TLDs (.co.uk, .co.in, .com.au, .com.br, .org.uk, .co.nz, etc.)
    .replace(/\.(co|com|org|net|gov|edu|ac)\.[a-z]{2}$/i, "")
    // Strip remaining single-part TLD
    .replace(/\.[a-z]+$/i, "")
    .toLowerCase();
}

function generateDomainAliases(domainStem: string): string[] {
  const aliases = new Set<string>([domainStem]);

  // camelCase, separator, letter-number splits
  const spaced = domainStem
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/([a-z])(\d)/g, "$1 $2");
  if (spaced !== domainStem) aliases.add(spaced);

  // Common suffix splits ("manipalhospitals" → "manipal hospitals")
  for (const suffix of COMMON_SUFFIXES) {
    if (domainStem.endsWith(suffix) && domainStem.length > suffix.length) {
      aliases.add(domainStem.slice(0, -suffix.length) + " " + suffix);
    }
  }
  // Common prefix splits
  for (const prefix of COMMON_PREFIXES) {
    if (domainStem.startsWith(prefix) && domainStem.length > prefix.length + 2) {
      aliases.add(prefix + " " + domainStem.slice(prefix.length));
    }
  }

  return [...aliases].sort((a, b) => b.length - a.length);
}

// ── detectMention ─────────────────────────────────────────────────────────────

/**
 * Detect whether the brand is mentioned in an AI response text.
 *
 * When brandKeywords is null/undefined, falls back to domain-stem logic
 * (backward compatible with V1 checks).
 */
export function detectMention(
  responseText: string,
  domain: string,
  brandKeywords?: BrandKeywords | null,
  categoryKeywords?: string[],
): { mentioned: boolean; position: number | null; sentiment: "positive" | "neutral" | "negative" } {
  let keywords: string[];
  let isAmbiguous: boolean;

  if (brandKeywords) {
    keywords = brandKeywords.keywords;
    isAmbiguous = brandKeywords.isAmbiguous;
  } else {
    // Backward compat: derive from domain stem (original V1 behavior)
    const domainStem = getDomainStem(domain);
    keywords = generateDomainAliases(domainStem);
    isAmbiguous = false;
  }

  const cats = categoryKeywords ?? [];

  // No-knowledge guard, SCOPED to the sentence of each match.
  //
  // These phrases signal the model is disclaiming knowledge. The guard must NOT
  // suppress a reply that affirmatively names the brand elsewhere while hedging
  // about *some* sources — Perplexity/Claude run web-search + the grounded system
  // prompt and routinely emit a hedge phrase in one sentence while genuinely
  // citing the brand in another. So a hedge only invalidates a brand match when
  // the match sits in the SAME sentence as the hedge (e.g. a reply that ONLY says
  // "I couldn't find information about <brand>"). An affirmative mention in a
  // clean sentence always wins.
  const noKnowledgePatterns = [
    "i don't have enough information",
    "i don't have reliable information",
    "i don't have specific information",
    "i'm not familiar with",
    "i am not familiar with",
    "i cannot find information",
    "i don't have details",
    "no information available",
    "i'm unable to provide details",
    "i could not find",
    "i couldn't find",
  ];

  // True when the sentence containing `index` disclaims knowledge. Sentence
  // bounds are the nearest [.!?\n] on either side; every hedge phrase lives
  // within a single sentence (none contain sentence terminators).
  const isHedgedAt = (index: number): boolean => {
    let start = 0;
    for (let i = index; i >= 0; i--) {
      if (/[.!?\n]/.test(responseText[i])) { start = i + 1; break; }
    }
    let end = responseText.length;
    for (let i = index; i < responseText.length; i++) {
      if (/[.!?\n]/.test(responseText[i])) { end = i; break; }
    }
    const sentence = responseText.slice(start, end).toLowerCase();
    return noKnowledgePatterns.some(p => sentence.includes(p));
  };

  // Pre-compile all keyword regexes once (not inside the loop)
  const compiledKeywords = keywords.map(keyword => ({
    keyword,
    regex: new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
  }));

  let match: RegExpExecArray | null = null; // an affirmative (non-hedged) match

  // Iterate ALL occurrences of each keyword so a brand named in both a hedge
  // sentence and a clean sentence still resolves to the clean (affirmative) one.
  for (const { keyword, regex } of compiledKeywords) {
    let m: RegExpExecArray | null;
    while ((m = regex.exec(responseText)) !== null) {
      if (isAmbiguous) {
        // Require a category keyword within 300-char window
        const start = Math.max(0, m.index - 300);
        const end = m.index + keyword.length + 300;
        const context = responseText.slice(start, end).toLowerCase();
        const hasCategory = cats.some(cat =>
          context.includes(cat.toLowerCase()),
        );
        if (!hasCategory) continue; // not a valid candidate for this brand
      }
      if (isHedgedAt(m.index)) continue; // keep scanning for an affirmative occurrence
      match = m;
      break;
    }
    if (match) break;
  }

  // Domain URL fallback (same hedge scoping)
  if (!match) {
    const domainRegex = new RegExp(
      domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi",
    );
    let dm: RegExpExecArray | null;
    while ((dm = domainRegex.exec(responseText)) !== null) {
      if (isHedgedAt(dm.index)) continue;
      match = dm;
      break;
    }
  }

  // No affirmative match: the brand was either absent, or named ONLY inside a
  // hedge sentence ("I couldn't find information about <brand>") — both are
  // no-mention. This is the guard's preserved purpose.
  if (!match) {
    return { mentioned: false, position: null, sentiment: "neutral" };
  }

  // Sentiment detection (100-char window around match) — coarse lexical signal;
  // the stored per-response sentiment comes from lib/engine/sentiment.ts.
  const ctx = responseText
    .slice(Math.max(0, match.index - 100), match.index + match[0].length + 100)
    .toLowerCase();
  const positive = ["recommend", "best", "excellent", "top", "great", "leading", "trusted"].some(
    w => ctx.includes(w),
  );
  const negative = ["avoid", "poor", "expensive", "unreliable", "worse", "slow"].some(
    w => ctx.includes(w),
  );
  const sentiment = positive ? "positive" : negative ? "negative" : "neutral";

  // Position detection (numbered list)
  // Count all \d+\. markers in the text before the brand, then subtract 1 if the
  // last marker immediately precedes the brand (it belongs to the current item,
  // not a prior one). This handles both:
  //   "1. Competitor\n2. Brand"  (brand is numbered item #2)
  //   "1. Competitor\nBrand is also good"  (brand is unnumbered, after 1 numbered item)
  const before = responseText.slice(0, match.index);
  const allMarkers = (before.match(/\d+\. /g) ?? []).length;
  const endsWithMarker = /\d+\. $/.test(before);
  const position = allMarkers - (endsWithMarker ? 1 : 0) + 1;

  return { mentioned: true, position, sentiment };
}
