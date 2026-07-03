# ES-062 — Site Report Page Rebuild

**Spec ID:** ES-062
**Date:** 2026-03-25
**Author:** SpecMaster (Agent 2)
**Source TS:** TS-062-site-report-rebuild.md
**Implementor:** DaVinci (Agent 10)
**Status:** Ready
**Prerequisite:** ES-061 must be merged before implementing ES-062 (shared CSS variable naming)

---

## a) Overview

### What
Full rebuild of the site report page from a single-file monolith (`ResultsDashboard.tsx`, 2,234 lines) to a tab-based Apple HIG layout (`SitePageClient.tsx`). `ResultsDashboard.tsx` is deleted. `app/sites/[id]/page.tsx` is extended with `allTeamDomains` query and additional site fields. Six new tabs: Overview, Scorecard, Recommendations, Pages, History, Setup.

### Reference
- **Source TS:** `.agents/specs/technical/TS-062-site-report-rebuild.md`
- **Design authority:** `geo/docs/frontend/FlowBlinqGEO-ImplementationSpec.md`
- **Visual reference:** `geo/docs/frontend/GEODashboardRedesignMockup-FINAL.html`

### Current Implementation State
- `app/sites/[id]/page.tsx` (177 lines): server component. Fetches site, tier, credits, lastCitationCheck, citationHistory. Missing: `discoveredCompetitors`, `brandKeywords`, `extractedCategories`, `perPageResults`, `allTeamDomains`.
- `app/sites/[id]/SitePageClient.tsx` (339 lines): `"use client"`. Currently delegates to `ResultsDashboard` when complete; shows pipeline progress screen while scanning; has email gate. **FULL REPLACE.** All existing logic to migrate (ALL_STAGES, polling, email gate).
- `app/sites/[id]/ResultsDashboard.tsx` (2,234 lines): `"use client"` monolith. **DELETE.** Exports `SiteData`, `GeoScore`, `GeoScorecard`, `RankedRec`, `DiffData`, `ChangeLogEntry`, `SchemaBlock` — these types must be preserved.
- Existing components that survive unchanged: `CitationMonitor`, `CitationAnalytics`, `CitationHistory`, `DimensionalIntelligence`, `UpgradeModal`.

---

## b) Implementation Requirements

### Critical: Type Migration from ResultsDashboard.tsx

`ResultsDashboard.tsx` currently exports these types that are imported by `page.tsx` and `SitePageClient.tsx`:
```typescript
export interface GeoScore { ... }
export interface GeoScorecard { ... }
export interface SchemaBlock { ... }
export interface RankedRec { ... }
export interface DiffData { ... }
export interface SiteData { ... }
export type ChangeLogEntry = ...
```

**Before deleting `ResultsDashboard.tsx`:** Move all these type exports to a new file `app/sites/[id]/types.ts`. Update all imports in `page.tsx` and `SitePageClient.tsx` to import from `./types`.

**New `app/sites/[id]/types.ts`:**
```typescript
// All types from ResultsDashboard.tsx, unchanged.
// Also add new types needed by the rebuild:

export type TabId = "overview" | "scorecard" | "recommendations" | "pages" | "history" | "setup";

export interface TeamDomainSwitcherEntry {
  id: string;
  domain: string;
  geoScorecard: unknown;  // for overallScore display
  crawlData: unknown;      // for pages.length subtitle
}

// Extended SiteData — add missing fields to existing interface
// (add these fields to the existing SiteData interface definition)
export interface SiteDataExtended extends SiteData {
  discoveredCompetitors?: import("@/lib/types/citation").DiscoveredCompetitor[];
  brandKeywords?: unknown;
  extractedCategories?: unknown;
  perPageResults?: Array<{ url: string; fixes?: unknown[] }> | null;
}
```

### File 1: `app/sites/[id]/page.tsx` — Extend

**Add imports:**
```typescript
import { geoSites, teams, citationCheckScores, teamDomains } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { type SiteData, type RankedRec } from "./types";  // updated import path
```

**Remove import:** `import { type RankedRec } from "./ResultsDashboard"` → import from `./types` instead.

**Add `allTeamDomains` query (after existing tier/credits fetch):**
```typescript
const allTeamDomains = site.teamId
  ? await db
      .select({
        id: geoSites.id,
        domain: geoSites.domain,
        geoScorecard: geoSites.geoScorecard,
        crawlData: geoSites.crawlData,
      })
      .from(geoSites)
      .where(eq(geoSites.teamId, site.teamId))
  : [];
```

**Add to `safeSite` object:**
```typescript
// Add inside the safeSite object (paid tier gates where applicable):
discoveredCompetitors: (site.discoveredCompetitors ?? []) as import("@/lib/types/citation").DiscoveredCompetitor[],
brandKeywords: site.brandKeywords ?? null,
extractedCategories: site.extractedCategories ?? null,
perPageResults: tier === "paid" ? (site.perPageResults ?? null) : null,
// perPageFixes already present — keep unchanged
```

**Update `SitePageClient` call — add new props:**
```tsx
<SitePageClient
  site={safeSite}
  siteId={id}
  initialToken={token}
  allTeamDomains={allTeamDomains}
  lastCitationCheck={lastCitationCheck ?? null}
  citationHistory={citationHistory}
  credits={credits}
  userEmail={/* not currently available in page.tsx — pass undefined */}
/>
```

**Remove the standalone `CitationMonitor` section** from `page.tsx` — it is now rendered inside `SitePageClient` within the Overview tab:
```tsx
// DELETE this entire block from page.tsx:
{showCitationMonitor && (
  <section ...>
    <CitationMonitor ... />
  </section>
)}
```

