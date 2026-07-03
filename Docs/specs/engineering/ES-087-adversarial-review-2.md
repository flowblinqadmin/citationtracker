# ES-087 Adversarial Engineering Review (Round 2)

**Reviewer**: Code Review Agent
**Date**: 2026-04-09
**Spec reviewed**: `docs/specs/engineering/ES-087-ux-audit-overhaul.md`
**Verdict**: 4 BLOCKERS, 7 WARNINGS, 5 INFO

---

## 1. Interface Mismatches: `useSiteData` and `useSiteActions`

### BLOCKER-1: `useSiteActions` spec declares `handleDownloadPdf` but no such function exists

The `SiteActions` interface at spec line 207 lists `handleDownloadPdf: () => Promise<void>`. Grep of `SitePageClient.tsx` returns zero matches for `handleDownloadPdf`. The PDF download is an inline anonymous `onClick` handler at line 1263, not a named function. It also uses `setHoveredRail("report-loading")` internally, which couples it to the sidebar's `hoveredRail` state.

**Impact**: The hook interface promises a function that does not exist. Implementing it requires inventing behavior or extracting the inline handler, which means PR-A is NOT a zero-behavior-change extraction -- it requires refactoring the anonymous handler into a named function.

**Fix**: Either (a) remove `handleDownloadPdf` from the `SiteActions` interface and keep the PDF handler inline in `ActionSidebar.tsx`, or (b) explicitly call out in A3 that this anonymous handler must be extracted into a named function and define its signature (it depends on `token`, `lc`, `siteId`, `site?.domain`, `setHoveredRail`, and `poll`).

---

### BLOCKER-2: `useSiteData` is missing `filteredPillars` and `filteredPages`/`pagedRows`

The spec's `SiteDerivedData` interface (lines 109-153) includes `allPages` and `sortedPages` but NOT `filteredPages` or `pagedRows`. However, the actual code at lines 546-551 computes `filteredPages` (filtered by `pageFilter` and `pageSearch`) and `pagedRows` (paginated slice), both of which depend on PagesTab-local state (`pageFilter`, `pageSearch`, `pageCursor`). This is fine if filtering is moved into PagesTab -- but the spec does not mention this.

Similarly, `filteredPillars` (line 519) depends on `tierFilter` state and is used directly at line 1852 in the Scorecard tab. The spec's `SiteDerivedData` returns only `pillars`, not `filteredPillars`. The Scorecard tab would need to re-derive `filteredPillars` from `pillars` + its local `tierFilter` state.

**Impact**: If an implementer follows the spec literally, they will put `filteredPillars` and `filteredPages`/`pagedRows` in `useSiteData` -- but those depend on tab-local state (`tierFilter`, `pageFilter`, `pageSearch`, `pageCursor`) that the hook does not accept as parameters. Or they will omit them from the hook and the tab components will have no guidance on how to reconstruct the filtering.

**Fix**: Explicitly state that per-tab filtering (`filteredPillars`, `filteredPages`, `pagedRows`) is NOT in `useSiteData` and MUST be re-derived inside the respective tab components using their local filter state + the `pillars`/`sortedPages` data from the hook.

---

### WARNING-1: `useSiteData` is missing `visibleCompetitors` and `hiddenCompetitorCount`

Lines 571-575 compute `visibleCompetitors` and `hiddenCompetitorCount`. These are used in the Overview tab's SOV section (line 1575, 1584). Neither appears in the `SiteDerivedData` interface. Since `visibleCompetitors` is currently just an alias for `competitorData` and `hiddenCompetitorCount` is hardcoded to 0, this is low-risk, but the implementer will find references to these variables in the Overview JSX with no source.

**Fix**: Add both to `SiteDerivedData`, or document that the Overview tab should inline these (they are trivial).

---

### WARNING-2: `useSiteData` is missing `estAfterFixes` and `top3Boost`

