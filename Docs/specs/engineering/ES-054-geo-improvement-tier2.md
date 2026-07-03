# ES-054: GEO Improvement Tier 2 — Measurement Depth

**Source:** TS-054-geo-improvement-tier2.md
**Author:** SpecMaster (Agent 2)
**Date:** 2026-03-23
**Branch:** `dev-an-geo`
**Issues:** #140 (C5), #141 (C6), #142 (C7), #148 (visibility metrics), #149 (recommendations)
**Depends on:** ES-053 (Tier 1 — trees and tagged prompts must exist)

---

## a) Overview

### What This Covers

Five changes that deepen measurement and reporting of GEO visibility:

| Component | Summary |
|-----------|---------|
| **C5** | Per-city and per-category visibility breakdown from tagged prompts |
| **C6** | Buy/Solve/Learn tier scoring with business-value interpretation |
| **C7** | Geographic signals as 17th GEO pillar (deterministic, no LLM) |
| **Cross** | Impression share metric + enriched execution prompt |
| **Cross** | Evidence-based recommendations + crawl coverage validation |

### Current Implementation State

**Exists:**
- `lib/services/citation-checker.ts` — `runCitationCheck()` groups responses by provider, computes `pillarVisibility`, `competitorData`, `citationQualityScore`. Returns aggregated results.
- `lib/services/geo-analyzer.ts` — 16 pillars scored via Gemini. Weighted overall score. `GEO_PILLARS` array (lines 76–93), pillar weights (lines 95–112).
- `lib/services/assembler.ts` — `assembleResults()` produces `executiveSummary` + `rankedRecommendations`. Ranks by `weight × (100 - score)`.
- `lib/services/page-fix-generator.ts` — `generatePerPageFixes()` batches of 15, max 100 pages, gpt-4o-mini.
- `citationCheckScores` has: overallVisibility, indirectVisibility, brandKnowledge, citationQualityScore, pillarVisibility, pillarQA, providerResults, competitorData, promptsUsed, promptMetadata (ES-053).
- `citationCheckResponses` has: per-response mentioned, position, sentiment, competitorsMentioned.

**Does not exist (new):**
- Per-geo / per-category visibility aggregation
- Tier-based (buy/solve/learn) visibility scoring
- Geographic signals (17th) pillar
- Impression share metric
- Crawl coverage validation service
- Evidence-based recommendation enrichment
- Visibility gap analysis

---

## b) Implementation Requirements

### b.1 Schema Changes

**File:** `lib/db/schema.ts`

**On `citationCheckScores`** (add after `promptMetadata`):

```typescript
geoVisibility: jsonb("geo_visibility").$type<GeoVisibility[]>().default([]),
categoryVisibility: jsonb("category_visibility").$type<CategoryVisibility[]>().default([]),
tierVisibility: jsonb("tier_visibility").$type<TierVisibility[]>().default([]),
avgImpressionShare: integer("avg_impression_share"),
visibilityGapAnalysis: jsonb("visibility_gap_analysis").$type<VisibilityGapEntry[]>().default([]),
```

**On `citationCheckResponses`** (add after existing fields):

```typescript
impressionShare: integer("impression_share"), // 0-100, nullable
```

**On `geoSites`** (add after `implementationStatus`):

```typescript
crawlCoverageReport: jsonb("crawl_coverage_report").$type<CrawlCoverageReport>(),
```

**SQL migration** (`geo/drizzle/XXXX_tier2_columns.sql`):

```sql
ALTER TABLE citation_check_scores
  ADD COLUMN geo_visibility jsonb DEFAULT '[]',
  ADD COLUMN category_visibility jsonb DEFAULT '[]',
  ADD COLUMN tier_visibility jsonb DEFAULT '[]',
  ADD COLUMN avg_impression_share integer,
  ADD COLUMN visibility_gap_analysis jsonb DEFAULT '[]';

ALTER TABLE citation_check_responses
  ADD COLUMN impression_share integer;

ALTER TABLE geo_sites
  ADD COLUMN crawl_coverage_report jsonb;
```

### b.2 Type Definitions

**File:** `lib/types/citation.ts` — Add these types:

```typescript
export type GeoVisibility = {
  geoId: string;
  geoName: string;
  promptCount: number;
  mentionCount: number;
  visibility: number;   // mentionCount / promptCount * 100
};

export type CategoryVisibility = {
  categoryId: string;
  categoryName: string;
  promptCount: number;
  mentionCount: number;
  visibility: number;
};

export type TierVisibility = {
  tier: "buy" | "solve" | "learn";
  promptCount: number;
  mentionCount: number;
  visibility: number;
};

export type VisibilityGapEntry = {
  dimension: "geo" | "category" | "tier";
  id: string;
  name: string;
  visibility: number;
  gap: string;            // human-readable gap description
  recommendation: string;
};

export type CrawlCoverageReport = {
  totalDiscovered: number;
  totalCrawled: number;
  coveragePercent: number;
  missingPageTypes: string[];
  blogPercent: number;
  structuralPercent: number;
  warnings: string[];
};
```

### b.3 C5: Per-City and Per-Category Visibility Breakdown

**File:** `lib/services/citation-checker.ts`

**Modify `runCitationCheck()`** — add new aggregation after existing pillarVisibility computation (around line 416):

Add a new parameter to accept prompt metadata:
```typescript
export async function runCitationCheck(
  checkId: string,
  siteId: string,
  domain: string,
  prompts: CitationPrompt[],
  callbacks: CitationCheckerCallbacks,
  discoveredCompetitors?: DiscoveredCompetitor[],
  promptMetadata?: CitationPrompt[]  // NEW — full tagged prompts from ES-053
): Promise<{
  // ... existing return fields ...
  geoVisibility: GeoVisibility[];           // NEW
  categoryVisibility: CategoryVisibility[]; // NEW
  tierVisibility: TierVisibility[];         // NEW
}>
```

**Aggregation logic** (new function):

```typescript
function aggregateByDimension(
  responses: ResponseRow[],
  promptMetadata: CitationPrompt[]
): {
  geoVisibility: GeoVisibility[];
  categoryVisibility: CategoryVisibility[];
  tierVisibility: TierVisibility[];
}
```

Algorithm:
1. Build a lookup map: `prompt string → CitationPrompt` from `promptMetadata`.
2. For each response, look up the prompt's `geoId`, `categoryId`, `tier`.
3. Accumulate per-geoId: `{ promptCount, mentionCount }`. Same for categoryId and tier.
4. Compute `visibility = (mentionCount / promptCount) * 100` for each.
5. Resolve names: geoId → geoName (from geoTree passed as context), categoryId → categoryName (from categoryTree).

**Name resolution:** The function needs access to geoTree and categoryTree to resolve IDs to names. Add these as parameters:

```typescript
function aggregateByDimension(
  responses: ResponseRow[],
  promptMetadata: CitationPrompt[],
  geoTree?: GeoTree | null,
  categoryTree?: CategoryTree | null
): { geoVisibility: GeoVisibility[]; categoryVisibility: CategoryVisibility[]; tierVisibility: TierVisibility[] }
```

Build flat lookup maps by traversing trees: `Map<geoId, geoName>`, `Map<categoryId, categoryName>`.

**Graceful degradation:**
- No geo-tagged prompts → `geoVisibility = []`
- No category-tagged prompts → `categoryVisibility = []`
- No tier-tagged prompts → `tierVisibility = []`
- Existing `overallVisibility`, `indirectVisibility`, `brandKnowledge` unchanged.

### b.4 C6: Buy/Solve/Learn Tier Scoring

Tier visibility is computed as part of `aggregateByDimension()` (see C5 above). The tier field comes from ES-053's `CitationPrompt.tier`.

**Insight generation** (new function in `citation-checker.ts`):

```typescript
export function generateTierInsight(tierVisibility: TierVisibility[]): string | null
```

Logic:
- Find highest and lowest visibility tiers.
- If all equal (within 5 points): return null (no actionable insight).
- If Buy >> Learn (difference > 15): "AI recommends you but doesn't cite your expertise — add educational content"
- If Learn >> Buy (difference > 15): "AI cites your expertise but doesn't recommend you — strengthen product positioning"
- If Solve is lowest (and > 15 below average of other two): "AI doesn't connect your brand to problem-solving — add how-to and use-case content"

