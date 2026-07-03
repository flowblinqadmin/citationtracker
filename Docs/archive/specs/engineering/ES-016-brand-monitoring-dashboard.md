# ES-016 — Brand Monitoring Dashboard

**Source spec:** TS-016-brand-monitoring-dashboard.md  
**GitHub Issue:** #107  
**Date:** 2026-03-01  
**Priority:** P1  
**Target branch:** dev-sprint-8 (NOT dev-sprint-7 — PR #103 pending merge)  
**Depends on:** ES-015 merged to main (`citationCheckScores` table + `citation-monitor.tsx` must exist)

---

## a) Overview

Adds a historical trend view to the AI Visibility section on `/sites/[id]`. Currently users see only their most recent citation check result. This spec adds:

1. A new **read-only API route** — `GET /api/sites/[id]/citation-history`
2. A new **client component** — `app/components/citation-history.tsx`
3. A **tab toggle** in `citation-monitor.tsx` — "Run Check" | "History"
4. A **server-side pre-load** in `app/sites/[id]/page.tsx`

**Current state (what exists):**
- `citationCheckScores` table: exists, schema confirmed at `geo/lib/db/schema.ts:221-242`
- `citation-monitor.tsx`: exists, single-mode (run + show result); no tab toggle, no history prop
- `page.tsx`: pre-loads `lastCitationCheck` (one row); passes to `<CitationMonitor>`
- `citation-check/route.ts`: auth pattern confirmed; POST-only SSE endpoint

**What's new:**
- `geo/app/api/sites/[id]/citation-history/route.ts` — new file
- `geo/app/components/citation-history.tsx` — new file
- `geo/app/components/citation-monitor.tsx` — extend (add tab + history prop)
- `geo/app/sites/[id]/page.tsx` — extend (add second DB query + prop)

---

## b) Implementation Requirements

### File 1: `geo/app/api/sites/[id]/citation-history/route.ts` (NEW)

**Runtime config:**
```typescript
export const runtime = "nodejs";
```

**Route context interface:** copy verbatim from `citation-check/route.ts`:
```typescript
interface RouteContext {
  params: Promise<{ id: string }>;
}
```

**Auth pattern:** copy exactly from `citation-check/route.ts`:
```typescript
const token = req.headers.get("authorization")?.replace("Bearer ", "")
  ?? req.nextUrl.searchParams.get("token");
if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });
if (site.accessToken !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
```

**Query param:**
- `?limit=N` — integer, 1–50, default 10
- Invalid (non-integer, out of range, zero): return `400 { error: "Invalid limit. Must be 1–50." }`

**DB query:**
```typescript
const rows = await db
  .select()
  .from(citationCheckScores)
  .where(eq(citationCheckScores.siteId, siteId))
  .orderBy(desc(citationCheckScores.createdAt))
  .limit(limit);

const [{ count }] = await db
  .select({ count: sql<number>`count(*)::int` })
  .from(citationCheckScores)
  .where(eq(citationCheckScores.siteId, siteId));
```

**Response shape:**
```typescript
// 200
{ history: CitationCheckScore[], total: number }

// 401
{ error: "Unauthorized" }

// 404
{ error: "Site not found" }

// 400
{ error: "Invalid limit. Must be 1–50." }
```

**No credit deduction.** Read-only. No `maxDuration` needed (fast DB read).

**Imports needed:**
```typescript
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites, citationCheckScores } from "@/lib/db/schema";
import { eq, desc, sql } from "drizzle-orm";
```

---

### File 2: `geo/app/components/citation-history.tsx` (NEW)

**Directive:** `"use client"`

**Props interface:**
```typescript
interface CitationHistoryProps {
  history: CitationCheckScore[];
  domain: string;
}
```

**Imports:**
```typescript
import { type CitationCheckScore } from "@/lib/types/citation";
import { type ProviderResult } from "@/lib/types/citation";
```

**Sub-section A — Visibility Sparkline (inline SVG):**

Render only when `history.length >= 2`. When `history.length === 1`, show a single dot with label "Only 1 check — run another to see trend." When `history.length === 0`, do not render this sub-section.

Values are `history.map(h => h.overallVisibility)` — note: `history` is ordered most-recent first from the API. **Reverse** the array for the sparkline so oldest is leftmost (chronological order left→right).

```typescript
function buildSparklinePath(values: number[]): string {
  if (values.length < 2) return "";
  const w = 300 - 20;
  const h = 60 - 20;
  const points = values.map((v, i) => {
    const x = 10 + (i / (values.length - 1)) * w;
    const y = 10 + (1 - v / 100) * h;
    return `${x},${y}`;
  });
  return `M ${points.join(" L ")}`;
}
```

Trend color logic:
```typescript
const chronological = [...history].reverse();
const first = chronological[0].overallVisibility;
const latest = chronological[chronological.length - 1].overallVisibility;
const trendColor = latest > first ? "#4ade80" : latest < first ? "#f87171" : "#facc15";
```

SVG structure:
- `viewBox="0 0 300 60"` — matches sparkline computation dimensions
- Three horizontal gridlines at y=10+(1-0.75)*40=20, y=30, y=40 (25%, 50%, 75% positions)
- `<polyline>` or `<path>` using `buildSparklinePath`
- Circle dots at each data point (r=3, fill=trendColor)
- Each dot has a `<title>` with date + visibility value for hover tooltip
- Edge-case: if all values are 0, render flat line at y=50 + "No mentions recorded" text label

**Sub-section B — History Table:**

Columns: Date | Visibility % | Best Provider | Avg Position | Sentiment | Credits Used

- Rows ordered most-recent first (as returned from API)
- Delta indicator: compare row `i` vs row `i+1` (next = older). Show `▲` in green if current > previous, `▼` in red if current < previous, `—` if equal or first row
- Sentinel: first row (most recent) gets no delta (it has nothing to compare forward to... wait — most recent is `history[0]`, previous is `history[1]`. Delta for `history[0]` = `history[0].overallVisibility - history[1].overallVisibility`. Delta for `history[history.length - 1]` = none.)
- Format date: `new Date(row.createdAt!).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })`
- Defensive: `bestProvider ?? "—"`, `avgPosition ?? "—"`, use `sentimentScore` for sentiment display (map: >0 → "Positive", <0 → "Negative", =0 → "Neutral") or display `bestProvider` field

**Sub-section C — Provider Consistency Table:**

Columns: Provider | Avg Visibility % | Checks With Mention | Total Checks

Aggregation — iterate over all `history` records, then all `providerResults` in each:
```typescript
type ProviderAgg = { totalVisibility: number; checksWithMention: number; totalChecks: number };
const agg: Record<string, ProviderAgg> = {};

for (const check of history) {
  const results = check.providerResults as ProviderResult[] ?? [];
  for (const pr of results) {
    if (!agg[pr.provider]) agg[pr.provider] = { totalVisibility: 0, checksWithMention: 0, totalChecks: 0 };
    agg[pr.provider].totalVisibility += pr.visibilityScore;
    agg[pr.provider].checksWithMention += pr.mentionCount > 0 ? 1 : 0;
    agg[pr.provider].totalChecks += 1;
  }
}
```

Display sorted by avg visibility descending. Access defensively with optional chaining (`check.providerResults as ProviderResult[] ?? []`) to handle legacy records.

**Sub-section D — Top Competitors (History Aggregate):**

Aggregate `competitorVisibility` across all checks:
```typescript
const compAgg: Record<string, { total: number; appearances: number }> = {};

for (const check of history) {
  const cv = check.competitorVisibility as Record<string, number> ?? {};
  for (const [comp, pct] of Object.entries(cv)) {
    if (!compAgg[comp]) compAgg[comp] = { total: 0, appearances: 0 };
    compAgg[comp].total += pct;
    compAgg[comp].appearances += 1;
  }
}

const ranked = Object.entries(compAgg)
  .map(([comp, { total, appearances }]) => ({ comp, avg: Math.round(total / appearances) }))
  .sort((a, b) => b.avg - a.avg)
  .slice(0, 5);
```

If `ranked.length === 0`: show card "No competitors detected across your citation history."

**Empty state (history.length === 0):**
Show a single card: "No citation checks yet. Run your first check to start tracking AI visibility."

**Styling:** match existing inline-style convention used in `citation-monitor.tsx` (dark theme: `#000` background, `#222` borders, `#aaa` muted text, `#4ade80` green, `#f87171` red, `#facc15` amber).

---

### File 3: `geo/app/components/citation-monitor.tsx` (EXTEND)

**Changes only — do not rewrite the file:**

1. **Add `history` prop to interface:**
```typescript
interface CitationMonitorProps {
  siteId:      string;
  accessToken: string;
  domain:      string;
  lastCheck:   CitationCheckScore | null;
  history:     CitationCheckScore[];          // NEW
}
```

2. **Add tab state:**
```typescript
const [activeTab, setActiveTab] = useState<"run" | "history">("run");
```

3. **Add local history state** (so new check prepends without reload):
```typescript
const [localHistory, setLocalHistory] = useState<CitationCheckScore[]>(history);
```

4. **On check complete** — in the `else if (type === "complete")` branch, after setting state, construct a new `CitationCheckScore` record and prepend it:
```typescript
// After setState for "complete":
// Build a CitationCheckScore-shaped record from the result to prepend
const newScore: CitationCheckScore = {
  checkId:              data.checkId,
  siteId,
  teamId:               "",           // not available client-side; use placeholder
  domain,
  overallVisibility:    data.scores.overallVisibility,
  bestProvider:         data.scores.bestProvider ?? null,
  worstProvider:        data.scores.worstProvider ?? null,
  avgPosition:          data.scores.avgPosition ?? null,
  sentimentScore:       data.scores.sentimentScore,
  providerResults:      data.providerResults,
  competitorVisibility: data.scores.competitorVisibility,
  creditsUsed:          data.creditsUsed,
  promptsUsed:          data.promptsUsed,
  createdAt:            new Date(),
};
setLocalHistory(prev => [newScore, ...prev]);
```

5. **Add tab toggle UI** — insert above the existing content area, below the header row:
```tsx
<div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
  {(["run", "history"] as const).map(tab => (
    <button
      key={tab}
      onClick={() => setActiveTab(tab)}
      style={{
        background:   activeTab === tab ? "#fff" : "transparent",
        color:        activeTab === tab ? "#000" : "#666",
        border:       "1px solid #333",
        borderRadius: 6,
        padding:      "6px 14px",
        fontSize:     13,
        fontWeight:   600,
        cursor:       "pointer",
      }}
    >
      {tab === "run" ? "Run Check" : `History${localHistory.length > 0 ? ` (${localHistory.length})` : ""}`}
    </button>
  ))}
</div>
```

6. **Conditional rendering** — wrap existing content in `activeTab === "run" && (...)` and add:
```tsx
{activeTab === "history" && (
  <CitationHistory history={localHistory} domain={domain} />
)}
```

7. **Import CitationHistory:**
```typescript
import { CitationHistory } from "@/app/components/citation-history";
```

8. **Update function signature** to destructure `history`:
```typescript
export function CitationMonitor({ siteId, accessToken, domain, lastCheck, history }: CitationMonitorProps) {
```

---

### File 4: `geo/app/sites/[id]/page.tsx` (EXTEND)

**Add second DB query** immediately after the existing `lastCitationCheck` query:

```typescript
// Pre-load citation history (server-side) — last 10 checks
const citationHistory = await db
  .select()
  .from(citationCheckScores)
  .where(eq(citationCheckScores.siteId, site.id))
  .orderBy(desc(citationCheckScores.createdAt))
  .limit(10);
```

**Pass as prop** to `<CitationMonitor>`:
```tsx
<CitationMonitor
  siteId={site.id}
  accessToken={site.accessToken!}
  domain={site.domain}
  lastCheck={lastCitationCheck ?? null}
  history={citationHistory}
/>
```

No other changes to this file.

---

## c) Unit Test Plan

**Test file:** `geo/__tests__/citation-history-api.test.ts`

**Framework:** Use existing test framework in the project (check `package.json` for jest/vitest).

**Mocks required:**
- `@/lib/db` — mock `db.select().from().where().orderBy().limit()` chain
- `next/server` — `NextRequest` constructor, `NextResponse.json`

### Test cases

| ID | Description | Input | Expected |
|----|-------------|-------|----------|
| U-1 | Missing token | No auth header, no ?token | 401 `{ error: "Unauthorized" }` |
| U-2 | Wrong token | token ≠ site.accessToken | 401 `{ error: "Unauthorized" }` |
| U-3 | Site not found | Correct token format but DB returns [] | 404 `{ error: "Site not found" }` |
| U-4 | Valid request, no checks | DB returns [], count=0 | 200 `{ history: [], total: 0 }` |
| U-5 | Valid request, 3 checks | DB returns 3 rows | 200 `{ history: [3 rows], total: 3 }` |
| U-6 | Default limit=10 | No ?limit param | DB called with limit=10 |
| U-7 | Custom limit=5 | ?limit=5 | DB called with limit=5 |
| U-8 | Limit too large | ?limit=51 | 400 `{ error: "Invalid limit. Must be 1–50." }` |
| U-9 | Limit zero | ?limit=0 | 400 `{ error: "Invalid limit. Must be 1–50." }` |
| U-10 | Limit non-integer | ?limit=abc | 400 `{ error: "Invalid limit. Must be 1–50." }` |
| U-11 | Bearer header auth | Authorization: Bearer {token} | 200 (auth accepted) |
| U-12 | ?token= query auth | ?token={token} | 200 (auth accepted) |

**Coverage target:** 100% of route handler branches (all error paths + success path).

---

**Test file:** `geo/__tests__/citation-history-component.test.tsx`

**Framework:** React Testing Library (if present) or snapshot tests.

| ID | Description | Setup | Expected |
|----|-------------|-------|----------|
| C-1 | Empty history | `history=[]` | Renders "No citation checks yet" empty state |
| C-2 | Single check | `history=[oneRecord]` | Sparkline not rendered; history table shows 1 row |
| C-3 | Two checks | `history=[r1, r2]` | Sparkline renders with 2 dots |
| C-4 | Delta indicator up | r1.overallVisibility=70, r2=50 | r1 shows ▲ |
| C-5 | Delta indicator down | r1.overallVisibility=40, r2=60 | r1 shows ▼ |
| C-6 | All-zero visibility | history with all overallVisibility=0 | Flat line SVG + "No mentions recorded" label |
| C-7 | No competitors | all competitorVisibility={} | "No competitors detected" card |
| C-8 | Provider aggregation | 2 checks, openai mentioned in both | openai row shows checksWithMention=2 |
| C-9 | Defensive JSONB | providerResults=null on one check | No crash; skips that record |

---

**Test file:** `geo/__tests__/citation-monitor-history.test.tsx`

| ID | Description | Expected |
|----|-------------|----------|
| M-1 | History tab shows count | `history=[r1,r2]` → button reads "History (2)" |
| M-2 | Tab switches view | Click "History" → CitationHistory rendered; "Run Check" content hidden |
| M-3 | New check prepends | After complete SSE event, localHistory length increases by 1 |
| M-4 | History prop empty, tab still shows | `history=[]` → "History (0)" button renders without crash |

---

## d) Integration Test Plan

**Test file:** `geo/__tests__/integration/citation-history-integration.test.ts`

### Scenario 1 — Happy path: full page load with history

1. Seed DB: 1 site, 3 citation check records
2. Call `page.tsx` server component (or simulate the DB calls)
3. Assert: `citationHistory` has 3 records ordered by `createdAt DESC`
4. Assert: `history` prop reaches `<CitationMonitor>` with correct length

### Scenario 2 — API end-to-end

1. Seed DB: site with `accessToken = "test-token"`, 2 citation check records
2. GET `/api/sites/{id}/citation-history?token=test-token`
3. Assert: 200, `history.length === 2`, `total === 2`, ordered most-recent first

### Scenario 3 — New check updates history without reload

1. Render `<CitationMonitor>` with `history=[oneRecord]`
2. Simulate SSE `complete` event with new check data
3. Assert: `localHistory.length === 2` (new record prepended)
4. Switch to History tab; assert CitationHistory receives updated array

### Scenario 4 — Unauthorized access

1. GET `/api/sites/{id}/citation-history?token=wrong-token`
2. Assert: 401

### Scenario 5 — Zero-history site

1. Seed DB: site with no citation checks
2. GET `/api/sites/{id}/citation-history?token=...`
3. Assert: 200 `{ history: [], total: 0 }`
4. Render `<CitationHistory history={[]} domain="...">` — assert empty state renders

---

## e) Profiling Requirements

**What to measure:**

| Metric | Tool | Target |
|--------|------|--------|
| DB query latency (citation-history route) | `console.time` or Drizzle explain | < 50ms p95 for sites with ≤ 50 checks |
| Server-side page load (both lastCheck + history queries) | Next.js dev timing | < 100ms added latency vs current page load |
| Sparkline SVG render time | React DevTools profiler | < 5ms for 10 data points |
| CitationHistory component render | React DevTools profiler | < 16ms (one frame) for 10-row history |

**Baseline:** Current `/sites/[id]` page load with no history pre-load (record this before adding the second query).

**Profiling tool:** Next.js built-in profiler (`NEXT_TELEMETRY_DEBUG=1`), React DevTools.

---

## f) Load Test Plan

**Target endpoint:** `GET /api/sites/[id]/citation-history`

### Scenario 1 — Steady throughput
- 50 concurrent requests/sec for 60s
- Each request: valid token, site with 10 history records
- **Pass criteria:** p50 < 30ms, p95 < 100ms, p99 < 200ms, 0% error rate

### Scenario 2 — Burst
- 200 requests in 5 seconds (burst)
- **Pass criteria:** all requests complete within 2s, 0% 5xx

### Scenario 3 — Large history (limit=50)
- 20 concurrent requests/sec, each fetching limit=50
- **Pass criteria:** p95 < 200ms

**Tool:** `k6` or `wrk`. Site must have ≥ 10 seeded records. Run against local/staging DB.

**Resource bounds:** DB connection pool must not be exhausted. Check for connection leak after load test (pool should return to pre-test count within 5s).

---

## g) Logging & Instrumentation

### API Route: `citation-history/route.ts`

```typescript
// On each successful response:
console.info(`[citation-history] siteId=${siteId} returned ${rows.length}/${count} records`);

// On auth failure:
console.warn(`[citation-history] siteId=${siteId} unauthorized attempt`);

// On invalid limit:
console.warn(`[citation-history] siteId=${siteId} invalid limit param: ${rawLimit}`);
```

**Log level guidance:**
- `info` — successful data retrieval (include siteId, result count)
- `warn` — auth failures, invalid params (include siteId, param value)
- `error` — unexpected DB errors (include full error + siteId)

**No PII in logs.** Do not log `accessToken` or `domain`.

### page.tsx

Add timing log for the new query:
```typescript
const t0 = Date.now();
const citationHistory = await db...
console.info(`[page] citationHistory preload siteId=${site.id} rows=${citationHistory.length} ms=${Date.now()-t0}`);
```

### Client component (citation-monitor.tsx)

No new logging needed. The existing `handleSSEEvent` flow handles all client-side state transitions.

---

## h) Acceptance Criteria

All criteria from TS-016 mapped to implementation:

| # | Criterion | Implementation reference |
|---|-----------|--------------------------|
| BM-1 | History tab visible when ≥1 past check | `CitationMonitor` tab button always renders; badge count from `localHistory.length` |
| BM-2 | Empty state shown when no checks run | `CitationHistory` renders "No citation checks yet" card when `history.length === 0` |
| BM-3 | Sparkline points match check count | `buildSparklinePath` maps one point per record; `<circle>` per point |
| BM-4 | Sparkline color reflects trend direction | `trendColor` logic: latest > first → green, < → red, = → amber |
| BM-5 | History table ordered most-recent first | API returns `ORDER BY created_at DESC`; component renders in array order |
| BM-6 | ▲/▼ delta indicator per row | Delta computed as `history[i].overallVisibility - history[i+1].overallVisibility` |
| BM-7 | Provider consistency aggregated | `ProviderAgg` accumulation loop across all history records |
| BM-8 | Top competitors aggregated | `compAgg` accumulation loop, top 5 by avg % |
| BM-9 | New check prepends history without reload | `setLocalHistory(prev => [newScore, ...prev])` in `complete` SSE handler |
| BM-10 | Citation history API returns 401 for wrong token | Auth check: `site.accessToken !== token → 401` |
| BM-11 | Empty array for site with no checks | DB returns `[]`; route returns `{ history: [], total: 0 }` |
| BM-12 | Server-side pre-load passed to component | `page.tsx` fetches `citationHistory`, passes as `history={citationHistory}` |

**Definition of Done:**
- [ ] All 4 files created/modified as specified
- [ ] All unit tests pass (U-1 through U-12, C-1 through C-9, M-1 through M-4)
- [ ] All integration scenarios pass (S1–S5)
- [ ] No new npm dependencies introduced
- [ ] Sparkline uses only inline SVG (no recharts, no d3, no chart library)
- [ ] All log statements follow level guidance (no token/PII in logs)
- [ ] `target_branch: dev-sprint-8` — do not merge or target dev-sprint-7
- [ ] PR linked to GitHub Issue #107