### File 2: `app/sites/[id]/SitePageClient.tsx` — Full Rebuild

**"use client"** — entire file is replaced.

**Preserved from existing file (do not change logic, only location):**

1. `ALL_STAGES` array — copy verbatim (6 stages: discovery/crawling/researching/analyzing/generating/assembling). DaVinci: do NOT rename any label (HP-112).

2. Token loading logic (lines 95–115) — copy exactly:
   ```typescript
   // sessionStorage → initialSite.token → URL hash fragment
   const stored = sessionStorage.getItem(`geo-token-${siteId}`);
   if (stored) { setToken(stored); }
   else if (initialSite?.token) { sessionStorage.setItem(...); setToken(initialSite.token); }
   else if (window.location.hash) { /* read st + sid from hash */ }
   setTokenReady(true);
   ```

3. Email gate form — copy exactly (lines 189–233). Display when `tokenReady && !token`.

4. Polling logic — copy exactly (lines 163–167):
   ```typescript
   const interval = setInterval(poll, 3000);
   // Stop when isComplete || isFailed || isIdle || !token
   ```

5. `handleRetry()` → rename to `handleRefreshScore()` but keep same fetch call: `POST /api/sites/${siteId}/regenerate` with `Authorization: Bearer ${token}`.

**New `SitePageClientProps` interface:**
```typescript
interface SitePageClientProps {
  site: SiteData | null;
  siteId: string;
  initialToken?: string;
  allTeamDomains: TeamDomainSwitcherEntry[];
  lastCitationCheck: import("@/lib/db/schema").CitationCheckScore | null;
  citationHistory: import("@/lib/db/schema").CitationCheckScore[];
  credits: number;
  userEmail?: string;
}
```

**State declarations:**
```typescript
const [site, setSite] = useState<SiteData | null>(initialSite);
const [token, setToken] = useState<string | null>(null);
const [tokenReady, setTokenReady] = useState(false);
const [retrying, setRetrying] = useState(false);

// Tab state
const [activeTab, setActiveTab] = useState<TabId>("overview");

// Domain switcher
const [switcherOpen, setSwitcherOpen] = useState(false);
const [switcherSearch, setSwitcherSearch] = useState("");

// Action rail
const [refreshError, setRefreshError] = useState<string | null>(null);
const [citationScanActive, setCitationScanActive] = useState(false);
const [competitorScanActive, setCompetitorScanActive] = useState(false);
const [discoveredCompetitors, setDiscoveredCompetitors] = useState<DiscoveredCompetitor[]>(
  (initialSite as SiteDataExtended)?.discoveredCompetitors ?? []
);

// Audit bar height CSS variable
const auditBarRef = useRef<HTMLDivElement | null>(null);
```

**CSS variable management for audit bar height (HP-108):**
```typescript
// When AuditStatusBar mounts (scan active):
useEffect(() => {
  if (isActiveStatus(site?.pipelineStatus)) {
    document.documentElement.style.setProperty("--audit-bar-height", "52px");
  } else {
    document.documentElement.style.setProperty("--audit-bar-height", "0px");
  }
}, [site?.pipelineStatus]);
```

`isActiveStatus`: same logic as ES-061 — checks if status is one of the 6 active pipeline states.

**`handleMapCompetitors()` — SSE consumer:**
```typescript
async function handleMapCompetitors() {
  if (!token || competitorScanActive) return;
  setCitationScanActive... // no, set competitorScanActive
  setCompetitorScanActive(true);
  try {
    const res = await fetch(`/api/sites/${siteId}/competitor-discovery?token=${token}`, {
      method: "POST",
    });
    if (!res.ok || !res.body) { setCompetitorScanActive(false); return; }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const evt = JSON.parse(line.slice(6)) as {
            type: string;
            competitors?: DiscoveredCompetitor[];
            creditsUsed?: number;
          };
          if (evt.type === "complete" && evt.competitors) {
            setDiscoveredCompetitors(evt.competitors);
            setSite((prev) => prev
              ? { ...prev, credits: prev.credits - (evt.creditsUsed ?? 2) }
              : prev
            );
          }
        } catch { /* ignore malformed events */ }
      }
    }
  } finally {
    setCompetitorScanActive(false);
  }
}
```

**`handleScanCitations()` — invoke via CitationMonitor callback:**
```typescript
const citationMonitorOnScanStart = useRef<(() => void) | null>(null);

function handleScanCitations() {
  citationMonitorOnScanStart.current?.();
}
```
Pass `onScanStart` prop to `<CitationMonitor onScanStart={(fn) => { citationMonitorOnScanStart.current = fn; }} ...>`.

Note: `CitationMonitor` must be updated to accept an `onScanStart` prop that receives a trigger function. If CitationMonitor does not currently support this prop, DaVinci must add it (AC-10b).

**Top-level rendered structure:**
```tsx
<div style={{ fontFamily: FONT_STACK, background: BG, minHeight: "100vh", position: "relative" }}>
  {/* Inter font */}
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />

  {/* Header */}
  <Header />

  {/* Audit Status Bar (conditional) */}
  {isActiveStatus(site?.pipelineStatus) && <AuditStatusBar />}

  {/* Tab Bar */}
  <TabBar />

  {/* Domain Switcher (conditional) */}
  {switcherOpen && <DomainSwitcher />}

  {/* Action Rail */}
  <ActionRail />

  {/* Main content — left-padded for rail */}
  <main style={{ paddingLeft: 80, maxWidth: 1200, margin: "0 auto", padding: "24px 24px 60px 80px" }}>
    <StatsRow />
    <TabContent />
  </main>
</div>
```

