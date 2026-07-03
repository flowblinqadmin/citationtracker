# ES-061 — Portfolio Dashboard Rebuild

**Spec ID:** ES-061
**Date:** 2026-03-25
**Author:** SpecMaster (Agent 2)
**Source TS:** TS-061-portfolio-dashboard-rebuild.md
**Implementor:** DaVinci (Agent 10)
**Status:** Ready

---

## a) Overview

### What
Full rebuild of the portfolio dashboard (`app/dashboard/page.tsx`) from a card-based grid (HoverCard) to a KPI + sortable data table design with copper design system. Two new client islands: `RowActions.tsx` (per-row action buttons) and `DomainTableRow.tsx` (scanning row poller). One deletion: `HoverCard.tsx`.

### Reference
- **Source TS:** `.agents/specs/technical/TS-061-portfolio-dashboard-rebuild.md`
- **Design authority:** `geo/docs/frontend/FlowBlinqGEO-ImplementationSpec.md` §1.1
- **Visual reference:** `geo/docs/frontend/GEOPortfolioDashboardMockup-FINAL.html`

### Current Implementation State
- `app/dashboard/page.tsx` (210 lines): server component with card grid. Fetches `geoSites.geoScorecard` and `pipelineStatus` only. Renders HoverCard per domain. No KPI cards, no table, no citation rate.
- `app/dashboard/HoverCard.tsx` (122 lines): client component showing score, band, status badge. **DELETE.**
- `app/dashboard/RowActions.tsx`: **does not exist** — must create.
- `app/dashboard/DomainTableRow.tsx`: **does not exist** — must create.
- `app/dashboard/BuyCreditsButton.tsx` (27 lines): shows credit count badge, opens UpgradeModal. **KEEP.**
- `app/dashboard/SignOutButton.tsx`: **KEEP** (referenced, not read — assume unchanged).
- `app/dashboard/PaymentToast.tsx`: **KEEP** (referenced, not read — assume unchanged).
- `app/dashboard/ApiAccessSection.tsx`: **KEEP**, position below table.

---

## b) Implementation Requirements

### Design System Constants

All color values are hardcoded inline (no CSS variables in server-rendered HTML). Use these exact values throughout:

```typescript
const COPPER        = "#c2652a";
const COPPER_LIGHT  = "#d4803e";
const COPPER_BG     = "#fff7ed";
const BG            = "#f5f5f7";
const CARD          = "#fff";
const BORDER        = "#e5e5ea";
const GREEN         = "#34c759";
const ORANGE        = "#ff9500";
const RED           = "#ff3b30";
const PINK          = "#ff2d55";   // POOR tier only
const TEXT          = "#1d1d1f";
const T2            = "#6e6e73";
const T3            = "#aeaeb2";
```

Font stack: `'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`

Inter import: Add to `<head>`:
```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
```

### File 1: `app/dashboard/page.tsx` — Full Rebuild

**Type:** Server Component (no `"use client"`)

**New TypeScript types to define in this file:**

```typescript
type DomainRow = {
  id: string;              // teamDomains.id
  domain: string;
  siteId: string;
  accessToken: string | null; // geoSites.accessToken — needed by RowActions
  pipelineStatus: string | null;
  overallScore: number | null;
  tier: "GOOD" | "FAIR" | "WEAK" | "POOR" | null;
  criticalIssues: number;
  delta: number | null;
  pageCount: number;
  citationRate: number | null;  // from citationCheckScores.overallVisibility
  lastCrawlAt: string | null;
  createdAt: string;
};

// KPI summary derived from all DomainRows
type KpiSummary = {
  totalSites: number;
  avgScore: number | null;
  totalCritical: number;
  creditBalance: number;
  scanningCount: number;  // for "N scan in progress" subtitle
};
```

**Pure helper functions (define above component, export for testing):**

