# TS-027 — AI Visibility v2: Market Citation Monitoring

**Date:** 2026-03-04
**Status:** Ready for Engineering Spec
**Priority:** P1
**Replaces:** ES-024 prompt strategy (same 4-file scope, no new infrastructure)

---

## What

Replace the ES-024 prompt generation strategy (48 site-attribute queries that include the domain name) with a two-stage market citation monitoring model:

- **40 indirect market queries** — domain name absent; measures organic citation
- **8 direct brand queries** — domain name present; measures brand knowledge depth

Add citation quality scoring to every positive mention (4-signal composite: position, sentiment, competitor co-presence, context match).

Add two new aggregate metrics: `indirectVisibility` and `brandKnowledge`, computed separately from `overallVisibility`.

---

## Why

ES-024 prompts ask AI assistants about internal site attributes (e.g. "Does flowblinq.com have JSON-LD structured data?"). AI assistants do not crawl sites in real-time — they cannot answer these questions accurately. Mention detection is essentially random noise.

The real question is: "When a user asks ChatGPT a relevant market question, does it recommend us?"

Indirect market queries measure this directly. The domain must appear spontaneously in the AI response — that is the citation signal.

---

## Dependencies

- ES-024 must be complete and on `main` (it is: `dd440eb`) — TS-027 replaces its prompt strategy in the same 4 files
- No new infrastructure, no DB migration
- `ANTHROPIC_API_KEY` required for Haiku prompt generation (unchanged)

---

## Files to Change

| File | Change |
|------|--------|
| `lib/services/citation-prompt-generator.ts` | Rewrite system/user prompt. Return type changes to `CitationPrompt[]` where `CitationPrompt = { type: "indirect"\|"direct"; pillar: string\|null; prompt: string }`. Indirect prompts never contain domain; direct always do. Add post-generation validation to strip indirect prompts that leak domain name. |
| `lib/services/citation-checker.ts` | Accept `CitationPrompt[]`. Add `promptType` field to in-memory `ResponseRow`. Compute `indirectVisibility`, `brandKnowledge`, `citationQualityScore`. Compute `pillarVisibility` from indirect queries only. Return all 3 new fields. |
| `lib/types/citation.ts` | Add `indirectVisibility`, `brandKnowledge`, `citationQualityScore` to `CitationCheckResult.scores`. Update `prompt-generated` SSE event data to include `promptType: "indirect"\|"direct"` and `pillar: string\|null`. |
| `app/api/sites/[id]/citation-check/route.ts` | Pass `promptType` in `prompt-generated` SSE event. Include 3 new score fields in `complete` SSE event. No other changes. |

---

## Interfaces

### CitationPrompt (new exported type in citation-prompt-generator.ts)

```typescript
export type CitationPrompt = {
  type:   "indirect" | "direct";
  pillar: string | null;   // pillar tag for indirect queries; null for direct
  prompt: string;
};
```

### Updated CitationCheckResult.scores

```typescript
scores: {
  overallVisibility:    number;   // % of ALL 48 queries where domain mentioned
  indirectVisibility:   number;   // % of indirect-only queries (organic citation)  [NEW]
  brandKnowledge:       number;   // % of direct queries with meaningful AI response [NEW]
  citationQualityScore: number;   // 0-100 composite across all positive mentions    [NEW]
  bestProvider:         string | null;
  worstProvider:        string | null;
  avgPosition:          number | null;
  sentimentScore:       number;
  competitorVisibility: Record<string, number>;
  pillarVisibility:     Record<string, number>; // topic-based, indirect queries only
}
```

### Updated SSEEvent: prompt-generated

```typescript
{ type: "prompt-generated"; data: {
  prompt:     string;
  index:      number;
  total:      number;
  pillar:     string | null;          // was: string
  promptType: "indirect" | "direct";  // NEW
}}
```

### Updated runCitationCheck return type

Add to existing return object:
```typescript
indirectVisibility:   number;
brandKnowledge:       number;
citationQualityScore: number;
```

---

## Prompt Generation Strategy

### Indirect queries (~40 total, no domain name)

Map each query to a pillar by *market topic dimension*:

| Pillar | Market topic queried |
|--------|---------------------|
| `author_authority` | "Who are the experts/thought leaders in [domain's field]?" |
| `competitive_positioning` | "What are the top tools for [use case]?" / "Compare [category] platforms" |
| `offering_clarity` | "What does [product type] do?" / "What should I look for in [tool]?" |
| `faq_coverage` | "Common questions businesses have about [product area]?" |
| `evidence_statistics` | "What data/research supports using [domain's product type]?" |
| `contact_trust` | "Which [product type] vendors are trustworthy and reputable?" |
| `content_freshness` | "What are the latest developments in [domain's field]?" |
| `structured_data` | "Which platforms are best recognized by AI search engines?" |
| `entity_definitions` | "What is [core concept]? Which companies offer it?" |
| `metadata_freshness` | "Which tools stay current with AI algorithm changes?" |
| `semantic_html` | "Which sites/tools are best optimized for AI understanding?" |
| `multi_format` | "Which [category] tools offer the most comprehensive resources?" |
| `licensing_signals` | "Which [category] platforms are AI-safe and enterprise-ready?" |
| `internal_linking` | "Which tools provide the most complete platform coverage?" |
| `content_structure` | "Which platforms organize their knowledge base most clearly?" |
| `cta_structure` | "Which [category] tools are easiest to get started with?" |