**Header — Apple HIG Three-Zone Toolbar:**
```tsx
<header style={{
  position: "sticky", top: 0, zIndex: 100,
  height: 52, background: CARD, borderBottom: `1px solid ${BORDER}`,
  display: "flex", alignItems: "center", padding: "0 20px",
}}>
  {/* Leading zone */}
  <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
    <button onClick={() => router.push("/dashboard")} style={{ /* chevron button */ }}>
      {/* ‹ chevron SVG 22px weight 300 T2 */}
    </button>
    <button onClick={() => setSwitcherOpen(!switcherOpen)} style={{ /* domain name button */ }}>
      <span style={{ fontSize: 15, fontWeight: 600, color: TEXT }}>{site?.domain}</span>
      <span style={{ color: T2 }}>▾</span>
    </button>
  </div>

  {/* Center zone — absolutely centered */}
  <div style={{ position: "absolute", left: "50%", transform: "translateX(-50%)" }}>
    <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "3px", color: COPPER }}>
      FLOWBLINQ GEO
    </span>
  </div>

  {/* Trailing zone */}
  <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, justifyContent: "flex-end" }}>
    <BuyCreditsButton credits={site?.credits ?? credits} />
    <SignOutButton />
  </div>
</header>
```

Note: `BuyCreditsButton` and `SignOutButton` must be imported from `../../dashboard/BuyCreditsButton` and `../../dashboard/SignOutButton` (they are reused across routes).

**Domain Switcher Dropdown:**
```tsx
// Positioned below header leading zone
<div style={{
  position: "fixed", top: 52, left: 20, zIndex: 90,
  background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12,
  width: 280, maxHeight: 400, overflowY: "auto",
  boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
}}>
  <input
    placeholder="Search domains..."
    value={switcherSearch}
    onChange={(e) => setSwitcherSearch(e.target.value)}
    style={{ /* search input */ }}
    autoFocus
  />
  {allTeamDomains
    .filter(d => d.domain.toLowerCase().includes(switcherSearch.toLowerCase()))
    .map(d => {
      const sc = (d.geoScorecard as { overallScore?: number } | null)?.overallScore;
      const pages = (d.crawlData as { pages?: unknown[] } | null)?.pages?.length ?? 0;
      return (
        <a
          key={d.id}
          href={`/dashboard/domains/${d.id}`}
          style={{ display: "flex", justifyContent: "space-between", padding: "10px 16px", textDecoration: "none" }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 500, color: TEXT }}>{d.domain}</div>
            <div style={{ fontSize: 11, color: T3 }}>{pages} pages</div>
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: sc != null ? TEXT : T3 }}>
            {sc ?? "–"}
          </div>
        </a>
      );
    })}
</div>
```

**Audit Status Bar:**
```tsx
<div style={{
  position: "sticky", top: 52, zIndex: 90, height: 52,
  background: "linear-gradient(135deg, #fffbf5, #fff7ed)",
  borderBottom: "1px solid #f0e0d0",
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "0 24px",
}}>
  {/* Left: scan indicator */}
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <span style={{ color: COPPER }}>●</span>
    <span style={{ fontSize: 13, fontWeight: 500 }}>
      {liveScore !== null ? "Refreshing audit" : "Running audit"}
    </span>
    <span style={{ fontSize: 12, color: T2 }}>
      {site?.crawlData ? `${(site.crawlData as { pages?: unknown[] }).pages?.length ?? 0} pages` : ""}
    </span>
  </div>

  {/* Center: numbered step circles */}
  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
    {ALL_STAGES.map((stage, i) => {
      const isDone = i < currentIndex;
      const isActive = i === currentIndex;
      return (
        <React.Fragment key={stage.status}>
          <div style={{
            width: 24, height: 24, borderRadius: "50%",
            background: isDone ? GREEN : isActive ? COPPER : "#e5e5ea",
            color: isDone || isActive ? "#fff" : T3,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 600,
          }}>
            {i + 1}
          </div>
          {i < 5 && <div style={{ width: 12, height: 1, background: isDone ? GREEN : "#e5e5ea" }} />}
        </React.Fragment>
      );
    })}
  </div>

  {/* Right: progress bar */}
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <div style={{ width: 80, height: 6, background: "#e5e5ea", borderRadius: 3 }}>
      <div style={{
        width: `${Math.round((currentIndex / 6) * 100)}%`,
        height: "100%", background: COPPER, borderRadius: 3,
      }} />
    </div>
    <span style={{ fontSize: 12, color: T2 }}>
      {Math.round((currentIndex / 6) * 100)}%
    </span>
  </div>
</div>
```

**Tab Bar:**
```tsx
const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "scorecard", label: "Scorecard" },
  { id: "recommendations", label: "Recommendations" },
  { id: "pages", label: "Pages" },
  { id: "history", label: "History" },
  { id: "setup", label: "Setup" },
];

<nav style={{
  position: "sticky",
  top: "calc(52px + var(--audit-bar-height, 0px))",  // HP-108
  zIndex: 80, background: CARD, borderBottom: `1px solid ${BORDER}`,
  display: "flex", padding: "0 24px",
}}>
  {TABS.map(tab => (
    <button
      key={tab.id}
      onClick={() => setActiveTab(tab.id)}
      style={{
        padding: "14px 16px", fontSize: 14, background: "none", border: "none",
        cursor: "pointer",
        color: activeTab === tab.id ? COPPER : T2,
        fontWeight: activeTab === tab.id ? 600 : 400,
        borderBottom: activeTab === tab.id ? `2px solid ${COPPER}` : "2px solid transparent",
      }}
    >
      {tab.label}
    </button>
  ))}
</nav>
```

