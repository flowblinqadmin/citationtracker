# TS-087 Adversarial Review -- Round 1

**Reviewer**: Code Reviewer Agent (adversarial)
**Date**: 2026-04-09
**Spec reviewed**: `docs/specs/technical/TS-087-ux-audit-overhaul.md`
**Code verified against**: SitePageClient.tsx (2581 lines), types.ts, assembler.ts, pipeline/stage/route.ts, config.ts, ChatWidget.tsx, DashboardFilter.tsx, DashboardTable.tsx, dashboard/page.tsx

---

## Per-Finding Verdicts

### F-01: "What AI actually said" is buried

**Verdict: PASS -- root cause confirmed, fix is achievable**

The spec correctly identifies:
- `sovSamplesExpanded` defaults to `false` (line 173 of SitePageClient.tsx)
- The section is rendered after the Critical Issues table (line 1653)
- It is a collapsible accordion that requires a click to open

No concerns with the proposed fix (move to position 2, show first 3 samples).

---

### F-02: Score drop with no explanation

**Verdict: PASS -- root cause confirmed, data exists**

The spec claims `ChangeLogEntry.pillarScores` exists but is never rendered. Verified:
- `ChangeLogEntry` type in `types.ts` line 111: `pillarScores: Record<string, number>` -- CONFIRMED
- Pipeline stores pillar scores at `route.ts` line 938: `pillarScores: Object.fromEntries(geoScorecard.pillars.map((p) => [p.pillar, p.score]))` -- CONFIRMED
- History tab rendering (lines 2243-2268): only shows `overallScore` and a delta bar. No pillar breakdown. -- CONFIRMED

The data is there, the rendering is not. Acceptance criteria is achievable.

**Edge case the spec missed**: The delta calculation at line 2245 compares `entry.overallScore - prev.overallScore` where `prev` is `changeLog[i - 1]`. But `changeLog` is not guaranteed to be sorted chronologically. If the backend appends entries (newer last), but the frontend reads them first-to-last, the delta is correct. If entries arrive out of order, deltas will be wrong. The spec should mandate a sort-by-date before rendering.

---

### F-03: "Est. after fixes" = current score

**Verdict: CONCERN -- root cause is partially wrong; two independent computation paths**

The spec says:
> `estAfterFixes` = `liveScore + top3Boost`. `top3Boost` sums parsed `estimatedBoost` from top 3 recs. If `estimatedBoost` fields are empty/unparseable, boost = 0.

Verified at line 554-558:
```ts
const top3Boost = recs.slice(0, 3).reduce((sum, r) => {
  const n = parseInt(String(r.estimatedBoost).replace(/[^0-9-]/g, ""), 10);
  return sum + (isNaN(n) ? 0 : Math.abs(n));
}, 0);
```

**Critical issue**: `estimatedBoost` from the assembler is a human-readable **string** like `"Pages with FAQ content average 4.9 AI citations vs 4.4 without"` (see `getBoostEstimate()` at assembler.ts line 565-581). The `parseInt()` call parses out the first digits it finds -- for `"Up to 40% boost in AI citations"` it extracts `40`, for `"2x more citations with multi-schema stacking"` it extracts `2`, for `"85% of AI Overview citations from last 2 years"` it extracts `85`. These numbers are **not point boosts** -- they're heterogeneous statistics about citation rates, percentages, and years.

So the client-side calculation is fundamentally broken: it's summing citation-rate percentages, multipliers, and calendar years as if they were score-point deltas. The result is either `0` (when the string has no digits -- not actually possible given current data) or a **wildly inaccurate number**.

The spec correctly says "use `site.projectedScore`" as the fix. Verified:
- `projectedScore` field exists in schema (`lib/db/schema.ts` line 238)
- `projectedScore` is computed server-side by `computeProjectedScore()` in `assembler.ts` (line 116-428) -- this is a proper weighted-average recalculation
- Pipeline stores it in `route.ts` line 921 and writes to DB at line 1074

**But there are TWO different `projectedScore` computations**:
1. `assembler.ts:computeProjectedScore()` -- sophisticated per-pillar boost with ceilings and weights (~300 lines of logic)
2. `route.ts` line 913-921 -- a crude `top5 pillars * priority-based flat boost` (critical=+10, high=+5, else=+2)

