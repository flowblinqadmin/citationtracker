# TS-086 — Tree extractor LLM call broken (wrong field name + insufficient budget + integration gaps)

**Author:** CoFounder (Agent 1)
**Date:** 2026-04-09
**Priority:** P0 — every recent geo customer is silently broken; empty geo_tree / category_tree / dimensional outputs
**Scope:** GEO app — `lib/services/tree-extractor.ts` + `app/api/sites/[id]/citation-check/route.ts`
**Related:** TS-083, TS-084 (P1, ships concurrently), TS-085 (P1, ships concurrently)
**Status:** AMENDED 2026-04-09 (round 3) per HolePoker findings HP-163-169 + HP-179/180/181/184 + SpecMaster ES-086 recon findings (LB1, LB2, LB3) + OQ-1 empirical resolution; DISPATCHED TO SCRIPTDEV

---

## 1. What

Fix two latent bugs in `lib/services/tree-extractor.ts` that have caused the lazy tree extraction code path to silently fall back to empty trees on every invocation since the bug was introduced (between 2026-03-27 and 2026-04-08), AND amend the lazy re-extraction trigger in `app/api/sites/[id]/citation-check/route.ts` so that EXISTING affected customers (who currently hold non-NULL empty trees) are rescued on their next citation check.

### 1.1 Bug summary (REFRAMED 2026-04-09 per HolePoker HP-163 + HP-164)

The original draft of this spec mis-attributed the field-name bug to ALL THREE LLM call sites. HolePoker correctly flagged this as a premise inversion. Corrected analysis below.

**Bug A — Wrong Anthropic SDK field name (lines 260 AND 403 ONLY).**
The two Anthropic Messages API call sites — `callSonnet` at line 260 and `pruneUngroundedNodes`'s correction call at line 403 — use `max_completion_tokens`. The Anthropic Messages API requires `max_tokens`. The Anthropic SDK rejects every call with HTTP 400 `"max_tokens: Field required"`. The catch block silently swallows the error and falls through.

**Line 285 is NOT a Bug A site.** Line 285 is the OpenAI fallback (`callGpt4o` → renamed to `callOpenAi` per AC-21) using model `gpt-5.4`. `gpt-5.4` is a real OpenAI reasoning model (verified — referenced in 20+ files across the codebase including `lib/services/competitor-discovery.ts`, `lib/services/content-generator.ts`, `lib/llm/claude.ts`, ES-082 §8.2, TS-081 §9). For OpenAI reasoning models, `max_completion_tokens` is the canonical field name, NOT a typo for `max_tokens`. Line 285's field name is correct and must NOT be touched.

**Bug B — Insufficient output token budget (lines 260 AND 285 BOTH affected).**
After fixing Bug A, the corrected Anthropic call still fails for multi-location, multi-category sites because `max_tokens: 8000` is insufficient. Manipal-class hospital sites need ~17K-20K output tokens to express the full geo + category + mapping JSON tree. The output truncates mid-string, `parseJsonResponse` throws, attempt fails, falls back to empty trees.

The same 8K cap applies to line 285 (gpt-5.4) and would silently fail the fallback path during Anthropic outages — empirically validated below.

**Bug C — Promise.race timeout fires before any LLM call can complete (HP-165, NEW).**
`lib/services/tree-extractor.ts:22` declares `const EXTRACTION_TIMEOUT_MS = 35_000` and uses it in a `Promise.race` against every LLM call. After fixing Bugs A and B, the corrected Sonnet call still takes 150-200s for Manipal-class sites. The 35s race fires first, every call times out, every customer falls back to `emptyGeoTree()`. **Without this fix, Bugs A and B fixes have ZERO production effect.**

**Bug D — Lazy re-extraction trigger uses JavaScript truthiness (HP-166, NEW).**
`app/api/sites/[id]/citation-check/route.ts:107` checks `!site.geoTree && !site.categoryTree && site.crawlData && site.discoveryData` before triggering re-extraction. Existing affected customers have NON-NULL empty trees (FIX-2 sentinel persisted on first failure, see Bug E). The truthiness check `!site.geoTree` is `false` for these rows → lazy re-extraction is SKIPPED → existing customers are never rescued by the field-name + budget fix alone. New customers with NULL trees ARE rescued; the ~6+ existing affected customers (per TS-083 §2.3) are NOT rescued unless an operator hand-edits each row to NULL.

**Bug E — Lazy re-extraction WRITE-side path is masked by isNull guards (NEW round 3 per SpecMaster ES-086 recon LB1).**
Even after fixing Bug D's READ-side trigger (per AC-15), the WRITE-side path is independently broken. `app/api/sites/[id]/citation-check/route.ts:122` (success UPDATE) and `:134` (FIX-2 sentinel UPDATE) BOTH use `where(and(eq(geoSites.id, siteId), isNull(geoSites.geoTree)))`. Once the FIX-2 sentinel writes a non-NULL empty tree on the first failure, NEITHER subsequent UPDATE can ever modify the row again. The rescue path's populated trees update only the in-memory `site` object (lines 124-126) — they never persist to the database.

**Failure mode without AC-23:** rescue triggers (per AC-15) → re-extract succeeds → in-memory `site` object updates → DB UPDATE silently matches 0 rows → next request reads the same FIX-2 sentinel from DB → loop forever, customer dashboard never recovers, AC-22 semaphore is the only thing preventing total system collapse.

**Bug F — FIX-2 sentinel writes a malformed tree shape (NEW round 3 per SpecMaster ES-086 recon LB2).**
`citation-check/route.ts:131-134` writes:
```ts
geoTree: { root: { id: "root", name: "Root", children: [] }, leafCount: 0 } as never,
categoryTree: { root: { id: "root", name: "Root", children: [] }, leafCount: 0 } as never,
```
This shape is missing `level`, `pageCount`, `evidence`, `extractedAt`. The correct shape (`emptyGeoTree()` at `lib/types/trees.ts:64-70`) has all of these plus `id: "global"` not `id: "root"`. The same malformed shape is used for both `geoTree` and `categoryTree` despite their correct shapes differing. The `as never` cast suppresses TypeScript. AC-15's `treeIsEmpty()` catches both shapes (it checks `leafCount` and `root.children` only), so detection still works post-AC-15 — but writing the malformed sentinel is its own typed-data integrity violation, AND post-AC-23 + AC-24 the sentinel is unnecessary anyway.

