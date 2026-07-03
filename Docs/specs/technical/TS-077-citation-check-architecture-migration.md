# TS-077 — Citation Check Architecture Migration (Preemptive Tool Injection + OpenRouter Gateway + Brave Search + Prompt Caching)

**Author:** CoFounder (Agent 1)
**Date:** 2026-04-07
**Priority:** P0 — blocks pricing (TS-079)
**Scope:** GEO app (citation-checker.ts + adjacent services)
**Depends on:** Verification pass from `verify-preemptive-injection-test-plan.md`
**Supersedes:** TS-076 pricing overhaul (whose assumptions are invalidated by this work)

---

## 1. What

Replace the current `citation-checker.ts` implementation — which uses each LLM provider's native in-LLM `web_search` tool — with a unified architecture that:

1. Routes **all** LLM calls through a single OpenRouter gateway, collapsing four direct SDK integrations (OpenAI, Anthropic, Google, Perplexity) into one.
2. Performs **external search via Brave Search API** once per prompt and injects the results into each measurement LLM call as a fabricated `assistant.tool_call` → `tool_result` message pair (*preemptive tool injection*). This eliminates the multi-turn tool-calling loop on OpenAI/Anthropic/Gemini and gives us deterministic control over the evidence the model sees.
3. Retains **Perplexity Sonar** on its native retrieval path — no preemptive injection, no Brave substitution — because Sonar does not expose a compatible tool-calling surface and because Perplexity's market penetration is the reason we measure it.
4. **Pads system prompts** to meet provider prompt-caching minimums (4,096 tokens for Anthropic Haiku 4.5, 1,024 for OpenAI and Gemini) and tags them with `cache_control: {type: "ephemeral", ttl: "1h"}` on Anthropic so repeat calls hit the 90%-off cache tier.
5. **Refreshes the Anthropic cache hourly** via a scheduled cron endpoint, keeping the 4K-padded prefix warm at a cost of ~$3.60/month.
6. **Migrates auxiliary LLM calls** (`extractTrees`, `extractCategoriesViaHaiku`, `extractBrandKeywords`, `discoverRealPrompts`, `generatePromptsV2`, `rephraseSeeds`, `analyzeEnginePreferences`) off direct Anthropic/Perplexity and onto OpenRouter routed at open-weight Llama 3.3 70B (via Fireworks or Together), with automatic provider fallback.
7. **Fixes the prompt determinism bug** in `citation-prompt-generator.ts:1225` where `rephraseSeeds` calls Haiku with `temperature: 0.7`, which makes subsequent response caching (TS-078) impossible. Change to `temperature: 0`.

The outcome is a single, uniformly-instrumented LLM gateway with measurable per-check cost in the **$0.90–$1.06 range** (warm path, with caching active), compared to today's $2.55–$4.86 using in-LLM native tools.

## 2. Why

### 2.1 The unit economics today are negative

Per the cost audit in `geo/docs/citation-check-cost-audit.tex`:

- Current cost per citation check using in-LLM native tools: **$2.55 (conservative) to $4.86 (aggressive)**
- Real customer revenue per 5-credit check (drawn from the subscription credit pool at $0.0173–$0.10/credit): **$0.087 to $0.500**
- Margin: **catastrophically negative** at every tier — ranging from -5× at Pro to -55× at the credit-pack tier

No pricing adjustment can fix this without first fixing the cost structure.

### 2.2 The architecture is over-fitted to the in-LLM tool pattern

Today's `citation-checker.ts` relies on each provider implementing an expensive, per-provider `web_search` tool:

- OpenAI `web_search`: ~$10/1k invocations + 8K search-content tokens each, no cap
- Anthropic `web_search_20250305`: ~$10/1k invocations, `max_uses: 2` cap
- Google grounding: free up to 1,500/day then **$35/1k** (cliff economics)
- Perplexity Sonar: native retrieval at ~$5/1k requests

A 44-prompt run × 4 providers × multi-turn tool calling rounds up to 176+ billable LLM calls plus 88+ billable search operations, all at retail provider prices. This is the most expensive possible implementation of the workload.

### 2.3 Four separate SDK integrations are ops debt