The pipeline route.ts value **overwrites** the assembler value in the DB. The assembler's `computeProjectedScore` is called at line 468 but its return value is only used in the prompt text (lines 480, 510, 512) -- it is NOT stored in the database. The DB gets the crude version from `route.ts`.

**Recommendation**: The spec should specify WHICH `projectedScore` to use. The assembler's version is far more accurate. The pipeline's version is the one currently stored. This is a backend bug that the spec should acknowledge before the frontend fix can be meaningful.

---

### F-04: Left sidebar actions lack affordance

**Verdict: PASS -- root cause confirmed**

Verified at lines 1168-1298: Buttons are plain `<button>` elements with:
- 10px icon container (32x32px icon box)
- Hover state only changes background color
- No confirmation dialog before credit spend
- No tooltip beyond the HTML `title` attribute (which is invisible on mobile)

The spec's fix (tooltip + confirmation modal + spinner) is achievable.

**Concern**: The "Don't ask again" checkbox in the Risk section could lead to accidental credit spend if the user changes devices or clears localStorage. Consider a session-scoped opt-out instead.

---

### F-05: Overview is information overload

**Verdict: PASS -- accurate assessment**

The Overview tab (lines 1331-1823) renders in this order:
1. Citation scan loading banner
2. 5 KPI cards
3. Download fix report bar
4. Competitor bar
5. Score History timeline
6. 2-col grid: Citation Visibility + SOV | Critical Issues
7. "What AI actually said" (collapsed)
8. 3-col grid: Geographic + Category + Buyer Intent/Recs

That is 8 distinct sections with no grouping headers. The spec's 3-section grouping (Health, Evidence, Diagnosis) is a reasonable reorganization.

---

### F-06: Citation Rate denominator unexplained

**Verdict: PASS -- root cause confirmed**

Line 1376: `{p.name} {p.mentionCount}/{p.totalQueries}` -- no label, no tooltip. Fix is straightforward.

---

### F-07: Citation Visibility by Theme -- all zeros

**Verdict: CONCERN -- the "sort by potential impact" fix may not be possible**

Line 1540: `Object.entries(pillarVisibility).sort((a, b) => a[1] - b[1])` -- currently sorts ascending (lowest first).

The spec says: "Sort by potential impact." But the `pillarVisibility` data is just `Record<string, number>` -- visibility percentages per theme. There is no "potential impact" score in the data. The spec would need to define what "potential impact" means -- is it the GEO pillar weight from `GEO_PILLAR_WEIGHTS`? Is it the inverse of current score? The spec needs clarification.

The "zero values get no treatment" observation is accurate -- there is no special rendering for 0% entries.

---

### F-08: Competitor mapping "6/6 slots full" -- no edit flow

**Verdict: PASS -- root cause confirmed**

Line 1148: slot limit hard-coded as `Math.max(0, 6 - effectiveCompetitors.length)` at line 147.
Line 1491: Shows "6/6 -- slots full" when `slotsRemaining === 0`.

The remove button ("x") exists per-competitor at line 1447. But when slots are full, the add input is hidden (line 1456 checks `slotsRemaining > 0`). The spec's proposed fix is achievable.

**Note**: The 6-slot limit is not sourced from config -- it is hard-coded in the component at line 147. The subscription tiers in `config.ts` define `maxCompetitors` per tier (3/5/10/20), but the component ignores this and always uses 6. This is a deeper bug that the spec does not address. Fix F-08 should source the limit from the tier config, not just make the hard-coded 6 more visible.

---

### F-09: Pages tab -- no severity sort, tiny vuln bars

**Verdict: CONCERN -- spec's root cause description is incomplete**

The spec says pages are sorted by `healthOrder` then vuln count, and bars are "nearly invisible." Verified at line 542-544:
```ts
const sortedPages = [...allPages].sort((a, b) => {
  const hd = healthOrder(a.overallPageHealth) - healthOrder(b.overallPageHealth);
  return hd !== 0 ? hd : critScore(b) - critScore(a);
});
```

This IS sorted worst-first (poor=0, needs-work=1, good=2), then by critical+high vuln count descending. The spec says "sort worst-first by default" as the fix, but that is already the behavior. The actual issue is that the vuln severity bars at line 2146-2150 are only 48px wide (`width: 48`) and 4px tall (`height: 4`). The fix should focus on bar size, not sort order.

---

### F-10: Recommendations header count missing CRIT

