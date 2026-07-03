# ES-055: GEO Improvement Tier 3 — Content Intelligence

**Source:** TS-055-geo-improvement-tier3.md
**Author:** SpecMaster (Agent 2)
**Date:** 2026-03-23
**Branch:** `dev-an-geo`
**Issues:** #143 (C8), #144 (C9), #145 (C10)
**Depends on:** ES-053 (Tier 1 — trees), ES-054 (Tier 2 — evidence framework)

---

## a) Overview

### What This Covers

Three changes adding content-level intelligence to scoring and fix generation:

| Component | Summary |
|-----------|---------|
| **C8** | Content strategy scoring — detect quotations, statistics, cited sources per page |
| **C9** | Content zone suggestions — Direct Answer, FAQ, Quotable Blocks, etc. |
| **C10** | Rule extraction per generative engine — pairwise preference analysis |

### Current Implementation State

**Exists:**
- `lib/services/geo-analyzer.ts` — 16 pillars scored via Gemini. Pillars include `content_structure` and `evidence_statistics` which will receive C8 signals.
- `lib/services/page-fix-generator.ts` — `generatePerPageFixes()` generates title/meta/heading/pillar fixes per page. `PerPageFix` type has `pillarFixes[]` but no content zone suggestions. Batches of 15, max 100 pages, gpt-4o-mini.
- `lib/services/citation-checker.ts` — Records per-response: mentioned, position, sentiment, competitorsMentioned. No response structure analysis.
- `lib/services/per-page-analyzer.ts` — `PerPageResult` with `vulnerabilities[]` and `overallPageHealth`.
- `app/api/sites/[id]/citation-check/route.ts` — SSE-based check, stores to citationCheckScores and citationCheckResponses.

**Does not exist (new):**
- Content strategy detection (quotations, statistics, citations)
- Zone audit / zone suggestions
- Engine preference analysis / rule extraction

---

## b) Implementation Requirements

### b.1 Schema Changes

**File:** `lib/db/schema.ts`

**On `geoSites`:**

```typescript
contentStrategyScores: jsonb("content_strategy_scores").$type<ContentStrategyReport>(),
enginePreferences: jsonb("engine_preferences").$type<EnginePreference[]>(),
```

**SQL migration** (`geo/drizzle/XXXX_tier3_columns.sql`):

```sql
ALTER TABLE geo_sites
  ADD COLUMN content_strategy_scores jsonb,
  ADD COLUMN engine_preferences jsonb;
```

Both nullable. No defaults.

### b.2 Type Definitions

**File:** `lib/types/content-strategy.ts` (NEW)

```typescript
// ── Per-Page Strategy Scores ─────────────────────────────────────

export type QuotationScore = {
  count: number;           // quotation instances found
  hasAttribution: boolean; // at least one quote has a named source
  score: number;           // 0-100
};

export type StatisticsScore = {
  count: number;           // data points found
  hasSourceAttribution: boolean;
  score: number;           // 0-100
};

export type CitationSourceScore = {
  externalLinkCount: number;
  authoritativeLinkCount: number; // .gov, .edu, .org, research domains
  inlineCitationCount: number;
  score: number;                   // 0-100
};

export type PageStrategyScores = {
  url: string;
  quotations: QuotationScore;
  statistics: StatisticsScore;
  citations: CitationSourceScore;
  compositeScore: number;          // weighted average: quotations 41%, statistics 33%, citations 26%
};

// ── Aggregate Report ─────────────────────────────────────────────

export type ContentStrategyReport = {
  quotations: {
    avgPerPage: number;
    pagesWithQuotes: number;
    pagesTotal: number;
    overallScore: number;   // average of per-page scores
  };
  statistics: {
    avgPerPage: number;
    pagesWithStats: number;
    pagesTotal: number;
    overallScore: number;
  };
  citations: {
    avgPerPage: number;
    pagesWithCitations: number;
    pagesTotal: number;
    overallScore: number;
  };
  computedAt: string;       // ISO-8601
};

// ── Content Zones ────────────────────────────────────────────────

export type ContentZone =
  | "direct_answer"
  | "comparison_table"
  | "data_evidence"
  | "expert_quote"
  | "faq_section"
  | "quotable_block";

export type PageZoneAudit = {
  url: string;
  hasDirectAnswer: boolean;
  hasComparisonTable: boolean;
  hasDataEvidence: boolean;
  hasExpertQuote: boolean;
  hasFaqSection: boolean;
  hasQuotableBlock: boolean;
  missingZones: ContentZone[];
};

export type ZoneSuggestion = {
  zone: ContentZone;
  exists: boolean;
  suggestion: string;        // draft content (paid) or guidance (free)
  evidence: string;          // research backing
  insertAfter: string;       // suggested location
};

// ── Engine Preferences ───────────────────────────────────────────

export type EngineRule = {
  rule: string;
  confidence: "high" | "medium" | "low";
  evidence: string;
};

export type EnginePreference = {
  provider: string;
  rules: EngineRule[];
  analyzedAt: string;
  checkCount: number;
};
```

