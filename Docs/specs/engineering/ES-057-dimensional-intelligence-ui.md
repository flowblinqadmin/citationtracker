# ES-057: Dimensional Intelligence UI

**Source:** TS-057-dimensional-intelligence-ui.md
**Author:** SpecMaster (Agent 2)
**Date:** 2026-03-24
**Branch:** `dev-an-geo`
**Depends on:** ES-053 (trees), ES-054 (dimensional aggregation), ES-056 (competitor intelligence)
**Scope:** New frontend component + data flow fix for SSE complete event

---

## a) Overview

### What this covers
Frontend UI component to surface Tier 2-4 dimensional intelligence data — geographic visibility, category visibility, buyer intent tiers, per-location/category competitors, dominance insights, real user questions, and visibility gap analysis.

### Current implementation state
- **Backend**: Complete. All Tier 2-4 data is computed and persisted to `citation_check_scores` table (ES-053/054/055/056).
- **Frontend**: Zero UI for Tier 2-4 data. `CitationAnalytics` renders only pillar visibility, radar chart, and global competitor SOV.
- **Data flow gap**: The SSE `complete` event (`app/api/sites/[id]/citation-check/route.ts:265-286`) does NOT include Tier 2-4 fields — only the original scores object. Data is saved to DB but not streamed to the client. The preloaded path (`lastCheck: CitationCheckScore`) works because it reads directly from DB. **The live scan path is broken for dimensional data.**

### Files involved
| File | Action |
|------|--------|
| `app/components/dimensional-intelligence.tsx` | **CREATE** — new component (all 6 sections) |
| `app/components/citation-monitor.tsx` | **MODIFY** — import + render new component, fix SSE data flow |
| `app/api/sites/[id]/citation-check/route.ts` | **MODIFY** — add Tier 2-4 fields to SSE `complete` event |
| `lib/types/citation.ts` | **MODIFY** — add Tier 2-4 fields to `CitationCheckResult.scores` |

---

## b) Implementation Requirements

### B1. Data Flow Fix — SSE Complete Event

**Problem:** `app/api/sites/[id]/citation-check/route.ts` lines 265-286 send the `complete` event WITHOUT dimensional data. The dimensional fields are computed (lines 199-211) and persisted to DB (lines 230-260) but not included in the SSE payload.

**File:** `app/api/sites/[id]/citation-check/route.ts`

**Change:** Add dimensional fields to the SSE `complete` event payload (line 281, after `pillarQA`):

```typescript
// Inside send({ type: "complete", data: { ... } }) at line 265:
send({
  type: "complete",
  data: {
    checkId,
    scores: {
      // ... existing fields (lines 270-280) ...
      pillarQA:             result.pillarQA,
      // ── NEW: Tier 2-4 dimensional data ──
      geoVisibility,
      categoryVisibility,
      tierVisibility,
      avgImpressionShare,
      visibilityGapAnalysis,
      locationCompetitors,
      categoryCompetitors,
      dominanceMap: { ...dominanceMap, insights: dominanceInsights },
      realPromptDiscovery: realPromptDiscovery.length > 0 ? realPromptDiscovery : null,
    },
    providerResults: result.providerResults,
    promptsUsed:     prompts.map(p => p.prompt),
    creditsUsed:     CITATION_CHECK_COST,
  },
});
```

All variables (`geoVisibility`, `categoryVisibility`, etc.) are already in scope at this point — they're computed earlier in the same function.

### B2. Type Update — CitationCheckResult

**File:** `lib/types/citation.ts`

Add Tier 2-4 fields to `CitationCheckResult.scores`:

```typescript
export interface CitationCheckResult {
  checkId:         string;
  scores: {
    // ... existing fields ...
    pillarQA:             Record<string, PillarQA>;
    // ── NEW: Tier 2-4 dimensional data ──
    geoVisibility?:        GeoVisibility[];
    categoryVisibility?:   CategoryVisibility[];
    tierVisibility?:       TierVisibility[];
    avgImpressionShare?:   number | null;
    visibilityGapAnalysis?: VisibilityGapEntry[];
    locationCompetitors?:  LocationCompetitor[];
    categoryCompetitors?:  CategoryCompetitor[];
    dominanceMap?:         DominanceMap | null;
    realPromptDiscovery?:  RealPromptDiscovery[] | null;
  };
  providerResults: ProviderResult[];
  promptsUsed:     string[];
  creditsUsed:     number;
}
```