**Verdict: PASS -- root cause confirmed**

Lines 1928-1937:
```ts
const hiCount = recs.filter(r => ["HIGH", "high"].includes(r.priority)).length;
const medCount = recs.filter(r => ["MED", "med"].includes(r.priority)).length;
const lowCount = recs.filter(r => ["LOW", "low"].includes(r.priority)).length;
```

No `critical` count. No `medium` handling (only `MED`/`med`). This means `"critical"` and `"medium"` priority values are uncounted in the header. The spec's fix is correct.

**Additional issue**: The `sortOrder` map at line 530 maps `critical: 0` and `HIGH: 0` to the same sort position. This means critical items are not guaranteed to sort before HIGH items -- they have the same sort key and rely on the browser's sort stability. This is fragile.

---

### F-11 through F-17: Medium/Low findings

**Verdict: PASS (all)**

These are straightforward UI improvements with verifiable root causes:
- F-11: Scorecard expand affordance (line 1883 -- just a "down/up" arrow)
- F-12: Domain verification (line 2359-2411 -- no status badge, no explanation of what it enables)
- F-13: Empty states (line 335-349 in dashboard -- basic text, no illustration)
- F-14: Credits display (line 301-317 in dashboard -- bare number, no context)
- F-15: 0% SOV competitors hidden -- PARTIALLY WRONG. The code at line 1575 renders `visibleCompetitors` which is `competitorData`, filtering at line 571 shows all. Competitors with 0% SOV ARE rendered if they exist in `competitorData`. The issue is that competitors NOT in `competitorData` (unmapped ones) are not shown. This is a data availability issue, not a rendering issue.
- F-16: No "What should I do first?" CTA -- confirmed, no such element exists
- F-17: Score History chart minimal -- confirmed at lines 1496-1532

---

### F-18: Tab navigation doesn't update URL

**Verdict: PASS -- root cause confirmed**

Line 118: `const [activeTab, setActiveTab] = useState<TabId>("overview");`
Line 1088: `onClick={() => setActiveTab(tab.id)}` -- no URL hash update.

Fix is straightforward.

**Edge case**: Hash changes should not trigger a full page reload or poll restart. The `useEffect` that depends on `poll` (line 246) should not be affected by hash changes, but verify during implementation.

---

### F-19: Mobile sidebar overlaps content

**Verdict: PASS -- but already partially addressed**

Lines 1148-1165: The action rail uses `position: fixed` with different positioning for mobile vs desktop:
- Mobile: `bottom: 0, left: 0, right: 0` -- a bottom bar
- Desktop: `top: "50%", left: 0` -- a left sidebar

The main content at line 1302 has `padding: isMobile ? "16px 12px 80px 12px" : "16px 24px 40px 92px"` -- the 80px bottom padding on mobile accounts for the bottom bar. This is already partially handled. The spec should verify whether the overlap is actually occurring or if this is a stale finding.

---

### F-20: Page type categorization inconsistent

**Verdict: PASS -- minor UI cleanup**

Line 2139: `{pageTypeLabel}` is rendered as-is from the data with `replace(/_/g, " ")`. The "FTF -" prefix issue would need to be verified against actual data.

---

### F-21: No loading states on action buttons

**Verdict: PASS -- partially addressed**

- Refresh Score: `retrying` state disables button (line 1170) but no skeleton in target area
- Citation scan: `citationScanActive` shows a banner (line 1334-1339) but no progress text from SSE events -- the SSE buffer is read but events are not surfaced to UI (lines 346-351 read the stream but discard all events)
- Competitor scan: `competitorScanActive` shows "Mapping competitors..." (line 1438)

The spec is correct that SSE events exist but are not surfaced as progress indicators.

---

### F-22: Chat widget overlaps scorecard last row

**Verdict: PASS**

ChatWidget at line 233-234: `position: fixed, bottom: 24, right: 24, width: 56, height: 56`. No bottom padding adjustment on the scorecard tab. The fix (add bottom margin to scorecard container) is trivial.

---

### F-23: Font size inconsistency

**Verdict: PASS**

Confirmed across the file: font sizes range from 7px (line 1182 mobile labels), 8px (credit badges), 9px (rail labels), 10px (headers), 11px (subtext), 12px (body-small), 13px (body), 14px (body-large), 15-17px (headings), 20px (history scores), 28px (dashboard KPI numbers), 32px (hero metrics). There is no typographic scale -- each size is ad-hoc.

