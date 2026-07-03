# TS-016 — Brand Monitoring Dashboard

**GitHub Issue:** #107
**Date:** 2026-03-02
**Priority:** P1 — closes the optimization feedback loop (audit → fix → check → verify improvement)
**Depends on:** ES-015 (citation check API + `citationCheckScores` table) merged to main

---

## What

Add a **Brand Monitoring Dashboard** to the AI Visibility tab on the site results page
(`/sites/[id]`). Users currently see only the most recent citation check result. This spec
adds a historical view with trend analytics so users can track whether their AI visibility
is improving over time after GEO optimizations.

### Deliverables

1. **New API endpoint**: `GET /api/sites/[id]/citation-history`
   — returns last 10 citation check scores for the site, authenticated by token.

2. **New client component**: `app/components/citation-history.tsx`
   — history tab rendered inside the existing AI Visibility section.

3. **Server-side data load**: update `app/sites/[id]/page.tsx` to also pre-load
   citation history alongside the existing `lastCheck` fetch.

4. **Integration**: update `citation-monitor.tsx` to accept and display history data.

---

## Why

The citation checker (ES-015) tells users *right now* whether AI platforms mention
their brand. But the strategic question is: **is it getting better?**

After a GEO audit, a user implements recommendations, then runs another citation check.
Without history, they can't see the delta. With history:

```
Audit score 42 → implement recommendations → re-check → visibility 67% (+25pp)
```

This is the feedback loop that justifies continued use of the product. Without it,
the citation check is a one-shot report. With it, it becomes an ongoing monitoring tool.

**Related issues addressed:**
- #28 — source attribution analytics (which providers cite you most, over time)
- #70 — score history chart (visibility trend over time)

---

## Scope

### In Scope
- Citation history API (last 10 checks, auth-gated)
- Sparkline trend chart of `overallVisibility` (SVG, no new dependency)
- History table: date, visibility %, best provider, avg position, sentiment
- Provider consistency table: per-provider mention rate aggregated across history
- Top competitors across history (aggregate `competitorVisibility` from all checks)
- Server-side pre-load of history (same pattern as `lastCheck`)