**Left Action Rail:**
```tsx
const RAIL_BUTTONS = [
  {
    id: "refresh",
    label: "Refresh Score",
    iconBg: "#e8f5e9",
    iconColor: GREEN,
    creditBadge: null,
    onClick: handleRefreshScore,
    disabled: false,
    tooltip: refreshError,  // shows error tooltip on 402
  },
  {
    id: "citations",
    label: "Scan Citations",
    iconBg: "#ede7f6",
    iconColor: "#5856d6",
    creditBadge: "5cr",
    onClick: handleScanCitations,
    disabled: citationScanActive,
  },
  {
    id: "competitors",
    label: "Map Competitors",
    iconBg: "#fff3e0",
    iconColor: ORANGE,
    creditBadge: "2cr",
    onClick: handleMapCompetitors,
    disabled: competitorScanActive,
  },
  null,  // separator
  {
    id: "download-zip",
    label: "Download ZIP",
    iconBg: "#e3f2fd",
    iconColor: "#007aff",
    creditBadge: null,
    href: `/api/sites/${siteId}/download-report?token=${token ?? ""}`,
  },
  {
    id: "download-report",
    label: "Download Report",
    iconBg: "#f5f5f7",  // HP-109: neutral gray, NOT pink
    iconColor: T3,
    creditBadge: null,
    disabled: true,
    tooltip: "Coming soon",
  },
];

<div style={{
  position: "fixed", top: "50%", left: 0,
  transform: "translateY(-50%)",
  width: 78, zIndex: 80,
  display: "flex", flexDirection: "column", alignItems: "center",
  gap: 8, padding: "12px 0",
  background: CARD, borderRight: `1px solid ${BORDER}`,
}}>
  {RAIL_BUTTONS.map((btn, i) => {
    if (btn === null) return (
      <div key={`sep-${i}`} style={{ width: 40, height: 1, background: BORDER }} />
    );
    const inner = (
      <div style={{ textAlign: "center", position: "relative" }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: btn.iconBg, color: btn.iconColor,
          display: "flex", alignItems: "center", justifyContent: "center",
          margin: "0 auto",
          opacity: btn.disabled ? 0.4 : 1,
        }}>
          {/* Icon SVG */}
        </div>
        <div style={{ fontSize: 10, color: T2, marginTop: 4, lineHeight: 1.2 }}>{btn.label}</div>
        {btn.creditBadge && (
          <div style={{
            fontSize: 9, background: COPPER_BG, color: COPPER,
            borderRadius: 100, padding: "1px 5px", marginTop: 2,
          }}>
            {btn.creditBadge}
          </div>
        )}
        {btn.tooltip && (
          <div style={{ /* tooltip styles */ }}>{btn.tooltip}</div>
        )}
      </div>
    );
    if (btn.href) {
      return <a key={btn.id} href={btn.href} download style={{ textDecoration: "none" }}>{inner}</a>;
    }
    return (
      <button
        key={btn.id}
        onClick={btn.onClick}
        disabled={btn.disabled}
        style={{ background: "none", border: "none", cursor: btn.disabled ? "not-allowed" : "pointer", padding: 0 }}
      >
        {inner}
      </button>
    );
  })}
</div>
```

**Refresh Score 402 handling:**
```typescript
async function handleRefreshScore() {
  if (!token || retrying) return;
  setRetrying(true);
  setRefreshError(null);
  try {
    const res = await fetch(`/api/sites/${siteId}/regenerate?token=${token}`, {
      method: "POST",
    });
    if (res.status === 202) {
      setSite((prev) => prev ? { ...prev, pipelineStatus: "queued" } : prev);
    } else if (res.status === 402) {
      setRefreshError("Not enough credits");
      setTimeout(() => setRefreshError(null), 4000);
    }
  } catch { /* ignore */ } finally { setRetrying(false); }
}
```

**Stats Row:**
```tsx
const scorecard = site?.geoScorecard as GeoScorecard | null;
const qaCount = (scorecard?.pillars ?? []).reduce((s, p) => s + (p.findings ? 1 : 0), 0);
const pillarCount = scorecard?.pillars?.length ?? 0;
const criticalCount = (scorecard?.pillars ?? []).filter(p => (p.score ?? 100) < 25 || p.priority === "critical").length;
const pageCount = (site?.crawlData as { pages?: unknown[] } | null)?.pages?.length ?? 0;

<div style={{ display: "flex", gap: 16, fontSize: 13, color: T2, padding: "16px 0", flexWrap: "wrap" }}>
  <span><b style={{ color: TEXT }}>{pageCount}</b> pages crawled</span>
  <span>·</span>
  <span><b style={{ color: TEXT }}>{pillarCount}</b> pillars</span>
  <span>·</span>
  <span><b style={{ color: TEXT }}>{criticalCount}</b> critical issues</span>
  <span>·</span>
  <span>Last scanned <b style={{ color: TEXT }}>{formatDate(site?.lastCrawlAt)}</b></span>
  {isActiveStatus(site?.pipelineStatus) && (
    <span style={{ color: COPPER }}>· Scores will update when scan completes</span>
  )}
</div>
```

### Tab Content Specs

**Overview tab** (8 sections in order):

