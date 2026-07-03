# ES-056: GEO Improvement Tier 4 — Competitive Intelligence

**Source:** TS-056-geo-improvement-tier4.md
**Author:** SpecMaster (Agent 2)
**Date:** 2026-03-23
**Branch:** `dev-an-geo`
**Issues:** #146 (C11), #147 (C12)
**Depends on:** ES-053 (Tier 1 — trees + tagged prompts), ES-054 (Tier 2 — per-city/category visibility)

---

## a) Overview

### What This Covers

Two changes adding geographic and real-world context to competitive intelligence:

| Component | Summary |
|-----------|---------|
| **C11** | Per-location competitor mapping + dominance map from tagged citation responses |
| **C12** | Real prompt discovery via Perplexity (Google PAA, Reddit, Quora questions) |

### Current Implementation State

**Exists:**
- `lib/services/citation-checker.ts` — `extractCompetitors()` extracts competitor domains/names from citation responses via regex. `competitorData: CompetitorCitationData[]` aggregated per check with shareOfVoice, mentionCount, rankedAbove, sentiment. Groups by provider, computes overall competitor metrics.
- `citationCheckScores` has `competitorData` (overall) and deprecated `competitorVisibility`.
- `citationCheckResponses` stores per-response `competitorsMentioned: string[]`.
- ES-053 tags each `CitationPrompt` with `geoId`, `categoryId`. `promptMetadata` stored on citationCheckScores.
- `lib/services/citation-prompt-generator.ts` — being rewritten by ES-053 to use Sonnet + trees.

**Does not exist (new):**
- Per-location / per-category competitor aggregation
- Dominance map
- Real prompt discovery service
- Perplexity-based real question fetching

---

## b) Implementation Requirements

### b.1 Schema Changes

**File:** `lib/db/schema.ts`

**On `citationCheckScores`:**

```typescript
locationCompetitors: jsonb("location_competitors").$type<LocationCompetitor[]>().default([]),
categoryCompetitors: jsonb("category_competitors").$type<CategoryCompetitor[]>().default([]),
dominanceMap: jsonb("dominance_map").$type<DominanceMap>(),
realPromptDiscovery: jsonb("real_prompt_discovery").$type<RealPromptDiscovery[]>(),
```

**SQL migration** (`geo/drizzle/XXXX_tier4_columns.sql`):

```sql
ALTER TABLE citation_check_scores
  ADD COLUMN location_competitors jsonb DEFAULT '[]',
  ADD COLUMN category_competitors jsonb DEFAULT '[]',
  ADD COLUMN dominance_map jsonb,
  ADD COLUMN real_prompt_discovery jsonb;
```

All nullable or defaulted. No migration needed.

### b.2 Type Definitions

**File:** `lib/types/citation.ts` — Add these types:

```typescript
// ── Per-Location/Category Competitors ────────────────────────────

export type CompetitorEntry = {
  domain: string;
  name: string;
  mentionCount: number;
  shareOfVoice: number;     // % of prompts in this geo/category where competitor appeared
  avgPosition: number;
  rankedAboveBrand: number; // % of co-mentions where competitor ranked higher
};

export type LocationCompetitor = {
  geoId: string;
  geoName: string;
  competitors: CompetitorEntry[];
};

export type CategoryCompetitor = {
  categoryId: string;
  categoryName: string;
  competitors: CompetitorEntry[];
};

// ── Dominance Map ────────────────────────────────────────────────

export type DominanceEntry = {
  geoId: string | null;       // null = global/all locations
  categoryId: string | null;  // null = all categories
  topBrand: string;           // domain that appeared most
  topBrandSOV: number;
  brandSOV: number;           // our domain's share of voice
  gap: number;                // topBrandSOV - brandSOV
};

export type DominanceMap = {
  entries: DominanceEntry[];
  computedAt: string;         // ISO-8601
};

// ── Real Prompt Discovery ────────────────────────────────────────

export type RealPromptSource = "paa" | "reddit" | "quora";

export type RealPromptDiscovery = {
  source: RealPromptSource;
  query: string;              // the actual user question
  context: string;            // surrounding text (truncated, 200 chars)
  url: string;                // source URL
};
```