All six bugs (A, B, C, D, E, F) must be fixed together for the lazy tree extraction to actually produce populated trees AND for existing affected customers to be rescued automatically AND for the rescue to actually persist to the database.

## 2. Why

### 2.1 Production evidence (verified 2026-04-09 via diagnostic script — Sonnet)

A standalone diagnostic script (`scripts/test-tree-extract-budget.ts`) was run against the production data of test row `manipal-ts083-79f1775171a9` (a synthetic merge of customer + Aditya brand pages, 243 pages total). Five iterations revealed the Sonnet bug:

| Run | `max_tokens` | Field Name | Result |
|---|---|---|---|
| 1 | 32K | `max_completion_tokens` | API rejected: `400 "max_tokens: Field required"` |
| 2 | 8K | `max_tokens` ✓ | Sonnet returned, hit `stop_reason: max_tokens` after 26K chars (truncated mid-string in evidence URL) |
| 3 | 16K | `max_tokens` ✓ | Sonnet returned, hit `stop_reason: max_tokens` after 52K chars (truncated mid-mapping-entry) |
| 4 | 24K | `max_tokens` ✓ | SDK rejected: `"Streaming is required for operations that may take longer than 10 minutes"` |
| 5 | **20K** | **`max_tokens` ✓** | **`stop_reason: end_turn`, 17,774 output tokens, 57,604 chars, JSON parsed cleanly. geoTree.leafCount=1, categoryTree.leafCount=100, mapping.totalEntries=116** |

### 2.2 Production evidence (verified 2026-04-09 via diagnostic script — gpt-5.4 OQ-1 resolution)

A second diagnostic script (`scripts/test-tree-extract-gpt54-budget.ts`) was run against the SAME fixture, this time exercising the OpenAI reasoning model `gpt-5.4` to resolve HolePoker's OQ-1 (the concern that gpt-5.4 might consume internal reasoning tokens against the output budget). Three budgets tested:

| Budget | Latency | finish_reason | input | completion | reasoning | parsed | geo_leaf | cat_leaf | mapping |
|---|---|---|---|---|---|---|---|---|---|
| 20K | 181.8s | `stop` | 29,908 | 10,555 | **0** | ✓ | 1 | 31 | 36 |
| 30K | 167.9s | `stop` | 29,908 | 10,207 | **0** | ✓ | 1 | 33 | 39 |
| 40K | 178.9s | `stop` | 29,908 | 9,769 | **0** | ✓ | 1 | 27 | 28 |

**Definitive findings:**
1. **gpt-5.4 used ZERO reasoning tokens** for tree extraction across all three budgets. OQ-1's hypothesis (that gpt-5.4 might burn 5-15K reasoning tokens internally) is empirically refuted for this prompt shape.
2. **All three budgets succeeded with `finish_reason: stop`** (natural completion, not max-tokens cap). Comfortable headroom across the board.
3. **gpt-5.4 produces ~60% smaller trees than Sonnet** for the same fixture (10K output vs 17K, 31 cat-leaves vs 100). This is acceptable for a fallback path: degraded but functional is better than empty.
4. **20K is the empirical sweet spot for gpt-5.4 too** — same as Sonnet, for consistency. The model produces a fixed-size response regardless of budget, so larger budgets don't yield richer trees.

### 2.3 Why every recent customer is affected

Looking at the empty `geo_tree` shape stored in production geo_sites rows:

```json
{
  "root": { "id": "global", "name": "Global", "level": "global", "children": [], "evidence": [], "pageCount": 0 },
  "leafCount": 0,
  "extractedAt": "2026-04-08T08:50:49.273Z"
}
```

This is **exactly** the shape returned by `emptyGeoTree()` at `lib/types/trees.ts:64-70`. The `extractedAt` timestamp is the only thing that changes — it's set when the function returns. Every site whose geo_tree matches this shape has had a failed extraction.

Aditya's test site `s8nbVx-w_XAf9Hzni_FBU` (crawled 2026-03-27) has a populated geo_tree with real city evidence. The bug was introduced between 2026-03-27 and 2026-04-08.

### 2.4 Cascade impact