```typescript
export function deriveTier(score: number | null): "GOOD" | "FAIR" | "WEAK" | "POOR" | null {
  if (score === null) return null;
  if (score >= 75) return "GOOD";
  if (score >= 50) return "FAIR";
  if (score >= 25) return "WEAK";
  return "POOR";
}

export function deriveCriticalIssues(
  pillars: Array<{ score?: number; priority?: string }> | undefined | null
): number {
  if (!pillars) return 0;
  return pillars.filter((p) => p.priority === "critical" || (p.score ?? 100) < 25).length;
}

export function deriveDelta(
  currentScore: number | null,
  previousRunSnapshot: { geoScorecard?: { overallScore?: number } } | null
): number | null {
  if (currentScore === null || !previousRunSnapshot?.geoScorecard?.overallScore) return null;
  return currentScore - previousRunSnapshot.geoScorecard.overallScore;
}

export function derivePageCount(crawlData: { pages?: unknown[] } | null): number {
  return (crawlData as { pages?: unknown[] } | null)?.pages?.length ?? 0;
}

export function isActiveStatus(status: string | null): boolean {
  return ["discovery", "crawling", "researching", "analyzing", "generating", "assembling"].includes(status ?? "");
}

export function formatDashDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function domainMonogramColor(domain: string): string {
  // Deterministic hash → pick from 8 pastel colors
  let hash = 0;
  for (let i = 0; i < domain.length; i++) hash = (hash * 31 + domain.charCodeAt(i)) & 0xffffffff;
  const palette = ["#e8f5e9","#e3f2fd","#fce4ec","#fff8e1","#ede7f6","#e0f7fa","#fbe9e7","#f3e5f5"];
  const textPalette = ["#2e7d32","#1565c0","#c62828","#f57f17","#4527a0","#00695c","#bf360c","#6a1b9a"];
  const idx = Math.abs(hash) % palette.length;
  return `background:${palette[idx]};color:${textPalette[idx]}`;
}
```

**DB imports to add:**
```typescript
import { eq, inArray, desc } from "drizzle-orm";
import { teamMembers, teams, teamDomains, geoSites, citationCheckScores } from "@/lib/db/schema";
```

**Extended domain query** — replace current `rows` select with:
```typescript
const rows = await db
  .select({
    id: teamDomains.id,
    domain: teamDomains.domain,
    siteId: teamDomains.siteId,
    createdAt: teamDomains.createdAt,
    accessToken: geoSites.accessToken,
    pipelineStatus: geoSites.pipelineStatus,
    lastCrawlAt: geoSites.lastCrawlAt,
    geoScorecard: geoSites.geoScorecard,
    previousRunSnapshot: geoSites.previousRunSnapshot,
    crawlData: geoSites.crawlData,
  })
  .from(teamDomains)
  .innerJoin(geoSites, eq(teamDomains.siteId, geoSites.id))
  .where(eq(teamDomains.teamId, membership.teamId));
```

**Citation rate query** — after domain rows are fetched:
```typescript
const t0 = Date.now();
const siteIds = rows.map((r) => r.siteId);
const latestCitations = siteIds.length > 0
  ? await db
      .select({ siteId: citationCheckScores.siteId, rate: citationCheckScores.overallVisibility })
      .from(citationCheckScores)
      .where(inArray(citationCheckScores.siteId, siteIds))
      .orderBy(desc(citationCheckScores.createdAt))
  : [];

// Dedup: first occurrence per siteId = latest
const citationMap = new Map<string, number>();
for (const row of latestCitations) {
  if (!citationMap.has(row.siteId)) citationMap.set(row.siteId, row.rate);
}
console.info(`[dashboard] citationRates=${latestCitations.length} unique=${citationMap.size} ms=${Date.now()-t0}`);
```

**DomainRow mapping:**
```typescript
domains = rows.map((r) => {
  const scorecard = r.geoScorecard as { overallScore?: number; pillars?: Array<{ score?: number; priority?: string }> } | null;
  const snap = r.previousRunSnapshot as { geoScorecard?: { overallScore?: number } } | null;
  const currentScore = scorecard?.overallScore ?? null;
  return {
    id: r.id,
    domain: r.domain,
    siteId: r.siteId,
    accessToken: r.accessToken ?? null,
    pipelineStatus: r.pipelineStatus,
    overallScore: currentScore,
    tier: deriveTier(currentScore),
    criticalIssues: deriveCriticalIssues(scorecard?.pillars),
    delta: deriveDelta(currentScore, snap),
    pageCount: derivePageCount(r.crawlData as { pages?: unknown[] } | null),
    citationRate: citationMap.get(r.siteId) ?? null,
    lastCrawlAt: r.lastCrawlAt?.toISOString() ?? null,
    createdAt: r.createdAt?.toISOString() ?? "",
  };
});
```

Sort domains by `overallScore` descending (nulls last):
```typescript
domains.sort((a, b) => {
  if (a.overallScore === null && b.overallScore === null) return 0;
  if (a.overallScore === null) return 1;
  if (b.overallScore === null) return -1;
  return b.overallScore - a.overallScore;
});
```

**KPI Summary derivation:**
```typescript
const kpi: KpiSummary = {
  totalSites: domains.length,
  avgScore: domains.filter(d => d.overallScore !== null).length > 0
    ? Math.round(domains.reduce((s, d) => s + (d.overallScore ?? 0), 0) / domains.filter(d => d.overallScore !== null).length)
    : null,
  totalCritical: domains.reduce((s, d) => s + d.criticalIssues, 0),
  creditBalance: teamInfo?.team.creditBalance ?? 0,
  scanningCount: domains.filter(d => isActiveStatus(d.pipelineStatus)).length,
};
```