Today the code maintains:
- `openai` SDK + `OPENAI_API_KEY` rotation + OpenAI billing
- `@anthropic-ai/sdk` + `ANTHROPIC_API_KEY` rotation + Anthropic billing
- Direct Gemini HTTP calls + `GEMINI_API_KEY` rotation + Google Cloud billing
- Perplexity via the OpenAI client with custom base URL + `PERPLEXITY_API_KEY` + Perplexity billing
- Fallback logic for when any one provider has an outage, duplicated per provider
- Cost accounting logic per provider, each with a different usage schema

OpenRouter collapses this to one SDK (the standard `openai` client), one credential, one bill, one dashboard, and one usage schema — at a ~5.5% markup that is dwarfed by the architectural simplification.

### 2.4 Prompt caching is left on the table

Our current system prompt is ~250 tokens. All four provider prompt-cache mechanisms have minimums:

- OpenAI: 1,024 tokens (automatic)
- Anthropic Sonnet: 1,024 tokens (explicit marker)
- **Anthropic Haiku 4.5: 4,096 tokens** (explicit marker)
- Gemini 2.5 Flash: 1,024 tokens (explicit resource)

Because our prefix is below every minimum, we currently get **zero caching benefit**. Padding the system prompt with load-bearing content (few-shot examples, sentiment rubric, output schema) to 4,096 tokens unlocks Anthropic's 90%-off cache tier, which saves ~$0.13 per check on the Anthropic leg alone.

### 2.5 OpenRouter solves routing and fallback without custom code

OpenRouter exposes all four target providers plus the open-weight models we want for auxiliary calls via a single OpenAI-compatible endpoint. For measurement calls we pin providers (`provider.order: ["Anthropic"], allow_fallbacks: false`) to preserve the integrity of "this is what Claude said". For auxiliary calls we enable fallbacks so a single provider outage doesn't break the whole pipeline.

## 3. Scope

### 3.1 In scope

- New file: `lib/services/llm-gateway.ts` — OpenRouter client with two entry points, `measurementCall()` and `auxiliaryCall()`, plus cost accounting hooks
- New file: `lib/services/brave-search.ts` — thin wrapper for the Brave Search API
- Refactor: `lib/services/citation-checker.ts` — replace the 4 provider-specific query functions with gateway calls and preemptive injection
- Refactor: `lib/services/tree-extractor.ts` — route its LLM call through `auxiliaryCall()`
- Refactor: `lib/services/real-prompt-discoverer.ts` — route through `auxiliaryCall()`
- Refactor: `lib/services/citation-prompt-generator.ts` — route `rephraseSeeds` and other helpers through `auxiliaryCall()`, fix `temperature: 0.7 → 0` at line 1225
- Refactor: `app/api/sites/[id]/citation-check/route.ts` — no behavioral change, but update `extractTrees`, `extractCategoriesViaHaiku`, `extractBrandKeywords`, `analyzeEnginePreferences` call sites to new gateway
- New: padded 4K system prompts stored in `lib/services/prompts/citation-system-prompt.ts` (one file per provider since each provider has different padding targets)
- New endpoint: `app/api/cron/cache-heartbeat/route.ts` — hourly cron that sends a minimal Anthropic request with the 4K cached prefix to keep the cache entry alive. Vercel Cron schedule `0 * * * *`.
- Env additions: `OPENROUTER_API_KEY`, `BRAVE_API_KEY` (added to `.env.example`, production env via Vercel)
- Cost accounting: gateway logs cost per call to a new `llm_call_log` table (see §6 DDL)
- Migration of `SUBSCRIPTION_TIERS` free allowances in `config.ts` happens in TS-079 — NOT this spec

### 3.2 Out of scope

