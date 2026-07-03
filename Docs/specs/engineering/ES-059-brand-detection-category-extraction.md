# ES-059: Brand Detection + Category Extraction + Template Overhaul

**Source:** TS-059-detection-category-overhaul.md
**Author:** SpecMaster (Agent 2)
**Date:** 2026-03-25
**Branch:** `dev-an-geo`
**Depends on:** TS-058 (V2 prompt generator), ES-057 (dimensional UI)
**HolePoker reviews:** Brand detection (2026-03-25T08:00Z), Category extraction (2026-03-25T09:30Z)

---

## a) Overview

### What this covers
Three interconnected quality fixes:

**Part A — Brand Mention Detection Rewrite:** Replace domain-stem-based `detectMention()` with a vendor.name-based keyword matcher. Includes auto-alias generation, common-word ambiguity check, and proximity-based validation. Proven: compound splitting alone jumped Manipal Hospitals from 2% to 30% visibility.

**Part B — LLM Category Extraction:** A single Haiku call extracts 5-7 real service categories + entity noun, replacing blog-derived tree categories that produce topics like "HIV" instead of "Oncology".

**Part C — Seed Template Fixes:** Replace hardcoded "companies"/"firms"/"providers" with the extracted `entityNoun`. For hospitals: "best Oncology hospitals" instead of "best Oncology companies".

### Current implementation state
- **`detectMention()`** (`lib/services/citation-checker.ts:40-87`): Takes `(responseText, domain)` — derives brand name from domain string only. No vendor.name awareness. No ambiguity check.
- **`extractCategories()`** (`lib/services/citation-prompt-generator.ts:927-949`): Falls back to `geo_profile.topics` → `categoryTree` leaves. No LLM extraction. No entityNoun.
- **`buildSeeds()`** (`lib/services/citation-prompt-generator.ts:1130-1158`): Hardcodes "companies"/"providers"/"firms"/"services" in templates.
- **DB schema** (`lib/db/schema.ts`): No `brand_keywords` or `extracted_categories` columns.

### Files involved
| File | Action | Part |
|------|--------|------|
| `lib/services/brand-detector.ts` | **CREATE** — brand keyword extraction + detectMention rewrite | A |
| `lib/services/category-extractor.ts` | **CREATE** — Haiku category extraction + validation | B |
| `lib/services/citation-checker.ts` | **MODIFY** — use new detectMention from brand-detector | A |
| `lib/services/citation-prompt-generator.ts` | **MODIFY** — use extractedCategories + entityNoun in seeds | B, C |
| `lib/db/schema.ts` | **MODIFY** — add 2 JSONB columns to geoSites | A, B |
| `lib/db/migrations/20260325-brand-keywords-categories.sql` | **CREATE** — DDL migration | A, B |
| `app/api/sites/[id]/citation-check/route.ts` | **MODIFY** — pass brandKeywords to runCitationCheck, lazy extraction | A, B |

---

## b) Implementation Requirements

### B1. New File: `lib/services/brand-detector.ts`

#### B1.1 Types

```typescript
export type BrandKeywords = {
  keywords: string[];          // sorted longest-first
  isAmbiguous: boolean;
  source: "vendor" | "domain" | "manual";
  extractedAt: string;         // ISO-8601
};
```

#### B1.2 `extractBrandKeywords(domain, businessJson)`

**Signature:**
```typescript
export function extractBrandKeywords(
  domain: string,
  businessJson: Record<string, unknown> | null,
): BrandKeywords
```

**Algorithm:**
1. Extract `vendorName` from `businessJson?.vendor?.name` (primary) or `businessJson?.geo_profile?.business_name` (fallback) or `null`
2. If `vendorName` exists, validate against domain stem (see B1.3)
3. Generate alias set (see B1.4)
4. Check ambiguity (see B1.5)
5. Sort keywords longest-first
6. Return `BrandKeywords`

#### B1.3 Vendor.name Validation

```typescript
function validateVendorName(vendorName: string, domainStem: string): boolean {
  const words = vendorName.toLowerCase().split(/\s+/);
  return words.some(word => word.length >= 3 && domainStem.includes(word));
}
```

- Domain stem: `domain.replace(/^www\./, "").replace(/\.[a-z]+$/i, "").toLowerCase()`
- If zero overlap → log warning: `[brand-detector] vendor.name "${vendorName}" has zero overlap with domain "${domain}" — possible hallucination`
- Fall back to domain-stem detection (source: "domain")

#### B1.4 Alias Auto-Generation

Given `vendorName = "Manipal Hospitals Ltd"`:

```typescript
const LEGAL_SUFFIXES = /\b(Inc|LLC|Ltd|Corp|Group|Pvt|Private|Limited|Co|Company|Holdings|Enterprises|Associates|Partners|International|Intl)\.?\s*$/i;

function generateAliases(vendorName: string, domainStem: string): string[] {
  const aliases = new Set<string>();

  // 1. Full name (lowercased)
  aliases.add(vendorName.toLowerCase());

  // 2. Strip legal suffixes
  const stripped = vendorName.replace(LEGAL_SUFFIXES, "").trim();
  if (stripped.toLowerCase() !== vendorName.toLowerCase()) {
    aliases.add(stripped.toLowerCase());
  }

  // 3. First N-1 words (if multi-word, and N-1 >= 1)
  const words = stripped.split(/\s+/);
  if (words.length > 1) {
    aliases.add(words.slice(0, -1).join(" ").toLowerCase());
  }

  // 4. Domain stem
  aliases.add(domainStem);

  // 5. Domain stem with common splits (reuse existing COMMON_SUFFIXES logic)
  const COMMON_SUFFIXES = ["hospitals", "health", "finance", "india", "tech", "labs", "solutions", "services", "group", "global", "care", "medical", "clinic", "dental"];
  for (const suffix of COMMON_SUFFIXES) {
    if (domainStem.endsWith(suffix) && domainStem.length > suffix.length) {
      aliases.add(domainStem.slice(0, -suffix.length) + " " + suffix);
    }
  }
  const COMMON_PREFIXES = ["the", "my", "go", "get", "try", "use"];
  for (const prefix of COMMON_PREFIXES) {
    if (domainStem.startsWith(prefix) && domainStem.length > prefix.length + 2) {
      aliases.add(prefix + " " + domainStem.slice(prefix.length));
    }
  }

  // 6. Singular/plural toggle for last word of stripped name
  if (words.length >= 1) {
    const last = words[words.length - 1].toLowerCase();
    if (last.endsWith("s") && last.length > 3) {
      const singular = [...words.slice(0, -1), last.slice(0, -1)].join(" ").toLowerCase();
      aliases.add(singular);
    } else if (!last.endsWith("s")) {
      const plural = [...words.slice(0, -1), last + "s"].join(" ").toLowerCase();
      aliases.add(plural);
    }
  }

  // Sort longest-first
  return [...aliases].sort((a, b) => b.length - a.length);
}
```

**DO NOT** generate acronyms (e.g., "MH" for "Manipal Hospitals") — too many false positives.

#### B1.5 Ambiguity Detection

```typescript
const AMBIGUOUS_BRAND_WORDS = new Set([
  "apple", "chase", "target", "amazon", "bolt", "gap", "shell", "virgin",
  "oracle", "adobe", "nest", "spark", "stripe", "square", "snap", "zoom",
  "slack", "notion", "linear", "arc", "ray", "nile", "delta", "summit",
  "atlas", "harbor", "beacon", "horizon", "compass", "sage", "iris",
  "nova", "pulse", "forge", "hive", "scout", "bloom", "pine", "maple",
  "cedar", "aspen", "birch", "coral", "amber", "ruby", "jade", "pearl",
  "onyx", "moss", "ivy", "fern", "reed", "brook", "vale", "crest",
  "peak", "ridge", "wave", "tide", "drift", "stone", "craft", "forge",
  "loom", "vault", "core", "base", "anchor", "bridge", "link", "flux",
  "duo", "solo", "alto", "lyric", "verse", "blend", "pilot", "unity",
]);

function isAmbiguousBrand(keywords: string[]): boolean {
  return keywords.some(kw => AMBIGUOUS_BRAND_WORDS.has(kw.toLowerCase()));
}
```

~80 entries. Check each keyword against the set. If ANY keyword matches → `isAmbiguous = true`.

#### B1.6 New `detectMention()` — Replaces Old

```typescript
export function detectMention(
  responseText: string,
  domain: string,
  brandKeywords?: BrandKeywords | null,
  categoryKeywords?: string[],
): { mentioned: boolean; position: number | null; sentiment: "positive" | "neutral" | "negative" }
```

**Algorithm (per TS-059 §A.4):**

```
1. keywords = brandKeywords?.keywords ?? [domainStem variants] (backward compat)
2. isAmbiguous = brandKeywords?.isAmbiguous ?? false
3. For each keyword (longest first):
     match = case-insensitive search in responseText
     if match:
       if isAmbiguous:
         context = responseText[match.index-300 : match.index+keyword.length+300]
         if any categoryKeyword in context (case-insensitive):
           return { mentioned: true, position, sentiment }
         else:
           continue  // try next keyword
       else:
         return { mentioned: true, position, sentiment }

4. // Complementary domain URL check
   domainMatch = search for domain in responseText
   if domainMatch:
     return { mentioned: true, position, sentiment }

5. return { mentioned: false, position: null, sentiment: "neutral" }
```

**Sentiment detection:** Reuse existing 100-char context window logic from current `detectMention()` (lines 78-81).

**Position detection:** Reuse existing `\n\d+\.` counting logic (lines 83-84).

**Backward compatibility:** When `brandKeywords` is `null/undefined`, fall back to domain-stem variant generation (exact current behavior from lines 44-67). This ensures existing V1 checks work unchanged.

### B2. New File: `lib/services/category-extractor.ts`

#### B2.1 Types

```typescript
export type ExtractedCategories = {
  categories: string[];
  entityNoun: string;
  extractedAt: string;         // ISO-8601
  source: "haiku" | "topics" | "tree" | "fallback";
};
```

#### B2.2 `extractCategoriesViaHaiku()`

