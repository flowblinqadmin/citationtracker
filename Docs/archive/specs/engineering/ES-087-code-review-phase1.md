# ES-087 Code Review — PR-A Phase 1

**Reviewer**: Code Reviewer Agent (claude-sonnet-4-6)
**Commit**: 3cc04b0
**Date**: 2026-04-09
**Files reviewed**:
- `app/sites/[id]/design-tokens.ts`
- `app/sites/[id]/hooks/useSiteData.ts`
- `__tests__/hooks/useSiteData.test.ts`
- `__tests__/sites/design-tokens.test.ts`

---

## ANALYSIS_RESULT

```json
{
  "action": "reviewed",
  "findings": {
    "critical": [],
    "warnings": [
      {
        "issue": "ALL_STAGES in useSiteData.ts diverges from SitePageClient.tsx: hook has 7 stages (includes 'extracting'), original has 7 stages with 'extracting' in position 3 but the COMMENT on the original says extracting is aliased to crawling precisely so ALL_STAGES.length stays 6 for /6 percentage math (line 503). The hook's ALL_STAGES has 7 entries including 'extracting', while SitePageClient.tsx's ALL_STAGES also has 7 but the alias to 'crawling' means findIndex('extracting') would match index 2 — in the hook it would ALSO match index 2 (extracting), not index 1 (crawling). The aliasing still produces the same currentStageIndex value. BUT the hook's ALL_STAGES now has 7 entries whereas the original comment says the alias keeps count at 6. If the shell (SitePageClient.tsx) still uses its OWN ALL_STAGES for rendering circles and the /6 math, and the hook has its own copy with 7, the counts are currently in sync (both have 7). However the duplication means they can silently drift if one is changed without updating the other.",
        "file": "app/sites/[id]/hooks/useSiteData.ts:25-33",
        "fix": "Extract ALL_STAGES into a shared constant (e.g. lib/config.ts or a new pipeline-stages.ts) imported by both SitePageClient.tsx and useSiteData.ts. A single source of truth eliminates the drift risk."
      },
      {
        "issue": "SitePageClient.tsx uses `currentIndex` (the raw variable name). useSiteData.ts exports it as `currentStageIndex`. The hook is not yet consumed by SitePageClient.tsx (that's remaining PR-A work), but when the wiring happens the caller must remember to rename from `currentIndex` to `currentStageIndex`. This is a rename trap that is easy to miss during cut-over and won't be caught by TypeScript since both are numbers.",
        "file": "app/sites/[id]/hooks/useSiteData.ts:179",
        "fix": "Document the rename in the hook's JSDoc or in the PR-A cut-over checklist. Alternatively rename the local variable in the hook return to match the existing name `currentIndex` — or the caller alias is fine as long as it's tracked."
      },
      {
        "issue": "useSiteData.ts re-declares a local `_PR` type alias inside useMemo (lines 231-236). This is a locally-scoped type used only to cast `providerResults` for the aggregation loop but is then referenced again at lines 287-294 on `totalMentions`/`totalQueryCount` using the same `_PR[]` cast on `providerResults`. The type is declared in the middle of a large useMemo body. It is invisible at the module level and forces the reader to locate the declaration amidst runtime logic.",
        "file": "app/sites/[id]/hooks/useSiteData.ts:231-236",
        "fix": "Hoist `_PR` to module scope alongside the other interface declarations (lines 37-72) to make the module's type surface readable in one place."
      }
    ],
    "suggestions": [
      {
        "issue": "Unused `_PR` type re-cast on lines 258 and 287-294: providerResults is already typed as ProviderResultWithSamples[] at line 237. The subsequent `(providerResults as _PR[])` casts on lines 258 and 287/290 are redundant since ProviderResultWithSamples extends _PR structurally. The local _PR alias adds noise without adding safety.",
        "file": "app/sites/[id]/hooks/useSiteData.ts:258, 287, 290"
      },
      {
        "issue": "visibleCompetitors is assigned directly to competitorData (line 239) with no transformation. hiddenCompetitorCount is hardcoded to 0 (line 240). Both are faithful to the original, but the SiteDerivedData interface declares them as first-class fields, suggesting future callers will treat them as distinct concepts. The comment 'PR-B replaces' is only on estAfterFixes (line 93), not on visibleCompetitors. If this tier-gating logic never ships it becomes permanent dead state.",
        "file": "app/sites/[id]/hooks/useSiteData.ts:239-240"
      },
      {
        "issue": "providerAggregates visibility score averaging (line 278-279) uses a simple rolling average of two values rather than a weighted average. For two providers with the same key and different totalQueries, the existing algorithm (identical to SitePageClient.tsx) under-weights the higher-volume provider. This is a pre-existing issue faithfully preserved, but worth flagging since it is now in an isolated, testable function where it is cheapest to fix.",
        "file": "app/sites/[id]/hooks/useSiteData.ts:276-280"
      },
      {
        "issue": "formatDate in design-tokens.ts calls `new Date(iso)` without any guard against invalid date strings. `new Date('invalid')` returns an Invalid Date and `toLocaleDateString` returns 'Invalid Date' as a string rather than throwing. The test suite only covers null, empty string, and valid ISO strings. A malformed string (e.g. user-supplied or corrupted DB value) would produce a visible 'Invalid Date' string in the UI.",
        "file": "app/sites/[id]/design-tokens.ts:41-47"
      },
      {
        "issue": "Test D9d documents the parseInt behavior for 'Pages with FAQ content average 4.9 AI citations' → strips non-digit/minus chars → '49' → 49. The comment in the test correctly describes this, but the test is asserting the current (arguably broken) behavior of the regex rather than the intended behavior. This is the 'broken client-side calc' the comment on estAfterFixes (hook line 93) refers to. The test locks in the broken behavior, which is the stated intent for PR-A. Just ensure PR-B's replacement test deletes or supersedes D9d; otherwise the locked-in value of 49 will be a false historical record.",
        "file": "__tests__/hooks/useSiteData.test.ts:332-349"
      },
      {
        "issue": "Tests D13 (null site) use repeated describe labels — six separate `it('D13 — ...')` blocks all share the label 'D13'. Vitest will not fail on duplicate test IDs within a describe, but test reporters and CI summaries will show multiple 'D13' entries which makes it harder to identify which assertion failed.",
        "file": "__tests__/hooks/useSiteData.test.ts:421-481"
      }
    ],
    "positive": [
      "Behavioral equivalence to SitePageClient.tsx lines 491-632 is exact. Every derivation (scorecard, pillars, liveScore, pageCount, criticalCount, tierCounts, recs, sortedPages, estAfterFixes, all citation fields, providerAggregates, pillarDisplayName) was checked line by line against the original and no behavioral differences were found.",
      "projectedScore is correctly extracted from site.projectedScore (not computed client-side) even though it did not exist in the original lines 491-632 — it originates from the page.tsx prop mapping and is a reasonable addition to the hook's surface since it belongs to the same data context.",
      "The extracting→crawling alias is correctly preserved in the hook with an explanatory comment matching the original.",
      "SORT_ORDER is promoted from an inline local (SitePageClient line 530) to a named module-level constant, which is a genuine improvement.",
      "SHORT_NAMES is promoted from an inline local (SitePageClient line 622) to a named module-level constant.",
      "The hook correctly excludes filteredPillars, filteredPages, and pagedRows — these depend on tab-local state and must remain inside their respective tab components. The JSDoc note on line 6-9 explains this correctly.",
      "useMemo dependency array [site, lastCitationCheck] is minimal and correct — there are no missing dependencies (all computations inside the memo reference only site, lastCitationCheck, and module-level constants).",
      "The hook is a pure computation with no side effects, no async operations, and no external calls — it is safe to test with renderHook without any mocking.",
      "74 tests provide strong coverage of all exported values, boundary conditions, null inputs, and sort ordering. The citationRate arithmetic test (D15) works through the math explicitly in comments.",
      "design-tokens.test.ts tests boundary values for scoreColor and scoreTier (exactly 75, exactly 50, exactly 25) which are the most important edge cases for these helpers.",
      "formatDate test uses a regex match rather than a hardcoded string, making the test timezone-tolerant for CI environments that may not use en-US locale.",
      "No security concerns. No environment variables accessed, no API calls, no user input processed."
    ]
  },
  "files_reviewed": [
    "app/sites/[id]/design-tokens.ts",
    "app/sites/[id]/hooks/useSiteData.ts",
    "__tests__/hooks/useSiteData.test.ts",
    "__tests__/sites/design-tokens.test.ts"
  ],
  "recommendations": [
    "Extract ALL_STAGES to a shared module (lib/config.ts or a new pipeline-stages.ts) to prevent silent divergence between the hook and the shell component.",
    "Hoist the _PR type alias out of the useMemo body to module scope.",
    "Add a guard in formatDate for invalid Date objects to prevent 'Invalid Date' rendering in production.",
    "Give each D13 null-site test a unique ID in the test name string."
  ],
  "blocks_release": false
}
```

