# ES-027 — AI Visibility v2: Market Citation Monitoring

**Date:** 2026-03-04
**Priority:** P1
**Technical Spec:** TS-027-market-citation-monitoring.md
**Baseline:** ES-024 implementation (commit `dd440eb`) — same 4 files, no new infrastructure
**Status:** READY — dispatch to ReviewMaster

---

## a) Overview

Replaces ES-024's 48 site-attribute queries (noisy, domain-name-always-present) with a two-stage market citation monitoring model:

- **~40 indirect market queries** — domain name absent; measures organic AI citation
- **~8 direct brand queries** — domain name present; measures brand knowledge depth

Adds citation quality scoring across 4 signals and 3 new aggregate metrics: `indirectVisibility`, `brandKnowledge`, `citationQualityScore`.

### Why this fixes ES-024

ES-024 prompts ask AI assistants about internal site attributes (e.g. "Does flowblinq.com have JSON-LD structured data?"). AI assistants cannot answer these accurately — they don't crawl sites in real-time. The result is random noise. TS-027 flips the model: measure whether AI spontaneously cites the domain when asked relevant market questions.

### Current state (ES-024 baseline)

| File | ES-024 state |
|------|-------------|
| `citation-prompt-generator.ts` | Returns `{ pillar: string; prompt: string }[]`; 48 domain-name-included queries; system prompt asks about site attributes |
| `citation-checker.ts` | Accepts `{ pillar: string; prompt: string }[]`; no `indirectVisibility`, `brandKnowledge`, `citationQualityScore`; `pillarVisibility` uses all responses |
| `lib/types/citation.ts` | `CitationCheckResult.scores` has `pillarVisibility`; `prompt-generated` has `pillar: string` (non-nullable) |
| `route.ts` | `onAnalysisStart` passes `pillar`; `complete` emits `pillarVisibility` |

### What changes (TS-027 delta)

| File | Change |
|------|--------|
| `lib/services/citation-prompt-generator.ts` | New `CitationPrompt` exported type; rewrite system/user prompt; 40 indirect + 8 direct; domain filter; fallback updated to new shape |
| `lib/services/citation-checker.ts` | Accept `CitationPrompt[]`; add `promptType` to `ResponseRow`; compute 3 new scores; `pillarVisibility` indirect-only |
| `lib/types/citation.ts` | 3 new fields in `CitationCheckResult.scores`; `prompt-generated` updated; `pillar` becomes `string \| null` |
| `app/api/sites/[id]/citation-check/route.ts` | Pass `promptType` in `prompt-generated`; 3 new fields in `complete` scores |

---

## b) Implementation Requirements

### 1. `geo/lib/types/citation.ts`

#### 1a. Updated `CitationCheckResult.scores`

Add 3 new fields after `overallVisibility`:

```typescript
export interface CitationCheckResult {
  checkId:         string;
  scores: {
    overallVisibility:    number;   // % of ALL queries where domain mentioned
    indirectVisibility:   number;   // % of indirect queries where domain organically cited  [NEW]
    brandKnowledge:       number;   // % of direct queries where domain mentioned            [NEW]
    citationQualityScore: number;   // 0-100 composite across all positive mentions          [NEW]
    bestProvider:         string | null;
    worstProvider:        string | null;
    avgPosition:          number | null;
    sentimentScore:       number;
    competitorVisibility: Record<string, number>;
    pillarVisibility:     Record<string, number>; // topic-based, indirect queries only
  };
  providerResults: ProviderResult[];
  promptsUsed:     string[];
  creditsUsed:     number;
}
```

#### 1b. Updated SSE `prompt-generated` event

Change `pillar: string` to `pillar: string | null`, add `promptType`:

```typescript
| { type: "prompt-generated"; data: {
    prompt:     string;
    index:      number;
    total:      number;
    pillar:     string | null;         // was: string (non-nullable in ES-024)
    promptType: "indirect" | "direct"; // NEW
  }}
```

No other SSE event types change.

---

### 2. `geo/lib/services/citation-prompt-generator.ts`

#### 2a. New exported type `CitationPrompt`

Add as a named export at the top of the file:

```typescript
export type CitationPrompt = {
  type:   "indirect" | "direct";
  pillar: string | null;   // pillar tag for indirect queries; null for direct
  prompt: string;
};
```