Generate 2-3 indirect queries per pillar (= ~40 total).

### Direct queries (~8 total, domain name required)

- "What is {domain} and what does it offer?"
- "Is {domain} recommended for [use case]?"
- "How does {domain} compare to alternatives in [category]?"
- "What are the main features of {domain}?"
- "Is {domain} trustworthy and reputable?"
- "What do users say about {domain}?"
- "Who should use {domain}?"
- "How does {domain} stay current with AI algorithm changes?"

### Haiku system prompt changes

The new system prompt must:
1. Describe the 40/8 split explicitly
2. Instruct that indirect prompts MUST NOT contain the domain name (market/category queries only)
3. Instruct that direct prompts MUST contain the domain name
4. Map each indirect query to a pillar topic (not a site attribute)
5. Set `pillar: null` for direct queries
6. Output format: `[{ "type": "indirect"|"direct", "pillar": "pillar_id"|null, "prompt": "..." }]`

### Post-generation domain filter

After Haiku returns the array, run a filter pass:
- For each item where `type === "indirect"`: if `prompt` contains the domain name or the domain name without TLD (case-insensitive), remove it from the array and log a warning.
- This prevents hallucinated domain leakage from corrupting indirect citation measurement.

### Legacy fallback

Update to 4 prompts with the new shape:
```typescript
[
  { type: "indirect", pillar: "competitive_positioning", prompt: "What are the best GEO optimization tools for SaaS companies in {year}?" },
  { type: "indirect", pillar: "author_authority",        prompt: "Who are the leading experts and companies in AI search optimization?" },
  { type: "direct",   pillar: null, prompt: "What is {domain} and what does it offer?" },
  { type: "direct",   pillar: null, prompt: "How does {domain} compare to alternatives for GEO optimization?" },
]
```

---

## Citation Quality Scoring

For every response where `mentioned === true`, compute a quality score from 4 signals:

| Signal | Scoring |
|--------|---------|
| **Position** | position=1 → 100, position=2 → 80, position=3 → 60, position=4 → 40, position≥5 or null → 20 |
| **Sentiment** | positive → 100, neutral → 50, negative → 0 |
| **Competitor co-presence** | no competitors → 100 (alone); with tier-1 competitor → 80; with obscure tool → 40 |
| **Context match** | indirect query → 100 (market-relevant by construction); direct query → 100 |

`citationQualityScore` = arithmetic mean of all per-mention quality scores across all providers and queries.

**Tier-1 competitor detection:** After all responses are collected, build a frequency map of `competitorsMentioned`. The top-5 most-cited competitors are classified as tier-1.

---

## Aggregate Metrics

```
indirectVisibility  = (indirect responses where mentioned=true) / (total indirect responses) * 100
brandKnowledge      = (direct responses where mentioned=true)   / (total direct responses)   * 100
overallVisibility   = (all responses where mentioned=true)      / (total responses)           * 100
pillarVisibility    = per-pillar breakdown of indirectResponses only (unchanged computation, new filter)
```

---

## DB Impact

None. `citationCheckResponses` table does not need a `promptType` column — it is an in-memory field on `ResponseRow` used only for aggregation. Drizzle ORM ignores extra fields on insert. All new scores (`indirectVisibility`, `brandKnowledge`, `citationQualityScore`) are returned via SSE and not persisted to DB (consistent with `pillarVisibility` today).

---

## Acceptance Criteria

1. `generatePrompts()` returns an array of objects each with `{ type, pillar, prompt }` fields
2. Indirect prompts never contain the domain name; direct prompts always do
3. All 16 pillar topics represented in indirect queries (min 2 per pillar)
4. `citationQualityScore` computed from all 4 signals on every positive mention
5. `indirectVisibility` and `brandKnowledge` present in SSE `complete` event scores
6. `pillarVisibility` derived from indirect queries only
7. Legacy fallback (4 prompts) triggers on Haiku failure, uses new `{ type, pillar, prompt }` shape
8. No DB migration required
9. TypeScript compiles without errors on the 4 changed files

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Haiku generates indirect prompts that accidentally include domain name | Post-generation filter: strip any indirect prompt containing domain name or domain stem |
| Context match scoring complex to implement accurately | Use constant 100 for indirect (market-relevant by construction) — refine later if needed |
| Competitor co-presence tier-1 list unknown upfront | Build tier-1 from top-5 frequency in current check's `compMap` after all responses collected |
| Indirect queries produce 0 organic mentions (low-awareness domain) | Valid result — low `indirectVisibility` is the signal. Do not inflate. |
| Validation: Haiku may return fewer than 48 items if domain filter removes items | Validation checks structure, not exact count after filtering; log warnings for stripped items |