Empty trees → empty `geo_visibility`, empty `category_visibility` (or `categoryId: "unknown"`), empty `tier_visibility`, partial `pillar_visibility` (5 keys instead of 7 because the category extraction can't anchor on canonical categories).

For Manipal customer specifically:
- Customer dashboard "Citation visibility by theme" → empty
- "Geographic performance by coverage" → empty
- "Category performance" → 1 entry labeled "unknown"
- "Buyer intent coverage" → 0 mentions across learn/solve/buy tiers

### 2.5 Why max_tokens=20000 is the right value

- **8K** is insufficient for both Sonnet and gpt-5.4 effective output (Sonnet: empirically truncated at 26K chars; gpt-5.4: would be tight if the model ever produced its 10K natural output)
- **16K** is insufficient for Sonnet (proven empirically — truncated at 52K chars)
- **24K** triggers the Anthropic SDK's 10-minute streaming requirement (the SDK estimates max_tokens × processing rate and requires streaming for >10min ops)
- **20K** is the sweet spot for both providers — high enough for Manipal-class hospital chains (Sonnet 17,774 tokens, gpt-5.4 10,555 tokens), low enough to stay synchronous

For SaaS sites with smaller trees (~3-5K output tokens), the higher budget has zero cost impact because both Anthropic and OpenAI bill on actual tokens consumed, not budget.

### 2.6 Why existing affected customers need an explicit rescue path (HP-166)

The lazy re-extraction at `app/api/sites/[id]/citation-check/route.ts:107` was originally written to handle NULL trees only (`!site.geoTree`). The function under `lib/services/tree-extractor.ts:emptyGeoTree()` persists empty trees as REAL objects, not NULL. JavaScript truthiness evaluates `!{root:{...}, leafCount:0}` as `false`, so existing affected sites bypass the lazy trigger entirely.

The Manipal customer was rescued during this investigation only because Aditya manually `UPDATE`d the geo_sites row to set `geo_tree = NULL`. Other affected customers have no equivalent intervention. The fix must detect empty trees by STRUCTURE (`leafCount === 0` OR `root.children.length === 0`) so the rescue path triggers automatically on the next citation check.

## 3. Acceptance criteria

### 3.1 Field name fix (Bug A)

- [ ] **AC-1:** `lib/services/tree-extractor.ts:260` (Sonnet attempt 1) uses `max_tokens`, NOT `max_completion_tokens`.
- [ ] **AC-2:** `lib/services/tree-extractor.ts:285` (gpt-5.4 OpenAI fallback) **STAYS** at `max_completion_tokens` — this is the canonical field for OpenAI reasoning models. **No field rename.** Model id stays as `"gpt-5.4"` (verified canonical, NOT a typo for `gpt-4o`). The only line-285 change is the budget bump (see AC-5).
- [ ] **AC-3:** `lib/services/tree-extractor.ts:403` (Sonnet correction call inside `pruneUngroundedNodes`) uses `max_tokens`, NOT `max_completion_tokens`.

### 3.2 Token budget fix (Bug B)

- [ ] **AC-4:** `lib/services/tree-extractor.ts:260` Sonnet call uses `max_tokens: 20000`. Empirically validated against the Manipal fixture; produces a populated tree with 17,774 output tokens and `stop_reason: end_turn`.
- [ ] **AC-5:** `lib/services/tree-extractor.ts:285` gpt-5.4 call uses `max_completion_tokens: 20000`. Empirically validated against the Manipal fixture across 20K/30K/40K; gpt-5.4 produces ~10,555 output tokens with `finish_reason: stop` and ZERO reasoning tokens. 20K matches the Sonnet budget for consistency.
- [ ] **AC-6:** `lib/services/tree-extractor.ts:403` correction call STAYS at `max_tokens: 2000` (correction prompts are small, no need to bump).

### 3.3 Smoke + integration tests

- [ ] **AC-7:** A new unit test asserts that calling `extractTrees` against a Manipal-class fixture (real production crawl_data with ~200 multi-city, multi-specialty pages) produces `geoTree.leafCount > 0` AND `categoryTree.leafCount > 0`. Fixture is derived from the test row `manipal-ts083-79f1775171a9` crawl_data, captured to `__tests__/fixtures/tree-extract-manipal.json`. **This fixture is shared with TS-085 AC-1 (single source of truth — see HP-172 amendment).**
- [ ] **AC-8:** A new unit test asserts that the function does NOT throw and does NOT return `emptyGeoTree()` for the Manipal fixture. Specifically: `result.geoTree.root.children.length > 0`.
- [ ] **AC-9:** A regression test using a SaaS-style fixture (single-domain, ~50 pages) confirms that the higher token budget does NOT regress smaller-site behavior. Output should be a small populated tree, not over-budget consumption.
- [ ] **AC-10:** An integration test that hits the lazy tree extraction code path in `app/api/sites/[id]/citation-check/route.ts` against a test database row with NULL trees. Asserts post-call that `geoTree IS NOT NULL` AND `geoTree.leafCount > 0` AND `categoryTree.leafCount > 0`.

### 3.4 Diagnostic script lifecycle

- [ ] **AC-11:** Two diagnostic scripts (`scripts/test-tree-extract-budget.ts` for Sonnet, `scripts/test-tree-extract-gpt54-budget.ts` for gpt-5.4) are **kept** as runnable diagnostic tools. Both bypass the production code path's `Promise.race` wrapper to directly probe SDK behavior — useful for future SDK regressions independent of EXTRACTION_TIMEOUT_MS. Documented in script headers.

### 3.5 Promise.race timeout fix (Bug C, HP-165 — NEW)

- [ ] **AC-12:** `lib/services/tree-extractor.ts:22` declares `const EXTRACTION_TIMEOUT_MS = 200_000` (200 seconds, up from 35_000). Any stale comment referencing "35 seconds" or similar is removed in the same commit. Rationale: real Manipal-class extractions take 150-200s end-to-end (verified empirically — see §2.1 row 5 and §2.2 across all budgets). 200s gives a 25-50s safety margin.
- [ ] **AC-13:** A unit test exercises the `Promise.race` wrapper with a mocked LLM call that resolves at ~60s. Asserts the wrapped call returns successfully (i.e., the timeout does NOT fire prematurely). This is a regression guard against future under-budget timeouts.
- [ ] **AC-14:** A unit test exercises the `Promise.race` wrapper with a mocked LLM call that resolves at ~250s. Asserts the wrapped call rejects at ~200s with a recognizable timeout error (the existing error path). This is the upper-bound guard.

### 3.6 Lazy re-extraction trigger fix (Bug D, HP-166 — NEW)

- [ ] **AC-15:** `app/api/sites/[id]/citation-check/route.ts` declares an INLINE helper at the top of the file (NOT in a shared utils module — this is a single-call-site helper):
  ```ts
  function treeIsEmpty(t: unknown): boolean {
    if (!t || typeof t !== "object") return true;
    const obj = t as { leafCount?: unknown; root?: { children?: unknown } };
    if (obj.leafCount === 0) return true;
    if (!Array.isArray(obj.root?.children) || obj.root.children.length === 0) return true;
    return false;
  }
  ```
  The lazy re-extraction trigger at line 107 is amended from `if (!site.geoTree && !site.categoryTree && site.crawlData && site.discoveryData) { … }` to:
  ```ts
  if (
    (treeIsEmpty(site.geoTree) || treeIsEmpty(site.categoryTree)) &&
    site.crawlData &&
    site.discoveryData
  ) {
    // re-extract
  }
  ```
  **Schema verification (per CLAUDE.md spec rigour rule, 2026-04-09):** the geo_sites table at `lib/db/schema.ts:106-107` has ONLY `geoTree` and `categoryTree` columns. There are NO `tierTree` or `pillarTree` columns. Tier and pillar visibility are computed at citation-check time from the actual response data, not stored as trees. The original draft of this AC referenced `site.tierTree` / `site.pillarTree` — those fields do not exist (per HolePoker HP-179) and are removed.

  The trigger preserves the existing AND-with-`crawlData`/`discoveryData` guard so we don't attempt re-extraction on sites missing the prerequisite inputs. The structural-emptiness check (`treeIsEmpty` OR `treeIsEmpty`) replaces the prior null-only check.

  Helper lives in the same route file, not in a shared utils/types module. The contract is local to this code path; broader use is out of scope.
- [ ] **AC-16:** A new integration test uses an explicit non-NULL empty tree fixture (the literal output of `emptyGeoTree()`) and asserts:
  1. `treeIsEmpty(fixture.geoTree) === true`
  2. The lazy re-extraction trigger DOES fire for this fixture
  3. After `extractTrees` completes (with the AC-1..AC-6 fixes), the persisted geo_tree has `leafCount > 0` and `root.children.length > 0`
  This is the canary test that proves existing affected customers get rescued.

### 3.7 Schema validation gap (HP-167 — NEW)

- [ ] **AC-17:** `parseJsonResponse` in `lib/services/tree-extractor.ts` (or its caller, depending on where the JSON arrives) gains a hand-rolled runtime schema validator (NOT zod — keep it dependency-free) that asserts:
  - `geoTree.leafCount` is a number
  - `geoTree.root` is an object with `children` as an array
  - `categoryTree.leafCount` is a number
  - `categoryTree.root` is an object with `children` as an array
  - `mapping` is an object with `entries` as an array
  - All other fields the production code reads downstream
  On validation failure, throw `TreeExtractorSchemaError` (see AC-18). The caller's catch block logs the error with `{domain, attempt, schemaError: err.message}` so failures are observable, then proceeds to the next attempt (or `emptyGeoTree()` last resort).
- [ ] **AC-18:** A new typed error class `TreeExtractorSchemaError extends Error` is added inside `lib/services/tree-extractor.ts` (file-local — not in a shared errors module, since this is the only producer and consumer).

### 3.8 Retry policy refinement (HP-168 — NEW)

- [ ] **AC-19:** The Sonnet primary attempt's catch block distinguishes by error type. Per HolePoker HP-180, the original "existing behavior" wording was ambiguous; the explicit table below replaces it:

  | Error type | Detection | Action |
  |---|---|---|
  | **Promise.race timeout** | Caught error matches the timeout sentinel from AC-12 | **Skip** Sonnet temp-0.3 retry. Fall through directly to gpt-5.4 fallback. Rationale: Sonnet hit wall-clock limit; temp jiggle won't help, and another 200s of budget burn delays gpt-5.4 unnecessarily. |
  | **Schema validation error** | `err instanceof TreeExtractorSchemaError` | **Retry** Sonnet at `temperature: 0.3`. Rationale: model produced output, just malformed. Temperature jiggle may help. |
  | **Anthropic overload (503 / 529)** | `err.status === 503 \|\| err.status === 529` | **Skip** Sonnet temp-0.3 retry. Fall through to gpt-5.4. Same reasoning as timeout — Anthropic explicitly signaling overload; retrying immediately won't help. |
  | **Auth / config error (400 / 401 / 403)** | `err.status === 400 \|\| 401 \|\| 403` | **Fail fast.** No retry, no fallback. These are configuration bugs (bad API key, malformed prompt) that should surface immediately to logs and never silently fall through. The route returns the error to the caller; the empty-tree fallback is NOT engaged. |
  | **Network error** (`ECONNRESET`, `EAI_AGAIN`, `ETIMEDOUT`, `EPIPE`) | `err.code` matches one of the listed values | **Retry** Sonnet at `temperature: 0.3` once. Rationale: transient connectivity may benefit from one immediate retry. If the retry also network-errors, fall through to gpt-5.4. |
  | **Anything else** | Catch-all | **Fall through to gpt-5.4** (conservative default). Logged at `console.error` with `{domain, attempt, errType: err.name, errMsg: err.message, errStatus: err.status}` so unexpected error shapes are observable. |

  The detection table is implemented as a single `classifySonnetError(err)` helper inside `lib/services/tree-extractor.ts` returning a discriminated union. The catch block consumes the discriminant and dispatches accordingly. Unit-tested with synthetic errors for each row.

### 3.9 Citation-check route maxDuration (HP-168 — NEW)

- [ ] **AC-20:** `app/api/sites/[id]/citation-check/route.ts` exports `export const maxDuration = 600` (up from 300). Rationale: worst-case path is now ~405s (200s Sonnet timeout + 200s gpt-5.4 + 5s correction). With AC-19 short-circuiting the temp-0.3 retry on timeout, the realistic worst case drops to ~200s (single Sonnet success). The 600s ceiling absorbs the rare cases where both providers are slow.

### 3.10 Stale function name + comments (HP-163 / HP-169 — NEW)

- [ ] **AC-21:** Documentation hygiene — no behavioral change. **Enumeration corrected 2026-04-09 round 3 per SpecMaster ES-086 recon LB3 + CoFounder verification grep.** The original draft showed ONE GPT-4o reference; the actual file has **NINE** references that all need updating in a single coordinated rename pass. Verbatim list with line numbers:

  | Line | Reference | Change |
  |---|---|---|
  | 5 | `// * Primary: Claude Sonnet 4 → Fallback: GPT-4o → Last resort: empty trees.` (file header) | `→ Fallback: OpenAI (gpt-5.4 reasoning model) →` |
  | 277 | `async function callGpt4o(userPrompt: string): Promise<TreeExtractionResult \| null> {` | Rename function to `callOpenAi` |
  | 293 | `setTimeout(() => reject(new Error("GPT-4o timeout")), EXTRACTION_TIMEOUT_MS)` | `new Error("OpenAI timeout")` |
  | 476 | `* Primary: Claude Sonnet 4 → Fallback: GPT-4o → Last resort: empty trees.` (extractTrees JSDoc header) | Same as line 5 |
  | 518 | `// Attempt 3: GPT-4o` (code comment) | `// Attempt 3: OpenAI (gpt-5.4)` |
  | 520 | `const result = await callGpt4o(userPrompt);` (caller site) | `await callOpenAi(userPrompt)` |
  | 524 | `console.info(\`[extract-trees] ${domain}: trees extracted via GPT-4o\`);` | `... via OpenAI (gpt-5.4)` |
  | 528 | `console.warn(\`[extract-trees] ${domain}: GPT-4o validation failed: ...\`);` | `OpenAI validation failed` |
  | 531 | `console.warn(\`[extract-trees] ${domain}: GPT-4o failed: ...\`);` | `OpenAI failed` |

  **ScriptDev grep gate:** after the rename, `grep -nE "GPT-4o\|gpt-4o\|callGpt4o" lib/services/tree-extractor.ts` MUST return zero matches. This is the regression check that confirms the rename is complete. Note: `gpt-5.4` (the model id string at line 287) is canonical and stays — only the historical `gpt-4o` / `GPT-4o` strings get renamed.

### 3.11 Re-extraction thundering-herd guard (HP-178 — NEW)

- [ ] **AC-22:** A global semaphore caps concurrent tree re-extractions to **3** at any time. Implementation:
  - **Minimum:** in-process counter (e.g., a `Map<"reextract", number>` or a simple `let activeReextractions = 0` module-level variable, guarded by `setInterval` cleanup if needed). Lives in `app/api/sites/[id]/citation-check/route.ts` or a small new helper file (`lib/services/tree-extract-semaphore.ts`). Acceptable for v1.
  - **Ideal:** Redis-backed counter using the existing Upstash pattern (atomic INCR/DECR with a TTL fallback). Allows concurrency cap to hold across Vercel serverless instances. Recommended for production but can land in a follow-up if v1 in-process works under load.

  **Semaphore-saturated path (AMENDED 2026-04-09 per HolePoker HP-181):** when the semaphore limit is hit, the citation-check route **proceeds with the citation check using the existing (empty) trees** — exactly today's pre-fix behavior — and surfaces a UX banner on the result:

  ```ts
  // Inside the SSE stream, after the credit deduction at lines 65-89 has already committed:
  if (treeIsEmpty(site.geoTree) || treeIsEmpty(site.categoryTree)) {
    if (activeReextractions >= MAX_CONCURRENT_REEXTRACTIONS) {
      // Saturated — skip re-extraction, proceed with empty trees, flag the result
      enrichedSite = { ...site, treeReextractionDeferred: true };
    } else {
      // Slot available — re-extract synchronously
      activeReextractions++;
      try { /* extractTrees call */ } finally { activeReextractions--; }
    }
  }
  ```

  The dashboard sees `treeReextractionDeferred: true` on the citation check result and displays a banner ON the result (not a replacement for it): *"Dimensional data is regenerating — your next citation check will include geographic and category breakdowns."* The customer always gets value for the 5 credits already deducted at route.ts lines 65-89 (the citation check itself runs to completion). The dimensional rescue happens on a later call when the semaphore has capacity.

  **Why the proceed-with-empty path is correct:** credits are deducted upfront at `app/api/sites/[id]/citation-check/route.ts:65-89`, BEFORE the SSE stream starts. The original AC-22 wording ("return early with empty response") would have charged the customer 5 credits and delivered nothing — a billing bug per HolePoker HP-181. The amended path matches today's pre-fix behavior (citation check runs even when trees are empty) plus a forward-looking UX hint.

  Rationale for the cap itself: after deploy, the wave of customers hitting their first citation check could trigger many parallel re-extractions and exhaust Anthropic's rate budget. AC-22 caps the burst.

### 3.12 Lazy re-extraction WRITE-side path fix (Bug E + Bug F — NEW round 3 per SpecMaster ES-086 recon)

- [ ] **AC-23 NEW:** Drop the `isNull(geoSites.geoTree)` clause from the success UPDATE at `app/api/sites/[id]/citation-check/route.ts:122`. The amended UPDATE becomes:

  ```ts
  await db.update(geoSites).set({
    geoTree: trees.geoTree,
    categoryTree: trees.categoryTree,
    geoCategoryMapping: trees.mapping,
  }).where(eq(geoSites.id, siteId));
  ```

  **Why the isNull guard must go:** post-AC-15 the lazy trigger fires for empty-but-non-NULL trees too (the canonical case for existing affected customers). The `isNull` clause was originally added as a concurrency guard to prevent concurrent overwrites during double-fire, but it's the wrong tool: AC-22's semaphore (max 3 concurrent re-extractions) is now the correct concurrency bound. Without dropping the isNull clause, the rescue UPDATE would silently match 0 rows for any row that already had a sentinel write, the in-memory `site` object would have new trees that never persist, and the next request would read the same stale sentinel from DB. AC-15 alone is INSUFFICIENT — it amends the READ trigger but not the WRITE guard.

  Per SpecMaster ES-086 recon LB1: this is the canary issue that proves the WRITE path is independently broken from the READ path. ScriptDev MUST ship AC-23 in the same commit as AC-15.

- [ ] **AC-24 NEW:** Delete the FIX-2 sentinel UPDATE at `app/api/sites/[id]/citation-check/route.ts:131-134` ENTIRELY. The amended catch path becomes:

  ```ts
  } catch (err) {
    console.warn(`[citation-check] ${site.domain}: lazy tree extraction failed: ${(err as Error).message}`);
    // Note: NO sentinel write. Post-AC-15 the rescue trigger detects empty
    // trees structurally via treeIsEmpty(), so a "don't retry" marker is
    // unnecessary. Failed extractions leave the trees as-is (NULL or pre-
    // existing empty), and the next citation check tries again. The AC-22
    // semaphore caps the retry burst.
  }
  ```

  **Why the sentinel must be deleted, not just fixed:**
  1. Post-AC-15 the trigger uses `treeIsEmpty()` (structural check), so a "don't retry" marker is unnecessary
  2. The current sentinel writes a MALFORMED shape (Bug F): missing `level`, `pageCount`, `evidence`, `extractedAt`, and uses `id: "root"` instead of `id: "global"`. The same shape is used for `geoTree` AND `categoryTree` despite their correct shapes differing
  3. The `as never` cast was suppressing TypeScript — a typed-data integrity violation
  4. AC-22's semaphore already caps the retry burst, so removing the "don't retry" marker doesn't open a thundering-herd risk
  5. Future regressions to the data integrity surface are easier to catch when there's no place writing malformed shapes

  Per SpecMaster ES-086 recon LB2.

## 4. Out of scope

- **TS-083** (auto-discover brand-level pages in bulk audit) — sibling spec, ships concurrently. P1.
- **TS-084** (tree extractor timing race against chunked crawl) — sibling spec, ships concurrently. P1 (promoted from P2 per HP-177; the original TS-086 framing that "lazy re-extraction handles this case" was wrong because the lazy trigger used truthiness — see Bug D / AC-15. TS-084's prevention layer is needed for FUTURE bulk audits; AC-15 handles the rescue path for EXISTING customers).
- **TS-085** (pageType classifier under-classification in bulk mode) — sibling spec, ships concurrently. P1.
- **Switching to streaming API** — not needed for 20K tokens (verified empirically — the 24K boundary is where streaming becomes mandatory).
- **Re-architecting the Anthropic / OpenAI client wrappers** — keep the existing `Anthropic()` and `OpenAI()` direct usage. Refactor out-of-scope.
- **Adding finer-grained error logging beyond AC-17's typed error path** — `[extract-trees] ${domain}: Sonnet attempt 1 failed: ${err.message}` logs already exist; the bug was that nobody was reading them. Out of scope for code change; possibly worth a follow-up monitoring/alerting TS.
- **Backfilling existing affected customers via a script** — AC-15 handles automatic rescue on next citation check. A proactive backfill script (similar to TS-081's T226/T227) is a possible follow-up but not required for v1.

## 5. Risks

### 5.1 Regression risk on sites that previously worked

The fix changes behavior of every site that runs through the lazy tree extraction. Specifically: instead of returning empty trees, the function will now return populated trees. Downstream consumers (`app/api/sites/[id]/citation-check/route.ts:118-126` writes the result back to geo_sites) expect the previous shape.

**Mitigation:** the response shape is identical between empty and populated trees — only the `children` and `evidence` arrays are populated. No new fields. No type changes. Existing consumers are unaffected.

**Verification:** AC-10 + AC-16 integration tests exercise the full citation-check route against real test rows.

### 5.2 Cost impact (REWRITTEN per HP-168)

Each Sonnet call now consumes up to ~20K output tokens. Anthropic billing is per actual token consumed, not budget:
- **Happy path** (Sonnet succeeds first try): ~$0.30 per extraction for Manipal-class sites, ~$0.05 for SaaS sites
- **Worst case** (Sonnet times out → temp-0.3 retry → gpt-5.4 fallback → correction call): ~$0.80 per extraction (3× the happy-path cost)
- **AC-19 mitigation:** skipping the temp-0.3 retry on timeout drops the worst case to ~$0.50 (Sonnet attempt + gpt-5.4 + correction)

Lazy tree extraction runs once per site per citation check (gated by `treeIsEmpty(...)` post-AC-15). Cost amortizes over the entire site lifetime.

**Mitigation:** AC-22 semaphore caps concurrent re-extractions at 3, so the deploy-day surge is bounded. Cost is appropriate for the value (populated dimensional dashboard data).

### 5.3 Latency impact (REWRITTEN per HP-165 + HP-168)

At 8K tokens (broken), the call rejected immediately (~50ms) and fell through to empty trees. After the fix:
- **Single Sonnet attempt** (the common case): 150-200s for Manipal-class sites
- **Worst case** (Sonnet timeout + temp-0.3 retry + gpt-5.4 + correction): up to ~605s — 200s timeout + 200s temp-0.3 retry + 200s gpt-5.4 + ~5s correction
- **AC-19 mitigation:** skipping the temp-0.3 retry on timeout drops the worst case to ~405s (200s Sonnet timeout + 200s gpt-5.4 + 5s correction)
- **AC-20 mitigation:** `maxDuration: 600` absorbs the realistic worst case with margin

The first citation check on any affected site now takes a perceptible amount of time. Subsequent citation checks short-circuit because trees are populated.

### 5.4 Schema validation gap (NEW per HP-167)

`parseJsonResponse` previously fail-opened on malformed LLM responses — partial JSON, missing fields, or type mismatches would propagate downstream and crash consumers. AC-17 closes this gap with hand-rolled validation that throws `TreeExtractorSchemaError` on failure, allowing the caller to retry (per AC-19) or fall through cleanly.

### 5.5 Re-extraction thundering herd (NEW per HP-178; text amended 2026-04-09 round 2 per HP-184)

After deploy, the wave of customers hitting their first post-deploy citation check could trigger many parallel re-extractions, spiking Anthropic costs and exhausting rate budgets. AC-22 caps concurrent re-extractions at 3, so the burst is bounded. Customers above the cap have their citation check **run to completion using the existing (empty) trees** — exactly today's pre-fix behavior — with a `treeReextractionDeferred: true` flag on the result so the dashboard can display a UX banner ("Dimensional data is regenerating — your next citation check will include geographic and category breakdowns"). The dimensional rescue happens on a later call when the semaphore has capacity. The customer always gets value for the 5 credits already deducted at `app/api/sites/[id]/citation-check/route.ts:65-89` (the citation check itself), and the route NEVER returns early.

### 5.6 Anthropic SDK version drift

The fix assumes the current Anthropic SDK version expects `max_tokens`. Verify the SDK version in `geo/package.json` and confirm the field name against the SDK's TypeScript types.

**Mitigation:** AC-7 + AC-13 unit tests fail fast if the field name regresses again (the runtime error is now structurally caught by AC-17's schema validation too).

## 6. Open questions

**OQ-1 RESOLVED 2026-04-09 (empirical):** gpt-5.4 reasoning token consumption against `max_completion_tokens` budget. Diagnostic script `scripts/test-tree-extract-gpt54-budget.ts` was run against the Manipal fixture at 20K, 30K, and 40K budgets. All three runs returned `reasoning_tokens: 0` and `finish_reason: stop`. The hypothesis that gpt-5.4 burns 5-15K reasoning tokens internally is refuted for tree-extraction prompts. The 20K budget is empirically validated as sufficient with comfortable headroom.

No other open questions. Ship as drafted.

## 7. Cross-reference

- Sibling specs: TS-083 (auto-discover brand pages, P1), TS-084 (tree extractor timing race, P1), TS-085 (pageType classifier regression, P1). All four together form the bulk-audit dimensional data fix.
- Related: ES-053 (original tree extraction spec — predates the bug).
- Diagnostic evidence: `scripts/test-tree-extract-budget.ts` (Sonnet sweep) + `scripts/test-tree-extract-gpt54-budget.ts` (gpt-5.4 OQ-1 sweep).
- HolePoker findings: `.agents/comms/inbox/1-cofounder/20260409T110000Z-hp-findings-ts083-086.yaml`
- CoFounder batch response (16 findings, all ACCEPT): `.agents/comms/inbox/5-holepoker/20260409T120000Z-hp163-178-batch-response.yaml`
- HolePoker re-evaluation (16/16 accepted): `.agents/comms/inbox/1-cofounder/20260409T120500Z-hp163-178-evaluations.yaml`
- Thread file: `.agents/comms/threads/hp-review-bulk-audit-fixes.yaml`

## 8. Reference: the exact diff

### 8.1 `lib/services/tree-extractor.ts`

```diff
@@ Line 5 (file header) @@
- // Fallback: GPT-4o
+ // Fallback: OpenAI (gpt-5.4 reasoning model)

@@ Line 22 @@
- const EXTRACTION_TIMEOUT_MS = 35_000;
+ const EXTRACTION_TIMEOUT_MS = 200_000; // 200s — empirically required for Manipal-class extractions (was 35_000, which fired before any Sonnet/gpt-5.4 call could complete; see TS-086 §2.1)

@@ Line 257-262 — callSonnet @@
   const client = new Anthropic({ apiKey });
   const response = await Promise.race([
     client.messages.create({
       model: "claude-sonnet-4-6",
-      max_completion_tokens: 8000,
+      max_tokens: 20000,
       temperature,
       system: SYSTEM_PROMPT,

@@ Line ~280-290 — callGpt4o → callOpenAi (function rename + budget bump only) @@
- async function callGpt4o(userPrompt: string): Promise<TreeExtractionResult | null> {
+ async function callOpenAi(userPrompt: string): Promise<TreeExtractionResult | null> {
   ...
   const response = await Promise.race([
     client.chat.completions.create({
       model: "gpt-5.4",                      // ← canonical reasoning model id, NOT a typo
-      max_completion_tokens: 8000,
+      max_completion_tokens: 20000,          // ← canonical OpenAI reasoning field; only budget bumps
       temperature: 0,
       messages: [

@@ Line 293 (or wherever the OpenAI fallback error message lives) @@
- console.error(`[extract-trees] GPT-4o fallback failed: ${err.message}`);
+ console.error(`[extract-trees] OpenAI fallback failed: ${err.message}`);

@@ Line ~399-405 — pruneUngroundedNodes correction call @@
         const response = await Promise.race([
           client.messages.create({
             model: "claude-sonnet-4-6",
-            max_completion_tokens: 2000,
+            max_tokens: 2000,
             temperature: 0,
             messages: [{ role: "user", content: correctionPrompt }],

@@ Caller site of callGpt4o (rename only) @@
- const fallbackResult = await callGpt4o(userPrompt);
+ const fallbackResult = await callOpenAi(userPrompt);
```

Plus the new additions in the same file (locations approximate, ScriptDev places them logically):

```ts
// New: typed error for schema validation failures (AC-18)
class TreeExtractorSchemaError extends Error {
  constructor(message: string, public readonly field: string) {
    super(message);
    this.name = "TreeExtractorSchemaError";
  }
}

// New: hand-rolled schema validator (AC-17)
function validateExtractionResponse(parsed: unknown): asserts parsed is TreeExtractionResult {
  if (!parsed || typeof parsed !== "object") {
    throw new TreeExtractorSchemaError("response is not an object", "root");
  }
  const obj = parsed as Record<string, unknown>;
  if (!obj.geoTree || typeof obj.geoTree !== "object") {
    throw new TreeExtractorSchemaError("geoTree missing or not an object", "geoTree");
  }
  // ... checks for leafCount, root.children array, categoryTree, mapping.entries, etc.
}
```

And the catch-block refinement (AC-19) — distinguish timeout, schema-error, and other-error.

### 8.2 `app/api/sites/[id]/citation-check/route.ts`

```diff
@@ Top of file @@
+ // Inline helper — single call site, not promoted to shared utils per TS-086 AC-15
+ function treeIsEmpty(t: unknown): boolean {
+   if (!t || typeof t !== "object") return true;
+   const obj = t as { leafCount?: unknown; root?: { children?: unknown } };
+   if (obj.leafCount === 0) return true;
+   if (!Array.isArray(obj.root?.children) || obj.root.children.length === 0) return true;
+   return false;
+ }

@@ Line 21 (maxDuration export) @@
- export const maxDuration = 300;
+ export const maxDuration = 600; // TS-086 AC-20: absorb worst-case ~405s extraction (Sonnet timeout + gpt-5.4 + correction)

@@ Line 107 — lazy re-extraction trigger (AMENDED 2026-04-09 per HP-179) @@
- if (!site.geoTree && !site.categoryTree && site.crawlData && site.discoveryData) {
+ if (
+   (treeIsEmpty(site.geoTree) || treeIsEmpty(site.categoryTree)) &&
+   site.crawlData &&
+   site.discoveryData
+ ) {
   const reextracted = await extractTrees(site.crawlData, site.domain);
   ...
 }

@@ Line 122 — success UPDATE (AMENDED 2026-04-09 round 3 per AC-23) @@
- }).where(and(eq(geoSites.id, siteId), isNull(geoSites.geoTree)));
+ }).where(eq(geoSites.id, siteId));

@@ Lines 131-134 — FIX-2 sentinel write (DELETED 2026-04-09 round 3 per AC-24) @@
- // FIX-2: store empty sentinel so extraction isn't retried on every check
- await db.update(geoSites).set({
-   geoTree: { root: { id: "root", name: "Root", children: [] }, leafCount: 0 } as never,
-   categoryTree: { root: { id: "root", name: "Root", children: [] }, leafCount: 0 } as never,
- }).where(and(eq(geoSites.id, siteId), isNull(geoSites.geoTree)));
+ // (Sentinel write deleted — see AC-24. Post-AC-15 the rescue trigger
+ //  detects empty trees structurally; AC-22 semaphore caps retry burst.)
```

Schema verification (per CLAUDE.md spec rigour rule): geo_sites table at `lib/db/schema.ts:106-107` has ONLY `geoTree` and `categoryTree`. There are NO `tierTree`/`pillarTree` columns. The trigger checks only the two trees that exist.

Plus the AC-22 semaphore (top of file or new helper module — see AC-22 §3.11 for the proceed-with-empty-trees path). Sketch:

```ts
// Module-level state — process-scoped for v1 (Redis-backed in follow-up)
let activeReextractions = 0;
const MAX_CONCURRENT_REEXTRACTIONS = 3;

// At the lazy re-extraction call site (inside the SSE stream, AFTER credits already deducted at lines 65-89):
let enrichedSite = site;
if (treeIsEmpty(site.geoTree) || treeIsEmpty(site.categoryTree)) {
  if (activeReextractions >= MAX_CONCURRENT_REEXTRACTIONS) {
    // Saturated — proceed with citation check using empty trees
    enrichedSite = { ...site, treeReextractionDeferred: true };
  } else {
    activeReextractions++;
    try {
      const reextracted = await extractTrees(site.crawlData, site.domain);
      // ... persist + enrich
    } finally {
      activeReextractions--;
    }
  }
}
// Citation check proceeds with enrichedSite — never returns early.
```

The citation check **always runs to completion**. Customer is never charged credits without delivery (per HP-181). The `treeReextractionDeferred` flag is a UX hint surfaced as a banner ON the result.

## 9. Decisions log (NEW)

| Date | Decision | Source | Note |
|---|---|---|---|
| 2026-04-09 | OQ-1 resolved empirically: gpt-5.4 budget = 20K | Diagnostic script `test-tree-extract-gpt54-budget.ts` | Three runs at 20K/30K/40K all returned `reasoning_tokens: 0` and `finish_reason: stop`. 20K matches Sonnet for symmetry. |
| 2026-04-09 | Bug A reframe: line 285 NOT affected | HolePoker HP-163 + HP-164 | gpt-5.4 is real OpenAI reasoning model; `max_completion_tokens` is canonical. Original spec inverted the premise. |
| 2026-04-09 | Bug C added: EXTRACTION_TIMEOUT_MS bump | HolePoker HP-165 | 35s race fired before any 150-200s LLM call could complete; bumped to 200s with margin. |
| 2026-04-09 | Bug D added: lazy trigger by structure | HolePoker HP-166 | Truthiness check skipped existing customers with non-NULL empty trees; AC-15 fix is the canonical rescue path. |
| 2026-04-09 | TS-084 promoted P2 → P1 | HolePoker HP-177 | Original framing "TS-086 lazy re-extraction handles this" was wrong; TS-084 retains its prevention-layer value. |
| 2026-04-09 | AC-22 semaphore added | HolePoker HP-178 | Deploy-day surge risk; in-process v1, Redis-backed v2. |
| 2026-04-09 | Schema validation added | HolePoker HP-167 | Hand-rolled, no zod, file-local error class. |
| 2026-04-09 | Retry policy refined | HolePoker HP-168 | Skip temp-0.3 retry on TIMEOUT; keep on schema-error. |
| 2026-04-09 | Function rename | HolePoker HP-163 / HP-169 | callGpt4o → callOpenAi; comments/error messages updated. |
| 2026-04-09 (round 2) | AC-15 trigger drops tierTree/pillarTree | HolePoker HP-179 | Schema only has geoTree + categoryTree. Verified at `lib/db/schema.ts:106-107`. tier/pillar visibility computed at runtime, not stored. |
| 2026-04-09 (round 2) | AC-19 explicit error-type table | HolePoker HP-180 | Replaced ambiguous "existing behavior" with explicit per-error-type dispatch (timeout / schema / overload / auth / network / other). |
| 2026-04-09 (round 2) | AC-22 proceed-with-empty-trees | HolePoker HP-181 | Original "return early" was a billing bug — credits deducted at route.ts:65-89 BEFORE the SSE stream. Amended path always runs the citation check; semaphore-saturated case sets `treeReextractionDeferred: true` flag for UX banner. |
| 2026-04-09 (round 3) | AC-23 NEW — drop isNull guard from success UPDATE | SpecMaster ES-086 recon LB1 | The READ-side AC-15 fix alone is INSUFFICIENT — the WRITE side at line 122 has its own isNull guard that masks the rescue. AC-23 drops it; AC-22 semaphore is the correct concurrency bound. Bug E added to §1.1. |
| 2026-04-09 (round 3) | AC-24 NEW — delete FIX-2 sentinel write entirely | SpecMaster ES-086 recon LB2 | Sentinel writes a malformed shape (missing level/pageCount/evidence/extractedAt, wrong id, same shape for both geoTree+categoryTree). Post-AC-15 a "don't retry" marker is unnecessary because treeIsEmpty() detects empty trees structurally. Bug F added to §1.1. AC-22 semaphore caps retry burst. |
| 2026-04-09 (round 3) | AC-21 enumeration corrected (1 → 9 lines) | SpecMaster ES-086 recon LB3 + CoFounder grep verification | Original AC-21 showed 1 GPT-4o reference; the actual file has 9 (lines 5, 277, 293, 476, 518, 520, 524, 528, 531). SpecMaster found 7; CoFounder grep found 2 additional (lines 476 + 518 — duplicate JSDoc header + Attempt 3 comment). Full enumeration added with grep gate. |
| 2026-04-09 (round 3) | Credit-deduction line range corrected | SpecMaster ES-086 recon (off-by-3 catch) | Original spec said route.ts:70-86; actual range is 65-89 (provider check + balanceBefore through creditTransactions.values insert). Updated globally. |

---

**End of TS-086 (amended 2026-04-09).**