**Page Layout — Rendered JSX:**

```
<head>
  Inter font preconnect + stylesheet links
</head>

<main style={{ minHeight:"100vh", background:BG, fontFamily:FONT_STACK }}>
  <Suspense><PaymentToast /></Suspense>

  <!-- Header -->
  <header class="hdr" style={{
    display:"flex", alignItems:"center", justifyContent:"space-between",
    padding:"14px 32px", background:CARD, borderBottom:`1px solid ${BORDER}`,
    position:"sticky", top:0, zIndex:100,
  }}>
    <div style={{fontWeight:700, fontSize:16, color:COPPER, letterSpacing:"2.5px"}}>
      FLOWBLINQ GEO
    </div>
    <div style={{display:"flex", alignItems:"center", gap:16}}>
      <span style={{fontSize:13, color:T2}}>{user.email}</span>
      <BuyCreditsButton credits={kpi.creditBalance} />
      <SignOutButton />
    </div>
  </header>

  <main class="main" style={{maxWidth:1200, margin:"0 auto", padding:"24px 32px 60px"}}>
    <!-- KPI Row -->
    <div class="kpi-row" style={{display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:16, marginBottom:24}}>
      KPI card 1: Total Sites
      KPI card 2: Avg GEO Score
      KPI card 3: Total Critical Issues
      KPI card 4: Credits Remaining
    </div>

    <!-- Actions Strip -->
    <div class="actions-strip" style={{display:"flex", alignItems:"center", gap:12, marginBottom:24}}>
      <a href="/audit" ...>+ Run new audit</a>
      <!-- Filter input is a DomainTableFilter client island (see §Client Islands) -->
    </div>

    <!-- Section title (HP-115) -->
    <h2 style={{fontSize:18, fontWeight:700, margin:"0 0 4px"}}>Your Audits</h2>
    <div style={{fontSize:13, color:T2, marginBottom:16}}>
      {domains.length} domain{domains.length!==1?"s":""} · sorted by score
    </div>

    <!-- Table -->
    <table class="ptable" style={{width:"100%", borderCollapse:"collapse"}}>
      <thead>
        Domain | GEO Score | Tier | Citations | Critical | Delta | Last Scan | Actions
      </thead>
      <tbody>
        {domains.map(row => <DomainTableRow key={row.siteId} row={row} />)}
      </tbody>
    </table>

    <!-- API Access -->
    {teamInfo && <ApiAccessSection teamId={teamInfo.team.id} />}
  </main>
</main>
```

**KPI Card specifications:**

```typescript
// Card 1 — Total Sites
{
  label: "Total Sites",
  value: kpi.totalSites.toString(),
  subtitle: kpi.scanningCount > 0
    ? `${kpi.scanningCount} scan${kpi.scanningCount>1?"s":""} in progress`
    : undefined,
  subtitleColor: COPPER,
}

// Card 2 — Avg GEO Score
{
  label: "Avg GEO Score",
  value: kpi.avgScore !== null ? kpi.avgScore.toString() : "—",
  subtitle: `across ${domains.filter(d=>d.overallScore!==null).length} domain${...}`,
}

// Card 3 — Total Critical Issues
{
  label: "Total Critical Issues",
  value: kpi.totalCritical.toString(),
  subtitle: kpi.totalCritical > 0 ? "Require attention" : "None found",
  subtitleColor: kpi.totalCritical > 0 ? RED : undefined,
}

// Card 4 — Credits Remaining (copper left border, 3px solid COPPER)
{
  label: "Credits Remaining",
  value: kpi.creditBalance.toString(),
  leftBorder: `3px solid ${COPPER}`,
  // "Buy more →" as copper-colored anchor to /api/checkout POST (via form) when balance < 10
  subtitle: kpi.creditBalance < 10 ? "Buy more →" : undefined,
  subtitleHref: kpi.creditBalance < 10 ? "/api/checkout" : undefined,
  subtitleMethod: "POST",  // rendered as <form method="POST"><button type="submit">Buy more →</button></form>
}
```

KPI card HTML structure:
```
<div style={{background:CARD, border:`1px solid ${BORDER}`, borderRadius:12, padding:"20px 24px",
  borderLeft: card.leftBorder || undefined}}>
  <div style={{fontSize:13, color:T2, marginBottom:8}}>{label}</div>
  <div style={{fontSize:32, fontWeight:700, color:TEXT}}>{value}</div>
  {subtitle && <div style={{fontSize:12, color:subtitleColor||T2, marginTop:4}}>{subtitle}</div>}
</div>
```