---

### F-24: Dashboard "Filter domains..." input is dead

**Verdict: PASS -- root cause confirmed**

`DashboardFilter.tsx` lines 8-14:
```ts
function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
  const query = e.target.value.toLowerCase();
  document.querySelectorAll<HTMLTableRowElement>("[data-domain]").forEach((row) => {
    row.style.display = domain.includes(query) ? "" : "none";
  });
}
```

This uses direct DOM manipulation with `querySelectorAll("[data-domain]")`. But `DashboardTable.tsx` does not render `data-domain` attributes on its rows -- it delegates to `DomainTableRow` component. After a sort operation (which re-renders the table via React state), the DOM references may be stale. The spec's assessment is correct.

**Missing detail**: The spec should also note that the filter does not debounce, which matters for 233+ domains.

---

### F-25: Mobile chatbot icon covers other icons

**Verdict: CONCERN -- spec's root cause needs clarification**

ChatWidget button: `position: fixed, bottom: 24, right: 24, zIndex: 9998`.
Action rail on mobile: `position: fixed, bottom: 0, left: 0, right: 0, zIndex: 80`.

The chatbot button (z-index 9998) renders ABOVE the action rail (z-index 80). On mobile, the action rail is a full-width bottom bar. The chatbot's `bottom: 24` overlaps with the action rail's top area.

The spec says "overlaps sidebar action buttons on mobile" -- this is accurate. But the fix "increase bottom offset" would push the chatbot button off-screen or into an awkward position. A better fix would be to hide the chatbot toggle when on the results page on mobile, or anchor it above the action rail.

---

### F-26: No delete/archive, no credit log, no scan cancel

**Verdict: CONCERN -- this is three features, not one finding**

This finding bundles three unrelated features:
1. Delete/archive sites -- requires new API route, soft-delete in DB, dashboard UI
2. Credit transaction log -- requires new page, query `creditTransactions` table
3. Scan cancellation -- requires new API route + pipeline interrupt logic (QStash job cannot be cancelled mid-flight)

The scan cancellation is the most complex: the pipeline uses QStash for stage orchestration. Once a stage is enqueued, QStash will deliver it. "Cancel" would need to set a DB flag that the stage handler checks on entry. This is not trivial and is under-specified.

**Recommendation**: Split into three separate findings or move to a separate spec.

---

### F-27: Hero metric cards not clickable

**Verdict: PASS**

Lines 1345-1400: All five KPI cards are plain `<div>` elements with no `onClick`, no `cursor: pointer`, no hover state. Fix is straightforward.

---

### F-28: Cards 1 (AI Visibility) and 4 (Competitive SOV) show identical data

**Verdict: FAIL -- the spec's root cause is WRONG**

The spec claims: "Both render `lc?.overallVisibility`"

Verified:
- Card 1 (AI Visibility) at line 1347-1348: `lc?.overallVisibility` -- CONFIRMED
- Card 4 (Competitive SOV) at line 1386-1387: `ourSOV` -- which is defined at line 612 as `lc?.overallVisibility ?? null` -- CONFIRMED, same value

So the spec is correct that they show the same number. But the spec's proposed fix says:

> Card 4 (SOV) should use actual share-of-voice data: brand's citation share relative to competitors.

The problem is: `overallVisibility` in the `citation_check_scores` table IS the share-of-voice metric. It represents what percentage of AI responses mention this brand. There is no separate "SOV relative to competitors" field in the schema. `competitorData` has per-competitor `shareOfVoice` values, but there is no pre-computed "brand's share relative to total mentions across all competitors."

The data structure does not support the spec's proposed fix without a backend computation change:
- Option A: Compute `brand_mentions / (brand_mentions + sum(competitor_mentions))` at query time
- Option B: Store a new `relativeShareOfVoice` field during citation check

The spec marks this as a dependency ("requires `lastCitationCheck` to have separate SOV field vs visibility") but understates the effort -- this requires a new computation in the citation check service, not just a rendering change.

---

### F-29: Credit cost labels hard-coded in JSX

**Verdict: PASS -- root cause confirmed**

Line 1183: `"10cr"` -- hard-coded string
Line 1215: `"5cr"` -- hard-coded string
Line 1235: `"5cr"` -- hard-coded string
Line 1257: `"5cr"` -- hard-coded string
Line 1297: `"5cr"` -- hard-coded string