### b.3 C11: Per-Location Competitor Mapping

**File:** `lib/services/citation-checker.ts`

**New function:**

```typescript
export function aggregateCompetitorsByDimension(
  responses: ResponseRow[],
  promptMetadata: CitationPrompt[],
  domain: string,
  geoTree?: GeoTree | null,
  categoryTree?: CategoryTree | null
): {
  locationCompetitors: LocationCompetitor[];
  categoryCompetitors: CategoryCompetitor[];
  dominanceMap: DominanceMap;
}
```

#### Algorithm

**Step 1: Group responses by geoId and categoryId**

For each response:
1. Look up the prompt in `promptMetadata` to get `geoId` and `categoryId`.
2. Extract competitors from the response (reuse existing `extractCompetitors()` logic which reads `competitorsMentioned`).
3. For each competitor found, accumulate into:
   - `geoCompetitorMap[geoId][competitor]` → { mentionCount, totalPrompts, positions[], rankedAbove }
   - `categoryCompetitorMap[categoryId][competitor]` → same

**Step 2: Compute per-group metrics**

For each geoId with ≥ 3 geo-specific prompts:
1. `shareOfVoice = competitor.mentionCount / totalPromptsForGeo * 100`
2. `avgPosition = mean(positions)` where positions are from mentions only
3. `rankedAboveBrand`: For each prompt where both competitor and brand are mentioned, check if competitor's position < brand's position. `rankedAboveBrand = aboveCount / coMentionCount * 100`.

Same computation for each categoryId.

**Minimum threshold:** Only produce entries for groups with ≥ 3 prompts. Below that, sample size is too small.

**Step 3: Build dominance map**

For each unique (geoId, categoryId) combination present in responses:
1. Find the competitor with highest SOV in that combination → `topBrand`.
2. Compute brand's SOV in the same combination → `brandSOV`.
3. `gap = topBrandSOV - brandSOV`.
4. Also compute global (null, null) entry for overall dominance.

Sort by gap descending (worst gaps first). Cap at 20 entries.

**Step 4: Name resolution**

Use tree traversal to resolve geoId → geoName, categoryId → categoryName (same utility as ES-054 C5).

#### Integration

**Modify `runCitationCheck()` return type** to include:

```typescript
locationCompetitors: LocationCompetitor[];
categoryCompetitors: CategoryCompetitor[];
dominanceMap: DominanceMap;
```

Call `aggregateCompetitorsByDimension()` after responses are collected, alongside existing competitor aggregation.

**Store on `citationCheckScores`** alongside existing `competitorData`.

#### Graceful Degradation

- No geo-tagged prompts → `locationCompetitors = []`, dominance map has only global entry.
- No category-tagged prompts → `categoryCompetitors = []`.
- No competitors found → all arrays empty, dominance map entries have gap=0.
- Pre-ES-053 checks (no tagged prompts) → all new fields empty (backward compat).

### b.4 Dominance Map Insight Generation

**New function:**

```typescript
export function generateDominanceInsights(
  dominanceMap: DominanceMap,
  geoTree?: GeoTree | null,
  categoryTree?: CategoryTree | null
): string[]
```

Logic:
- `gap > 30`: `"In {city} for {category}, {competitor} dominates with {SOV}% vs your {SOV}%. High-priority gap."`
- `gap < 10 && brandSOV > 0`: `"You're competitive with {topBrand} in {city} for {category}."`
- `brandSOV > topBrandSOV`: `"You lead in {city} for {category}."`
- Return top 5 insights sorted by gap descending.

### b.5 C12: Real Prompt Discovery

**File:** `lib/services/real-prompt-discoverer.ts` (NEW)

#### Exports

```typescript
import type { RealPromptDiscovery } from "@/lib/types/citation";
import type { CategoryTree } from "@/lib/types/trees";

/**
 * Discover real user questions from PAA, Reddit, Quora via Perplexity.
 * Takes top 3 category leaf nodes and optional geo context.
 * Returns deduplicated, filtered questions (max 15).
 */
export async function discoverRealPrompts(
  categoryTree: CategoryTree,
  geoContext?: { cityNames: string[] },  // top 2-3 cities from geoTree
  domain: string
): Promise<RealPromptDiscovery[]>;
```