**Table header:**
```
<th>Domain</th>
<th>GEO Score</th>
<th>Tier</th>
<th>Citations</th>
<th>Critical</th>
<th>Delta</th>
<th>Last Scan</th>
<th>Actions</th>
```
`<th>` style: `{fontSize:11, fontWeight:600, color:T2, textAlign:"left", padding:"10px 12px", borderBottom:`1px solid ${BORDER}`, textTransform:"uppercase", letterSpacing:"0.05em"}`

**Tier badge colors:**
```typescript
const TIER_COLORS = {
  GOOD: { bg:"#e8f5e9", color:"#2e7d32" },
  FAIR: { bg:"#fff8e1", color:"#f57f17" },
  WEAK: { bg:"#fbe9e7", color:"#c62828" },
  POOR: { bg:"#fce4ec", color:"#b71c1c" },
};
```

**Progress bar in score column:**
- 60px wide, 6px height, border-radius 3px
- Background: `#e5e5ea`
- Fill: `GREEN` if score≥75, `ORANGE` if score≥50, `RED` if <50
- Width: `${score}%`

**Actions strip filter input:**
The filter input needs client-side JS. Implement as a minimal `"use client"` island `DashboardFilter.tsx` that:
- Renders an `<input placeholder="Filter domains...">`
- On change, hides/shows rows with `data-domain` attribute matching substring (case-insensitive)
- Uses `document.querySelectorAll('[data-domain]')` to filter table rows
- No state management framework needed

### File 2: `app/dashboard/RowActions.tsx` — NEW Client Island

```typescript
"use client";

interface RowActionsProps {
  siteId: string;
  accessToken: string | null;
  domain: string;
  initialPipelineStatus: string | null;
  onScanStart?: () => void; // callback to parent DomainTableRow
}
```

**State:**
```typescript
const [rerunTooltip, setRerunTooltip] = useState<string | null>(null);
const [citationTooltip, setCitationTooltip] = useState<string | null>(null);
```

**`handleRerunAudit()` implementation:**
```typescript
async function handleRerunAudit() {
  if (!accessToken) return;
  try {
    const res = await fetch(`/api/sites/${siteId}/regenerate?token=${accessToken}`, { method: "POST" });
    if (res.status === 202) {
      onScanStart?.();  // optimistic scan state in parent
    } else if (res.status === 409) {
      setRerunTooltip("Scan already in progress");
      setTimeout(() => setRerunTooltip(null), 3000);
    } else if (res.status === 402) {
      setRerunTooltip("Not enough credits");
      setTimeout(() => setRerunTooltip(null), 3000);
    }
  } catch {
    setRerunTooltip("Request failed");
    setTimeout(() => setRerunTooltip(null), 3000);
  }
}
```

**`handleRerunCitations()` implementation:**
Uses SSE. Initiates `POST /api/sites/${siteId}/citation-check?token=${accessToken}` and reads as stream. On complete event updates local state (if citation update callback is provided).

**Rendered layout:**
```
<div style={{display:"flex", alignItems:"center", gap:4}}>
  <!-- Button 1: Rerun Audit -->
  <div style={{position:"relative"}}>
    <button onClick={handleRerunAudit} title="Rerun Audit" style={...icon button styles...}>
      {/* circular-arrow SVG */}
    </button>
    {rerunTooltip && <div style={{...tooltip styles...}}>{rerunTooltip}</div>}
  </div>

  <!-- Button 2: Rerun Citations -->
  <button onClick={handleRerunCitations} title="Rerun Citations" style={...}>
    {/* @-arrow SVG */}
  </button>

  <!-- Separator -->
  <div style={{width:1, height:20, background:BORDER, margin:"0 4px"}} />

  <!-- Button 3: Download ZIP -->
  <a href={`/api/sites/${siteId}/download-report?token=${accessToken ?? ""}`}
     download title="Download ZIP" style={...}>
    {/* download SVG */}
  </a>

  <!-- Button 4: Download Report (disabled) -->
  <button disabled title="Coming soon" style={{...icon button styles..., opacity:0.4, cursor:"not-allowed"}}>
    {/* document SVG */}
  </button>
</div>
```

**SVG icon specs (from TS-061 §2.x):**
- All icons: 16×16px viewBox, `stroke="currentColor"`, `strokeWidth="1.5"`, `fill="none"`
- Rerun Audit (circular arrows): `M4 4 A6 6 0 1 1 4 10 M4 4 L4 8 L8 4` (simplified circular arrow)
- Download ZIP (download arrow): `M8 3v9 M5 9l3 3 3-3 M3 16h10`
- Document: `M6 2h8a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5l3-3z M6 2v3H3`

