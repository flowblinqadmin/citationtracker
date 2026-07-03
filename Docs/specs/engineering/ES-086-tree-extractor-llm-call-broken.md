# ES-086 — Tree Extractor LLM Call Broken (Field Name + Budget + Integration Gaps)

**Author:** SpecMaster (Agent 2)
**Source TS:** geo/docs/specs/technical/TS-086-tree-extractor-llm-call-broken.md
**Date:** 2026-04-09
**Priority:** P0 — every recent geo customer is silently broken (empty geo_tree / category_tree / dimensional outputs)
**Sprint:** Bulk-audit dimensional data fix sprint (TS-083 / TS-084 / TS-085 / TS-086 ship together)
**Sprint role:** **Dominant root cause — without ES-086, ES-083/084/085 have no visible effect.**
**Branch:** `fix/tree-extractor-and-bulk-audit` (NEW branch — sprint specs are currently parked on `fix/llms-txt-empty-generation`; CoFounder will move them to the new branch before any code lands)
**HolePoker status:** Cleared rounds 1+2+3 (16+5+1 = 22 findings absorbed, 0 disputes); HP-163 through HP-184

---

## a) Overview

### What this covers

Fix two latent bugs in `lib/services/tree-extractor.ts` that have caused the lazy tree extraction code path to silently fall back to empty trees on every invocation since the bug was introduced (between 2026-03-27 and 2026-04-08). AND amend the lazy re-extraction trigger in `app/api/sites/[id]/citation-check/route.ts` so existing affected customers (who currently hold non-NULL empty trees) are rescued automatically on their next citation check.

The fix has eleven distinct surfaces, all in two files:

1. **Bug A — Anthropic SDK field name (lines 260 + 403):** `max_completion_tokens` → `max_tokens`. The Anthropic Messages API rejects every call with HTTP 400 `"max_tokens: Field required"`. The catch block silently swallows. **Line 285 (gpt-5.4) STAYS `max_completion_tokens`** — that is the canonical OpenAI reasoning model field.
2. **Bug B — Insufficient output token budget (lines 260 + 285 BOTH):** 8000 → 20000. Empirically validated against the Manipal fixture: Sonnet needs 17,774 output tokens, gpt-5.4 needs 10,555 output tokens with **zero** reasoning tokens. 20K is the empirical sweet spot for both providers.
3. **Bug C — Promise.race timeout fires before any LLM call can complete (line 22):** `EXTRACTION_TIMEOUT_MS = 35_000` → `200_000`. Real Manipal-class extractions take 150-200s end-to-end. Without this fix, Bugs A+B fixes have ZERO production effect.
4. **Bug D — Lazy re-extraction trigger uses JavaScript truthiness:** `if (!site.geoTree && !site.categoryTree && ...)` becomes `if ((treeIsEmpty(site.geoTree) || treeIsEmpty(site.categoryTree)) && ...)`. The current trigger evaluates `!{root:{...}, leafCount:0}` as `false` and skips affected customers entirely.
5. **Hand-rolled runtime schema validator + typed error class** (file-local, no zod dependency).
6. **Catch-block error dispatch table** (timeout / schema / overload / auth / network / other) — explicit 6-row policy.
7. **`maxDuration` 300 → 600** in citation-check route to absorb worst-case ~405s extraction.
8. **Function rename** `callGpt4o` → `callOpenAi` + file header comment + all 4 GPT-4o references in error/log strings (mechanical, no behavior change).
9. **Global semaphore (max 3 concurrent re-extractions)** with saturated-path proceed-with-empty-trees behavior + `treeReextractionDeferred` flag (HP-181 fixed the original "return early" billing bug).
10. **Diagnostic script lifecycle** — both diagnostic scripts already exist in the repo and are kept as runnable tools per AC-11.
11. **Smoke + integration tests** — extract Manipal fixture, regression on SaaS-style fixture, citation-check route end-to-end rescue path.

### Source TS reference

`geo/docs/specs/technical/TS-086-tree-extractor-llm-call-broken.md` (~13K bytes, 9 sections, 22 ACs). Read end-to-end before implementing — load-bearing sections:

- **§1.1** — Bug summary REFRAMED 2026-04-09 per HP-163/HP-164 (premise inversion correction)
- **§2.1** — Sonnet diagnostic sweep (5 budgets, 20K is the sweet spot, empirically validated)
- **§2.2** — gpt-5.4 OQ-1 resolution sweep (3 budgets, reasoning_tokens=0 across all, finish_reason=stop, 20K matches Sonnet)
- **§2.6** — Why existing customers need an explicit rescue path (HP-166 — lazy trigger truthiness check)
- **§3** — 22 ACs (this ES translates each one + adds 3 cross-cutting ACs from recon)
- **§8** — Reference diff (illustrative — see SpecMaster note 1 below for the discrepancy between the diff and the actual file)

### Current implementation state

Verified end-to-end via Read/Grep per CLAUDE.md spec rigour rule (2026-04-09).

| Surface | File | Lines | State |
|---|---|---|---|
| EXTRACTION_TIMEOUT_MS | `geo/lib/services/tree-extractor.ts` | 22 | Currently `35_000` ms, comment says "3 attempts × 35s = 105s max, under Vercel 120s limit" — comment must be removed in same commit (AC-12) |
| STRUCTURAL_TYPES set | `geo/lib/services/tree-extractor.ts` | 28 | `homepage / about / services / pricing / team / contact` (informational; used by `buildPageInventory`) |
| SYSTEM_PROMPT | `geo/lib/services/tree-extractor.ts` | 32-58 | Schema spec embedded in prompt; no change |
| `callSonnet` function | `geo/lib/services/tree-extractor.ts` | 252-275 | **Bug A:** line 260 `max_completion_tokens: 8000` → must become `max_tokens: 20000` (AC-1 + AC-4); model `claude-sonnet-4-6` stays |
| `callGpt4o` function | `geo/lib/services/tree-extractor.ts` | 277-302 | **Bug B:** line 285 `max_completion_tokens: 8000` → STAYS `max_completion_tokens`, bumped to `20000` (AC-2 + AC-5); function renamed to `callOpenAi` (AC-21); model `gpt-5.4` stays (verified canonical reasoning model id) |
| `callGpt4o` error message | `geo/lib/services/tree-extractor.ts` | 293 | `setTimeout(() => reject(new Error("GPT-4o timeout")), EXTRACTION_TIMEOUT_MS)` — error message needs `GPT-4o` → `OpenAI` rename (AC-21) |
| `pruneUngroundedNodes` correction call | `geo/lib/services/tree-extractor.ts` | 400-410 | Line 403 `max_completion_tokens: 2000` → must become `max_tokens: 2000` (AC-3); budget STAYS at 2000 (AC-6) |
| `extractTrees` Sonnet attempt 1 | `geo/lib/services/tree-extractor.ts` | 487-500 | `console.warn` log on failure — NEEDS catch-block dispatch refactor per AC-19 |
| `extractTrees` Sonnet attempt 2 (retry @ temp 0.3) | `geo/lib/services/tree-extractor.ts` | 502-516 | NEEDS short-circuit on timeout / overload errors per AC-19 (skip retry, fall through) |
| `extractTrees` GPT-4o fallback | `geo/lib/services/tree-extractor.ts` | 518-532 | Lines 524 + 528 + 531 — three additional `GPT-4o` references in info/warn logs that AC-21 must update (TS-086 §8 diff only mentions one) |
| Empty fallback | `geo/lib/services/tree-extractor.ts` | 534-541 | `console.warn` last-resort line + return empty trees — no change in main path; AC-19 dispatch table changes the *catch block* behavior, not the fallback |
| `maxDuration` export | `geo/app/api/sites/[id]/citation-check/route.ts` | 21 | `export const maxDuration = 300` → must become `600` (AC-20) |
| Credit deduction | `geo/app/api/sites/[id]/citation-check/route.ts` | 65-89 | Credits deducted upfront BEFORE the SSE stream begins — this is the `MUST proceed with empty trees on semaphore saturation` rationale (AC-22 / HP-181) |
| Lazy tree extraction trigger | `geo/app/api/sites/[id]/citation-check/route.ts` | 107 | Currently `!site.geoTree && !site.categoryTree && site.crawlData && site.discoveryData` — Bug D / AC-15 amends to `(treeIsEmpty(site.geoTree) \|\| treeIsEmpty(site.categoryTree)) && site.crawlData && site.discoveryData` |
| Successful-extraction UPDATE | `geo/app/api/sites/[id]/citation-check/route.ts` | 117-122 | **CRITICAL LATENT BUG** (see SpecMaster note 2): `where(and(eq(geoSites.id, siteId), isNull(geoSites.geoTree)))` — the `isNull` guard prevents the rescue path from ever persisting populated trees once the FIX-2 sentinel is in place |
| FIX-2 empty sentinel | `geo/app/api/sites/[id]/citation-check/route.ts` | 128-135 | **CRITICAL LATENT BUG** (see SpecMaster note 3): catch block writes a malformed sentinel (`{ root: { id: "root", name: "Root", children: [] }, leafCount: 0 }`) that does NOT match `emptyGeoTree()` shape and locks the row via the same `isNull` guard |
| `extractTrees` import | `geo/app/api/sites/[id]/citation-check/route.ts` | 15 | Already imported, no change |

| Schema | File | Lines | State |
|---|---|---|---|
| `geoTree` column | `geo/lib/db/schema.ts` | 106 | `jsonb("geo_tree").$type<GeoTree>()` — exists ✓ |
| `categoryTree` column | `geo/lib/db/schema.ts` | 107 | `jsonb("category_tree").$type<CategoryTree>()` — exists ✓ |
| `geoCategoryMapping` column | `geo/lib/db/schema.ts` | 108 | exists ✓ |
| `tierTree` column | — | — | **DOES NOT EXIST** (verified) — round-1 TS-086 referenced this field; HP-179 corrected the spec; AC-15 only checks geoTree + categoryTree |
| `pillarTree` column | — | — | **DOES NOT EXIST** (verified) — same HP-179 correction |