#### Implementation

**Step 1: Select query topics**

From `categoryTree`, extract top 3 leaf nodes by `pageCount` (most evidence = most important services). If `geoContext` provided, use top 2 cities.

**Step 2: Perplexity API call**

Use existing Perplexity (Sonar) client. Single call:

```
System: "You are a research assistant. Return only a JSON array of questions, no prose."

User: "What are the top 10-15 questions real users ask on Google (People Also Ask), Reddit, and Quora about the following topics:
{categories list}
{optional: "specifically in these locations: {cities list}"}

For each question, provide:
- source: "paa" | "reddit" | "quora"
- query: the exact question
- context: brief surrounding context (200 chars max)
- url: source URL if available, empty string otherwise

Return JSON array only."
```

**Model:** `sonar` (Perplexity)
**Temperature:** 0
**Max tokens:** 2000
**Timeout:** 15 seconds

**Step 3: Post-processing**

1. Parse JSON array.
2. Deduplicate: remove questions with >80% word overlap (use simple Jaccard similarity on word sets).
3. Filter: remove questions containing the brand's domain name (competitor-specific questions leak brand).
4. Filter: remove off-topic questions (must contain at least one keyword from the category names).
5. Cap at 15 questions.

#### Integration into Prompt Generation

**File:** `lib/services/citation-prompt-generator.ts` (modified by ES-053)

In the tree-based `generatePrompts()` function, before the Sonnet LLM call:

```typescript
// Attempt real prompt discovery (non-blocking fallback)
let realPrompts: RealPromptDiscovery[] = [];
try {
  if (site.categoryTree && site.categoryTree.leafCount > 0) {
    const cityNames = extractTopCities(site.geoTree, 3);
    realPrompts = await discoverRealPrompts(
      site.categoryTree,
      cityNames.length > 0 ? { cityNames } : undefined,
      site.domain
    );
  }
} catch (err) {
  console.warn(`[citation-prompts] ${site.domain}: real prompt discovery failed, proceeding without`);
}
```

If `realPrompts.length > 0`, append to the Sonnet user prompt:

```
<real_user_questions>
Real questions users ask about this category (from Google PAA, Reddit, Quora):
{realPrompts.map(p => `- [${p.source}] ${p.query}`).join('\n')}

Use these to inform the phrasing and intent of your generated queries.
Adopt natural language patterns from these real questions.
</real_user_questions>
```

#### Fallback

- Perplexity fails or returns < 3 questions → skip real prompt grounding. Sonnet generates from trees alone (Tier 1 behavior).
- Log: `[citation-prompts] ${domain}: real prompt discovery failed, proceeding without`
- No user-facing impact — prompts are still tree-grounded.

#### Storage

Store `realPrompts` on `citationCheckScores.realPromptDiscovery` for debugging/analytics.

#### Cost

- 1 Perplexity Sonar call per citation check: ~$0.001. Negligible.
- No additional cost if discovery fails (falls back silently).

---

## c) Unit Test Plan

**File:** `__tests__/services/citation-checker-competitors.test.ts` (NEW)

| # | Test | Input | Expected |
|---|------|-------|----------|
| U1 | aggregateCompetitorsByDimension groups by geoId | Responses tagged with 3 geoIds | locationCompetitors has 3 entries |
| U2 | aggregateCompetitorsByDimension groups by categoryId | Responses tagged with 2 categoryIds | categoryCompetitors has 2 entries |
| U3 | SOV computation correct | Competitor in 3/10 prompts for geoId | shareOfVoice = 30 |
| U4 | avgPosition computation | Competitor at positions 1, 3, 5 | avgPosition ≈ 3 |
| U5 | rankedAboveBrand computation | Competitor above brand in 2/3 co-mentions | rankedAboveBrand ≈ 67 |
| U6 | Minimum threshold: < 3 prompts excluded | geoId with 2 prompts | Not in locationCompetitors |
| U7 | Dominance map finds top brand | Apollo 50% SOV, Manipal 20% SOV in Blr | topBrand="Apollo", gap=30 |
| U8 | Dominance map includes global entry | Any responses | Entry with geoId=null, categoryId=null |
| U9 | Dominance map capped at 20 | 30 geo×category combos | Max 20 entries |
| U10 | Dominance insights: high gap | gap > 30 | Insight mentions "dominates" |
| U11 | Dominance insights: competitive | gap < 10, brandSOV > 0 | Insight mentions "competitive" |
| U12 | Dominance insights: brand leads | brandSOV > topBrandSOV | Insight mentions "lead" |
| U13 | Empty arrays for untagged prompts | No geoId/categoryId on prompts | All empty |
| U14 | Name resolution from trees | geoId with geoTree | geoName populated |

