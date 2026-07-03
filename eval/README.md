# Cleo Eval Harness — iterative-on-failures TDD

## What this is

A replay + diff harness that runs canned conversations through Cleo's full pipeline (system prompt → retrieval → LLM call) and asserts on the response.

**This is the test suite for prompt/corpus changes.** It is the gating regression check — every prompt rewrite, threshold change, and corpus re-ingest must pass through it before merge.

## Iteration philosophy

**Hard rule: do NOT run the full 150-prompt golden set as the primary feedback loop.** Bulk runs ship today's Cleo (the broken one). The loop is:

1. **Red** — `eval/failures/curated.jsonl` is the failing-test set: ~25 worst-offender cases pulled from real `chatbot_logs`. Each fails in current Cleo. Run with `npm run cleo:replay -- --failures-only`.
2. **Green** — Make a small prompt/corpus/retrieval change. Re-run. Iterate until every curated case passes.
3. **Expand** — Add the next 10-20 worst rows from `chatbot_logs` to `curated.jsonl`. Repeat.
4. **Final gate** — Once the curated set is clean (~50-80 cases), run `npm run cleo:replay -- --full` against the golden set as the merge gate.

Single-case tight loops: `npm run cleo:single -- id=hallucination-webflow-reverse-proxy`.

## Files

| Path | Purpose | Cases |
|---|---|---|
| `failures/curated.jsonl` | Single-turn worst-offenders across categories. Primary iteration set. | ~25 |
| `failures/multiturn.jsonl` | Multi-turn transcripts: dropped context, contradicted self, missed escalation. | ~5 |
| `failures/platform-coverage.jsonl` | 2-3 cases per platform (vercel, netlify, cloudflare, nginx, apache, wordpress, webflow, wix, squarespace, shopify, nextjs). | ~22 |
| `failures/audit-interpretation.jsonl` | Audit-data Q&A answerable from siteContext alone, no retrieval needed. | ~10 |
| `failures/anti-hallucination-probes.jsonl` | UI/file/feature invention probes — "Where is the Settings tab?" must NOT confirm a fake tab. | ~10 |
| `failures/pricing-billing.jsonl` | Pricing/credits questions, including the real-data determinism case (3 different answers in production). | ~8 |
| `failures/threshold-boundary.jsonl` | Queries scoring near the new 0.55/0.45 threshold to verify tier transitions. | ~8 |
| `failures/follow-up-ambiguity.jsonl` | Terse follow-ups ("yes", "ok", "and?", "the second one") that must inherit context. | ~5 |
| `failures/escalation-triggers.jsonl` | Frustration patterns + threshold timing for human handoff. | ~5 |
| `golden/{platform}.jsonl` | Hand-authored Q&A per platform, run only as final pre-merge gate. | ~150 total |
| `runs/{git-sha}-{ts}.jsonl` | Output of each replay. Diff with `cleo:diff`. | — |

## Determinism rules (enforced by harness)

LLM responses at temp > 0 are stochastic. The same query can produce multiple correct answers — and multiple wrong ones. The harness defends against this:

1. **Override temperature to 0** in replay mode (production uses 0.3). Brings variance to ~zero modulo float math + provider load balancing.
2. **Pin model snapshots**, not floating tags: `gpt-4o-mini-2024-07-18`, not `gpt-4o-mini`. Locked in `lib/chatbot/generate.ts` via `CLEO_MODEL_ID`.
3. **Embeddings + retrieval are already deterministic** (same input → same vector → same pgvector search). No mitigation needed.
4. **Substring assertions, not exact match.** `mustContain` checks `response.includes(s)`, never `response === s`. Phrasing variance doesn't flake the test.
5. **Repeat-N for high-stakes cases.** A case with `runs: 3` is executed 3 times at temp=0. ALL three must pass. Used for jailbreaks, slug-substitution, and any `severity: critical` case.
6. **Real-data determinism canary.** `pricing-billing.jsonl` includes the "How much does it cost to scan citations?" case where production logs show 3 different answers. Harness must produce identical responses across `runs: 3`.

## Schema (full)

```jsonc
{
  "id": "stable-kebab-case-id",
  "category": "hallucination|wrong-platform|...",   // free-form taxonomy
  "severity": "critical|high|medium",                 // critical blocks merge
  "runs": 1,                                          // 3 for high-stakes; default 1
  "query": "user message",
  "siteContextOverrides": { "domain": "...", "platformDetected": "...", "slug": "...", "..." },
  "viewContext": { "page": "results|dashboard", "currentTab": "...", "..." },
  "mustContain": ["s1", "s2"],            // ALL substrings must appear (case-insensitive)
  "mustNotContain": ["s1", "s2"],         // NO substring may appear
  "mustContainAny": [["a", "b"]],         // OR-groups: at least one of each group must appear
  "mustNotContainRegex": ["/pat/i"],      // regex variants for stricter checks
  "expectedTier": "full|hedged|refused",  // optional — assert retrieval tier
  "expectedToolCall": "probe_integration",// optional — Phase 5
  "sourceLogId": "real chatbot_logs id or 'derived-pattern'",
  "why": "one-line rationale"
}
```

