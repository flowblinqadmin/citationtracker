# TS-024 — Smart Citation Prompts: Paid-Only, 48 Pillar-Targeted Prompts via 1 Haiku Call

**Date:** 2026-03-04
**Priority:** P1
**Status:** DISPATCHED — 2026-03-04
**Author:** CoFounder (Agent 1)

---

## What

Rewrite the AI Visibility citation prompt system from 4 static, domain-only templates to 48 pillar-targeted prompts generated dynamically via a single `claude-haiku-4-5` call. Remove citation check from the free tier entirely. Increase concurrency to handle 192 API calls in ~20s wall time.

---

## Why

The current `citation-prompt-generator.ts` (23 lines, 8 static templates, `count=4` default) ignores the full 16-pillar GEO scorecard that exists on every `geoSites` row. Every domain gets the same 4 generic questions regardless of what the audit found. The value proposition of AI Visibility is depth — but the current implementation delivers none.

Target: **5 credits → 48 targeted prompts → a result equivalent to a 25-page targeted re-audit.** The value jump from 4 generic prompts to 48 pillar-specific prompts is the justification for keeping it paid-only.

---

## Dependencies

- `geoSites.geoScorecard` must be non-null at citation check time (pipeline completed at least `geo_analysis` stage)
- `ANTHROPIC_API_KEY` must be set (already required for citation provider queries)
- ES-023 complete (crawl fan-out pipeline) — ensures site data is reliably populated before this ships

---

## Architecture: Three Steps

### Step 1 — Prompt Generation (1 Haiku call)

**Input:** Full `geoSites` row including:
- `domain` (string)
- `siteType` (string | null) — e.g. "SaaS", "E-commerce", "Agency"
- `geoScorecard.pillars` (array of 16 `GeoScore` objects, each with `pillarName`, `score`, `findings`)
- `executiveSummary` (string | null) — optional context

**LLM call:**
- Model: `claude-haiku-4-5-20251001`
- Max tokens: 2000
- Temperature: 0 (deterministic output)
- System prompt: instructs the model to output JSON only
- User prompt: structured template with all 16 pillar names, scores, and findings injected

**Expected output:** JSON array of 48 objects, 3 prompts per pillar:
```json
[
  { "pillar": "faq_coverage", "prompt": "What are frequently asked questions about example.com?" },
  { "pillar": "faq_coverage", "prompt": "Does example.com answer common customer questions about their service?" },
  { "pillar": "faq_coverage", "prompt": "What questions does example.com help customers solve?" },
  ...
]
```

**Fallback:** If Haiku call fails or returns malformed JSON, fall back to 4 legacy static prompts. Never block the citation check on a prompt-gen failure.

**Prompt engineering guidance for SpecMaster:**

The system prompt must instruct Haiku to:
1. Generate prompts that a real user would ask ChatGPT, Perplexity, or Google AI — natural language, not technical
2. Tailor each prompt to the specific pillar dimension: FAQ prompts ask about FAQs, structured data prompts ask about technical correctness, author authority prompts ask about expertise/credentials
3. Consider `siteType` — a SaaS company's faq_coverage prompts differ from an e-commerce store's
4. Weight toward low-scoring pillars (score < 40) — the most actionable gaps should have the sharpest prompts
5. Output valid JSON only, no markdown wrapping

Example pillar → prompt mapping to include in the system prompt:
```
faq_coverage → "What are frequently asked questions about {domain}?"
structured_data → "Is {domain} properly marked up for AI search engines?"
author_authority → "Who are the experts behind {domain}?"
evidence_statistics → "What data does {domain} cite to support their claims?"
contact_trust → "How do I contact {domain} and can I trust them?"
```

### Step 2 — Provider Execution (batched, increased concurrency)

**Current:** `BATCH_SIZE = 3`, `BATCH_DELAY_MS = 500` → ~32s artificial delay alone for 192 calls

**New:** `BATCH_SIZE = 20`, `BATCH_DELAY_MS = 100`

**Math:** 192 calls ÷ 20 concurrent × (avg 2s LLM latency + 0.1s delay) ≈ **~20s total wall time**. Acceptable for SSE stream with active progress events.

Constants must be defined in `lib/config.ts` (not hardcoded in `citation-checker.ts`):
```typescript
export const CITATION_CHECK_BATCH_SIZE = 20;
export const CITATION_CHECK_BATCH_DELAY_MS = 100;
```

**No other changes to the citation-checker execution loop.** Provider query functions, mention detection, competitor extraction, and the callback interface are unchanged.

### Step 3 — Per-Pillar Aggregation

After the existing per-provider aggregation, add per-pillar aggregation:

```typescript
pillarVisibility: Record<string, number>
// Key = pillar ID (e.g. "faq_coverage")
// Value = % of that pillar's 3 prompts where domain was mentioned across all providers
// = (mentions in 3 prompts × N providers) / (3 × N providers) × 100
```

This gives users a "which pillars is AI finding you for" breakdown — directly actionable against the 16-pillar scorecard.

---

## Files to Change