#### 2b. Updated `LEGACY_PROMPTS`

Replace the existing `LEGACY_PROMPTS` constant with the new shape. All 4 prompts must use `CitationPrompt`:

```typescript
const LEGACY_PROMPTS: CitationPrompt[] = [
  { type: "indirect", pillar: "competitive_positioning", prompt: "What are the best GEO optimization tools for SaaS companies in {year}?" },
  { type: "indirect", pillar: "author_authority",        prompt: "Who are the leading experts and companies in AI search optimization?" },
  { type: "direct",   pillar: null, prompt: "What is {domain} and what does it offer?" },
  { type: "direct",   pillar: null, prompt: "How does {domain} compare to alternatives for GEO optimization?" },
];
```

Update `buildFallback` to return `CitationPrompt[]`:

```typescript
function buildFallback(domain: string): CitationPrompt[] {
  const year = new Date().getFullYear().toString();
  return LEGACY_PROMPTS.map(({ type, pillar, prompt }) => ({
    type,
    pillar,
    prompt: prompt.replace(/\{domain\}/g, domain).replace(/\{year\}/g, year),
  }));
}
```

#### 2c. Updated `isValidPromptArray`

The new validator checks structure only — not exact count (domain filter may reduce item count):

```typescript
function isValidCitationPromptArray(data: unknown): data is CitationPrompt[] {
  if (!Array.isArray(data) || data.length < 20) return false;
  return data.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as Record<string, unknown>).type === "indirect" ||
      (item as Record<string, unknown>).type === "direct"
  ) && data.every(
    (item) => typeof (item as Record<string, unknown>).prompt === "string"
  );
}
```

Note the min-20 floor guards against Haiku returning a near-empty array while still being valid JSON.

**Correct implementation (handle operator precedence):**

```typescript
function isValidCitationPromptArray(data: unknown): data is CitationPrompt[] {
  if (!Array.isArray(data) || data.length < 20) return false;
  return data.every((item) => {
    if (typeof item !== "object" || item === null) return false;
    const { type, prompt } = item as Record<string, unknown>;
    return (type === "indirect" || type === "direct") && typeof prompt === "string";
  });
}
```

#### 2d. Domain filter

Add a new internal function. Called after Haiku returns and before returning to the caller:

```typescript
function filterIndirectDomainLeaks(prompts: CitationPrompt[], domain: string): CitationPrompt[] {
  // Match domain name and domain stem (without TLD)
  const domainStem = domain.replace(/\.(com|io|co|net|org|ai|app|dev).*$/i, "");
  const escapedStem = domainStem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escapedDomain}|${escapedStem})`, "i");

  return prompts.filter((p) => {
    if (p.type !== "indirect") return true; // direct queries keep domain — allowed
    if (regex.test(p.prompt)) {
      console.warn(`[citation-prompts] stripped indirect prompt leaking domain: "${p.prompt}"`);
      return false;
    }
    return true;
  });
}
```

#### 2e. Updated Haiku system prompt (verbatim — ready to copy)

Replace the existing `SYSTEM_PROMPT` constant entirely:

```typescript
const SYSTEM_PROMPT = `You are a market query generator for AI citation measurement. Your job is to generate natural-language questions that real users ask AI assistants (ChatGPT, Perplexity, Google AI) when exploring a market or evaluating vendors — NOT questions about a specific website's internal attributes.

You will generate exactly 48 queries total in two categories:

CATEGORY 1 — INDIRECT QUERIES (40 queries, 2-3 per GEO pillar)
- Purpose: Measure whether the domain is organically cited when users ask market-level questions
- Rule: INDIRECT queries MUST NOT contain the domain name or any variation of it
- These are category/market queries — the domain should appear spontaneously in AI responses if it is well-known
- Map each query to one of the 16 GEO pillar topics using these market-level angles:
  - author_authority        → "Who are the experts/thought leaders in [domain's field]?" / "Which companies in [field] have the most credible team?"
  - competitive_positioning → "What are the top tools for [use case]?" / "Compare the leading [category] platforms" / "Best alternatives to [competitor] for [use case]?"
  - offering_clarity        → "What should I look for in a [product type]?" / "What does [product category] software do?"
  - faq_coverage            → "Common questions about [product area]?" / "What do buyers ask before choosing a [product type]?"
  - evidence_statistics     → "What data supports using [domain's product type]?" / "ROI studies for [category] tools?"
  - contact_trust           → "Which [product type] vendors are most trustworthy?" / "How to evaluate [category] providers?"
  - content_freshness       → "What are the latest developments in [domain's field]?" / "Which [category] tools stay current with AI changes?"
  - structured_data         → "Which platforms are best recognized by AI search engines?" / "Which tools are most AI-search-friendly?"
  - entity_definitions      → "What is [core concept in domain's field]? Which companies offer it?"
  - metadata_freshness      → "Which [category] tools update their content most frequently?"
  - semantic_html           → "Which [category] sites are best optimized for AI understanding?"
  - multi_format            → "Which [category] tools offer the most comprehensive learning resources?"
  - licensing_signals       → "Which [category] platforms are AI-safe and enterprise-ready?"
  - internal_linking        → "Which tools provide the most complete and connected platform coverage?"
  - content_structure       → "Which platforms organize their knowledge base most clearly?"
  - cta_structure           → "Which [category] tools are easiest to get started with?"

CATEGORY 2 — DIRECT QUERIES (8 queries, pillar: null)
- Purpose: Measure brand knowledge depth — what AI knows about the domain specifically
- Rule: DIRECT queries MUST contain the domain name
- Generate these 8 direct queries (substituting {domain} with the actual domain):
  1. "What is {domain} and what does it offer?"
  2. "Is {domain} recommended for [use case based on siteType]?"
  3. "How does {domain} compare to alternatives in [category]?"
  4. "What are the main features of {domain}?"
  5. "Is {domain} trustworthy and reputable?"
  6. "What do users say about {domain}?"
  7. "Who should use {domain}?"
  8. "How does {domain} stay current with AI algorithm changes?"

OUTPUT FORMAT — Output ONLY valid JSON. No markdown, no explanation, no code fences.
[
  { "type": "indirect", "pillar": "author_authority",        "prompt": "Who are the most trusted experts in GEO optimization?" },
  { "type": "indirect", "pillar": "competitive_positioning", "prompt": "What are the top AI visibility audit tools for SaaS?" },
  ...
  { "type": "direct",   "pillar": null, "prompt": "What is {domain} and what does it offer?" },
  ...
]

CRITICAL: Indirect queries must NEVER contain the domain name. Direct queries must ALWAYS contain the domain name.`;
```

#### 2f. Updated user prompt builder

The user prompt now provides market context (not site audit context). Replace `buildUserPrompt`:

```typescript
function buildUserPrompt(
  site: Pick<GeoSite, "domain" | "siteType" | "geoScorecard" | "executiveSummary">
): string {
  const scorecard = site.geoScorecard as GeoScorecard | null;

  // Summarise scorecard as weak-pillar context (for sharpening market queries)
  const scorecardContext = scorecard
    ? `GEO Scorecard context (use to sharpen market queries toward weaker dimensions):\n${
        scorecard.pillars
          .sort((a, b) => a.score - b.score) // weakest first
          .map(p => `  ${p.pillar}: score=${p.score}`)
          .join("\n")
      }`
    : "GEO Scorecard: not available.";

  return `Domain: ${site.domain}
Site type: ${site.siteType ?? "unknown"}
Executive summary: ${(site.executiveSummary as string | null)?.slice(0, 300) ?? "not available"}

${scorecardContext}

Generate 48 queries (40 indirect + 8 direct) as a JSON array. Remember:
- Indirect queries must NOT contain "${site.domain}" or any variation of it
- Direct queries must contain "${site.domain}"
- All 16 GEO pillar topics must be represented in indirect queries (2-3 per pillar)`;
}
```

#### 2g. Updated `generatePrompts` signature and body

Change return type from `{ pillar: string; prompt: string }[]` to `CitationPrompt[]`:

```typescript
export async function generatePrompts(
  site: Pick<GeoSite, "domain" | "siteType" | "geoScorecard" | "executiveSummary">
): Promise<CitationPrompt[]>
```

Update the success path to apply the domain filter and use updated validator:

```typescript
// In the try block, after JSON.parse:
const parsed = JSON.parse(text) as unknown;
if (!isValidCitationPromptArray(parsed)) {
  throw new Error(
    `Validation failed: got ${Array.isArray(parsed) ? parsed.length : "non-array"}, min 20 required with valid structure`
  );
}
// Apply domain filter before returning
const filtered = filterIndirectDomainLeaks(parsed as CitationPrompt[], site.domain);
const elapsed = Date.now() - t0;
console.info(
  `[citation-prompts] ${site.domain}: Haiku generated ${filtered.length} prompts in ${elapsed}ms` +
  ` (${filtered.filter(p => p.type === "indirect").length} indirect, ${filtered.filter(p => p.type === "direct").length} direct)`
);
return filtered;
```

---

### 3. `geo/lib/services/citation-checker.ts`

#### 3a. Import type update

```typescript
import { type CitationPrompt } from "@/lib/services/citation-prompt-generator";
```

Remove or replace the old `{ pillar: string; prompt: string }` inline type.

#### 3b. Add `promptType` to `ResponseRow`

```typescript
type ResponseRow = {
  id: string; checkId: string; siteId: string;
  provider: string; model: string; query: string;
  pillar: string | null;          // now nullable (direct queries have null)
  promptType: "indirect" | "direct"; // NEW
  response: string | null; responseTimeMs: number | null;
  mentioned: boolean; position: number | null;
  sentiment: string | null; competitorsMentioned: string[];
  error: string | null;
};
```

#### 3c. Updated `runCitationCheck` signature

```typescript
export async function runCitationCheck(
  checkId: string,
  siteId: string,
  domain: string,
  prompts: CitationPrompt[],          // was: { pillar: string; prompt: string }[]
  callbacks: CitationCheckerCallbacks
): Promise<{
  responses: ResponseRow[];
  providerResults: ProviderResult[];
  overallVisibility: number;
  sentimentScore: number;
  avgPosition: number | null;
  bestProvider: string | null;
  worstProvider: string | null;
  competitorVisibility: Record<string, number>;
  pillarVisibility: Record<string, number>;
  indirectVisibility:   number;   // NEW
  brandKnowledge:       number;   // NEW
  citationQualityScore: number;   // NEW
}>
```

#### 3d. Updated task construction

```typescript
type Task = {
  prompt: string;
  pillar: string | null;
  promptType: "indirect" | "direct";
  promptIndex: number;
  provider: typeof providers[number];
};
const tasks: Task[] = prompts.flatMap(({ prompt, pillar, type: promptType }, promptIndex) =>
  providers.map(provider => ({ prompt, pillar, promptType, promptIndex, provider }))
);
```

#### 3e. Updated `onAnalysisStart` call

Pass `pillar` (now `string | null`) and `promptType`:

```typescript
callbacks.onAnalysisStart(provider.name, prompt, promptIndex, prompts.length, pillar, promptType);
```

#### 3f. Updated `CitationCheckerCallbacks`

```typescript
export interface CitationCheckerCallbacks {
  onAnalysisStart:    (
    provider: string,
    prompt: string,
    promptIndex: number,
    totalPrompts: number,
    pillar: string | null,
    promptType: "indirect" | "direct"
  ) => void;
  onPartialResult:    (provider: string, prompt: string, mentioned: boolean, position: number | null, sentiment: string | null) => void;
  onAnalysisComplete: (provider: string, prompt: string, status: "completed" | "failed") => void;
}
```

#### 3g. Updated `ResponseRow` construction in task executor

In both success and error branches, include `pillar` and `promptType`:

```typescript
// Success branch:
return {
  id: nanoid(), checkId, siteId,
  provider: provider.name, model: provider.model, query: prompt,
  pillar,          // string | null
  promptType,      // "indirect" | "direct"
  response: text, responseTimeMs,
  mentioned, position, sentiment, competitorsMentioned, error: null,
} satisfies ResponseRow;