**Signature:**
```typescript
export async function extractCategoriesViaHaiku(
  domain: string,
  siteType: string | null,
  businessJson: Record<string, unknown> | null,
  llmsTxt: string | null,
  crawlData: unknown,
  categoryTree: CategoryTree | null,
): Promise<ExtractedCategories>
```

**Algorithm:**

1. **Minimum input guard:** Compute combined input length = `(llmsTxt ?? "").length + homepageContent.length`. If < 200 → skip Haiku, fall through to fallback chain.

2. **Build Haiku prompt** (see B2.3)

3. **Call Haiku:**
   - Model: `claude-haiku-4-5-20251001`
   - Temperature: 0
   - Max tokens: 500
   - Timeout: 10s (Promise.race with timeout)

4. **Parse response:** Extract JSON from response text. Handle markdown code fences.

5. **Validate** (see B2.4)

6. **Fallback chain** if Haiku fails or returns < 3 valid categories:
   - `businessJson.geo_profile.topics` (filter strings, filter domain stems)
   - `categoryTree` leaves (sorted by pageCount, top 5)
   - `[siteType ?? "general"]` as single category
   - `entityNoun` fallback: `INDUSTRY_NOUN_MAP[siteType]` → "companies"

#### B2.3 Haiku Prompts

**System prompt:**
```
Extract 5-7 primary service or product categories for this business.
Think DEPARTMENTS or PRODUCT LINES — what would appear on the company's
main navigation menu. Not blog post topics or subcategories.

Also return the entity noun that describes what this type of business is
called (e.g., "hospitals", "agencies", "platforms", "stores").

Return only valid JSON:
{ "categories": ["Category1", "Category2", ...], "entityNoun": "hospitals" }
```

**User prompt construction:**
```typescript
function buildUserPrompt(
  domain: string,
  industry: string | null,
  llmsTxt: string | null,
  homepageContent: string,
  serviceUrls: string[],
  treeLeafNames: string[],
): string {
  const parts: string[] = [];
  parts.push(`Domain: ${domain}`);
  if (industry) parts.push(`Industry: ${industry}`);
  if (llmsTxt) parts.push(`\nBusiness description:\n${llmsTxt.slice(0, 800)}`);
  if (homepageContent) parts.push(`\nHomepage:\n${homepageContent.slice(0, 300)}`);
  if (serviceUrls.length > 0) parts.push(`\nService/department pages found on the site:\n${serviceUrls.join("\n")}`);
  if (treeLeafNames.length > 0) parts.push(`\nContent topics found during crawl (these may be blog topics, use as hints only):\n${treeLeafNames.join(", ")}`);

  parts.push(`\nExamples:
- Hospital: {"categories": ["Oncology", "Cardiology", "Orthopedics"], "entityNoun": "hospitals"}
- Consultancy: {"categories": ["Digital Transformation", "Regulatory Compliance"], "entityNoun": "consultancies"}
- SaaS: {"categories": ["Project Management", "Team Collaboration"], "entityNoun": "platforms"}
- Any business: the main services or product lines the business offers`);

  return parts.join("\n");
}
```

#### B2.4 Validation

```typescript
function validateCategories(
  raw: { categories?: unknown; entityNoun?: unknown },
  crawlData: unknown,
  categoryTree: CategoryTree | null,
): { categories: string[]; entityNoun: string; valid: boolean } {
  let cats = Array.isArray(raw.categories)
    ? raw.categories.filter((c): c is string => typeof c === "string")
    : [];

  // 1. Length check: 2-50 chars each
  cats = cats.filter(c => c.length >= 2 && c.length <= 50);

  // 2. Dedup: remove substrings ("Oncology Department" if "Oncology" also present)
  cats = deduplicateSubstrings(cats);

  // 3. Cross-reference: check ≥2 appear in page URLs or tree node names
  const urlPaths = extractServiceUrls(crawlData);
  const treeNames = categoryTree ? collectLeafNames(categoryTree) : [];
  const allRef = [...urlPaths, ...treeNames].map(s => s.toLowerCase());
  const matched = cats.filter(c =>
    allRef.some(ref => ref.includes(c.toLowerCase()) || c.toLowerCase().includes(ref))
  );

  // 4. entityNoun validation
  let entityNoun = typeof raw.entityNoun === "string" && raw.entityNoun.length <= 30
    ? raw.entityNoun.toLowerCase()
    : "";

  return {
    categories: cats,
    entityNoun,
    valid: cats.length >= 3 && matched.length >= 2,
  };
}
```

**Substring dedup:**
```typescript
function deduplicateSubstrings(cats: string[]): string[] {
  const lower = cats.map(c => c.toLowerCase());
  return cats.filter((c, i) => {
    const cl = lower[i];
    return !lower.some((other, j) => j !== i && other !== cl && cl.includes(other));
  });
}
```
Keep the shorter (more specific) entry. "Oncology" + "Oncology Department" → keep "Oncology" (filter out "Oncology Department" because it contains "Oncology").

Wait — the TS says "remove categories that are substrings of each other" and the example shows keeping "Oncology" and removing "Oncology Department". So we remove the LONGER one that contains the shorter. Fix the filter logic:

```typescript
function deduplicateSubstrings(cats: string[]): string[] {
  return cats.filter((c, i) => {
    const cl = c.toLowerCase();
    // Remove this entry if a shorter entry exists that it contains
    return !cats.some((other, j) => j !== i && cl.includes(other.toLowerCase()) && other.length < c.length);
  });
}
```

#### B2.5 Page URL Filtering

```typescript
const SERVICE_PATTERNS = [
  /\/departments\//i, /\/services\//i, /\/specialties\//i, /\/solutions\//i,
  /\/products\//i, /\/practice-areas\//i, /\/treatments\//i, /\/procedures\//i,
  /\/offerings\//i,
];
const EXCLUDE_PATTERNS = [
  /\/blog\//i, /\/news\//i, /\/press\//i, /\/careers\//i, /\/events\//i,
  /\/category\//i, /\/tag\//i,
];

export function extractServiceUrls(crawlData: unknown): string[] {
  const pages = (crawlData as { pages?: Array<{ url?: string }> })?.pages ?? [];
  return pages
    .map(p => {
      try { return new URL(p.url ?? "").pathname; } catch { return ""; }
    })
    .filter(path => path && SERVICE_PATTERNS.some(r => r.test(path)))
    .filter(path => !EXCLUDE_PATTERNS.some(r => r.test(path)))
    .slice(0, 30);
}
```

### B3. Schema Changes — `lib/db/schema.ts`

Add 2 new JSONB columns to `geoSites` table definition (after `promptArchitectureVersion`, before `createdAt`):

```typescript
// Brand detection (ES-059 / Part A)
brandKeywords:        jsonb("brand_keywords").$type<BrandKeywords>(),
// LLM category extraction (ES-059 / Part B)
extractedCategories:  jsonb("extracted_categories").$type<ExtractedCategories>(),
```

Import types at top of schema.ts:
```typescript
import type { BrandKeywords } from "@/lib/services/brand-detector";
import type { ExtractedCategories } from "@/lib/services/category-extractor";
```

### B4. DDL Migration

**File:** `lib/db/migrations/20260325-brand-keywords-categories.sql`

```sql
ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS brand_keywords jsonb,
  ADD COLUMN IF NOT EXISTS extracted_categories jsonb;
```

Both nullable, no defaults. Populated lazily or via pipeline.

### B5. Modify `lib/services/citation-checker.ts`

#### B5.1 Import new `detectMention`

Replace the old `detectMention` function (lines 40-87) with an import:

```typescript
import { detectMention } from "@/lib/services/brand-detector";
```

Delete the old function body (lines 40-87).

#### B5.2 Update `runCitationCheck` signature

Add `brandKeywords` and `categoryKeywords` to params:

```typescript
export async function runCitationCheck(
  checkId: string,
  siteId: string,
  domain: string,
  prompts: CitationPrompt[],
  callbacks: CitationCheckerCallbacks,
  discoveredCompetitors?: DiscoveredCompetitor[],
  brandKeywords?: BrandKeywords | null,         // NEW
  categoryKeywords?: string[],                  // NEW
): Promise<{ ... }>
```

#### B5.3 Pass to detectMention

At line 276, change:
```typescript
// OLD:
const { mentioned, position, sentiment } = detectMention(text, domain);
// NEW:
const { mentioned, position, sentiment } = detectMention(text, domain, brandKeywords, categoryKeywords);
```

### B6. Modify `app/api/sites/[id]/citation-check/route.ts`

#### B6.1 Lazy Brand Keyword Extraction

After the lazy tree extraction block (~line 123), add brand keyword extraction:

```typescript
// ── ES-059: Brand keyword extraction (lazy) ─────────────────
import { extractBrandKeywords } from "@/lib/services/brand-detector";

let brandKeywords = site.brandKeywords as BrandKeywords | null;
if (!brandKeywords) {
  const bj = site.generatedBusinessJson as Record<string, unknown> | null;
  brandKeywords = extractBrandKeywords(site.domain, bj);
  await db.update(geoSites)
    .set({ brandKeywords })
    .where(eq(geoSites.id, siteId));
  console.info(`[citation-check] ${site.domain}: brand keywords extracted (${brandKeywords.keywords.length} keywords, ambiguous=${brandKeywords.isAmbiguous})`);
}
```

#### B6.2 Lazy Category Extraction

After brand keyword extraction, add category extraction:

```typescript
// ── ES-059: Category extraction (lazy) ─────────────────────
import { extractCategoriesViaHaiku } from "@/lib/services/category-extractor";

let extractedCategories = site.extractedCategories as ExtractedCategories | null;
if (!extractedCategories) {
  extractedCategories = await extractCategoriesViaHaiku(
    site.domain,
    site.siteType ?? null,
    site.generatedBusinessJson as Record<string, unknown> | null,
    site.generatedLlmsTxt ?? null,
    site.crawlData,
    site.categoryTree as CategoryTree | null,
  );
  await db.update(geoSites)
    .set({ extractedCategories })
    .where(eq(geoSites.id, siteId));
  console.info(`[citation-check] ${site.domain}: categories extracted (${extractedCategories.categories.length} categories, noun="${extractedCategories.entityNoun}", source=${extractedCategories.source})`);
}
```