- **Response caching via Redis** — TS-078 (depends on this spec's `rephraseSeeds` determinism fix)
- **Subscription pricing + Stripe migration** — TS-079 (depends on this spec's measured cost)
- **Audit pipeline (`/api/sites/[id]/regenerate`) cost audit** — TS-080 (independent)
- **Self-hosted vLLM/SGLang deployment** — deferred until volume >1M auxiliary calls/mo
- **Brave Answers API for `discoverRealPrompts`** — deferred; the auxiliary call path in this spec is sufficient, the Brave Answers migration can be a follow-up if Sonar pricing moves against us
- **UI changes** — no dashboard or pricing-page changes. The citation check UX is unchanged; only the engine behind it is swapped.

### 3.3 Non-goals

- Preserving exact byte-identical citation detection output. Acceptable regression: ±10% of current citation-detection accuracy (measured on a 20-site replay set).
- Preserving the existing provider-specific prompt structures. The 4K padded system prompt is new content and will produce stylistically different LLM outputs.
- Matching per-call latency exactly. Acceptable regression: ≤ 10% median latency increase across a 44-prompt batch.

## 4. Dependencies

### 4.1 Upstream

- **Verification pass** from `geo/scripts/verify-preemptive-injection-test-plan.md` — mandatory. Do not start implementation until `verdict.md` reads PASS.
- **Brave Search API key** provisioned in Vercel production env
- **OpenRouter API key** provisioned in Vercel production env, with a $500 initial credit balance
- **Upstash Redis** — already in platform stack, used here only for the heartbeat cron's lock (not for response caching, which is TS-078)

### 4.2 Downstream

- TS-078 (response caching) depends on the `rephraseSeeds` temperature fix in this spec
- TS-079 (pricing migration) depends on the measured cost from this spec's deployment
- TS-080 (audit pipeline audit) benefits from this spec's gateway pattern but does not strictly block on it

## 5. Interfaces

### 5.1 `lib/services/llm-gateway.ts`

```typescript
// Exported types
export type MeasurementProvider = "openai" | "anthropic" | "google" | "perplexity";

export interface MeasurementCallInput {
  provider: MeasurementProvider;       // pinned upstream, no fallback
  prompt: string;                      // user prompt (e.g., "best dental clinics in Mumbai")
  systemPromptKey: "citation-check";   // selects padded prompt file
  evidence: BraveSearchResult[];       // injected as synthetic tool_result
  maxTokens?: number;                  // defaults to 512
  temperature?: number;                // defaults to 0
}

export interface MeasurementCallOutput {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;           // how many were served from provider cache
  costUsd: number;                     // computed from OpenRouter's usage response
  latencyMs: number;
  upstreamProvider: string;            // what OpenRouter reported as the actual upstream
  modelId: string;                     // e.g., "anthropic/claude-haiku-4-5"
}

export interface AuxiliaryCallInput {
  taskKey: string;                     // for cost attribution, e.g., "tree-extraction"
  prompt: string;
  systemPrompt?: string;
  responseFormat?: "text" | "json";
  jsonSchema?: object;                 // for structured extraction
  maxTokens?: number;                  // defaults to 1024
  temperature?: number;                // defaults to 0
}

// Entry points
export async function measurementCall(input: MeasurementCallInput): Promise<MeasurementCallOutput>;
export async function auxiliaryCall(input: AuxiliaryCallInput): Promise<{
  text: string;
  json?: unknown;
  costUsd: number;
  latencyMs: number;
  modelId: string;
}>;

// Cost tracking
export interface LlmCallLogEntry {
  id: string;
  createdAt: Date;
  siteId?: string;
  taskKey: string;                     // "citation-check.openai" | "auxiliary.tree-extraction" | etc.
  modelId: string;
  upstreamProvider: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  latencyMs: number;
  errorCode?: string;
}
```

### 5.2 Preemptive injection pattern (inside `measurementCall`)

For OpenAI-compatible providers (OpenAI, Anthropic via OpenRouter, Gemini via OpenRouter):

```typescript
const messages = [
  { role: "system", content: PADDED_SYSTEM_PROMPT_FOR_PROVIDER },
  { role: "user",   content: userPrompt },
  {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "call_preemptive_brave_001",
      type: "function",
      function: {
        name: "web_search",
        arguments: JSON.stringify({ query: userPrompt }),
      },
    }],
  },
  {
    role: "tool",
    tool_call_id: "call_preemptive_brave_001",
    content: formatBraveResultsAsToolOutput(evidence),
  },
];

// For Anthropic specifically, add cache_control to the system prompt content block
// This passes through OpenRouter to the upstream
const anthropicSystemBlocks = [
  {
    type: "text",
    text: PADDED_SYSTEM_PROMPT_4K,
    cache_control: { type: "ephemeral", ttl: "1h" },
  },
];
```

For Perplexity Sonar (no preemptive injection — native retrieval path):

```typescript
const messages = [
  { role: "system", content: PADDED_SYSTEM_PROMPT_FOR_SONAR },
  { role: "user",   content: userPrompt },
];
// Sonar handles retrieval internally; we do NOT inject Brave results.
```

### 5.3 `lib/services/brave-search.ts`

```typescript
export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

export async function braveSearch(query: string, opts?: {
  count?: number;      // defaults to 10
  country?: string;    // defaults to "in" if siteLocale is IN
  safesearch?: "strict" | "moderate" | "off";  // defaults to "moderate"
}): Promise<BraveSearchResult[]>;
```

Thin wrapper, directly calls `https://api.search.brave.com/res/v1/web/search`. No caching in this file — caching is TS-078's scope.

### 5.4 `citation-checker.ts` refactor

The four query functions (`queryOpenAI`, `queryAnthropic`, `queryPerplexity`, `queryGoogle`) collapse to a single helper:

```typescript
async function runProviderCheck(
  provider: MeasurementProvider,
  prompt: string,
  evidence: BraveSearchResult[],
): Promise<ProviderResponse> {
  const result = await measurementCall({
    provider,
    prompt,
    systemPromptKey: "citation-check",
    evidence,
  });
  return parseProviderResponse(result.text, provider);
}

// Top-level orchestration (inside runCitationCheck):
for (const prompt of prompts) {
  // Brave search ONCE per prompt, shared across all 3 injection-compatible providers
  const evidence = await braveSearch(prompt, { count: 10, country: siteLocale });
  const [openaiResult, anthropicResult, googleResult, perplexityResult] = await Promise.allSettled([
    runProviderCheck("openai", prompt, evidence),
    runProviderCheck("anthropic", prompt, evidence),
    runProviderCheck("google", prompt, evidence),
    runProviderCheck("perplexity", prompt, []),  // Sonar ignores evidence arg
  ]);
  // ... existing aggregation logic unchanged
}
```

Key property: **Brave is called once per prompt, shared across three providers**. That's 44 Brave calls per run, not 132. At $5/1k Brave calls that is 44 × $0.005 = $0.22 per run for search, irrespective of how many LLMs consume it.

### 5.5 Cache heartbeat cron

```typescript
// app/api/cron/cache-heartbeat/route.ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  // Auth: check CRON_SECRET matches the Vercel cron header
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Fire one minimal Anthropic call that hits the cached 4K prefix
  // Cost: ~$0.005 per call × 24 calls/day × 30 days = ~$3.60/mo
  try {
    const result = await measurementCall({
      provider: "anthropic",
      prompt: "ping",
      systemPromptKey: "citation-check",
      evidence: [],
      maxTokens: 1,
    });
    console.info("[cache-heartbeat] ok", {
      cachedTokens: result.cachedInputTokens,
      cost: result.costUsd,
    });
    return Response.json({ status: "ok", cachedTokens: result.cachedInputTokens });
  } catch (err) {
    console.error("[cache-heartbeat] failed", err);
    return Response.json({ status: "error", error: String(err) }, { status: 500 });
  }
}
```

Vercel cron config in `vercel.json`:
```json
{
  "crons": [
    { "path": "/api/cron/cache-heartbeat", "schedule": "0 * * * *" }
  ]
}
```

## 6. Data model changes

One new table for cost accounting:

```sql
-- Migration: T224-llm-call-log
CREATE TABLE llm_call_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  site_id       uuid REFERENCES sites(id) ON DELETE SET NULL,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  task_key      text NOT NULL,             -- "citation-check.openai" etc
  model_id      text NOT NULL,             -- "anthropic/claude-haiku-4-5"
  upstream      text NOT NULL,             -- "Anthropic" per OpenRouter
  input_tokens  integer NOT NULL,
  cached_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL,
  cost_usd      numeric(12, 8) NOT NULL,
  latency_ms    integer NOT NULL,
  error_code    text
);

CREATE INDEX idx_llm_call_log_site_created ON llm_call_log (site_id, created_at DESC);
CREATE INDEX idx_llm_call_log_task_created ON llm_call_log (task_key, created_at DESC);
CREATE INDEX idx_llm_call_log_created     ON llm_call_log (created_at DESC);
```

No changes to `sites`, `users`, `credits`, or `subscription_tiers`. All cost accounting is additive.

## 7. Configuration changes

### 7.1 Env vars

```
OPENROUTER_API_KEY=sk-or-v1-...            # new
BRAVE_API_KEY=BSA...                        # new
CRON_SECRET=...                             # new (for cache-heartbeat auth)

# These can be removed after migration completes and cleanup lands:
# ANTHROPIC_API_KEY   (still needed during rollout as direct fallback)
# OPENAI_API_KEY      (ditto)
# GEMINI_API_KEY      (ditto)
# PERPLEXITY_API_KEY  (ditto)
```

### 7.2 `lib/config.ts`

No change in this spec. The `SUBSCRIPTION_TIERS` credit allocations and the `ACTION_CREDITS.shareOfVoice = 5` constant stay as-is until TS-079 rewrites them.

### 7.3 Model selection constants (new file `lib/services/llm-gateway-config.ts`)

```typescript
export const MEASUREMENT_MODELS: Record<MeasurementProvider, string> = {
  openai:     "openai/gpt-5.4-mini",
  anthropic:  "anthropic/claude-haiku-4-5",
  google:     "google/gemini-2.5-flash",
  perplexity: "perplexity/sonar",
};

export const AUXILIARY_MODEL_ORDER = [
  "meta-llama/llama-3.3-70b-instruct:nitro",      // Fireworks, fast
  "meta-llama/llama-3.3-70b-instruct",             // Together fallback
  "anthropic/claude-haiku-4-5",                    // final fallback to paid provider
];

export const MODEL_PRICING = {
  // Used for verification and audit; real cost comes from OpenRouter's response
  "openai/gpt-5.4-mini":                 { inputPerM: 0.75, outputPerM: 4.50 },
  "anthropic/claude-haiku-4-5":          { inputPerM: 0.80, outputPerM: 4.00, cachedInputPerM: 0.08 },
  "google/gemini-2.5-flash":             { inputPerM: 0.30, outputPerM: 2.50 },
  "perplexity/sonar":                    { inputPerM: 1.00, outputPerM: 1.00, perRequest: 0.005 },
  "meta-llama/llama-3.3-70b-instruct":   { inputPerM: 0.88, outputPerM: 0.88 },
} as const;
```

### 7.4 Padded system prompts

New directory: `lib/services/prompts/`

- `citation-system-prompt-openai.ts` — 1,024 tokens, includes original 250-token prompt + 774 tokens of few-shot examples + output schema
- `citation-system-prompt-anthropic.ts` — 4,096 tokens, includes original + 3,846 tokens of few-shot examples, sentiment rubric, entity extraction instructions, brand-disambiguation rules. This is the heaviest file and carries the most load-bearing content.
- `citation-system-prompt-google.ts` — 1,024 tokens
- `citation-system-prompt-perplexity.ts` — 1,024 tokens (Sonar does not cache, but keeping the prompts aligned makes parsing uniform)

All four must produce behaviorally equivalent outputs — see §9 acceptance criteria.

## 8. Rollout plan

### 8.1 Phase 1 — Gateway + single-provider cutover (OpenAI only)

1. Ship `llm-gateway.ts`, `brave-search.ts`, padded OpenAI system prompt, `llm_call_log` DDL
2. Wire `citation-checker.ts` to use the gateway **only for OpenAI**; the other three providers still call their direct SDKs. This keeps the blast radius small.
3. Behind a `CITATION_CHECK_USE_GATEWAY` feature flag (env var, default `false` in production).
4. Shadow-test in staging: flip flag on for a single test site, run 10 citation checks, compare OpenAI leg outputs byte-for-byte against the old path.
5. Acceptance: ≥ 90% of citation mentions match between old and new OpenAI path; cost per OpenAI call within ±20% of analytical target.
6. Flip flag on in production for OpenAI only. Monitor `llm_call_log` for anomalies over 48 hours.

### 8.2 Phase 2 — Remaining providers (Anthropic, Google)

1. Add Anthropic and Google support in the gateway + padded prompts for each
2. Add `cache_control` markers on Anthropic, deploy heartbeat cron
3. Shadow-test in staging; compare outputs as in Phase 1
4. Flip flag on in production for Anthropic + Google
5. Monitor cache hit rates (`cached_tokens` column in `llm_call_log`) — expect ≥ 80% hit rate within 2 hours of the heartbeat cron running

### 8.3 Phase 3 — Perplexity and auxiliary calls

1. Add Perplexity Sonar routing via OpenRouter (no preemptive injection, direct pass-through)
2. Migrate `extractTrees`, `extractCategoriesViaHaiku`, `extractBrandKeywords`, `discoverRealPrompts`, `generatePromptsV2`, `rephraseSeeds`, `analyzeEnginePreferences` to `auxiliaryCall()`
3. Apply `temperature: 0` fix to `rephraseSeeds` at `citation-prompt-generator.ts:1225` (unblocks TS-078)
4. Shadow-test: compare aggregate citation-check outputs across 20 replay sites. Require ≥ 90% citation detection parity.
5. Flip flag on for the full pipeline
6. Remove the old direct-SDK code paths and feature flag after 7 days of stable operation

### 8.4 Phase 4 — Cleanup

1. Delete direct SDK imports from `citation-checker.ts`, `tree-extractor.ts`, `citation-prompt-generator.ts`, `real-prompt-discoverer.ts`
2. Remove `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY` from the env — keep them commented in `.env.example` with a note referencing this spec
3. Document the gateway as the single entry point for all LLM calls in `lib/services/README.md`
4. Update `BUSINESS_LOGIC.md` with the new cost numbers

## 9. Acceptance criteria

### 9.1 Functional

- ✅ All existing citation-check tests pass (unit + integration, including the Sprint-30 through Sprint-33 dimensional intelligence tests)
- ✅ On a 20-site replay suite, citation detection counts are within ±10% of the pre-migration baseline
- ✅ Cache heartbeat cron runs on schedule; `cached_tokens` in `llm_call_log` is > 0 for ≥ 80% of Anthropic calls measured in the hour after a heartbeat run
- ✅ `temperature: 0` fix in `rephraseSeeds` produces deterministic output (sha256 hash stable across 5 consecutive runs of the same seed)

### 9.2 Economic

- ✅ Median per-check cost (from `llm_call_log` sum per check) ≤ $1.20 **before** caching activates
- ✅ Median per-check cost ≤ $0.95 **after** caching activates (measured 48h after heartbeat cron is running)
- ✅ Cache hit rate on Anthropic calls ≥ 80% for non-first-of-hour calls
- ✅ No cost regression on Perplexity leg (expect unchanged since it bypasses injection)

### 9.3 Operational

- ✅ Zero citation checks fail because of OpenRouter-layer errors (provider outages should degrade via `allow_fallbacks: true` for auxiliary only; measurement provider outages are surfaced as 500s to the caller, same as today)
- ✅ P95 latency per 44-prompt citation check ≤ 110% of pre-migration baseline
- ✅ Heartbeat cron costs ≤ $5/month
- ✅ OpenRouter total monthly bill ≤ 1.08× the sum of what the four direct provider bills would have been (5.5% markup + noise)

## 10. Risks

### 10.1 Verification script uncovers architecture-level failure

**Risk:** Preemptive injection turns out to not work — either OpenAI rejects the synthetic tool_call shape (H1 in the test plan) or the model ignores the injected evidence and falls back to training data (H2).

**Likelihood:** Low for H1 (the shape is a documented OpenAI feature). Medium for H2 (known failure mode with some models).

**Mitigation:** Run the verification script first. If H2 fails, the test plan prescribes three remediations (stronger grounding language, `temperature: 0`, try Anthropic Haiku instead of OpenAI for the verification). If all three fail, this spec is rejected and we fall back to the "in-LLM native tools + aggressive caching only" architecture.

### 10.2 OpenRouter as a single point of failure

**Risk:** OpenRouter has an outage and all measurement calls fail simultaneously.

**Likelihood:** OpenRouter's published SLA is 99.9%. In 2025 they had two publicly-acknowledged incidents totaling ~90 minutes. Low but nonzero.

**Mitigation:**
1. Keep direct provider SDKs + keys warm but unused during Phase 4 cleanup (delay env-var removal by 30 days post-flip).
2. Gateway exposes an `OPENROUTER_FALLBACK_DIRECT` env flag that, when set to `true`, routes measurement calls through the original direct-SDK path. This is a break-glass toggle, not a normal code path.
3. Monitor OpenRouter status page and alert on Slack via existing `ops` channel webhook.

### 10.3 Cache markers not honored through OpenRouter

**Risk:** OpenRouter is an HTTP proxy; it may not correctly forward Anthropic's `cache_control` markers to the upstream.

**Likelihood:** Low — OpenRouter explicitly documents cache_control passthrough — but worth verifying in staging.

**Mitigation:** Phase 2 of the rollout includes a cache-hit verification step. If `cached_tokens` remains 0 after deploying padded prompts and the heartbeat cron, call Anthropic directly for the measurement leg (bypassing OpenRouter) and compare.

### 10.4 Padded prompts change the model's stylistic output

**Risk:** Going from a 250-token system prompt to a 4,096-token one changes the tone, length, or structure of the model's responses, breaking downstream parsers in `aggregateByDimension`, `parseProviderResponse`, etc.

**Likelihood:** Medium. The verification script uses the *current* 250-token prompt and cannot catch this.

**Mitigation:**
1. Shadow-test with the padded prompt against the 20-site replay suite before flipping the flag.
2. Preserve the output schema section of the system prompt as the final block, with explicit "OUTPUT FORMAT:" heading, so the model's priority stays on structured output.
3. Include 5–10 few-shot examples of correctly-formatted citation responses in the padded content — these do double duty as cache padding AND as behavioral anchors.

### 10.5 `rephraseSeeds` determinism fix changes prompt outputs

**Risk:** Changing `temperature: 0.7 → 0` in `citation-prompt-generator.ts:1225` changes which prompts are generated, which in turn changes citation results.

**Likelihood:** Medium — this is a real behavioral change.

**Mitigation:** Bundle the fix with the shadow-test phase. If the replay suite shows prompt drift > 20%, consider keeping `temperature: 0.7` and making TS-078 response caching fuzzy (hash-set cache keys instead of exact match).

### 10.6 Brave Search latency degrades

**Risk:** Brave's 1 req/sec free-tier rate limit slows down a 44-prompt run significantly.

**Likelihood:** Certain on the free tier. Low on a paid tier ($5/mo for 20 req/sec).

**Mitigation:** Provision a paid Brave tier before Phase 1 deployment. Budget: $5/mo flat for the foreseeable future; migrate to pay-per-use if volume demands.

## 11. Open questions for Aditya

1. **OpenRouter credit float:** How much should we pre-fund the OpenRouter account? Recommendation: $500 initial, auto-top-up at $100 balance. Confirm.
2. **Padded prompt content ownership:** Who writes the 3,800+ tokens of load-bearing content for the Anthropic system prompt? CoFounder drafts, ScriptDev reviews? Or do you want to write it directly?
3. **Rollout cadence:** Ship Phases 1 + 2 + 3 in one sprint (aggressive) or stretch across two sprints (safer)? Default: one sprint, with gating at each phase.
4. **Direct provider keys retention period:** 30 days post-flip, or longer? Default: 30 days, then removal.
5. **Gateway observability:** Route `llm_call_log` writes to Postgres only, or also ship to an external log aggregator (Datadog, Axiom)? Default: Postgres only for v1, add external aggregator if audit complexity demands it.

## 12. Effort estimate

Not estimated at this stage. CostMaster will produce a taskboard breakdown after this spec is accepted.

## 13. References

- `geo/docs/citation-check-cost-audit.tex` — full cost audit, session transcript, analytical estimates
- `geo/scripts/verify-preemptive-injection.ts` — verification script
- `geo/scripts/verify-preemptive-injection-test-plan.md` — verification test plan (must pass before implementation starts)
- `geo/lib/services/citation-checker.ts` — current implementation (being replaced)
- `geo/lib/services/citation-prompt-generator.ts:1225` — the `rephraseSeeds` temperature bug
- `geo/lib/services/real-prompt-discoverer.ts` — auxiliary call site that moves to gateway
- OpenRouter docs: https://openrouter.ai/docs
- Brave Search API docs: https://api-dashboard.search.brave.com/app/documentation/web-search/get-started
- Anthropic prompt caching: https://docs.claude.com/en/docs/build-with-claude/prompt-caching
