# TS-058: Citation Prompt Recomposition

**Author:** CoFounder (Agent 1)
**Date:** 2026-03-25
**Branch:** `dev-an-geo`
**Depends on:** ES-053 (trees), ES-056 (dimensional analysis), ES-057 (dimensional UI)
**Scope:** Rewrite of `generatePrompts()` in `citation-prompt-generator.ts`. Zero interface changes.
**Design review:** HolePoker adversarial analysis completed (2026-03-25T02:00:00Z)

---

## Problem

The current prompt generator asks an LLM to simultaneously: understand the business, select categories, choose geography, pick pillars, AND write natural queries — all in one massive prompt with tree JSON. Result: nonsensical cross-products ("semantic HTML in blockchain service design"), 0% indirect visibility across all test sites.

## Solution

Two-stage prompt generation: **programmatic seed construction → LLM phrasing refinement**.

Stage 1 decides WHAT to ask (deterministic). Stage 2 decides HOW to say it (LLM).

---

## Stage 1: Programmatic Seed Construction

### 1.1 Category Extraction

Extract 3-5 service categories. Source priority (use first available):

1. `generatedBusinessJson.geo_profile.topics[]` — structured array, best source
2. `categoryTree` leaf nodes sorted by `pageCount` desc, top 5 names
3. `generatedBusinessJson.geo_profile.industry` as single category
4. Homepage `<title>` + `<meta description>` keywords (last resort)

If ALL sources empty: fall back to legacy 4-prompt generator (unchanged).

Store extracted categories as `string[]`. Example for NileHQ:
```
["Regulatory Compliance", "Digital Transformation", "Data Privacy"]
```

For sebamedindia.com:
```
["Skin Care", "Baby Care", "Hair Care"]
```

### 1.2 Geographic Level Extraction

Extract geo levels from `geoTree`. Walk the tree depth-first, collect nodes at each level:

```
Level 0: global (always present, implicit)
Level 1: country nodes (e.g., "India", "UK")
Level 2: region/state nodes (e.g., "Karnataka", "Scotland")
Level 3: city nodes (e.g., "Bangalore", "Edinburgh")
```

For each level, take top 2 nodes by `pageCount`. Result:
```
geoLevels = [
  { level: "global", name: null, geoId: null },
  { level: "country", name: "UK", geoId: "gb" },
  { level: "region", name: "Scotland", geoId: "gb-sct" },
  { level: "city", name: "Edinburgh", geoId: "gb-sct-edi" },
]
```

**No-geo mode:** If `geoTree` is null OR `leafCount === 0`, use `geoLevels = [{ level: "global", name: null, geoId: null }]`. Cross-product collapses to categories × angles only.

### 1.3 Buyer Angles

Five angles, each maps to 1-2 pillars:

| Angle | Pillar(s) | Query pattern |
|-------|-----------|---------------|
| discovery | competitive_positioning | "Which companies/platforms offer {category}?" |
| evaluation | evidence_statistics | "Which {category} providers have case studies/data?" |
| trust | author_authority, contact_trust | "Who is most established/trusted for {category}?" |
| clarity | offering_clarity, entity_definitions | "What does a good {category} provider offer?" |
| readiness | faq_coverage, cta_structure | "How do I get started with {category}?" |

### 1.4 Cross-Product + Pairwise Sampling

Generate all combinations: `categories × geoLevels × angles`.

Example: 3 categories × 4 geo levels × 5 angles = 60 combinations.

**Sampling to 36 indirect prompts** using pairwise covering:
- Every (category, geoLevel) pair appears at least once
- Every (category, angle) pair appears at least once
- Every (geoLevel, angle) pair appears at least once
- Priority: city-level prompts weighted higher for local businesses
- Guarantee: ≥3 prompts per geoId (required by ES-054 C11 for competitor aggregation)

**Implementation:** Use a greedy pairwise covering algorithm:
1. Enumerate all uncovered pairs
2. For each candidate triple, count how many uncovered pairs it covers
3. Select the triple that covers the most uncovered pairs
4. Repeat until 36 triples selected or all pairs covered

If categories × geoLevels × angles ≤ 36 (e.g., no-geo SaaS: 5 × 1 × 5 = 25), include all combinations — no sampling needed.