---

## Detailed Findings

### Warning 1 — ALL_STAGES Duplication

**What**: `useSiteData.ts` declares its own copy of `ALL_STAGES` (lines 25-33). `SitePageClient.tsx` has its own copy (lines 39-47). Both currently have 7 entries and identical content, so the `currentStageIndex` computation is equivalent. But they are separate constants with no import relationship.

**Where**: `app/sites/[id]/hooks/useSiteData.ts:25-33` and `app/sites/[id]/SitePageClient.tsx:39-47`

**Why**: If a future pipeline stage is added or renamed in `SitePageClient.tsx` and the hook is not updated (or vice versa), `currentStageIndex` will silently return the wrong value without any compile-time error. The original comment on `SitePageClient.tsx` line 503 references the array length explicitly ("keeps ALL_STAGES.length = 6") — that comment is now stale (the array has 7 entries in both files), but more importantly the comment can only be trusted for one of the two copies.

**Fix**: Move `ALL_STAGES` to `lib/config.ts` (where other pipeline constants live) and import it in both files. This is one line of change per file.

---

### Warning 2 — Variable Rename Trap on Cut-Over

**What**: The original `SitePageClient.tsx` names this variable `currentIndex` (line 506). The hook exports it as `currentStageIndex` (hook line 129 in `SiteDerivedData`, returned at line 351). The hook is not yet wired into `SitePageClient.tsx` — that is stated remaining PR-A work. When the wiring happens, the engineer must remember to rename `currentIndex` to use `data.currentStageIndex`, and must update the `displayIndex` alias on line 1001 of `SitePageClient.tsx`.

