/**
 * ES-059 Part A — Brand Detector
 *
 * Vendor.name-based keyword matching + ambiguity proximity check.
 * Replaces domain-stem-only detectMention with a richer signal.
 *
 * TS-081 / HP-146: humanizeDomainToBrand uses a Haiku LLM rename pass with
 * an in-memory cache (7 day TTL). On Haiku failure: stale cache → raw stem.
 * Never throws.
 */

import Anthropic from "@anthropic-ai/sdk";

export type BrandKeywords = {
  keywords: string[];       // sorted longest-first
  isAmbiguous: boolean;
  source: "vendor" | "domain" | "manual";
  /**
   * @deprecated HP-161: brand-detector.ts no longer writes this field. Kept
   * optional to avoid breaking test fixtures that still construct BrandKeywords
   * with a timestamp. No production code reads this field — verified via grep
   * (`.extractedAt` only references geoTree / categoryTree / mapping types).
   */
  extractedAt?: string;
  // HP-152: when the same canonical brand name appears in the discovered set
  // with multiple TLDs (apollohospitals.com + apollohospitals.in), the entry
  // is merged and both domains are recorded here. NOT JSON-serializable —
  // serialization boundaries must convert to Array.
  sourceDomains?: Set<string>;
  // HP-159: pre-compiled `\b{alias}\b` regexes (gi flags) so detectCompetitorMentions
  // does not allocate a new RegExp per inner-loop iteration. Optional because
  // legacy callers (extractBrandKeywords for the subject brand) don't populate
  // it; detectCompetitorMentions falls back to on-the-fly compilation when absent.
  compiledAliases?: RegExp[];
};

// ── Legal suffix strip ────────────────────────────────────────────────────────

const LEGAL_SUFFIXES =
  /\b(Inc|LLC|Ltd|Corp|Group|Pvt|Private|Limited|Co|Company|Holdings|Enterprises|Associates|Partners|International|Intl)\.?\s*$/i;

// ── Ambiguous brand words ─────────────────────────────────────────────────────

const AMBIGUOUS_BRAND_WORDS = new Set([
  "apple", "chase", "target", "amazon", "bolt", "gap", "shell", "virgin",
  "oracle", "adobe", "nest", "spark", "stripe", "square", "snap", "zoom",
  "slack", "notion", "linear", "arc", "ray", "nile", "delta", "summit",
  "atlas", "harbor", "beacon", "horizon", "compass", "sage", "iris",
  "nova", "pulse", "forge", "hive", "scout", "bloom", "pine", "maple",
  "cedar", "aspen", "birch", "coral", "amber", "ruby", "jade", "pearl",
  "onyx", "moss", "ivy", "fern", "reed", "brook", "vale", "crest",
  "peak", "ridge", "wave", "tide", "drift", "stone", "craft",
  "loom", "vault", "core", "base", "anchor", "bridge", "link", "flux",
  "duo", "solo", "alto", "lyric", "verse", "blend", "pilot", "unity",
]);

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

function validateVendorName(vendorName: string, domainStem: string): boolean {
  const words = vendorName.toLowerCase().split(/\s+/);
  return words.some(word => word.length >= 3 && domainStem.includes(word));
}

function generateAliases(
  vendorName: string,
  domainStem: string,
  collidingFirstWords?: Set<string>,
): string[] {
  const aliases = new Set<string>();

  // 1. Full name
  aliases.add(vendorName.toLowerCase());

  // 2. Strip legal suffixes
  const stripped = vendorName.replace(LEGAL_SUFFIXES, "").trim();
  if (stripped.toLowerCase() !== vendorName.toLowerCase()) {
    aliases.add(stripped.toLowerCase());
  }

  // 3. HP-151: First N-1 words (if multi-word) — but SKIP when first word
  // collides with another brand in the discovered set. Otherwise the bare
  // "Apollo" alias generated for "Apollo Hospitals" would phantom-match
  // "Apollo Pharmacy" responses.
  const words = stripped.split(/\s+/);
  if (words.length > 1) {
    const firstWord = words[0]?.toLowerCase();
    const collides = firstWord ? collidingFirstWords?.has(firstWord) ?? false : false;
    if (!collides) {
      aliases.add(words.slice(0, -1).join(" ").toLowerCase());
    }
  }

  // 4. Domain stem
  aliases.add(domainStem);

  // 5. Domain stem compound splits
  for (const suffix of COMMON_SUFFIXES) {
    if (domainStem.endsWith(suffix) && domainStem.length > suffix.length) {
      aliases.add(domainStem.slice(0, -suffix.length) + " " + suffix);
    }
  }
  for (const prefix of COMMON_PREFIXES) {
    if (domainStem.startsWith(prefix) && domainStem.length > prefix.length + 2) {
      aliases.add(prefix + " " + domainStem.slice(prefix.length));
    }
  }

  return [...aliases].sort((a, b) => b.length - a.length);
}