### File 3: `app/dashboard/DomainTableRow.tsx` — NEW Client Island

```typescript
"use client";

interface DomainTableRowProps {
  row: {
    id: string;
    domain: string;
    siteId: string;
    accessToken: string | null;
    pipelineStatus: string | null;
    overallScore: number | null;
    tier: "GOOD" | "FAIR" | "WEAK" | "POOR" | null;
    criticalIssues: number;
    delta: number | null;
    pageCount: number;
    citationRate: number | null;
    lastCrawlAt: string | null;
  };
}
```

**State:**
```typescript
const [liveStatus, setLiveStatus] = useState(row.pipelineStatus);
const [liveScore, setLiveScore] = useState(row.overallScore);
const [isOptimisticScan, setIsOptimisticScan] = useState(false);
```

**`isActiveStatus` check:** same as helper in page.tsx — `["discovery","crawling","researching","analyzing","generating","assembling"].includes(status ?? "")`

**Polling logic (when `liveStatus` is active):**
```typescript
useEffect(() => {
  if (!isActiveStatus(liveStatus) && !isOptimisticScan) return;
  const interval = setInterval(async () => {
    try {
      const res = await fetch(`/api/sites/${row.siteId}?token=${row.accessToken ?? ""}`);
      if (res.ok) {
        const data = await res.json() as { pipelineStatus: string; geoScorecard?: { overallScore?: number } };
        setLiveStatus(data.pipelineStatus);
        const sc = (data.geoScorecard as { overallScore?: number } | null)?.overallScore;
        if (sc !== undefined) setLiveScore(sc ?? null);
        if (!isActiveStatus(data.pipelineStatus)) {
          setIsOptimisticScan(false);
          router.refresh();  // refresh server component to update full row
        }
      }
    } catch { /* ignore */ }
  }, 3000);
  return () => clearInterval(interval);
}, [liveStatus, isOptimisticScan, row.siteId, row.accessToken, router]);
```

**Pipeline step mapping (ALL_STAGES — do NOT rename labels):**
```typescript
const ALL_STAGES = [
  { status: "discovery",   step: 1, label: "Discovering pages" },
  { status: "crawling",    step: 2, label: "Reading your content" },
  { status: "researching", step: 3, label: "Checking the landscape" },
  { status: "analyzing",   step: 4, label: "Running your AI audit" },
  { status: "generating",  step: 5, label: "Building your profile" },
  { status: "assembling",  step: 6, label: "Final checks" },
];
```

**Scanning row render:**
```
<tr style={{background:COPPER_BG, boxShadow:"inset 3px 0 0 #c2652a"}} data-domain={row.domain}>
  <!-- Domain cell -->
  <td>
    <div>{/* monogram square */}</div>
    <div>
      <div>{row.domain}</div>
      <div style={{color:COPPER, fontSize:11}}>{currentStage.label}</div>
    </div>
  </td>
  <!-- Score cell -->
  <td>
    {isNewSite ? "—" : <span style={{opacity:0.4}}>{liveScore}</span>}
  </td>
  <!-- Tier/Citations/Critical cells: dash for new site, 0.4 opacity for refresh -->
  ...
  <!-- Actions cell: pipeline status widget -->
  <td>
    <div>
      <span style={{color:COPPER}}>● STEP {currentStep} OF 6</span>
      <div>{/* 6 segment bars: green=done, pulsing orange=active, gray=pending */}</div>
      <div style={{fontSize:10, color:T2}}>{currentStage.label}</div>
    </div>
  </td>
</tr>
```

**isNewSite detection:** `row.overallScore === null` (HP-107).