All fields are optional (`?`) for backward compatibility — existing checks in the SSE stream before this change won't have them.

### B3. Frontend Data Flow Fix — citation-monitor.tsx

**File:** `app/components/citation-monitor.tsx`

**Change 1 (lines 556-564):** In the SSE `complete` handler, read Tier 2-4 fields from `data.scores` instead of hardcoding empty:

```typescript
geoVisibility:        (data.scores as any).geoVisibility ?? [],
categoryVisibility:   (data.scores as any).categoryVisibility ?? [],
tierVisibility:       (data.scores as any).tierVisibility ?? [],
avgImpressionShare:   (data.scores as any).avgImpressionShare ?? null,
visibilityGapAnalysis: (data.scores as any).visibilityGapAnalysis ?? [],
locationCompetitors:  (data.scores as any).locationCompetitors ?? [],
categoryCompetitors:  (data.scores as any).categoryCompetitors ?? [],
dominanceMap:         (data.scores as any).dominanceMap ?? null,
realPromptDiscovery:  (data.scores as any).realPromptDiscovery ?? null,
```

Note: `data` is typed as `CitationCheckResult & { type: string }` (line 521). After B2 updates the type, the `as any` casts can be removed. However, since `data` comes from SSE JSON parse (untyped at runtime), the `?? []` fallbacks are essential.

**Change 2 (around line 968):** Import and render `DimensionalIntelligence` after `CitationAnalytics`:

```typescript
import { DimensionalIntelligence } from "@/app/components/dimensional-intelligence";

// After <CitationAnalytics .../> (line 968), before Full Research toggle (line 972):
{analyticsResult && (
  <DimensionalIntelligence result={analyticsResult} domain={domain} />
)}
```

### B4. New Component — DimensionalIntelligence

**File:** `app/components/dimensional-intelligence.tsx` (CREATE)

**Props:**
```typescript
interface DimensionalIntelligenceProps {
  result: CitationCheckResult | CitationCheckScore | null;
  domain: string;
}
```

Same pattern as `CitationAnalytics` — accepts both `CitationCheckResult` (live scan) and `CitationCheckScore` (preloaded).

**Data extraction:** Use a getter function similar to `getScores()` in citation-analytics.tsx. For `CitationCheckResult`, fields are inside `result.scores`. For `CitationCheckScore`, fields are flat on the object.

```typescript
function getDimensionalData(r: CitationCheckResult | CitationCheckScore) {
  if ("scores" in r && typeof r.scores === "object" && r.scores !== null) {
    // CitationCheckResult (live scan path)
    const s = r.scores as Record<string, unknown>;
    return {
      geoVisibility:        (s.geoVisibility ?? []) as GeoVisibility[],
      categoryVisibility:   (s.categoryVisibility ?? []) as CategoryVisibility[],
      tierVisibility:       (s.tierVisibility ?? []) as TierVisibility[],
      visibilityGapAnalysis: (s.visibilityGapAnalysis ?? []) as VisibilityGapEntry[],
      locationCompetitors:  (s.locationCompetitors ?? []) as LocationCompetitor[],
      categoryCompetitors:  (s.categoryCompetitors ?? []) as CategoryCompetitor[],
      dominanceMap:         (s.dominanceMap ?? null) as DominanceMap | null,
      realPromptDiscovery:  (s.realPromptDiscovery ?? null) as RealPromptDiscovery[] | null,
    };
  }
  // CitationCheckScore (preloaded path — fields are flat)
  return {
    geoVisibility:        r.geoVisibility ?? [],
    categoryVisibility:   r.categoryVisibility ?? [],
    tierVisibility:       r.tierVisibility ?? [],
    visibilityGapAnalysis: r.visibilityGapAnalysis ?? [],
    locationCompetitors:  r.locationCompetitors ?? [],
    categoryCompetitors:  r.categoryCompetitors ?? [],
    dominanceMap:         r.dominanceMap ?? null,
    realPromptDiscovery:  r.realPromptDiscovery ?? null,
  };
}
```