**Storage:** The `tierVisibility` array and insight text are stored on `citationCheckScores`.

### b.5 C7: Geographic Signals Scoring Pillar (17th)

**File:** `lib/services/geo-analyzer.ts`

**New function (deterministic, no LLM):**

```typescript
export function scoreGeographicSignals(
  crawlData: CrawlData,
  geoTree?: GeoTree | null
): GeoScore
```

**Scoring rubric (sum, capped at 100):**

| Signal | Points | Detection |
|--------|--------|-----------|
| LocalBusiness schema on ≥1 page | 20 | `page.existingSchema` includes "LocalBusiness" |
| GeoCoordinates in schema | 15 | `page.existingSchema` includes "GeoCoordinates" |
| PostalAddress in schema | 15 | `page.existingSchema` includes "PostalAddress" |
| areaServed in schema | 10 | `page.existingSchema` includes "areaServed" |
| Address in visible content on ≥3 pages | 15 | `page.contactInfo` has address-like patterns on ≥3 pages |
| Location-specific pages exist | 15 | Pages with URL matching `/locations/*`, `/offices/*`, `/branches/*` or pageType matches location patterns |
| Geo meta tags | 10 | `page.content` contains `geo.region` or `geo.placename` patterns |

**Integration into scorecard:**

After `analyzeGeoGaps()` returns the 16-pillar scorecard from Gemini, inject the 17th pillar:

```typescript
// In analyzeGeoGaps(), after LLM scoring (around line 394):
const geoPillar = scoreGeographicSignals(crawlData, geoTree);
scorecard.pillars.push(geoPillar);
// Recompute overall weighted score including the 17th pillar
```

**Pillar metadata:**
- `pillar`: `"geographic_signals"`
- `pillarName`: `"Geographic Signals"`
- Weight: `2.5` (same tier as `licensing_signals` — lowest, optional signal)
- `priority`: score < 20 → "low", 20-50 → "medium", 50-80 → "high", ≥80 → "critical" (inverted: high score = already good = low priority)

**Add to GEO_PILLARS array and PILLAR_WEIGHTS:**

```typescript
// In GEO_PILLARS array (line 93):
{ id: "geographic_signals", name: "Geographic Signals" },

// In PILLAR_WEIGHTS (line 112):
geographic_signals: 2.5,
```

**Backward compatibility:** Old scorecards without this pillar render fine — dashboard iterates `pillars` array dynamically.

### b.6 Cross: Impression Share Metric

**File:** `lib/services/citation-checker.ts`

**New function:**

```typescript
export function computeImpressionShare(response: string, domain: string): number | null
```

Algorithm:
1. Extract domain stem: `domain.replace(/\.(com|io|co|net|org|ai|app|dev).*$/i, "")`.
2. Split response into sentences: `response.split(/[.!?]+/).filter(s => s.trim().length > 0)`.
3. If response has < 50 words total: return `null` (too short for meaningful share).
4. Find sentences mentioning domain stem (case-insensitive regex).
5. Compute: `mentionWords / totalWords * 100`, rounded to integer.

**Integration:** Call `computeImpressionShare()` for each response during batch execution. Store on `citationCheckResponses.impressionShare`.

**Aggregation:** After all responses collected, compute `avgImpressionShare` across responses where `mentioned === true && impressionShare !== null`. Store on `citationCheckScores.avgImpressionShare`.

### b.7 Cross: Enriched Execution Prompt

**File:** `lib/services/citation-checker.ts`

**Modify the system prompt** sent to AI providers during citation execution.

Current (approximate): "Respond with a numbered list of 3-7 items, one sentence each."

New: "Respond with a ranked list of 3-7 relevant options. For each, provide the name and a brief reason why it's relevant."

This is a one-line change in the system prompt constant. Does not affect response parsing — the mention detection regex and position extraction already handle variable-length responses.

### b.8 Cross: Crawl Coverage Validation

**File:** `lib/services/crawl-coverage-validator.ts` (NEW)

