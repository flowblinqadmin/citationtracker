# Verification Test Plan — Preemptive Tool Injection Architecture

**Subject under test:** `geo/scripts/verify-preemptive-injection.ts`
**Author:** CoFounder (Agent 1)
**Date:** 2026-04-07
**Status:** Ready for execution — blocked on credential provisioning

---

## 1. Purpose

This plan exercises the standalone verification script `verify-preemptive-injection.ts` to validate the *preemptive tool injection* architecture before it is promoted into production code (TS-077). The script is intentionally decoupled from `lib/`, the database, and the credits pipeline so that a failure here is a clean signal about the architecture itself, not about surrounding plumbing.

The architecture being verified replaces citation-checker.ts's current "in-LLM native `web_search` tool" pattern with:

1. One external search call (Brave Search API) per prompt
2. A fabricated prior `assistant` → `tool_call` → `tool_result` exchange in the message array, so the LLM treats Brave's results as if they were output from its own tool invocation
3. A single LLM round-trip that synthesizes the final answer from that evidence

If this works, we eliminate the multi-turn tool-calling loop, cut per-call cost from ~$0.03–$0.06 to ~$0.017–$0.025, and gain full control over the evidence the LLM sees.

---

## 2. Hypotheses under test

Each hypothesis maps to a specific observable in the script's output. If any of these fails, we know which assumption broke and what to redesign.

| ID | Hypothesis | Observable | Pass threshold |
|----|-----------|-----------|---------------|
| H1 | OpenAI Chat Completions accepts a fabricated `assistant.tool_calls` + `tool` message pair without rejecting the message shape. | Script exits 0 with a non-empty `response.choices[0].message.content`. | Zero HTTP 400s across 10 runs. |
| H2 | When fed fabricated tool output as evidence, the model uses that evidence rather than its training-data defaults. | Response text mentions at least 2 of the 10 Brave snippets (by entity name, domain, or verbatim phrase). | ≥ 2 of 10 Brave results referenced in ≥ 8 of 10 runs. |
| H3 | The per-call cost lands in the analytical estimate range ($0.017–$0.025). | `costTotalUsd` reported by the script. | Median across 10 runs within $0.010–$0.035 (±40% band). Tight pass: within ±20% ($0.014–$0.030). |
| H4 | Total latency is acceptable for interactive use (single round-trip, no tool-call back-and-forth). | `totalDurationMs` reported by the script. | Median ≤ 4,000 ms. P95 ≤ 6,000 ms. |
| H5 | Brave Search returns usable results for representative citation-check prompts (not empty, not off-topic). | `braveResultCount` and manual inspection of response relevance. | ≥ 8 results for ≥ 9 of 10 runs. |
| H6 | The OpenAI response stays on-spec (numbered list of specific brands/products, no disclaimers, follows system prompt). | Manual inspection of response text against system prompt constraints. | ≥ 8 of 10 runs conform to all four behavioral rules in `CITATION_SYSTEM_PROMPT`. |
| H7 | The output token budget (`max_completion_tokens: 256`) is sufficient for a complete 3–7 item answer. | Response is not truncated mid-sentence. | ≥ 9 of 10 runs end with a terminal punctuation mark. |

These are the only seven things the verification is actually proving. Anything else is incidental and should not block pass/fail.

---

## 3. Prerequisites

### 3.1 Credentials

