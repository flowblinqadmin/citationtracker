# TS-054: GEO Improvement Tier 2 — Measurement Depth

**Author:** CoFounder
**Date:** 2026-03-23
**Branch:** `dev-an-geo`
**Issues:** #140 (C5), #141 (C6), #142 (C7), #148 (visibility metrics), #149 (recommendations)
**Depends on:** TS-053 (Tier 1 — trees must exist)
**Status:** Draft

---

## 1. What

Five changes that deepen how we measure and report GEO visibility, building on the trees and tagged prompts from Tier 1.

| Component | Current | Proposed |
|-----------|---------|----------|
| **C5: Per-city/category visibility** | Single overall % | Breakdown by location and service line |
| **C6: Buy/Solve/Learn tiers** | Pillar-only distribution | Intent-based prompt tiers with business-value scoring |
| **C7: Geographic signals pillar** | 16 pillars, no geo | 17th pillar scoring location-specific structured data |
| **Cross: Visibility metrics** | Binary mention + position 1-5 | Continuous impression share + word-count contribution |
| **Cross: Recommendations** | Generic per-pillar | Evidence-based, structural-page-aware, gap-prioritized |

## 2. Why

Tier 1 produces geo/category-tagged prompts and trees. Without Tier 2, we generate better prompts but still report a single overall score — the richness is invisible to the user. A user seeing "3% visibility" needs to know "0% in Delhi for cardiology, 40% in Bangalore for oncology" to take action.

All 5 components are either **Universal** (measurement theory, evidence-based recs) or **Scale with complexity** (per-city/category breakdowns degrade to a single score for simple sites).

---

## 3. C5: Per-City and Per-Category Visibility Breakdown

### 3.1 Design

After citation check execution, aggregate results by the `geoId` and `categoryId` tags on each prompt.

**New scoring dimensions:**

```typescript
type GeoVisibility = {
  geoId: string;       // references GeoNode.id
  geoName: string;     // human-readable ("Bangalore")
  promptCount: number; // how many prompts targeted this location
  mentionCount: number;// how many of those mentioned the brand
  visibility: number;  // mentionCount / promptCount * 100
};

type CategoryVisibility = {
  categoryId: string;
  categoryName: string;
  promptCount: number;
  mentionCount: number;
  visibility: number;
};
```

**Aggregation logic (within `runCitationCheck()`):**

```
For each CitationCheckResponse:
  Look up the prompt's geoId and categoryId (from promptMetadata)
  If geoId is not null:
    Increment geoVisibility[geoId].promptCount
    If mentioned: increment geoVisibility[geoId].mentionCount
  If categoryId is not null:
    Increment categoryVisibility[categoryId].promptCount
    If mentioned: increment categoryVisibility[categoryId].mentionCount

Compute visibility = mentionCount / promptCount * 100 for each
```

### 3.2 Schema Changes

```typescript
// On citationCheckScores
geoVisibility: jsonb("geo_visibility").$type<GeoVisibility[]>().default([]),
categoryVisibility: jsonb("category_visibility").$type<CategoryVisibility[]>().default([]),
```

### 3.3 Graceful Degradation

- If no geo-tagged prompts: `geoVisibility` = empty array. Dashboard shows no geo breakdown.
- If no category-tagged prompts: `categoryVisibility` = empty array. Same.
- Existing `overallVisibility`, `indirectVisibility`, `brandKnowledge` remain unchanged.

### 3.4 Acceptance Criteria

- [ ] For Manipal (rich trees): geoVisibility has entries for Bangalore, Delhi, Kolkata, etc.
- [ ] For SaaS (no geo): geoVisibility is empty array
- [ ] For single-service business: categoryVisibility has 1-2 entries
- [ ] Visibility % per geo/category is correct: mentionCount / promptCount × 100
- [ ] Overall visibility is unchanged (backward compatible)

---

## 4. C6: Buy/Solve/Learn Prompt Tiers

### 4.1 Design

TS-053 (C4) already defines the `tier` field on `CitationPrompt` and the allocation (20% Buy, 40% Solve, 40% Learn). This spec covers **scoring and reporting** by tier.

**New scoring dimension:**

