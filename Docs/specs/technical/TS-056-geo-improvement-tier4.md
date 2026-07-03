# TS-056: GEO Improvement Tier 4 — Competitive Intelligence

**Author:** CoFounder
**Date:** 2026-03-23
**Branch:** `dev-an-geo`
**Issues:** #146 (C11), #147 (C12)
**Depends on:** TS-053 (Tier 1 — trees), TS-054 (Tier 2 — per-city/category visibility)
**Status:** Draft

---

## 1. What

Two changes that add geographic and real-world context to competitive intelligence:

| Component | Current | Proposed |
|-----------|---------|----------|
| **C11: Per-location competitor mapping** | Location-blind competitor analysis | Competitors mapped per city and per service line |
| **C12: Real prompt discovery** | LLM-generated prompts only | Supplement with Google PAA, Reddit, Quora real user questions |

## 2. Why

**C11:** Competitors vary by geography. Apollo Hospitals dominates Chennai but not Bangalore. A national "share of voice" metric hides local competitive dynamics that determine where to focus.

**C12:** LLM-generated prompts capture what a model thinks users ask. Real user questions (PAA, Reddit) capture what users actually ask — different phrasing, different priorities, different intent patterns.

Both **Scale with complexity** (C11) or are **Universal** (C12).

---

## 3. C11: Per-Location Competitor Mapping

### 3.1 Design

Extend competitor analysis to produce per-geo and per-category competitor breakdowns.

**Data source:** Citation check responses already contain competitor mentions per prompt. With geo/category tags on prompts (from Tier 1), we can slice competitor mentions by location and service.

**Computation (post-citation-check aggregation):**

```typescript
type LocationCompetitor = {
  geoId: string;
  geoName: string;
  competitors: CompetitorEntry[];
};

type CategoryCompetitor = {
  categoryId: string;
  categoryName: string;
  competitors: CompetitorEntry[];
};

type CompetitorEntry = {
  domain: string;
  name: string;
  mentionCount: number;
  shareOfVoice: number;    // % of prompts in this geo/category where competitor appeared
  avgPosition: number;
  rankedAboveBrand: number; // % of co-mentions where competitor ranked higher
};
```

**Aggregation:**
```
For each CitationCheckResponse:
  Get prompt's geoId and categoryId from promptMetadata
  Extract competitors from response (existing logic)
  Group competitor mentions by geoId and categoryId
  Compute SOV, avgPosition, rankedAbove per group
```

### 3.2 Dominance Map

Inspired by geo_toolkit's approach, but built from our existing citation data (no external API needed):

```typescript
type DominanceMap = {
  entries: DominanceEntry[];
  computedAt: string;
};

type DominanceEntry = {
  geoId: string | null;       // null = global
  categoryId: string | null;  // null = all categories
  topBrand: string;           // domain that appeared most
  topBrandSOV: number;        // their share of voice
  brandSOV: number;           // our domain's share of voice
  gap: number;                // topBrandSOV - brandSOV
};
```

**Insight generation:**
- `gap > 30`: "In {city} for {category}, {competitor} dominates with {SOV}% vs your {SOV}%. High-priority gap."
- `gap < 10`: "You're competitive with {competitor} in {city} for {category}."
- `brandSOV > topBrandSOV`: "You lead in {city} for {category}."

### 3.3 Storage

```typescript
// On citationCheckScores
locationCompetitors: jsonb("location_competitors").$type<LocationCompetitor[]>().default([]),
categoryCompetitors: jsonb("category_competitors").$type<CategoryCompetitor[]>().default([]),
dominanceMap: jsonb("dominance_map").$type<DominanceMap>(),
```

### 3.4 Graceful Degradation

- No geo-tagged prompts: `locationCompetitors` = empty array. No location breakdown shown.
- No category-tagged prompts: `categoryCompetitors` = empty array.
- Single-location business: one entry in `locationCompetitors`.
- Competitor extraction logic unchanged — just sliced by new dimensions.

### 3.5 Acceptance Criteria

- [ ] Competitors aggregated per geoId when geo-tagged prompts exist
- [ ] Competitors aggregated per categoryId when category-tagged prompts exist
- [ ] Dominance map identifies top competitor per geo×category combination
- [ ] Gap analysis produces actionable insight text
- [ ] Empty arrays for businesses without geo/category tags (backward compat)
- [ ] No new API calls — built entirely from existing citation response data

---

## 4. C12: Real Prompt Discovery

### 4.1 Design

Supplement LLM-generated prompts with real user questions from three sources:

| Source | Method | What we get |
|--------|--------|-------------|
| **Google PAA** | SerpAPI or direct scrape of "People Also Ask" boxes | Real questions users ask about the category |
| **Reddit** | Web search: `site:reddit.com "{category}" recommendation` | Authentic phrasing, emotional context, real decision-making |
| **Quora** | Web search: `site:quora.com "{category}" best` | Question-format queries with intent signal |