**Where**: `app/sites/[id]/hooks/useSiteData.ts:179` (return object key `currentStageIndex`)

**Why**: Both are `number`. TypeScript will not catch a missed rename. The risk is low but non-zero during the cut-over step.

**Fix**: Add a note in the PR-A cut-over checklist (or in a TODO comment in `SitePageClient.tsx` at line 506) tracking the rename. Alternatively, use `currentIndex` as the field name in `SiteDerivedData` to preserve continuity.

---

### Warning 3 — Local Type Alias Buried in useMemo Body

**What**: The `_PR` type alias is declared at lines 231-236, inside the `useMemo` callback, sandwiched between runtime variable declarations. It is then used again at lines 258, 287, and 290 (also inside the memo). In TypeScript, a `type` declaration in a function body is valid but unconventional — it breaks the expectation that types appear at module scope.

**Where**: `app/sites/[id]/hooks/useSiteData.ts:231-236`

**Why**: A reader scanning the module to understand its type surface has to read through runtime logic to find this alias. It also makes the type invisible to callers even though `ProviderResultWithSamples` is already exported and structurally equivalent.

**Fix**: Hoist to module scope alongside the other interface declarations on lines 37-72.

---

### Suggestion — formatDate Does Not Guard Invalid Dates

**What**: `formatDate` in `design-tokens.ts` calls `new Date(iso).toLocaleDateString(...)` without checking if the result is a valid date. `new Date('garbage')` produces an `Invalid Date` object; calling `toLocaleDateString()` on it returns the string `"Invalid Date"` rather than throwing, so it renders silently in the UI.

**Where**: `app/sites/[id]/design-tokens.ts:41-47`

**Why**: The function accepts `string | null`. The null case is handled. An invalid string (corrupted DB value, unexpected format) passes through and renders `"Invalid Date"` in production.

**Fix**: Add `if (isNaN(new Date(iso).getTime())) return "Never";` after the null/empty check.

---

### Suggestion — Duplicate D13 Test IDs

**What**: The "null site" describe block (`__tests__/hooks/useSiteData.test.ts:421-481`) contains 12 test cases all labeled `"D13 — ..."` with different suffixes, but the `it()` title strings are all `"D13 — scorecard is null"`, `"D13 — pillars is empty array"`, etc. These are unique strings so Vitest treats them as distinct tests — no functional problem. The issue is that if any of them fails, the reporter will print `D13 — scorecard is null FAILED` and it is ambiguous which of the 12 "D13" tests failed without reading the full message.

**Where**: `__tests__/hooks/useSiteData.test.ts:421-481`

**Fix**: Use `D13a`, `D13b`, etc. to give each test a unique prefix matching the pattern used elsewhere in the file (`D4b`, `D5b`, `D8c`, etc.).

---

## Behavioral Equivalence Verification

The following table summarizes the line-by-line comparison between `SitePageClient.tsx` (lines 491-632) and `useSiteData.ts`.