**Normal row render:**
```
<tr style={{borderBottom:`1px solid ${BORDER}`}} data-domain={row.domain}>
  <td style={{padding:"12px 12px"}}>
    <!-- Domain column: monogram + domain name + page count -->
    <div style={{display:"flex", alignItems:"center", gap:10}}>
      <div style={{
        width:32, height:32, borderRadius:6, display:"flex", alignItems:"center",
        justifyContent:"center", fontSize:14, fontWeight:700, flexShrink:0,
        // background+color from domainMonogramColor(row.domain)
      }}>
        {row.domain[0].toUpperCase()}
      </div>
      <div>
        <a href={`/dashboard/domains/${row.siteId}`} style={{fontSize:14, fontWeight:600, color:TEXT, textDecoration:"none"}}>
          {row.domain}
        </a>
        <div style={{fontSize:11, color:T3}}>{row.pageCount} pages</div>
      </div>
    </div>
  </td>
  <td>
    {liveScore !== null ? (
      <div>
        <span style={{fontSize:16, fontWeight:700}}>{liveScore}</span>
        <div style={{width:60, height:6, borderRadius:3, background:"#e5e5ea", marginTop:4}}>
          <div style={{width:`${liveScore}%`, height:"100%", borderRadius:3,
            background: liveScore>=75?GREEN : liveScore>=50?ORANGE : RED}} />
        </div>
      </div>
    ) : "—"}
  </td>
  <td>
    {row.tier ? (
      <span style={{...TIER_COLORS[row.tier], borderRadius:100, padding:"2px 8px", fontSize:11, fontWeight:600}}>
        {row.tier}
      </span>
    ) : "—"}
  </td>
  <td>
    {row.citationRate !== null ? (
      <span>
        <span style={{color: row.citationRate>=75?GREEN : row.citationRate>=50?ORANGE : RED}}>●</span>
        {" "}{row.citationRate}%
      </span>
    ) : "—"}
  </td>
  <td style={{color: row.criticalIssues >= 5 ? RED : TEXT}}>
    {row.criticalIssues}
  </td>
  <td>
    {row.delta !== null ? (
      <span style={{color: row.delta>0 ? GREEN : row.delta<0 ? RED : T2}}>
        {row.delta>0 ? "+" : ""}{row.delta}
      </span>
    ) : "—"}
  </td>
  <td style={{fontSize:13, color:T2}}>
    {formatDashDate(row.lastCrawlAt)}
  </td>
  <td>
    <RowActions
      siteId={row.siteId}
      accessToken={row.accessToken}
      domain={row.domain}
      initialPipelineStatus={liveStatus}
      onScanStart={() => setIsOptimisticScan(true)}
    />
  </td>
</tr>
```

### File 4: `app/dashboard/HoverCard.tsx` — DELETE

Entire file deleted. No imports or references to it remain after page.tsx rebuild.

### File 5: `app/dashboard/DashboardFilter.tsx` — NEW Client Island (minimal)

```typescript
"use client";

export default function DashboardFilter() {
  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const query = e.target.value.toLowerCase();
    document.querySelectorAll<HTMLTableRowElement>("[data-domain]").forEach((row) => {
      const domain = row.dataset.domain?.toLowerCase() ?? "";
      row.style.display = domain.includes(query) ? "" : "none";
    });
  }
  return (
    <input
      type="text"
      placeholder="Filter domains..."
      onChange={handleChange}
      style={{
        border: `1px solid ${BORDER}`, borderRadius:8, padding:"8px 12px",
        fontSize:13, background:CARD, color:TEXT, outline:"none", width:220,
      }}
    />
  );
}
```

---

## c) Unit Test Plan

**Test file:** `geo/tests/unit/dashboard/page.test.ts`

Import: `{ deriveTier, deriveCriticalIssues, deriveDelta, derivePageCount, isActiveStatus, domainMonogramColor }` from `app/dashboard/page`

| ID | Function | Input | Expected Output |
|----|----------|-------|-----------------|
| U1 | `deriveTier` | score=75 | "GOOD" |
| U2 | `deriveTier` | score=74 | "FAIR" |
| U3 | `deriveTier` | score=50 | "FAIR" |
| U4 | `deriveTier` | score=49 | "WEAK" |
| U5 | `deriveTier` | score=25 | "WEAK" |
| U6 | `deriveTier` | score=24 | "POOR" |
| U7 | `deriveTier` | score=0 | "POOR" |
| U8 | `deriveTier` | null | null |
| U9 | `deriveCriticalIssues` | [{priority:"critical",score:80}] | 1 |
| U10 | `deriveCriticalIssues` | [{priority:"high",score:20}] | 1 (score<25) |
| U11 | `deriveCriticalIssues` | [{priority:"high",score:25}] | 0 (score not <25, priority not critical) |
| U12 | `deriveCriticalIssues` | null | 0 |
| U13 | `deriveCriticalIssues` | [] | 0 |
| U14 | `deriveDelta` | (60, {geoScorecard:{overallScore:50}}) | 10 |
| U15 | `deriveDelta` | (60, null) | null |
| U16 | `deriveDelta` | (null, {geoScorecard:{overallScore:50}}) | null |
| U17 | `deriveDelta` | (60, {geoScorecard:{}}) | null |
| U18 | `derivePageCount` | {pages:[1,2,3]} | 3 |
| U19 | `derivePageCount` | null | 0 |
| U20 | `derivePageCount` | {} | 0 |
| U21 | `isActiveStatus` | "crawling" | true |
| U22 | `isActiveStatus` | "complete" | false |
| U23 | `isActiveStatus` | null | false |
| U24 | `isActiveStatus` | "pending" | false |
| U25 | `domainMonogramColor` | "example.com" | deterministic (same call twice returns same value) |
| U26 | `domainMonogramColor` | "a.com" vs "b.com" | may differ (no assertion on specific color, just stable) |