The spec says (line 166): "estAfterFixes removed. Replaced by projectedScore from site.projectedScore (see PR-B F-03 fix)." However, PR-A is supposed to be zero-behavior-change. If PR-A removes `estAfterFixes` before PR-B adds the `projectedScore` display, there will be a period where the "Est. after fixes" metric disappears entirely from the hero card (line 1360).

**Fix**: In PR-A, `useSiteData` should still compute `estAfterFixes` identically to the current code (lines 554-558). PR-B then replaces it with `projectedScore`. The spec should explicitly say: "A2 preserves `estAfterFixes`; B1 replaces it."

---

### WARNING-3: `useSiteActions` does not accept all required dependencies

The `useSiteActions` signature (spec line 220-227) accepts:
```
siteId, token, site, setSite, setActiveTab, poll
```

But the actual action handlers also depend on:
- `setCitationScanActive` (line 337) -- state setter for `citationScanActive`
- `setCompetitorScanActive` (line 361)
- `setDiscoveredCompetitors`, `setUserCompetitors`, `setCompetitorBlocklist` (lines 383-414)
- `addCompetitorName`, `addCompetitorDomain`, `showDomainInput` and their setters (lines 400-417)
- `setRefreshError` (line 315)
- `setDownloadError` (line 284)
- `setOtherLoading`, `setOtherError`, `setOtherConfig`, `otherPlatform` (lines 924-944)
- `setTestingConnection`, `setConnectionResult` (lines 907-921)
- `setAuthLoading`, `setAuthError`, `email`, `emailInputRef` (lines 252-280)

The spec's approach is to have the hook own all these states internally (they are listed as return values in `SiteActions`). This is correct for most of them -- but `otherPlatform` is both an input that the user types AND a dependency of `handleOtherPlatform`. The hook would need to own the `otherPlatform` state, but the UI input that sets it is in SetupTab. This creates a circular dependency: SetupTab renders the input, the hook owns the state, SetupTab needs `setOtherPlatform` from the hook but also needs to pass it back to display.

**Impact**: Workable but needs careful wiring. The spec should explicitly show that `otherPlatform`, `setOtherPlatform`, `otherConfig`, `otherError`, `otherLoading` are all returned from `useSiteActions` and the SetupTab treats them as controlled props.

---

## 2. Component Boundary Violations

### WARNING-4: `citationScanActive` used in both Sidebar AND Overview tab

`citationScanActive` is used:
- In the sidebar (line 1199): to disable the "Scan Citations" button
- In the Overview tab (line 1334): to show the "Running citation scan..." banner

The spec lists `citationScanActive` as a return value of `useSiteActions` (line 188). Both `OverviewTab` and `ActionSidebar` receive `actions: SiteActions` as a prop. This works -- both can read `actions.citationScanActive`. No boundary violation.

BUT: `competitorScanActive` has the same cross-boundary usage (sidebar line 1221, Overview line 1436) and is also in `SiteActions`. This is fine.

**Status**: No actual violation -- the spec handles this correctly via the shared `SiteActions` object. Noting for completeness.

---

### WARNING-5: `showUpgradeModal` / `setShowUpgradeModal` crosses Overview and shell

At line 1596, the Overview tab's SOV section calls `setShowUpgradeModal(true)`. This state is declared at shell level (line 172) and the `UpgradeModal` is rendered in the shell (line 2576). The spec lists `showUpgradeModal` as shell state (A6, line 259) but does NOT include `setShowUpgradeModal` in either `useSiteActions` or in the OverviewTab props table (A5, line 246).

**Impact**: The OverviewTab will need `setShowUpgradeModal` as a prop, or it needs to be added to `useSiteActions`. The spec omits this.

**Fix**: Add `setShowUpgradeModal` to the OverviewTab props or to `SiteActions`.

---

### WARNING-6: `setActiveTab` is called from within tab components