**Section rendering:** The component renders 6 sections. Each section is gated on its data being non-empty. If all sections are empty, render nothing (return `null`).

#### Section 1: Buyer Intent Breakdown

- **Data:** `tierVisibility: TierVisibility[]`
- **Gate:** `tierVisibility.length > 0`
- **Layout:** 3 horizontal progress bars (buy/solve/learn)
- **Bar width:** `visibility` as percentage
- **Color logic:** `visibility >= 40` → GREEN (`#16a34a`), `15-39` → AMBER (`#d97706`), `<15` → RED (`#dc2626`)
- **Labels:** "Buy" / "Solve" / "Learn" (12px, 500 weight)
- **Values:** `{visibility}%` right-aligned (14px, 700 weight, colored)
- **Sub-text:** `{mentionCount}/{promptCount} prompts` (11px, TEXT_3)

#### Section 2: Geographic Performance

- **Data:** `geoVisibility: GeoVisibility[]`, `locationCompetitors: LocationCompetitor[]`
- **Gate:** `geoVisibility.length > 0`
- **Layout:** Table with columns: Location | Prompts | Mentions | Visibility
- **Sort:** ascending by `visibility` (worst first)
- **Progress bar** in visibility column (same color logic as Section 1)
- **Expandable row:** If `locationCompetitors` has entry matching `geoId`, show expandable panel (collapsed by default) with top 3 competitors: `domain` | `shareOfVoice%` | `rankedAboveBrand%`
- **Container:** `border: 1px solid BORDER`, `borderRadius: 10`, `background: #fff`
- **Mobile:** Stack as cards (< 640px)

#### Section 3: Category/Service Performance

- **Data:** `categoryVisibility: CategoryVisibility[]`, `categoryCompetitors: CategoryCompetitor[]`
- **Gate:** `categoryVisibility.length > 0`
- **Layout:** Identical to Section 2 but keyed on `categoryId`/`categoryName`
- **Expandable row:** If `categoryCompetitors` has matching `categoryId`, show top 3 competitors

#### Section 4: Dominance Insights

- **Data:** `dominanceMap: DominanceMap | null`
- **Gate:** `dominanceMap !== null && (dominanceMap.insights?.length > 0 || dominanceMap.entries.length > 0)`
- **If insights exist:** Render each insight string as a callout card. Color-code:
  - Insight text contains "dominates" → RED background (`RED + "08"`, border `RED + "25"`)
  - Insight text contains "competitive" → AMBER background
  - Insight text contains "lead" → GREEN background
  - Default → neutral (BORDER background)
- **If no insights but entries exist:** Compact table: Location | Category | Leader | Leader SOV% | Your SOV% | Gap
  - Sort by `gap` descending (biggest gap first)
  - Cap at 8 entries
  - Gap column: colored text (RED if gap > 30, AMBER if 10-30, GREEN if < 10)

#### Section 5: Real User Questions

- **Data:** `realPromptDiscovery: RealPromptDiscovery[] | null`
- **Gate:** `realPromptDiscovery !== null && realPromptDiscovery.length > 0`
- **Layout:** Collapsed by default with toggle: "Show {N} real questions ▼"
- **When expanded:** List of question cards, grouped by source
- **Source badge styling:**
  - `"paa"` → blue badge (`#2563eb` bg `#2563eb15`, text `#2563eb`)
  - `"reddit"` → orange badge (`#ea580c` bg `#ea580c15`, text `#ea580c`)
  - `"quora"` → red badge (`#dc2626` bg `#dc262615`, text `#dc2626`)
- **Each card:** Source badge + `query` text (14px, TEXT) + context snippet (11px, TEXT_2, truncated at 150 chars)
- **Container:** same card style as pillar Q&A samples in citation-analytics.tsx