### b.3 C8: Content Strategy Scoring

**File:** `lib/services/content-strategy-scorer.ts` (NEW)

#### Exports

```typescript
import type { CrawledPage } from "@/lib/services/geo-crawler";
import type { PageStrategyScores, ContentStrategyReport } from "@/lib/types/content-strategy";

/**
 * Score a single page for quotation blocks.
 * Detection: <blockquote>, "..." — Name, According to Name, Name says.
 */
export function scoreQuotations(content: string): QuotationScore;

/**
 * Score a single page for statistics/data points.
 * Detection: N%, Nx, $N, N million/billion, "increased by", "reduced by", <table>, <figure>.
 */
export function scoreStatistics(content: string): StatisticsScore;

/**
 * Score a single page for cited external sources.
 * Detection: external links >2 word anchor, "according to [Source]", (Source, Year), [1].
 * Authoritative domains: .gov, .edu, .org, pubmed, scholar.google.
 */
export function scoreCitedSources(content: string): CitationSourceScore;

/**
 * Score all three strategies for a single page.
 */
export function scorePageStrategies(page: CrawledPage): PageStrategyScores;

/**
 * Aggregate per-page scores into a ContentStrategyReport.
 */
export function aggregateStrategyReport(pages: CrawledPage[]): ContentStrategyReport;
```

#### Detection Rules (Deterministic — No LLM)

**Quotation scoring:**
1. Count `<blockquote>` occurrences in content.
2. Count patterns: `/"[^"]{15,}"[\s]*[—–-]\s*[A-Z]/g` (quoted text followed by attribution).
3. Count patterns: `/\b(According to|says|noted|stated|explained)\s+[A-Z][a-z]+/g`.
4. `hasAttribution = true` if any pattern matches in (2) or (3).
5. Score: 0 if count=0, 50 if count>0 but no attribution, 100 if count>0 with attribution.

**Statistics scoring:**
1. Count numeric patterns: `/\d+(\.\d+)?(%|x|×)/g`, `/\$[\d,.]+/g`, `/\d+\s*(million|billion|thousand)/gi`.
2. Count comparative phrases: `/(increased|decreased|grew|reduced|compared to|rose|fell)\s+by/gi`.
3. Count data elements: `<table>`, `<figure>`, `<data>` tags.
4. `hasSourceAttribution = true` if any pattern like `(Source, Year)` or `Source: ...` near a number.
5. Score: 0 if count=0, 50 if count>0 but no source, 100 if count≥3 with sources.

**Citation source scoring:**
1. Count external links: markdown `[text](url)` where url is external and text > 2 words.
2. Count authoritative links: external links to `.gov`, `.edu`, `.org`, `pubmed`, `scholar.google`, `arxiv.org`.
3. Count inline citations: `/according to\s+\[?[A-Z]/gi`, `/\([A-Z][a-z]+,?\s*\d{4}\)/g`, `/\[\d+\]/g`.
4. Score: 0 if externalLinks=0 and inlineCitations=0, 50 if links>0 but no authoritative, 100 if authoritative>0 and inlineCitations>0.

**Composite score per page:** `(quotations.score * 0.41) + (statistics.score * 0.33) + (citations.score * 0.26)` — weights from Princeton GEO impact research.

#### Integration with GEO Scoring

**File:** `lib/services/geo-analyzer.ts`

After computing `ContentStrategyReport`, inject as additional context into the Gemini scoring prompt:

```
Content strategy signals (pre-computed from crawl data):
- Quotation density: {avgPerPage} per page. {pagesWithQuotes}/{pagesTotal} pages have attributed quotes.
- Statistics density: {avgPerPage} per page. {pagesWithStats}/{pagesTotal} include sourced data points.
- External citation density: {avgPerPage} per page. {pagesWithCitations}/{pagesTotal} link to authoritative sources.

Use these signals to inform your scoring of content_structure and evidence_statistics pillars.
```