| Derivation | SitePageClient.tsx | useSiteData.ts | Match |
|---|---|---|---|
| scorecard | line 492 | line 163 | Identical |
| pillars | line 493 | line 164 | Identical |
| liveScore | line 507 | line 165 | Identical (order differs, value same) |
| pageCount | lines 494-496 | lines 166-169 | Identical |
| criticalCount | line 497 | lines 170-173 | Identical |
| stageLookupStatus / alias | line 505 | lines 175-178 | Identical |
| currentIndex | line 506 | lines 179-181 | Identical (renamed to currentStageIndex) |
| tierCounts | lines 510-517 | lines 184-188 | SitePageClient uses inline if/else; hook uses scoreTier(). Functionally identical since scoreTier uses the same thresholds (>=75 Good, >=50 Fair, >=25 Weak, else Poor). |
| recs (sort) | lines 526-534 | lines 191-201 | Identical |
| allPages / sortedPages | lines 539-545 | lines 203-214 | Identical |
| estAfterFixes | lines 554-558 | lines 217-225 | Identical |
| providerResults | line 563 | line 237 | Identical (type differs: _PR[] vs ProviderResultWithSamples[]) |
| competitorData | line 568 | line 238 | Identical |
| visibleCompetitors | line 571 | line 239 | Identical |
| hiddenCompetitorCount | line 575 | line 240 | Identical |
| hasSovSamples | lines 580-582 | lines 243-245 | Identical (hook uses providerResults; original uses a separate providerResultsWithSamples cast — same data) |
| pillarVisibility | line 584 | line 247 | Identical |
| geoVisibility | line 585 | line 248 | Identical |
| categoryVisibility | line 586 | line 249 | Identical |
| tierVisibility | line 587 | line 250 | Identical |
| changeLog | line 588 | line 251 | Identical |
| providerAggMap | lines 591-605 | lines 254-282 | Identical |
| providerAggregates | line 606 | lines 283-285 | Identical |
| totalMentions | line 608 | lines 287-290 | Identical |
| totalQueryCount | line 609 | lines 291-293 | Identical |
| citationRate | line 610 | lines 295-298 | Identical |
| ourSOV | line 612 | line 300 | Identical |
| topCompetitor | lines 613-615 | lines 301-306 | Identical |
| pillarNameMap | lines 618-621 | lines 309-311 | Identical |
| pillarDisplayName | lines 627-632 | lines 313-320 | Identical |
| projectedScore | not in 491-632 (comes from page.tsx prop) | line 227 | Addition — correct and appropriate |

**Verdict**: Behavioral equivalence is confirmed. The only material addition is `projectedScore`, which is pulled from `site.projectedScore` and was previously passed as a prop to sub-components. Including it in the hook is the correct design.

---

## Test Coverage Assessment

74 tests across 2 files covering:

- **design-tokens.ts** (14 tests): `scoreColor` (4), `scoreTier` (5), `formatDate` (5). All boundary values tested. Coverage is complete for the exported surface.

- **useSiteData.ts** (60 tests): Every field in `SiteDerivedData` has at least one positive test and at least one null/empty input test. Sort ordering (sortedPages, recs) has tiebreaker tests. The `providerAggregates` aggregation logic and `pillarDisplayName` fallback chain are covered.

**Missing coverage**:

1. `formatDate` with an invalid (non-null, non-empty, non-ISO) string — e.g. `formatDate("not-a-date")`. Given the suggestion above about the missing guard, this gap is worth closing.
2. Pipeline stage `currentStageIndex` for the `"extracting"` alias specifically — a test that passes `pipelineStatus: "extracting"` and verifies `currentStageIndex === 1` (crawling index) would pin the alias behavior.
3. `pillarDisplayName` for a pillar whose ID has no underscores — currently all test IDs use underscores. Testing `pillarDisplayName("faq")` uses the pillarNameMap path, but testing a short single-word unknown pillar (e.g. `pillarDisplayName("new")`) would exercise the title-case branch on a string with no `_`.
4. `recs` where a recommendation has neither `priority` nor `impact` — the fallback to `"LOW"` is not tested.

None of these gaps are blocking, but items 2 and 4 directly cover behavior that is documented in code comments as non-obvious.

---

## Security Assessment

No concerns. The files contain:
- Pure computation functions
- No API calls, no external network requests
- No environment variable access
- No user-supplied input processed (data flows from typed props only)
- No `eval`, `Function()`, or dynamic code execution

---

## Next.js / React 19 Compatibility

No issues. `useMemo` with a stable dependency array `[site, lastCitationCheck]` is correct React 19 usage. The hook has no effects, no refs, no context, and no concurrent-mode concerns. The `pillarDisplayName` function is recreated inside `useMemo` (not as a `useCallback`), which is correct — it captures `pillarNameMap` from the same memo computation and cannot be separated.