### 1.5 Seed Prompt Construction

For each selected triple (category, geoLevel, angle), construct a seed:

```typescript
type Seed = {
  text: string;           // e.g., "Which companies offer regulatory compliance in Edinburgh?"
  geoId: string | null;   // from geoLevel
  categoryId: string | null; // from category extraction
  pillar: string;         // from angle mapping
  tier: "buy" | "solve" | "learn"; // derived from angle
};
```

Seed text template per angle:
- **discovery:** `"What are the best {category} companies{geo_suffix}?"`
- **evaluation:** `"Which {category} providers{geo_suffix} have published case studies with measurable results?"`
- **trust:** `"Who are the most trusted and established {category} firms{geo_suffix}?"`
- **clarity:** `"What should I look for when choosing a {category} provider{geo_suffix}?"`
- **readiness:** `"Which {category} services{geo_suffix} offer free trials or consultations?"`

Where `geo_suffix` = `""` (global) | `" in {country}"` | `" in {region}"` | `" in {city}"`.

Tier mapping: discovery/clarity → "learn", evaluation/trust → "solve", readiness → "buy".

### 1.6 Direct Prompts (unchanged)

8 direct prompts using current deterministic templates. `pillar: null`, `geoId: null`, `categoryId: null`.

---

## Stage 2: LLM Phrasing Refinement

### 2.1 Input

Send the 36 seed texts as a numbered plain-text list to Haiku:

```
System: You are a search query rephraser. For each numbered query below,
rephrase it as a natural question a real person would type into ChatGPT
or Perplexity. Vary the structure:
- Some as "which/what" questions
- Some as "who" questions
- Some as imperative ("list the top...", "compare...")
- Some as "how do I find..."
Keep the same meaning, service category, and geography.
Return one rephrased query per line, numbered to match.

User:
1. What are the best regulatory compliance companies in Edinburgh?
2. Which digital transformation providers in UK have published case studies?
...
36. How do I get started with data privacy services?
```

### 2.2 Output parsing

Split response by newlines. Strip numbering prefix (`1. `, `2. ` etc.).

### 2.3 Validation

For each rephrased prompt, validate:
- Contains at least one keyword from the original category (case-insensitive substring match)
- If geo was specified, contains the geo name (case-insensitive)
- If validation fails, use the raw seed text instead

### 2.4 Fallback chain

```
Haiku rephrasing succeeded + validated → use rephrased
Haiku rephrasing succeeded but validation failed → use raw seed
Haiku failed (timeout/error) → use raw seeds for all 36
Category extraction failed → legacy 4-prompt generator
```

### 2.5 Model and parameters

- Model: `claude-haiku-4-5-20251001`
- Max tokens: 2000
- Temperature: 0.7 (slight creativity for phrasing diversity)
- Timeout: 15s (plain text, simple task)
- Cost: ~$0.001

---

## Schema Change

### Add version flag to citationCheckScores

```sql
ALTER TABLE citation_check_scores
  ADD COLUMN IF NOT EXISTS prompt_architecture_version integer DEFAULT 1;
```

New prompts set `prompt_architecture_version = 2`.

UI should only compare visibility trends within the same version. Show "Measurement upgraded" indicator when version changes in history.

---

## Implementation

**File:** `lib/services/citation-prompt-generator.ts`

### Functions to add:

```typescript
// Category extraction from business data
function extractCategories(site: GeneratePromptsSite): string[]

// Geo level extraction from geoTree
function extractGeoLevels(geoTree: GeoTree | null): GeoLevel[]

// Pairwise covering array construction
function buildCoveringArray(
  categories: string[],
  geoLevels: GeoLevel[],
  angles: Angle[],
  budget: number
): Triple[]

// Seed construction from triples
function buildSeeds(triples: Triple[], domain: string): Seed[]

// Haiku rephrasing
async function rephraseSeeds(seeds: Seed[]): Promise<string[]>

// Main entry point (replaces generatePromptsTreeBased)
async function generatePromptsV2(site: GeneratePromptsSite): Promise<CitationPrompt[]>
```

### Functions to modify:

```typescript
// generatePrompts() — add V2 path
export async function generatePrompts(site: GeneratePromptsSite): Promise<CitationPrompt[]> {
  const categories = extractCategories(site);
  if (categories.length > 0) {
    const result = await generatePromptsV2(site);
    if (result) return result;
  }
  // Fallback: legacy generator (unchanged)
  return generatePromptsLegacy(site);
}
```

### Functions to remove/deprecate:

- `generatePromptsTreeBased()` — replaced by `generatePromptsV2()`
- `buildTreeUserPrompt()` — no longer needed
- `callTreeSonnet()` — no longer needed (V2 uses Haiku for rephrasing only)
- `callTreeGpt4o()` — no longer needed
- `TREE_SYSTEM_PROMPT` — no longer needed
- `buildSamplingPlan()` — replaced by `buildCoveringArray()`
- `validateAndCleanTags()` — tags are programmatically assigned, no validation needed
- `capTreePrompts()` — budget enforced by covering array

### Route handler change:

In `citation-check/route.ts`, the SSE complete event should include:
```typescript
promptArchitectureVersion: 2  // when V2 prompts used
```

And the DB insert should store the version flag.

---

## Acceptance Criteria

- [ ] AC1: Categories extracted from businessJson.geo_profile.topics (primary) or categoryTree
- [ ] AC2: Geo levels extracted from geoTree with depth-based hierarchy
- [ ] AC3: No-geo mode: geoLevels = [global] when tree absent or leafCount=0
- [ ] AC4: Pairwise covering array covers all (cat, geo), (cat, angle), (geo, angle) pairs
- [ ] AC5: ≥3 prompts per geoId for ES-054 C11 compatibility
- [ ] AC6: 36 indirect + 8 direct = 44 total prompts (or fewer if cross-product < 36)
- [ ] AC7: Haiku rephrasing produces plain text, one per line
- [ ] AC8: Validation: rephrased prompt contains category keyword + geo name
- [ ] AC9: Fallback to raw seed on validation failure
- [ ] AC10: Fallback to legacy generator if no categories extracted
- [ ] AC11: promptArchitectureVersion=2 stored on citationCheckScores
- [ ] AC12: Each prompt tagged with geoId, categoryId, pillar (deterministic from seed)
- [ ] AC13: Pillar coverage: 7 buyer-facing pillars only (not technical pillars)
- [ ] AC14: Tier coverage: buy/solve/learn distributed across angles
- [ ] AC15: Legacy generator unchanged as fallback
- [ ] AC16: Output shape is CitationPrompt[] — zero interface change to downstream

---

## Test Plan

### Unit Tests

| # | Test | Expected |
|---|------|----------|
| U1 | extractCategories with topics array | Returns topics array |
| U2 | extractCategories with empty topics, has categoryTree | Returns top 5 leaf names |
| U3 | extractCategories with nothing | Returns empty array |
| U4 | extractGeoLevels with 3-level tree | Returns [global, country, region, city] |
| U5 | extractGeoLevels with null tree | Returns [global] only |
| U6 | buildCoveringArray covers all pairs | Every (cat,geo), (cat,angle), (geo,angle) pair present |
| U7 | buildCoveringArray respects budget | Returns ≤36 triples |
| U8 | buildCoveringArray ≥3 per geoId | Each geoId appears in ≥3 triples |
| U9 | buildSeeds produces correct text | Seed text matches template for each angle |
| U10 | buildSeeds assigns correct tags | geoId, categoryId, pillar match the triple |
| U11 | rephraseSeeds parses numbered output | Correct 1:1 mapping |
| U12 | rephraseSeeds validates keywords | Failed validation falls back to raw seed |
| U13 | rephraseSeeds handles Haiku failure | Returns raw seeds on timeout |
| U14 | generatePromptsV2 end-to-end | 44 prompts with correct distribution |
| U15 | generatePromptsV2 no-geo mode | No geo-tagged prompts, all global |
| U16 | generatePrompts routes to V2 when categories exist | V2 path taken |
| U17 | generatePrompts falls back to legacy when no categories | Legacy path taken |

### Integration Tests