**File:** `__tests__/services/real-prompt-discoverer.test.ts` (NEW)

| # | Test | Input | Expected |
|---|------|-------|----------|
| U15 | discoverRealPrompts returns questions | Mock Perplexity returns 12 questions | Array of 12 RealPromptDiscovery |
| U16 | Deduplication removes similar questions | Two questions with >80% word overlap | Only 1 retained |
| U17 | Filter removes brand-specific questions | Question containing domain name | Filtered out |
| U18 | Filter removes off-topic questions | Question about unrelated topic | Filtered out |
| U19 | Caps at 15 questions | Perplexity returns 20 | Max 15 |
| U20 | Handles Perplexity failure | Mock timeout | Returns empty array, no throw |
| U21 | Handles invalid JSON from Perplexity | Mock returns prose | Returns empty array |
| U22 | Topic selection from categoryTree | Tree with 10 leaves | Top 3 by pageCount selected |
| U23 | Geo context included when geoTree exists | geoTree with 5 cities | Top 2-3 cities in query |
| U24 | No geo context for pure-digital | geoTree.leafCount = 0 | geoContext undefined |

**Mocking:** Mock Perplexity API, mock DB queries. Use Vitest.

---

## d) Integration Test Plan

**File:** `__tests__/integration/competitive-intelligence.test.ts` (NEW)

| # | Test | Scenario | Expected |
|---|------|----------|----------|
| IT1 | Citation check stores location competitors | Full check with geo-tagged prompts | citationCheckScores.locationCompetitors populated |
| IT2 | Citation check stores category competitors | Full check with category-tagged prompts | citationCheckScores.categoryCompetitors populated |
| IT3 | Dominance map computed end-to-end | Full check | dominanceMap has ≥1 entry |
| IT4 | Real prompts stored on citation check | Full check with Perplexity available | realPromptDiscovery non-null |
| IT5 | Real prompts influence generated prompts | Compare prompts with/without discovery | Prompts with discovery use more natural phrasing (qualitative) |
| IT6 | Backward compat: no tags → empty competitors | Citation check with legacy untagged prompts | locationCompetitors=[], categoryCompetitors=[], dominanceMap null |
| IT7 | Real prompt fallback | Perplexity unavailable | Check completes, realPromptDiscovery=null or [] |

---

## e) Profiling Requirements

| Metric | Target | Tool |
|--------|--------|------|
| aggregateCompetitorsByDimension | < 20ms for 48 × 4 responses | In-code timer |
| dominance map computation | < 10ms | In-code timer |
| discoverRealPrompts (Perplexity) | < 5s p95 | LLM call timer |
| Real prompt post-processing | < 10ms | In-code timer |

---

## f) Load Test Plan

| Scenario | Description | Success Criteria |
|----------|-------------|-----------------|
| L1 | 50 sequential citation checks with competitor aggregation | Consistent results, no memory leak |
| L2 | Perplexity rate limiting under 100 concurrent checks | Graceful degradation, no crashes |

---

## g) Logging & Instrumentation