| Type definitions | File | Lines | State |
|---|---|---|---|
| `GeoTree` / `GeoNode` | `geo/lib/types/trees.ts` | 3-18 | `GeoNode` has `level: GeoNodeLevel`, `pageCount: number`, `evidence: string[]` — used by emptyGeoTree |
| `emptyGeoTree()` | `geo/lib/types/trees.ts` | 64-70 | Returns `{ root: { id: "global", name: "Global", level: "global", children: [], pageCount: 0, evidence: [] }, leafCount: 0, extractedAt: ... }` |
| `emptyCategoryTree()` | `geo/lib/types/trees.ts` | 72-78 | Returns `{ root: { id: "root", name: "Unknown", level: 0, children: [], pageCount: 0, evidence: [] }, leafCount: 0, extractedAt: ... }` |
| `emptyMapping()` | `geo/lib/types/trees.ts` | 80-86 | Returns `{ entries: [], totalEntries: 0, extractedAt: ... }` |
| `TreeExtractionResult` | `geo/lib/types/trees.ts` | 56-60 | `{ geoTree: GeoTree, categoryTree: CategoryTree, mapping: GeoCategoryMapping }` |

| Diagnostic scripts | File | Lines | State |
|---|---|---|---|
| Sonnet budget sweep | `geo/scripts/test-tree-extract-budget.ts` | 228 LOC | **EXISTS** — verified via Glob; not a new file. AC-11 keeps it as a runnable diagnostic. |
| gpt-5.4 OQ-1 resolution | `geo/scripts/test-tree-extract-gpt54-budget.ts` | 274 LOC | **EXISTS** — same. |

| Existing tests | File | Lines | State |
|---|---|---|---|
| `tree-extractor.test.ts` | `geo/__tests__/services/tree-extractor.test.ts` | 404 LOC | Has Anthropic + OpenAI mock infra (`mockSonnetCreate` / `mockOpenAICreate` hoisted), `makeCrawlData`/`makeDiscoveryData`/`makeValidGeoTree`/`makeValidCategoryTree` factories. New AC-7..AC-19 unit tests EXTEND this file or import its helpers. |

| SDK versions | File | Lines | State |
|---|---|---|---|
| `@anthropic-ai/sdk` | `geo/package.json` | 26 | `^0.78.0` — confirmed Anthropic Messages API uses `max_tokens` (AC-1 / AC-3) |
| `openai` | `geo/package.json` | 51 | `^6.18.0` — confirmed OpenAI Chat Completions API for reasoning models uses `max_completion_tokens` (AC-2 stays) |

### Out of scope (verbatim from TS-086 §4)

- **TS-083** (auto-discover brand-level pages) — sibling spec, ships concurrently. P1.
- **TS-084** (tree extractor timing race against chunked crawl) — sibling spec, ships concurrently. P1 (promoted from P2 per HP-177).
- **TS-085** (pageType classifier under-classification) — sibling spec, ships concurrently. P1.
- Switching to streaming Anthropic API — not needed for 20K (the 24K boundary is where streaming becomes mandatory).
- Refactoring Anthropic / OpenAI client wrappers — keep direct usage.
- Finer-grained error logging beyond AC-17's typed error path.
- Backfilling existing affected customers via a script — AC-15 handles automatic rescue on next citation check.

### SpecMaster recon findings (3 latent bugs surfaced — TS-082 AC-16 precedent)

#### SpecMaster note 1 — TS-086 §8.1 illustrative diff is incomplete

TS-086 §8.1 shows ONE `console.error("[extract-trees] GPT-4o fallback failed: ${err.message}")` rename. **That exact string does not exist in the current file.** The actual `GPT-4o` references in `tree-extractor.ts` are:

| Line | Code | AC-21 action |
|---|---|---|
| 5 | `// Primary: Claude Sonnet 4 → Fallback: GPT-4o → Last resort: empty trees.` | Replace `GPT-4o` with `OpenAI (gpt-5.4 reasoning model)` |
| 277 | `async function callGpt4o(userPrompt: string): Promise<TreeExtractionResult \| null> {` | Rename function to `callOpenAi` |
| 293 | `setTimeout(() => reject(new Error("GPT-4o timeout")), EXTRACTION_TIMEOUT_MS)` | Replace `"GPT-4o timeout"` → `"OpenAI timeout"` |
| 520 | `const result = await callGpt4o(userPrompt);` (caller site) | Update to `callOpenAi(userPrompt)` |
| 524 | `console.info(\`[extract-trees] ${domain}: trees extracted via GPT-4o\`);` | Replace `GPT-4o` → `OpenAI` |
| 528 | `console.warn(\`[extract-trees] ${domain}: GPT-4o validation failed: ${validation.errors.join(", ")}\`);` | Replace `GPT-4o` → `OpenAI` |
| 531 | `console.warn(\`[extract-trees] ${domain}: GPT-4o failed: ${(err as Error).message}\`);` | Replace `GPT-4o` → `OpenAI` |

ScriptDev MUST grep `tree-extractor.ts` for `GPT-4o` and `gpt-4o` (case-insensitive) before commit and confirm zero matches remain. **AC-21 covers ALL of these, not just the one line in TS-086 §8.1.**

#### SpecMaster note 2 — `isNull` WRITE-side guard masks the rescue path

`citation-check/route.ts` has TWO `where(and(eq(geoSites.id, siteId), isNull(geoSites.geoTree)))` UPDATE statements:

- **Line 117-122 (success path):** writes populated trees on successful extraction, gated by `isNull(geoTree)`
- **Line 131-134 (FIX-2 sentinel catch path):** writes empty sentinel on extraction failure, gated by `isNull(geoTree)`

Once the FIX-2 sentinel writes a non-NULL empty tree on the FIRST extraction failure, **neither UPDATE can ever modify the row again** because `isNull(geoTree)` is now `false`. TS-086 AC-15 amends the READ trigger to detect the sentinel via `treeIsEmpty()`, so the rescue path FIRES on next citation check — but the success-path UPDATE at line 122 then matches 0 rows, the populated trees are NOT persisted to the DB, and the local in-memory `site` object update at lines 124-126 is the only effect. The next citation check sees the same sentinel and re-runs extraction again. Forever.

**This is a real bug. ScriptDev MUST also remove the `isNull(geoSites.geoTree)` guard from the success-path UPDATE (line 122).** The amended UPDATE becomes:

```ts
// ES-086 LATENT BUG FIX: removed isNull guard so the rescue path can overwrite
// the FIX-2 sentinel from the prior failed extraction. Without this, the
// rescue path's UPDATE matches 0 rows and the populated trees are never
// persisted (only the in-memory site object below is updated).
await db.update(geoSites).set({
  geoTree: trees.geoTree,
  categoryTree: trees.categoryTree,
  geoCategoryMapping: trees.mapping,
}).where(eq(geoSites.id, siteId));
```

This is captured in **AC-23 (NEW)** below.

#### SpecMaster note 3 — FIX-2 sentinel writes a malformed shape

The FIX-2 catch block at lines 131-134 writes:

```ts
{ root: { id: "root", name: "Root", children: [] }, leafCount: 0 }
```

This shape:
- Uses `id: "root"` (correct shape uses `id: "global"` for geoTree per `emptyGeoTree()` at trees.ts:66)
- Uses `name: "Root"` (correct shape uses `name: "Global"` for geoTree)
- Is **MISSING** `level` field (`GeoNode.level: "global"|"country"|"state"|"city"` per trees.ts:8)
- Is **MISSING** `pageCount` field (`number` per trees.ts:10)
- Is **MISSING** `evidence` field (`string[]` per trees.ts:11)
- Is **MISSING** the tree-level `extractedAt` timestamp
- Same shape used for BOTH `geoTree` AND `categoryTree` UPDATEs — but `emptyGeoTree()` and `emptyCategoryTree()` produce structurally distinct shapes (`level: "global"` vs `level: 0`)

The sentinel is cast `as never` which suppresses the type checker. AC-15's `treeIsEmpty()` helper catches both shapes via `leafCount === 0` and `root.children.length === 0`, so detection works — but the malformed shape itself is a typed-data integrity violation.

**Resolution per ES-086 (AC-24 NEW):** the catch block should call `emptyGeoTree()` / `emptyCategoryTree()` directly instead of the inline malformed sentinel. But more importantly, **the catch block should not write the sentinel at all post-AC-15**, because:
- AC-15's `treeIsEmpty()` makes the sentinel unnecessary as a "don't retry" marker (the rescue trigger now detects empty trees structurally)
- Writing the sentinel locks the row via the `isNull` guard (per SpecMaster note 2)

**AC-24 deletes the FIX-2 catch-block UPDATE entirely.** The catch block becomes:

```ts
} catch (err) {
  console.warn(`[citation-check] ${site.domain}: lazy tree extraction failed: ${(err as Error).message}`);
  // ES-086: do NOT write a sentinel. Post-AC-15, leaving the trees as-is
  // (NULL or pre-existing empty) lets the next citation check try again
  // via treeIsEmpty(). The semaphore at AC-22 caps the retry burst.
}
```

This is mandatory — without it, every extraction failure on a fresh NULL-tree site permanently locks the row to the malformed sentinel.

---

## b) Implementation Requirements

### b.1 New typed error class (AC-18)

File: `geo/lib/services/tree-extractor.ts` — add at top of file (after existing imports, before `MAX_INVENTORY_PAGES`):

```ts
/**
 * Thrown when the LLM response parses to JSON but fails the structural
 * schema check (missing required fields, wrong types, etc.). File-local;
 * not exported. The catch block at the call site classifies this via the
 * AC-19 error dispatch table and decides whether to retry at temp 0.3.
 */
class TreeExtractorSchemaError extends Error {
  constructor(message: string, public readonly field: string) {
    super(message);
    this.name = "TreeExtractorSchemaError";
  }
}
```

**Constraint:** file-local, NOT in `lib/services/content-generator-errors.ts` or any shared errors module. The class has exactly one producer (`validateExtractionResponse` at AC-17) and one consumer (the catch block at AC-19). Cross-file scope is gratuitous.

### b.2 Hand-rolled runtime schema validator (AC-17)

File: `geo/lib/services/tree-extractor.ts` — add as a `function` (not exported), placed after `parseJsonResponse` (line 220).