// Error branch:
return {
  id: nanoid(), checkId, siteId,
  provider: provider.name, model: provider.model, query: prompt,
  pillar,
  promptType,
  response: null, responseTimeMs: null,
  mentioned: false, position: null, sentiment: null, competitorsMentioned: [], error,
} satisfies ResponseRow;
```

#### 3h. Aggregate metrics: `indirectVisibility` and `brandKnowledge`

Add after the existing `competitorVisibility` block (and before `pillarVisibility`):

```typescript
// ── Indirect vs direct visibility ─────────────────────────────────────
const indirectResponses = allResponses.filter(r => r.promptType === "indirect");
const directResponses   = allResponses.filter(r => r.promptType === "direct");

const indirectMentioned = indirectResponses.filter(r => r.mentioned).length;
const directMentioned   = directResponses.filter(r => r.mentioned).length;

const indirectVisibility = Math.round(
  (indirectMentioned / Math.max(indirectResponses.length, 1)) * 100
);
const brandKnowledge = Math.round(
  (directMentioned / Math.max(directResponses.length, 1)) * 100
);
```

#### 3i. Citation quality scoring: `citationQualityScore`

The tier-1 competitor list is derived from `compMap` (already computed above). Add after `indirectVisibility` / `brandKnowledge`:

```typescript
// ── Tier-1 competitor detection (top-5 by frequency) ─────────────────
const tier1Competitors = new Set(
  Object.entries(compMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([comp]) => comp)
);

