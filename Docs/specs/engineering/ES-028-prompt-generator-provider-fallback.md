# ES-028 — Prompt Generator Provider Fallback

**Date:** 2026-03-04
**Priority:** P1
**Technical Spec:** TS-028-prompt-generator-provider-fallback.md
**Baseline:** ES-027 implementation (commit `b474366`) — `CitationPrompt` type and `generatePrompts()` in place
**Status:** READY — dispatch to ReviewMaster

---

## a) Overview

Single-file change to `lib/services/citation-prompt-generator.ts`. After a Haiku failure, try OpenAI → Google → Perplexity in order before degrading to the 4 static legacy prompts. Uses the identical `SYSTEM_PROMPT`, `isValidCitationPromptArray()`, and `filterIndirectDomainLeaks()` on every provider attempt. `generatePrompts()` signature and return type are unchanged.

### Current state (ES-027 baseline)

`generatePrompts()` tries Haiku; on any failure immediately returns `buildFallback(domain)` (4 static prompts). Other provider clients (OpenAI, Google, Perplexity) are available as dependencies but not used here.

### What changes

| What | Before | After |
|------|--------|-------|
| Haiku fails | Return 4 legacy prompts | Try OpenAI → Google → Perplexity in order |
| All providers fail | n/a | Return 4 legacy prompts |
| Static 4-prompt fallback triggered | On any Haiku failure | Only when ALL configured providers fail |
| `generatePrompts()` signature | unchanged | unchanged |

---

## b) Implementation Requirements

### File: `geo/lib/services/citation-prompt-generator.ts`

No other files change.

#### b1. New imports

Add at the top of the file alongside the existing `Anthropic` import:

```typescript
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
```

Both packages are already dependencies (used in `citation-checker.ts`).

#### b2. Timeout constant

Add a module-level constant (after imports):

```typescript
const PROMPT_GEN_TIMEOUT_MS = 30_000;
```

#### b3. `tryProvider` internal helper

Add this function. It encapsulates one provider attempt: call, extract text, strip code fences, parse, validate, filter. Returns `CitationPrompt[]` on success, `null` on any failure.

```typescript
async function tryProvider(
  name: string,
  fn: () => Promise<string>,
  domain: string,
  userPrompt: string
): Promise<CitationPrompt[] | null> {
  const t0 = Date.now();
  try {
    const raw = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), PROMPT_GEN_TIMEOUT_MS)
      ),
    ]);
    const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(text) as unknown;
    if (!isValidCitationPromptArray(parsed)) {
      throw new Error(
        `validation failed: got ${Array.isArray(parsed) ? parsed.length : "non-array"}`
      );
    }
    const filtered = filterIndirectDomainLeaks(parsed as CitationPrompt[], domain);
    const elapsed = Date.now() - t0;
    console.info(
      `[citation-prompts] ${domain}: ${name} succeeded — ${filtered.length} prompts in ${elapsed}ms`
    );
    return filtered;
  } catch (err) {
    return null; // caller logs the failure
  }
}
```

Note: The `userPrompt` parameter is included in the signature so the caller can close over it when building the provider `fn`. It is not used inside `tryProvider` directly — the provider `fn` closes over it. This keeps `tryProvider` stateless and independently testable.

**Revised signature without unused param:**

```typescript
async function tryProvider(
  name: string,
  fn: () => Promise<string>,
  domain: string
): Promise<CitationPrompt[] | null>
```

The `fn` closure captures `userPrompt` from the outer scope.

#### b4. Provider function builders

Define these as inline async lambdas within `generatePrompts()` (after `buildUserPrompt` is called), so they close over `userPrompt` and `SYSTEM_PROMPT` naturally:

**OpenAI** (`gpt-4o-mini`):

```typescript
const openAiFn = async (): Promise<string> => {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 2000,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: userPrompt },
    ],
  });
  return res.choices[0]?.message?.content ?? "";
};
```

**Google** (`gemini-2.5-flash-lite`):

```typescript
const googleFn = async (): Promise<string> => {
  const client = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY!);
  const model = client.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
  const res = await model.generateContent(`${SYSTEM_PROMPT}\n\n${userPrompt}`);
  return res.response.text();
};
```