1. **KPI cards row (5 cards):**
```
AI Visibility % | GEO Audit Score | Est. After Fixes | Citation Rate | Citation Quality
```
   - AI Visibility: `lastCitationCheck?.overallVisibility ?? null` (show as "N%")
   - GEO Audit Score: `scorecard?.overallScore ?? null`
   - Est. After Fixes: sum of top-3 `rankedRecommendations[].estimatedBoost` as numbers + currentScore, capped at 100. If `estimatedBoost` is a string (e.g. "+5"), parse the number. If parsing fails, show "~+15 pts" fallback.
   - Citation Rate: same as AI Visibility
   - Citation Quality: `lastCitationCheck?.citationQualityScore ?? null`

2. **Competitor chips:**
```tsx
<div style={{ display: "flex", gap: 8, overflowX: "auto", padding: "8px 0" }}>
  {discoveredCompetitors.length > 0
    ? discoveredCompetitors.map((c) => (
        <span key={c.domain} style={{
          background: BG, border: `1px solid ${BORDER}`, borderRadius: 100,
          padding: "4px 12px", fontSize: 12, color: T2, whiteSpace: "nowrap",
        }}>
          {c.domain}
        </span>
      ))
    : <span style={{ color: T2, fontSize: 13 }}>No competitors mapped yet — use Map Competitors in the action rail.</span>
  }
</div>
```

3. **Score sparkline:** Simple inline sparkline from `citationHistory`. Use `<CitationHistory>` component's sparkline variant if available, otherwise render a minimal inline SVG line chart from `citationHistory.map(h => h.overallVisibility)`. Max 10 points, 200×40px.

4. **CitationMonitor:** Full component render.
```tsx
<CitationMonitor
  siteId={siteId}
  accessToken={token ?? ""}
  domain={site?.domain ?? ""}
  lastCheck={lastCitationCheck}
  history={citationHistory}
  discoveredCompetitors={discoveredCompetitors}
  citationNarrative={(site as SiteData & { citationNarrative?: string })?.citationNarrative ?? null}
  onScanStart={(fn) => { citationMonitorOnScanStart.current = fn; }}
/>
```

5. **DimensionalIntelligence:**
```tsx
<DimensionalIntelligence
  geoScorecard={site?.geoScorecard}
  lastCitationCheck={lastCitationCheck}
/>
```
Note: Check actual prop interface in `app/components/dimensional-intelligence.tsx` before implementing — use exact prop names.

6. **CitationAnalytics:**
```tsx
<CitationAnalytics
  lastCheck={lastCitationCheck}
  discoveredCompetitors={discoveredCompetitors}
/>
```
Note: Check actual prop interface in `app/components/citation-analytics.tsx` before implementing.

7. **Critical Issues table:**
```tsx
const criticalPillars = (scorecard?.pillars ?? []).filter(
  p => (p.score ?? 100) < 25 || p.priority === "critical"
);
// Table: Pillar | Score | Top Finding
```

8. **Top Recommendations preview (3 items):**
```tsx
const top3 = (site?.rankedRecommendations ?? []).slice(0, 3);
// Each: priority badge + pillar + title
// "View all →" button sets activeTab("recommendations")
```

**Scorecard tab:**

Severity filter (HP-106 — dynamic, not static):
```typescript
// Determine present tiers:
const tierCounts = { Poor: 0, Weak: 0, Fair: 0, Good: 0 };
for (const p of pillars) {
  const score = p.score ?? 0;
  if (score < 25) tierCounts.Poor++;
  else if (score < 50) tierCounts.Weak++;
  else if (score < 75) tierCounts.Fair++;
  else tierCounts.Good++;
}
// Show buttons only for tiers with count > 0, plus "All"
// Order: All | Poor | Weak | Fair | Good
const [tierFilter, setTierFilter] = useState<"All" | "Poor" | "Weak" | "Fair" | "Good">("All");
```

Pillar row:
```tsx
{filteredPillars.map(p => (
  <div key={p.pillar} style={{ borderBottom: `1px solid ${BORDER}`, padding: "16px 0" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{p.pillarName}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* severity badge */}
        <span style={{ fontSize: 11, ...severityStyle(p) }}>
          {scoreTier(p.score)}
        </span>
        {/* score */}
        <span style={{ fontSize: 16, fontWeight: 700 }}>{p.score}</span>
        {/* 60px bar */}
        <div style={{ width: 60, height: 6, background: "#e5e5ea", borderRadius: 3 }}>
          <div style={{ width: `${p.score}%`, height: "100%", borderRadius: 3, background: scoreColor(p.score) }} />
        </div>
      </div>
    </div>
    <div style={{ fontSize: 12, color: T2, marginTop: 6 }}>{p.findings}</div>
  </div>
))}
```

**Recommendations tab:**

```typescript
const sorted = [...(site?.rankedRecommendations ?? [])].sort((a, b) => {
  const order = { HIGH: 0, high: 0, MED: 1, med: 1, LOW: 2, low: 2 };
  return (order[a.priority as keyof typeof order] ?? 3) - (order[b.priority as keyof typeof order] ?? 3);
});
const [expanded, setExpanded] = useState<Set<number>>(new Set());
```

Priority badge colors: HIGH=`{bg:"#ffebee",color:"#c62828"}`, MED=`{bg:"#fff8e1",color:"#f57f17"}`, LOW=`{bg:"#f5f5f5",color:T2}`

Expand/collapse toggle:
```tsx
<button onClick={() => setExpanded(expanded.size ? new Set() : new Set(sorted.map((_,i)=>i)))}>
  {expanded.size ? "Collapse all" : "Expand all"}
</button>
```

**Pages tab:**