| # | Test | Expected |
|---|------|----------|
| IT1 | Full citation check with V2 prompts | promptArchitectureVersion=2 in DB |
| IT2 | V2 prompts produce dimensional data | geoVisibility, categoryVisibility non-empty |
| IT3 | No-geo site uses V2 with global only | Prompts generated, no geo breakdowns |
| IT4 | Backward compat: old check + new check | Both visible in history, version flag differs |

---

## Cost Analysis

| Component | Current | Proposed |
|-----------|---------|----------|
| Prompt generation LLM | Sonnet ($0.05-0.10) | Haiku ($0.001) |
| Tree extraction | Sonnet ($0.05) | Not needed (categories from DB) |
| Total per check | ~$0.15 | ~$0.001 |
| Latency | 30-60s (tree JSON + Sonnet) | ~5s (Haiku plain text) |

**98% cost reduction, 10x faster.**

---

## Additional Scope: Pillar Ladder UI Split

**File:** `app/components/citation-analytics.tsx`

The GEO Pillar Visibility section currently shows all 16 pillars. With V2 prompts only covering 7 buyer-facing pillars, the other 9 show "No data" — which looks broken.

**Fix:** Split the pillar ladder into two sections:

### Section 1: "AI Citation Visibility" (from citation check)
Show only the 7 buyer-facing pillars with citation data:
- competitive_positioning, entity_definitions, offering_clarity
- evidence_statistics, contact_trust, author_authority, faq_coverage

Same UI as current pillar ladder (ranked table, expandable Q&A, progress bars).

### Section 2: "Content Quality Scores" (from GEO audit)
Show all 16 pillar scores from `geoScorecard` (deterministic, not citation-based):
- These scores come from the audit, not the citation check
- Display as compact progress bars (no expandable Q&A needed)
- Label: "Based on content audit" to distinguish from citation-based scores

**Conditional rendering:**
- If `promptArchitectureVersion === 2`: show split view (two sections)
- If `promptArchitectureVersion === 1` or missing: show current unified 16-pillar view (backward compat)

---

## Additional Scope: site_type + Competitor Discovery Fixes

### Persist site_type from businessJson

In `citation-check/route.ts`, if `site.siteType` is empty but `businessJson.geo_profile.industry` exists, persist it:

```typescript
if (!site.siteType && site.generatedBusinessJson) {
  const bj = site.generatedBusinessJson as { geo_profile?: { industry?: string } };
  const industry = bj?.geo_profile?.industry;
  if (industry) {
    await db.update(geoSites).set({ siteType: industry }).where(eq(geoSites.id, siteId));
    (site as Record<string, unknown>).siteType = industry;
  }
}
```

This populates `site_type` for all existing sites on first citation check. No re-audit needed.

### Fix competitor discovery category default

In `lib/services/competitor-discovery.ts`, change:
```typescript
const category = siteType ?? "software tool";
```
To:
```typescript
const category = siteType || (groundingText ? groundingText.split(/[.!?]/)[0]?.trim().slice(0, 80) || "business" : "business");
```

This uses the first sentence of crawled description as the category when siteType is empty, instead of the misleading "software tool" default.

---

## Updated Acceptance Criteria

- [ ] AC17: Pillar ladder split into "AI Citation Visibility" (7 pillars) + "Content Quality Scores" (16 pillars from audit)
- [ ] AC18: Split view only when promptArchitectureVersion=2; legacy checks show unified view
- [ ] AC19: site_type persisted from businessJson.geo_profile.industry on first citation check
- [ ] AC20: Competitor discovery uses crawled description as category, not "software tool" default

---

## Updated Test Plan

| # | Test | Expected |
|---|------|----------|
| U18 | Pillar ladder shows 7 buyer pillars for V2 check | Only buyer pillars in citation section |
| U19 | Pillar ladder shows 16 pillars for V1 check | Unified view, backward compat |
| U20 | Content quality section shows geoScorecard scores | All 16 pillars from audit |
| U21 | site_type extracted from businessJson.industry | Persisted to DB |
| U22 | Competitor discovery uses crawl description as category | Not "software tool" |

---

## Migration

No data migration needed. New checks get `promptArchitectureVersion=2`. Old checks keep version 1 (default). History comparison UI should group by version.
