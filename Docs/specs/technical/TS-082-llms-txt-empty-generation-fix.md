# TS-082 — `llms.txt` Empty-Generation Bug Fix

**Author:** CoFounder (Agent 1)
**Date:** 2026-04-08 (drafted), 2026-04-09 (open questions resolved)
**Priority:** P1 — bug is real but customer impact is currently zero (verified 2026-04-09 via production query, see §9). Was P0 when only Manipal-class symptoms were known.
**Scope:** GEO app (`lib/services/content-generator.ts`, `app/api/pipeline/stage/route.ts`, `app/api/serve/[slug]/llms.txt/route.ts`)
**Related:** TS-081 (originally listed this as Open Question Q1 — separate TS or fold in)
**Status:** READY FOR DISPATCH — all open questions resolved 2026-04-09. Direction A+B both approved. See §9 Decisions Log.

---

## 1. What

Fix the silent empty-string corruption of `geo_sites.generated_llms_txt` that happens when `gpt-5.4-mini` consumes its `max_completion_tokens` budget on internal reasoning before emitting any output, combined with `withRetry`'s silent fail-through that persists the empty result.

The fix has three layers, in priority order:

1. **Generation** (`lib/services/content-generator.ts:257-289`) — bump `max_completion_tokens` for the short llms.txt OpenAI call from `2000` to `8000`, AND treat `finish_reason === "length"` with empty content as a hard failure that throws.
2. **Retry semantics** (`app/api/pipeline/stage/route.ts:148-167`) — `withRetry` must throw when validation fails on the final attempt regardless of `maxAttempts`. The current "use best result" path silently corrupts data. Either remove the fall-through return, or special-case `maxAttempts === 1` to throw immediately on failed validation.
3. **Serve route diagnostics** (`app/api/serve/[slug]/llms.txt/route.ts:15`) — distinguish "site not found" (404) from "site exists but content is empty" (503 with `Retry-After: 600` and a body explaining "Generation pending or failed — please re-run audit"). The current code returns 404 for both, which causes `verify-connection` to misdiagnose as "rewrite rule not installed."

## 2. Why

### 2.1 Production evidence (verified 2026-04-08)

Manipal Hospitals bulk audit completed 2026-04-08 08:52:53 UTC. Pipeline status `complete`. All other artifacts present and correct:

| Field | Value |
|---|---|
| `pipeline_status` | `complete` |
| `generated_llms_full_txt` | **16,404 chars** ✓ |
| `generated_llms_txt` | **0 bytes** ✗ |
| `generated_business_json` | present ✓ |
| `generated_schema_blocks` | present ✓ |
| `executive_summary` | present ✓ |
| `geo_scorecard` | present ✓ |

The customer attempted "Test Connection" in the dashboard. The verify-connection endpoint at `app/api/sites/[id]/verify-connection/route.ts` proxies through to `https://geo.flowblinq.com/api/serve/{slug}/llms.txt`, which returned **HTTP 404 "Not found"** because the serve route at line 15 treats empty `generatedLlmsTxt` as not-found:

```ts
if (!site || !site.generatedLlmsTxt) {
  return new NextResponse("Not found", { status: 404, ... });
}
```

The verify-connection then ran the 404 branch and returned the misleading error: *"Your site returned a 404 for /llms.txt — the rewrite rule isn't installed yet."* The customer's rewrite rule was actually correct; our content was empty.

### 2.2 Generation root cause (PROMPT-SHAPE SENSITIVITY — primary insight)

`generateLlmsTxt` at `content-generator.ts:257-276` makes two parallel OpenAI calls to `gpt-5.4-mini`:

| Call | `max_completion_tokens` | Result for Manipal |
|---|---|---|
| Short version | **2000** | **0 bytes** (empty content, finish_reason likely `length`) |
| Full version | **6000** | 16,404 chars ✓ |

Initial hypothesis: "the short prompt's 2000-token budget was too tight for reasoning." This is partially right but misses the load-bearing insight.

**Direct experiment performed 2026-04-08 (script: `geo/scripts/manual-fix-manipal-llms.mjs`):**