```typescript
const [pageFilter, setPageFilter] = useState<"All" | "good" | "needs_work" | "poor">("All");
const [pageSearch, setPageSearch] = useState("");
const [pageCursor, setPageCursor] = useState(0);
const PAGE_SIZE = 25;

const allPages = (site?.perPageResults ?? []) as Array<{
  url: string;
  status?: string;
  fixes?: unknown[];
}>;

const filtered = allPages.filter(p => {
  const matchSearch = p.url.toLowerCase().includes(pageSearch.toLowerCase());
  const matchFilter = pageFilter === "All" || p.status === pageFilter;
  return matchSearch && matchFilter;
});

const paged = filtered.slice(pageCursor, pageCursor + PAGE_SIZE);
```

Status filter (HP-116):
```tsx
{/* Above search input */}
<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
  {(["All", "good", "needs_work", "poor"] as const).map(f => (
    <button
      key={f}
      onClick={() => { setPageFilter(f); setPageCursor(0); }}
      style={{
        background: "none", border: "none", cursor: "pointer",
        fontSize: 13, fontWeight: pageFilter === f ? 600 : 400,
        color: pageFilter === f ? COPPER : T2,
        borderBottom: pageFilter === f ? `2px solid ${COPPER}` : "2px solid transparent",
        padding: "4px 8px",
      }}
    >
      {f === "needs_work" ? "Needs Work" : f.charAt(0).toUpperCase() + f.slice(1)}
    </button>
  ))}
</div>
```

Status badge colors: good=`{bg:"#e8f5e9",color:"#2e7d32"}`, needs_work=`{bg:"#fff8e1",color:"#f57f17"}`, poor=`{bg:"#ffebee",color:"#c62828"}`

**History tab:**
```tsx
<>
  <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
    <button onClick={handleRefreshScore} style={{ /* same style as action rail button */ }}>
      Refresh Score
    </button>
  </div>
  <CitationHistory
    siteId={siteId}
    accessToken={token ?? ""}
    history={citationHistory}
  />
</>
```
Note: Check actual prop interface in `app/components/citation-history.tsx` before implementing.

**Setup tab:**
```tsx
const AI_FILES = [
  { label: "llms.txt",      field: "generatedLlmsTxt",      slug: "llms" },
  { label: "llms-full.txt", field: "generatedLlmsFullTxt",  slug: "llms-full" },
  { label: "business.json", field: "generatedBusinessJson", slug: "business" },
  { label: "schema.json",   field: "generatedSchemaBlocks", slug: "schema" },
  { label: "urls.txt",      field: null,                    slug: "urls" },
];

// AI Files section
{AI_FILES.map(f => {
  const exists = f.field ? !!(site as unknown as Record<string, unknown>)?.[f.field] : true;
  return (
    <div key={f.slug} style={{ display:"flex", justifyContent:"space-between", padding:"10px 0", borderBottom:`1px solid ${BORDER}` }}>
      <span style={{ fontSize:13, fontWeight:500 }}>{f.label}</span>
      <div style={{ display:"flex", gap:12, alignItems:"center" }}>
        <a href={`/api/serve/${site?.slug ?? siteId}/${f.slug}`} target="_blank" rel="noreferrer"
           style={{ fontSize:12, color:"#007aff" }}>
          View ↗
        </a>
        <span style={{ color: exists ? GREEN : ORANGE, fontSize:12 }}>
          {exists ? "✓ Ready" : "⚠ Not generated"}
        </span>
      </div>
    </div>
  );
})}

// Domain Verification section
{site?.domainVerified ? (
  <div style={{ color: GREEN, fontSize:13 }}>✓ Domain verified</div>
) : (
  <div>
    <p style={{ fontSize:13, color:T2 }}>Add this DNS TXT record to verify your domain:</p>
    <code style={{ background:BG, padding:"8px 12px", borderRadius:6, fontSize:12 }}>
      {site?.verifyToken ?? "Loading..."}
    </code>
    <button onClick={async () => {
      await fetch(`/api/sites/${siteId}/verify-domain`, { method:"POST", headers:{ Authorization:`Bearer ${token}` } });
      router.refresh();
    }} style={{ /* button styles */ }}>
      Verify Domain
    </button>
  </div>
)}
```

### File 3: `app/sites/[id]/ResultsDashboard.tsx` — DELETE

Before deletion, confirm:
1. All type exports have been moved to `types.ts`
2. No other file outside `app/sites/[id]/` imports from this file
3. `app/sites/[id]/page.tsx` no longer imports `RankedRec` from `./ResultsDashboard`
4. `SitePageClient.tsx` no longer imports `SiteData` from `./ResultsDashboard`

Execute: `git rm app/sites/[id]/ResultsDashboard.tsx`

### File 4: `app/sites/[id]/types.ts` — NEW

Contains all type definitions moved from `ResultsDashboard.tsx`:
- `GeoScore`, `GeoScorecard`, `SchemaBlock`, `RankedRec`, `DiffData`, `SiteData`, `ChangeLogEntry`
- New additions: `TabId`, `TeamDomainSwitcherEntry`, `SiteDataExtended`

### File 5: `app/components/citation-monitor.tsx` — Minor extension

Add `onScanStart?: (triggerFn: () => void) => void` prop to `CitationMonitor` component signature. Call the prop with the internal trigger function on mount:
```typescript
// Inside CitationMonitor, on mount:
useEffect(() => {
  onScanStart?.(() => initiateSSEScan());
}, []);
```

Where `initiateSSEScan` is the existing internal function that starts the citation-check SSE stream. DaVinci: check existing implementation to find the correct internal function name.

---

## c) Unit Test Plan

**Test file:** `geo/tests/unit/sites/SitePageClient.test.tsx`

Mock: `useRouter` from `next/navigation`, `fetch`

