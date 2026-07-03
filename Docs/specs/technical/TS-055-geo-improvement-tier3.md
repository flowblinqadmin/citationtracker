# TS-055: GEO Improvement Tier 3 — Content Intelligence

**Author:** CoFounder
**Date:** 2026-03-23
**Branch:** `dev-an-geo`
**Issues:** #143 (C8), #144 (C9), #145 (C10)
**Depends on:** TS-053 (Tier 1), TS-054 (Tier 2 — evidence framework)
**Status:** Draft

---

## 1. What

Three changes that add content-level intelligence to the scoring and fix generation:

| Component | Current | Proposed |
|-----------|---------|----------|
| **C8: Content strategy scoring** | No detection of quotations, statistics, or cited sources | Score Princeton GEO's top 3 strategies per page |
| **C9: Content zone suggestions** | Meta/heading fixes only | Suggest content zone additions (Direct Answer, FAQ, Quotable Blocks) |
| **C10: Rule extraction per GE** | Same optimization for all engines | Discover per-engine preferences via pairwise analysis |

## 2. Why

Princeton GEO research proves that specific content patterns boost visibility by 28-41%. Our scoring doesn't detect these patterns, and our per-page fixes don't suggest them. This tier bridges the gap between "what works" (research) and "what we recommend" (product).

All items are **Universal** — content patterns are vertical-agnostic.

---

## 3. C8: Content Strategy Scoring

### 3.1 Strategy Detection

Detect three content strategies per crawled page:

**1. Quotation Blocks (+41% visibility)**

Detection rules:
- Blockquote elements (`<blockquote>`)
- Text matching patterns: `"…" — {Name}`, `According to {Name}`, `{Name} says`, `As {Name} noted`
- Direct speech patterns in content (quoted strings >15 words)

Output per page:
```typescript
type QuotationScore = {
  count: number;           // quotation instances found
  hasAttribution: boolean; // at least one quote has a named source
  score: number;           // 0-100: 0=none, 50=quotes but no attribution, 100=attributed quotes
};
```

**2. Statistics/Data Points (+33% visibility)**

Detection rules:
- Numeric patterns with context: `{number}%`, `{number}x`, `${number}`, `{number} million/billion`
- Phrases: "increased by", "reduced by", "compared to", "grew from X to Y"
- Data-bearing elements: `<table>`, `<figure>`, `<data>`

Output per page:
```typescript
type StatisticsScore = {
  count: number;           // data points found
  hasSourceAttribution: boolean; // at least one stat cites a source
  score: number;           // 0-100: 0=none, 50=stats without sources, 100=sourced stats
};
```

**3. Cited External Sources (+28% visibility)**

Detection rules:
- External links with descriptive anchor text (>2 words, not "click here" or "read more")
- Inline citations: "according to [Source]", "(Source, Year)", "[1]", "Source: ..."
- Links to authoritative domains (.gov, .edu, .org, research journals)

Output per page:
```typescript
type CitationScore = {
  externalLinkCount: number;
  authoritativeLinkCount: number; // .gov, .edu, .org, research domains
  inlineCitationCount: number;    // "according to", "(Source, Year)" patterns
  score: number;                   // 0-100
};
```

### 3.2 Integration with GEO Scoring

These are **sub-signals** within existing pillars, not new pillars:

| Strategy | Parent Pillar | Effect |
|----------|--------------|--------|
| Quotation blocks | `content_structure` | Bonus signal in pillar prompt: "also consider quotation usage" |
| Statistics | `evidence_statistics` | Bonus signal: "consider density of sourced data points" |
| Cited sources | `evidence_statistics` | Bonus signal: "consider external citation quality" |

**Implementation:** Compute strategy scores deterministically from crawl data. Pass them as additional context to the Gemini scoring prompt:

```
Content strategy signals (pre-computed):
- Quotation density: {avg per page}. {X}% of pages have attributed quotes.
- Statistics density: {avg per page}. {X}% include sourced data points.
- External citation density: {avg per page}. {X}% link to authoritative sources.

Use these signals to inform your scoring of content_structure and evidence_statistics pillars.
```

### 3.3 Aggregate Metrics

New field on geoSites:

```typescript
contentStrategyScores: jsonb("content_strategy_scores").$type<ContentStrategyReport>(),
```

```typescript
type ContentStrategyReport = {
  quotations: { avgPerPage: number; pagesWithQuotes: number; pagesTotal: number; overallScore: number };
  statistics: { avgPerPage: number; pagesWithStats: number; pagesTotal: number; overallScore: number };
  citations:  { avgPerPage: number; pagesWithCitations: number; pagesTotal: number; overallScore: number };
  computedAt: string;
};
```

