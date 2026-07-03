# TS-028 — Prompt Generator Provider Fallback

**Date:** 2026-03-04
**Status:** Ready for Engineering Spec
**Priority:** P1 (production reliability)

---

## What

When Haiku fails to generate citation prompts (overload, timeout, API error), instead of immediately dropping to the 4 static legacy prompts, try the remaining configured providers in order using the same system/user prompt. Only fall back to the static 4 prompts if every configured provider fails.

---

## Why

Currently a transient Haiku 529 (overloaded) silently degrades the entire citation check to 4 generic prompts with no domain-aware market queries. Users lose the ES-027 indirect/direct split and get meaningless legacy results — and are charged 5 credits for it.

The same system prompt and JSON output format works with any capable LLM. We already have OpenAI, Google, and Perplexity clients available. There is no reason to fall back to static prompts while other providers are configured and reachable.

---

## Dependencies

- ES-027 on main (b474366) — `CitationPrompt` type and `generatePrompts()` already in place
- No new API integrations, no new env vars, no DB changes

---

## Files to Change

| File | Change |
|------|--------|
| `lib/services/citation-prompt-generator.ts` | Add provider fallback loop after Haiku failure. Try OpenAI → Google → Perplexity in order using same prompt. Static 4-prompt fallback only if all providers fail. |

---

## Interface

`generatePrompts()` signature and return type are **unchanged**. All changes are internal to the function.

---

## Provider Fallback Logic

### Fallback order (after Haiku)
1. OpenAI — `gpt-4o-mini` via `OPENAI_API_KEY`
2. Google — `gemini-2.5-flash-lite` via `GOOGLE_GENERATIVE_AI_API_KEY`
3. Perplexity — `sonar` via `PERPLEXITY_API_KEY`

Skip any provider whose API key is not configured.

### Per-provider attempt
- Same `SYSTEM_PROMPT` and `buildUserPrompt()` output — no changes
- Same `isValidCitationPromptArray()` validation
- Same `filterIndirectDomainLeaks()` post-processing
- Same timeout: 30 seconds
- On success: log which provider was used, return filtered result
- On failure: log warning, try next provider

### Final fallback
Only if ALL configured providers fail: return `buildFallback(domain)` (4 static prompts). Log error listing all providers that were attempted.

### Logging
```
[citation-prompts] {domain}: Haiku failed, trying OpenAI. Error: {err}
[citation-prompts] {domain}: OpenAI succeeded — {n} prompts in {ms}ms
```
or:
```
[citation-prompts] {domain}: all providers failed [haiku, openai, google] — using 4 legacy prompts
```

---

## Implementation Notes

- Use the OpenAI SDK (already a dependency) for both OpenAI and Perplexity calls — same pattern as `citation-checker.ts`
- Use `@google/generative-ai` SDK (already a dependency) for Google
- Reuse the exact same `SYSTEM_PROMPT` constant — it is model-agnostic
- Wrap each provider call in its own try/catch; catch → log → continue to next
- 30s timeout via `Promise.race` (same pattern as citation-checker.ts)
- Parse and validate each response the same way as the Haiku path

---

## Acceptance Criteria

1. When Haiku returns 529, next configured provider is tried automatically
2. When OpenAI succeeds as fallback, returns valid `CitationPrompt[]` (passes `isValidCitationPromptArray`)
3. `filterIndirectDomainLeaks()` applied to all provider responses, not just Haiku
4. Static 4-prompt fallback only triggered when ALL providers fail
5. Each failed provider attempt logs a warning with provider name and error
6. Successful fallback provider logged at info level
7. No change to `generatePrompts()` signature or return type
8. Providers with no API key configured are silently skipped (not attempted)

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Different LLMs may not follow the JSON output format as reliably as Haiku | Validation (`isValidCitationPromptArray`) catches malformed output; fallback to next provider |
| Perplexity `sonar` may return web-search-augmented responses with unexpected structure | Same validation + filter handles it; if parse fails, fallback to next provider |
| Added latency if multiple providers fail sequentially | Sequential by design — each failure is a real API timeout (30s). Acceptable trade-off vs. silent 4-prompt degradation. |