Note: Google's SDK does not accept a separate `system` parameter in `generateContent()`, so prepend `SYSTEM_PROMPT` to the user prompt content.

**Perplexity** (`sonar`):

```typescript
const perplexityFn = async (): Promise<string> => {
  const client = new OpenAI({
    apiKey: process.env.PERPLEXITY_API_KEY,
    baseURL: "https://api.perplexity.ai",
  });
  const res = await client.chat.completions.create({
    model: "sonar",
    max_tokens: 2000,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: userPrompt },
    ],
  });
  return res.choices[0]?.message?.content ?? "";
};
```

#### b5. Fallback provider table

Define after the inline `fn` lambdas:

```typescript
const FALLBACK_PROVIDERS: Array<{
  name: string;
  envKey: string;
  fn: () => Promise<string>;
}> = [
  { name: "openai",     envKey: "OPENAI_API_KEY",                fn: openAiFn },
  { name: "google",     envKey: "GOOGLE_GENERATIVE_AI_API_KEY",  fn: googleFn },
  { name: "perplexity", envKey: "PERPLEXITY_API_KEY",            fn: perplexityFn },
];
```

#### b6. Updated `generatePrompts()` body

Replace the current try/catch block with the following structure. `generatePrompts()` signature stays identical:

```typescript
export async function generatePrompts(
  site: Pick<GeoSite, "domain" | "siteType" | "geoScorecard" | "executiveSummary">
): Promise<CitationPrompt[]> {
  const domain = site.domain;

  // Step 1: Skip all LLM calls if no providers configured at all
  const hasAnyKey =
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.PERPLEXITY_API_KEY;

  if (!hasAnyKey) {
    return buildFallback(domain);
  }

  const t0 = Date.now();
  const userPrompt = buildUserPrompt(site);
  const attempted: string[] = [];

  // Step 2: Try Haiku first (existing primary)
  if (process.env.ANTHROPIC_API_KEY) {
    attempted.push("haiku");
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const message = await Promise.race([
        client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2000,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), PROMPT_GEN_TIMEOUT_MS)
        ),
      ]);
      const raw = (message.content[0] as { type: "text"; text: string }).text;
      const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const parsed = JSON.parse(text) as unknown;
      if (!isValidCitationPromptArray(parsed)) {
        throw new Error(`validation failed: got ${Array.isArray(parsed) ? parsed.length : "non-array"}`);
      }
      const filtered = filterIndirectDomainLeaks(parsed as CitationPrompt[], domain);
      const elapsed = Date.now() - t0;
      console.info(
        `[citation-prompts] ${domain}: haiku succeeded — ${filtered.length} prompts in ${elapsed}ms`
      );
      return filtered;
    } catch (err) {
      // Determine next provider name for log message
      const configuredFallbacks = FALLBACK_PROVIDERS.filter(p => process.env[p.envKey]);
      const nextName = configuredFallbacks[0]?.name ?? "none";
      if (nextName !== "none") {
        console.warn(`[citation-prompts] ${domain}: haiku failed, trying ${nextName}. Error: ${err}`);
      } else {
        console.warn(`[citation-prompts] ${domain}: haiku failed, no fallback providers configured. Error: ${err}`);
      }
    }
  }

  // Step 3: Try fallback providers in order
  // Build inline lambdas here so they close over userPrompt
  const openAiFn = async (): Promise<string> => {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 2000,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userPrompt },
      ],
    });
    return res.choices[0]?.message?.content ?? "";
  };

  const googleFn = async (): Promise<string> => {
    const client = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY!);
    const model = client.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
    const res = await model.generateContent(`${SYSTEM_PROMPT}\n\n${userPrompt}`);
    return res.response.text();
  };

  const perplexityFn = async (): Promise<string> => {
    const client = new OpenAI({
      apiKey: process.env.PERPLEXITY_API_KEY,
      baseURL: "https://api.perplexity.ai",
    });
    const res = await client.chat.completions.create({
      model: "sonar",
      max_tokens: 2000,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userPrompt },
      ],
    });
    return res.choices[0]?.message?.content ?? "";
  };

  const FALLBACK_PROVIDERS: Array<{ name: string; envKey: string; fn: () => Promise<string> }> = [
    { name: "openai",     envKey: "OPENAI_API_KEY",               fn: openAiFn },
    { name: "google",     envKey: "GOOGLE_GENERATIVE_AI_API_KEY", fn: googleFn },
    { name: "perplexity", envKey: "PERPLEXITY_API_KEY",           fn: perplexityFn },
  ];

  for (const provider of FALLBACK_PROVIDERS) {
    if (!process.env[provider.envKey]) continue; // skip unconfigured

    attempted.push(provider.name);
    const result = await tryProvider(provider.name, provider.fn, domain);

    if (result !== null) return result;

    // Log failure and peek at next configured provider
    const remainingIdx = FALLBACK_PROVIDERS.indexOf(provider) + 1;
    const nextConfigured = FALLBACK_PROVIDERS
      .slice(remainingIdx)
      .find(p => process.env[p.envKey]);
    if (nextConfigured) {
      console.warn(
        `[citation-prompts] ${domain}: ${provider.name} failed, trying ${nextConfigured.name}.`
      );
    } else {
      console.warn(
        `[citation-prompts] ${domain}: ${provider.name} failed.`
      );
    }
  }

  // Step 4: All configured providers failed
  console.warn(
    `[citation-prompts] ${domain}: all providers failed [${attempted.join(", ")}] — using 4 legacy prompts`
  );
  return buildFallback(domain);
}
```