| File | Change |
|------|--------|
| `lib/services/citation-prompt-generator.ts` | Full rewrite: async `generatePrompts(site: GeoSite): Promise<{ pillar: string; prompt: string }[]>` — 1 Haiku call, 48 pillar-targeted prompts, fallback to 4 legacy prompts on error |
| `lib/services/citation-checker.ts` | `BATCH_SIZE` → read from config; `BATCH_DELAY_MS` → read from config; add `pillarVisibility` to aggregation output |
| `app/api/sites/[id]/citation-check/route.ts` | Hard gate: if `team.creditBalance === 0` return 402 immediately (no free path); pass full `site` object to `generatePrompts()`; emit `pillarVisibility` in complete event |
| `lib/config.ts` | Add `CITATION_CHECK_BATCH_SIZE = 20` and `CITATION_CHECK_BATCH_DELAY_MS = 100` |
| `lib/types/citation.ts` | Add `pillarVisibility: Record<string, number>` to `CitationCheckResult.scores` |

---

## Interfaces

### Updated `generatePrompts` signature
```typescript
// lib/services/citation-prompt-generator.ts
export async function generatePrompts(
  site: Pick<GeoSite, 'domain' | 'siteType' | 'geoScorecard' | 'executiveSummary'>
): Promise<{ pillar: string; prompt: string }[]>
```

The return type is an array of `{ pillar, prompt }` objects rather than a flat string array. `citation-checker.ts` must be updated to accept this type and route each prompt to the correct pillar bucket for aggregation.

### Updated `CitationCheckResult.scores`
```typescript
scores: {
  overallVisibility:    number;
  bestProvider:         string | null;
  worstProvider:        string | null;
  avgPosition:          number | null;
  sentimentScore:       number;
  competitorVisibility: Record<string, number>;
  pillarVisibility:     Record<string, number>; // NEW
}
```

### Updated SSE `complete` event
```typescript
{ type: "complete", data: CitationCheckResult }  // unchanged — pillarVisibility is inside scores
```

### Updated route credit gate (pseudo-code)
```typescript
// Existing: creditBalance < CITATION_CHECK_COST → 402
// New: creditBalance === 0 → 402 (same check if CITATION_CHECK_COST = 5, but explicit)
if (!site.teamId) return 402;
const [team] = await db.select()...
if (!team || team.creditBalance < CITATION_CHECK_COST) return 402;
// No free path. Full stop.
```

Note: The existing route code already gates on `!site.teamId` and `creditBalance < CITATION_CHECK_COST`. The TS-024 change ensures this gate is hard-coded as "paid-only" with no future code path that bypasses it. The route comment should be updated to reflect intent.

---

## Acceptance Criteria

1. **Prompt generation:** For a site with a complete `geoScorecard`, `generatePrompts()` returns exactly 48 `{ pillar, prompt }` objects (3 per pillar × 16 pillars). All 16 pillar IDs from `GEO_PILLARS` are represented.

2. **Prompt relevance:** Each prompt is phrased as a natural-language question a user would ask an AI assistant. No technical jargon. Domain name appears in each prompt.

3. **Fallback:** When `ANTHROPIC_API_KEY` is not set or the Haiku call fails, `generatePrompts()` returns 4 legacy prompts (the existing static templates) without throwing. The citation check proceeds.

4. **Batch size:** `runCitationCheck` reads `CITATION_CHECK_BATCH_SIZE` and `CITATION_CHECK_BATCH_DELAY_MS` from config. Hardcoded values removed.

5. **Pillar aggregation:** `runCitationCheck` returns `pillarVisibility: Record<string, number>` where each key is a pillar ID and each value is `Math.round((mentionsForPillar / totalCallsForPillar) * 100)`.

6. **Credit gate:** Route returns HTTP 402 immediately if `team.creditBalance < 5`. No anonymous or zero-credit path exists.

7. **SSE events:** All existing SSE events still fire. New: `prompt-generated` events now include `pillar` field alongside `prompt`, `index`, `total`.

8. **Performance:** End-to-end wall time for 4-provider, 48-prompt run is <30s (measured from SSE `start` to `complete`).

9. **No schema migrations required.** `pillarVisibility` is returned in the `complete` SSE event and stored in `citationCheckScores.providerResults` (jsonb — existing column). No new columns.

---

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Haiku call fails / timeout | Low | Fallback to 4 legacy prompts. Never block check. |
| Haiku returns malformed JSON | Low | Parse in try/catch; fallback on parse error. |
| 192 concurrent calls hit provider rate limits | Medium | BATCH_SIZE=20 with 100ms delay is conservative. If rate limit errors spike, reduce to 15. ReviewMaster should test with mock providers. |
| geoScorecard is null (pipeline incomplete) | Medium | Gate in route: if `!site.geoScorecard`, return 422 "Audit not complete — run GEO analysis first." |
| Prompt token overage (16 pillars × full findings) | Low | Cap each `findings` string to 200 chars in the Haiku prompt. Full text available on `site.geoScorecard`. |

---

## Out of Scope

- Dashboard UI changes (pillarVisibility display in frontend — separate ticket)
- Cost changes (5 credits unchanged)
- New DB migrations
- Changes to any provider query function
- Changes to mention detection or competitor extraction