`ACTION_CREDITS` constants exist in `config.ts` (lines 62-73) and are NOT imported or used in `SitePageClient.tsx`. Fix is trivial: import and interpolate.

---

## Monolith Extraction Plan Review

### Component Boundaries

The proposed extraction into ~10 components is reasonable but has several state dependency issues:

**Issue 1: The `site` state is mutated by multiple handlers that span tabs**

`setSite()` is called by:
- `poll()` (line 231) -- updates entire site
- `handleRefreshScore()` (line 319) -- sets `pipelineStatus: "queued"`
- `handleMapCompetitors()` (line 386) -- decrements `credits`

These handlers would need to live in the shell, with callbacks passed to child components. The spec's rule "state that crosses tabs stays in SitePageClient.tsx shell" handles this, but the shell would need ~15 callback props for the various action handlers, making the ~300 line estimate for the shell unrealistic.

**Issue 2: Derived data computations are extensive**

Lines 491-631 compute ~30 derived values from `site` and `lastCitationCheck`:
- `scorecard`, `pillars`, `pageCount`, `criticalCount`, `liveScore`
- `tierCounts`, `filteredPillars`
- `recs` (sorted, normalized)
- `allPages`, `sortedPages`, `filteredPages`, `pagedRows`
- `estAfterFixes`, `top3Boost`
- `providerResults`, `competitorData`, `providerAggregates`
- `totalMentions`, `citationRate`, `ourSOV`, `topCompetitor`
- `pillarVisibility`, `geoVisibility`, `categoryVisibility`, `tierVisibility`
- `changeLog`
- `pillarNameMap`, `SHORT_NAMES`

These derivations use data from BOTH `site` AND `lastCitationCheck`, and some results (e.g., `recs`, `criticalCount`) are used across multiple tabs. They cannot simply be moved into individual tab components without either:
- Duplicating computation across tabs
- Creating a shared `useDerivedData()` hook
- Keeping all derivations in the shell (which balloons the shell size)

**Recommendation**: The spec should propose a `useSiteData(site, lastCitationCheck)` custom hook that encapsulates all derived computations and returns a typed object. Each tab component receives the slice it needs from this hook's output.

**Issue 3: Integration configs are ~200 lines of template literals**

Lines 634-905 define integration configs (Vercel, Netlify, Cloudflare, nginx, WordPress, Apache) as template literals. These are only used in the Setup tab. They should be extracted to a separate `integration-configs.ts` file, not kept in the component tree. The spec's plan does not account for this.

**Issue 4: The ~300-line shell estimate is wrong**

The shell would need:
- Header + domain switcher (lines 953-1145) = ~190 lines
- Audit status bar (lines 999-1074) = ~75 lines
- Tab bar (lines 1076-1101) = ~25 lines
- Action rail (lines 1147-1299) = ~150 lines
- Main content wrapper + tab routing = ~20 lines
- State declarations (~30 useState calls) = ~30 lines
- Action handler functions (refresh, citations, competitors, download, add/remove competitor, email auth, test connection) = ~250 lines
- Token loading, polling, CSS var effects = ~50 lines

**Total: ~790 lines minimum** -- over 2.5x the spec's estimate. The shell will not be 300 lines unless action handlers are also extracted (e.g., into a `useSiteActions()` hook).

---

## Hidden Dependencies

The spec lists 5 dependencies. These are missing:

1. **`DomainTableRow` component** (F-24): The dashboard filter fix requires understanding how `DomainTableRow` renders its rows and whether it sets `data-domain` attributes. Not mentioned in the spec.

2. **`useMediaQuery` hook** (`lib/hooks/useMediaQuery`): Used throughout for mobile detection. The monolith extraction needs to decide whether each child component imports this independently or receives `isMobile` as a prop. Not addressed.

3. **`CitationCheckScore` type** (multiple findings): Many findings reference `lastCitationCheck` data. The type is `CitationCheckScore` from schema. The spec does not document the schema shape, which is essential for verifying F-28's feasibility.

4. **SSE event format** (F-21): The citation scan handler reads SSE events but discards them. To surface progress, the spec needs to document the SSE event schema from `/api/sites/[id]/citation-check`.