#### Section 6: Visibility Gap Analysis

- **Data:** `visibilityGapAnalysis: VisibilityGapEntry[]`
- **Gate:** `visibilityGapAnalysis.length > 0`
- **Layout:** Table/card list
- **Columns:** Dimension badge | Area | Visibility % | Gap | Recommendation
- **Dimension badge:** `"geo"` → blue, `"category"` → purple (`#7c3aed`), `"tier"` → amber
- **Sort:** already sorted by visibility ascending (from backend)
- **Cap:** 10 entries (already capped by backend, but enforce client-side too with `.slice(0, 10)`)
- **Recommendation column:** 12px, TEXT_2, max 2 lines
- **Visibility column:** colored number + thin progress bar

### B5. Design Tokens & Typography

Reuse existing tokens from citation-analytics.tsx:

```typescript
const TEXT    = "#1c1917";
const TEXT_2  = "#78716c";
const TEXT_3  = "#a8a29e";
const BORDER  = "rgba(0,0,0,0.07)";
const GREEN   = "#16a34a";
const AMBER   = "#d97706";
const RED     = "#dc2626";

const SECTION_HEADING: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: TEXT_3,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  margin: "0 0 12px",
};
```

Additional colors for source/dimension badges:
- Blue: `#2563eb`
- Purple: `#7c3aed`

### B6. Responsive Breakpoints

```css
/* Mobile (< 640px): stack everything vertically */
@media (max-width: 640px) {
  .di-table { display: block; }              /* tables become card stacks */
  .di-table-row { flex-direction: column; }
  .di-competitor-panel { padding-left: 12px; } /* reduce indent */
}

/* Tablet (640-1024px): 2-column grids for tier bars and gap entries */
@media (min-width: 640px) and (max-width: 1024px) {
  .di-gap-grid { grid-template-columns: 1fr 1fr; }
}

/* Desktop (1024px+): full-width tables, default layout */
```

Use inline styles with CSS class overrides in a `<style>` block (same pattern as citation-analytics.tsx lines 387-397).

### B7. Error Handling

- All data access uses `?? []` / `?? null` fallbacks — no crashes on missing data
- No new API calls — if data is missing, sections simply don't render
- No loading states — data is available synchronously from props

---

## c) Unit Test Plan

**File:** `__tests__/components/dimensional-intelligence.test.tsx`

**Framework:** Vitest + React Testing Library

**Minimum coverage:** 90% line coverage for `dimensional-intelligence.tsx`

### Test cases

| # | Test | Input | Expected |
|---|------|-------|----------|
| UT1 | Renders nothing when all data empty | `result` with all Tier 2-4 fields as `[]`/`null` | Component returns `null` |
| UT2 | Tier visibility — 3 bars render | `tierVisibility: [{ tier: "buy", promptCount: 10, mentionCount: 5, visibility: 50 }, { tier: "solve", promptCount: 10, mentionCount: 2, visibility: 20 }, { tier: "learn", promptCount: 10, mentionCount: 0, visibility: 0 }]` | 3 progress bars; buy=green, solve=amber, learn=red |
| UT3 | Tier visibility — color thresholds | Visibility values: 40 (green), 39 (amber), 15 (amber), 14 (red), 0 (red) | Correct color per threshold |
| UT4 | Geo table — sorted ascending | 3 geos: visibility 80, 20, 5 | Rendered order: 5, 20, 80 |
| UT5 | Geo table — competitor expand | geoVisibility + locationCompetitors with matching geoId | Chevron visible; click expands competitor panel showing top 3 |
| UT6 | Geo table — no competitors | geoVisibility with no matching locationCompetitors | No chevron, no expand |
| UT7 | Category table — sorted ascending | Same pattern as UT4 but for categories | Correct sort order |
| UT8 | Category table — competitor expand | categoryVisibility + categoryCompetitors with matching categoryId | Same expand behavior as UT5 |
| UT9 | Dominance insights — color-coded | insights: ["Competitor dominates in X", "You lead in Y", "Competitive in Z"] | red/green/amber backgrounds |
| UT10 | Dominance entries fallback | dominanceMap with entries but no insights | Table renders with gap column |
| UT11 | Dominance — null map | dominanceMap: null | Section not rendered |
| UT12 | Real questions — collapsed default | realPromptDiscovery: 5 items | Toggle text "Show 5 real questions"; items not visible |
| UT13 | Real questions — expand toggle | Click toggle | All 5 items visible, grouped by source |
| UT14 | Real questions — source badges | Sources: paa, reddit, quora | Correct badge colors per source |
| UT15 | Real questions — context truncation | context: 200-char string | Truncated to 150 chars with "…" |
| UT16 | Gap analysis — renders | 3 VisibilityGapEntry items | Table with 3 rows, dimension badges colored |
| UT17 | Gap analysis — cap at 10 | 15 entries | Only 10 rendered |
| UT18 | Gap analysis — dimension badges | dimension: "geo" / "category" / "tier" | Blue / purple / amber badges |
| UT19 | Accepts CitationCheckResult | Wrap data in `{ scores: { ... } }` | Same render as flat CitationCheckScore |
| UT20 | Accepts CitationCheckScore | Flat fields on result object | Correct render |
| UT21 | Partial data — only tier | tierVisibility populated, all others empty | Only Section 1 renders |
| UT22 | Partial data — only geo | geoVisibility populated, all others empty | Only Section 2 renders |
| UT23 | Null result | result = null | Returns null |