| Event | Level | Fields |
|-------|-------|--------|
| `citation-check.location-competitors` | info | domain, locationCount, totalCompetitors |
| `citation-check.category-competitors` | info | domain, categoryCount, totalCompetitors |
| `citation-check.dominance-map` | info | domain, entries, worstGap, gapGeoId, gapCategoryId |
| `citation-check.dominance-insights` | info | domain, insightCount |
| `real-prompts.discovery.start` | info | domain, categories, cities |
| `real-prompts.discovery.complete` | info | domain, questionsFound, sources: {paa, reddit, quora} |
| `real-prompts.discovery.failed` | warn | domain, error |
| `real-prompts.filtered` | debug | domain, duplicatesRemoved, offTopicRemoved, brandSpecificRemoved |

---

## h) Acceptance Criteria

### C11: Per-Location Competitor Mapping

- [ ] **AC1**: Competitors aggregated per geoId when ≥ 3 geo-specific prompts exist per location
- [ ] **AC2**: Competitors aggregated per categoryId when ≥ 3 category-specific prompts exist
- [ ] **AC3**: `CompetitorEntry` has shareOfVoice, avgPosition, rankedAboveBrand
- [ ] **AC4**: Dominance map identifies top competitor per geo × category combination
- [ ] **AC5**: Gap analysis produces actionable insight text (top 5, sorted by gap)
- [ ] **AC6**: Empty arrays for businesses without geo/category tags (backward compat)
- [ ] **AC7**: No new external API calls — built entirely from existing citation response data
- [ ] **AC8**: Minimum threshold: groups with < 3 prompts excluded from breakdown
- [ ] **AC9**: Dominance map capped at 20 entries

### C12: Real Prompt Discovery

- [ ] **AC10**: Real questions fetched from Perplexity for top 3 category nodes
- [ ] **AC11**: Questions deduplicated (>80% word overlap removed)
- [ ] **AC12**: Questions filtered: no off-topic, no brand-specific competitor questions
- [ ] **AC13**: Top 10-15 real questions passed to Sonnet as grounding context
- [ ] **AC14**: Fallback works: if Perplexity fails, prompts generate from trees alone
- [ ] **AC15**: Cost: < $0.01 per citation check for discovery
- [ ] **AC16**: `realPromptDiscovery` stored on citationCheckScores for debugging
- [ ] **AC17**: Capped at 15 questions after dedup + filtering

### Schema & Tests

- [ ] **AC18**: Migration adds `location_competitors`, `category_competitors`, `dominance_map`, `real_prompt_discovery` to citation_check_scores
- [ ] **AC19**: Unit tests U1–U24 pass
- [ ] **AC20**: Integration tests IT1–IT7 pass

---

## ScriptDev Notes

1. **C11 reuses existing competitor extraction** from `extractCompetitors()` in citation-checker.ts. The only new logic is slicing the existing competitor data by geoId/categoryId. No new competitor detection algorithm needed.

2. **SOV denominator is per-group.** For `locationCompetitors[geoId="blr"]`, SOV = competitor mentions in Bangalore prompts / total Bangalore prompts × 100. Not total prompts.

3. **rankedAboveBrand** requires finding the brand's position in the same response. Use existing `position` field on `ResponseRow`. If brand not mentioned (position null), skip that response for rankedAbove computation.

4. **Perplexity Sonar model** is already used in the citation checker for execution. The real-prompt-discoverer uses the same client and model. No new API key or setup needed.

5. **Real prompt discovery runs BEFORE the Sonnet prompt generation call** (in the tree-based generatePrompts flow from ES-053). The timing is: `discoverRealPrompts()` (~2-3s) → build Sonnet prompt including real questions → call Sonnet. Total: ~12-15s. This is acceptable for citation check (user-initiated, SSE-streamed).

6. **Deduplication using Jaccard similarity** on word sets: `intersection(words_a, words_b).size / union(words_a, words_b).size > 0.8`. Simple, fast, sufficient. Lowercase and remove stop words before comparison.

7. **The `extractTopCities()` helper** walks the geoTree, collects city-level nodes, sorts by pageCount descending, returns top N names. Reuse the tree traversal utility from ES-054.

8. **Cost summary for Tier 4:** $0.001/check for real prompt discovery (Perplexity). Competitor aggregation is pure computation (no API calls). Total Tier 4 cost per citation check: ~$0.001.