```typescript
type TierVisibility = {
  tier: "buy" | "solve" | "learn";
  promptCount: number;
  mentionCount: number;
  visibility: number;
};
```

**Business value interpretation (for dashboard display):**

| Tier | Visibility meaning | User-facing label |
|------|-------------------|-------------------|
| Buy | "When people are ready to choose, are you recommended?" | "Recommendation Visibility" |
| Solve | "When people need help, does your solution come up?" | "Solution Visibility" |
| Learn | "When people research the topic, are you cited as a source?" | "Knowledge Visibility" |

**Insight generation:**
- If Buy visibility >> Learn visibility: "AI recommends you but doesn't cite your expertise — add educational content"
- If Learn >> Buy: "AI cites your expertise but doesn't recommend you — strengthen product positioning"
- If Solve is lowest: "AI doesn't connect your brand to problem-solving — add how-to and use-case content"

### 4.2 Schema Changes

```typescript
// On citationCheckScores
tierVisibility: jsonb("tier_visibility").$type<TierVisibility[]>().default([]),
```

### 4.3 Acceptance Criteria

- [ ] tierVisibility has exactly 3 entries (buy, solve, learn) when tree-based prompts are used
- [ ] tierVisibility is empty array when legacy prompts are used (backward compat)
- [ ] Insight text generated based on tier comparison (highest vs lowest)

---

## 5. C7: Geographic Signals Scoring Pillar

### 5.1 Design

Add `geographic_signals` as the 17th GEO pillar. Modeled on aeo-audit's approach (their 7% weight factor) but integrated into our existing scoring framework.

**What it measures:**