| ID | Scenario | Expected |
|----|----------|---------|
| U1 | Component renders with site=null | email gate form shown (tokenReady=true, token=null) |
| U2 | Token loaded from sessionStorage | setToken called with stored value |
| U3 | Token loaded from URL hash fragment | sessionStorage set + hash cleaned |
| U4 | Tab "overview" active by default | overview tab content rendered |
| U5 | Tab click "scorecard" | scorecard content shown, overview hidden |
| U6 | Tab click "recommendations" | recommendations shown |
| U7 | Tab click "pages" | pages table shown |
| U8 | Tab click "history" | history shown |
| U9 | Tab click "setup" | setup shown |
| U10 | Polling starts when pipelineStatus="crawling" | setInterval called |
| U11 | Polling stops when pipelineStatus="complete" | clearInterval called |
| U12 | handleRefreshScore → 202 | pipelineStatus set to "queued" |
| U13 | handleRefreshScore → 402 | refreshError set, "Not enough credits" shown on rail |
| U14 | Domain switcher opens on domain name click | switcher dropdown renders |
| U15 | Domain switcher search filters list | only matching domains shown |
| U16 | AuditStatusBar renders during active scan | status bar present in DOM |
| U17 | AuditStatusBar absent when complete | status bar not in DOM |
| U18 | CSS var `--audit-bar-height` set to "52px" during scan | document.documentElement style set |
| U19 | CSS var reset to "0px" after scan completes | style reset |
| U20 | isNewSite=true during scan (overallScore=null initially) | set once on mount, not updated by polling |

**Test file:** `geo/tests/unit/sites/types.test.ts`

| ID | Scenario | Expected |
|----|----------|---------|
| U21 | SiteData type has all required fields | TypeScript compilation (type-only test) |
| U22 | SiteDataExtended extends SiteData | discoveredCompetitors field accessible |
| U23 | TabId union covers all 6 tabs | no TS error when assigning any tab name |

**Test file:** `geo/tests/unit/sites/tabContent.test.tsx`

| ID | Scenario | Expected |
|----|----------|---------|
| U24 | Overview tab — 5 KPI cards render | all 5 present |
| U25 | Overview tab — competitor chips render from discoveredCompetitors | chips present |
| U26 | Overview tab — empty competitors → CTA message | "No competitors mapped yet" shown |
| U27 | Scorecard tab — tierFilter "All" shows all pillars | all rendered |
| U28 | Scorecard tab — tierFilter "Poor" shows only score<25 pillars | correct filter |
| U29 | Scorecard tab — tier button absent when no pillars match | e.g. no "Good" button if 0 good pillars |
| U30 | Recommendations tab — sorted HIGH before MED before LOW | order correct |
| U31 | Recommendations tab — expand/collapse toggle works | state changes |
| U32 | Pages tab — status filter "good" hides non-good rows | filter applied |
| U33 | Pages tab — search filters by URL substring | search applied |
| U34 | Pages tab — status + search AND logic | both applied simultaneously |
| U35 | Pages tab — pagination shows 25 rows max | 26th row not visible |
| U36 | Setup tab — generatedLlmsTxt=null → "Not generated" | warning shown |
| U37 | Setup tab — domainVerified=true → checkmark | verified shown |
| U38 | Setup tab — domainVerified=false → DNS instructions | instructions shown |

**Test file:** `geo/tests/unit/sites/competitorSSE.test.ts`

| ID | Scenario | Expected |
|----|----------|---------|
| U39 | SSE stream: `{ type:"complete", competitors:[...], creditsUsed:2 }` | discoveredCompetitors state updated |
| U40 | SSE stream: `{ type:"complete", creditsUsed:2 }` | credits deducted by 2 |
| U41 | fetch throws | competitorScanActive reset to false |
| U42 | Malformed SSE line (invalid JSON) | no crash, continues reading |

---

## d) Integration Test Plan

**Test file:** `geo/tests/integration/sites/sitePage.test.ts`

| ID | Scenario | Expected |
|----|----------|---------|
| I1 | page.tsx with valid token | safeSite populated, all new fields included |
| I2 | page.tsx allTeamDomains query | returns all domains for same teamId |
| I3 | page.tsx free tier | perPageResults=null, rankedRecs truncated to 3 |
| I4 | page.tsx paid tier | all fields populated |
| I5 | page.tsx no teamId | allTeamDomains=[] (empty) |
| I6 | ResultsDashboard.tsx absent from repo | no import errors in page.tsx or SitePageClient |
| I7 | CitationMonitor renders inside SitePageClient | no prop errors |
| I8 | DimensionalIntelligence renders inside SitePageClient | no prop errors |
| I9 | CitationAnalytics renders inside SitePageClient | no prop errors |
| I10 | CitationHistory renders inside SitePageClient | no prop errors |
| I11 | Polling: mock API returns pipelineStatus="complete" after 2 ticks | router.refresh() called |

---

## e) Profiling Requirements

- **allTeamDomains query:** < 30ms for teams with ≤ 20 domains
- **Total page.tsx server render:** < 200ms (2 new DB queries vs current 2)
- Log: `[sites/page] allTeamDomains=${N} ms=${X}`
- Tab switching (client-side) must be < 16ms (one frame) — no network calls on tab switch, all data preloaded
- SitePageClient initial paint: < 100ms after token resolved (no network waterfall before render)

---

## f) Load Test Plan

| Scenario | Config | Pass Criteria |
|----------|--------|---------------|
| Single user site report | 1 VU, 30s | p95 TTFB < 400ms |
| Normal load | 30 VU, 120s | p95 TTFB < 700ms |
| Active scan polling | 20 VU polling every 3s | p99 poll response < 200ms |
| Domain switcher | 20 VU, 60s | allTeamDomains query < 50ms |