// HP-147: heuristic safety net so healthcare brands not in AMBIGUOUS_BRAND_WORDS
// (apollo, fortis, max, etc.) are still flagged ambiguous. Three layers:
//   1. Dictionary fast-path (existing)
//   2. Any short single-word keyword (≤8 chars, no space) → flag the brand
//      ambiguous. This catches both pure single-word brands ("Apollo") AND
//      multi-word brands whose generated bare-prefix alias is short
//      ("Apollo Hospitals" → bare "apollo" alias).
//   3. First-word collision across discovered set (caller passes the set)
//
// The breadth of #2 is intentional and pairs with the SELECTIVE proximity
// guard in detectCompetitorMentions: only short bare-keyword matches require
// category context; full multi-word matches like "apollo hospitals" still
// match without context even when the brand is flagged ambiguous overall.
// This protects multi-word brands like "Manipal Hospitals" from losing real
// matches while still catching phantom mentions of the bare "manipal" prefix.
function isAmbiguousBrand(
  keywords: string[],
  collidingFirstWords?: Set<string>,
): boolean {
  // 1. Dictionary
  if (keywords.some(kw => AMBIGUOUS_BRAND_WORDS.has(kw.toLowerCase()))) return true;

  // 2. Any short single-word keyword
  if (
    keywords.some(kw => {
      const trimmed = kw.trim();
      return trimmed.length > 0 && trimmed.length <= 8 && !/\s/.test(trimmed);
    })
  ) {
    return true;
  }

  // 3. First-word collision (when caller provides the discovered-set context)
  if (collidingFirstWords && collidingFirstWords.size > 0) {
    const firstWords = keywords
      .map(kw => kw.trim().split(/\s+/)[0]?.toLowerCase())
      .filter((w): w is string => Boolean(w));
    if (firstWords.some(fw => collidingFirstWords.has(fw))) return true;
  }

  return false;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract brand keywords from a domain + optional businessJson.
 * Source priority: vendor.name > geo_profile.business_name > domain stem.
 */
export function extractBrandKeywords(
  domain: string,
  businessJson: Record<string, unknown> | null,
): BrandKeywords {
  const domainStem = getDomainStem(domain);

  // Try vendor.name first
  const vendorName =
    (businessJson?.vendor as { name?: string } | undefined)?.name ??
    (businessJson?.geo_profile as { business_name?: string } | undefined)?.business_name ??
    null;

  if (vendorName && typeof vendorName === "string" && vendorName.trim().length > 0) {
    const hasOverlap = validateVendorName(vendorName, domainStem);
    if (!hasOverlap) {
      console.warn(
        `[brand-detector] vendor.name "${vendorName}" has zero overlap with domain "${domain}" — possible hallucination`,
      );
      // Fall back to domain-stem
      const keywords = generateDomainAliases(domainStem);
      return {
        keywords,
        isAmbiguous: isAmbiguousBrand(keywords),
        source: "domain",
        // HP-161: extractedAt removed (no production reads)
      };
    }

    const keywords = generateAliases(vendorName, domainStem);
    return {
      keywords,
      isAmbiguous: isAmbiguousBrand(keywords),
      source: "vendor",
      // HP-161: extractedAt removed (no production reads)
    };
  }

  // Fall back to domain stem
  const keywords = generateDomainAliases(domainStem);
  return {
    keywords,
    isAmbiguous: isAmbiguousBrand(keywords),
    source: "domain",
    // HP-161: extractedAt removed (no production reads)
  };
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

  // Sentiment detection (100-char window around match)
  const domainStem = getDomainStem(domain);
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

// ── Competitor brand-name detection (TS-081) ─────────────────────────────────
//
// Until TS-081 the citation pipeline matched competitors only by literal domain
// strings (URLs and bare *.com refs in response text). That captured ~3% of the
// real signal because LLMs name competitors by brand ("Apollo Hospitals"), not
// by URL. The helpers below apply the same alias-generation pipeline used for
// the subject brand (extractBrandKeywords / detectMention) to a list of known
// competitors so the runtime extractor can match brand names too.
//
// The functions are intentionally pure — they take competitor inputs and a
// response text, and return matched competitor identifiers. No I/O.

export interface CompetitorInput {
  name: string;
  domain?: string | null;
}

/**
 * TS-081: Build a map of competitor identifier → BrandKeywords for runtime
 * matching during citation checks. Each competitor's keyword list is generated
 * via the same alias logic that powers subject-brand detection, so a competitor
 * named "Apollo Hospitals" with domain "apollohospitals.com" produces the
 * keyword set ["apollo hospitals", "apollohospitals", "apollo"] — including the
 * bare prefix. The map key is the lower-cased competitor name (canonical id).
 *
 * Sub-cases handled:
 *   - Competitor name is a real brand ("Apollo Hospitals") → use generateAliases
 *   - Competitor name was already humanized upstream but the domain stem differs
 *   - Competitor has no domain → degrade gracefully to name-only aliases
 *   - Single-word ambiguous names (Apollo, Fortis) → flag isAmbiguous so the
 *     runtime detector requires a category-keyword proximity guard
 */
export function extractCompetitorBrandKeywords(
  competitors: CompetitorInput[],
): Map<string, BrandKeywords> {
  // HP-147 #3 / HP-151: build the colliding-first-word set BEFORE the
  // per-competitor loop. Two passes through the input list — cheap, runs
  // once per audit, ≤6 competitors typical.
  const firstWordCounts = new Map<string, number>();
  for (const comp of competitors) {
    if (!comp.name) continue;
    const firstWord = comp.name.trim().toLowerCase().split(/\s+/)[0];
    if (firstWord) {
      firstWordCounts.set(firstWord, (firstWordCounts.get(firstWord) ?? 0) + 1);
    }
  }
  const collidingFirstWords = new Set(
    [...firstWordCounts.entries()].filter(([, n]) => n > 1).map(([w]) => w),
  );

  const map = new Map<string, BrandKeywords>();
  for (const comp of competitors) {
    if (!comp.name) continue;
    const id = comp.name.toLowerCase();

    // HP-152: same canonical name + different domain → merge into sourceDomains
    const existing = map.get(id);
    if (existing) {
      if (comp.domain) existing.sourceDomains?.add(comp.domain.toLowerCase());
      continue;
    }

    const domainStem = comp.domain
      ? getDomainStem(comp.domain)
      : id.replace(/[^a-z0-9]/g, "");

    const keywords = generateAliases(comp.name, domainStem, collidingFirstWords);

    const sourceDomains = new Set<string>();
    if (comp.domain) sourceDomains.add(comp.domain.toLowerCase());

    // HP-159: pre-compile alias regexes once at map build time so
    // detectCompetitorMentions doesn't allocate a new RegExp per inner-loop
    // iteration. Same gi flags HP-150 mandates for matchAll.
    const compiledAliases = keywords.map(keyword => {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`, "gi");
    });

    map.set(id, {
      keywords,
      isAmbiguous: isAmbiguousBrand(keywords, collidingFirstWords),
      source: "vendor",
      // HP-161: extractedAt removed (no production reads)
      sourceDomains,
      compiledAliases,
    });
  }
  return map;
}

/**
 * TS-081: Detect which competitors from a known set are mentioned in a
 * response. Returns the lower-cased canonical names of matched competitors.
 *
 * Matching uses the same longest-first regex strategy as detectMention(), and
 * the same isAmbiguous proximity guard (300-char window for category keywords).
 * Unlike detectMention(), this function does NOT apply the no-knowledge guard
 * — a response saying "I don't have details on Apollo" still mentions Apollo as
 * a competitor for SOV/co-presence purposes. Each competitor is checked
 * independently; multiple matches per response are allowed.
 */
export function detectCompetitorMentions(
  responseText: string,
  competitorKeywords: Map<string, BrandKeywords>,
  categoryKeywords?: string[],
): string[] {
  if (competitorKeywords.size === 0) return [];

  // HP-150: emit one entry per match (multi-mention semantics) rather than
  // dedup via Set. Downstream compMap aggregation now reflects per-response
  // mention counts, which feeds the SOV / co-presence model.
  const matched: string[] = [];
  const cats = categoryKeywords ?? [];

  // HP-153: ambiguous brand + empty categoryKeywords would silently lose all
  // bare-prefix matches because the proximity guard always fails. Detect this
  // case once per call and fall through (treat as non-ambiguous for the call)
  // with a clear WARN so the upstream ES-059 categoryKeywords data gap is
  // visible. The data gap is upstream and out of TS-081 scope.
  const hasAmbiguous = [...competitorKeywords.values()].some(kw => kw.isAmbiguous);
  const ambiguousButNoCategory = hasAmbiguous && cats.length === 0;
  if (ambiguousButNoCategory) {
    console.warn(
      "[brand-detector] categoryKeywords map empty in isAmbiguousBrand — " +
      "falling through as non-ambiguous; check ES-059 categoryKeywords data " +
      "population for site",
    );
  }

  for (const [id, kw] of competitorKeywords.entries()) {
    for (let i = 0; i < kw.keywords.length; i++) {
      const keyword = kw.keywords[i];
      // HP-159: prefer pre-compiled alias regex (built once in
      // extractCompetitorBrandKeywords). Fall back to on-the-fly compilation
      // for legacy callers that build BrandKeywords without compiledAliases.
      // HP-150: gi flags are MANDATORY for matchAll (throws on non-global).
      let regex: RegExp;
      if (kw.compiledAliases && kw.compiledAliases[i]) {
        regex = kw.compiledAliases[i];
        regex.lastIndex = 0;
      } else {
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        regex = new RegExp(`\\b${escaped}\\b`, "gi");
      }
      const matches = [...responseText.matchAll(regex)];
      if (matches.length === 0) continue;

      // HP-147: ambiguous brands require category proximity ONLY when the
      // matched keyword is a short bare token (≤8 chars, no space). Full
      // multi-word matches like "apollo hospitals" are distinctive enough
      // to skip the guard even when the brand is flagged ambiguous overall.
      // HP-153: skip the guard entirely when categoryKeywords is empty
      // (already WARN-logged above).
      const isShortBare = !/\s/.test(keyword) && keyword.length <= 8;
      let validMatches = matches;
      if (kw.isAmbiguous && isShortBare && !ambiguousButNoCategory) {
        validMatches = matches.filter(m => {
          const idx = m.index ?? 0;
          const start = Math.max(0, idx - 300);
          const end = idx + keyword.length + 300;
          const context = responseText.slice(start, end).toLowerCase();
          return cats.some(cat => context.includes(cat.toLowerCase()));
        });
      }

      if (validMatches.length === 0) continue;

      // Emit one entry per valid match (HP-150 multi-mention) and stop
      // trying further aliases for this competitor — the longest-first
      // ordering means we already used the most specific alias.
      for (let i = 0; i < validMatches.length; i++) matched.push(id);
      break;
    }
  }

  return matched;
}

// ── HP-146: Haiku rename pass + canonical-name cache ─────────────────────────
//
// Until HP-146 the function below was a regex-based compound-split heuristic
// that produced sub-optimal names like "Fortishealth Care" because the suffix
// table didn't sort longest-first. HolePoker re-review (HP-146) replaced it
// with a Haiku call gated by an in-memory cache. Behavior on Haiku failure is
// load-bearing per Aditya 2026-04-09: NEVER throw — try cache → raw stem.
//
// Cost: ~$0.001 per Haiku call. Cache hit rate at steady state should be 90%+
// since the same competitor set repeats across audits for the same site. The
// 7-day TTL is generous because brand→canonical mappings are essentially
// immutable.

const HUMANIZE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const HUMANIZE_HAIKU_TIMEOUT_MS = 5_000;
const HUMANIZE_SYSTEM_PROMPT =
  "Convert this domain stem to its canonical brand name. Return ONLY the " +
  "brand name, no explanation, no quotes. Examples: fortishealthcare → " +
  "Fortis Healthcare; apollohospitals → Apollo Hospitals; asterdmhealthcare " +
  "→ Aster DM Healthcare.";

type HumanizeCacheEntry = { value: string; expiresAt: number };
const HUMANIZE_CACHE = new Map<string, HumanizeCacheEntry>();

function capitalizeStem(stem: string): string {
  return stem.length === 0 ? stem : stem[0].toUpperCase() + stem.slice(1);
}

/**
 * TS-081 / HP-146: domain → canonical brand name via Haiku LLM rename pass
 * with cached fallback. Replaces the regex-based heuristic that preceded it.
 *
 * Failure semantics (load-bearing per Aditya 2026-04-09):
 *   1. Fresh cache hit → return immediately
 *   2. Try Haiku call (5 s timeout)
 *   3. On success: cache result with 7-day TTL, return
 *   4. On failure: try stale cache → return cached value if any entry exists
 *   5. On stale-cache miss: return capitalized raw stem
 *   6. NEVER throw — Haiku outage must not cause audit failure
 */
export async function humanizeDomainToBrand(domain: string): Promise<string> {
  const stem = getDomainStem(domain);
  const now = Date.now();

  // 1. Fresh cache hit short-circuit
  const cached = HUMANIZE_CACHE.get(stem);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  // 4. No API key — fall straight to stem
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      `[brand-detector] humanizeDomainToBrand: ANTHROPIC_API_KEY not set; ` +
      `falling back to raw stem for "${stem}"`,
    );
    if (cached) return cached.value; // stale > stem if we have it
    return capitalizeStem(stem);
  }

  // 2. Try Haiku
  try {
    const client = new Anthropic();
    const result = await Promise.race([
      client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 50,
        temperature: 0,
        system: HUMANIZE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: stem }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("haiku-timeout")), HUMANIZE_HAIKU_TIMEOUT_MS),
      ),
    ]);

    // Anthropic SDK ContentBlock is a union type — narrow to text blocks before
    // accessing .text. Match the same pattern used in citation-checker.ts.
    const text = result.content
      .filter(b => b.type === "text")
      .map(b => (b as { type: "text"; text: string }).text)
      .join("")
      .trim();

    if (text.length === 0) throw new Error("haiku-empty-response");
    if (text.length > 200) throw new Error("haiku-response-too-long");

    HUMANIZE_CACHE.set(stem, { value: text, expiresAt: now + HUMANIZE_TTL_MS });
    return text;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // 4. Stale cache fallback
    if (cached) {
      console.warn(
        `[brand-detector] humanizeDomainToBrand Haiku call failed for "${stem}" ` +
        `(${reason}); falling back to stale cached value`,
      );
      return cached.value;
    }
    // 5. Stem fallback
    console.warn(
      `[brand-detector] humanizeDomainToBrand Haiku call failed for "${stem}" ` +
      `(${reason}); falling back to capitalized raw stem`,
    );
    return capitalizeStem(stem);
  }
}

/**
 * Test-only cache control. Two modes:
 *   - reset (default): clear the cache entirely.
 *   - keepStaleEntry: insert a single entry with `expiresAt = 0` so the
 *     fresh-hit short-circuit misses it but the failure-fallback path finds it.
 * NOT for production use. Underscore-prefixed to signal test-only.
 */
export function _resetHumanizeCacheForTests(
  options?: { keepStaleEntry?: { stem: string; value: string } },
): void {
  HUMANIZE_CACHE.clear();
  if (options?.keepStaleEntry) {
    HUMANIZE_CACHE.set(options.keepStaleEntry.stem, {
      value: options.keepStaleEntry.value,
      expiresAt: 0,
    });
  }
}

/**
 * TS-081: Detect whether a name string looks like an unprocessed domain stem
 * (lowercase, no spaces, plausible domain-stem characters). Used by the
 * competitor discovery path to decide whether to humanize a name returned by
 * the discovery LLM.
 */
export function looksLikeDomainStem(name: string): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  if (trimmed.length === 0) return true;
  // Real brand names usually have a space, hyphen, or capital letter.
  // A single-token, all-lowercase, alphanumeric string is almost certainly
  // a domain stem ("apollohospitals", "fortishealthcare").
  return /^[a-z0-9]+$/.test(trimmed);
}