// ── Per-mention quality scoring ───────────────────────────────────────
function positionSignal(position: number | null): number {
  if (position === 1) return 100;
  if (position === 2) return 80;
  if (position === 3) return 60;
  if (position === 4) return 40;
  return 20; // position >= 5 or null
}

function sentimentSignal(sentiment: string | null): number {
  if (sentiment === "positive") return 100;
  if (sentiment === "negative") return 0;
  return 50; // "neutral" or null
}

function coPresenceSignal(competitorsMentioned: string[], tier1: Set<string>): number {
  if (competitorsMentioned.length === 0) return 100; // alone in response
  if (competitorsMentioned.some(c => tier1.has(c))) return 80; // alongside tier-1 rival
  return 40; // alongside obscure tools only
}

const mentionQualities: number[] = [];
for (const r of allResponses) {
  if (!r.mentioned) continue;
  const quality =
    (positionSignal(r.position) +
      sentimentSignal(r.sentiment) +
      coPresenceSignal(r.competitorsMentioned, tier1Competitors) +
      100) / // contextMatchScore is always 100 (indirect = market-relevant; direct = brand-relevant)
    4;
  mentionQualities.push(quality);
}
const citationQualityScore =
  mentionQualities.length > 0
    ? Math.round(
        mentionQualities.reduce((a, b) => a + b, 0) / mentionQualities.length
      )
    : 0;
```

#### 3j. Updated `pillarVisibility` — indirect-only filter

Replace the existing `pillarVisibility` computation block:

```typescript
// ── Pillar visibility (indirect queries only) ─────────────────────────
const pillarVisibility: Record<string, number> = {};
const pillarGroups = new Map<string, ResponseRow[]>();

for (const r of allResponses) {
  if (r.promptType !== "indirect" || !r.pillar) continue; // skip direct and null-pillar
  if (!pillarGroups.has(r.pillar)) pillarGroups.set(r.pillar, []);
  pillarGroups.get(r.pillar)!.push(r);
}

for (const [pillarId, rows] of pillarGroups.entries()) {
  const mentions = rows.filter(r => r.mentioned).length;
  pillarVisibility[pillarId] = Math.round(
    (mentions / Math.max(rows.length, 1)) * 100
  );
}
```

#### 3k. Updated log line

```typescript
console.info(
  `[citation-check] ${domain}: ${allResponses.length} calls, ${totalMentioned} mentions` +
  ` | indirect=${indirectVisibility}% brand=${brandKnowledge}% quality=${citationQualityScore}`
);
```

#### 3l. Updated return object

Add 3 new fields:

```typescript
return {
  responses: allResponses,
  providerResults,
  overallVisibility,
  sentimentScore,
  avgPosition,
  bestProvider,
  worstProvider,
  competitorVisibility,
  pillarVisibility,
  indirectVisibility,   // NEW
  brandKnowledge,       // NEW
  citationQualityScore, // NEW
};
```

---

### 4. `geo/app/api/sites/[id]/citation-check/route.ts`

#### 4a. Updated `onAnalysisStart` — pass `promptType` in SSE event

```typescript
onAnalysisStart: (provider, prompt, promptIndex, totalPrompts, pillar, promptType) => {
  sendEvent({
    type: "prompt-generated",
    data: { prompt, index: promptIndex, total: totalPrompts, pillar, promptType },
  });
},
```

#### 4b. Updated `complete` SSE event — include 3 new score fields

When building `CitationCheckResult` to pass into the `complete` event, destructure the 3 new fields from `runCitationCheck` and include them in `scores`:

```typescript
const {
  responses, providerResults, overallVisibility, sentimentScore, avgPosition,
  bestProvider, worstProvider, competitorVisibility, pillarVisibility,
  indirectVisibility, brandKnowledge, citationQualityScore,   // NEW
} = await runCitationCheck(checkId, siteId, domain, prompts, callbacks);