**KPI derivation unit tests:**

| ID | Scenario | Expected |
|----|----------|---------|
| U27 | 2 domains with scores [60,80], avgScore | 70 |
| U28 | all null scores | avgScore=null |
| U29 | 1 scanning, 1 complete | scanningCount=1 |
| U30 | creditBalance=5, < 10 threshold | subtitle "Buy more →" rendered |

**Test file:** `geo/tests/unit/dashboard/RowActions.test.tsx`

Mock: `global.fetch` with `jest.fn()` / `vi.fn()`

| ID | Scenario | Expected |
|----|----------|---------|
| U31 | Renders 4 action buttons (rerun, citations, ZIP link, report disabled) | all present |
| U32 | Rerun Audit → fetch returns 202 | `onScanStart` callback called |
| U33 | Rerun Audit → fetch returns 409 | tooltip "Scan already in progress" shown |
| U34 | Rerun Audit → fetch returns 402 | tooltip "Not enough credits" shown |
| U35 | accessToken=null | rerun button click does nothing (early return) |
| U36 | Download ZIP href | includes `siteId` and `accessToken` |
| U37 | Download Report button | has `disabled` attribute |

**Test file:** `geo/tests/unit/dashboard/DomainTableRow.test.tsx`

| ID | Scenario | Expected |
|----|----------|---------|
| U38 | Normal row, all 8 columns present | renders without error |
| U39 | Normal row, overallScore=72 | score col shows "72" + orange bar |
| U40 | Normal row, tier=GOOD | badge background #e8f5e9 |
| U41 | Normal row, delta=+5 | green "+5" |
| U42 | Normal row, delta=-3 | red "-3" |
| U43 | Normal row, delta=null | "—" |
| U44 | Normal row, criticalIssues=5 | red color |
| U45 | Normal row, criticalIssues=4 | not red |
| U46 | Scanning row (pipelineStatus="crawling"), isNewSite=false | shows score at 0.4 opacity |
| U47 | Scanning row, isNewSite=true (overallScore=null) | score col shows "—" |
| U48 | Scanning row | pipeline status widget present |
| U49 | Poll fires on active status | fetch called after interval |
| U50 | Poll stops on status="complete" | clearInterval called |

---

## d) Integration Test Plan

**Test file:** `geo/tests/integration/dashboard/dashboard.test.ts`

Framework: Vitest + real Drizzle connection (test DB with seeded data)

| ID | Scenario | Expected |
|----|----------|---------|
| I1 | User with 2 domains, 1 scanning, 1 complete | page returns 200, both rows in HTML |
| I2 | Citation rate query with `inArray` | single query, not N+1 (verify via query count) |
| I3 | Domain sorted by score descending | higher score domain appears first |
| I4 | Domain with no overallScore | sorted to end (after scored domains) |
| I5 | creditBalance=5 | "Buy more →" link rendered in Credits KPI card |
| I6 | Empty domains (no team) | empty state div rendered |
| I7 | Unauthenticated user | redirect to `/auth/login?redirectTo=/dashboard` |
| I8 | citationMap correctly maps siteId→overallVisibility | citationRate in row matches DB value |
| I9 | 5 domains, 3 have citation scores | 2 domains show "—" in Citations col |
| I10 | domain with previousRunSnapshot | delta computed correctly |

---

## e) Profiling Requirements

- **Target:** Full server component render < 150ms
- **Measure:**
  - `[dashboard] domains=${N} ms=X` — domain+scorecard query
  - `[dashboard] citationRates=${N} unique=${M} ms=X` — citation batch query
- Both queries should complete in < 50ms each on a cold connection
- Profiling tool: `console.info` with `Date.now()` delta (already pattern in `app/sites/[id]/page.tsx`)
- If team has > 100 domains: add index on `team_domains.team_id` if missing; add index on `citation_check_scores.site_id` + `created_at` for the citation sort

---

## f) Load Test Plan

**Tool:** k6 or Artillery

| Scenario | Config | Pass Criteria |
|----------|--------|---------------|
| Baseline | 10 VU, 60s, authenticated session | p95 TTFB < 300ms |
| Normal load | 50 VU, 120s | p95 TTFB < 500ms |
| Spike | 200 VU, 30s burst | p99 < 2000ms, no 500 errors |
| Team with 50 domains | 20 VU | p95 < 800ms (2 DB queries stay bounded) |