---

## c) Unit Test Plan

**File:** `geo/__tests__/citation-prompt-generator.test.ts`

Extend existing ES-027 tests. Add the following cases to cover the new fallback loop.

**Mock setup** — extend existing `vi.hoisted()` block to also mock OpenAI and Google SDKs:

```typescript
const { mockHaikuCreate, mockOpenAICreate, mockGoogleGenerate } = vi.hoisted(() => {
  const mockHaikuCreate  = vi.fn();
  const mockOpenAICreate = vi.fn();
  const mockGoogleGenerate = vi.fn();
  return { mockHaikuCreate, mockOpenAICreate, mockGoogleGenerate };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(() => ({ messages: { create: mockHaikuCreate } })),
}));

vi.mock("openai", () => ({
  default: vi.fn(() => ({
    chat: { completions: { create: mockOpenAICreate } },
  })),
}));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn(() => ({
    getGenerativeModel: vi.fn(() => ({ generateContent: mockGoogleGenerate })),
  })),
}));
```

**Helper to mock OpenAI success response:**

```typescript
function mockOpenAISuccess(items: CitationPrompt[]) {
  mockOpenAICreate.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(items) } }],
  });
}

function mockGoogleSuccess(items: CitationPrompt[]) {
  mockGoogleGenerate.mockResolvedValue({
    response: { text: () => JSON.stringify(items) },
  });
}
```

**Test cases:**

| ID | Name | Setup | Expected |
|----|------|-------|----------|
| FB-1 | OpenAI tried when Haiku fails | `mockHaikuCreate.mockRejectedValue(new Error("529"))`, `OPENAI_API_KEY` set, OpenAI returns 48 valid prompts | Returns OpenAI's `CitationPrompt[]`; console.warn called with "haiku failed, trying openai" |
| FB-2 | Google tried when Haiku and OpenAI fail | Both fail; `GOOGLE_GENERATIVE_AI_API_KEY` set; Google returns 48 valid prompts | Returns Google's result; warn called for haiku and openai failures |
| FB-3 | Perplexity tried when Haiku, OpenAI, Google all fail | All three fail; `PERPLEXITY_API_KEY` set; Perplexity returns 48 valid prompts | Returns Perplexity's result |
| FB-4 | Legacy fallback when all fail | All 3 providers fail (+ no ANTHROPIC key) | Returns 4 legacy `CitationPrompt[]`; console.warn "all providers failed [openai, google, perplexity]" |
| FB-5 | Provider with no API key is skipped | `OPENAI_API_KEY` unset; Google configured and succeeds | `mockOpenAICreate` never called; returns Google's result |
| FB-6 | domain filter applied to OpenAI response | OpenAI returns 40 indirect + 8 direct + 1 indirect leaking domain | Leaking indirect stripped; remainder returned; domain filter log emitted |
| FB-7 | OpenAI returns malformed JSON → Google tried | `mockOpenAICreate` returns `{ choices: [{ message: { content: "not json" } }] }` | OpenAI result discarded; Google attempted next |
| FB-8 | OpenAI returns <20 items → Google tried | OpenAI returns 5-item valid-structure array | Validation fails (< 20); Google tried |
| FB-9 | Haiku timeout → next provider tried | `mockHaikuCreate` never resolves (real timeout would take 30s — use fake timers or mock rejection with "timeout") | OpenAI tried; eventually returns result |
| FB-10 | No providers configured → legacy fallback immediately | All env vars unset | Returns 4 legacy prompts; no SDK call made |