### 4.2 Integration Point

**When:** During citation prompt generation (C4 flow from TS-053).

**How:** Before the Sonnet prompt generation call, gather real-world prompts:

```typescript
type RealPromptDiscovery = {
  source: "paa" | "reddit" | "quora";
  query: string;          // the actual user question
  context: string;        // surrounding text (truncated, 200 chars)
  url: string;            // source URL
};
```

**Pipeline:**
```
1. Take top 3 category leaf nodes from categoryTree
2. For each, search:
   - Google PAA: "{category name} {city if geo}" → extract PAA questions
   - Reddit: site:reddit.com "{category name}" recommendation → extract post titles
   - Quora: site:quora.com "{category name}" best → extract question titles
3. Deduplicate and filter (remove off-topic, remove brand-specific competitor questions)
4. Pass top 10-15 real prompts to Sonnet as additional grounding:
   "Real questions users ask about this category:
    - {paa question 1}
    - {reddit question 1}
    - {quora question 1}
    ...
    Use these to inform the phrasing and intent of your generated queries."
```

### 4.3 Data Sources — API Options

| Source | API | Cost | Rate limit |
|--------|-----|------|------------|
| Google PAA | SerpAPI ($50/mo for 5000 searches) | ~$0.01/search | 5000/mo |
| Google PAA | Serper.dev ($50/mo for 2500 searches) | ~$0.02/search | 2500/mo |
| Reddit | Web search via Perplexity (already have API key) | Included | Existing limits |
| Quora | Web search via Perplexity | Included | Existing limits |

**Recommended:** Use Perplexity API for all three (already integrated). Single call:
```
"What are the top 10 questions real users ask on Google, Reddit, and Quora about {category} in {city}? Return only the questions, not answers."
```

Cost: One Perplexity Sonar call per citation check (~$0.001). Negligible.

### 4.4 Fallback

If Perplexity fails or returns insufficient results:
- Skip real prompt discovery. Sonnet generates prompts without this grounding (same as Tier 1 behavior).
- Log: `[citation-prompts] ${domain}: real prompt discovery failed, proceeding without`
- No user-facing impact — prompts are still tree-grounded.

### 4.5 Storage

Real prompts are not stored separately — they're injected into the Sonnet prompt generation call as grounding context. The resulting `promptsUsed` array on `citationCheckScores` captures the final prompts (which may be influenced by real question phrasing).

Optional: Store discovery results for debugging:
```typescript
// On citationCheckScores
realPromptDiscovery: jsonb("real_prompt_discovery").$type<RealPromptDiscovery[]>(),
```

### 4.6 Acceptance Criteria

- [ ] Real questions fetched from Perplexity for top 3 category nodes
- [ ] Questions deduplicated and filtered (no off-topic, no competitor-brand-specific)
- [ ] Top 10-15 real questions passed to Sonnet as grounding
- [ ] Generated prompts reflect real user phrasing (qualitative — compare output with/without discovery)
- [ ] Fallback works: if Perplexity fails, prompts still generate from trees alone
- [ ] Cost: <$0.01 per citation check for discovery

---

## 5. Files Affected

| File | Change |
|------|--------|
| `lib/services/citation-checker.ts` | Aggregate competitors by geoId/categoryId. Compute dominance map. |
| `lib/services/real-prompt-discoverer.ts` | **New.** Perplexity-based real question discovery. |
| `lib/services/citation-prompt-generator.ts` | Inject real prompts as grounding before Sonnet call. |
| `lib/db/schema.ts` | New fields on citationCheckScores. |
| `lib/types/citation.ts` | New types. |

## 6. New DB Columns

```sql
ALTER TABLE citation_check_scores
  ADD COLUMN location_competitors jsonb DEFAULT '[]',
  ADD COLUMN category_competitors jsonb DEFAULT '[]',
  ADD COLUMN dominance_map jsonb,
  ADD COLUMN real_prompt_discovery jsonb;
```

---

## 7. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Perplexity returns irrelevant questions | Medium | Filter by relevance (must contain category keywords). Cap at 15 questions. |
| PAA/Reddit scraping blocked | Low | Using Perplexity as intermediary, not direct scraping. |
| Per-location competitor data sparse | Medium | Only show breakdown when ≥3 geo-specific prompts exist per location. |
| Real prompt discovery adds latency | Low | Single Perplexity call (~2-3s). Runs in parallel with other prompt generation prep. |
| SerpAPI cost at scale | Low | Start with Perplexity (free). Evaluate SerpAPI if quality insufficient. |

## 8. Out of Scope

- Full dominance dashboard UI (frontend task)
- Competitor content analysis (reading competitor pages)
- Automated competitive strategy recommendations
- Trending prompt detection over time