**Where in pipeline:** Compute `contentStrategyScores` in the `assemble` stage (it needs crawlData which is available). Store on geoSites.

Alternatively, compute in `extract-trees` stage alongside tree extraction — both operate on crawlData. This is acceptable if preferred for performance (parallel with LLM call).

### b.4 C9: Content Zone Suggestions

**File:** `lib/services/page-fix-generator.ts` (EXTEND)

#### Zone Audit Function (new, deterministic)

```typescript
export function auditPageZones(
  page: CrawledPage,
  pageStrategyScores?: PageStrategyScores
): PageZoneAudit
```

Detection per zone:
- **Direct Answer:** First 100 words contain a clear declarative statement (not a question, not navigation). Heuristic: first sentence > 15 words and doesn't start with a question word.
- **Comparison Table:** `<table>` with ≥2 rows and ≥2 columns detected in content.
- **Data & Evidence:** `pageStrategyScores.statistics.count >= 3`.
- **Expert Quote:** `pageStrategyScores.quotations.count >= 1 && pageStrategyScores.quotations.hasAttribution`.
- **FAQ Section:** Existing detection from per-page-analyzer (check `faqContent.length > 0` on CrawledPage).
- **Quotable Block:** Any paragraph (split by `\n\n`) that is 40-60 words, contains no pronouns (I, we, you, he, she, they), and reads as standalone fact.

`missingZones`: list of zones where `has{Zone} === false`.

#### Zone Suggestion Generation (LLM)

**Extend existing `generatePerPageFixes()`** to include zone suggestions.

Add `zoneSuggestions: ZoneSuggestion[]` to the `PerPageFix` type:

```typescript
export interface PerPageFix {
  // ... existing fields ...
  zoneSuggestions: ZoneSuggestion[];  // NEW
}
```

**In the LLM prompt for fix generation** (gpt-4o-mini batches), append zone context:

```
For each page, also suggest content zones that are missing:

Missing zones for this page: {missingZones list}

For paid users: generate draft content for each missing zone.
For free users: generate guidance only ("Add a FAQ section with 3 questions about {topic}").

Zone evidence:
- Direct Answer Block: 44.2% of citations come from first 30% of content
- Expert Quote: +41% visibility (Princeton GEO)
- Data & Evidence: +33% visibility (Princeton GEO)
- FAQ Section: 4.9 avg citations vs 4.4 without (SE Ranking)
- Quotable Block: Optimal for AI extraction (40-60 words, standalone)
- Comparison Table: Highly extractable by AI for ranked list responses
```