```ts
/**
 * Validates that an LLM-returned object matches the TreeExtractionResult shape.
 * Hand-rolled to avoid pulling in zod for one call site. Throws
 * TreeExtractorSchemaError on the first failure with a path-style field marker.
 *
 * Asserts the production code can read every field downstream:
 *   - geoTree.leafCount (number)
 *   - geoTree.root: { children: GeoNode[] }
 *   - categoryTree.leafCount (number)
 *   - categoryTree.root: { children: CategoryNode[] }
 *   - mapping.entries: GeoCategoryEntry[]
 */
function validateExtractionResponse(parsed: unknown): asserts parsed is TreeExtractionResult {
  if (!parsed || typeof parsed !== "object") {
    throw new TreeExtractorSchemaError("response is not an object", "root");
  }
  const obj = parsed as Record<string, unknown>;

  // ── geoTree ──
  if (!obj.geoTree || typeof obj.geoTree !== "object") {
    throw new TreeExtractorSchemaError("geoTree missing or not an object", "geoTree");
  }
  const geoTree = obj.geoTree as Record<string, unknown>;
  if (typeof geoTree.leafCount !== "number") {
    throw new TreeExtractorSchemaError("geoTree.leafCount is not a number", "geoTree.leafCount");
  }
  if (!geoTree.root || typeof geoTree.root !== "object") {
    throw new TreeExtractorSchemaError("geoTree.root missing or not an object", "geoTree.root");
  }
  const geoRoot = geoTree.root as Record<string, unknown>;
  if (!Array.isArray(geoRoot.children)) {
    throw new TreeExtractorSchemaError("geoTree.root.children is not an array", "geoTree.root.children");
  }

  // ── categoryTree ──
  if (!obj.categoryTree || typeof obj.categoryTree !== "object") {
    throw new TreeExtractorSchemaError("categoryTree missing or not an object", "categoryTree");
  }
  const catTree = obj.categoryTree as Record<string, unknown>;
  if (typeof catTree.leafCount !== "number") {
    throw new TreeExtractorSchemaError("categoryTree.leafCount is not a number", "categoryTree.leafCount");
  }
  if (!catTree.root || typeof catTree.root !== "object") {
    throw new TreeExtractorSchemaError("categoryTree.root missing or not an object", "categoryTree.root");
  }
  const catRoot = catTree.root as Record<string, unknown>;
  if (!Array.isArray(catRoot.children)) {
    throw new TreeExtractorSchemaError("categoryTree.root.children is not an array", "categoryTree.root.children");
  }

  // ── mapping ──
  if (!obj.mapping || typeof obj.mapping !== "object") {
    throw new TreeExtractorSchemaError("mapping missing or not an object", "mapping");
  }
  const mapping = obj.mapping as Record<string, unknown>;
  if (!Array.isArray(mapping.entries)) {
    throw new TreeExtractorSchemaError("mapping.entries is not an array", "mapping.entries");
  }
}
```

**Wire-up:** `parseJsonResponse` (line 220) returns `unknown` and `callSonnet` / `callGpt4o` cast it. After the cast, the LLM response was previously trusted blind. Insert the validator immediately after the cast in BOTH `callSonnet` (line ~273) and `callOpenAi` (line ~300):

```ts
const parsed = parseJsonResponse(text);
validateExtractionResponse(parsed); // ES-086 AC-17
return ensureTimestampsAndCounts(parsed);
```

`validateExtractionResponse` is an `asserts parsed is TreeExtractionResult` declaration, so TypeScript narrows the type after the call and the explicit cast becomes unnecessary.

### b.3 Bug A — Field name fix (AC-1, AC-3)

File: `geo/lib/services/tree-extractor.ts`

**Line 260 — `callSonnet`:**

```ts
// Before (BUG: Anthropic API rejects with HTTP 400 "max_tokens: Field required"):
max_completion_tokens: 8000,
// After (AC-1 + AC-4 — field name + budget bump):
max_tokens: 20000,
```

**Line 403 — `pruneUngroundedNodes` correction call:**

```ts
// Before:
max_completion_tokens: 2000,
// After (AC-3 — field name only; AC-6 keeps budget at 2000):
max_tokens: 2000,
```

### b.4 Bug B — Token budget fix (AC-4, AC-5, AC-6)

**Line 260 — Sonnet primary call:** `max_tokens: 20000` (combined with AC-1 above)

**Line 285 — gpt-5.4 fallback (CRITICAL: STAYS `max_completion_tokens`):**

```ts
// Before:
max_completion_tokens: 8000,
// After (AC-2 + AC-5 — budget bump only; FIELD NAME STAYS):
max_completion_tokens: 20000,
```

**Why the asymmetry:** Anthropic Messages API uses `max_tokens`. OpenAI Chat Completions API for **reasoning models** (gpt-5.4, o1, o3) uses `max_completion_tokens`. The original spec author confused them; HP-163 corrected the analysis. This ES locks the asymmetry into AC-1 vs AC-2 explicitly so ScriptDev cannot accidentally cross-update.

**Line 403 — correction call:** `max_tokens: 2000` (combined with AC-3 above; budget unchanged per AC-6).

### b.5 Bug C — Promise.race timeout fix (AC-12)

File: `geo/lib/services/tree-extractor.ts`, line 22.

```ts
// Before:
const EXTRACTION_TIMEOUT_MS = 35_000; // 3 attempts × 35s = 105s max, under Vercel 120s limit

// After (AC-12):
const EXTRACTION_TIMEOUT_MS = 200_000; // 200s — empirically required for Manipal-class extractions (was 35_000, which fired before any Sonnet/gpt-5.4 call could complete; see TS-086 §2.1 for the diagnostic sweep)
```

**The stale comment must be removed or replaced in the SAME commit.** The previous comment ("3 attempts × 35s = 105s max, under Vercel 120s limit") is actively misleading post-fix.

### b.6 Bug D — Lazy re-extraction trigger fix (AC-15, AC-16)

File: `geo/app/api/sites/[id]/citation-check/route.ts`

**Inline helper at top of file** (after the imports, before the existing `sseMessage` helper at line 29):

```ts
/**
 * ES-086 AC-15: detect non-NULL empty trees by structure.
 * Inline (NOT a shared helper) — single call site, broader use is out of scope.
 *
 * Catches three shapes:
 *   1. NULL / undefined / non-object        → empty
 *   2. leafCount === 0                       → empty
 *   3. root.children is not an array         → empty
 *   4. root.children is an empty array       → empty
 *
 * The third case catches the FIX-2 sentinel (line 131-134) which writes
 * a malformed shape missing the `level`, `pageCount`, and `evidence` fields
 * but does set `children: []`. See SpecMaster note 3 for the malformed
 * sentinel detail.
 */
function treeIsEmpty(t: unknown): boolean {
  if (!t || typeof t !== "object") return true;
  const obj = t as { leafCount?: unknown; root?: { children?: unknown } };
  if (obj.leafCount === 0) return true;
  if (!Array.isArray(obj.root?.children) || obj.root.children.length === 0) return true;
  return false;
}
```

**Line 107 — amend the lazy trigger:**

```ts
// Before:
if (!site.geoTree && !site.categoryTree && site.crawlData && site.discoveryData) {

// After (AC-15):
if (
  (treeIsEmpty(site.geoTree) || treeIsEmpty(site.categoryTree)) &&
  site.crawlData &&
  site.discoveryData
) {
```

**Logical change:**
- OLD: only NULL trees trigger re-extraction (truthiness check skips non-NULL empty sentinels)
- NEW: any empty tree (NULL OR non-NULL empty OR FIX-2 sentinel) triggers re-extraction
- The `&& crawlData && discoveryData` guard is preserved — without those inputs the extractor cannot run

**No `tierTree` or `pillarTree` checks** — those columns do not exist (verified at `lib/db/schema.ts:106-107`). Round-1 of TS-086 referenced them; HP-179 corrected the spec.

### b.7 LATENT BUG FIX — Remove `isNull` guard from success-path UPDATE (AC-23 NEW)

File: `geo/app/api/sites/[id]/citation-check/route.ts`, lines 117-122.

```ts
// Before (BUG — see SpecMaster note 2):
await db.update(geoSites).set({
  geoTree: trees.geoTree,
  categoryTree: trees.categoryTree,
  geoCategoryMapping: trees.mapping,
}).where(and(eq(geoSites.id, siteId), isNull(geoSites.geoTree)));

// After (AC-23):
// ES-086 AC-23: removed isNull guard so the rescue path can overwrite
// the FIX-2 sentinel (or any other prior empty tree). Without this fix,
// the rescue path's UPDATE matches 0 rows once a sentinel exists, and
// the populated trees are never persisted (only in-memory).
await db.update(geoSites).set({
  geoTree: trees.geoTree,
  categoryTree: trees.categoryTree,
  geoCategoryMapping: trees.mapping,
}).where(eq(geoSites.id, siteId));
```

**Concurrency note:** the original `isNull` guard was an attempt to prevent concurrent overwrites (FIX-1a per the existing comment at line 117). With the AC-22 semaphore in place (max 3 concurrent re-extractions), the concurrent-overwrite race is bounded — but two threads can still race to write populated trees. Acceptable: both threads write the same content (deterministic LLM output up to temperature jitter), and the second writer's transaction wins. **No data loss.** If a stricter safety net is desired, ScriptDev can add `where(or(isNull(geoSites.geoTree), sql\`(geo_tree->>'leafCount')::int = 0\`))` — but that complexity is not warranted for v1.

### b.8 LATENT BUG FIX — Delete the FIX-2 sentinel write (AC-24 NEW)

File: `geo/app/api/sites/[id]/citation-check/route.ts`, lines 128-135.

```ts
// Before (BUG — see SpecMaster note 3):
} catch (err) {
  console.warn(`[citation-check] ${site.domain}: lazy tree extraction failed: ${(err as Error).message}`);
  // FIX-2: store empty sentinel so extraction isn't retried on every check
  await db.update(geoSites).set({
    geoTree: { root: { id: "root", name: "Root", children: [] }, leafCount: 0 } as never,
    categoryTree: { root: { id: "root", name: "Root", children: [] }, leafCount: 0 } as never,
  }).where(and(eq(geoSites.id, siteId), isNull(geoSites.geoTree)));
}

// After (AC-24):
} catch (err) {
  console.warn(`[citation-check] ${site.domain}: lazy tree extraction failed: ${(err as Error).message}`);
  // ES-086 AC-24: do NOT write a sentinel. Post-AC-15 the rescue trigger
  // detects empty trees structurally via treeIsEmpty(), so a "don't retry"
  // marker is unnecessary. Writing the sentinel would lock the row to
  // a malformed shape (missing level/pageCount/evidence) AND prevent the
  // rescue path's UPDATE from overwriting it on the next attempt.
  // The AC-22 semaphore (max 3 concurrent) caps the retry burst.
}
```

**Implication:** sites whose first extraction fails after this ES ships will have their trees stay NULL (or whatever they were) instead of being locked to a sentinel. The next citation check sees the same NULL/empty state and tries again. The semaphore caps the burst.

### b.9 maxDuration bump (AC-20)