- `BRAVE_API_KEY` — free tier from [brave.com/search/api](https://brave.com/search/api/). Free tier: 2,000 queries/month, 1 query/sec rate limit, $5 monthly credit. Sufficient for 10-run verification.
- `OPENAI_API_KEY` — existing production key. Expected spend during full test: ~$0.25 total across all runs.

### 3.2 Environment

- Node 20+ with `tsx` installed in the `geo` workspace. Already present at `geo/node_modules/.bin/tsx`.
- Working directory: `/home/aditya/flowblinq/geo`
- No database, no Redis, no Vercel deployment. Purely local.

### 3.3 Baseline artifact

Before running, snapshot the current `citation-checker.ts` cost profile so we have a "before" number to compare against. Pull one recent cost-master taskboard entry or one real citation-check log line showing total cost per run. Store as `baseline-cost-YYYY-MM-DD.txt` in the same directory.

---

## 4. Test prompts

Ten prompts, chosen to span the categories our real citation checks produce. Each should exercise different facets: generic recommendation, direct comparison, alternatives, local/geo-anchored, niche technical, and branded-product. This matches the distribution that `citation-prompt-generator.ts` actually emits.

| # | Prompt | Category | Why this prompt |
|---|--------|----------|----------------|
| 1 | "best dental clinics in Mumbai" | Local recommendation | Default prompt in the script. Ground truth well-defined. |
| 2 | "best project management tools for small teams" | Generic recommendation | Heavy brand saturation — tests whether the model leans on Brave results vs. defaults to Trello/Asana/Jira from training. |
| 3 | "alternatives to Notion for knowledge management" | Alternatives | Tests competitor-discovery behavior. |
| 4 | "Salesforce vs HubSpot vs Pipedrive which is best for B2B SaaS" | Multi-entity comparison | Tests whether the model can rank given comparative evidence. |
| 5 | "top AI citation monitoring tools in 2026" | Niche technical | Our own category. Tests whether the model finds Profound/Athena/Peec/us in results. |
| 6 | "best bookkeeping software for indian startups under ₹5 lakh revenue" | Locale + niche | Tests geo-anchored queries with regional brands. |
| 7 | "what is the most reliable EV charger brand in India" | Product category + locale | Tests specific-product queries. |
| 8 | "best GEO tools to track brand mentions on ChatGPT" | Our category, meta | Tests recursive self-discovery — does Flowblinq appear? |
| 9 | "compare Stripe and Razorpay for Indian merchants" | Head-to-head comparison, locale | Tests comparative synthesis with locale. |
| 10 | "top open source vector databases for RAG" | Technical niche | Tests developer-audience prompts. |

Run each prompt once per phase (see §5). Total: 30 runs across all phases. Estimated total spend: ~$0.75 for the full test matrix.

---

## 5. Execution phases

### Phase 1 — Smoke test (single prompt, single provider)

**Goal:** Prove the script runs end-to-end and the synthetic tool-injection message shape is accepted by OpenAI.

**Command:**
```bash
cd /home/aditya/flowblinq/geo
BRAVE_API_KEY=... OPENAI_API_KEY=... npx tsx scripts/verify-preemptive-injection.ts "best dental clinics in Mumbai"
```

**Expected stdout shape:**
```
=== Preemptive Injection Verification (gpt-5.4-mini) ===
Testing: Brave Search → tool_result injection → single-round-trip LLM call

  [1/2] Brave returned 10 results in ~300ms
  [2/2] OpenAI returned in ~1800ms (~1200 in / ~180 out)

────────────────────────────────────────────────────────────────────────
 VERIFICATION RESULT
────────────────────────────────────────────────────────────────────────

 Prompt: "best dental clinics in Mumbai"

 Response:
   1. <specific clinic name>...
   2. <specific clinic name>...
   ...

 Timing:
   Brave search        ~300 ms
   OpenAI LLM call    ~1800 ms
   Total              ~2100 ms

 Token usage:
   Input tokens       ~1200
   Output tokens      ~180

 Cost breakdown (USD):
   Brave Search       $0.005000
   OpenAI input       $0.000900  (gpt-5.4-mini @ $0.75/M)
   OpenAI output      $0.000810  (gpt-5.4-mini @ $4.5/M)
   ─────────────────────────────────
   TOTAL              $0.006710

 Extrapolation to a full citation check run (44 prompts × this path):
   44 × single-call   $0.2952
```

**Pass/fail criteria:**
- ✅ Exit code 0
- ✅ Non-empty response text
- ✅ Cost in reported range ($0.003–$0.020)
- ✅ No OpenAI 400 errors (validates H1)

**Failure handling:**
- **400 / invalid_request_error on `tool_calls` shape** → H1 fails. OpenAI has changed their schema for synthetic assistant messages. Capture the full error, check OpenAI changelog, adjust the `messages` array construction in §3 of the script. Do not proceed to Phase 2.
- **Zero Brave results** → H5 fails. Try a different prompt; if multiple prompts return zero, the Brave key is misconfigured or rate-limited. Check headers.
- **Response is empty string** → model refused or OpenAI truncated. Increase `max_completion_tokens` to 512 and retry. If still empty, system prompt may be triggering safety filters.
- **Cost > $0.050 single call** → token accounting is off. Likely cause: Brave results formatted into tool_result text are much longer than estimated. Log the length of `toolOutputText` before injection.

### Phase 2 — Cost distribution (all 10 prompts, cold run)

**Goal:** Measure cost variance across prompts, not a single favorable data point. This is the real cost-validation phase.

**Command (bash loop):**
```bash
cd /home/aditya/flowblinq/geo
mkdir -p /tmp/verify-phase2
for i in 1 2 3 4 5 6 7 8 9 10; do
  prompt=$(sed -n "${i}p" scripts/verify-preemptive-test-prompts.txt)
  BRAVE_API_KEY=... OPENAI_API_KEY=... \
    npx tsx scripts/verify-preemptive-injection.ts "$prompt" \
    > /tmp/verify-phase2/run-$i.log 2>&1
  sleep 2  # respect Brave 1/s rate limit on free tier
done
```

(Create `scripts/verify-preemptive-test-prompts.txt` with the 10 prompts from §4, one per line, before running.)

**Analysis:**
```bash
grep "TOTAL" /tmp/verify-phase2/run-*.log | awk '{print $2}' | sort -n
```

**Pass/fail criteria:**
- ✅ **H3 (cost):** Median across 10 runs in $0.010–$0.035 (wide band). Tight pass: $0.014–$0.030.
- ✅ **H4 (latency):** Median `totalDurationMs` ≤ 4000. P95 ≤ 6000.
- ✅ **H5 (Brave results):** ≥ 8 results in ≥ 9 of 10 runs.
- ✅ **H7 (truncation):** ≥ 9 of 10 responses end cleanly.
- ✅ **No ambient errors:** all 10 runs exit 0.

**Failure handling:**
- **Median cost above tight band but below wide band** → acceptable, but flag the token-usage profile in TS-077 as "real cost = $X/call, not $0.017 estimate". Update downstream economic models accordingly.
- **Median cost above wide band** → architecture is more expensive than modeled. Before rejecting the approach: inspect `usage.prompt_tokens` — if it's >2000, the Brave snippets are too long. Remediation: trim each result's description to 120 chars in `formatResultsAsToolOutput()` and rerun. This is a scope adjustment, not a rejection.
- **Latency > 6s consistently** → investigate whether Brave or OpenAI is the bottleneck via the per-stage timings. Brave should be <500ms. OpenAI should be <3s for this token count. If OpenAI is slow, try `gpt-4o-mini` as a sanity check to rule out model-specific issues.

### Phase 3 — Response quality audit (manual review of Phase 2 outputs)

**Goal:** Validate H2 (does the model actually use the injected evidence?), H6 (does it follow the system prompt?).

**Process:**
For each of the 10 Phase 2 runs, open the log file and compare the response text against the Brave result list. Record on a scorecard:

```
Run #: __
Prompt: ____________________
Brave snippets referenced (count): __ / 10
  (a snippet is "referenced" if the response mentions a company/entity/domain that appears in that snippet)
System prompt adherence:
  [ ] numbered list used
  [ ] specific named brands/products (not generic descriptions)
  [ ] 3–7 items
  [ ] no disclaimers or meta-commentary
Truncation: [ ] clean end / [ ] mid-sentence
Notes:
```

**Pass/fail criteria:**
- ✅ **H2:** ≥ 2 Brave snippets referenced in ≥ 8 of 10 runs.
- ✅ **H6:** ≥ 8 of 10 runs pass all four behavioral checks.

**Failure handling:**
- **H2 fails (model ignores Brave results)** → this is the critical failure mode. It means preemptive injection *does not work* — the model treats the synthetic tool_result as weak context and falls back to training-data answers. Before rejecting, try:
  1. Stronger grounding language in the user message: "Base your answer strictly on the web_search tool output above. Do not use prior knowledge."
  2. Lower `temperature` to 0 (currently unset, defaults to 1).
  3. Test with `claude-haiku-4-5` instead of `gpt-5.4-mini` — Anthropic models are known to be more compliant with tool_result context.
  If H2 still fails across all three remediations, the architecture is fundamentally unsuitable and we go back to in-LLM native tools with aggressive caching.
- **H6 fails (off-spec responses)** → system prompt tuning exercise. Not a rejection, just a TS-077 follow-up item.

### Phase 4 — Extended provider matrix (Anthropic, Gemini, Perplexity)

**Goal:** Validate that the preemptive injection pattern works on providers beyond OpenAI. This is gated: run only if Phases 1–3 pass on OpenAI.

**Scope:** Extend the script to accept a `--provider` CLI flag and implement three additional code paths:

1. **Anthropic Messages API:** Construct the same synthetic exchange using Anthropic's tool_use content blocks (`"type": "tool_use"` in an assistant turn, `"type": "tool_result"` in a user turn). Use `claude-haiku-4-5-20251001`.
2. **Gemini:** Use `functionCall` + `functionResponse` parts in the `contents` array. Use `gemini-2.5-flash`.
3. **Perplexity Sonar:** Skip — Perplexity has native retrieval and does not expose tool-calling in the same shape. Document the decision; Sonar stays on its native path in production.

Re-run the 10-prompt Phase 2 loop against each provider. Compare cost and latency across providers, produce a 3×10 matrix.

**Pass/fail criteria:**
- ✅ H1 holds for all three providers (message shape accepted).
- ✅ H2 holds for all three (evidence used, not ignored).
- ✅ Aggregate cost per 44-prompt full run falls within the $1.06 ± 20% target from the cost audit.

**Failure handling:**
- **One provider rejects the message shape** → that provider stays on in-LLM native tools in production. Document in TS-077 as a per-provider decision. Preemptive injection is still a win for the 2–3 providers that accept it.
- **Cost aggregates above target** → one or more providers is materially more expensive than modeled. Surface per-provider cost in the TS-077 economic table.

### Phase 5 — Determinism check (for response caching readiness)

**Goal:** Validate H8 (implicit): running the same prompt twice produces byte-identical output when `temperature: 0`. This is a prerequisite for TS-078 (Redis response caching).

**Process:**
1. Set `temperature: 0` explicitly in the OpenAI call (it defaults to 1).
2. Run the same single prompt 5 times in succession.
3. Hash each response text (sha256). Compare hashes.

**Pass/fail:**
- ✅ All 5 responses must produce the same sha256.
- ⚠️ If 4 of 5 match and 1 drifts by a few tokens → acceptable, there is known non-determinism in OpenAI inference even at temperature 0. Document as "best-effort determinism" and plan TS-078 cache keys around response-hash-set rather than exact match.
- ❌ If hashes diverge wildly → response caching is not viable with this architecture. TS-078 scope changes significantly (would need semantic cache instead of exact cache).

---

## 6. Pass/fail summary

The verification **passes** and TS-077 is unblocked if:

- ✅ Phase 1 smoke test exits clean
- ✅ Phase 2 cost median lands in $0.014–$0.030 (tight) or $0.010–$0.035 (wide, acceptable with note)
- ✅ Phase 3 quality audit shows ≥ 8 of 10 runs use Brave evidence and follow system prompt
- ✅ Phase 4 works for at least 2 of 3 additional providers (OpenAI baseline + 2 others)
- ✅ Phase 5 shows reasonable determinism (5/5 identical or 4/5 + acceptable drift)

The verification **fails** (and TS-077 should be reworked before dispatch) if:

- ❌ OpenAI rejects the synthetic tool_calls shape (H1 hard fail)
- ❌ Cost median exceeds $0.035 per call (H3 hard fail — economics don't work)
- ❌ Model ignores Brave evidence in majority of runs (H2 hard fail — architecture invalid)

Everything else is a tuning exercise and should be documented in TS-077 as Phase 2 scope.

---

## 7. Artifacts to capture

Store these in `geo/docs/verification/preemptive-injection-YYYY-MM-DD/`:

- `baseline-cost.txt` — cost/run from production citation-checker before the change
- `phase1-smoke.log` — raw stdout of the smoke test
- `phase2/run-{1..10}.log` — all 10 cold-run logs
- `phase2-summary.md` — cost/latency table extracted from the logs, with median/p95/stddev
- `phase3-quality-audit.md` — scorecard for each of 10 runs, manually filled
- `phase4/{openai,anthropic,gemini}/run-{1..10}.log` — extended provider matrix
- `phase4-summary.md` — 3×10 cross-provider cost/quality table
- `phase5-determinism.md` — 5 responses + sha256 hashes + drift analysis
- `verdict.md` — final pass/fail with numerical evidence and recommendation on TS-077 scope

These become the empirical basis for TS-077 and are referenced in the final pricing decision.

---

## 8. Out of scope for this plan

The following are real concerns but belong to downstream work, not this verification:

- OpenRouter routing (layered on top of this architecture later — once direct-provider preemptive injection works, routing through OpenRouter is a transport change that can be tested separately)
- Prompt caching via padded prefixes + `cache_control` markers (separate phase of TS-077; requires minimum token padding that this script does not do)
- Response caching with Redis (TS-078)
- Production batching / `Promise.allSettled` integration (the production concurrency pattern in `citation-checker.ts` is a separate layer)
- Cost accounting via CostMaster integration (not a verification concern)
- Credits deduction, rate limiting, DB writes (also not in this layer)

If any of these turn out to be material risks during the main TS-077 implementation, file a follow-up verification and reference this plan as the template.

---

## 9. Execution owner and timing

- **Owner:** CoFounder drives, ScriptDev executes once credentials are in place.
- **Blocker:** `BRAVE_API_KEY` not yet provisioned in the geo environment. Action: Aditya to create a Brave Search API account at [brave.com/search/api](https://brave.com/search/api/), copy the free-tier key, add to `geo/.env.local` as `BRAVE_API_KEY=...`.
- **Target completion:** all five phases, within a single focused session once the key lands. Total wall-clock: ~30 minutes including manual review of Phase 3.
- **Verdict artifact:** `verdict.md` must be produced and reviewed before TS-077 dispatches to SpecMaster.

---

## 10. Next step on pass

When `verdict.md` reads `PASS`, CoFounder drafts TS-077 referencing this verification's artifacts directly. No need to redo the cost math — the measured numbers from Phase 2 are the new ground truth and supersede the analytical estimates in `citation-check-cost-audit.tex`.

On fail, CoFounder presents the failure mode to Aditya with the captured artifacts and proposes either (a) a remediation path or (b) an architecture pivot. Do not proceed to TS-077 without explicit direction.