The Overview tab calls `setActiveTab("scorecard")` at line 1641 and `setActiveTab("recommendations")` at line 1814 (the "View all" links). The spec's A5 table does not list `setActiveTab` as a prop for OverviewTab -- it only lists `data`, `actions`, `isMobile`, `site`, `lastCitationCheck`, and competitor state.

Similarly, HeroMetrics in PR-C (C23) needs `setActiveTab` to make hero metric cards clickable.

**Impact**: Missing prop. Easy fix but if not addressed, the "View all X pillars" and "View all X recommendations" links in Overview will break.

**Fix**: Add `setActiveTab` (or the spec's proposed `handleTabChange` from B5) to OverviewTab props.

---

## 3. PR Ordering Risk

### BLOCKER-3: PR-B modifies files that PR-A creates from scratch

PR-A creates NEW files: `useSiteData.ts`, `useSiteActions.ts`, `OverviewTab.tsx`, `HeroMetrics.tsx`, `ActionSidebar.tsx`, etc. PR-B then modifies those exact files (B1 modifies `useSiteData.ts` and `HeroMetrics.tsx`, B2 modifies `RecommendationsTab.tsx`, B6 modifies `ActionSidebar.tsx`).

This is NOT a merge conflict risk per se -- since the files do not exist before PR-A, there is no three-way merge conflict. However, if PR-A's review leads to changes in the extracted file structure (renamed interfaces, different prop signatures, file reorganization), every B-task will need rebasing. Given that A5 alone creates 8 component files with complex prop interfaces, iteration during PR-A review is almost certain.

**Mitigation**: This is manageable with discipline. Recommend merging PR-A quickly and only starting PR-B implementation after PR-A is merged. The spec implies sequential execution (line 696-703) but does not explicitly forbid parallel development.

**Risk level**: Medium. Not a blocker but deserves explicit callout: "Do not begin PR-B implementation until PR-A is merged."

---

## 4. B1: `projectedScore` Fix -- Backend Analysis

### BLOCKER-4: `assemblyResult.projectedScore` does NOT exist on the return type

The spec says (line 290): "Replace crude projectedScore calc with `assemblyResult.projectedScore` from `computeProjectedScore()` (already computed at assembler.ts:468, just not stored)."

Let me trace the data flow:

1. `computeProjectedScore()` is called at `assembler.ts:468` and its result is stored in the local variable `projectedScore` inside `assembleResults()`.
2. `assembleResults()` returns `{ executiveSummary, rankedRecommendations }` at line 562. It does NOT return `projectedScore`.
3. In `route.ts:901`, `assemblyResult` is the return value of `assembleResults()`. So `assemblyResult.projectedScore` is `undefined`.
4. The pipeline then computes its OWN `projectedScore` at lines 913-921 using a crude heuristic (not `computeProjectedScore`).
5. This crude value is what gets stored in the DB at line 1074.

**Impact**: The spec's claim that `assemblyResult.projectedScore` is "already computed, just not stored" is wrong. It IS computed inside `assembleResults()` but is NOT returned. To use it, you must either:
- (a) Modify `assembleResults()` to include `projectedScore` in its return type, OR
- (b) Export `computeProjectedScore` and call it directly in `route.ts`

Option (b) is cleaner since it avoids changing the assembler's return type, but `computeProjectedScore` takes `(geoScorecard, generatedContent)` -- and `generatedContent` is not readily available at that point in `route.ts` (it was used earlier to create the assembler input).

**Fix**: Modify `assembleResults()` at `assembler.ts:562` to return `{ executiveSummary, rankedRecommendations, projectedScore }`. Then in `route.ts`, replace lines 913-921 with `const projectedScore = assemblyResult.projectedScore`. This is a ~2-line change but must be explicitly called out because the spec implies it is already wired up.

---

## 5. B3: Dashboard Filter -- `searchParams` in Server Component

### WARNING-7: Next.js 15 App Router `searchParams` access pattern

The spec says (line 371): "Read `searchParams.q` in the server component." In Next.js 15 App Router, `searchParams` IS available to page server components as a prop -- but it is a `Promise` that must be awaited:

```ts
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  // ...
}
```

The current `DashboardPage` at `app/dashboard/page.tsx:112` does NOT accept `searchParams` as a prop:
```ts
export default async function DashboardPage() {
```

This is workable -- just add the prop. But the spec does not mention the `Promise` wrapper that Next.js 15 requires for `searchParams` (unlike Next.js 14 where it was a plain object). If the implementer treats it as a sync object, the code will fail at build time.

**Fix**: Spec should show the exact signature: `searchParams: Promise<{ q?: string }>` and the `await` call.

Additionally: The current `DashboardFilter` uses DOM mutation (`document.querySelectorAll`) at `app/dashboard/DashboardFilter.tsx:10`. The spec's rewrite to URL search params changes the filter from instant client-side DOM manipulation to a server round-trip (since `router.replace` with search params in a server-component page triggers a server re-render). This may feel slower to the user.

**Mitigation**: Use `useTransition` (which the spec does include) and keep the DOM row-hiding as a client-side optimistic update while the URL updates in the background. Or: keep filtering fully client-side by moving it into `DashboardTable` (a client component) instead of passing through server searchParams.

---

## 6. Missing from Spec

### INFO-1: `isNewSiteRef` not accounted for

`isNewSiteRef` (line 156) is a `useRef` that stores whether the site had no score at mount time. It is used in the audit status bar at line 1022 to decide between "Running audit" vs "Refreshing audit". This ref is not mentioned in any extraction plan. It should live in the shell since it is used in the audit status bar (which is shell-level JSX per A6).

---

### INFO-2: `citationHistory` prop is accepted but never used

`SitePageClientProps` declares `citationHistory: CitationCheckScore[]` at line 76, and it is destructured at line 105. But grep shows zero usage of `citationHistory` anywhere in the component body. It is a dead prop.

**Fix**: Remove from props in PR-A extraction. Note: this might have been used by a removed component (CitationHistory) that was mocked out in tests.

---

### INFO-3: `COPPER_BG` constant declared but never used in component

`COPPER_BG` is declared at line 25 but never referenced in any JSX. Dead code -- remove during A1 token extraction.

---

### INFO-4: `ALL_STAGES` has 7 entries but UI says `/6`

`ALL_STAGES` at lines 39-47 has 7 entries (discovery through assembling), but `extracting` is aliased to `crawling` at line 505 (`stageLookupStatus`). The audit bar at line 1002 computes `pct = Math.round(((displayIndex + 0.5) / 6) * 100)` -- hardcoded `/6`. This works because `extracting` never appears in the `findIndex` lookup (it's aliased), but the `ALL_STAGES` array still has 7 elements. The comment at line 504 explains this.

The spec does not account for this aliasing logic. It should be preserved in the shell (it is part of the audit status bar, which remains in the shell per A6).

---

### INFO-5: Integration config templates reference `site?.slug` but the spec extracts them to a standalone function

The spec's A4 extracts integration configs to `getIntegrationConfigs(slug: string)`. But the actual code also uses `geoBase`, `pixelTag`, `scriptTag`, `cspNote`, and `robotsBlock` (lines 636-674) which are derived from `slug`/`siteId`. And the `referrerSteps` object (lines 676-767) is platform-specific config that is NOT part of `integrationConfigs` but is interpolated INTO them.

The spec's function signature `getIntegrationConfigs(slug: string)` is insufficient. It needs the full `geoBase` URL construction and must return both `integrationConfigs` and `referrerSteps`, or inline `referrerSteps` into the configs. The current code builds `integrationConfigs` at lines 769-905 by interpolating `geoBase`, `pixelTag`, `scriptTag`, `cspNote`, `referrerSteps[platform]`, and `robotsBlock` -- all of which are derived from `slug`.

This is workable but the spec undersells the complexity. The function should accept `slug` (or `siteId` as fallback) and internally construct all derived strings.

---

## 7. Test Feasibility

### WARNING-8: Component tests require heavy mocking

The existing `SitePageClient.test.tsx` already mocks `next/navigation`, `fetch`, and several child components. The proposed per-component tests (A7) will need the same mocking setup. This is feasible with the current Vitest + `@testing-library/react` setup.

However, the B5 test ("Browser back -> returns to previous hash") requires testing `window.location.hash` changes and `popstate` events. `@testing-library/react` with jsdom does NOT fire real navigation events. The `popstate` event must be manually dispatched, and `window.location.hash` must be manually set. This is doable but fragile.

The B3 test ("render dashboard with 250 domains, type 'stripe' in filter") requires rendering a server component with database access. Server components cannot be rendered with `@testing-library/react` in Vitest. The test would need to either:
- Test only the `DashboardFilter` client component in isolation (verifying it updates the URL), OR
- Test the filtering logic as a pure function, OR
- Use Playwright E2E

The spec says "Integration test" but does not clarify which test framework. Given the Docker Vitest constraint, this test may need to be a Playwright E2E test instead.

---

## Summary

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| BLOCKER-1 | Critical | `handleDownloadPdf` in SiteActions does not exist | Remove or extract inline handler |
| BLOCKER-2 | Critical | `filteredPillars`/`filteredPages`/`pagedRows` not addressed in hook | Explicitly state they are tab-local re-derivations |
| BLOCKER-3 | Medium | PR-B modifies files PR-A creates -- rebase risk | Add rule: "merge PR-A before starting PR-B" |
| BLOCKER-4 | Critical | `assemblyResult.projectedScore` is undefined -- assembler does not return it | Modify `assembleResults()` return type to include `projectedScore` |
| WARNING-1 | Low | `visibleCompetitors`/`hiddenCompetitorCount` missing from SiteDerivedData | Add or document as inline |
| WARNING-2 | Medium | `estAfterFixes` removed in PR-A breaks zero-behavior-change guarantee | Preserve in A2, replace in B1 |
| WARNING-3 | Low | `useSiteActions` dependency wiring for `otherPlatform` state is underspecified | Document controlled-prop pattern |
| WARNING-4 | N/A | `citationScanActive` cross-boundary -- already handled | No action needed |
| WARNING-5 | Medium | `setShowUpgradeModal` missing from OverviewTab props | Add to props or SiteActions |
| WARNING-6 | Medium | `setActiveTab` missing from OverviewTab props | Add to props |
| WARNING-7 | Medium | Next.js 15 `searchParams` is a Promise, not sync object | Show correct signature |
| WARNING-8 | Low | B3 dashboard filter test requires server component rendering | Clarify test approach (Playwright E2E or pure function test) |
| INFO-1 | N/A | `isNewSiteRef` not mentioned in extraction plan | Keep in shell |
| INFO-2 | N/A | `citationHistory` is a dead prop | Remove in PR-A |
| INFO-3 | N/A | `COPPER_BG` unused | Remove in A1 |
| INFO-4 | N/A | `ALL_STAGES` aliasing logic not called out | Preserve in shell |
| INFO-5 | Low | `getIntegrationConfigs(slug)` undersells complexity | Document full derivation chain |

**Blocks release**: YES (BLOCKER-1 and BLOCKER-4 are implementation-blocking; BLOCKER-2 will cause confusion and rework)

**Recommended actions before implementation begins**:
1. Fix the `SiteActions` interface to remove `handleDownloadPdf` or define extraction plan for the inline PDF handler
2. Add explicit note that `filteredPillars`/`filteredPages`/`pagedRows` are tab-local computations
3. Modify the B1 plan to include changing `assembleResults()` return type
4. Preserve `estAfterFixes` in PR-A, replace in PR-B
5. Add `setShowUpgradeModal` and `setActiveTab` (or `handleTabChange`) to OverviewTab props
6. Fix the Next.js 15 `searchParams: Promise` signature for B3