### Mock requirements
- No mocks needed — component is pure render (stateless except expand/collapse toggles)
- Use `@testing-library/react` `render()` and `screen.getByText()` / `queryByText()`

---

## d) Integration Test Plan

**File:** `__tests__/integration/dimensional-intelligence-flow.test.tsx`

### Test cases

| # | Test | Scenario | Expected |
|---|------|----------|----------|
| IT1 | SSE complete includes dimensional data | Mock SSE stream with Tier 2-4 fields in `scores` | `DimensionalIntelligence` renders sections |
| IT2 | Preloaded lastCheck renders dimensional data | Provide `lastCheck: CitationCheckScore` with populated Tier 2-4 fields | Sections render on initial load |
| IT3 | Old SSE event (no dimensional fields) | Mock SSE `complete` without Tier 2-4 fields | Sections hidden, no crash |
| IT4 | DimensionalIntelligence renders after CitationAnalytics | Full page render with both components | Dimensional sections appear below competitor SOV |
| IT5 | Expand/collapse preserves state | Expand a geo competitor row, then expand a category row | Both remain expanded |
| IT6 | Responsive — mobile layout | Render at 320px viewport width | Tables stack as cards |
| IT7 | Responsive — desktop layout | Render at 1280px viewport width | Full-width tables |

### Approach
- Use React Testing Library with Vitest
- Mock fetch for SSE stream (IT1, IT3)
- Use `lastCheck` prop for IT2
- Use `window.matchMedia` mock for responsive tests (IT6, IT7) or use `container` width assertions

---

## e) Profiling Requirements

### What to measure
- **Render time** of `DimensionalIntelligence` component with realistic data (20 geos, 15 categories, 3 tiers, 50 dominance entries, 30 real questions, 10 gap entries)
- **Re-render cost** when parent re-renders but data hasn't changed

### Baseline expectations
- Initial render: < 16ms (single frame)
- Re-render with unchanged data: < 5ms (React should bail out if data reference is stable)

### Tool
- React DevTools Profiler (built into Chrome DevTools)
- `React.memo` the component if re-render exceeds 5ms on unchanged props

---

## f) Load Test Plan

Not applicable — this is a frontend-only component with no API calls. Load testing is handled by existing citation-check API load tests.

---

## g) Logging & Instrumentation

### Events to log
None — this is a pure frontend render component. No API calls, no side effects.

### Metrics to emit
None required. The data flow fix (B1) inherits existing logging from the citation-check route.

### Console logging
- No `console.log` in the component — all data issues are handled by silent fallback (empty sections)

---

## h) Acceptance Criteria