- Called `gpt-5.4-mini` with `max_completion_tokens: 6000` and a SIMPLER prompt: "Here's the full llms-full.txt for manipalhospitals.com. Condense it into a short llms.txt following the llmstxt.org spec." (no pillar-aware conditional sections, no scoring instructions, no formatting branches.)
- Source document: 16,404 chars (the existing valid llms-full.txt for Manipal).
- Result: **6,452 chars output, finish_reason="stop", reasoning_tokens=0, completion_tokens=1,362**.

The condensation prompt used **zero reasoning tokens**. The original `generateLlmsTxt` short prompt almost certainly burned all 2000 tokens on reasoning (and emitted no content). Both calls used the same model. The difference is **prompt shape**, not prompt length:

- The short llms.txt prompt at `content-generator.ts:210-226` has 5+ conditional sections: `freshnessNote`, `conceptInstructions`, `faqSection`, `teamSection`, `evidenceSection`, plus pillar-score-derived branching and a numbered-rule structure. The model treats this as a planning/reasoning task and spends its budget reasoning about which branches to apply.
- The full llms.txt prompt at `content-generator.ts:228-246` is structurally similar BUT has `max_completion_tokens: 6000` — enough headroom that even after heavy reasoning there's budget left to emit the output.
- A simple "condense this document" prompt skips the planning phase entirely and goes straight to output.

**This changes the recommended fix.** "Bump tokens to 4000" is insufficient because the same prompt shape would just consume the larger budget reasoning. Two viable directions:

**Direction A — Generous token budget.** Bump `max_completion_tokens` for the short call from `2000 → 8000` (matching/exceeding the full call's 6000). Cheap, single-line change, preserves the existing prompt structure. Risk: future prompt growth could re-trigger the same exhaustion at a higher ceiling.

**Direction B — Prompt restructuring.** Pre-resolve the conditional branches in TypeScript before constructing the prompt, so the LLM sees a flat instruction list with no decision-making. Removes the reasoning trigger entirely. More work, more durable.

**Recommended:** Direction A as the immediate fix (one line, ships today), Direction B as a follow-up cleanup. Direction A alone is sufficient — the 6000-token budget on the full call has been working for months with no empty failures, so 8000 on the short call has comfortable headroom.

### 2.3 Retry semantics root cause

`withRetry` at `app/api/pipeline/stage/route.ts:148-167`:

```ts
async function withRetry<T>(label, fn, check, maxAttempts = 3): Promise<T> {
  let lastResult: T | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = await fn();
    const { passed, failures } = check(lastResult);
    if (passed) return lastResult;
    console.warn(`[stage] ${label} check failed (attempt ${attempt}/${maxAttempts}): ${failures.join("; ")}`);
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  console.warn(`[stage] ${label} still failing after ${maxAttempts} attempts — using best result`);
  return lastResult!;  // ← silent fall-through; persists known-bad result
}
```

The `llms` chunk handler at line 624 calls this with `maxAttempts: 1` and a validator that checks `!txt || txt.length < 200`. When the OpenAI call returns empty, the validator fails, but the loop body never re-runs (only 1 attempt allowed) and the function falls through to `return lastResult!` which is the empty result. The caller persists it without knowing validation failed.

The "stage-level retry handles transient failures" comment at line 625 is technically true but irrelevant — stage-level retry only fires if the stage *throws*, not if it silently returns a bad result.

### 2.4 Serve route diagnostic root cause

`app/api/serve/[slug]/llms.txt/route.ts:15` collapses two distinct error states into one HTTP 404:

```ts
if (!site || !site.generatedLlmsTxt) return new NextResponse("Not found", { status: 404, ... });
```

This is the proximate cause of the customer's "Test Connection" misdiagnosis. The verify-connection endpoint cannot distinguish "you forgot to install the rewrite rule" from "we have your site but our content is empty." Both look like 404.

## 3. Acceptance criteria

### 3.1 Generation

- [ ] AC-1: `generateLlmsTxt` for any site that successfully generates `llms-full.txt` ALSO produces a non-empty `llmsTxt` with at least 200 chars.
- [ ] AC-2: When OpenAI returns empty content with `finish_reason === "length"`, `generateLlmsTxt` throws a typed error (`LlmsGenerationLengthExhausted`) that the caller can detect.
- [ ] AC-3: The bumped `max_completion_tokens: 8000` does not regress the response time for the short call by more than 50% (current p50: ~3-5s; tolerance: 8s). Measure via the existing pipeline stage timing.

### 3.2 Retry semantics

- [ ] AC-4: When `withRetry` is called with `maxAttempts: 1` and the validator fails, it **throws** instead of returning the failing result. The thrown error includes the validator's failure reasons.
- [ ] AC-5: Existing callers that pass `maxAttempts: 1` (currently only the `llms` chunk) handle the throw path. The handler should re-enqueue the stage via the existing stage-level retry mechanism, not catch+swallow.
- [ ] AC-6: Callers that pass `maxAttempts ≥ 2` retain current behavior (retry on failure, return best result after exhaustion). The throw path is gated behind `maxAttempts === 1` OR the function always throws on final-attempt validation failure regardless of `maxAttempts`. Either is acceptable; pick one and document it in the function JSDoc.

### 3.3 Serve route diagnostic

- [ ] AC-7: `GET /api/serve/{slug}/llms.txt` returns:
  - **404** when the site row does not exist OR has no `generatedLlmsTxt` field at all (legacy / never-generated state)
  - **503** with `Retry-After: 600` and a plain-text body `"Generation pending or failed — please re-run the audit from your dashboard."` when the site row exists but `generatedLlmsTxt` is an empty string
  - **200** when `generatedLlmsTxt` is non-empty (current behavior)
- [ ] AC-8: `app/api/sites/[id]/verify-connection/route.ts` recognizes the 503 response and returns a more accurate error to the customer: *"Your site is correctly proxying to our serve URL, but our generated llms.txt file is currently empty for this site. Please re-run the audit from your dashboard."*
- [ ] AC-9: The same treatment is applied to `app/api/serve/[slug]/llms-full.txt/route.ts` for symmetry, even though that path is currently unaffected (defensive — same bug class).

### 3.4 Backfill / immediate remediation

- [ ] AC-10: A one-shot script can regenerate `generated_llms_txt` for any site whose value is empty but whose `generated_llms_full_txt` is non-empty. **Reference implementation:** see §8 "Reference implementation (proven working)" for the exact prompt + validation + UPDATE logic that successfully fixed Manipal on 2026-04-08. Productionize as `geo/scripts/regenerate-empty-llms-txt.ts` with `--site` filter (single site) or no filter (all affected sites). Credentials sourced from `.env.local` — never inlined.
- [ ] AC-11: The script is idempotent and gated behind `--commit`. Default is dry-run, prints which sites would be regenerated, exits without writing.
- [ ] AC-12: As of 2026-04-09 production query (see §9), **zero non-test customer sites** are currently in the empty-short-text state. Manipal (`-GzFX1KcKhmN0W_1t8SmY`) was hot-fixed 2026-04-08. The 126 `ar@flowblinq.com` test sites with empty llms.txt are a separate one-day bug (double-stringified `crawl_data`, not TS-082's target — see §9). The cleanup script should still ship per AC-10 as a defensive operator tool, but no scheduled cleanup run is required.

### 3.5 Test coverage

- [ ] AC-13: Unit test for `generateLlmsTxt` that asserts non-empty output for a Manipal-style input (large crawl data, multi-section conditional prompt). Use a real fixture, not a synthetic one.
- [ ] AC-14: Unit test for `withRetry` with `maxAttempts: 1` and a failing validator — must throw, must not return.
- [ ] AC-15: Integration test for the serve route 503 path: insert a site row with empty `generatedLlmsTxt`, hit the route, assert HTTP 503 + `Retry-After` header.

## 4. Out of scope

- TS-081 competitor brand-name detection (independent fix on the same branch).
- The full `gpt-5.4-mini` reasoning-token instrumentation effort (would require model-aware prompt design across many other call sites — separate TS).
- Migrating to a non-reasoning model for short-form generation (e.g. `gpt-4o-mini`). May be warranted as a follow-up but adds quality risk that needs measurement.
- Restructuring the conditional pillar-aware prompt to remove reasoning triggers (Direction B in §2.2). Recommended as a follow-up, not blocking this fix.

## 5. Risks

### 5.1 Direction A is a band-aid, not a root cause fix

Bumping `max_completion_tokens` to 8000 fixes the symptom but the underlying issue — that `gpt-5.4-mini` reasoning behavior is prompt-shape-sensitive and unpredictable — remains. Future prompt growth (more pillar-aware sections, more scoring instructions, longer crawl data injection) could re-trigger exhaustion at a higher ceiling.

**Mitigation:** Add a runtime check that warns when reasoning tokens consume more than 70% of the completion budget on any call. This gives early warning before silent corruption resumes.

### 5.2 Token budget cost increase

Bumping from 2000 → 8000 max increases the per-call cost ceiling 4x. Actual cost is metered on consumed tokens, not budget, so the realistic increase is small (the condensation experiment used 1,362 completion tokens with `max_completion_tokens: 6000`). Worst case: if the new short prompt does spend up to 8000 tokens reasoning, per-call cost goes from ~$0.001 → ~$0.004. Negligible at audit volume.

### 5.3 503 may break customer-side automation

If any customer has tooling that polls `/llms.txt` and treats anything other than 200 as "site offline," they'll see false alarms during the brief window between site creation and audit completion. Mitigation: 503 with `Retry-After: 600` is the standard "service temporarily unavailable" pattern; tooling that handles HTTP correctly will back off rather than alert.

### 5.4 The retry-throw change affects more than the llms chunk

`withRetry` is also called from `business`, `schema-sitewide`, `schema-faq` chunk handlers with `maxAttempts: 2-3`. Changing the final-attempt-failure semantics could change behavior for those handlers if any of their validators are currently failing (we'd be throwing instead of returning the best-effort result). Run the existing `__tests__/pipeline-stage-errors.test.ts` to confirm no regression and add a test for the new throw path.

## 6. Open questions for Aditya — RESOLVED 2026-04-09

1. ~~Direction A vs Direction B (or both)?~~ → **RESOLVED: A + B both.** Direction A ships at normal pipeline pace (no longer urgent — see §9 customer impact). Direction B as the durable follow-up. Both go in the same TS-082 dispatch.
2. ~~`withRetry` throw scope?~~ → **RESOLVED: throw on every final-attempt failure**, regardless of `maxAttempts`. Unified semantics. Validation failures that survive all retries are real failures and must surface.
3. ~~Manipal hot-fix script — keep or delete?~~ → **RESOLVED: productionize per 5c.** The proven working logic from `geo/scripts/manual-fix-manipal-llms.mjs` is captured in §8 below. The standalone script (containing inlined credentials) has been deleted.
4. ~~Customer comms?~~ → **RESOLVED: not needed.** Production query confirmed zero real customers are currently affected (see §9). Manipal already hot-fixed.

## 7. Cross-reference

TS-081 §9 Open Question Q1 asked whether to fold the llms.txt empty-string bug into TS-081 or split into a separate TS-082. **Decision:** split. TS-082 (this document) is the separate TS. TS-081 stays focused on competitor brand-name detection. The two have no shared code surfaces.

## 8. Reference implementation (proven working — 2026-04-08 production experiment)

This is the exact logic that was used to hot-fix Manipal site `-GzFX1KcKhmN0W_1t8SmY` on 2026-04-08, reducing `generated_llms_txt` from 0 bytes to 6,452 chars in a single OpenAI call with `finish_reason="stop"`, **0 reasoning tokens**, and 1,362 completion tokens. It is the empirical proof that Direction B (flat instruction prompt) eliminates the reasoning-burn trap entirely.

The original standalone script (`geo/scripts/manual-fix-manipal-llms.mjs`, contained inlined credentials) was deleted on 2026-04-09. This section is now the canonical source of truth. ScriptDev must implement `geo/scripts/regenerate-empty-llms-txt.ts` against this reference, sourcing credentials from `.env.local` (never inlined).

### 8.1 Inputs

- `siteId` (string) — `geo_sites.id` of the site to repair
- `domain` (string) — `geo_sites.domain` (used in the user prompt for brand naming)
- `fullText` (string) — the existing valid `generated_llms_full_txt` from the same row, OR fetched from the live serve endpoint at `https://geo.flowblinq.com/api/serve/{slug}/llms-full.txt`
- Sanity gate: `fullText.length >= 1000 && fullText.startsWith("# ")` — refuse to proceed otherwise

### 8.2 OpenAI call (the load-bearing piece)

```ts
const res = await openai.chat.completions.create({
  model: "gpt-5.4-mini",
  temperature: 0.1,
  max_completion_tokens: 6000,  // proven safe — full call uses 6000, this matches
  messages: [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: buildUserPrompt(domain, fullText) },
  ],
});
```

**System prompt (verbatim, do not edit lightly — this exact shape is what produced 0 reasoning tokens):**

```
You generate llms.txt files following the llmstxt.org specification. An llms.txt
file is a structured document that helps AI systems understand what a business
is, what it offers, and how to accurately describe it.

The llmstxt.org format requires:
- Line 1: # [Company Name] (H1 heading with exact company name)
- Line 2-3: > [One-sentence summary] (blockquote, answer-first: what the company
  does and for whom)
- Sections use ## headings, content is plain markdown

Use ONLY information found in the provided source document. DO NOT invent phone
numbers, emails, team names, or URLs not in the source. DO NOT use the words
"journey", "empower", "leverage", or "holistic". Return ONLY the file content —
no code fences, no explanations.
```

**User prompt template (`buildUserPrompt(domain, fullText)`):**

```
Below is the full llms-full.txt document for {DOMAIN}. Produce a CONDENSED
llms.txt version following the llmstxt.org spec.

REQUIREMENTS:
1. Keep the same H1 (# {Brand Name from source}) and the same blockquote (> ...)
   on lines 1-3.
2. Keep these sections in this order: ## About, ## Products/Services,
   ## Key Concepts, ## Contact.
3. ## About — 2 paragraphs maximum, distilled from the full About section.
4. ## Products/Services — keep as a bulleted list of service categories with
   one short description line each. Drop the nested bullet points.
5. ## Key Concepts — define 5-8 domain-specific terms. Each definition MUST
   start with "is" or "refers to".
6. ## Contact — only real emails and URLs found in the source. Do not invent.
7. Target length: 1500-3000 words. The full version is ~16K bytes; the short
   version should be roughly 1/4 of that.
8. Do NOT include the FAQ section verbatim. If FAQs are referenced, mention
   they are available and link to relevant URLs.

SOURCE DOCUMENT:
{fullText}

Return ONLY the condensed llms.txt content. No code fences. No explanations.
```

**Why this prompt works (load-bearing insight):**

The prompt is a *flat instruction list with concrete numbered rules and a single
clear deliverable*. The model treats it as transformation, not planning. Compare
with the production `generateLlmsTxt` short prompt at `content-generator.ts:210-226`,
which has 5+ conditional sections (`freshnessNote`, `conceptInstructions`,
`faqSection`, `teamSection`, `evidenceSection`) plus pillar-score-derived
branching. That structure triggers the model's planning/reasoning path and
exhausts the budget before any output is emitted.

**Direction B implementation strategy (per §2.2):** pre-resolve all conditional
branches in TypeScript before constructing the prompt. The prompt the LLM sees
should always be a flat numbered instruction list with no `if X then mention Y`
language. The §8 prompt above is the structural template — adapt it as needed
to retain pillar-aware customization, but pre-bake all conditionals on the TS
side.

### 8.3 Validation gates (must all pass before persistence)

```ts
if (generated.length < 200) throw new LlmsValidationError("too short");
if (!/^# .+/m.test(generated)) throw new LlmsValidationError("missing H1");
if (!/^> .+/m.test(generated)) throw new LlmsValidationError("missing blockquote");
if (!/^## /m.test(generated)) throw new LlmsValidationError("no sections");

// Sanitize: strip code fences if any
const sanitized = generated
  .replace(/^```(?:txt|markdown)?\n/, "")
  .replace(/\n```\s*$/, "")
  .trim();
```

(The throw-on-validation-failure semantics here are exactly what AC-2 requires —
this is intentional symmetry between `generateLlmsTxt` and the regeneration
script.)

### 8.4 UPDATE logic

```ts
const result = await sql`
  UPDATE geo_sites
  SET generated_llms_txt = ${sanitized},
      updated_at = NOW()
  WHERE id = ${siteId}
    AND domain = ${domain}
    AND (generated_llms_txt IS NULL OR length(generated_llms_txt) = 0)
  RETURNING id, length(generated_llms_txt) AS new_len, updated_at
`;

if (result.length === 0) {
  // Either site doesn't exist, domain doesn't match, or row already has
  // non-empty content (race condition with normal pipeline). Idempotent skip.
  console.log(`[skip] site ${siteId} already has content or does not match`);
  return { skipped: true };
}
```

**Idempotency invariant:** The `WHERE ... AND (generated_llms_txt IS NULL OR length = 0)` clause means re-running the script on an already-fixed site is a no-op. This is what makes `--commit` mode safe to retry.

### 8.5 Verification

```ts
// Post-update: hit the live serve endpoint to confirm cache invalidation
const verifyRes = await fetch(`https://geo.flowblinq.com/api/serve/${slug}/llms.txt`);
if (verifyRes.status !== 200) {
  console.warn(`[warn] serve endpoint returned ${verifyRes.status} after UPDATE — check cache`);
}
```

### 8.6 Production result (Manipal, 2026-04-08)

| Metric | Value |
|---|---|
| `model` | `gpt-5.4-mini` |
| `max_completion_tokens` (budget) | 6000 |
| `completion_tokens` (consumed) | 1,362 |
| `reasoning_tokens` | **0** |
| `finish_reason` | `stop` |
| Output length | 6,452 chars |
| Total OpenAI latency | ~12s |
| Persisted to DB | Yes |
| Serve endpoint after UPDATE | HTTP 200, 6,452 bytes |

**This is the empirical proof that prompt shape — not token budget — is the root cause.**

## 9. Decisions log

### 2026-04-09 — Open questions resolved (Aditya in CoFounder session)

| Question | Resolution | Reasoning |
|---|---|---|
| Q1: Direction A vs B | **A + B both** | A as immediate fix, B as durable follow-up. Same dispatch. |
| Q2: `withRetry` throw scope | **Throw on every final-attempt failure** | Unified semantics. The current swallow-then-return is the bug. |
| Q3: Hot-fix script | **Productionize per 5c** | Captured in §8 above. Standalone script deleted. |
| Q4: Customer comms | **Not needed** | Production query: 0 real customers affected. See impact analysis below. |

### 2026-04-09 — Customer impact analysis (production query)

Query run against production Supabase 2026-04-09:

```sql
SELECT owner_email,
       COUNT(*) AS total_complete,
       SUM(CASE WHEN generated_llms_txt IS NULL OR LENGTH(generated_llms_txt) = 0 THEN 1 ELSE 0 END) AS short_empty,
       SUM(CASE WHEN generated_llms_full_txt IS NULL OR LENGTH(generated_llms_full_txt) = 0 THEN 1 ELSE 0 END) AS full_empty
FROM geo_sites
WHERE pipeline_status = 'complete'
GROUP BY owner_email;
```

| Owner type | Sites | short_empty | full_empty |
|---|---|---|---|
| `ar@flowblinq.com` (test batches) | 152 | 126 | 127 |
| `batch-noreply@flowblinq.com` (system batches) | 58 | 0 | 0 |
| `an@flowblinq.com` (Aditya) | 30 | 0 | 0 |
| **All 41 other real customer owners** | **67** | **0** | **0** |

**Manipal-class bug (short empty AND full populated): 0 sites currently.**
The only Manipal-class case (Manipal itself) was hot-fixed 2026-04-08.

**The 126 `ar@flowblinq.com` empty-llms sites are a SEPARATE bug**, not TS-082's
target. Diagnosis (verified 2026-04-09):

- All 126 are owned by Rao
- All from a single 13-hour window on 2026-03-16
- All have `audit_mode = 'single'`, none domain-verified, none in batch
- All have `crawl_data` stored as a **JSON-encoded STRING** (not JSONB object)
  — a double-stringification bug at the write site
- Downstream pipeline reads `crawl_data` as object → silently no-ops research /
  exec_summary / llms.txt / business_json / schema_blocks generation
- Pipeline status still gets marked `complete` → empty fields persisted

**The double-stringification bug is dead.** Day-by-day query:

| Day | Sites created | String-typed `crawl_data` | Object-typed |
|---|---|---|---|
| 2026-03-15 | 4 | 0 | 4 |
| **2026-03-16** | **183** | **177** | **6** |
| 2026-03-17 → 2026-04-09 | 43 | **0** | 43 |

Zero recurrence since 2026-03-16. The bad code path no longer exists in the
codebase. The 126 affected rows are dead test data; no remediation required.
Flagged to Rao for cleanup at his discretion.

### 2026-04-09 — Priority downgrade

Was: **P0** (when only Manipal symptom was visible)
Now: **P1** — bug is real, fix is needed, but no real customer is currently
bleeding. TS-082 ships at normal pipeline pace.

---

**End of TS-082**