```typescript
export function validateCrawlCoverage(
  discoveryData: DiscoveryData,
  crawlData: CrawlData
): CrawlCoverageReport
```

Algorithm:
1. `totalDiscovered = discoveryData.totalPages`
2. `totalCrawled = crawlData.pages.length`
3. `coveragePercent = (totalCrawled / totalDiscovered) * 100`
4. Classify crawled pages by `pageType`. Check for missing structural types:
   - Expected types: `["homepage", "about", "services", "pricing", "contact", "faq"]`
   - `missingPageTypes = expected.filter(t => !crawledTypes.has(t))`
5. `blogPercent = (blogPages / totalCrawled) * 100`
6. `structuralPercent = (structuralPages / totalCrawled) * 100` where structural = homepage, about, services, pricing, contact, team, faq
7. Warnings:
   - `blogPercent > 60`: "Blog pages are {X}% of crawl — structural pages may be under-represented"
   - `coveragePercent < 50`: "Only {X}% of discovered pages were crawled"
   - `missingPageTypes.length > 0`: "Missing page types: {list}"

**Integration in pipeline:**

**File:** `app/api/pipeline/stage/route.ts` — `handleAssemble()`:

```typescript
// After reading crawlData and discoveryData:
const coverageReport = validateCrawlCoverage(discoveryData, crawlData);
await db.update(geoSites).set({ crawlCoverageReport: coverageReport }).where(eq(geoSites.id, siteId));
```

### b.9 Cross: Evidence-Based Recommendations

**File:** `lib/services/assembler.ts`

**New constant: evidence database:**

```typescript
const EVIDENCE_DATABASE: Record<string, { evidence: string; source: string }> = {
  expert_quotes:      { evidence: "+41% visibility", source: "Princeton GEO (KDD 2024)" },
  statistics_data:    { evidence: "+33% visibility", source: "Princeton GEO (KDD 2024)" },
  external_citations: { evidence: "+28% visibility", source: "Princeton GEO (KDD 2024)" },
  answer_first:       { evidence: "44.2% of citations from first 30% of content", source: "Growth Memo (2026)" },
  faq_sections:       { evidence: "4.9 avg citations vs 4.4 without", source: "SE Ranking (2025)" },
  optimal_length:     { evidence: "~61% AI coverage vs ~13% for >3K words", source: "houtini-ai research" },
};
```

**Inject into recommendation generation prompt** in `assembleResults()`:

Add to the LLM system prompt context:
```
Research-backed evidence for recommendations:
- Expert quotes boost visibility by 41% (Princeton GEO, KDD 2024)
- Statistics and data boost by 33% (Princeton GEO, KDD 2024)
- Citing external sources boosts by 28% (Princeton GEO, KDD 2024)
- 44.2% of AI citations come from the first 30% of page content (Growth Memo, 2026)
- Pages with FAQ sections average 4.9 citations vs 4.4 without (SE Ranking, 2025)

Reference specific evidence when making recommendations.
```

**Extend `RankedRecommendation` type:**

```typescript
export interface RankedRecommendation {
  // ... existing fields ...
  evidence: string | null;  // NEW — research backing, e.g., "+41% visibility (Princeton GEO)"
}
```

### b.10 Cross: Visibility Gap Analysis

**File:** `app/api/sites/[id]/citation-check/route.ts`

After citation check completes and geoVisibility/categoryVisibility/tierVisibility are computed:

```typescript
function generateVisibilityGapAnalysis(
  geoVisibility: GeoVisibility[],
  categoryVisibility: CategoryVisibility[],
  tierVisibility: TierVisibility[]
): VisibilityGapEntry[]
```

Algorithm:
1. For each geo entry with visibility < 10%: generate a gap entry.
   - `gap`: "Your {city} presence is invisible to AI."
   - `recommendation`: "Add structured data and FAQ content to {city} location pages."
2. For each category entry with visibility < 10%: generate a gap entry.
   - `gap`: "AI rarely recommends you for {category}."
   - `recommendation`: "Your {category} pages lack expert quotes and case studies."
3. For tier entries: generate insights per `generateTierInsight()`.
4. Sort by visibility ascending (worst gaps first).
5. Cap at top 10 entries.