// ...build CitationCheckResult:
scores: {
  overallVisibility,
  indirectVisibility,   // NEW
  brandKnowledge,       // NEW
  citationQualityScore, // NEW
  bestProvider,
  worstProvider,
  avgPosition,
  sentimentScore,
  competitorVisibility,
  pillarVisibility,
},
```

No other changes to route.ts.

---

## c) Unit Test Plan

### File: `geo/__tests__/citation-prompt-generator.test.ts`

Update existing ES-024 tests for the new `CitationPrompt` shape. Replace all ES-024 test cases.

**Vitest mock setup (same pattern as existing):**

```typescript
const { mockCreate } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  return { mockCreate };
});
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}));
```

**Helper — build 48-item Haiku response:**

```typescript
const PILLAR_IDS = [
  "metadata_freshness","semantic_html","structured_data","entity_definitions",
  "faq_coverage","evidence_statistics","content_structure","author_authority",
  "internal_linking","content_freshness","multi_format","licensing_signals",
  "contact_trust","competitive_positioning","offering_clarity","cta_structure",
];

function mockHaiku48(domain: string): CitationPrompt[] {
  const indirect: CitationPrompt[] = PILLAR_IDS.flatMap(pillar => [
    { type: "indirect", pillar, prompt: `Best tools for ${pillar} optimization?` },
    { type: "indirect", pillar, prompt: `Which companies lead in ${pillar}?` },
    { type: "indirect", pillar, prompt: `How to evaluate ${pillar} for SaaS?` },
  ]);
  const direct: CitationPrompt[] = [
    { type: "direct", pillar: null, prompt: `What is ${domain} and what does it offer?` },
    { type: "direct", pillar: null, prompt: `How does ${domain} compare to alternatives?` },
    { type: "direct", pillar: null, prompt: `Is ${domain} trustworthy?` },
    { type: "direct", pillar: null, prompt: `What are the main features of ${domain}?` },
    { type: "direct", pillar: null, prompt: `Is ${domain} recommended for SaaS?` },
    { type: "direct", pillar: null, prompt: `What do users say about ${domain}?` },
    { type: "direct", pillar: null, prompt: `Who should use ${domain}?` },
    { type: "direct", pillar: null, prompt: `How does ${domain} stay current with AI changes?` },
  ];
  return [...indirect, ...direct];
}