Resource bounds: DB connection pool must not exhaust (max 10 connections per Supabase tier).

---

## g) Logging & Instrumentation

| Event | Level | Format |
|-------|-------|--------|
| Domain query | `info` | `[dashboard] userId=${userId} domains=${N} ms=${X}` |
| Citation query | `info` | `[dashboard] citationRates=${N} unique=${M} ms=${X}` |
| No team membership | `warn` | `[dashboard] userId=${userId} no_team` |
| Empty domain list | `info` | `[dashboard] teamId=${id} no_domains` |

Metrics to emit (if instrumentation layer exists):
- `dashboard.render_ms` — histogram of total server component time
- `dashboard.domains_count` — gauge

---

## h) Acceptance Criteria

All criteria carry over verbatim from TS-061 (AC-1 through AC-16):

**AC-1:** Dashboard renders at `/dashboard` for authenticated users with copper design system (variables match spec §1.1).
**AC-2:** Header shows logo ("FLOWBLINQ GEO" in copper, 16px, 700, 2.5px letter-spacing), user email, credits badge, sign out.
**AC-3:** 4 KPI cards with correct values. Total Sites subtitle "N scan in progress" in copper when scanning. Credits card has copper left border and "Buy more →" copper link when balance < 10.
**AC-4:** Table shows all team domains sorted by overallScore descending (nulls last).
**AC-5:** Each completed row shows all 8 columns. overallScore=null → "—" in score column.
**AC-6:** Tier badge uses correct color per tier (GOOD=#34c759 bg, FAIR=#ff9500 bg, WEAK=#ff3b30 bg, POOR=#ff2d55 bg).
**AC-7:** Delta: green for positive, red for negative, "—" for null.
**AC-8:** Critical issues count: red text if ≥ 5.
**AC-9:** Action icons always visible (not hover-only). Tooltips appear on error states.
**AC-10:** Download ZIP links to `/api/sites/:id/download-report?token=`.
**AC-11:** Scanning rows: warm tint background (`#fff7ed`) + copper left inset shadow.
**AC-12:** Pipeline status widget shows correct step (1–6) and segment coloring.
**AC-13:** Scanning rows poll every 3 seconds. Row updates to complete state on pipeline completion without full page reload.
**AC-14:** `PaymentToast` still renders after credit purchase.
**AC-15:** `ApiAccessSection` renders below table unchanged.
**AC-16:** Filter input filters rows client-side by domain name substring.

**Additional spec-level criteria:**
**AC-17:** `HoverCard.tsx` file is deleted. No remaining imports of it anywhere.
**AC-18:** Inter font loaded via Google Fonts preconnect in `<head>`.
**AC-19:** `domainMonogramColor()` is deterministic — same domain always produces same colors across renders.
**AC-20:** Citation rate query uses `inArray` (single query), not a per-domain loop.
**AC-21:** `geoSites.accessToken` is fetched in the domain query and passed to `RowActions` as a prop.
**AC-22:** `DomainTableRow` uses `data-domain` attribute on `<tr>` to enable `DashboardFilter` client-side filtering.

---

## ScriptDev / DaVinci Notes

1. **Font loading:** Add Inter preconnect tags at top of `<head>` in `page.tsx`. The `next/font/google` approach is also acceptable — use whichever pattern the project already uses (check `app/layout.tsx`).

2. **HoverCard deletion:** `git rm app/dashboard/HoverCard.tsx` — ensure no other file imports it before deleting.

3. **accessToken exposure:** `geoSites.accessToken` is sensitive but is being passed to a `"use client"` island that already uses it to call the API. This is consistent with the existing pattern in `SitePageClient.tsx`. The token is site-specific, not account-level.

4. **DomainTableRow import loop:** `DomainTableRow.tsx` imports `RowActions.tsx`. `RowActions.tsx` does not import back. No circular dependency.

5. **router.refresh() after scan completes:** The `DomainTableRow` island calls `router.refresh()` after polling detects completion. This re-runs the server component and updates all table data. Ensure the `useRouter` import is from `next/navigation`.

6. **`isNewSite` detection (HP-107):** `overallScore === null` at the time the scan starts. Use `row.overallScore` (initial server-rendered value) not `liveScore` (which may update during polling) to determine new vs. refresh scan type. Store this as a `const isNewSite = row.overallScore === null` once on component mount.

7. **Empty state:** Preserve the existing empty state from `page.tsx` (the centered "No audits yet" card) — just update it to use the new color constants and font.