Store as `visibilityGapAnalysis` on `citationCheckScores`.

### b.11 Cross: Services List Validation

**File:** `app/api/pipeline/stage/route.ts` — `handleGenerateChunk()` for type "business"

After generating business.json, if `categoryTree` exists on the site:

```typescript
const catLeafCount = site.categoryTree?.leafCount ?? 0;
const servicesCount = generatedBusinessJson?.services?.length ?? 0;
if (catLeafCount > 5 * servicesCount && catLeafCount > 10) {
  console.warn(
    `[generate-chunk:business] ${domain}: business.json lists ${servicesCount} services but site has ~${catLeafCount} distinct service pages. Profile may be incomplete.`
  );
  // Optionally store warning on site record for dashboard surfacing
}
```

---

## c) Unit Test Plan

**File:** `__tests__/services/citation-checker-dimensions.test.ts` (NEW)

| # | Test | Input | Expected |
|---|------|-------|----------|
| U1 | aggregateByDimension groups by geoId | 10 responses, 5 geo-tagged | geoVisibility has entries for each unique geoId |
| U2 | aggregateByDimension groups by categoryId | 10 responses, 8 category-tagged | categoryVisibility populated |
| U3 | aggregateByDimension groups by tier | Responses with buy/solve/learn tags | tierVisibility has exactly 3 entries |
| U4 | aggregateByDimension handles null tags | Prompts with no geoId/categoryId/tier | Empty arrays for all dimensions |
| U5 | geoVisibility computes correct percentage | 4/10 prompts for geoId "blr" mentioned | visibility = 40 |
| U6 | categoryVisibility handles single category | All prompts tagged same categoryId | 1 entry with correct visibility |
| U7 | Name resolution from trees | geoId "in-ka-blr" with geoTree | geoName = "Bangalore" |
| U8 | Name resolution with missing tree | geoId without tree | geoName = geoId (fallback) |
| U9 | computeImpressionShare for single mention | Response with 7 items, 1 is brand | ~14% |
| U10 | computeImpressionShare for dominant mention | Response mostly about brand | >50% |
| U11 | computeImpressionShare returns null for short response | <50 words | null |
| U12 | computeImpressionShare with no mention | Response without brand | 0 |
| U13 | generateTierInsight Buy >> Learn | Buy 60%, Learn 20%, Solve 40% | "doesn't cite your expertise" message |
| U14 | generateTierInsight all equal | All tiers within 5 points | null |
| U15 | generateTierInsight Solve lowest | Buy 50%, Learn 45%, Solve 15% | "doesn't connect to problem-solving" message |

**File:** `__tests__/services/geo-analyzer-geo-pillar.test.ts` (NEW)