5. **`ACTION_CREDITS` mapping to button labels** (F-29): The current buttons show "10cr" for refresh, "5cr" for citations/competitors/download/PDF. But `ACTION_CREDITS.geoAudit` is `10` (per 100 pages) and the refresh is a full re-audit. The credit label needs to account for the site's page count, not just the base rate. This is not a simple find-and-replace with config constants.

6. **Subscription tier gating** (F-08): The component hard-codes 6 competitor slots but `SUBSCRIPTION_TIERS` defines `maxCompetitors` as 3/5/10/20 per tier. The spec should address which value governs.

---

## Findings That May Be WONTFIX

### F-15: Show 0% competitors

If a competitor has 0% SOV, it means they were not mentioned in ANY AI response. Competitors must first be in `competitorData` to be shown -- if they have 0% SOV but are in the data, they ARE already shown (the code renders all entries in `visibleCompetitors`). If they are NOT in `competitorData`, they were never checked and there is no data to show. This finding may be based on a misunderstanding of the data.

### F-28: Cards show identical data

As analyzed above, the underlying data does not have a distinct "relative SOV" metric. Without a backend change to compute this during citation checks, the frontend fix is impossible. This should be re-classified as a backend + frontend change, not just a frontend finding.

---

## Conflicts Between Findings

1. **F-05 (reorganize Overview) conflicts with F-01 (move "What AI said" to position 2)**: F-05 proposes a 3-section grouping (Health, Evidence, Diagnosis). F-01 says move "What AI said" to position 2. In the 3-section model, "What AI said" belongs in "Evidence" -- but "position 2" could mean the second section (Evidence) or the second element within the first section. The specs need to be reconciled with a single layout wireframe.

2. **F-27 (hero cards clickable) + F-05 (reorganize Overview)**: If hero cards become navigational (clicking AI Visibility goes to Citations tab), this creates a second navigation paradigm alongside the tab bar. Users may be confused about whether tabs or cards are the primary navigation.

3. **F-18 (URL hash sync) + F-27 (hero card clicks)**: If hero cards navigate to tabs AND tabs sync to URL hash, clicking a hero card should also update the URL hash. This interaction is not specified.

---

## Summary: Blocking Issues

These MUST be resolved before proceeding to engineering spec:

| # | Issue | Impact |
|---|-------|--------|
| B-1 | F-03: Two competing `projectedScore` computations -- the DB stores the crude one from `route.ts`, not the accurate one from `assembler.ts` | Frontend will display inaccurate projections even after the fix |
| B-2 | F-28: No "relative SOV" field exists in the data. Proposed fix requires backend change. | Frontend-only fix is impossible |
| B-3 | Shell size estimate (300 lines) is 2.5x too low. No plan for extracting action handlers or derived data. | Extraction plan will fail or produce a shell that is still 800+ lines |
| B-4 | F-26 bundles three unrelated features (delete, credit log, scan cancel) with no individual scope estimates | Unbounded scope risk |
| B-5 | F-08: Hard-coded 6-slot limit ignores `SUBSCRIPTION_TIERS.maxCompetitors` per tier | Fix will still be wrong if it just makes the 6 more visible |
| B-6 | F-29: Credit costs are not just config lookups -- `geoAudit` cost depends on page count | Simple find-and-replace with `ACTION_CREDITS` will show wrong costs for audits |
| B-7 | F-01 and F-05 propose conflicting layout changes without a unified wireframe | Implementation will oscillate between two designs |

---

## Recommendations

1. **Create a single layout wireframe** that reconciles F-01, F-05, F-16, and F-27 into one coherent Overview design.
2. **Fix the `projectedScore` pipeline bug** (B-1) as a prerequisite before F-03 frontend work.
3. **Split F-26** into three separate findings with independent scope and priority.
4. **Add a `useSiteData()` hook** to the extraction plan for derived data computations.
5. **Add a `useSiteActions()` hook** for action handlers to keep the shell under 400 lines.
6. **Define "potential impact"** for F-07's sort -- use `GEO_PILLAR_WEIGHTS` as the sort key.
7. **Reclassify F-28** as requiring a backend change (compute relative SOV during citation check).
8. **Verify F-15** against real data -- 0% competitors may already be rendered if they exist in `competitorData`.
9. **Source competitor slot limits from `SUBSCRIPTION_TIERS`** instead of hard-coding 6.
10. **Add page-count-aware credit labels** for the audit refresh action (F-29).