| Signal | Points | Source |
|--------|--------|--------|
| LocalBusiness schema present on ≥1 page | 20 | Crawl: existingSchema |
| GeoCoordinates in schema | 15 | Crawl: existingSchema |
| PostalAddress in schema | 15 | Crawl: existingSchema |
| areaServed signal in schema | 10 | Crawl: existingSchema |
| Address/location present in visible content on ≥3 pages | 15 | Crawl: contactInfo |
| Location-specific pages exist (e.g. /locations/*) | 15 | Crawl: pageType/URL pattern |
| Geo meta tags (`<meta name="geo.*">`) | 10 | Crawl: meta tags |

**Score:** Sum of points, capped at 100. Weight: 2.5 (same as licensing_signals — lowest tier, optional signal).

**For pure-digital businesses:** Score will naturally be 0-10 (no LocalBusiness, no addresses). This is fine — the low weight (2.5) means it barely affects the overall score.

### 5.2 Integration

**File:** `lib/services/geo-analyzer.ts`

The geo-analyzer already uses a Gemini LLM call to score all 16 pillars. Two options:

**Option A (preferred): Deterministic scoring.** Score geographic_signals algorithmically from crawl data — no LLM call needed. The signals are binary (schema present/absent, addresses found/not found). This is faster, cheaper, and more reliable than asking the LLM.

**Option B: Add to LLM prompt.** Include geographic_signals in the Gemini prompt alongside the other 16 pillars. Risk: LLM may hallucinate geo presence.

**Recommendation: Option A.** New function `scoreGeographicSignals(crawlData, geoTree): PillarScore` that runs deterministically. Result injected into the scorecard alongside the 16 LLM-scored pillars.

### 5.3 Schema Changes

No schema change needed — `geoScorecard.pillars` is already a jsonb array. The 17th pillar is simply a new entry in the array.

### 5.4 Acceptance Criteria

- [ ] Manipal Hospitals: geographic_signals score ≥ 40 (has addresses, location pages, some schema)
- [ ] SaaS tool with no addresses: geographic_signals score ≤ 10
- [ ] Pillar weight = 2.5. Overall score impact is minimal for pure-digital sites.
- [ ] Scored deterministically (no LLM call)
- [ ] Backward compatible: old scorecards without this pillar still render correctly

---

## 6. Cross-Cutting: Visibility Metric Improvements

### 6.1 Impression Share

**Current:** Binary mention (yes/no) + position (integer 1-5+).
**Proposed:** Add `impressionShare` — what fraction of the response text references the brand.

**Computation:**

```typescript
function computeImpressionShare(response: string, domain: string): number {
  const domainStem = domain.replace(/\.(com|io|co|net|org|ai|app|dev).*$/i, "");
  const sentences = response.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const mentioningSentences = sentences.filter(s =>
    new RegExp(domainStem, "i").test(s)
  );
  if (sentences.length === 0) return 0;

  // Word count of mentioning sentences / total word count
  const mentionWords = mentioningSentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0);
  const totalWords = sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0);
  return Math.round((mentionWords / totalWords) * 100);
}
```

**Storage:** New field on `citationCheckResponses`:
```typescript
impressionShare: integer("impression_share"), // 0-100, nullable
```

**Aggregation on `citationCheckScores`:**
```typescript
avgImpressionShare: integer("avg_impression_share"), // average across all mentions
```

### 6.2 Enriched Execution Prompt

**Current system prompt:** "Respond with a numbered list of 3-7 items, one sentence each."

**Proposed:** "Respond with a ranked list of 3-7 relevant options. For each, provide the name and a brief reason why it's relevant."

**Why:** "Brief reason" gives us richer sentiment extraction (positive/negative language about each option) and more text to compute impression share from. Does not change the fundamental response format — still a ranked list.

### 6.3 Acceptance Criteria

- [ ] impressionShare computed per response (0-100)
- [ ] avgImpressionShare aggregated on check scores
- [ ] For a response where brand is the only item: impressionShare ≈ 100
- [ ] For a response where brand is 1 of 7 items: impressionShare ≈ 14
- [ ] System prompt change does not break existing mention/position detection

---

## 7. Cross-Cutting: Evidence-Based Recommendations

### 7.1 Crawl Coverage Validation

**New function:** `validateCrawlCoverage(discoveryData, crawlData): CrawlCoverageReport`

```typescript
type CrawlCoverageReport = {
  totalDiscovered: number;
  totalCrawled: number;
  coveragePercent: number;
  missingPageTypes: string[];    // e.g., ["services", "locations", "pricing"]
  blogPercent: number;           // what % of crawled pages are blog/article
  structuralPercent: number;     // what % are structural (about, services, locations, etc.)
  warnings: string[];            // e.g., "Blog pages are 93% of crawl — structural pages may be missing"
};
```

**Called in:** `assemble` stage, before generating recommendations.

**Effect on recommendations:**
- If `missingPageTypes` includes "services": add recommendation "Your site's service pages were not crawled. Run a re-audit to improve coverage."
- If `blogPercent > 60`: add warning "Most crawled pages are blog content. Structural pages (services, locations) may be under-represented in this analysis."

### 7.2 Evidence-Based Recommendation Text

Current recommendations say things like "Add FAQ sections to content pages."

Upgrade to include research backing:

```typescript
type EnhancedRecommendation = {
  pillar: string;
  finding: string;
  recommendation: string;
  evidence: string | null;  // e.g., "Pages with FAQ average 4.9 citations vs 4.4 without (SE Ranking, 2025)"
  estimatedImpact: string;
  priority: "critical" | "high" | "medium" | "low";
  impactedPages: string[];
};
```

**Evidence database (hardcoded constants):**

| Strategy | Evidence | Source |
|----------|----------|-------|
| Add expert quotes | +41% visibility | Princeton GEO (KDD 2024) |
| Add statistics/data | +33% visibility | Princeton GEO (KDD 2024) |
| Cite external sources | +28% visibility | Princeton GEO (KDD 2024) |
| Answer-first content | 44.2% of citations from first 30% of content | Growth Memo (2026) |
| FAQ sections | 4.9 avg citations vs 4.4 without | SE Ranking (2025) |
| Content 800-1500 words | ~61% AI coverage vs ~13% for >3K words | houtini-ai research |

**Injected into:** The `assemble` stage's recommendation generation prompt. The LLM is told to reference specific evidence when making recommendations.

### 7.3 Gap-Prioritized Recommendations

When geo/category visibility data exists (from C5), recommendations should prioritize by measured gap:

```
If geoVisibility shows Delhi = 0%, Bangalore = 40%:
  → "Your Delhi presence is invisible to AI. Priority: add structured data and FAQ content to Delhi location pages."

If categoryVisibility shows Oncology = 60%, Cardiology = 5%:
  → "AI rarely recommends you for cardiology. Your cardiology pages lack expert quotes and case studies."
```

**Implementation:** After citation check completes, generate a `visibilityGapAnalysis` that's stored alongside the check scores and surfaced in the dashboard.

### 7.4 Services List Validation

In `generate-chunk[business]`, after generating business.json, compare the services list against the category tree:

```
categoryTree leaf count: 50
business.json services: 3

→ Warning: "business.json lists 3 services but the site has ~50 distinct service pages. The generated profile may be incomplete."
```

This warning is stored on the site record and surfaced in the dashboard.

### 7.5 Schema Changes

```typescript
// On geoSites
crawlCoverageReport: jsonb("crawl_coverage_report").$type<CrawlCoverageReport>(),

// On citationCheckScores
visibilityGapAnalysis: jsonb("visibility_gap_analysis").$type<VisibilityGapEntry[]>(),
```

```typescript
type VisibilityGapEntry = {
  dimension: "geo" | "category" | "tier";
  id: string;
  name: string;
  visibility: number;
  gap: string;          // human-readable gap description
  recommendation: string;
};
```

### 7.6 Acceptance Criteria

- [ ] Crawl coverage report generated during assemble stage
- [ ] Blog-heavy crawls (>60%) produce a warning
- [ ] Missing page types detected and surfaced
- [ ] Recommendations include evidence citations (Princeton, SE Ranking, etc.)
- [ ] Gap-prioritized recs generated when geo/category visibility data exists
- [ ] Services list mismatch warning generated when tree leaf count >> business.json services count

---

## 8. Files Affected

| File | Change |
|------|--------|
| `lib/services/citation-checker.ts` | Aggregate by geoId, categoryId, tier. Compute impressionShare. |
| `lib/services/geo-analyzer.ts` | Add deterministic `scoreGeographicSignals()`. Inject 17th pillar into scorecard. |
| `lib/services/crawl-coverage-validator.ts` | **New.** Validates crawl coverage, detects missing page types, blog-heavy warnings. |
| `app/api/pipeline/stage/route.ts` | Call crawl coverage validator in assemble stage. Inject evidence into recommendation prompt. |
| `app/api/sites/[id]/citation-check/route.ts` | Store geoVisibility, categoryVisibility, tierVisibility, visibilityGapAnalysis. |
| `lib/db/schema.ts` | New fields on citationCheckScores + citationCheckResponses + geoSites. |
| `lib/types/citation.ts` | New types: GeoVisibility, CategoryVisibility, TierVisibility, VisibilityGapEntry, CrawlCoverageReport. |

## 9. New DB Columns

```sql
-- citationCheckScores
ALTER TABLE citation_check_scores
  ADD COLUMN geo_visibility jsonb DEFAULT '[]',
  ADD COLUMN category_visibility jsonb DEFAULT '[]',
  ADD COLUMN tier_visibility jsonb DEFAULT '[]',
  ADD COLUMN avg_impression_share integer,
  ADD COLUMN visibility_gap_analysis jsonb DEFAULT '[]';

-- citationCheckResponses
ALTER TABLE citation_check_responses
  ADD COLUMN impression_share integer;

-- geoSites
ALTER TABLE geo_sites
  ADD COLUMN crawl_coverage_report jsonb;
```

All nullable or defaulted. No migration needed.

---

## 10. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Impression share noisy for short responses | Low | Only compute when response >50 words. Null otherwise. |
| Evidence citations become stale | Low | Hardcoded constants reviewed quarterly. Sources are peer-reviewed research. |
| 17th pillar breaks dashboard rendering | Low | Dashboard already renders dynamic pillar count from scorecard array. |
| Gap analysis overwhelming for large businesses | Medium | Cap at top 10 gaps sorted by severity. |

## 11. Out of Scope

- Dashboard UI changes (frontend displays these new fields — separate task)
- Content zone suggestions (C9 — Tier 3)
- Rule extraction per GE (C10 — Tier 3)
- Competitor mapping per location (C11 — Tier 4)