**Scaling rule:** Pages with < 300 words: only suggest Direct Answer Block (not all 6 zones — thin pages can't support all).

**Cost impact:** Zone suggestions piggyback on existing gpt-4o-mini batches. Marginal token increase per batch (~200 extra tokens per page for zone context + suggestions).

### b.5 C10: Rule Extraction Per Generative Engine

**File:** `lib/services/engine-preference-analyzer.ts` (NEW)

#### Exports

```typescript
import type { EnginePreference } from "@/lib/types/content-strategy";

/**
 * Analyze accumulated citation check responses to extract per-engine preference rules.
 * Requires ≥3 citation checks for the domain.
 * Uses Claude Sonnet for pattern analysis.
 */
export async function analyzeEnginePreferences(
  domain: string,
  siteId: string
): Promise<EnginePreference[] | null>;
```

#### Triggering Logic

**File:** `app/api/sites/[id]/citation-check/route.ts`

After citation check completes:

```typescript
// Count previous checks for this site
const checkCount = await db.select({ count: sql`count(*)` })
  .from(citationCheckScores)
  .where(eq(citationCheckScores.siteId, siteId));

if (checkCount >= 3) {
  // Run engine preference analysis (async, non-blocking)
  analyzeEnginePreferences(domain, siteId)
    .then(prefs => {
      if (prefs) {
        db.update(geoSites)
          .set({ enginePreferences: prefs })
          .where(eq(geoSites.id, siteId));
      }
    })
    .catch(err => console.warn(`[engine-prefs] ${domain}: analysis failed`, err));
}
```

**Non-blocking:** Engine preference analysis runs after the SSE stream closes. Does not delay user-facing results.

#### Data Assembly

1. Fetch all `citationCheckResponses` for this siteId (across all checks).
2. Group by prompt × provider.
3. For each response, extract `responseStructure`:
   - `"list"`: response contains numbered items or bullet points
   - `"paragraph"`: response is prose paragraphs
   - `"mixed"`: both elements present
   - Detection: count lines matching `/^\d+[\.\)]\s/` or `/^[-*]\s/` for list, else paragraph.

4. Build analysis payload:
```typescript
type EngineAnalysisInput = {
  provider: string;
  prompt: string;
  mentioned: boolean;
  position: number | null;
  responseStructure: "list" | "paragraph" | "mixed";
  sentiment: string;
}[];
```

#### LLM Call

**Model:** Claude Sonnet 4 (`claude-sonnet-4-6`), temperature 0, max_tokens 2000.

**System prompt:**
```
You are an AI citation pattern analyst. Given citation check results across multiple runs for a single domain, identify patterns in which AI providers mention this brand and when.

Extract 3-5 actionable rules per provider. Focus on:
- What content characteristics correlate with being mentioned
- What response format correlates with higher/lower positioning
- Provider-specific quirks (one provider consistently ranks the brand higher than others)

Confidence thresholds:
- "high": pattern appears in ≥70% of relevant responses
- "medium": 50-69%
- "low": 30-49%

Return JSON array. No prose.
```

**User prompt:** The assembled `EngineAnalysisInput[]` grouped by provider.

**Output schema:**
```json
[
  {
    "provider": "chatgpt",
    "rules": [
      { "rule": "...", "confidence": "high", "evidence": "mentioned in X/Y prompts when ..." }
    ]
  }
]
```

#### Constraints

- **Cold start:** Returns `null` for 1st and 2nd citation check. Only runs on 3rd+.
- **Max 5 rules per provider.**
- **Not every check triggers re-analysis.** Only on 3rd, 5th, 10th, and every 10th check thereafter (to avoid excessive Sonnet calls). Logic: `checkCount === 3 || checkCount === 5 || checkCount % 10 === 0`.
- **Sonnet timeout:** 30 seconds. On failure, skip (non-blocking, non-critical).
- **Cost:** ~$0.03 per analysis. At 3rd check only: $0.03/domain. Negligible.

---

## c) Unit Test Plan

**File:** `__tests__/services/content-strategy-scorer.test.ts` (NEW)

| # | Test | Input | Expected |
|---|------|-------|----------|
| U1 | scoreQuotations finds blockquotes | Content with `<blockquote>` | count ≥ 1 |
| U2 | scoreQuotations finds attributed quotes | `"Innovation is key" — Dr. Smith` | hasAttribution = true, score = 100 |
| U3 | scoreQuotations returns 0 for no quotes | Plain text content | count = 0, score = 0 |
| U4 | scoreQuotations finds "According to" pattern | `According to Dr. Johnson, the study...` | count ≥ 1 |
| U5 | scoreStatistics finds percentages | `Revenue grew by 45% in 2025` | count ≥ 1 |
| U6 | scoreStatistics finds monetary values | `$2.5 million in funding` | count ≥ 1 |
| U7 | scoreStatistics finds comparative phrases | `Increased by 3x compared to baseline` | count ≥ 1 |
| U8 | scoreStatistics finds tables | Content with `<table>` | count ≥ 1 |
| U9 | scoreStatistics returns 0 for no data | Narrative text with no numbers | count = 0, score = 0 |
| U10 | scoreCitedSources finds external links | `[Research paper](https://example.edu/paper)` | externalLinkCount ≥ 1 |
| U11 | scoreCitedSources identifies authoritative domains | Links to .gov, .edu | authoritativeLinkCount ≥ 1 |
| U12 | scoreCitedSources finds inline citations | `(Smith, 2024)` | inlineCitationCount ≥ 1 |
| U13 | scorePageStrategies composite weighting | Quotation 100, stats 100, citations 100 | compositeScore = 100 |
| U14 | aggregateStrategyReport averages correctly | 10 pages, mixed scores | Report averages match |
| U15 | aggregateStrategyReport handles empty pages | 0 pages | All zeros |

**File:** `__tests__/services/page-fix-generator-zones.test.ts` (NEW)

| # | Test | Input | Expected |
|---|------|-------|----------|
| U16 | auditPageZones detects Direct Answer | Page with clear first-100-word statement | hasDirectAnswer = true |
| U17 | auditPageZones detects missing Direct Answer | Page starting with navigation/question | hasDirectAnswer = false, "direct_answer" in missingZones |
| U18 | auditPageZones detects Comparison Table | Content with `<table>` ≥2 rows | hasComparisonTable = true |
| U19 | auditPageZones detects FAQ | Page with faqContent.length > 0 | hasFaqSection = true |
| U20 | auditPageZones detects Expert Quote | Page with attributed quotation | hasExpertQuote = true |
| U21 | auditPageZones detects Quotable Block | Paragraph 40-60 words, no pronouns | hasQuotableBlock = true |
| U22 | Zone suggestions for paid user | Missing direct_answer, isPaidUser=true | suggestion contains draft content |
| U23 | Zone suggestions for free user | Missing direct_answer, isPaidUser=false | suggestion contains guidance only |
| U24 | Thin pages only suggest Direct Answer | Page with < 300 words, 4 missing zones | zoneSuggestions has only direct_answer |
| U25 | Zone evidence included | Any zone suggestion | evidence field non-empty |

**File:** `__tests__/services/engine-preference-analyzer.test.ts` (NEW)

| # | Test | Input | Expected |
|---|------|-------|----------|
| U26 | analyzeEnginePreferences returns null for < 3 checks | 2 citation checks | null |
| U27 | analyzeEnginePreferences produces rules on 3rd check | 3 checks with diverse responses | EnginePreference[] with ≥1 provider |
| U28 | Rules have confidence levels | Mock Sonnet response | Each rule has "high"\|"medium"\|"low" |
| U29 | Max 5 rules per provider | Mock Sonnet returns 8 rules | Capped to 5 |
| U30 | Response structure detection: list | `1. Item one\n2. Item two` | "list" |
| U31 | Response structure detection: paragraph | `Long prose paragraph about the topic.` | "paragraph" |
| U32 | Non-blocking on Sonnet failure | Mock Sonnet timeout | No throw, returns null |
| U33 | Only triggers on checkpoints | 4th check (not 3, 5, or 10) | Analysis not triggered |

**Mocking:** Mock LLM clients, mock DB queries. Use Vitest.

---

## d) Integration Test Plan

**File:** `__tests__/integration/content-intelligence.test.ts` (NEW)

| # | Test | Scenario | Expected |
|---|------|----------|----------|
| IT1 | Content strategy scores computed during pipeline | Full pipeline through assemble | geoSites.contentStrategyScores populated |
| IT2 | Strategy scores injected into GEO analyzer | Pipeline through analyze | Gemini prompt includes quotation/statistics/citation density |
| IT3 | Zone suggestions appear in per-page fixes | Pipeline through assemble with paid user | perPageFixes entries have zoneSuggestions |
| IT4 | Zone suggestions scale with page length | Mix of thin (<300 word) and long pages | Thin pages: only direct_answer; long pages: multiple zones |
| IT5 | Engine prefs computed on 3rd citation check | Run 3 citation checks for same site | geoSites.enginePreferences populated after 3rd |
| IT6 | Engine prefs skipped on 1st/2nd check | Run 1 citation check | enginePreferences remains null |
| IT7 | End-to-end: strategy detection → scoring → zones → fixes | Full pipeline + fix gen | Consistent data flow: strategy scores inform both pillar scoring and zone suggestions |

---

## e) Profiling Requirements

| Metric | Target | Tool |
|--------|--------|------|
| scorePageStrategies per page | < 5ms | In-code timer |
| aggregateStrategyReport for 200 pages | < 100ms | In-code timer |
| auditPageZones per page | < 2ms | In-code timer |
| Zone suggestion generation (gpt-4o-mini batch) | +0.5s per batch of 15 (marginal) | LLM call timer |
| analyzeEnginePreferences (Sonnet) | < 15s | LLM call timer |

All strategy scoring is regex-based. Negligible overhead.

---

## f) Load Test Plan

| Scenario | Description | Success Criteria |
|----------|-------------|-----------------|
| L1 | 200-page site strategy scoring | All pages scored in < 200ms total |
| L2 | Zone suggestions for 100 pages (15-page batches) | All batches complete, no OOM |
| L3 | Engine preference analysis with 500 responses | Sonnet call < 15s, JSON parses correctly |

---

## g) Logging & Instrumentation

| Event | Level | Fields |
|-------|-------|--------|
| `content-strategy.scored` | info | domain, pagesTotal, avgQuotationScore, avgStatisticsScore, avgCitationScore |
| `content-strategy.page-detail` | debug | url, quotations.count, statistics.count, citations.externalLinkCount |
| `page-fix.zone-audit` | debug | url, missingZones |
| `page-fix.zone-suggestions` | info | domain, totalSuggestions, zonesDistribution |
| `engine-prefs.triggered` | info | domain, checkCount |
| `engine-prefs.complete` | info | domain, providerCount, totalRules |
| `engine-prefs.skipped` | debug | domain, reason ("< 3 checks" or "not a checkpoint") |
| `engine-prefs.failed` | warn | domain, error |

---

## h) Acceptance Criteria

### C8: Content Strategy Scoring

- [ ] **AC1**: Quotation detection finds `<blockquote>` and attribution patterns ("According to", "says")
- [ ] **AC2**: Statistics detection finds numeric patterns with context (%, x, $, million/billion)
- [ ] **AC3**: Citation detection finds external links and inline citation patterns
- [ ] **AC4**: Strategy scores passed to GEO analyzer as additional context in Gemini prompt
- [ ] **AC5**: `ContentStrategyReport` stored on geoSites
- [ ] **AC6**: Pages with zero strategies score 0; pages with all three score higher
- [ ] **AC7**: Composite score weighted: 41% quotations, 33% statistics, 26% citations

### C9: Content Zone Suggestions

- [ ] **AC8**: Zone audit detects existing Direct Answer, Comparison Table, FAQ, Expert Quote, Data Evidence, Quotable Block
- [ ] **AC9**: Missing zones generate suggestions (draft content for paid, guidance for free)
- [ ] **AC10**: Suggestions include research evidence citations
- [ ] **AC11**: Zone suggestions stored in `perPageFixes` alongside existing fixes
- [ ] **AC12**: Thin pages (< 300 words): only suggest Direct Answer Block
- [ ] **AC13**: `ZoneSuggestion` has `insertAfter` field suggesting placement location

### C10: Engine Preference Analysis

- [ ] **AC14**: Engine preferences NOT computed on 1st or 2nd citation check
- [ ] **AC15**: On 3rd check: Sonnet analyzes accumulated responses, produces per-provider rules
- [ ] **AC16**: Rules include confidence level ("high"/"medium"/"low") and evidence
- [ ] **AC17**: Max 5 rules per provider
- [ ] **AC18**: Stored on geoSites as `enginePreferences`
- [ ] **AC19**: Non-blocking: analysis runs after SSE stream closes, does not delay user
- [ ] **AC20**: Sonnet failure does not crash — returns null, logs warning
- [ ] **AC21**: Only triggers on checkpoints: 3rd, 5th, 10th, and every 10th thereafter

### Schema & Tests

- [ ] **AC22**: Migration adds `content_strategy_scores` and `engine_preferences` to geo_sites
- [ ] **AC23**: Unit tests U1–U33 pass
- [ ] **AC24**: Integration tests IT1–IT7 pass

---

## ScriptDev Notes

1. **Strategy detection is regex-based on CrawledPage.content** (max 3000 chars per page). This is sufficient for signal detection but won't catch everything. False negatives are acceptable — this is a scoring signal, not a precise count.

2. **Content comes as markdown** (from Firecrawl). Patterns like `<blockquote>` may appear as `> ` in markdown. Handle both HTML and markdown quotation patterns.

3. **Zone audit's "Quotable Block" detection** is the trickiest. A good heuristic: split content by double newlines, filter paragraphs to 40-60 words, check for pronouns with a simple regex `/\b(I|we|you|he|she|they|my|our|your)\b/i`. This will have false positives but is a reasonable signal.

4. **Engine preference analysis data assembly** queries all `citationCheckResponses` for the siteId. For sites with many checks (10+), this could be 10 × 48 × 4 = 1920 rows. Ensure the query has an index on `siteId` (it does — FK index).

5. **The checkpoint logic** (`checkCount === 3 || checkCount === 5 || checkCount % 10 === 0`) prevents excessive Sonnet calls. At $0.03/call and typical usage of 3-10 checks per site, cost is $0.03-$0.09 per site total.

6. **Zone suggestions extend the existing LLM prompt** in `generatePerPageFixes()`. The batch size (15 pages) stays the same. Just add zone context to the prompt and expect `zoneSuggestions[]` in the response JSON.

7. **ContentStrategyReport computation** should happen in the `assemble` stage (after crawlData is finalized). It reads crawlData.pages which is available. Store on geoSites alongside other generated content.