**Coverage target:** All branches of the fallback loop (success at each position, exhaustion, skip-if-no-key, validation failure, domain filter).

**Note on FB-9 timing:** Use `vi.useFakeTimers()` for the timeout test to avoid 30s wall time. Advance timer by 30001ms after `mockHaikuCreate` is set to hang indefinitely.

---

## d) Integration Test Plan

No new integration test file needed. Update existing `CF-4` in `citation-check-flow.test.ts`:

| ID | Name | Before | After |
|----|------|--------|-------|
| CF-4 (updated) | Fallback flow sends CitationPrompt[] to providers | Haiku fails → 4 legacy prompts | Haiku fails → OpenAI succeeds → 48 CitationPrompt[] sent to citation checker |

Add one new integration scenario:

| ID | Name | Setup | Expected |
|----|------|-------|----------|
| CF-6 | All prompt providers fail → 4 legacy prompts sent to citation checker | All LLM mocks reject; citation provider mocks configured | Citation check completes with `promptsUsed` containing 4 entries; no throw |

---

## e) Profiling

No new targets. Latency risk is sequential provider failure (up to 30s per provider × N providers). This is an acceptable trade-off per TS-028: sequential failure is a real API timeout, not artificial delay.

Log output includes timing for the succeeding provider (`${n} prompts in ${ms}ms`) which is sufficient to identify slow providers in production logs.

---

## f) Load Test

No change from ES-027.

---

## g) Logging & Instrumentation

Exact log patterns per TS-028 (verbatim):

```
[citation-prompts] {domain}: haiku failed, trying openai. Error: {err}
[citation-prompts] {domain}: openai succeeded — {n} prompts in {ms}ms
```

```
[citation-prompts] {domain}: all providers failed [haiku, openai, google] — using 4 legacy prompts
```

The `attempted` array in `generatePrompts()` accumulates provider names in attempt order and is used in the final-failure log line.

---

## h) Acceptance Criteria

| AC | Criterion | Testable assertion |
|----|-----------|-------------------|
| AC-1 | When Haiku returns 529, next configured provider is tried automatically | FB-1: OpenAI called after Haiku rejection |
| AC-2 | When OpenAI succeeds as fallback, returns valid `CitationPrompt[]` | FB-1: result passes `isValidCitationPromptArray` |
| AC-3 | `filterIndirectDomainLeaks()` applied to all provider responses | FB-6: domain leak in OpenAI response stripped |
| AC-4 | Static 4-prompt fallback only when ALL providers fail | FB-4: fallback only after all three fail |
| AC-5 | Each failed provider logs a warning with provider name and error | FB-2: console.warn called for haiku, openai |
| AC-6 | Successful fallback provider logged at info level | FB-1: console.info called with "openai succeeded" |
| AC-7 | `generatePrompts()` signature and return type unchanged | TypeScript compile check; no callers need updating |
| AC-8 | Providers with no API key silently skipped | FB-5: `mockOpenAICreate` not called when `OPENAI_API_KEY` unset |
| AC-9 | Unit tests FB-1..FB-10 all pass | |
| AC-10 | Integration tests CF-4 (updated) and CF-6 pass | |