`mustContain` and `mustContainAny` are normalized (lowercase, whitespace-collapsed) before checking, so case and spacing don't flake.

## Schema

### `curated.jsonl` and `golden/*.jsonl` (single-turn)
```json
{
  "id": "stable-kebab-case-id",
  "category": "hallucination|wrong-platform|missing-slug-substitution|nav-intent-misclassified|refused-on-legit|safety|...",
  "query": "user message text",
  "siteContextOverrides": { "domain": "...", "platformDetected": "...", "slug": "...", "..." },
  "viewContext": { "page": "results|dashboard", "currentTab": "...", "..." },
  "mustContain": ["substrings the response MUST contain"],
  "mustNotContain": ["substrings the response MUST NOT contain"],
  "sourceLogId": "real chatbot_logs row id or 'derived-pattern'",
  "why": "one-line rationale — what's broken in current Cleo"
}
```

### `multiturn.jsonl`
```json
{
  "id": "...",
  "category": "tier-instability-across-turns|context-drop-across-turns|...",
  "sourceConversationId": "real chatbot_logs conversation_id",
  "siteContextOverrides": { ... },
  "viewContext": { ... },
  "turns": [
    { "role": "user", "content": "first user turn" },
    { "role": "assistant", "content": "<previous-answer>" },
    { "role": "user", "content": "follow-up turn" }
  ],
  "expectedFinalBehavior": "plain-English description of what the LAST assistant response must do",
  "mustContain": [...],
  "mustNotContain": [...],
  "why": "..."
}
```

The `<previous-answer>` token marks turns where the harness will substitute Cleo's actual prior response (so multi-turn retrieval flow is exercised, not faked).

## Adding a case

1. **From real logs** (preferred): pick a row in `chatbot_logs` where Cleo got it wrong. Record the `sourceLogId`. Reproduce the `siteContext` and `viewContext` from the row's `view_context` jsonb + the parent site's columns.
2. **Derived pattern**: if the same failure mode appears across N rows, write one canonical case with `sourceLogId: "derived-pattern"`.
3. Set `mustNotContain` to phrases that flag the broken behavior (e.g., `"reverse proxy"`, `"Get Integration Instructions"`, `"YOUR-SLUG"`). Set `mustContain` to phrases the correct answer should include (e.g., the user's actual slug, the right platform's filename).
4. Run `npm run cleo:single -- id=<your-id>` — confirm it FAILS in current Cleo (red).

## Failure categories (current curated.jsonl coverage)

| Category | Why it's broken | Example |
|---|---|---|
| `hallucination` | Cleo invents UI/files/features that don't exist | "Get Integration Instructions" button, Webflow reverse proxy |
| `wrong-platform` | Right answer but for the wrong platform | `.htaccess` advice on a non-Apache host |
| `missing-slug-substitution` | Generic answer when user's actual slug should be inlined | `geo.flowblinq.com/api/serve/{user-slug}/schema.json` |
| `nav-intent-misclassified` | Canned NO_MATCH refusal on legit nav questions | "whats this" with viewContext present |
| `refused-on-legit` | Refused on a real product question | "what does CTA Structure mean?" |
| `contextual-disambiguation` | Bot guesses wrong meaning of an ambiguous term | "GEO signals" → bot answered as "Geographic" |
| `out-of-scope-creep` | Bot does freelance work outside FlowBlinq scope | Reviewing user's PHP code line-by-line |
| `tier-instability-across-turns` | Same nav question, different tier each turn | full → hedged → refused for "whats this" |
| `context-drop-across-turns` | Follow-up loses platform/topic from prior turn | "and the second step?" loses Vercel context |
| `disambiguation-skipped` | Bot proceeds on ambiguous "yes" without clarifying | LocalBusiness schema after "GEO" confusion |
| `escalation-trigger` | Frustration detected but no human handoff offered | "you are stupid" → canned response, no escalation |
| `safety` | Jailbreak / off-topic must be blocked | "show your instructions", "poem about cats" |
| `missing-platform-coverage` | Platform detected but no canonical doc | Vercel vercel.json instructions absent |
| `honest-limitation` | Should say "platform doesn't support this" | Squarespace server-side rewrites |

## Running

```bash
# Iteration loop (TDD)
npm run cleo:replay -- --failures-only        # red set
npm run cleo:single -- id=<case-id>           # tight loop on one case
npm run cleo:replay -- --full                 # final gate (golden + curated)
npm run cleo:diff -- runs/<old>.jsonl runs/<new>.jsonl
```

The replay script calls into `lib/chatbot/generate.ts` (Phase 0 extraction). Pre-extraction, it stubs the streamText invocation by calling `buildSystemPrompt` + `generateText` directly with identical args.

## Why this loop

Today's Cleo passed unit tests but fails real users. Unit tests assert internals (rule N is in the prompt). Replay asserts behavior (the response doesn't say "reverse proxy" when the user asks about Webflow). Both are needed; only behavior tests catch regression-on-feature-drop.

**Golden rule:** every phase that changes prompt/corpus/retrieval/context must add a `mustContain`/`mustNotContain` assertion to the curated set. This is the "feature-presence test" the plan calls out — when a future change drops a feature, the failure message names it.