#### B6.3 Pass to runCitationCheck

At the `runCitationCheck` call (~line 163), add the new params:

```typescript
const categoryKeywords = extractedCategories?.categories ?? [];

const result = await runCitationCheck(checkId, siteId, site.domain, prompts, {
  // ... existing callbacks ...
}, discoveredCompetitors, brandKeywords, categoryKeywords);
```

#### B6.4 Pass extractedCategories to generatePrompts

Update the `generatePrompts()` call (~line 141) to include `extractedCategories`:

```typescript
const prompts = await generatePrompts({
  domain: site.domain,
  // ... existing fields ...
  extractedCategories,   // NEW
});
```

### B7. Modify `lib/services/citation-prompt-generator.ts`

#### B7.1 Update `GeneratePromptsSite` type

Add `extractedCategories` field:

```typescript
type GeneratePromptsSite = {
  // ... existing fields ...
  extractedCategories?: ExtractedCategories | null;  // NEW (ES-059)
};
```

#### B7.2 Rewrite `extractCategories()`

Replace the function at lines 927-949:

```typescript
export function extractCategories(site: GeneratePromptsSite): string[] {
  const domainStem = site.domain.replace(/\.[a-z]+$/i, "").toLowerCase();

  // 1. Use persisted extracted categories (Haiku or fallback) — ES-059
  if (site.extractedCategories?.categories && site.extractedCategories.categories.length >= 3) {
    return site.extractedCategories.categories
      .filter(c => !c.toLowerCase().includes(domainStem));
  }

  // 2. businessJson.geo_profile.topics (existing fallback)
  const bj = site.generatedBusinessJson as { geo_profile?: { topics?: unknown[] } } | null;
  const topics = bj?.geo_profile?.topics;
  if (Array.isArray(topics) && topics.length > 0) {
    const cats = topics.filter((t): t is string => typeof t === "string");
    return cats.filter(c => !c.toLowerCase().includes(domainStem));
  }

  // 3. categoryTree leaves (existing fallback)
  const ct = site.categoryTree;
  if (ct) {
    const leaves = collectCategoryLeaves(ct.root);
    return leaves
      .sort((a, b) => b.pageCount - a.pageCount)
      .slice(0, 5)
      .map(n => n.name)
      .filter(c => !c.toLowerCase().includes(domainStem));
  }

  return [];
}
```

#### B7.3 Add `getEntityNoun()` helper

```typescript
const INDUSTRY_NOUN_MAP: Record<string, string> = {
  healthcare: "hospitals",
  hospital: "hospitals",
  dental: "dental clinics",
  consulting: "consultancies",
  software: "platforms",
  saas: "platforms",
  finance: "financial institutions",
  insurance: "insurers",
  legal: "law firms",
  education: "schools",
  retail: "stores",
  restaurant: "restaurants",
  manufacturing: "manufacturers",
  construction: "contractors",
  marketing: "agencies",
  "real estate": "agencies",
  travel: "tour operators",
  fitness: "studios",
};

export function getEntityNoun(site: GeneratePromptsSite): string {
  // 1. From extracted categories (Haiku)
  if (site.extractedCategories?.entityNoun) {
    return site.extractedCategories.entityNoun;
  }
  // 2. From industry-noun map (substring match on siteType)
  const st = (site.siteType ?? "").toLowerCase();
  for (const [key, noun] of Object.entries(INDUSTRY_NOUN_MAP)) {
    if (st.includes(key)) return noun;
  }
  // 3. Default
  return "companies";
}
```

#### B7.4 Update `buildSeeds()` — Replace Hardcoded Nouns

At lines 1130-1158, change `buildSeeds` to accept an `entityNoun` parameter:

```typescript
export function buildSeeds(triples: Triple[], _domain: string, entityNoun: string = "companies"): Seed[] {
  const angleCounts = new Map<Angle, number>();
  return triples.map(({ category, geoLevel, angle }, i) => {
    const geoSuffix = geoLevel.name ? ` in ${geoLevel.name}` : "";

    const text: Record<Angle, string> = {
      discovery:  `What are the best ${category} ${entityNoun}${geoSuffix}?`,
      evaluation: `Which ${category} ${entityNoun}${geoSuffix} have published case studies with measurable results?`,
      trust:      `Who are the most trusted ${entityNoun} for ${category}${geoSuffix}?`,
      clarity:    `Which ${entityNoun} should I consider for ${category}${geoSuffix}?`,
      readiness:  `Which ${entityNoun} for ${category}${geoSuffix} offer free trials or consultations?`,
    };
    // ... rest unchanged ...
  });
}
```

#### B7.5 Update callers of `buildSeeds()`

In `generatePromptsV2()` (~line 1248):