---

## g) Logging & Instrumentation

| Event | Level | Format |
|-------|-------|--------|
| allTeamDomains query | `info` | `[sites/page] siteId=${id} allTeamDomains=${N} ms=${X}` |
| Scan initiated from rail | `info` | `[site-client] siteId=${id} action=refresh_score` |
| Competitor scan complete | `info` | `[site-client] siteId=${id} competitors=${N} creditsUsed=${C}` |
| Tab switch | `debug` | `[site-client] siteId=${id} tab=${tab}` (only if debug logging enabled) |
| Token loaded source | `debug` | `[site-client] token_source=sessionStorage|prop|hash` |

---

## h) Acceptance Criteria

All criteria carry over verbatim from TS-062 (AC-1 through AC-20), plus spec-level additions:

**AC-1:** Page renders at `/sites/:id?token=` with Apple HIG three-zone header.
**AC-2:** Back chevron navigates to `/dashboard`. Domain name click opens domain switcher.
**AC-3:** Domain switcher shows all team domains with GEO score right-aligned and page count subtitle. Search filters live.
**AC-4:** "FLOWBLINQ GEO" wordmark centered regardless of left/right zone widths.
**AC-5:** Credits badge shows current balance; click triggers UpgradeModal.
**AC-6:** Audit status bar hidden when not scanning. Sticky below header (top: 52px) when active. Correct step number shown.
**AC-7:** 6 tab buttons render. Active tab has copper underline and weight 600.
**AC-8:** Action rail fixed on left, vertically centered. All 5 buttons correct. Download Report uses `#f5f5f7` bg + T3 icon (HP-109 — not pink).
**AC-9:** Credit badges (5cr, 2cr) appear below Scan Citations and Map Competitors labels.
**AC-10:** Download ZIP links to `/api/sites/:id/download-report?token=`. Download Report shows "Coming soon" tooltip.
**AC-10a:** Refresh Score button shows red border + "Not enough credits" tooltip on 402.
**AC-10b:** Scan Citations triggers CitationMonitor's internal SSE handler via `onScanStart` callback.
**AC-11:** Stats row shows correct values. Copper "Scores will update" suffix during active scan.
**AC-12:** Overview tab renders all 8 sections in order.
**AC-13:** `CitationMonitor`, `CitationAnalytics`, `CitationHistory`, `DimensionalIntelligence` render without prop errors.
**AC-14:** Scorecard severity filter shows only present tiers with counts. "All" always shown. Zero-match tiers omitted. (HP-106)
**AC-15:** Recommendations sorted HIGH→MED→LOW. Expand/collapse works.
**AC-16:** Pages tab: filter buttons + search both apply (AND logic). Pagination 25/page. (HP-116)
**AC-17:** History tab: CitationHistory renders. Refresh button triggers regenerate.
**AC-18:** Setup tab: AI files show correct served URLs and status. Domain verification flow works.
**AC-19:** Polling stops on completion. Tab content reflects updated data.
**AC-20:** Token stored in sessionStorage on mount. All API calls use token.

**Spec-level additions:**
**AC-21:** `ResultsDashboard.tsx` file is deleted. No remaining imports of it.
**AC-22:** All type exports from `ResultsDashboard.tsx` are now in `app/sites/[id]/types.ts`.
**AC-23:** Inter font loaded via Google Fonts preconnect.
**AC-24:** `--audit-bar-height` CSS variable drives tab bar sticky offset (no hardcoded conditional).
**AC-25:** `allTeamDomains` query selects only `id`, `domain`, `geoScorecard`, `crawlData` (minimal projection — not `SELECT *`).
**AC-26:** ALL_STAGES labels are verbatim from existing `SitePageClient.tsx` (HP-112).

---

## ScriptDev / DaVinci Notes

1. **Sequence dependency:** ES-062 depends on ES-061 for shared CSS variable naming convention. Implement ES-061 first, then ES-062. Both target branch `feat/task-061-062-dashboard-rebuild`.

2. **ResultsDashboard.tsx deletion:** This is 2,234 lines. Before `git rm`, audit all exports: ensure `SiteData`, `GeoScore`, `GeoScorecard`, `RankedRec`, `DiffData`, `ChangeLogEntry`, `SchemaBlock`, `ChangeLogEntry` are all captured in `types.ts`. Run `grep -r "ResultsDashboard" app/` to confirm no stale imports.

3. **CitationMonitor onScanStart prop:** This requires a minor change to `CitationMonitor`. The change is: expose the internal `handleStartCheck` (or equivalent) function via the `onScanStart` callback ref pattern. This is not a breaking change — the prop is optional.

4. **Component prop verification:** Before using `DimensionalIntelligence`, `CitationAnalytics`, `CitationHistory` — read their current source files to verify exact prop names. The spec gives the expected props but the implementations (ES-057, ES-059, ES-060) are the source of truth.

5. **Email gate preservation:** The email gate form in current `SitePageClient.tsx` (lines 189–233) handles unauthenticated public report access. This MUST be preserved in the rebuild. It is displayed when `tokenReady && !token`.

6. **Tab bar top offset:** `top: "calc(52px + var(--audit-bar-height, 0px))"` — this is the HP-108 mechanism. The CSS variable is set/cleared in a `useEffect` watching `site?.pipelineStatus`. Verify it works in both server-side render (where the variable may be undefined) and client hydration.

7. **Mobile:** Out of scope per TS-062. Desktop-only implementation. Do not add mobile breakpoints.