| # | Test | Input | Expected |
|---|------|-------|----------|
| U16 | scoreGeographicSignals full signals | Pages with LocalBusiness, GeoCoordinates, PostalAddress, addresses, location pages | Score ≥ 80 |
| U17 | scoreGeographicSignals no geo signals | SaaS pages, no addresses, no schema | Score ≤ 10 |
| U18 | scoreGeographicSignals partial signals | LocalBusiness schema only | Score = 20 |
| U19 | scoreGeographicSignals address threshold | Addresses on 2 pages (below threshold of 3) | No points for address signal |
| U20 | scoreGeographicSignals location pages | URLs matching /locations/* | +15 points |
| U21 | 17th pillar injected into scorecard | Full analyzeGeoGaps flow | scorecard.pillars.length === 17, last is geographic_signals |
| U22 | Overall score includes 17th pillar weight | Score computation | Weight 2.5 included in denominator |

**File:** `__tests__/services/crawl-coverage-validator.test.ts` (NEW)

| # | Test | Input | Expected |
|---|------|-------|----------|
| U23 | validateCrawlCoverage full coverage | 100 discovered, 100 crawled | coveragePercent = 100, no warnings |
| U24 | validateCrawlCoverage low coverage | 500 discovered, 50 crawled | coveragePercent = 10, warning |
| U25 | validateCrawlCoverage missing types | No services or pricing pages crawled | missingPageTypes includes "services", "pricing" |
| U26 | validateCrawlCoverage blog-heavy | 90 blog, 10 structural | blogPercent = 90, warning about blog-heavy |
| U27 | validateCrawlCoverage empty crawl | 0 pages crawled | coveragePercent = 0, warnings |

**File:** `__tests__/services/assembler-evidence.test.ts` (NEW)

| # | Test | Input | Expected |
|---|------|-------|----------|
| U28 | RankedRecommendation includes evidence field | Recommendation for faq_coverage pillar | evidence contains "SE Ranking" |
| U29 | Evidence injected into LLM prompt | assembleResults called | System prompt contains Princeton GEO reference |
| U30 | Visibility gap analysis prioritizes worst gaps | geo: Blr=40%, Del=0%, Kol=5% | Del first, Kol second |
| U31 | Visibility gap analysis caps at 10 | 20 low-visibility entries | Max 10 returned |
| U32 | Visibility gap ignores entries above 10% | All visibility > 10% | Empty array |

**Mocking:** Mock LLM clients (Anthropic, OpenAI, Google, Perplexity), mock DB queries. Use Vitest.

---

## d) Integration Test Plan

**File:** `__tests__/integration/citation-check-tier2.test.ts` (NEW)

| # | Test | Scenario | Expected |
|---|------|----------|----------|
| IT1 | Citation check stores geo/category/tier visibility | Full citation check with tagged prompts | citationCheckScores has geoVisibility, categoryVisibility, tierVisibility populated |
| IT2 | Citation check stores impression share | Full check | citationCheckResponses.impressionShare populated, citationCheckScores.avgImpressionShare computed |
| IT3 | Citation check stores visibility gap analysis | Check with mixed visibility results | visibilityGapAnalysis has ≥1 entry |
| IT4 | GEO analysis includes 17th pillar | Full pipeline through analyze | geoScorecard.pillars has 17 entries |
| IT5 | Assemble stores crawl coverage report | Full pipeline through assemble | geoSites.crawlCoverageReport populated |
| IT6 | End-to-end: tagged prompts → dimensional visibility | Pipeline + citation check | geo/category breakdowns match prompt tags |
| IT7 | Backward compat: legacy prompts produce empty arrays | Citation check with untagged prompts | geoVisibility=[], categoryVisibility=[], tierVisibility=[] |

---

## e) Profiling Requirements

| Metric | Target | Tool |
|--------|--------|------|
| aggregateByDimension latency | < 10ms for 48 prompts × 4 providers | In-code timer |
| computeImpressionShare latency | < 1ms per response | In-code timer |
| scoreGeographicSignals latency | < 50ms for 200-page crawl | In-code timer |
| validateCrawlCoverage latency | < 10ms | In-code timer |

All new computation is deterministic (no LLM calls). Negligible performance impact.

---

## f) Load Test Plan

| Scenario | Description | Success Criteria |
|----------|-------------|-----------------|
| L1 | 100 sequential citation checks with tagged prompts | geo/category aggregation consistent, no memory leak |
| L2 | Scorecard with 17 pillars renders in dashboard | No frontend crash, weight computation correct |

---

## g) Logging & Instrumentation

| Event | Level | Fields |
|-------|-------|--------|
| `citation-check.dimension-aggregation` | info | domain, geoEntries, categoryEntries, tierEntries |
| `citation-check.impression-share` | debug | domain, avgImpressionShare, responseCount |
| `citation-check.tier-insight` | info | domain, insight |
| `geo-analyzer.geographic-signals` | info | domain, score, signals |
| `crawl-coverage.report` | info | domain, coveragePercent, blogPercent, missingTypes |
| `crawl-coverage.blog-heavy` | warn | domain, blogPercent |
| `assembler.evidence-recommendations` | debug | domain, recsWithEvidence |
| `citation-check.visibility-gaps` | info | domain, gapCount, worstGap |

---

## h) Acceptance Criteria

### C5: Per-City/Category Visibility

- [ ] **AC1**: `geoVisibility` array on citationCheckScores has entries for each unique geoId from tagged prompts
- [ ] **AC2**: `categoryVisibility` array has entries for each unique categoryId
- [ ] **AC3**: For Manipal-like site (rich trees): geoVisibility has entries for Bangalore, Delhi, Kolkata, etc.
- [ ] **AC4**: For SaaS (no geo): geoVisibility is empty array
- [ ] **AC5**: For single-service business: categoryVisibility has 1-2 entries
- [ ] **AC6**: Visibility % correct: `mentionCount / promptCount × 100`
- [ ] **AC7**: Overall visibility unchanged (backward compatible)
- [ ] **AC8**: Name resolution works: geoId → human-readable geoName from tree

### C6: Tier Scoring

- [ ] **AC9**: `tierVisibility` has exactly 3 entries (buy, solve, learn) when tree-based prompts used
- [ ] **AC10**: `tierVisibility` is empty array when legacy prompts used (backward compat)
- [ ] **AC11**: Tier insight generated when visibility difference > 15 points between tiers

### C7: Geographic Signals Pillar

- [ ] **AC12**: `scoreGeographicSignals()` deterministic — no LLM call
- [ ] **AC13**: Healthcare site with LocalBusiness + addresses: score ≥ 40
- [ ] **AC14**: SaaS with no addresses: score ≤ 10
- [ ] **AC15**: Pillar weight = 2.5
- [ ] **AC16**: Scorecard has 17 pillars after analysis
- [ ] **AC17**: Backward compat: old 16-pillar scorecards still render

### Cross: Impression Share

- [ ] **AC18**: `impressionShare` computed per response (0-100) when response > 50 words
- [ ] **AC19**: `impressionShare` = null when response < 50 words
- [ ] **AC20**: `avgImpressionShare` aggregated on check scores (average of non-null mentioned responses)

### Cross: Recommendations

- [ ] **AC21**: Crawl coverage report generated during assemble stage
- [ ] **AC22**: Blog-heavy crawls (>60%) produce a warning in report
- [ ] **AC23**: Missing page types detected and listed
- [ ] **AC24**: Recommendations include evidence citations (Princeton, SE Ranking)
- [ ] **AC25**: `RankedRecommendation` type has `evidence` field
- [ ] **AC26**: Gap-prioritized recs generated when geo/category visibility exists
- [ ] **AC27**: Gap analysis capped at top 10 entries, sorted by worst visibility first

### Cross: Execution Prompt

- [ ] **AC28**: Citation execution system prompt uses enriched format ("name and a brief reason")
- [ ] **AC29**: Existing mention/position detection still works with enriched responses

### Schema & Infrastructure

- [ ] **AC30**: Migration adds all new columns (nullable or defaulted)
- [ ] **AC31**: Unit tests U1–U32 pass
- [ ] **AC32**: Integration tests IT1–IT7 pass

---

## ScriptDev Notes

1. **C5 depends on ES-053's `promptMetadata`** — the geoId/categoryId/tier tags come from the extended CitationPrompt type. Without ES-053 deployed first, all dimensional arrays will be empty.

2. **Name resolution helper:** Write a utility `flattenTreeToMap(tree: GeoTree | CategoryTree): Map<string, string>` that walks the tree recursively and builds `id → name` mapping. Reuse for both geo and category.

3. **Impression share edge case:** The domain stem extraction (`domain.replace(...)`) must handle subdomains (e.g., `www.manipalhospitals.com` → `manipalhospitals`). Test with common patterns.

4. **17th pillar weight:** Adding geographic_signals with weight 2.5 changes the denominator in the weighted average. Existing scores will shift very slightly (~0.1-0.5 points). This is acceptable and expected.

5. **Evidence database is hardcoded.** Keep it simple — a `Record<string, { evidence, source }>` constant. No DB table, no config file. Update quarterly if new research published.

6. **Crawl coverage validator** runs in assemble stage, not extract-trees. It reads discoveryData + crawlData which are both available by assemble time.

7. **The enriched execution prompt** change is a single string edit. Test that existing regex patterns for mention detection and position extraction still work with the slightly longer response format.

8. **Visibility gap analysis** should only fire when `promptMetadata` has geo/category tags. For legacy checks (pre-ES-053), skip gap analysis and store empty array.