File: `geo/app/api/sites/[id]/citation-check/route.ts`, line 21.

```ts
// Before:
export const maxDuration = 300;

// After (AC-20):
export const maxDuration = 600; // ES-086 AC-20 — absorbs worst-case ~405s extraction (200s Sonnet timeout + 200s gpt-5.4 + 5s correction)
```

### b.10 Function rename (AC-21)

File: `geo/lib/services/tree-extractor.ts`. **All 7 sites enumerated in SpecMaster note 1 above.** This is mechanical, no behavior change.

ScriptDev MUST grep the file for `GPT-4o` and `gpt-4o` (case-insensitive) before commit and confirm zero matches remain.

### b.11 Catch-block error dispatch table (AC-19)

File: `geo/lib/services/tree-extractor.ts` — add as a private helper, placed after `validateExtractionResponse` (introduced in §b.2).

```ts
type SonnetErrorClass =
  | { kind: "timeout" }                                                      // skip retry, fall to gpt-5.4
  | { kind: "schema" }                                                       // retry at temp 0.3
  | { kind: "overload" }                                                     // skip retry, fall to gpt-5.4
  | { kind: "auth_or_config" }                                               // fail fast, no fallback
  | { kind: "network" }                                                      // retry at temp 0.3 once
  | { kind: "other"; errType: string; errMsg: string; errStatus?: number };  // fall to gpt-5.4

function classifySonnetError(err: unknown): SonnetErrorClass {
  if (!(err instanceof Error)) return { kind: "other", errType: "non-error", errMsg: String(err) };

  // Timeout sentinel (Promise.race rejection from line 266)
  if (err.message === "Sonnet timeout") return { kind: "timeout" };

  // Schema validation failure
  if (err instanceof TreeExtractorSchemaError) return { kind: "schema" };

  // Anthropic SDK error with HTTP status (status field is on the SDK error type)
  const errStatus = (err as { status?: number }).status;
  if (errStatus === 503 || errStatus === 529) return { kind: "overload" };
  if (errStatus === 400 || errStatus === 401 || errStatus === 403) return { kind: "auth_or_config" };

  // Network errors (Node.js error codes)
  const errCode = (err as { code?: string }).code;
  if (errCode === "ECONNRESET" || errCode === "EAI_AGAIN" || errCode === "ETIMEDOUT" || errCode === "EPIPE") {
    return { kind: "network" };
  }

  return {
    kind: "other",
    errType: err.name,
    errMsg: err.message,
    errStatus,
  };
}
```

**Wire-up — refactor `extractTrees` Sonnet attempt 1 catch block (currently lines 487-500):**

```ts
// Attempt 1: Sonnet temperature=0
try {
  const result = await callSonnet(userPrompt, 0);
  if (result) {
    const validation = validateTrees(result);
    if (validation.valid) {
      console.info(`[extract-trees] ${domain}: trees extracted via Sonnet`);
      await pruneUngroundedNodes(result, crawlData);
      return result;
    }
    console.warn(`[extract-trees] ${domain}: Sonnet validation failed (attempt 1): ${validation.errors.join(", ")}`);
  }
} catch (err) {
  const classified = classifySonnetError(err);
  console.warn(JSON.stringify({
    event: "extract_trees_sonnet_attempt1_failed",
    domain,
    attempt: 1,
    classified: classified.kind,
    errMsg: (err as Error).message,
  }));
  if (classified.kind === "auth_or_config") {
    // Fail fast — no retry, no fallback. Per AC-19 row 4.
    throw err;
  }
  if (classified.kind === "timeout" || classified.kind === "overload") {
    // Skip the temp-0.3 retry — go straight to gpt-5.4 fallback. Per AC-19 row 1+3.
    // The AC-19 short-circuit is implemented by labeling and break-ing past attempt 2.
    // ScriptDev refactors the if/try chain or uses a clearly-named flag.
  }
  // schema | network | other → fall through to attempt 2 (temp 0.3 retry)
}

// Attempt 2: Sonnet temperature=0.3 (retry — only if attempt 1 was schema/network/other)
// (skipped if attempt 1 was timeout/overload — fall straight to gpt-5.4)
```

**Implementation guidance for ScriptDev:** the cleanest refactor is to extract attempts 1-3 into a `try-attempt-1 → maybe-attempt-2 → try-attempt-3` state machine (e.g., a `for` loop with explicit `break`/`continue`, or a series of labeled `if` blocks). The point is that the AC-19 dispatch table determines whether attempt 2 runs, NOT a blanket "retry on any error". Per HP-180, the original "existing behavior" wording was ambiguous; the table is the canonical contract.

**Catch block for attempt 2 + attempt 3** follows the same dispatch pattern but simplified — there's no "next" attempt to short-circuit, so `auth_or_config` still fail-fasts and everything else falls through to the empty fallback at line 534-541.

**Test coverage** for AC-19 is in §c (one synthetic error per row of the dispatch table — 6 unit tests).

### b.12 Re-extraction thundering-herd guard (AC-22)

File: `geo/app/api/sites/[id]/citation-check/route.ts` — add as a module-level state at top of file (after the imports, alongside `treeIsEmpty`):

```ts
// ES-086 AC-22: in-process semaphore capping concurrent tree re-extractions to 3.
// Lives in this file (NOT a shared helper) per the v1 minimum implementation.
// Future iteration: replace with a Redis-backed counter using the existing
// Upstash pattern for cross-instance concurrency control.
const MAX_CONCURRENT_REEXTRACTIONS = 3;
let activeReextractions = 0;
```

**Wire-up at the lazy extraction site (post-AC-15 amendment, line 107 area):**

```ts
if (
  (treeIsEmpty(site.geoTree) || treeIsEmpty(site.categoryTree)) &&
  site.crawlData &&
  site.discoveryData
) {
  if (activeReextractions >= MAX_CONCURRENT_REEXTRACTIONS) {
    // ES-086 AC-22: semaphore saturated. Proceed with citation check using
    // empty trees (today's pre-fix behavior) and flag the result so the
    // dashboard can show a regenerating-data banner. Critically: the credit
    // deduction at lines 65-89 has already committed, so returning early here
    // would charge 5 credits for nothing — that was the HP-181 billing bug.
    console.info(`[citation-check] ${site.domain}: tree re-extraction deferred (semaphore saturated, active=${activeReextractions})`);
    // Mark the result so the SSE stream can include the flag in the final
    // 'complete' event. Implementation: ScriptDev declares a local variable
    // (e.g. `let treeReextractionDeferred = false;`) ahead of this block,
    // sets it to true here, and includes it in the result payload below.
    treeReextractionDeferred = true;
  } else {
    activeReextractions++;
    try {
      send({ type: "stage", data: { stage: "extracting-trees", progress: 7, message: "Building geographic & category intelligence" } });
      const crawl = site.crawlData as Record<string, unknown>;
      if (!crawl || !Array.isArray((crawl as Record<string, unknown>).pages)) {
        throw new Error("crawlData missing pages array");
      }
      const discovery = site.discoveryData as unknown as DiscoveryData;
      const trees = await extractTrees(crawl as unknown as CrawlData, discovery, site.domain);
      // AC-23: removed isNull guard
      await db.update(geoSites).set({
        geoTree: trees.geoTree,
        categoryTree: trees.categoryTree,
        geoCategoryMapping: trees.mapping,
      }).where(eq(geoSites.id, siteId));
      (site as Record<string, unknown>).geoTree = trees.geoTree;
      (site as Record<string, unknown>).categoryTree = trees.categoryTree;
      (site as Record<string, unknown>).geoCategoryMapping = trees.mapping;
      console.info(`[citation-check] ${site.domain}: lazy tree extraction complete (geo=${trees.geoTree.leafCount}, cat=${trees.categoryTree.leafCount})`);
    } catch (err) {
      console.warn(`[citation-check] ${site.domain}: lazy tree extraction failed: ${(err as Error).message}`);
      // AC-24: do NOT write a sentinel
    } finally {
      activeReextractions--;
    }
  }
}
```

**Result payload — surface `treeReextractionDeferred`:** ScriptDev adds a `treeReextractionDeferred?: boolean` field to the `complete` SSE event (and to whatever DB row tracks per-check metadata, if any). The dashboard reads this flag and shows: *"Dimensional data is regenerating — your next citation check will include geographic and category breakdowns."*

**Why the proceed-with-empty path is correct (HP-181):** credits are deducted upfront at lines 65-89, BEFORE the SSE stream starts. The original AC-22 wording (round 1) said "return early with empty response" — that would have charged 5 credits and delivered nothing. The amended path matches today's pre-fix behavior (citation check runs even when trees are empty) plus the forward-looking UX hint. **No billing regression.**

**Concurrency semantics:** in-process counter is sufficient for v1 because Vercel serverless instances each maintain their own counter. The cap-of-3 is per-instance, not global. Realistic deploy-day burst across 10 active Vercel instances = 30 concurrent extractions. Anthropic rate budget can absorb this. A Redis-backed global counter is the v2 enhancement.

### b.13 Diagnostic script lifecycle (AC-11)

Both diagnostic scripts already exist in `geo/scripts/`:

| Script | LOC | Purpose |
|---|---|---|
| `test-tree-extract-budget.ts` | 228 | Sonnet diagnostic sweep — 5 budgets × 1 fixture, exposes Bug A + B (TS-086 §2.1) |
| `test-tree-extract-gpt54-budget.ts` | 274 | gpt-5.4 OQ-1 resolution sweep — 3 budgets × 1 fixture, validates reasoning_tokens=0 (TS-086 §2.2) |

**AC-11 action:** **keep** both scripts as runnable diagnostic tools. Both should bypass the production code path's `Promise.race` wrapper to directly probe SDK behavior (useful for future SDK regressions independent of `EXTRACTION_TIMEOUT_MS`).

**Documentation requirement:** ScriptDev adds a header comment to each script:

```ts
/**
 * Diagnostic script — kept per ES-086 AC-11 as a runnable SDK regression detector.
 *
 * Bypasses the production Promise.race timeout wrapper to probe Anthropic
 * (or OpenAI gpt-5.4) SDK behavior directly. Useful when:
 *   - SDK version bumps to verify field-name compatibility
 *   - Suspected reasoning-token regressions on gpt-5.4 / o-series models
 *   - Manipal-class fixture re-validation post-prompt-restructure
 *
 * NOT invoked from application code. Operator-only.
 */
```

**No code change** beyond the header comment. No CLI argument changes, no schema changes, no production wiring.

### b.14 Files summary