### Out of Scope
- Pagination beyond 10 results (future)
- Email alerts / scheduled checks (#24)
- Per-page citation tracking (aggregate domain only)
- Export to CSV (future)
- DSPy prompt optimization (#25)
- Competitor benchmarking dashboard (separate feature)

---

## Architecture

### Data Flow

```
page.tsx (server)
  ├── fetch geoSites (existing)
  ├── fetch lastCitationCheck from citationCheckScores (existing)
  └── fetch citationHistory: last 10 from citationCheckScores ORDER BY createdAt DESC (NEW)
        ↓
CitationMonitor (existing client component)
  ├── props: { ..., lastCheck, history: CitationCheckScore[] }
  └── renders two tabs:
        ├── "Run Check" tab (existing — run + live results)
        └── "History" tab (NEW — CitationHistory component)
              ├── VisibilitySparkline (SVG trend chart)
              ├── HistoryTable (per-check summary rows)
              ├── ProviderConsistencyTable (per-provider aggregates across checks)
              └── TopCompetitors (aggregate competitor visibility)
```

### No New Dependencies

The existing stack (React, Tailwind, Lucide, TypeScript) is sufficient:
- Sparkline: inline SVG path computed from `overallVisibility` values
- Tables: standard Tailwind table styling already used on the page
- No recharts, no d3

---

## New Artifacts

### 1. `app/api/sites/[id]/citation-history/route.ts`

```
GET /api/sites/[id]/citation-history?token={accessToken}&limit={n}
```

**Auth:** same pattern as citation-check route — Bearer header or `?token=` param,
compared against `site.accessToken`.

**Response (200):**
```typescript
{
  history: CitationCheckScore[]   // last N records, most recent first
  total: number                   // total number of checks ever run for this site
}
```

**Error responses:**
- `401` — missing or wrong token
- `404` — site not found
- `400` — invalid limit param (must be 1–50, default 10)

**Query:**
```sql
SELECT * FROM citation_check_scores
WHERE site_id = $siteId
ORDER BY created_at DESC
LIMIT $limit
```

**No credit deduction.** This is a read-only endpoint.

---

### 2. `app/components/citation-history.tsx` (new component)

**Props:**
```typescript
interface CitationHistoryProps {
  history: CitationCheckScore[]
  domain: string
}
```

**Renders four sub-sections:**

#### A. Visibility Trend (sparkline)
- SVG viewBox with a polyline connecting `overallVisibility` values over time
- X-axis: check date labels (e.g., "Mar 2", "Mar 5")
- Y-axis: 0–100 (three gridlines: 25, 50, 75)
- Dots on each data point; tooltip on hover (title attribute)
- Color: green if latest > first check, amber if same, red if declined
- Computed entirely from `history.map(h => h.overallVisibility)` — no library

#### B. History Table
Columns: Date | Visibility % | Best Provider | Avg Position | Sentiment | Credits Used

Each row = one `CitationCheckScore`. Most recent at top.
Sentinel indicator: ▲ / ▼ on visibility vs previous check.

#### C. Provider Consistency Table
Columns: Provider | Avg Visibility % | Checks With Mention | Total Checks

Computed by aggregating `providerResults` across all history records.
Shows which AI platform mentions the brand most reliably over time.

#### D. Top Competitors (History Aggregate)
Aggregate `competitorVisibility` across all checks. Show top 5 competitors
and their average visibility % across all checks (i.e., "competitor.com appeared
in 80% of your citation checks").

---

### 3. Updates to `app/components/citation-monitor.tsx`

- Add `history: CitationCheckScore[]` to props
- Add a tab toggle: **"Run Check"** | **"History"** (show history badge count)
- Render `<CitationHistory history={history} domain={domain} />` when History tab active
- After a new check completes (`status === "complete"`), prepend the new result to the
  history array in local state so the trend updates without page reload

---

### 4. Updates to `app/sites/[id]/page.tsx`

Add second DB query alongside existing `lastCheck` fetch:

```typescript
const citationHistory = await db
  .select()
  .from(citationCheckScores)
  .where(eq(citationCheckScores.siteId, site.id))
  .orderBy(desc(citationCheckScores.createdAt))
  .limit(10);
```

Pass `citationHistory` as a prop to `<CitationMonitor>`.

---

## Acceptance Criteria

| # | Criterion | How to Verify |
|---|-----------|---------------|
| BM-1 | History tab visible when site has ≥1 past citation check | Open site page with prior check in DB; "History (N)" tab appears |
| BM-2 | History tab hidden / empty state shown when no checks run yet | Fresh site with no checks; History tab shows "No checks yet" |
| BM-3 | Sparkline renders with correct number of points | 5 historical checks → 5 dots on the SVG sparkline |
| BM-4 | Sparkline color reflects trend direction | Latest visibility > first → green line; < first → red |
| BM-5 | History table rows ordered most-recent first | Most recent check at top |
| BM-6 | History table shows ▲/▼ delta vs previous check | Row 2 visibility < row 1 → ▼ indicator on row 1 |
| BM-7 | Provider consistency table aggregates across all history | 3 checks each mentioning "openai" → Avg Visibility reflects 3/3 = 100% |
| BM-8 | Top competitors aggregated across history | competitorVisibility from 3 checks merged, top 5 shown |
| BM-9 | New check result prepended to history without page reload | Run check; complete → history updates in place |
| BM-10 | Citation history API returns 401 for wrong token | curl with bad token → `{ "error": "Unauthorized" }` |
| BM-11 | Citation history API returns empty array for site with no checks | Correct token, site exists, no checks → `{ history: [], total: 0 }` |
| BM-12 | Server-side `citationHistory` pre-loaded and passed to component | Page renders history without client-side fetch on first load |

---

## Risks

| Risk | Mitigation |
|------|------------|
| `providerResults` JSONB shape may vary across old vs new checks | Access defensively with optional chaining; skip malformed records |
| Sparkline SVG not rendering if all visibility values are 0 | Show flat line + "No mentions recorded" label instead of empty SVG |
| Page load time if site has many history records | Limit to 10 server-side; history API also caps at 50 max |
| `competitorVisibility` may be `{}` for all checks | Show "No competitors detected" if aggregate is empty |

---

## Implementation Notes

### Sparkline SVG Computation

```typescript
// width=300, height=60, padding=10
function buildSparklinePath(values: number[]): string {
  if (values.length < 2) return "";
  const w = 300 - 20; // usable width
  const h = 60 - 20;  // usable height
  const points = values.map((v, i) => {
    const x = 10 + (i / (values.length - 1)) * w;
    const y = 10 + (1 - v / 100) * h;
    return `${x},${y}`;
  });
  return `M ${points.join(" L ")}`;
}
```

### Tab Toggle Pattern

Use `useState<"run" | "history">("run")` and conditional rendering.
If `history.length === 0`, keep the "History" tab but show an empty state card.

### Reference Implementations

- `app/components/citation-monitor.tsx` — existing SSE + state pattern to extend
- `app/api/sites/[id]/citation-check/route.ts` — auth pattern to copy for history API
- `app/sites/[id]/page.tsx` — server-side DB fetch pattern to extend
- `flowblinq_fullrepo/brands-api/src/services/ai-visibility-engine.ts` — aggregation
  logic for `providerResults` (how to summarize across multiple checks)