```typescript
export async function generatePromptsV2(
  site: GeneratePromptsSite
): Promise<CitationPrompt[]> {
  const categories = extractCategories(site);
  const geoLevels  = extractGeoLevels(site.geoTree ?? null);
  const triples    = buildCoveringArray(categories, geoLevels, 36);
  const entityNoun = getEntityNoun(site);  // NEW
  const seeds      = buildSeeds(triples, site.domain, entityNoun);  // CHANGED
  // ... rest unchanged ...
```

### B8. Backward Compatibility

- `detectMention()` accepts optional `brandKeywords` — when null, falls back to domain-stem matching (existing behavior)
- `extractCategories()` checks `extractedCategories` first, then falls through to existing fallback chain
- `buildSeeds()` defaults `entityNoun` to "companies" if not provided
- Brand detection version tracked by existing `promptArchitectureVersion` flag (V1 = domain stem, V2 = brand keywords)
- No retroactive re-scoring of existing checks

---

## c) Unit Test Plan

**File:** `__tests__/services/brand-detector.test.ts`

**Framework:** Vitest

### Brand Detection Tests

| # | Test | Input | Expected |
|---|------|-------|----------|
| UT1 | extractBrandKeywords from vendor.name | domain="manipalhospitals.com", businessJson=`{vendor:{name:"Manipal Hospitals Ltd"}}` | keywords includes "manipal hospitals", "manipal", "manipalhospitals"; source="vendor" |
| UT2 | Alias includes legal suffix stripping | vendor.name="Manipal Hospitals Ltd" | "manipal hospitals ltd" AND "manipal hospitals" both in keywords |
| UT3 | Alias includes first N-1 words | vendor.name="Manipal Hospitals" | "manipal" in keywords |
| UT4 | Alias includes singular/plural | vendor.name="Manipal Hospitals" | "manipal hospital" in keywords |
| UT5 | Keywords sorted longest-first | vendor.name="Manipal Hospitals Ltd" | keywords[0].length >= keywords[1].length for all adjacent pairs |
| UT6 | Ambiguity: "Nile" in common-word dict | vendor.name="Nile" | isAmbiguous=true |
| UT7 | Ambiguity: "Manipal" NOT in dict | vendor.name="Manipal" | isAmbiguous=false |
| UT8 | Vendor.name validation: overlap found | vendor.name="Manipal Hospitals", domain="manipalhospitals.com" | source="vendor" (not "domain") |
| UT9 | Vendor.name validation: zero overlap | vendor.name="Best Healthcare", domain="xyzmedical.com" | source="domain", warning logged |
| UT10 | Fallback to domain stem when no businessJson | businessJson=null | keywords derived from domain; source="domain" |
| UT11 | Fallback to geo_profile.business_name | businessJson=`{geo_profile:{business_name:"NileHQ"}}`, no vendor.name | keywords include "nilehq" |
| UT12 | detectMention: brand keyword match (non-ambiguous) | text="Manipal Hospitals is great", brand="manipal hospitals", isAmbiguous=false | mentioned=true |
| UT13 | detectMention: brand keyword match (ambiguous, category nearby) | text="Nile's digital transformation consulting is excellent", brand="nile", categoryKeywords=["transformation"] | mentioned=true |
| UT14 | detectMention: brand keyword match (ambiguous, no category) | text="The Nile river flows through Egypt", brand="nile", categoryKeywords=["consulting"] | mentioned=false |
| UT15 | detectMention: proximity window exactly 300 chars | category keyword at position 301 away from brand | mentioned=false |
| UT16 | detectMention: longest keyword matches first | keywords=["manipal hospitals", "manipal"], text="Manipal" | matches "manipal" (since "manipal hospitals" doesn't match full phrase) |
| UT17 | detectMention: domain URL fallback | text="visit manipalhospitals.com", no keyword match | mentioned=true |
| UT18 | detectMention: backward compat (no brandKeywords) | text="manipalhospitals is great", brandKeywords=null | mentioned=true (domain-stem logic) |
| UT19 | detectMention: sentiment detection | text="Manipal Hospitals is the best", positive keyword | sentiment="positive" |
| UT20 | detectMention: position extraction | text="1. ABC\n2. Manipal Hospitals\n3. XYZ" | position=2 |
| UT21 | No acronym generation | vendor.name="Manipal Hospitals" | keywords does NOT contain "mh" |
| UT22 | Domain-stem common split | domain="manipalhospitals.com" | keywords includes "manipal hospitals" |

**File:** `__tests__/services/category-extractor.test.ts`

### Category Extraction Tests

| # | Test | Input | Expected |
|---|------|-------|----------|
| UT23 | Haiku returns valid categories + entityNoun | Mock Haiku returns `{categories:["Oncology","Cardiology","Orthopedics"],entityNoun:"hospitals"}` | source="haiku", categories=3, entityNoun="hospitals" |
| UT24 | Haiku returns <3 valid after validation → topics fallback | Mock Haiku returns 2 categories; topics=["Digital","Strategy","Compliance"] | source="topics", 3 categories |
| UT25 | Haiku timeout → topics fallback | Mock Haiku rejects after 10s | source="topics" or "tree" |
| UT26 | Page URL filtering: includes service patterns | URLs with /departments/oncology, /services/cardiology, /blog/cancer | Only /departments/ and /services/ returned |
| UT27 | Page URL filtering: excludes blog patterns | URLs with /blog/hiv, /news/update | Empty result |
| UT28 | Page URL filtering: max 30 | 50 service URLs | 30 returned |
| UT29 | Category dedup: substring removal | ["Oncology", "Oncology Department", "Cardiology"] | ["Oncology", "Cardiology"] |
| UT30 | Cross-reference validation: ≥2 match | categories=["Oncology","Cardiology","Neuro"], tree contains "Oncology" + "Cardiology" | valid=true |
| UT31 | Cross-reference validation: <2 match | categories=["Strategy","Innovation","Compliance"], tree empty, no matching URLs | valid=false → fallback |
| UT32 | Minimum input guard: <200 chars | llmsTxt="" + homepage="" | Haiku skipped, fallback used |
| UT33 | entityNoun validation: >30 chars → empty | entityNoun="this is way too long to be a valid entity noun" | entityNoun="" → falls back to INDUSTRY_NOUN_MAP |
| UT34 | Full fallback chain: Haiku fails + no topics + no tree | all sources empty, siteType="healthcare" | categories=["healthcare"], entityNoun="hospitals", source="fallback" |
| UT35 | Haiku response with markdown code fences | Response wrapped in ````json ... ``` `` | Correctly parsed |

### Template Tests

**File:** `__tests__/services/citation-prompt-generator.test.ts` (add to existing)

| # | Test | Input | Expected |
|---|------|-------|----------|
| UT36 | buildSeeds uses entityNoun "hospitals" | entityNoun="hospitals", category="Oncology" | discovery template: "What are the best Oncology hospitals?" |
| UT37 | buildSeeds defaults to "companies" | entityNoun not provided | "What are the best Oncology companies?" |
| UT38 | getEntityNoun from extractedCategories | extractedCategories.entityNoun="hospitals" | returns "hospitals" |
| UT39 | getEntityNoun from INDUSTRY_NOUN_MAP | extractedCategories=null, siteType="healthcare" | returns "hospitals" |
| UT40 | getEntityNoun default | extractedCategories=null, siteType=null | returns "companies" |
| UT41 | Trust template uses noun correctly | entityNoun="hospitals", category="Cardiology" | "Who are the most trusted hospitals for Cardiology?" |
| UT42 | extractCategories prefers extractedCategories | site has both extractedCategories (3+) AND topics | returns extractedCategories, not topics |

---

## d) Integration Test Plan

**File:** `__tests__/integration/brand-detection-category-flow.test.ts`

| # | Test | Scenario | Expected |
|---|------|----------|----------|
| IT1 | Full citation check with brand keywords | Mock SSE with "Manipal Hospitals" in AI response, brandKeywords set | visibility > 0% |
| IT2 | Full citation check with extracted categories | extractedCategories populated | prompts use real service names, not blog topics |
| IT3 | Lazy brand extraction | brandKeywords=null on geoSites, mock businessJson.vendor.name | brandKeywords extracted and persisted to DB before check runs |
| IT4 | Lazy category extraction | extractedCategories=null, mock Haiku response | extractedCategories extracted and persisted |
| IT5 | Lazy extraction only runs once | Run citation check twice | Second run reuses persisted data (no Haiku call) |
| IT6 | Fallback chain: no Haiku → topics → tree → siteType | Mock Haiku failure, no topics, no tree | categories=[siteType], source="fallback" |
| IT7 | Ambiguous brand with category proximity | brand="Nile", AI text mentions "Nile" near "consulting" | mentioned=true |
| IT8 | Ambiguous brand without category proximity | brand="Nile", AI text mentions "Nile river" with no category keywords nearby | mentioned=false |
| IT9 | V1 backward compat | site with no brandKeywords, no extractedCategories | detection uses domain stem, categories use topics/tree (unchanged) |
| IT10 | Prompt templates contain entityNoun | extractedCategories.entityNoun="hospitals" | seed prompts contain "hospitals" not "companies"/"firms" |

---

## e) Profiling Requirements

### What to measure
- **`extractBrandKeywords()`:** Execution time with vendor.name containing 5+ words
- **`detectMention()` with 80-keyword ambiguity dict:** Time per call with 500-char response text
- **Haiku category extraction:** Round-trip time (network-bound, expect 1-3s)

### Baseline expectations
- `extractBrandKeywords()`: < 1ms (pure string ops)
- `detectMention()`: < 2ms per call (regex matching, called ~60-100 times per check)
- Total brand detection overhead per citation check: < 200ms
- Haiku call: < 10s (timeout enforced)

### Tool
- `console.time()` / `console.timeEnd()` in citation-check route (temporary)
- Remove before merge

---

## f) Load Test Plan

Not directly applicable — the Haiku call is once per site (persisted), and brand detection is O(n) string matching. The existing citation check load tests cover the overall pipeline.

---

## g) Logging & Instrumentation

### Events to log

| Event | Level | Format |
|-------|-------|--------|
| Brand keywords extracted | info | `[brand-detector] {domain}: {count} keywords, ambiguous={bool}, source={source}` |
| Vendor.name zero-overlap | warn | `[brand-detector] vendor.name "{name}" has zero overlap with domain "{domain}" — possible hallucination` |
| Categories extracted (Haiku) | info | `[citation-check] {domain}: categories extracted ({count} categories, noun="{noun}", source={source})` |
| Haiku call failed | warn | `[category-extractor] {domain}: Haiku failed: {error}` |
| Haiku input too short | info | `[category-extractor] {domain}: skipping Haiku (input {len} chars < 200 minimum)` |
| Lazy brand extraction | info | `[citation-check] {domain}: brand keywords extracted ({count} keywords, ambiguous={bool})` |
| Lazy category extraction | info | `[citation-check] {domain}: categories extracted ({count} categories, noun="{noun}", source={source})` |

### Log level guidance
- `info` for normal operations
- `warn` for fallbacks and validation failures
- No `error` level — all errors are recoverable (fallback chain)

---

## h) Acceptance Criteria

| # | Criterion | Spec Section |
|---|-----------|-------------|
| AC1 | Brand keywords extracted from vendor.name with auto-generated aliases (legal suffix stripping, first N-1 words, domain stem, common splits, singular/plural) | B1.4 |
| AC2 | Keywords sorted longest-first for matching priority | B1.4 |
| AC3 | No acronym generation (DO NOT generate "MH" from "Manipal Hospitals") | B1.4 |
| AC4 | Common-word dictionary (~80 entries) triggers `isAmbiguous=true` for matching keywords | B1.5 |
| AC5 | Proximity check: 300-char window, category keyword required for confirmation | B1.6 |
| AC6 | Domain URL matching retained as complementary check alongside brand keywords | B1.6 |
| AC7 | Vendor.name validated against domain stem — zero-overlap logs warning, falls back to domain | B1.3 |
| AC8 | `brandKeywords` persisted as JSONB column on geoSites | B3, B4 |
| AC9 | Haiku call extracts 5-7 categories + entityNoun from llms.txt + homepage + page URLs + tree hints | B2.2, B2.3 |
| AC10 | Validation: length check (2-50 chars), dedup (substring removal), cross-reference (≥2 match) | B2.4 |
| AC11 | Minimum input guard: ≥200 chars combined or skip Haiku | B2.2 |
| AC12 | Page URL filtering: include service patterns, exclude blog/news, max 30 | B2.5 |
| AC13 | `extractedCategories` persisted as JSONB column on geoSites | B3, B4 |
| AC14 | Fallback chain: Haiku → topics → tree → siteType | B2.2 |
| AC15 | Lazy brand keyword extraction at citation check time (atomic guard) | B6.1 |
| AC16 | Lazy category extraction at citation check time (atomic guard) | B6.2 |
| AC17 | Entity noun from extractedCategories.entityNoun (primary) or INDUSTRY_NOUN_MAP (fallback) or "companies" (default) | B7.3 |
| AC18 | All 5 seed templates use `{entityNoun}` instead of hardcoded "companies"/"firms"/"providers"/"services" | B7.4 |
| AC19 | `extractCategories()` prefers `extractedCategories` over topics/tree | B7.2 |
| AC20 | `runCitationCheck` passes brandKeywords + categoryKeywords to detectMention | B5.2, B5.3 |
| AC21 | Backward compatible: null brandKeywords → domain-stem matching (V1 behavior) | B1.6, B8 |
| AC22 | Backward compatible: null extractedCategories → existing fallback chain | B7.2, B8 |
| AC23 | `CitationPrompt[]` shape unchanged — no downstream interface changes | B8 |
| AC24 | DDL migration adds both columns as nullable JSONB | B4 |
| AC25 | 42 unit tests pass (UT1-UT42) | §c |
| AC26 | 10 integration tests pass (IT1-IT10) | §d |

---

## ScriptDev Implementation Notes

1. **Start with B3+B4** (schema + migration) — run migration before anything else.
2. **B1 (brand-detector.ts)** is self-contained — can be developed and tested independently. Write UT1-UT22 first.
3. **B2 (category-extractor.ts)** has a Haiku dependency — mock in tests. Write UT23-UT35.
4. **B5 (citation-checker.ts)** is a small surgery — delete old `detectMention()`, add import + 2 new params to `runCitationCheck`, pass them through at line 276.
5. **B7 (citation-prompt-generator.ts)** — `extractCategories()` rewrite is minimal (add one `if` block at top). `getEntityNoun()` + `INDUSTRY_NOUN_MAP` are new additions. `buildSeeds()` just needs an extra param.
6. **B6 (route.ts)** ties it all together — lazy extraction blocks should follow the same pattern as the existing lazy tree extraction at lines 102-123.
7. **The common-word dictionary** (B1.5) should be a module-level `Set` — no file I/O, no runtime cost. Start with the ~80 words in the TS, can be expanded later.
8. **Haiku response parsing** (B2) — always handle markdown code fences: strip `` ```json `` and `` ``` `` before JSON.parse. This is a common Haiku behavior.
9. **Domain leak prevention** — `extractCategories()` already filters domain stems (FIX-3). Keep this filter in the rewritten version for all sources including extractedCategories.