| Action | Path | LOC est. |
|---|---|---|
| **MODIFY** | `geo/lib/services/tree-extractor.ts` | +130, -10 (3 field renames + 2 budget bumps + EXTRACTION_TIMEOUT_MS bump + TreeExtractorSchemaError class + validateExtractionResponse + classifySonnetError + extractTrees catch refactor + 7 GPT-4o renames) |
| **MODIFY** | `geo/app/api/sites/[id]/citation-check/route.ts` | +50, -15 (treeIsEmpty helper + semaphore state + lazy trigger amendment + isNull guard removal + sentinel deletion + maxDuration bump + treeReextractionDeferred flag) |
| **MODIFY** | `geo/scripts/test-tree-extract-budget.ts` | +12, -0 (header doc only) |
| **MODIFY** | `geo/scripts/test-tree-extract-gpt54-budget.ts` | +12, -0 (header doc only) |
| **MODIFY** | `geo/__tests__/services/tree-extractor.test.ts` | +200, -0 (extend with AC-7..AC-19 unit tests) |
| **CREATE** | `geo/__tests__/integration/services/tree-extractor.integration.test.ts` | ~250 (AC-10 + AC-16 + AC-22 saturated path + AC-23 sentinel-overwrite) |
| **CREATE** | `geo/__tests__/fixtures/tree-extract-manipal.json` | ~5K LOC fixture (243-page production capture; **shared with TS-085 AC-1**) |

**No DDL.** **No new dependencies** (zod is NOT added — schema validator is hand-rolled per AC-17 constraint). No env var changes. No config changes.

---

## c) Unit Test Plan

All new tests live in `geo/__tests__/services/tree-extractor.test.ts` (extension of the existing 404-LOC file) unless otherwise noted. The existing file has the Anthropic + OpenAI mock infrastructure (`mockSonnetCreate` / `mockOpenAICreate` hoisted) and test data factories that the new tests reuse.

### c.1 Field name + budget — `callSonnet` / `callOpenAi` arg capture (AC-1 / AC-2 / AC-3 / AC-4 / AC-5 / AC-6)

| # | Test | Setup | Assertion |
|---|---|---|---|
| U1 | Sonnet primary call uses `max_tokens: 20000` | Mock `mockSonnetCreate` to capture args; call `extractTrees` with a fixture | First captured call has `max_tokens === 20000`, NOT `max_completion_tokens` |
| U2 | Sonnet primary call uses model `claude-sonnet-4-6` | Same | Captured `model === "claude-sonnet-4-6"` |
| U3 | gpt-5.4 fallback call uses `max_completion_tokens: 20000` | Mock Sonnet to throw, then capture `mockOpenAICreate` args | Captured call has `max_completion_tokens === 20000`, NOT `max_tokens` |
| U4 | gpt-5.4 fallback call uses model `gpt-5.4` | Same | Captured `model === "gpt-5.4"` |
| U5 | `pruneUngroundedNodes` correction call uses `max_tokens: 2000` | Mock Sonnet success path that returns ungrounded nodes; capture the second `mockSonnetCreate` invocation | Second captured call has `max_tokens === 2000` |
| U6 | Field-name regression guard | Negative assert: capture all `mockSonnetCreate` invocations | No invocation has `max_completion_tokens` set |
| U7 | Field-name regression guard (OpenAI) | Negative assert | No `mockOpenAICreate` invocation has `max_tokens` set (they all use `max_completion_tokens`) |

### c.2 Promise.race timeout (AC-12 / AC-13 / AC-14)

| # | Test | Setup | Assertion |
|---|---|---|---|
| U8 | EXTRACTION_TIMEOUT_MS constant is 200000 | Import the constant from the module | `EXTRACTION_TIMEOUT_MS === 200000`. Note: ScriptDev may need to export the constant for testing OR test indirectly via the timeout helper |
| U9 | Promise.race wraps successful 60s call (under timeout) | Use `vi.useFakeTimers()`. Mock `mockSonnetCreate` to return after 60s. Call `extractTrees`. Advance fake timers. | Returns the mocked result successfully — no timeout error |
| U10 | Promise.race wraps failing 250s call (over timeout) | Mock `mockSonnetCreate` to never resolve. Advance fake timers past 200s. | Throws with error message matching `/Sonnet timeout/` |

### c.3 Schema validator (AC-17 / AC-18)

| # | Test | Setup | Assertion |
|---|---|---|---|
| U11 | Validator passes on valid TreeExtractionResult | Pass `makeValidGeoTree() + makeValidCategoryTree() + valid mapping` | No throw |
| U12 | Validator throws on missing geoTree | Pass `{ categoryTree: ..., mapping: ... }` | Throws `TreeExtractorSchemaError` with `field === "geoTree"` |
| U13 | Validator throws on geoTree.leafCount not a number | Pass `{ geoTree: { leafCount: "five", root: ... }, ... }` | Throws with `field === "geoTree.leafCount"` |
| U14 | Validator throws on geoTree.root.children not array | Pass `{ geoTree: { leafCount: 0, root: { children: "nope" } }, ... }` | Throws with `field === "geoTree.root.children"` |
| U15 | Validator throws on missing categoryTree | Pass `{ geoTree: ..., mapping: ... }` | Throws with `field === "categoryTree"` |
| U16 | Validator throws on categoryTree.leafCount not a number | Same pattern | Throws with `field === "categoryTree.leafCount"` |
| U17 | Validator throws on missing mapping | Pass `{ geoTree: ..., categoryTree: ... }` | Throws with `field === "mapping"` |
| U18 | Validator throws on mapping.entries not array | Pass `{ geoTree: ..., categoryTree: ..., mapping: { entries: null } }` | Throws with `field === "mapping.entries"` |
| U19 | TreeExtractorSchemaError has `field` property | Construct directly | `err.field === "..."`, `err.name === "TreeExtractorSchemaError"` |

### c.4 Catch-block error dispatch (AC-19 — six dispatch rows)

`classifySonnetError` should be exported (or re-exported via `__test_internals`) for unit testing.

| # | Test | Input | Expected output |
|---|---|---|---|
| U20 | Timeout sentinel | `new Error("Sonnet timeout")` | `{ kind: "timeout" }` |
| U21 | Schema error | `new TreeExtractorSchemaError("...", "field")` | `{ kind: "schema" }` |
| U22 | Anthropic 503 overload | `Object.assign(new Error("..."), { status: 503 })` | `{ kind: "overload" }` |
| U23 | Anthropic 529 overload | `Object.assign(new Error("..."), { status: 529 })` | `{ kind: "overload" }` |
| U24 | 400 auth/config | `Object.assign(new Error("..."), { status: 400 })` | `{ kind: "auth_or_config" }` |
| U25 | 401 auth/config | `Object.assign(new Error("..."), { status: 401 })` | `{ kind: "auth_or_config" }` |
| U26 | 403 auth/config | `Object.assign(new Error("..."), { status: 403 })` | `{ kind: "auth_or_config" }` |
| U27 | Network ECONNRESET | `Object.assign(new Error("..."), { code: "ECONNRESET" })` | `{ kind: "network" }` |
| U28 | Network EAI_AGAIN | `Object.assign(new Error("..."), { code: "EAI_AGAIN" })` | `{ kind: "network" }` |
| U29 | Network ETIMEDOUT | `Object.assign(new Error("..."), { code: "ETIMEDOUT" })` | `{ kind: "network" }` |
| U30 | Network EPIPE | `Object.assign(new Error("..."), { code: "EPIPE" })` | `{ kind: "network" }` |
| U31 | Catch-all | `new Error("something weird")` (no status, no code) | `{ kind: "other", errType: "Error", errMsg: "something weird" }` |
| U32 | Non-Error input | `"string err"` | `{ kind: "other", errType: "non-error", errMsg: "string err" }` |

### c.5 Catch-block dispatch — full extractTrees flow (AC-19 wire-up)

| # | Test | Setup | Assertion |
|---|---|---|---|
| U33 | Timeout in attempt 1 → skip attempt 2, fall to gpt-5.4 | Mock `mockSonnetCreate` first call to throw `new Error("Sonnet timeout")`. Mock `mockOpenAICreate` to return valid result. Call `extractTrees`. | `mockSonnetCreate` called exactly **once**. `mockOpenAICreate` called exactly once. Returns the gpt-5.4 result. |
| U34 | Overload (503) in attempt 1 → skip attempt 2, fall to gpt-5.4 | Same pattern with `{ status: 503 }` error | Same — Sonnet called once, OpenAI called once |
| U35 | Schema error in attempt 1 → retry attempt 2 (temp 0.3), succeed | Mock first Sonnet to throw `TreeExtractorSchemaError`. Mock second Sonnet (temp 0.3) to return valid result. | Sonnet called **twice**. Second call's `temperature === 0.3`. OpenAI NOT called. |
| U36 | Auth/config error (401) in attempt 1 → throw, no fallback | Mock Sonnet to throw `{ status: 401 }` | Throws. `mockSonnetCreate` called once. `mockOpenAICreate` NOT called. Empty trees NOT returned. |
| U37 | Network error in attempt 1 → retry attempt 2, succeed | Mock first Sonnet to throw `{ code: "ECONNRESET" }`. Mock second to succeed. | Sonnet called twice. OpenAI not called. |

### c.6 `treeIsEmpty` helper (AC-15)

The helper lives inside `citation-check/route.ts` (not exported) so tests must either import via a `__test_internals` export OR mirror the helper inline in the test file. ScriptDev's call: pick the cleaner pattern.

| # | Test | Input | Expected |
|---|---|---|---|
| U38 | NULL is empty | `null` | `true` |
| U39 | undefined is empty | `undefined` | `true` |
| U40 | Non-object is empty | `"string"`, `42`, `true` | `true` for all |
| U41 | Object with leafCount=0 is empty | `{ leafCount: 0, root: { children: [{...}] } }` | `true` (leafCount short-circuits) |
| U42 | Object with no root.children is empty | `{ leafCount: 5, root: {} }` | `true` |
| U43 | Object with root.children=[] is empty | `{ leafCount: 5, root: { children: [] } }` | `true` |
| U44 | Object with leafCount>0 AND root.children non-empty is NOT empty | `{ leafCount: 5, root: { children: [{ ... }] } }` | `false` |
| U45 | FIX-2 sentinel shape is detected as empty | `{ root: { id: "root", name: "Root", children: [] }, leafCount: 0 }` | `true` |
| U46 | `emptyGeoTree()` is detected as empty | `emptyGeoTree()` | `true` |
| U47 | `emptyCategoryTree()` is detected as empty | `emptyCategoryTree()` | `true` |
| U48 | `makeValidGeoTree()` is NOT detected as empty | `makeValidGeoTree()` (the existing test factory with leafCount=2) | `false` |