| # | Criterion | Spec Section |
|---|-----------|-------------|
| AC1 | Tier visibility breakdown (buy/solve/learn) renders with 3 colored progress bars when `tierVisibility` is non-empty | B4 §1 |
| AC2 | Progress bar colors: green ≥40%, amber 15-39%, red <15% | B4 §1 |
| AC3 | Geographic performance table renders when `geoVisibility` is non-empty, sorted by visibility ascending | B4 §2 |
| AC4 | Location competitors expand within geo rows when `locationCompetitors` data exists for matching `geoId` | B4 §2 |
| AC5 | Category performance table renders when `categoryVisibility` is non-empty, sorted by visibility ascending | B4 §3 |
| AC6 | Category competitors expand within category rows when `categoryCompetitors` data exists for matching `categoryId` | B4 §3 |
| AC7 | Dominance insights render with color-coded severity (red/amber/green) when `dominanceMap` has insights | B4 §4 |
| AC8 | Dominance entries table renders as fallback when insights are empty but entries exist | B4 §4 |
| AC9 | Real user questions render grouped by source (PAA/Reddit/Quora badges) when `realPromptDiscovery` is non-empty | B4 §5 |
| AC10 | Real user questions section collapsed by default with "Show N real questions" toggle | B4 §5 |
| AC11 | Visibility gap analysis table renders when `visibilityGapAnalysis` is non-empty, capped at 10 entries | B4 §6 |
| AC12 | Dimension badges in gap analysis: geo=blue, category=purple, tier=amber | B4 §6 |
| AC13 | All sections hidden when their data is empty — no empty state UI | B4 |
| AC14 | Component returns `null` when ALL dimensional data is empty | B4 |
| AC15 | Responsive: mobile (<640px) stacks tables as cards | B6 |
| AC16 | Responsive: desktop (1024px+) full-width tables | B6 |
| AC17 | Design tokens match existing citation-analytics styling exactly | B5 |
| AC18 | SSE `complete` event includes Tier 2-4 dimensional fields | B1 |
| AC19 | Frontend SSE handler reads Tier 2-4 fields (not hardcoded empty) | B3 |
| AC20 | `CitationCheckResult.scores` type includes optional Tier 2-4 fields | B2 |
| AC21 | Component renders correctly from live SSE path (CitationCheckResult) | B4 |
| AC22 | Component renders correctly from preloaded path (CitationCheckScore/lastCheck) | B4 |
| AC23 | No new API calls — all data from existing CitationCheckScore fields | B7 |
| AC24 | Backward compatible — old SSE events without Tier 2-4 fields don't crash | B2, B3 |
| AC25 | 23 unit tests pass (UT1-UT23) | §c |
| AC26 | 7 integration tests pass (IT1-IT7) | §d |

---

## ScriptDev Implementation Notes

1. **Start with B1+B2** (data flow fix) — without this, the live scan path will show empty sections. It's ~15 lines total.
2. **B4 is the bulk of the work** — the new component. Use `citation-analytics.tsx` as a template for design tokens, section heading style, expand/collapse pattern (see `ThemeRow`), and responsive CSS approach.
3. **Do NOT use any chart libraries** — all visualizations are progress bars (inline `<div>` elements) and tables. No recharts, no SVG.
4. **The `getDimensionalData()` extraction function** is critical — it handles both `CitationCheckResult` (nested in `.scores`) and `CitationCheckScore` (flat). Test both paths (UT19, UT20).
5. **Expand/collapse state** — use individual `useState<boolean>` per expandable row, same pattern as `ThemeRow` in citation-analytics.tsx. Don't use a single shared state.
6. **Source badge colors** (Section 5) are NOT the same as the design tokens — PAA blue (#2563eb), Reddit orange (#ea580c), Quora red (#dc2626). These are distinct from the GREEN/AMBER/RED tokens.
7. **The "dominates"/"competitive"/"lead" keyword matching** (Section 4) should use `insight.toLowerCase().includes()` — the insight strings are generated by `generateDominanceInsights()` which uses these exact words.