function setHaikuResponse(items: CitationPrompt[]) {
  mockCreate.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify(items) }],
  });
}
```

**Test cases:**

| ID | Name | Setup | Expected |
|----|------|-------|----------|
| PG-1 | Returns CitationPrompt[] with correct shape | mockHaiku48(domain) | Every item has `type`, `pillar`, `prompt` |
| PG-2 | Indirect prompts have no domain name | mockHaiku48("flowblinq.com") | All items where `type === "indirect"` have no "flowblinq" in `prompt` |
| PG-3 | Direct prompts contain domain name | mockHaiku48("flowblinq.com") | All items where `type === "direct"` contain "flowblinq.com" in `prompt` |
| PG-4 | All 16 pillar IDs represented in indirect | mockHaiku48(domain) | `new Set(result.filter(p=>p.type==="indirect").map(p=>p.pillar)).size === 16` |
| PG-5 | Domain filter strips leaking indirect prompts | Haiku returns indirect prompt containing "flowblinq" | Stripped from result; console.warn called; direct prompts kept |
| PG-6 | Domain stem filter works (no TLD) | Indirect prompt contains "flowblinq" (not "flowblinq.com") | Still stripped |
| PG-7 | Fallback returns CitationPrompt[] shape | `mockCreate.mockRejectedValue(new Error("api fail"))` | 4 prompts with `{ type, pillar, prompt }`; 2 indirect, 2 direct |
| PG-8 | Fallback on missing API key | `delete process.env.ANTHROPIC_API_KEY` | Returns 4 fallback prompts; `mockCreate` not called |
| PG-9 | Fallback on count < 20 (malformed) | Haiku returns 5-item array | Returns 4 fallback prompts; does not throw |
| PG-10 | Fallback prompts substitute {domain} | PG-7 or PG-8 scenario | No `{domain}` literal in any returned prompt; domain present in direct prompts |
| PG-11 | pillar is null for direct prompts in fallback | PG-7 scenario | `fallback.filter(p=>p.type==="direct").every(p=>p.pillar===null)` |

**Coverage target:** 100% branches of `generatePrompts`, `filterIndirectDomainLeaks`, `buildFallback`.

---

### File: `geo/__tests__/citation-checker.test.ts`

Extend with new test cases for TS-027 additions.

**Mock prompt sets:**

```typescript
const INDIRECT_PROMPTS: CitationPrompt[] = [
  { type: "indirect", pillar: "faq_coverage",    prompt: "Common questions about GEO tools?" },
  { type: "indirect", pillar: "faq_coverage",    prompt: "What do buyers ask before choosing GEO software?" },
  { type: "indirect", pillar: "author_authority", prompt: "Who are the experts in AI search optimization?" },
];
const DIRECT_PROMPTS: CitationPrompt[] = [
  { type: "direct", pillar: null, prompt: "What is testsite.com?" },
  { type: "direct", pillar: null, prompt: "Is testsite.com trustworthy?" },
];
const MIXED_PROMPTS = [...INDIRECT_PROMPTS, ...DIRECT_PROMPTS];
```

**Test cases:**

| ID | Name | Setup | Expected |
|----|------|-------|----------|
| CC-7 | indirectVisibility counts only indirect responses | 3 indirect (2 mentioned) + 2 direct (2 mentioned) | `indirectVisibility === 67` (2/3 × 100) |
| CC-8 | brandKnowledge counts only direct responses | Same setup | `brandKnowledge === 100` (2/2 × 100) |
| CC-9 | pillarVisibility only uses indirect responses | 2 indirect for "faq_coverage" (1 mentioned); 2 direct (both mentioned) | `pillarVisibility["faq_coverage"] === 50`; no "null" key |
| CC-10 | citationQualityScore — position=1, positive, alone = 100 | 1 mention: position=1, positive, no competitors | `citationQualityScore === 100` (all 4 signals max) |
| CC-11 | citationQualityScore — position=2, neutral, tier-1 competitor = 77 | position=2→80, neutral→50, tier-1 comp→80, context→100; avg = 77.5 → `Math.round` = 78 | `citationQualityScore === 78` |
| CC-12 | citationQualityScore = 0 when no positive mentions | All responses have `mentioned: false` | `citationQualityScore === 0` |
| CC-13 | tier1Competitors built from top-5 frequency | 6 competitors in responses; top-5 counted | tier1 has exactly 5 entries; 6th is not in tier1 |
| CC-14 | Direct queries with null pillar don't appear in pillarVisibility | MIXED_PROMPTS; direct queries mentioned | `pillarVisibility` has no key with value "null" or undefined |

---

## d) Integration Test Plan

**File:** `geo/__tests__/citation-check-flow.test.ts`

Update existing CF-1..CF-5 from ES-024 to handle `CitationPrompt[]` input. Add new scenarios:

| ID | Name | Setup | Expected |
|----|------|-------|----------|
| CF-1 | complete event contains all 3 new scores | Full 48-prompt mock run; indirect prompts get mentioned | `scores.indirectVisibility`, `brandKnowledge`, `citationQualityScore` all present in `complete` event |
| CF-2 | `prompt-generated` events include `promptType` | Full run | Every `prompt-generated` event has `promptType: "indirect" \| "direct"` |
| CF-3 | `pillar` is null for direct prompts in SSE | Full run with direct prompts | `prompt-generated` events for direct prompts have `pillar: null` |
| CF-4 | Fallback flow sends CitationPrompt[] to providers | Haiku fails | `prompt-generated` events have `{ type, pillar, prompt }` shape; check completes without error |
| CF-5 | 402 / 422 gates unchanged | `creditBalance=0` or `geoScorecard=null` | HTTP 402 / 422 respectively |

---

## e) Profiling Requirements

Same targets as ES-024. No new performance requirements introduced by TS-027.

| Metric | Target |
|--------|--------|
| `generatePrompts` (Haiku call + filter) | < 5s (p95) |
| Total wall time (4 providers, 48 prompts) | < 30s |

Log the indirect/direct split count in `[citation-prompts]` log line (see §2g) to monitor domain filter effectiveness.

---

## f) Load Test

No change from ES-024. Citation checks are low-concurrency, user-initiated.

---

## g) Logging & Instrumentation

### `citation-prompt-generator.ts` — updated log on success

```typescript
console.info(
  `[citation-prompts] ${site.domain}: Haiku generated ${filtered.length} prompts in ${elapsed}ms` +
  ` (${filtered.filter(p => p.type === "indirect").length} indirect, ${filtered.filter(p => p.type === "direct").length} direct)`
);
```

### `citation-prompt-generator.ts` — per filtered item

```typescript
console.warn(`[citation-prompts] stripped indirect prompt leaking domain: "${p.prompt}"`);
```

### `citation-checker.ts` — updated summary log

```typescript
console.info(
  `[citation-check] ${domain}: ${allResponses.length} calls, ${totalMentioned} mentions` +
  ` | indirect=${indirectVisibility}% brand=${brandKnowledge}% quality=${citationQualityScore}`
);
```

---

## h) Acceptance Criteria

Derived from TS-027. ReviewMaster must verify all:

- [ ] **AC-1:** `generatePrompts()` returns `CitationPrompt[]` where every item has `{ type: "indirect"|"direct", pillar: string|null, prompt: string }`. TypeScript infers this correctly from the exported type.
- [ ] **AC-2:** No indirect prompt in the returned array contains the domain name or domain stem (case-insensitive). Direct prompts all contain the domain name.
- [ ] **AC-3:** All 16 pillar IDs from `GEO_PILLARS` are represented in indirect queries (minimum 2 per pillar) in the Haiku-generated output.
- [ ] **AC-4:** `citationQualityScore` is the arithmetic mean of per-mention scores, where each mention score = `(positionSignal + sentimentSignal + coPresenceSignal + 100) / 4`. Signals: position 1→100, 2→80, 3→60, 4→40, ≥5/null→20; sentiment positive→100, neutral→50, negative→0; co-presence alone→100, with tier-1→80, with other→40.
- [ ] **AC-5:** `indirectVisibility` and `brandKnowledge` are present in the SSE `complete` event's `scores` object.
- [ ] **AC-6:** `pillarVisibility` is computed from indirect responses only. Direct responses with `pillar: null` do not contribute to any pillar bucket.
- [ ] **AC-7:** Legacy fallback returns exactly 4 prompts in `CitationPrompt[]` shape: 2 indirect (with pillar tags) + 2 direct (with `pillar: null`). No `{domain}` or `{year}` placeholders in returned prompts.
- [ ] **AC-8:** No DB migration required. No new database columns. All 3 new scores flow via SSE `complete` event only.
- [ ] **AC-9:** TypeScript compiles without errors on all 4 changed files. No `any` casts introduced for new fields.
- [ ] **AC-10:** Unit tests PG-1..PG-11 all pass.
- [ ] **AC-11:** Unit tests CC-7..CC-14 all pass.
- [ ] **AC-12:** Integration tests CF-1..CF-5 all pass.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Haiku generates indirect prompts containing domain name | Post-generation domain filter (§2d) strips them. Logged as warnings. |
| Haiku returns <20 items after filter (very aggressive stripping) | Validation floor of 20; triggers fallback. Acceptable — aggressive filtering means low-quality Haiku output. |
| `citationQualityScore` = 0 for low-awareness domains | Valid and correct — means no positive mentions. Do not inflate. |
| Route's `onAnalysisStart` signature must match updated `CitationCheckerCallbacks` | Both files updated in same PR. TS compile check catches mismatch. |
| Existing ES-024 tests use `string[]` prompts | Replace with `CitationPrompt[]` in all test fixtures. |