### c.7 Smoke + structural tests (AC-7 / AC-8 / AC-9)

| # | Test | Setup | Assertion |
|---|---|---|---|
| U49 | extractTrees on Manipal fixture produces populated trees | Load `__tests__/fixtures/tree-extract-manipal.json` (the 243-page production capture). Mock `mockSonnetCreate` to return a synthetic populated TreeExtractionResult mirroring the production diagnostic output (geoTree.leafCount > 0, categoryTree.leafCount > 0). | `result.geoTree.leafCount > 0 && result.categoryTree.leafCount > 0`. Per AC-7. |
| U50 | extractTrees does NOT return emptyGeoTree() for Manipal | Same setup | `result.geoTree.root.children.length > 0`. Per AC-8. |
| U51 | SaaS-style fixture (small site, single domain, ~50 pages) regression | Use existing `makeCrawlData(50)` factory. Mock Sonnet to return a small valid populated tree (leafCount=1, single category). | `result` shape is valid, validator does not throw, output is small populated tree (not empty fallback). Per AC-9. |

### c.8 Function rename grep test (AC-21)

| # | Test | Setup | Assertion |
|---|---|---|---|
| U52 | No `GPT-4o` references in tree-extractor.ts | Read the file via `fs.readFileSync` in the test | The file content does NOT contain `GPT-4o` or `gpt-4o` (case-insensitive) |

(Quick mechanical guard. ScriptDev can also add this as a lint rule if preferred.)

### c.9 Coverage summary

- **Total new unit tests: 52 (U1–U52)**
- **Existing test file extended:** `geo/__tests__/services/tree-extractor.test.ts` (+200 LOC est.)
- **Coverage target:** 100% of new code in `tree-extractor.ts`, 100% of new helpers in `citation-check/route.ts`, 100% of `classifySonnetError` dispatch table branches.
- **Mock pattern:** reuse existing `mockSonnetCreate` / `mockOpenAICreate` hoisted mocks at lines 17-21 of the existing test file. Tests for `treeIsEmpty` either mirror the helper inline OR ScriptDev exposes via `__test_internals`.

---

## d) Integration Test Plan

New file: `geo/__tests__/integration/services/tree-extractor.integration.test.ts` (CREATE).

These tests use the real `db` (test schema), real `extractTrees`, real `citation-check` route handler, but mock the Anthropic + OpenAI SDKs at the module boundary.

### d.1 End-to-end rescue path (AC-10 / AC-15 / AC-16 / AC-23)

| # | Test | Setup | Assertion |
|---|---|---|---|
| IT1 | Lazy rescue: NULL trees → populated trees persisted | Insert a `geo_sites` row with `geoTree: null`, `categoryTree: null`, valid `crawlData`, valid `discoveryData`, `pipelineStatus: 'complete'`, valid `geoScorecard`, valid team with credit balance ≥ 5. Mock Sonnet to return valid populated trees. POST `/api/sites/{id}/citation-check`. After the SSE stream completes, re-fetch the row from DB. | `row.geoTree.leafCount > 0 && row.categoryTree.leafCount > 0` (post-AC-23 fix — the populated trees are persisted, not just in-memory) |
| IT2 | Lazy rescue: FIX-2 sentinel → populated trees persisted | Insert a row with `geoTree: { root: { id: "root", name: "Root", children: [] }, leafCount: 0 }` (the malformed sentinel from the current production state), same other fields. Hit citation-check. | Same — trees are persisted to DB |
| IT3 | Lazy rescue: emptyGeoTree() shape → populated trees persisted | Insert a row with `geoTree: emptyGeoTree()`, `categoryTree: emptyCategoryTree()`. Same other setup. | Same |
| IT4 | Lazy rescue regression — populated trees stay populated | Insert a row with valid populated `geoTree` and `categoryTree`. Hit citation-check. | The trees are unchanged in DB. The lazy trigger does NOT fire (verified via spy on `extractTrees` mock). |

### d.2 Catch-block dispatch end-to-end (AC-19 / AC-24)

| # | Test | Setup | Assertion |
|---|---|---|---|
| IT5 | Sonnet timeout → gpt-5.4 fallback → trees persisted | NULL-trees row. Mock first Sonnet to reject with `Sonnet timeout`. Mock OpenAI to return valid trees. | DB row has populated trees. Sonnet called once (no temp 0.3 retry). OpenAI called once. |
| IT6 | Sonnet schema error → temp 0.3 retry → success → trees persisted | NULL-trees row. Mock first Sonnet to throw `TreeExtractorSchemaError`. Mock second Sonnet (temp 0.3) to succeed. | DB row populated. Sonnet called twice. OpenAI not called. |
| IT7 | Sonnet auth error → fail fast | NULL-trees row. Mock Sonnet to throw `{ status: 401 }`. | The route returns a 500 (or whatever the error path produces) — does NOT silently write empty trees. **DB row's geoTree stays NULL** (post-AC-24 — no sentinel write). |
| IT8 | All providers fail → no sentinel written | NULL-trees row. Mock Sonnet to throw `Sonnet timeout`. Mock OpenAI to throw `Error("api error")`. | The catch block at line 128 logs the failure but does NOT write a sentinel. DB row's `geoTree` stays NULL. (Per AC-24.) |

### d.3 Semaphore saturation (AC-22)

