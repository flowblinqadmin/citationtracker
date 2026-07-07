// Brand-mention detection — trimmed from geo's lib/services/brand-detector.ts
// (ES-059). The engine needs exactly one entry point: detectMention, plus the
// domain-stem alias fallback it uses when a client has no stored BrandKeywords.
// Keyword EXTRACTION (extractBrandKeywords, competitor keyword maps, the Haiku
// humanizer) stays in geo — this service builds its keyword sets in
// lib/tracker-db.ts at brand creation.
//
// detectMention's logic is verbatim: no-knowledge guard, longest-first keyword
// scan with the ambiguity proximity check, domain-URL fallback, lexical
// sentiment window, and numbered-list position detection.

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
  let match: RegExpExecArray | null = null;

  // Guard: if the model explicitly says it doesn't know, that's not a real mention
  const lowerResponse = responseText.toLowerCase();
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
  ];
  if (noKnowledgePatterns.some(p => lowerResponse.includes(p))) {
    return { mentioned: false, position: null, sentiment: "neutral" };
  }

  // Pre-compile all keyword regexes once (not inside the loop)
  const compiledKeywords = keywords.map(keyword => ({
    keyword,
    regex: new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
  }));

  for (const { keyword, regex } of compiledKeywords) {
    const m = regex.exec(responseText);
    if (m) {
      if (isAmbiguous) {
        // Require a category keyword within 300-char window
        const start = Math.max(0, m.index - 300);
        const end = m.index + keyword.length + 300;
        const context = responseText.slice(start, end).toLowerCase();
        const hasCategory = cats.some(cat =>
          context.includes(cat.toLowerCase()),
        );
        if (hasCategory) {
          match = m;
          break;
        }
        // else continue to next keyword
      } else {
        match = m;
        break;
      }
    }
  }

  // Domain URL fallback
  if (!match) {
    const domainRegex = new RegExp(
      domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi",
    );
    const dm = domainRegex.exec(responseText);
    if (dm) {
      match = dm;
    }
  }

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