**Computed in:** New `extract-trees` stage (after crawl, alongside tree extraction) or as a separate step in `assemble`.

### 3.4 Acceptance Criteria

- [ ] Quotation detection finds `<blockquote>` and attribution patterns
- [ ] Statistics detection finds numeric patterns with context
- [ ] Citation detection finds external links and inline citation patterns
- [ ] Strategy scores passed to GEO analyzer as additional context
- [ ] ContentStrategyReport stored on geoSites
- [ ] Pages with zero strategies score 0; pages with all three score higher

---

## 4. C9: Content Zone Suggestions

### 4.1 Content Zones

Upgrade per-page fixes from meta/heading-only to include content zone recommendations.

Six content zones (derived from gtm-engineer-skills' framework and Princeton research):

| Zone | What | Why | Applies to |
|------|------|-----|------------|
| **Direct Answer Block** | 1-3 sentence answer to the page's primary question, in the first 100 words | 44.2% of citations come from first 30% of content | All content pages |
| **Comparison Table** | Structured table comparing options/features | Tables are highly extractable by AI | Service/product/department pages |
| **Data & Evidence** | Section with 3+ statistics, each with source attribution | +33% visibility from statistics | All content pages with claims |
| **Expert Quote** | Attributed quote from a named expert/doctor/specialist | +41% visibility from quotations | Blog, department, service pages |
| **FAQ Section** | 3+ Q&A pairs with FAQPage schema | Pages with FAQ: 4.9 avg citations vs 4.4 | All pages with >500 words |
| **Quotable Block** | 40-60 word standalone paragraph, no pronouns, self-contained fact | Optimal for AI extraction | All content pages |

### 4.2 Zone Detection (What's Already There)

Before suggesting zones, detect which already exist on the page:

```typescript
type PageZoneAudit = {
  url: string;
  hasDirectAnswer: boolean;     // first 100 words contain a clear statement (not a question or navigation)
  hasComparisonTable: boolean;  // <table> with >2 rows and >2 columns
  hasDataEvidence: boolean;     // contentStrategyScores.statistics.count >= 3
  hasExpertQuote: boolean;      // contentStrategyScores.quotations.count >= 1 with attribution
  hasFaqSection: boolean;       // existing from per-page-analyzer
  hasQuotableBlock: boolean;    // paragraph 40-60 words, no pronouns, standalone
  missingZones: string[];       // list of zones not found
};
```

### 4.3 Zone Suggestion Generation

For each missing zone, generate a **draft** suggestion:

**For paid users (exact copy):**
- Direct Answer Block: LLM generates 1-3 sentence answer based on the page's H1 and content
- FAQ Section: LLM generates 3 Q&A pairs relevant to the page topic
- Expert Quote: LLM suggests a quote template with placeholder for expert name
- Quotable Block: LLM extracts/rewrites a key paragraph into 40-60 word standalone form

**For free users (guidance only):**
- "Add a 1-3 sentence summary answering '{H1 as question}' in the first paragraph"
- "Add a FAQ section with 3 questions patients commonly ask about {topic}"

**Model:** gpt-4o-mini (same as current fix generator — cost-effective for content generation)

**Batching:** Extend existing `page-fix-generator.ts` batches. Add zone suggestions alongside existing title/meta/heading/pillar fixes.

### 4.4 Extended PerPageFix Type

```typescript
// Extend existing PerPageFix
type PerPageFix = {
  // ... existing fields ...

  // New: content zone suggestions
  zoneSuggestions: ZoneSuggestion[];
};

type ZoneSuggestion = {
  zone: "direct_answer" | "comparison_table" | "data_evidence" | "expert_quote" | "faq_section" | "quotable_block";
  exists: boolean;       // already present on the page
  suggestion: string;    // the actual suggested content (paid) or guidance (free)
  evidence: string;      // research backing, e.g., "+41% visibility (Princeton GEO)"
  insertAfter: string;   // suggested location, e.g., "after the first H2" or "before the closing section"
};
```

### 4.5 Acceptance Criteria

- [ ] Zone audit detects existing Direct Answer, Comparison Table, FAQ, Expert Quote, Quotable Block
- [ ] Missing zones generate suggestions (draft content for paid, guidance for free)
- [ ] Suggestions include research evidence citations
- [ ] Zone suggestions stored in perPageFixes alongside existing fixes
- [ ] Suggestion count scales with page content (thin pages get fewer zone suggestions)
- [ ] Pages with <300 words: only suggest Direct Answer Block (not all 6 zones)

---

## 5. C10: Rule Extraction Per Generative Engine

### 5.1 Approach

Inspired by AutoGEO (CMU), but adapted for our context. We don't rewrite content — we **discover what each engine prefers and surface it as recommendations.**

**Phase 1: Preference observation (runs during citation check)**

During citation execution, for each prompt × provider pair, record:
- Whether the brand was mentioned (existing)
- The brand's position (existing)
- The response structure (new): list format, paragraph format, with citations, without citations

**Phase 2: Pairwise preference analysis (runs after citation check)**

Compare responses across providers for the same prompt:
```
Prompt: "best oncology hospitals in India"
  ChatGPT: mentioned at position 1, paragraph format, with citations
  Perplexity: mentioned at position 3, list format, with web links
  Gemini: not mentioned
  Claude: mentioned at position 2, list format, no citations
```

**Phase 3: Rule extraction (periodic, not per-check)**

After accumulating ≥3 citation checks for a domain, analyze patterns:
```
Pattern: ChatGPT consistently ranks brand higher when page has FAQ schema
Pattern: Perplexity mentions brand more when page has external citations
Pattern: Gemini rarely mentions brand regardless (possible training data gap)
```

**Implementation:** New service `engine-preference-analyzer.ts` that runs a Sonnet call with accumulated citation responses:

```
Given these citation check results across multiple runs:
[{prompt, provider, mentioned, position, responseStructure}, ...]

Identify patterns in which providers mention this brand and when.
Extract 3-5 actionable rules per provider.

Output format:
[
  { "provider": "chatgpt", "rule": "...", "confidence": "high|medium|low", "evidence": "mentioned in X/Y prompts when ..." },
  ...
]
```

### 5.2 Storage

```typescript
// On geoSites (cached, refreshed after each citation check if ≥3 checks exist)
enginePreferences: jsonb("engine_preferences").$type<EnginePreference[]>(),
```

```typescript
type EnginePreference = {
  provider: string;
  rules: EngineRule[];
  analyzedAt: string;
  checkCount: number; // how many citation checks informed this analysis
};

type EngineRule = {
  rule: string;
  confidence: "high" | "medium" | "low";
  evidence: string;
};
```

### 5.3 Surfacing

- Dashboard: "What each AI engine prefers" section
- Recommendations: "To improve ChatGPT visibility: {rule}"
- Per-page fixes: Engine-specific suggestions when applicable

### 5.4 Constraints

- Requires ≥3 citation checks to produce meaningful patterns. Before that: null.
- Sonnet call only on the 3rd+ check. Not on every check.
- Max 5 rules per provider (keep focused).
- Confidence thresholds: "high" requires ≥70% consistency, "medium" ≥50%, "low" ≥30%.

### 5.5 Acceptance Criteria

- [ ] Engine preferences NOT computed on 1st or 2nd citation check
- [ ] On 3rd+ check: Sonnet analyzes accumulated responses, produces per-provider rules
- [ ] Rules include confidence level and evidence
- [ ] Stored on geoSites as enginePreferences
- [ ] Results surface in recommendations when applicable

---

## 6. Files Affected

| File | Change |
|------|--------|
| `lib/services/content-strategy-scorer.ts` | **New.** Deterministic detection of quotations, statistics, citations per page. |
| `lib/services/page-fix-generator.ts` | Extend to generate zone suggestions alongside existing fixes. |
| `lib/services/engine-preference-analyzer.ts` | **New.** Pairwise preference analysis + rule extraction via Sonnet. |
| `lib/services/geo-analyzer.ts` | Inject content strategy signals into scoring prompt. |
| `app/api/pipeline/stage/route.ts` | Compute content strategy scores in assemble. |
| `app/api/sites/[id]/citation-check/route.ts` | Record response structure. Trigger engine preference analysis on 3rd+ check. |
| `lib/db/schema.ts` | New fields: contentStrategyScores, enginePreferences on geoSites. |
| `lib/types/citation.ts` | New types. |

## 7. New DB Columns

```sql
ALTER TABLE geo_sites
  ADD COLUMN content_strategy_scores jsonb,
  ADD COLUMN engine_preferences jsonb;
```

---

## 8. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Quotation/statistics detection false positives | Medium | Conservative patterns. Require context (not just a number). Validate against sample sites. |
| Zone suggestions add to page-fix generation cost | Low | Piggyback on existing gpt-4o-mini batches. Marginal token increase. |
| Engine preferences require multiple checks (cold start) | Medium | Expected. Show "run 2 more checks for engine-specific insights" message. |
| Engine preference rules may be generic | Medium | Confidence threshold filtering. Only surface "high" by default. |

## 9. Out of Scope

- Content rewriting (we suggest, not rewrite)
- RL-trained model for optimization (dropped — Manipal-derived)
- Per-location competitor mapping (C11 — Tier 4)
- Real prompt discovery (C12 — Tier 4)