| # | Test | Setup | Assertion |
|---|---|---|---|
| IT9 | Saturated path proceeds with empty trees, sets deferred flag | Force `activeReextractions = 3` (via test hook or monkey-patch). NULL-trees row. Hit citation-check. | The lazy extraction is SKIPPED. The citation check runs to completion using the empty trees. Credits were already deducted (not refunded). The SSE `complete` event includes `treeReextractionDeferred: true`. **No sentinel is written.** |
| IT10 | Slot available path runs extraction normally | `activeReextractions = 0`. Same setup. | Extraction runs. `activeReextractions` is incremented to 1, then decremented to 0 in the `finally`. DB row populated. SSE `complete` does NOT have the deferred flag (or it's `false`). |
| IT11 | Semaphore release on extraction failure | `activeReextractions = 0`. Mock Sonnet + OpenAI to both throw. Hit citation-check. | After the failing call, `activeReextractions === 0` (decremented in `finally` despite the throw). |

### d.4 Existing test file regression (AC-25 NEW)

| # | Test | Setup | Assertion |
|---|---|---|---|
| IT12 | Existing `tree-extractor.test.ts` (404 LOC) regression gate | Run the existing test file unchanged | All existing tests pass. **Mandatory pre-merge gate** — the +200 LOC extension at AC-7..AC-19 must not break the existing buildPageInventory / validateTrees / pruneUngroundedNodes coverage. |

### d.5 Total integration tests: 12 (IT1–IT12)

**Required infrastructure:** test DB (existing Vitest integration setup), real `db` instance, mocked Anthropic + OpenAI SDKs at the module boundary, hook to manipulate `activeReextractions` for IT9 (or use a Vi.spyOn pattern on the module-local variable).

---

## e) Profiling Requirements

### e.1 What to measure

| Metric | Surface | Tool | Baseline | Tolerance |
|---|---|---|---|---|
| `callSonnet` total wall-clock | tree-extractor.ts | Stage timing logs (existing `console.info` lines) | Pre-fix: ~50ms (rejects immediately). Post-fix: 150-200s for Manipal-class. SaaS sites: ~30-60s. | New baseline; no regression target |
| `callOpenAi` (gpt-5.4) wall-clock | tree-extractor.ts | Same | 167-181s for Manipal (per TS-086 §2.2 diagnostic) | Same |
| End-to-end `extractTrees` (success path) | tree-extractor.ts | Same | Best case: 150-200s (single Sonnet success). Worst case: 405s (Sonnet timeout + gpt-5.4 + correction). | 600s ceiling (AC-20 maxDuration) |
| Sonnet output token consumption | tree-extractor.ts | Anthropic SDK `usage.output_tokens` | Manipal: ~17,774. SaaS: ~3,000-5,000. | Alert if any single call hits the 20K cap (would indicate prompt drift) |
| gpt-5.4 reasoning_tokens share | tree-extractor.ts | OpenAI SDK `usage.completion_tokens_details.reasoning_tokens` | TS-086 §2.2: empirically 0 for tree extraction across all 3 budgets tested | Alert if `reasoning_tokens > 0` (TS-082-style monitoring guard) |
| Lazy re-extraction trigger fire rate | citation-check/route.ts | New log event `tree_reextraction_triggered` | Pre-fix: 0 (truthiness check skipped non-NULL empties). Post-fix: matches the count of customer rows with empty trees, draining over the deploy week. | Should trend to 0 within ~7 days as customers' first citation checks rescue them |
| Semaphore saturation rate | citation-check/route.ts | New log event `tree_reextraction_deferred` | Initial deploy day: peaks during burst. Subsequent days: near 0. | Alert if > 5% of citation checks defer for sustained period |

### e.2 Baseline expectations (production data — TS-086 §2.1 + §2.2)

The diagnostic scripts produced empirical baselines against the Manipal fixture (`manipal-ts083-79f1775171a9`):

**Sonnet (AC-1 + AC-4):**

| Metric | Value |
|---|---|
| Model | `claude-sonnet-4-6` |
| `max_tokens` | 20000 |
| `output_tokens` | 17,774 |
| Output length | 57,604 chars |
| `stop_reason` | `end_turn` |
| Total latency | ~150-200s |
| Result | geoTree.leafCount=1, categoryTree.leafCount=100, mapping.totalEntries=116 |

**gpt-5.4 (AC-2 + AC-5):**

| Metric | Value |
|---|---|
| Model | `gpt-5.4` |
| `max_completion_tokens` | 20000 |
| `completion_tokens` | 10,555 |
| `reasoning_tokens` | **0** |
| `finish_reason` | `stop` |
| Total latency | 181.8s (20K), 167.9s (30K), 178.9s (40K) |
| Result | geoTree.leafCount=1, categoryTree.leafCount=27-33, mapping.totalEntries=28-39 |

**Post-fix expectations:** Sonnet success path on production should converge on `output_tokens` near 17K-18K for healthcare-class sites and `~3K-5K` for SaaS sites. **If any production call hits `output_tokens === 20000` (the cap), open an incident** — that indicates prompt drift consuming the safety margin.

### e.3 Profiling tools

- **Local:** existing `console.info` / `console.warn` JSON event lines in `tree-extractor.ts`.
- **Production:** Vercel function logs + the new `extract_trees_sonnet_attempt1_failed` JSON warning + `tree_reextraction_triggered` / `tree_reextraction_deferred` info events.
- **Manual benchmark:** ScriptDev runs `tsx scripts/test-tree-extract-budget.ts` against staging once after impl lands and posts the timing + token usage in the PR description for AC-21 verification.
- **No new infrastructure** — same logging convention as existing extractTrees code.

---

## f) Load Test Plan

### f.1 Light load validation

Tree extraction is on a lazy path (one-time per site, gated by `treeIsEmpty()`), not a hot serving path. Sustained-load testing is not in scope.

| # | Scenario | Setup | Success criteria |
|---|---|---|---|
| L1 | Semaphore burst — 10 simultaneous citation checks on rows with empty trees | Insert 10 rows with empty trees. Fire 10 parallel POSTs to `/api/sites/{id}/citation-check`. | First 3 acquire semaphore slots, run extraction. Other 7 set `treeReextractionDeferred: true` and proceed with empty trees. **No 5XX errors. No double-charging.** All 10 return `200 OK` with citation check results (some with `treeReextractionDeferred: true` flag). |
| L2 | Semaphore burst recovery — sequential checks after first 3 complete | After L1, the first 3 successful extractions release their slots. Re-fire the 7 deferred rows. | All 7 acquire slots in batches of 3 + 3 + 1, all successfully extract and persist. |

**No throughput SLA.** This is a one-time-per-customer rescue; latency tolerance is generous.

### f.2 Single-site latency baseline (regression sanity)

| # | Scenario | Setup | Success criteria |
|---|---|---|---|
| L3 | Single citation check on populated-trees row | Insert row with valid populated trees. Hit citation-check. | The lazy trigger does NOT fire (verified via spy on `extractTrees` mock). p50 latency unchanged from current baseline. |

This guards against accidentally re-running extraction on already-populated rows.

---

## g) Logging & Instrumentation

### g.1 New log events

All emitted via `console.warn(JSON.stringify({...}))` or `console.info(JSON.stringify({...}))` per the existing convention.

| Event | Level | Source | Payload | Purpose |
|---|---|---|---|---|
| `extract_trees_sonnet_attempt1_failed` | warn | tree-extractor.ts (catch block, attempt 1) | `{ event, domain, attempt, classified: kind, errMsg }` | Track AC-19 dispatch decisions; surface auth/config failures (currently silently swallowed) |
| `extract_trees_sonnet_attempt2_failed` | warn | tree-extractor.ts (catch block, attempt 2) | Same shape | Track temp-0.3 retry outcomes |
| `extract_trees_openai_failed` | warn | tree-extractor.ts (catch block, fallback) | `{ event, domain, errMsg, errStatus }` | OpenAI provider failure visibility |
| `extract_trees_schema_validation_failed` | error | tree-extractor.ts (validator throw site) | `{ event, domain, attempt, schemaError: err.message, field: err.field }` | Surface malformed LLM responses (currently silently swallowed) |
| `tree_reextraction_triggered` | info | citation-check/route.ts (lazy trigger fire) | `{ event, domain, siteId, prior_state: "null"\|"sentinel"\|"empty_emptyGeoTree" }` | Track rescue path fire rate; should drain to 0 over deploy week |
| `tree_reextraction_deferred` | info | citation-check/route.ts (semaphore saturated branch) | `{ event, domain, siteId, active: number }` | Track semaphore saturation rate; should be near 0 outside deploy day |
| `tree_reextraction_complete` | info | citation-check/route.ts (success path) | `{ event, domain, siteId, geoLeaves, catLeaves, mappingEntries, latencyMs }` | Track post-fix success metrics |

### g.2 Existing logs to preserve

- `[citation-check] ${domain}: lazy tree extraction failed: ...` — keep, but note that the malformed-sentinel write below it is REMOVED per AC-24
- `[extract-trees] ${domain}: trees extracted via Sonnet` (post-AC-21: stays as-is, just `Sonnet` not affected by GPT-4o rename)
- `[extract-trees] ${domain}: trees extracted via GPT-4o` → **renamed to `via OpenAI`** per AC-21
- `[extract-trees] ${domain}: tree extraction failed, continuing with empty trees` (last-resort warn) — keep
- `[tree-extractor] Pruned ...` — pruneUngroundedNodes log, unchanged

### g.3 Removed logs

- `// FIX-2: store empty sentinel so extraction isn't retried on every check` — comment AND the UPDATE statement below it are deleted per AC-24.

### g.4 Log levels

- `error` — `extract_trees_schema_validation_failed` (real malformed response)
- `warn` — provider failure events
- `info` — operational metrics (`tree_reextraction_triggered`, `_deferred`, `_complete`)

### g.5 Metric counters (manual via existing log queries)

No new metric infrastructure. The events above are queryable via the existing Vercel log search:

- `tree_reextraction_triggered` count over time → should trend down sharply over the first 24-48h post-deploy
- `tree_reextraction_deferred` count → should be near 0 outside deploy day burst
- `extract_trees_schema_validation_failed` count → should be near 0 (residual fires only on prompt drift)
- `extract_trees_openai_failed` count → should be near 0 (Sonnet handles the load; OpenAI is the fallback)

---

## h) Acceptance Criteria

**Translation of TS-086 §3 acceptance criteria (22), plus 3 new ACs (AC-23 / AC-24 / AC-25) discovered during recon.**

### h.1 Field name fix (TS-086 §3.1)

- [ ] **AC-1:** `geo/lib/services/tree-extractor.ts:260` (Sonnet attempt 1) uses `max_tokens`, NOT `max_completion_tokens`. **Verified by:** U1, U6.
- [ ] **AC-2:** `geo/lib/services/tree-extractor.ts:285` (gpt-5.4 OpenAI fallback) STAYS at `max_completion_tokens` — canonical OpenAI reasoning model field. Model id stays `"gpt-5.4"` (verified canonical). **Verified by:** U3, U4, U7.
- [ ] **AC-3:** `geo/lib/services/tree-extractor.ts:403` (Sonnet correction call inside `pruneUngroundedNodes`) uses `max_tokens`, NOT `max_completion_tokens`. **Verified by:** U5, U6.

### h.2 Token budget fix (TS-086 §3.2)

- [ ] **AC-4:** `geo/lib/services/tree-extractor.ts:260` Sonnet call uses `max_tokens: 20000`. Empirically validated against the Manipal fixture; produces a populated tree with 17,774 output tokens and `stop_reason: end_turn`. **Verified by:** U1, U49 (smoke test).
- [ ] **AC-5:** `geo/lib/services/tree-extractor.ts:285` gpt-5.4 call uses `max_completion_tokens: 20000`. Empirically validated; produces ~10,555 output tokens with `finish_reason: stop` and ZERO reasoning tokens. **Verified by:** U3.
- [ ] **AC-6:** `geo/lib/services/tree-extractor.ts:403` correction call STAYS at `max_tokens: 2000`. **Verified by:** U5.

### h.3 Smoke + integration tests (TS-086 §3.3)

- [ ] **AC-7:** New unit test asserts `extractTrees` against Manipal fixture produces `geoTree.leafCount > 0 AND categoryTree.leafCount > 0`. Fixture at `__tests__/fixtures/tree-extract-manipal.json` (243-page production capture). **Shared with TS-085 AC-1.** **Verified by:** U49.
- [ ] **AC-8:** Same unit test asserts `result.geoTree.root.children.length > 0` (does NOT return `emptyGeoTree()`). **Verified by:** U50.
- [ ] **AC-9:** Regression test using SaaS-style fixture (single-domain, ~50 pages) confirms higher token budget does NOT regress smaller-site behavior. **Verified by:** U51.
- [ ] **AC-10:** Integration test against citation-check route with NULL-trees row asserts post-call `geoTree IS NOT NULL && geoTree.leafCount > 0 && categoryTree.leafCount > 0`. **Verified by:** IT1.

### h.4 Diagnostic script lifecycle (TS-086 §3.4)

- [ ] **AC-11:** Both diagnostic scripts (`scripts/test-tree-extract-budget.ts` and `scripts/test-tree-extract-gpt54-budget.ts`) are KEPT as runnable diagnostic tools. Both already exist. Both bypass the production `Promise.race` wrapper to directly probe SDK behavior. **Documentation comment added per §b.13.** **Verified by:** code review (the header comment) + grep test that asserts neither script is imported from any application file.

### h.5 Promise.race timeout fix (TS-086 §3.5)

- [ ] **AC-12:** `geo/lib/services/tree-extractor.ts:22` declares `EXTRACTION_TIMEOUT_MS = 200_000` (was `35_000`). Stale comment removed in same commit. **Verified by:** U8 (constant value), code review (comment cleanup).
- [ ] **AC-13:** Unit test exercises Promise.race with mock LLM resolving at ~60s — wrapped call returns successfully. Per AC-12 not firing prematurely. **Verified by:** U9.
- [ ] **AC-14:** Unit test exercises Promise.race with mock LLM resolving at ~250s — wrapped call rejects at ~200s with recognizable timeout error. **Verified by:** U10.

### h.6 Lazy re-extraction trigger fix (TS-086 §3.6)

- [ ] **AC-15:** `app/api/sites/[id]/citation-check/route.ts` declares INLINE `treeIsEmpty(t: unknown): boolean` helper (NOT shared utils — per HP-179 schema verification). Lazy trigger amended from `!site.geoTree && !site.categoryTree` to `treeIsEmpty(site.geoTree) || treeIsEmpty(site.categoryTree)`. Preserves `&& crawlData && discoveryData` guard. NO `tierTree`/`pillarTree` references (those columns don't exist). **Verified by:** U38–U48 (helper unit tests), IT1 (rescue path).
- [ ] **AC-16:** Integration test uses non-NULL empty tree fixture (the literal output of `emptyGeoTree()`) and asserts treeIsEmpty returns true, lazy trigger fires, post-extraction trees are populated. **Verified by:** IT2 (FIX-2 sentinel) + IT3 (`emptyGeoTree()` shape).

### h.7 Schema validation gap (TS-086 §3.7)

- [ ] **AC-17:** Hand-rolled runtime schema validator (`validateExtractionResponse`) added to `tree-extractor.ts`. Asserts `geoTree.leafCount`, `geoTree.root.children`, `categoryTree.leafCount`, `categoryTree.root.children`, `mapping.entries`. Throws `TreeExtractorSchemaError` on failure. NO zod dependency. **Verified by:** U11–U18.
- [ ] **AC-18:** `TreeExtractorSchemaError extends Error` typed error class added inside `tree-extractor.ts` (file-local). **Verified by:** U19.

### h.8 Retry policy refinement (TS-086 §3.8)

- [ ] **AC-19:** Sonnet attempt 1 catch block dispatches by error type per the explicit 6-row table:
  | Error type | Detection | Action |
  |---|---|---|
  | timeout | `Sonnet timeout` message | skip retry, fall to gpt-5.4 |
  | schema | `instanceof TreeExtractorSchemaError` | retry at temp 0.3 |
  | overload | `status === 503 \|\| 529` | skip retry, fall to gpt-5.4 |
  | auth_or_config | `status === 400 \|\| 401 \|\| 403` | fail fast, no fallback |
  | network | `code === ECONNRESET \|\| EAI_AGAIN \|\| ETIMEDOUT \|\| EPIPE` | retry at temp 0.3 once |
  | other | catch-all | fall to gpt-5.4 |

  Implemented as `classifySonnetError(err): SonnetErrorClass` discriminated union. **Verified by:** U20–U37, IT5–IT8.

### h.9 Citation-check route maxDuration (TS-086 §3.9)

- [ ] **AC-20:** `app/api/sites/[id]/citation-check/route.ts` exports `export const maxDuration = 600` (was 300). **Verified by:** code review.

### h.10 Stale function name + comments (TS-086 §3.10)

- [ ] **AC-21:** All 7 GPT-4o references in `tree-extractor.ts` updated per SpecMaster note 1 table: function rename `callGpt4o` → `callOpenAi`, file header comment, error message, info logs, validation warning, failed warning. **Mechanical, no behavior change.** **Verified by:** U52 (grep test) + manual code review.

### h.11 Re-extraction thundering-herd guard (TS-086 §3.11)

- [ ] **AC-22:** Global semaphore (`MAX_CONCURRENT_REEXTRACTIONS = 3`, `let activeReextractions = 0`) caps concurrent re-extractions. **In-process counter for v1** (Redis-backed counter is v2). Saturated path proceeds with citation check using empty trees + sets `treeReextractionDeferred: true` flag (NOT return early — that was HP-181 billing bug). Slot release in `finally` block. **Verified by:** IT9 (saturated), IT10 (slot available), IT11 (release on failure).

### h.12 NEW ACs from SpecMaster recon

- [ ] **AC-23 (NEW):** `app/api/sites/[id]/citation-check/route.ts` success-path UPDATE (currently lines 117-122) has the `isNull(geoSites.geoTree)` guard REMOVED. Without this, the rescue path's UPDATE matches 0 rows once any prior empty tree (NULL or sentinel) exists, and the populated trees are never persisted to DB (only in-memory). **See SpecMaster note 2 for the full bug analysis.** **Verified by:** IT1 + IT2 + IT3 — all three integration tests assert the trees are persisted to DB, not just to the in-memory site object.
- [ ] **AC-24 (NEW):** `app/api/sites/[id]/citation-check/route.ts` catch block (currently lines 128-135) has the FIX-2 sentinel UPDATE DELETED. Post-AC-15 the rescue trigger detects empty trees structurally via `treeIsEmpty()`, so a "don't retry" marker is unnecessary. The malformed sentinel shape (`{ root: { id: "root", name: "Root", children: [] }, leafCount: 0 }`) is also a typed-data integrity violation. **See SpecMaster note 3 for the full bug analysis.** **Verified by:** IT7 + IT8 — integration tests assert that on extraction failure, no sentinel is written; the row's `geoTree` stays in its prior state.
- [ ] **AC-25 (NEW):** Existing `__tests__/services/tree-extractor.test.ts` (404 LOC) regression gate. The +200 LOC extension at AC-7..AC-19 must not break the existing buildPageInventory / validateTrees / pruneUngroundedNodes coverage. **Mandatory pre-merge gate.** **Verified by:** IT12.

### h.13 Cross-cutting checks

- [ ] **AC-26:** No new dependencies added to `package.json`. Validator is hand-rolled per AC-17 constraint.
- [ ] **AC-27:** No DDL migrations.
- [ ] **AC-28:** No env var changes.
- [ ] **AC-29:** Branch is `fix/tree-extractor-and-bulk-audit` (NEW branch for the sprint, NOT shared with `fix/llms-txt-empty-generation` from ES-082). All 4 sprint specs (ES-083, ES-084, ES-085, ES-086) commit to the same branch.
- [ ] **AC-30:** PR description includes:
  1. Manual benchmark output from §e.3 against staging Manipal fixture
  2. Confirmation that `reasoning_tokens === 0` in the gpt-5.4 fallback test
  3. `grep -r "GPT-4o\|gpt-4o" lib/services/tree-extractor.ts` returns zero matches
  4. Confirmation that `extract_trees_schema_validation_failed` did not fire in the benchmark
  5. Confirmation that the diagnostic scripts still run successfully against the staging fixture

### h.14 Done definition

ES-086 is **done** when:

1. All 30 ACs (22 from TS-086 + 3 new from recon + 5 cross-cutting) are checked
2. ReviewMaster Phase A delivers test scaffolding for all 52 unit + 12 integration tests
3. ScriptDev's PR has the AC-21 grep clean
4. Manual benchmark in PR description confirms `output_tokens` near 17K-18K for Manipal Sonnet, near 10K for Manipal gpt-5.4
5. Existing `tree-extractor.test.ts` 404-LOC regression gate (IT12 / AC-25) passes
6. Both diagnostic scripts still execute successfully against the Manipal fixture
7. The semaphore saturated path L1/L2 load tests pass
8. **The 3 SpecMaster notes (latent bugs) are addressed via AC-23 + AC-24** — NOT skipped, NOT deferred

---

## Notes for downstream agents

### For ReviewMaster (Phase A)

1. **Test file count: 1 new file + 1 fixture file + 1 extension** — see §c.9 + §d.5. Match the structure exactly.
2. **Use DIFFERENT fixture identifiers than ScriptDev's source.** Same convention as ES-081 / ES-082. ScriptDev uses literal `manipal-ts083-79f1775171a9` for the fixture file name, but in your tests use `manipal-fixture-rm` site IDs to keep ReviewMaster Phase A independent of ScriptDev source.
3. **The Manipal fixture is SHARED with TS-085 AC-1.** ScriptDev creates it during the ES-086 implementation pass; ES-085 implementation consumes it. **Coordinate fixture creation order with the ES-085 task.**
4. **U33 / IT5 are load-bearing for AC-19** — they assert the timeout-skip behavior. Without the AC-19 dispatch table working correctly, every Sonnet timeout would still attempt the temp-0.3 retry (200s wasted) before falling to gpt-5.4. The tests must demonstrate the SHORT-CIRCUIT behavior.
5. **IT1 / IT2 / IT3 are the canary tests for the 3 latent bugs (AC-23 + AC-24).** Without these, ScriptDev could ship the AC-15 amendment alone and the rescue path would still be broken (in-memory only). All three must transition RED → GREEN across the ScriptDev diff.
6. **IT12 (existing test regression gate) is mandatory** — running the existing 404-LOC `tree-extractor.test.ts` unchanged is non-negotiable.
7. **`treeIsEmpty` and `classifySonnetError` are module-private until ScriptDev exports them.** For U20-U48 you'll need either a `__test_internals` export OR ScriptDev exports the helpers directly. Your call — specify in your delivery.
8. **IT9 needs a hook to manipulate `activeReextractions`.** Either ScriptDev exports a `__test_internals.setActiveReextractions(n)` setter OR you use `vi.spyOn` on the module. Coordinate with ScriptDev impl.
9. **Site IDs: NEVER use the literal `-GzFX1KcKhmN0W_1t8SmY`** (real Manipal customer site) in any RM test fixture. Use `manipal-fixture-rm`, `-it1`, `-it7`, etc.

### For CostMaster

1. **Files (CREATE):** 2 (`tree-extractor.integration.test.ts`, `tree-extract-manipal.json` fixture)
2. **Files (MODIFY):** 5 (tree-extractor.ts, citation-check/route.ts, both diagnostic scripts, tree-extractor.test.ts)
3. **Total LOC est.:** ~180 (impl) + ~450 (tests + fixture) = ~630
4. **No new dependencies, no DDL, no new env vars.**
5. **Branch:** new `fix/tree-extractor-and-bulk-audit` (NOT shared with ES-082's branch). All 4 sprint specs (ES-083, ES-084, ES-085, ES-086) commit here.
6. **Sequencing:** ES-086 ScriptDev tasks must complete BEFORE ES-085 tasks start working on the shared `tree-extract-manipal.json` fixture (ES-086 creates, ES-085 consumes).
7. **Lang:** `typescript`
8. **AC-23 + AC-24 are NEW ACs from SpecMaster recon** — taskboard should explicitly call out the 3 latent bug fixes (per the AC-16 / TS-082 precedent that surfaced the assembleResults adapter).
9. **Diagnostic scripts ALREADY EXIST** (228 + 274 LOC). AC-11 is "keep them, add header comments" — do not create new task for "create diagnostic scripts".

### For CoFounder

1. **Spec ready for ReviewMaster + CostMaster dispatch.** No open questions remain (TS-086 §6 closed).
2. **3 latent bugs surfaced during recon (AC-23, AC-24, plus the AC-21 enumeration discrepancy in SpecMaster note 1).** All 3 are real and load-bearing — without AC-23 + AC-24, the rescue path is purely in-memory and never persists. Worth noting that the AC-16 / TS-082 precedent paid off again here.
3. **Branch creation:** the sprint spec describes branch `fix/tree-extractor-and-bulk-audit` as the target, but the spec files are currently parked on `fix/llms-txt-empty-generation`. Per your dispatch message, you'll move them to the new branch before any code lands. ScriptDev should not start coding until the branch is in place.
4. **Sprint sequencing:** ES-086 ships first (this spec), then ES-083 + ES-084 + ES-085 in parallel. The Manipal fixture from AC-7 is created by ScriptDev during ES-086 impl and consumed by ES-085 (and possibly ES-083 AC-15 integration test fixture base).
5. **Anthropic SDK ^0.78.0 + OpenAI SDK ^6.18.0 confirmed** — no SDK upgrades required.

---

**End of ES-086**
