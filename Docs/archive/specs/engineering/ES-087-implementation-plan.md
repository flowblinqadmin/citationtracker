# ES-087 Implementation Plan — Remaining Work

Based on deep code inspection of `SitePageClient.tsx` (2581 lines), the completed hook files, and the engineering spec, here is the complete prioritized task breakdown.

---

## Current State

| File | Status | Notes |
|------|--------|-------|
| `app/sites/[id]/design-tokens.ts` | DONE | |
| `app/sites/[id]/hooks/useSiteData.ts` | DONE | 74 tests passing |
| `app/sites/[id]/hooks/useSiteActions.ts` | NOT STARTED | |
| `app/sites/[id]/integration-configs.ts` | NOT STARTED | |
| `app/sites/[id]/components/` | DOES NOT EXIST | Entire directory to create |
| `app/sites/[id]/SitePageClient.tsx` | 2581 lines, not cut | `useSiteData` exists but shell still re-declares all derivations inline (lines 491–632); hook not yet called |

---

## PR-A Remaining Tasks

### Task A3 — `hooks/useSiteActions.ts` (NEW, ~250 lines)

**Source lines in SitePageClient.tsx:**
- State declarations: lines 114–191
- `handleEmailAuth`: 252–281
- `handleDownloadZip`: 284–309
- `handleRefreshScore`: 311–333
- `handleScanCitations`: 335–357
- `handleMapCompetitors`: 359–397
- `handleAddCompetitor`: 399–420
- `handleRemoveCompetitor`: 422–436
- `handleTestConnection`: 907–922
- `handleOtherPlatform`: 924–945

**State moving INTO hook** (deleted from shell):
```
retrying, refreshError
citationScanActive, competitorScanActive
addCompetitorName, addCompetitorLoading, addCompetitorError
addCompetitorDomain, showDomainInput
email, authLoading, authError, emailInputRef
downloadError
testingConnection, connectionResult
otherLoading, otherError, otherPlatform, otherConfig
```

**State staying in shell** (shared between OverviewTab + ActionSidebar):
```
discoveredCompetitors, userCompetitors, competitorBlocklist
effectiveCompetitors (derived), slotsRemaining (derived)
```

**Hook signature:**
```ts
export function useSiteActions(
  siteId: string,
  token: string | null,
  site: SiteData | null,
  setSite: React.Dispatch<React.SetStateAction<SiteData | null>>,
  setActiveTab: (tab: TabId) => void,
  poll: () => Promise<void>,
  setDiscoveredCompetitors: React.Dispatch<React.SetStateAction<DiscoveredCompetitor[]>>,
  setUserCompetitors: React.Dispatch<React.SetStateAction<UserCompetitor[]>>,
  setCompetitorBlocklist: React.Dispatch<React.SetStateAction<string[]>>,
): SiteActions
```

**PDF download stays inline in ActionSidebar** (BLOCKER-1 resolution — depends on `hoveredRail` local state).

**Dependencies:** None — can start immediately.
**Parallelizes with:** A4.

---

### Task A4 — `integration-configs.ts` (NEW, ~280 lines)

**Source lines:** 634–905 — the `integrationSlug`, `geoBase`, `pixelTag`, `scriptTag`, `cspNote`, `robotsBlock`, `referrerSteps`, and `integrationConfigs` declarations.

**Shape:** Must become a function (per spec):
```ts
export function getIntegrationConfigs(slug: string): Record<string, string> {
  const geoBase = `https://geo.flowblinq.com/api/serve/${slug}`;
  const pixelTag = `<img src=".../${slug}" .../>`;
  // ... all template strings ...
  return { vercel, netlify, cloudflare, nginx, wordpress, apache };
}
```

All six platform keys stay. The function reconstructs `geoBase`, `pixelTag`, `scriptTag`, `cspNote`, `robotsBlock`, `referrerSteps` internally from `slug`.

**Dependencies:** None.
**Parallelizes with:** A3 and all A5 subtasks.

---

### Task A5 — Extract 8 tab/component files (ALL PARALLEL after A3+A4 interfaces stable)

Create directory: `app/sites/[id]/components/`

All 8 components can be extracted in parallel by separate agents. A5b (HeroMetrics) should complete before A5c (OverviewTab) since OverviewTab imports it.

#### A5a — `components/ActionSidebar.tsx` (~200 lines)

**Source lines:** 1147–1299

**Tab-local state to add:**
```ts
const [hoveredRail, setHoveredRail] = useState<string | null>(null);
```
(Currently shell line 169 — moves here.)

**PDF handler stays inline** — the `onClick` at lines 1260–1298 uses `hoveredRail` for loading state display. Do not extract it.

**Props:**
```ts
interface ActionSidebarProps {
  actions: SiteActions;
  site: SiteData | null;
  data: SiteDerivedData;
  isMobile: boolean;
  credits: number;
  slotsRemaining: number;
  siteId: string;
  token: string | null;
  poll: () => Promise<void>;
}
```

---

#### A5b — `components/HeroMetrics.tsx` (~80 lines)

**Source lines:** 1343–1401 (the 5 KPI cards grid)

**Tab-local state:** None.

**Props:**
```ts
interface HeroMetricsProps {
  data: SiteDerivedData;
  lastCitationCheck: CitationCheckScore | null;
  isMobile: boolean;
  setActiveTab: (tab: TabId) => void;
}
```

`lc.overallVisibility` and `lc.citationQualityScore` are accessed via the `lastCitationCheck` prop directly (not through `data`). `data` provides `liveScore`, `estAfterFixes`, `citationRate`, `providerAggregates`, `ourSOV`, `topCompetitor`.

---

#### A5c — `components/OverviewTab.tsx` (~520 lines)

**Source lines:** 1331–1823

**Tab-local state to add:**
```ts
const [sovSamplesExpanded, setSovSamplesExpanded] = useState(false);
const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
```
(Shell lines 173–174.)

**Imports:** `HeroMetrics` from `./HeroMetrics`.

**Props:**
```ts
interface OverviewTabProps {
  data: SiteDerivedData;
  actions: SiteActions;
  isMobile: boolean;
  site: SiteData | null;
  lastCitationCheck: CitationCheckScore | null;
  effectiveCompetitors: EffectiveCompetitor[];
  slotsRemaining: number;
  setActiveTab: (tab: TabId) => void;
  setShowUpgradeModal: (show: boolean) => void;
}
```

**Note:** The citation scan loading banner (lines 1334–1340), the download fix report bar (1403–1429), and the competitor management UI (1431–1820, including add/remove inputs) all live in OverviewTab. The competitor mutation handlers (`handleAddCompetitor`, `handleRemoveCompetitor`, `setAddCompetitorName`, etc.) come from `actions`.

---

#### A5d — `components/ScorecardTab.tsx` (~120 lines)

**Source lines:** 1827–1922

**Tab-local state to add:**
```ts
const [tierFilter, setTierFilter] = useState<"All"|"Poor"|"Weak"|"Fair"|"Good">("All");
const [expandedPillars, setExpandedPillars] = useState<Set<string>>(new Set());
```
(Shell lines 161, 165.)

**Local derivation (NOT from useSiteData — BLOCKER-2):**
```ts
const filteredPillars = data.pillars.filter(p =>
  tierFilter === "All" || scoreTier(p.score ?? 0) === tierFilter
);
```

**Props:**
```ts
interface ScorecardTabProps {
  data: SiteDerivedData;
  isMobile: boolean;
}
```

---

#### A5e — `components/RecommendationsTab.tsx` (~90 lines)

**Source lines:** 1924–1992

**Tab-local state to add:**
```ts
const [expanded, setExpanded] = useState<Set<number>>(new Set());
```
(Shell line 164.)

**Props:**
```ts
interface RecommendationsTabProps {
  data: SiteDerivedData;
}
```

---

#### A5f — `components/PagesTab.tsx` (~280 lines)

**Source lines:** 1994–2238

**Tab-local state to add:**
```ts
const [pageFilter, setPageFilter] = useState<"All"|"good"|"needs-work"|"poor">("All");
const [pageSearch, setPageSearch] = useState("");
const [pageCursor, setPageCursor] = useState(0);
const [expandedPageUrls, setExpandedPageUrls] = useState<Set<string>>(new Set());
const PAGE_SIZE = 25;
```
(Shell lines 177–182.)

**Local derivations (NOT from useSiteData — BLOCKER-2):**
```ts
const filteredPages = data.sortedPages.filter(p => {
  const matchSearch = p.url.toLowerCase().includes(pageSearch.toLowerCase())
    || (p.title ?? "").toLowerCase().includes(pageSearch.toLowerCase());
  const matchFilter = pageFilter === "All" || p.overallPageHealth === pageFilter;
  return matchSearch && matchFilter;
});
const pagedRows = filteredPages.slice(pageCursor, pageCursor + PAGE_SIZE);
```

**Props:**
```ts
interface PagesTabProps {
  data: SiteDerivedData;
  domainVerified: boolean;
  tier: string;
  onDownloadZip: () => Promise<void>;
}
```

---

#### A5g — `components/HistoryTab.tsx` (~50 lines)

**Source lines:** 2240–2270

**Tab-local state:** None.

**Props:**
```ts
interface HistoryTabProps {
  changeLog: ChangeLogEntry[];
  isMobile: boolean;
}
```

---

#### A5h — `components/SetupTab.tsx` (~320 lines)

**Source lines:** 2272–2556

**Tab-local state to add:**
```ts
const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
const [integrationTab, setIntegrationTab] = useState("vercel");
```
(Shell lines 166, 184.)

`AI_FILES` constant (shell lines 91–97) moves into SetupTab.tsx (or exported from a shared constants file — simplest to inline it here since only SetupTab uses it).

`otherPlatform`, `otherConfig`, `otherLoading`, `otherError` come from `actions` (moved into useSiteActions).

The verify-domain handler (inline at line 2394–2406) — this accesses `token`, `siteId`, `setSite`, `router`. It can either stay inline in SetupTab (passing those props) or move into useSiteActions as `handleVerifyDomain`. Simplest for zero-behavior-change: pass `token`, `siteId`, `setSite` as props and keep inline.

**Props:**
```ts
interface SetupTabProps {
  site: SiteData | null;
  siteId: string;
  token: string | null;
  actions: SiteActions;
  setSite: React.Dispatch<React.SetStateAction<SiteData | null>>;
  integrationConfigs: Record<string, string>;
}
```

---

### Task A6 — Rewrite SitePageClient.tsx shell (~350 lines)

**Dependencies:** A3, A4, and ALL A5 subtasks must be written (not necessarily merged — just code-stable).

**What shell retains:**
- All imports (add new component + hook imports)
- `SitePageClientProps` interface (unchanged)
- `TABS` constant
- `isActiveStatus()` function (used in audit bar JSX and polling effect — stays in shell)
- `ALL_STAGES` constant (used directly in audit bar JSX)
- Shell state: `site`, `token`, `tokenReady`, `activeTab`, `switcherOpen`, `switcherSearch`, `showUpgradeModal`
- Competitor state: `discoveredCompetitors`, `userCompetitors`, `competitorBlocklist`
- `effectiveCompetitors` + `slotsRemaining` derived values
- `isNewSiteRef` ref (preserved per spec)
- Token loading `useEffect` (lines 192–214)
- CSS var `useEffect` (lines 216–222)
- `poll` `useCallback` (lines 225–237)
- Polling effects (lines 239–250)
- `const data = useSiteData(site, lastCitationCheck);` — **REPLACES** lines 491–632
- `const actions = useSiteActions(...);` — **REPLACES** lines 252–450 + 907–945
- `const integrationConfigs = getIntegrationConfigs(site?.slug ?? site?.id ?? siteId);`
- JSX: email gate early return, header, audit status bar, tab nav, domain switcher, `<main>` with tab dispatch, ChatWidget, UpgradeModal

**What shell deletes:**
- Inline derivations: lines 491–632 (replaced by `useSiteData` call)
- All handlers: lines 252–450 + 907–945 (replaced by `useSiteActions` call)
- Integration config templates: lines 634–906 (replaced by `getIntegrationConfigs()`)
- All tab JSX: lines 1147–2556 (replaced by component renders)

**Estimated lines after rewrite:** ~350

**Shell state that gets destructured from hooks:**
```ts
const data = useSiteData(site, lastCitationCheck);
const { pillars, liveScore, criticalCount, currentStageIndex, pageCount } = data;

const actions = useSiteActions(
  siteId, token, site, setSite, handleTabChange, poll,
  setDiscoveredCompetitors, setUserCompetitors, setCompetitorBlocklist
);
const { email, setEmail, authLoading, authError, emailInputRef, ... } = actions;
```

**Tab dispatch pattern:**
```tsx
{activeTab === "overview" && (
  <OverviewTab
    data={data}
    actions={actions}
    isMobile={isMobile}
    site={site}
    lastCitationCheck={lastCitationCheck}
    effectiveCompetitors={effectiveCompetitors}
    slotsRemaining={slotsRemaining}
    setActiveTab={handleTabChange}
    setShowUpgradeModal={setShowUpgradeModal}
  />
)}
```

---

### Task A7 — Tests

**Files to create:**
- `app/sites/[id]/__tests__/hooks/useSiteActions.test.ts` — each handler calls correct endpoint with correct params (mock fetch)
- Snapshot tests for each extracted component: write immediately after each A5 component, in parallel with writing other components
- Run existing: `tests/unit/sites/SitePageClient.test.tsx`, `tests/unit/sites/tabContent.test.tsx` — must pass unchanged

**Dependencies:** A6 complete for shell-level tests. Per-component snapshots can be written in parallel with A5.

---

## PR-A Parallelization Map

```
SEQUENTIAL prerequisite:
  A3 ──┐  (can be done in parallel with each other)
  A4 ──┘
         │
         ▼ (once A3+A4 interfaces are code-stable — don't need to merge)
FULLY PARALLEL (8 agents):
  A5a (ActionSidebar)      ──────────────────────┐
  A5b (HeroMetrics)        ──────────────────────┤
  A5c (OverviewTab)        ── after A5b ─────────┤
  A5d (ScorecardTab)       ──────────────────────┤──► A6 → A7
  A5e (RecommendationsTab) ──────────────────────┤
  A5f (PagesTab)           ──────────────────────┤
  A5g (HistoryTab)         ──────────────────────┤
  A5h (SetupTab)           ──────────────────────┘

Recommended agent allocation (6 agents):
  Agent 1: A3 (useSiteActions)
  Agent 2: A4 (integration-configs) → A5g (HistoryTab, simplest, ~50 lines)
  Agent 3: A5b (HeroMetrics) → A5c (OverviewTab)
  Agent 4: A5d (ScorecardTab) + A5e (RecommendationsTab)
  Agent 5: A5f (PagesTab)
  Agent 6: A5h (SetupTab)
  After all done: Agent 1 → A6 (shell rewrite) + A7 (tests)
```

---

## PR-B Tasks (after PR-A merged)

### B1 — Fix "Est. after fixes" (F-03)

**Backend first (independent of PR-A):**

`lib/services/assembler.ts` ~line 562:
- `assembleResults()` return must include `projectedScore` (it's already computed at ~line 468 by `computeProjectedScore()`, just not returned)

`app/api/pipeline/stage/route.ts` lines ~913–921:
- Replace crude `projectedScore` calc with `assemblyResult.projectedScore`
- Store in DB: `projectedScore: assemblyResult.projectedScore`

**Frontend (after PR-A merged):**

`app/sites/[id]/hooks/useSiteData.ts`:
- Delete `top3Boost` (lines 217–225 in hook) and `estAfterFixes`
- Remove from `SiteDerivedData` interface
- Keep `projectedScore: site?.projectedScore ?? null` (already present)

`app/sites/[id]/components/HeroMetrics.tsx`:
- Show `projectedScore` only when `projectedScore !== null && projectedScore !== liveScore`
- Format: `"Est. after fixes: {projectedScore} (+{projectedScore - liveScore})"`

**Tests:** `__tests__/components/HeroMetrics.test.tsx` — three cases: show delta, hide when null, hide when equal to live score.

**Can parallelize:** B1 backend can start now (no PR-A dep). B1 frontend after PR-A merged, parallel with B2/B5/B6.

---

### B2 — Fix recommendations count (F-10)

`app/sites/[id]/components/RecommendationsTab.tsx`:
- Add `normPriority()` that maps "critical" → "CRIT", "medium"/"med" → "MED"
- Replace `hiCount`/`medCount`/`lowCount` logic with normalized count map
- Fix sort order: critical = 0, HIGH = 1, MED = 2, LOW = 3
- Header format: "1 CRIT · 2 HIGH · 3 MED · 1 LOW" (filter out zero counts)

**Dependencies:** PR-A merged.
**Parallelizes with:** B1 frontend, B5, B6.

---

### B3 — Fix dashboard filter (F-24)

`app/dashboard/DashboardFilter.tsx` — rewrite:
```tsx
"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";

export default function DashboardFilter() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const current = searchParams.get("q") ?? "";

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    startTransition(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (q) params.set("q", q); else params.delete("q");
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  }, [router, searchParams]);

  return <input type="text" placeholder="Filter domains..." defaultValue={current} onChange={handleChange} />;
}
```

`app/dashboard/page.tsx`:
```ts
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  // filter domains before DashboardTable
  const filtered = domains.filter(d => !q || d.domain.toLowerCase().includes(q.toLowerCase()));
}
```

**Test:** Playwright E2E (not Vitest — server component rendering).
**Can start now** — independent of PR-A (dashboard files only).

---

### B4 — Fix chat widget overlap (F-22)

`app/components/chatbot/ChatWidget.tsx`:
- Change `bottom` on mobile from 24px to 90px

**Can start now.** Trivial, no dependencies.

---

### B5 — Tab URL deep linking (F-18)

`app/sites/[id]/SitePageClient.tsx` shell (after PR-A):
```ts
useEffect(() => {
  const hash = window.location.hash.slice(1) as TabId;
  if (TABS.some(t => t.id === hash)) setActiveTab(hash);
}, []);

function handleTabChange(tab: TabId) {
  setActiveTab(tab);
  window.history.replaceState(null, "", `#${tab}`);
}
```
Replace all `setActiveTab` calls in shell with `handleTabChange`. Pass `handleTabChange` (not `setActiveTab`) to all components that need it.

**Dependencies:** PR-A merged.

---

### B6 — Source credit costs from config (F-29)

`app/sites/[id]/components/ActionSidebar.tsx`:
```ts
import { ACTION_CREDITS, PAGES_PER_CREDIT } from "@/lib/config";
const auditCost = Math.max(1, Math.ceil(pageCount / PAGES_PER_CREDIT));
```
Replace all hardcoded "10cr", "5cr" badge strings with dynamic values from config.

**Dependencies:** PR-A merged.

---

## PR-B Parallelization Map

```
Can start NOW (before PR-A):
  B1 backend (assembler.ts, pipeline route)
  B3 (dashboard filter)
  B4 (chat widget)

After PR-A merged (all parallel):
  B1 frontend (useSiteData + HeroMetrics)
  B2 (RecommendationsTab)
  B5 (shell hash routing)
  B6 (ActionSidebar credit labels)
```

---

## PR-C Tasks (after PR-B merged)

Group by component for agent parallelization:

### GROUP 1 — OverviewTab.tsx: C1, C4, C6, C13, C18 (one agent)
- **C1:** Move "What AI said" block to Evidence section position 1. Show first 3 samples by default, expand button for rest.
- **C4:** Add `SectionHeader` component (inline or extracted). Three sections per TS-087 wireframe.
- **C6:** "Topics AI providers associate with your brand" header. Sort by pillar weight. Zero values: gray bar + "Not yet detected — see Recommendations" link.
- **C13:** Show gray "{name} — Not cited" row for competitors present in mapped list but absent from `competitorData`.
- **C18:** Pulsing skeleton when `citationScanActive`. "Discovering competitors…" spinner when `competitorScanActive`. Surface SSE progress events as status text.

### GROUP 2 — HeroMetrics.tsx: C5, C23, C24 (one agent)
- **C5:** Add `title` attributes to provider pills. Change "1/40" to "1 of 40".
- **C23:** Make cards clickable (`cursor: pointer`, hover shadow lift). Map click targets per spec table (GEO Score → scorecard, etc.).
- **C24:** Rename "Competitive SOV" to "Brand Visibility". Show CTA "Run Citation Scan to measure" when no citation data.

### GROUP 3 — HistoryTab.tsx: C2, C15 (one agent)
- **C2:** Expandable rows showing per-pillar score deltas. Sort `changeLog` by `runAt` ascending. Green/red/gray colors.
- **C15:** Add y-axis labels (0, 25, 50, 75, 100), x-axis date labels, trend line connecting dots to the score history chart.

### GROUP 4 — ActionSidebar.tsx + new ConfirmCreditModal.tsx: C3 (one agent)
- **C3:** Rich tooltip text on hover for each action. `ConfirmCreditModal` gate before credit-spending actions.
- **New file:** `app/sites/[id]/components/ConfirmCreditModal.tsx` — props: `action`, `description`, `cost`, `balance`, `onConfirm`, `onCancel`. Session-scoped "Don't ask again" via `sessionStorage`.

### GROUP 5 — ScorecardTab.tsx: C9 (one agent, combine with GROUP 6)
- **C9:** `cursor: pointer` on pillar rows, hover affordance (show expand icon or "Click to expand"). Default-expand first 2 pillars with score < 25.

### GROUP 6 — PagesTab.tsx + SetupTab.tsx: C8, C17, C10 (one agent)
- **C8:** Increase vuln bar from 48×4 to 80×8. Add severity text "2 crit, 3 high" next to bar.
- **C17:** Strip domain prefix from page titles: `title.replace(/^[A-Z]{2,5}\s*[-–—]\s*/i, "").trim()`.
- **C10:** Green "Verified" / amber "Not verified" badge. Explanation text about what verification enables.

### GROUP 7 — Shell + new shared components: C7, C11, C14 (one agent)
- **C7:** `const maxCompetitors = SUBSCRIPTION_TIERS[tier]?.maxCompetitors ?? 6;` in shell. Pass to OverviewTab for display.
- **C11:** `app/sites/[id]/components/EmptyState.tsx` (NEW) — props: `title`, `description`, `ctaLabel?`, `onCtaClick?`. Use in OverviewTab (no scorecard), PagesTab (no pages), HistoryTab (no history).
- **C14:** `app/sites/[id]/components/StartHereCard.tsx` (NEW) — shows `recs[0]` with title, impact, link to Recommendations tab.

### GROUP 8 — Dashboard: C21, C22 (one agent)
- **C21:** `app/dashboard/DomainTableRow.tsx` — add Archive option in RowActions menu. New `app/api/sites/[id]/archive/route.ts` — set `archivedAt`. `lib/db/schema.ts` — add `archivedAt` column to `geoSites`. `app/dashboard/page.tsx` — filter archived by default, add "Show archived" toggle.
- **C22:** `app/dashboard/credits/page.tsx` (NEW) — query `creditTransactions`, display date/description/amount/running balance, paginate 25/page.

### GROUP 9 — Polish: C12, C16, C19 (after all others complete)
- **C12:** Credits tooltip in `BuyCreditsButton.tsx` or header — last 5 transactions, "1 credit = 10 pages", link to `/dashboard/credits`.
- **C16:** Verify mobile sidebar overlap — likely no-op if B4 done.
- **C19:** Apply `TYPE` scale from `design-tokens.ts` across all components. Replace ad-hoc font sizes.

---

## PR-C Parallelization Map

```
After PR-B merged — all groups 1–8 fully parallel:

  GROUP 1 (OverviewTab: C1,C4,C6,C13,C18)    ──────────────┐
  GROUP 2 (HeroMetrics: C5,C23,C24)            ──────────────┤
  GROUP 3 (HistoryTab: C2,C15)                 ──────────────┤──► GROUP 9 (polish)
  GROUP 4 (ActionSidebar+Modal: C3)            ──────────────┤
  GROUP 5+6 (Scorecard+Pages+Setup: C9,C8,C17,C10) ─────────┤
  GROUP 7 (Shell+EmptyState+StartHere: C7,C11,C14) ─────────┤
  GROUP 8 (Dashboard: C21,C22)                 ──────────────┘

Recommended agent allocation (6 agents):
  Agent 1: GROUP 1 (OverviewTab — 5 changes, largest)
  Agent 2: GROUP 2 (HeroMetrics) + GROUP 5/C9 (ScorecardTab)
  Agent 3: GROUP 3 (HistoryTab)
  Agent 4: GROUP 4 (ActionSidebar + ConfirmCreditModal)
  Agent 5: GROUP 6 (PagesTab + SetupTab)
  Agent 6: GROUP 7 (Shell + new components) + GROUP 8 (Dashboard)
  After all: Any agent → GROUP 9 (polish pass)
```

---

## Complete File Index

### PR-A — Files to Create/Modify

| Action | File | Task | Est. Lines |
|--------|------|------|-----------|
| CREATE | `app/sites/[id]/hooks/useSiteActions.ts` | A3 | ~250 |
| CREATE | `app/sites/[id]/integration-configs.ts` | A4 | ~280 |
| CREATE | `app/sites/[id]/components/ActionSidebar.tsx` | A5a | ~200 |
| CREATE | `app/sites/[id]/components/HeroMetrics.tsx` | A5b | ~80 |
| CREATE | `app/sites/[id]/components/OverviewTab.tsx` | A5c | ~520 |
| CREATE | `app/sites/[id]/components/ScorecardTab.tsx` | A5d | ~120 |
| CREATE | `app/sites/[id]/components/RecommendationsTab.tsx` | A5e | ~90 |
| CREATE | `app/sites/[id]/components/PagesTab.tsx` | A5f | ~280 |
| CREATE | `app/sites/[id]/components/HistoryTab.tsx` | A5g | ~50 |
| CREATE | `app/sites/[id]/components/SetupTab.tsx` | A5h | ~320 |
| REWRITE | `app/sites/[id]/SitePageClient.tsx` | A6 | ~350 (was 2581) |
| CREATE | `app/sites/[id]/__tests__/hooks/useSiteActions.test.ts` | A7 | ~80 |

### PR-B — Files to Modify

| Action | File | Task |
|--------|------|------|
| MODIFY | `lib/services/assembler.ts` | B1 backend |
| MODIFY | `app/api/pipeline/stage/route.ts` | B1 backend |
| MODIFY | `app/sites/[id]/hooks/useSiteData.ts` | B1 frontend |
| MODIFY | `app/sites/[id]/components/HeroMetrics.tsx` | B1 frontend |
| MODIFY | `app/sites/[id]/components/RecommendationsTab.tsx` | B2 |
| REWRITE | `app/dashboard/DashboardFilter.tsx` | B3 |
| MODIFY | `app/dashboard/page.tsx` | B3 |
| MODIFY | `app/components/chatbot/ChatWidget.tsx` | B4 |
| MODIFY | `app/sites/[id]/SitePageClient.tsx` | B5 |
| MODIFY | `app/sites/[id]/components/ActionSidebar.tsx` | B6 |

### PR-C — Files to Create/Modify

| Action | File | Task |
|--------|------|------|
| MODIFY | `app/sites/[id]/components/OverviewTab.tsx` | C1, C4, C6, C13, C18 |
| MODIFY | `app/sites/[id]/components/HeroMetrics.tsx` | C5, C23, C24 |
| MODIFY | `app/sites/[id]/components/HistoryTab.tsx` | C2, C15 |
| MODIFY | `app/sites/[id]/components/ActionSidebar.tsx` | C3 |
| CREATE | `app/sites/[id]/components/ConfirmCreditModal.tsx` | C3 |
| MODIFY | `app/sites/[id]/components/ScorecardTab.tsx` | C9 |
| MODIFY | `app/sites/[id]/components/PagesTab.tsx` | C8, C17 |
| MODIFY | `app/sites/[id]/components/SetupTab.tsx` | C10 |
| MODIFY | `app/sites/[id]/SitePageClient.tsx` | C7 |
| CREATE | `app/sites/[id]/components/EmptyState.tsx` | C11 |
| CREATE | `app/sites/[id]/components/StartHereCard.tsx` | C14 |
| MODIFY | `app/dashboard/DomainTableRow.tsx` | C21 |
| CREATE | `app/api/sites/[id]/archive/route.ts` | C21 |
| MODIFY | `lib/db/schema.ts` | C21 |
| MODIFY | `app/dashboard/page.tsx` | C21 |
| CREATE | `app/dashboard/credits/page.tsx` | C22 |
| MODIFY | `app/dashboard/BuyCreditsButton.tsx` | C12 |

---

## Critical State Boundary Reference

| State | Location | Reason |
|-------|----------|--------|
| `hoveredRail` | ActionSidebar.tsx local | PDF inline handler depends on it |
| `tierFilter`, `expandedPillars` | ScorecardTab.tsx local | Tab-local filter state (BLOCKER-2) |
| `expanded` (rec set) | RecommendationsTab.tsx local | Tab-local (BLOCKER-2) |
| `pageFilter`, `pageSearch`, `pageCursor`, `expandedPageUrls` | PagesTab.tsx local | Tab-local (BLOCKER-2) |
| `expandedFiles`, `integrationTab` | SetupTab.tsx local | Tab-local |
| `sovSamplesExpanded`, `expandedProviders` | OverviewTab.tsx local | Tab-local |
| `discoveredCompetitors`, `userCompetitors`, `competitorBlocklist` | Shell | Shared: both OverviewTab (competitor bar) + ActionSidebar (slot count) render it |
| `effectiveCompetitors`, `slotsRemaining` | Shell (derived) | Same shared reason |
| `site`, `token`, `tokenReady`, `activeTab` | Shell | Core navigation/data state |
| `showUpgradeModal`, `switcherOpen`, `switcherSearch` | Shell | Shell-level modals/overlays |
| All action loading/error states | useSiteActions | Handler-local side effects |
| `otherPlatform`, `otherConfig`, `otherLoading`, `otherError` | useSiteActions | SetupTab actions |
| `email`, `authLoading`, `authError`, `emailInputRef` | useSiteActions | Email gate in early return |

## Critical Implementation Gotchas

**`useSiteData` is not yet wired into the shell.** The hook exists and is tested, but `SitePageClient.tsx` still re-declares all derivations inline at lines 491–632. In A6, delete lines 491–632 and replace with `const data = useSiteData(site, lastCitationCheck);`.

**`poll` stays in shell.** It's a `useCallback` that depends on `siteId`, `token`, and `router` — all shell-level. Pass it as a prop to components that need to trigger refresh (ActionSidebar for ZIP/PDF, SetupTab for verify-domain).

**`isActiveStatus()` stays in shell.** Used in the audit status bar JSX and in the polling `useEffect`. Do not move it — it's a pure function needed at shell render level.

**`AI_FILES` moves to SetupTab.** Only SetupTab uses it. Either inline it there or export from a `constants.ts` file in `app/sites/[id]/`.

**B3 dashboard filter: Next.js 15 `searchParams` is a Promise.** The pattern is `const { q } = await searchParams;` in the async server component. Do NOT use the old synchronous `searchParams.q` access pattern.

**C21 archive route middleware check.** Before creating `app/api/sites/[id]/archive/route.ts`, verify that `/api/sites/[id]/archive` is covered by the existing middleware `ALWAYS_ALLOWED` pattern. If not, add it to `middleware.ts` and `middleware.test.ts` first. Missing entry = silent 403 in production (this has happened before).

**Build verification before every push.** The Dockerfile only runs Vitest — not `next build`. Always run:
```bash
API_JWT_SECRET=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef npm run build
```
after `docker run --rm geo-test` and before pushing.

Now let me write this to disk. I realize I need to use a different approach since I don't have a write tool — let me check what I missed:

Looking at my available tools: Glob, Grep, Read, WebFetch, WebSearch. There is no Write tool in this session. I'll present the plan as the response and note that it should be saved to the specified path.

However, looking at the task again — the user asked me to "Write the plan to `/Users/adithya/Code/Claudeled/geo/docs/specs/engineering/ES-087-implementation-plan.md`". Since I don't have a Write tool available, I'll deliver the full content in my response and clearly label it so the user knows what to save.

Let me compile everything into my final response now:

---

I don't have a file-write tool available in this session, so I'm delivering the full plan content below. Save it to `/Users/adithya/Code/Claudeled/geo/docs/specs/engineering/ES-087-implementation-plan.md`.

---

# ES-087 Implementation Plan — Remaining Work

**Source of truth:** ES-087-ux-audit-overhaul.md + live code inspection of SitePageClient.tsx (2581 lines)
**Date:** 2026-04-09
**Status:** PR-A Phase 1 complete (design-tokens.ts, useSiteData.ts — 74 tests passing)

---

## Current State

| File | Status | Notes |
|------|--------|-------|
| `app/sites/[id]/design-tokens.ts` | DONE | |
| `app/sites/[id]/hooks/useSiteData.ts` | DONE | 74 tests passing |
| `app/sites/[id]/hooks/useSiteActions.ts` | NOT STARTED | |
| `app/sites/[id]/integration-configs.ts` | NOT STARTED | |
| `app/sites/[id]/components/` | DOES NOT EXIST | Directory must be created |
| `app/sites/[id]/SitePageClient.tsx` | 2581 lines, not cut | `useSiteData` extracted but shell still re-declares all derivations inline (lines 491–632); hook not yet called |

**Critical:** `useSiteData` is extracted and tested but not yet wired into the shell. Lines 491–632 of `SitePageClient.tsx` re-declare all the same derivations inline and must be deleted in A6.

---

## PR-A: Remaining Work

### A3 — `hooks/useSiteActions.ts` (NEW)

**File:** `app/sites/[id]/hooks/useSiteActions.ts`
**Estimated lines:** ~250
**Dependencies:** None — start immediately.
**Parallelizes with:** A4.

**Source lines to extract from SitePageClient.tsx:**
- State declarations: 114–191 (action loading states, email gate, competitor add form, download error, connection/other platform states)
- `handleEmailAuth`: 252–281
- `handleDownloadZip`: 284–309
- `handleRefreshScore`: 311–333
- `handleScanCitations`: 335–357
- `handleMapCompetitors`: 359–397 (updates `discoveredCompetitors` via `setDiscoveredCompetitors` passed as arg)
- `handleAddCompetitor`: 399–420 (updates all three competitor lists)
- `handleRemoveCompetitor`: 422–436
- `handleTestConnection`: 907–922
- `handleOtherPlatform`: 924–945

**State moving INTO the hook** (delete from shell):
```
retrying, refreshError
citationScanActive, competitorScanActive
addCompetitorName, addCompetitorLoading, addCompetitorError
addCompetitorDomain, showDomainInput
email, authLoading, authError, emailInputRef (useRef)
downloadError
testingConnection, connectionResult
otherLoading, otherError, otherPlatform, otherConfig
```

**State staying in shell** (used by both OverviewTab and ActionSidebar):
```
discoveredCompetitors, userCompetitors, competitorBlocklist
effectiveCompetitors (derived), slotsRemaining (derived)
```

**PDF download does NOT go in hook** (BLOCKER-1): the inline PDF handler at lines 1260–1298 uses `hoveredRail` local state (loading indicator). Keep it inline in `ActionSidebar.tsx`.

**Hook signature:**
```ts
export function useSiteActions(
  siteId: string,
  token: string | null,
  site: SiteData | null,
  setSite: React.Dispatch<React.SetStateAction<SiteData | null>>,
  setActiveTab: (tab: TabId) => void,
  poll: () => Promise<void>,
  setDiscoveredCompetitors: React.Dispatch<React.SetStateAction<DiscoveredCompetitor[]>>,
  setUserCompetitors: React.Dispatch<React.SetStateAction<UserCompetitor[]>>,
  setCompetitorBlocklist: React.Dispatch<React.SetStateAction<string[]>>,
): SiteActions
```

---

### A4 — `integration-configs.ts` (NEW)

**File:** `app/sites/[id]/integration-configs.ts`
**Estimated lines:** ~280 (mostly template string literals)
**Dependencies:** None.
**Parallelizes with:** A3 and all A5 subtasks.

**Source lines:** 634–905 in SitePageClient.tsx — the `integrationSlug`, `geoBase`, `pixelTag`, `scriptTag`, `cspNote`, `robotsBlock`, `referrerSteps` locals and the `integrationConfigs` record.

**Must become a function** (per spec):
```ts
export function getIntegrationConfigs(slug: string): Record<string, string> {
  const geoBase = `https://geo.flowblinq.com/api/serve/${slug}`;
  const pixelTag = `<img src="https://geo.flowblinq.com/api/t/${slug}" width="1" height="1" .../>`;
  const scriptTag = `<script src="https://geo.flowblinq.com/api/t/${slug}" async></script>`;
  const cspNote = `// NOTE: ...`;
  const robotsBlock = `# Step 3 ...`;
  const referrerSteps: Record<string, string> = { vercel: ..., netlify: ..., ... };
  const configs: Record<string, string> = { vercel: ..., netlify: ..., cloudflare: ..., nginx: ..., wordpress: ..., apache: ... };
  return configs;
}
```

All six platform keys (vercel, netlify, cloudflare, nginx, wordpress, apache) stay identical to current template content — zero behavior change.

---

### A5 — Extract 8 tab/component files (PARALLEL)

**Create directory:** `app/sites/[id]/components/`

All 8 can be extracted in parallel. Only constraint: A5b (HeroMetrics) should be code-stable before A5c (OverviewTab imports it). Both A3 and A4 interfaces must be stable before starting A5 (for prop types).

---

#### A5a — `components/ActionSidebar.tsx`
**Source lines:** 1147–1299
**Estimated lines:** ~200

**Tab-local state to add:**
```ts
const [hoveredRail, setHoveredRail] = useState<string | null>(null);
```
(Currently shell line 169.)

**PDF handler stays inline** — lines 1260–1298, uses `hoveredRail` for the loading spinner `"report-loading"` key.

**Props:**
```ts
interface ActionSidebarProps {
  actions: SiteActions;
  site: SiteData | null;
  data: SiteDerivedData;
  isMobile: boolean;
  credits: number;
  slotsRemaining: number;
  siteId: string;
  token: string | null;
  poll: () => Promise<void>;
}
```

---

#### A5b — `components/HeroMetrics.tsx`
**Source lines:** 1343–1401
**Estimated lines:** ~80

**Tab-local state:** None.

**Props:**
```ts
interface HeroMetricsProps {
  data: SiteDerivedData;
  lastCitationCheck: CitationCheckScore | null;
  isMobile: boolean;
  setActiveTab: (tab: TabId) => void;
}
```

`lc.overallVisibility` and `lc.citationQualityScore` accessed via `lastCitationCheck` directly. `data` provides `liveScore`, `estAfterFixes`, `citationRate`, `providerAggregates`, `ourSOV`, `topCompetitor`.

---

#### A5c — `components/OverviewTab.tsx`
**Source lines:** 1331–1823
**Estimated lines:** ~520

**Tab-local state to add:**
```ts
const [sovSamplesExpanded, setSovSamplesExpanded] = useState(false);
const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
```
(Shell lines 173–174.)

**Imports:** `HeroMetrics` from `./HeroMetrics`.

**Props:**
```ts
interface OverviewTabProps {
  data: SiteDerivedData;
  actions: SiteActions;
  isMobile: boolean;
  site: SiteData | null;
  lastCitationCheck: CitationCheckScore | null;
  effectiveCompetitors: Array<(DiscoveredCompetitor | UserCompetitor) & { source: "user" | "discovered" }>;
  slotsRemaining: number;
  setActiveTab: (tab: TabId) => void;
  setShowUpgradeModal: (show: boolean) => void;
}
```

Contains: citation scan loading banner (1334–1340), download fix report bar (1403–1429), competitor bar (1431–1820) including the add/remove competitor inputs using `actions.addCompetitorName`, `actions.handleAddCompetitor`, etc.

---

#### A5d — `components/ScorecardTab.tsx`
**Source lines:** 1827–1922
**Estimated lines:** ~120

**Tab-local state to add:**
```ts
const [tierFilter, setTierFilter] = useState<"All"|"Poor"|"Weak"|"Fair"|"Good">("All");
const [expandedPillars, setExpandedPillars] = useState<Set<string>>(new Set());
```
(Shell lines 161, 165.)

**Local derivation (NOT in useSiteData — BLOCKER-2):**
```ts
const filteredPillars = data.pillars.filter(p =>
  tierFilter === "All" || scoreTier(p.score ?? 0) === tierFilter
);
```

**Props:**
```ts
interface ScorecardTabProps {
  data: SiteDerivedData;
  isMobile: boolean;
}
```

---

#### A5e — `components/RecommendationsTab.tsx`
**Source lines:** 1924–1992
**Estimated lines:** ~90

**Tab-local state to add:**
```ts
const [expanded, setExpanded] = useState<Set<number>>(new Set());
```
(Shell line 164.)

**Props:**
```ts
interface RecommendationsTabProps {
  data: SiteDerivedData;
}
```

---

#### A5f — `components/PagesTab.tsx`
**Source lines:** 1994–2238
**Estimated lines:** ~280

**Tab-local state to add:**
```ts
const [pageFilter, setPageFilter] = useState<"All"|"good"|"needs-work"|"poor">("All");
const [pageSearch, setPageSearch] = useState("");
const [pageCursor, setPageCursor] = useState(0);
const [expandedPageUrls, setExpandedPageUrls] = useState<Set<string>>(new Set());
const PAGE_SIZE = 25;
```
(Shell lines 177–182.)

**Local derivations (NOT in useSiteData — BLOCKER-2):**
```ts
const filteredPages = data.sortedPages.filter(p => {
  const matchSearch = p.url.toLowerCase().includes(pageSearch.toLowerCase())
    || (p.title ?? "").toLowerCase().includes(pageSearch.toLowerCase());
  const matchFilter = pageFilter === "All" || p.overallPageHealth === pageFilter;
  return matchSearch && matchFilter;
});
const pagedRows = filteredPages.slice(pageCursor, pageCursor + PAGE_SIZE);
```

**Props:**
```ts
interface PagesTabProps {
  data: SiteDerivedData;
  domainVerified: boolean;
  tier: string;
  onDownloadZip: () => Promise<void>;
}
```

---

#### A5g — `components/HistoryTab.tsx`
**Source lines:** 2240–2270
**Estimated lines:** ~50

**Tab-local state:** None.

**Props:**
```ts
interface HistoryTabProps {
  changeLog: ChangeLogEntry[];
  isMobile: boolean;
}
```

---

#### A5h — `components/SetupTab.tsx`
**Source lines:** 2272–2556
**Estimated lines:** ~320

**Tab-local state to add:**
```ts
const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
const [integrationTab, setIntegrationTab] = useState("vercel");
```
(Shell lines 166, 184.)

`AI_FILES` constant (shell lines 91–97) moves here — only SetupTab uses it.

`otherPlatform`, `otherConfig`, `otherLoading`, `otherError` come from `actions`.

Verify-domain handler (currently inline at lines 2394–2406) stays inline in SetupTab using `token`, `siteId`, `setSite` passed as props.

**Props:**
```ts
interface SetupTabProps {
  site: SiteData | null;
  siteId: string;
  token: string | null;
  actions: SiteActions;
  setSite: React.Dispatch<React.SetStateAction<SiteData | null>>;
  integrationConfigs: Record<string, string>;
}
```

---

### A6 — Rewrite SitePageClient.tsx shell (~350 lines)

**Dependencies:** A3, A4, and ALL A5 subtasks must be code-complete.

**What shell retains:**
- All imports (add extracted component/hook imports, remove inlined code)
- `SitePageClientProps` interface (unchanged)
- `TABS` constant
- `isActiveStatus()` function (used in audit bar JSX + polling effect)
- `ALL_STAGES` constant (used in audit bar JSX directly)
- Shell state: `site`, `token`, `tokenReady`, `activeTab`, `switcherOpen`, `switcherSearch`, `showUpgradeModal`
- Competitor shared state: `discoveredCompetitors`, `userCompetitors`, `competitorBlocklist`
- `effectiveCompetitors` + `slotsRemaining` derived values
- `isNewSiteRef` ref
- Token loading `useEffect` (lines 192–214)
- CSS var `useEffect` (lines 216–222)
- `poll` `useCallback` (lines 225–237) — passed as prop to components needing refresh
- Polling `useEffect` (lines 239–250)
- `const data = useSiteData(site, lastCitationCheck);` — replaces lines 491–632
- `const actions = useSiteActions(...);` — replaces lines 252–450 + 907–945
- `const integrationConfigs = getIntegrationConfigs(site?.slug ?? site?.id ?? siteId);`
- Email gate early return (uses `actions.email`, `actions.authLoading`, `actions.authError`, `actions.emailInputRef`, `actions.handleEmailAuth`)
- Header JSX (lines 953–997)
- Audit status bar JSX (lines 999–1074)
- Tab nav JSX (lines 1076–1101)
- Domain switcher (lines 1103–1145)
- `<main>` with tab dispatch — one `{activeTab === "x" && <XTab .../>}` per tab
- ChatWidget (lines 2559–2575)
- UpgradeModal (lines 2576–2578)

**What shell deletes:**
- Lines 491–632: inline derivations → replaced by `useSiteData()` call
- Lines 252–450 + 907–945: handlers/state → replaced by `useSiteActions()` call
- Lines 634–906: integration config templates → replaced by `getIntegrationConfigs()`
- Lines 1147–2556: all tab JSX → replaced by component renders

**Shell destructuring pattern:**
```ts
const data = useSiteData(site, lastCitationCheck);
const { pillars, liveScore, criticalCount, currentStageIndex, pageCount } = data;

const actions = useSiteActions(
  siteId, token, site, setSite, setActiveTab, poll,
  setDiscoveredCompetitors, setUserCompetitors, setCompetitorBlocklist
);
```

**Tab dispatch in JSX:**
```tsx
{activeTab === "overview" && <OverviewTab data={data} actions={actions} ... />}
{activeTab === "scorecard" && <ScorecardTab data={data} isMobile={isMobile} />}
{activeTab === "recommendations" && <RecommendationsTab data={data} />}
{activeTab === "pages" && <PagesTab data={data} domainVerified={site?.domainVerified ?? false} tier={site?.tier ?? "free"} onDownloadZip={actions.handleDownloadZip} />}
{activeTab === "history" && <HistoryTab changeLog={data.changeLog} isMobile={isMobile} />}
{activeTab === "setup" && <SetupTab site={site} siteId={siteId} token={token} actions={actions} setSite={setSite} integrationConfigs={integrationConfigs} />}
```

**`<ActionSidebar>` rendered outside the tab dispatch** (fixed position, always visible):
```tsx
<ActionSidebar actions={actions} site={site} data={data} isMobile={isMobile} credits={site?.credits ?? initialCredits} slotsRemaining={slotsRemaining} siteId={siteId} token={token} poll={poll} />
```

---

### A7 — Tests

- `app/sites/[id]/__tests__/hooks/useSiteActions.test.ts` — each handler calls correct API endpoint + params (mock fetch)
- Snapshot tests per component — can be written in parallel with A5 subtasks
- `tests/unit/sites/SitePageClient.test.tsx` and `tests/unit/sites/tabContent.test.tsx` must pass unchanged

---

## PR-A Parallelization Map

```
PARALLEL:
  A3 ─────────┐  (can run simultaneously)
  A4 ─────────┘
              │ (interfaces stable)
              ▼
PARALLEL (8 agents — A5b before A5c):
  A5a (ActionSidebar)       ──────────────────────────────┐
  A5b → A5c (Hero/Overview) ──────────────────────────────┤
  A5d (ScorecardTab)        ──────────────────────────────┤──► A6 → A7
  A5e (RecommendationsTab)  ──────────────────────────────┤
  A5f (PagesTab)            ──────────────────────────────┤
  A5g (HistoryTab)          ──────────────────────────────┤
  A5h (SetupTab)            ──────────────────────────────┘

Recommended allocation (6 agents):
  Agent 1: A3
  Agent 2: A4 → A5g
  Agent 3: A5b → A5c
  Agent 4: A5d + A5e
  Agent 5: A5f
  Agent 6: A5h
  Then Agent 1: A6 + A7
```

---

## PR-B Tasks (after PR-A merged)

### B1 — Fix "Est. after fixes" (F-03)

**Backend (independent, start now):**
- `lib/services/assembler.ts` ~line 562: add `projectedScore` to `assembleResults()` return (already computed at ~line 468)
- `app/api/pipeline/stage/route.ts` ~lines 913–921: use `assemblyResult.projectedScore` instead of crude inline calc; persist to DB

**Frontend (after PR-A):**
- `app/sites/[id]/hooks/useSiteData.ts`: delete `top3Boost` + `estAfterFixes`, remove from `SiteDerivedData` interface
- `app/sites/[id]/components/HeroMetrics.tsx`: display `projectedScore` only when `!== null && !== liveScore`

**Tests:** 3 cases in `__tests__/components/HeroMetrics.test.tsx`

### B2 — Fix recommendation count (F-10)
- `app/sites/[id]/components/RecommendationsTab.tsx`
- Add `normPriority()` mapper, fix sort order (critical=0, HIGH=1, MED=2, LOW=3)
- Header: "1 CRIT · 2 HIGH · 3 MED · 1 LOW"

### B3 — Fix dashboard filter (F-24)
- `app/dashboard/DashboardFilter.tsx`: full rewrite to `useRouter`/`useSearchParams`/`useTransition`
- `app/dashboard/page.tsx`: add `searchParams: Promise<{ q?: string }>`, filter server-side
- **Can start now** (no PR-A dep)

### B4 — Fix chat widget overlap (F-22)
- `app/components/chatbot/ChatWidget.tsx`: `bottom: 90px` on mobile (was 24px)
- **Can start now**, trivial

### B5 — Tab URL deep linking (F-18)
- `app/sites/[id]/SitePageClient.tsx` shell: add hash-read `useEffect` on mount, add `handleTabChange()`, replace all `setActiveTab` calls
- Requires PR-A merged

### B6 — Source credit costs from config (F-29)
- `app/sites/[id]/components/ActionSidebar.tsx`: import `ACTION_CREDITS`, `PAGES_PER_CREDIT` from `@/lib/config`; compute `auditCost = Math.max(1, Math.ceil(pageCount / PAGES_PER_CREDIT))`
- Requires PR-A merged

---

## PR-C Tasks (after PR-B merged)

### Group 1 — OverviewTab.tsx (Agent 1): C1, C4, C6, C13, C18
- C1: Move "What AI said" to Evidence section, show first 3 samples by default
- C4: Add `SectionHeader` component inline, three sections per TS-087 wireframe
- C6: "Topics AI providers associate" header, sort by pillar weight, zero-value gray bars
- C13: Gray "{name} — Not cited" row for competitors with zero SOV
- C18: Pulsing skeleton when `citationScanActive`, spinner when `competitorScanActive`

### Group 2 — HeroMetrics.tsx (Agent 2): C5, C23, C24
- C5: `title` attributes on provider pills, "1 of 40" format (not "1/40")
- C23: Clickable cards with `cursor: pointer` + hover shadow lift, tab navigation on click
- C24: Rename "Competitive SOV" → "Brand Visibility", CTA when no citation data

### Group 3 — HistoryTab.tsx (Agent 3): C2, C15
- C2: Expandable rows with pillar delta breakdown, sort ascending by `runAt`
- C15: Y-axis labels, x-axis dates, trend line on score chart

### Group 4 — ActionSidebar.tsx (Agent 4): C3
- C3: Rich hover tooltips, `ConfirmCreditModal` gate before credit-spending actions
- **New file:** `app/sites/[id]/components/ConfirmCreditModal.tsx` — props: `action`, `description`, `cost`, `balance`, `onConfirm`, `onCancel`. Session-scoped "Don't ask again" via `sessionStorage`.

### Group 5 — ScorecardTab + PagesTab + SetupTab (Agent 5): C9, C8, C17, C10
- C9: `cursor: pointer`, hover affordance, default-expand first 2 pillars with score < 25
- C8: Vuln bar 80×8 (was 48×4), severity text "2 crit, 3 high"
- C17: Strip domain prefix from titles
- C10: Verified/not-verified badge + explanation text

### Group 6 — Shell + new components (Agent 6): C7, C11, C14
- C7: `SUBSCRIPTION_TIERS[tier]?.maxCompetitors ?? 6` in shell for `slotsRemaining`
- C11: New `app/sites/[id]/components/EmptyState.tsx`
- C14: New `app/sites/[id]/components/StartHereCard.tsx`

### Group 7 — Dashboard (Agent 6 or 7): C21, C22
- C21: Archive feature — `DomainTableRow.tsx`, new archive route, schema change, dashboard toggle
- C22: New `app/dashboard/credits/page.tsx` credit transaction log

### Group 8 — Polish last (any agent): C12, C16, C19
- C12: Credits tooltip in BuyCreditsButton
- C16: Verify mobile sidebar (likely no-op after B4)
- C19: TYPE scale audit across all components

---

## Complete File Index

### PR-A
| Action | File | Task | Est. Lines |
|--------|------|------|-----------|
| CREATE | `app/sites/[id]/hooks/useSiteActions.ts` | A3 | ~250 |
| CREATE | `app/sites/[id]/integration-configs.ts` | A4 | ~280 |
| CREATE | `app/sites/[id]/components/ActionSidebar.tsx` | A5a | ~200 |
| CREATE | `app/sites/[id]/components/HeroMetrics.tsx` | A5b | ~80 |
| CREATE | `app/sites/[id]/components/OverviewTab.tsx` | A5c | ~520 |
| CREATE | `app/sites/[id]/components/ScorecardTab.tsx` | A5d | ~120 |
| CREATE | `app/sites/[id]/components/RecommendationsTab.tsx` | A5e | ~90 |
| CREATE | `app/sites/[id]/components/PagesTab.tsx` | A5f | ~280 |
| CREATE | `app/sites/[id]/components/HistoryTab.tsx` | A5g | ~50 |
| CREATE | `app/sites/[id]/components/SetupTab.tsx` | A5h | ~320 |
| REWRITE | `app/sites/[id]/SitePageClient.tsx` | A6 | ~350 (was 2581) |
| CREATE | `app/sites/[id]/__tests__/hooks/useSiteActions.test.ts` | A7 | ~80 |

### PR-B
| Action | File | Task |
|--------|------|------|
| MODIFY | `lib/services/assembler.ts` | B1 backend |
| MODIFY | `app/api/pipeline/stage/route.ts` | B1 backend |
| MODIFY | `app/sites/[id]/hooks/useSiteData.ts` | B1 frontend |
| MODIFY | `app/sites/[id]/components/HeroMetrics.tsx` | B1 frontend |
| MODIFY | `app/sites/[id]/components/RecommendationsTab.tsx` | B2 |
| REWRITE | `app/dashboard/DashboardFilter.tsx` | B3 |
| MODIFY | `app/dashboard/page.tsx` | B3, C21 |
| MODIFY | `app/components/chatbot/ChatWidget.tsx` | B4 |
| MODIFY | `app/sites/[id]/SitePageClient.tsx` | B5, C7 |
| MODIFY | `app/sites/[id]/components/ActionSidebar.tsx` | B6, C3 |

### PR-C
| Action | File | Task |
|--------|------|------|
| MODIFY | `app/sites/[id]/components/OverviewTab.tsx` | C1, C4, C6, C13, C18 |
| MODIFY | `app/sites/[id]/components/HeroMetrics.tsx` | C5, C23, C24 |
| MODIFY | `app/sites/[id]/components/HistoryTab.tsx` | C2, C15 |
| CREATE | `app/sites/[id]/components/ConfirmCreditModal.tsx` | C3 |
| MODIFY | `app/sites/[id]/components/ScorecardTab.tsx` | C9 |
| MODIFY | `app/sites/[id]/components/PagesTab.tsx` | C8, C17 |
| MODIFY | `app/sites/[id]/components/SetupTab.tsx` | C10 |
| CREATE | `app/sites/[id]/components/EmptyState.tsx` | C11 |
| CREATE | `app/sites/[id]/components/StartHereCard.tsx` | C14 |
| MODIFY | `app/dashboard/DomainTableRow.tsx` | C21 |
| CREATE | `app/api/sites/[id]/archive/route.ts` | C21 |
| MODIFY | `lib/db/schema.ts` | C21 |
| CREATE | `app/dashboard/credits/page.tsx` | C22 |
| MODIFY | `app/dashboard/BuyCreditsButton.tsx` | C12 |

---

## Critical Implementation Notes

### State Ownership Reference

| State | Where | Why |
|-------|-------|-----|
| `hoveredRail` | ActionSidebar.tsx local | PDF handler depends on it (BLOCKER-1) |
| `tierFilter`, `expandedPillars` | ScorecardTab.tsx local | Tab-local filter (BLOCKER-2) |
| `expanded` (rec set) | RecommendationsTab.tsx local | Tab-local (BLOCKER-2) |
| `pageFilter`, `pageSearch`, `pageCursor`, `expandedPageUrls` | PagesTab.tsx local | Tab-local (BLOCKER-2) |
| `expandedFiles`, `integrationTab` | SetupTab.tsx local | Tab-local |
| `sovSamplesExpanded`, `expandedProviders` | OverviewTab.tsx local | Tab-local |
| `discoveredCompetitors`, `userCompetitors`, `competitorBlocklist` | Shell | Shared: OverviewTab + ActionSidebar both render it |
| `effectiveCompetitors`, `slotsRemaining` | Shell (derived) | Same sharing reason |
| `site`, `token`, `tokenReady`, `activeTab` | Shell | Core app state |
| `showUpgradeModal`, `switcherOpen`, `switcherSearch` | Shell | Shell-level overlays |
| Action loading/error states | useSiteActions | Handler-local side effects |
| `otherPlatform`, `otherConfig`, `otherLoading`, `otherError` | useSiteActions | SetupTab actions |
| `email`, `authLoading`, `authError`, `emailInputRef` | useSiteActions | Email gate early return |

### `useSiteData` wiring gap
The hook exists and is tested, but `SitePageClient.tsx` re-declares all derivations inline at lines 491–632. In A6, delete those lines and replace with `const data = useSiteData(site, lastCitationCheck);`.

### `poll` stays in shell
It's a `useCallback` depending on `siteId`, `token`, `router` — all shell-level. Pass as prop to ActionSidebar (ZIP/PDF refresh), SetupTab (verify-domain triggers `router.refresh()`).

### `isActiveStatus()` stays in shell
Used in audit bar JSX (line 1000) and the polling `useEffect` (line 247). Do not move.

### `AI_FILES` moves to SetupTab
Only SetupTab uses it. Inline it there — no need for a shared constants file.

### B3: Next.js 15 searchParams is async
```ts
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;  // mandatory await
```
Do NOT use synchronous `searchParams.q` — Next.js 15 requires the await.

### C21: archive route middleware check
Before creating `app/api/sites/[id]/archive/route.ts`, check `middleware.ts` `ALWAYS_ALLOWED` list. The pattern `/api/sites/[id]/archive` may not be covered. If not: add it to both `middleware.ts` and `middleware.test.ts` before creating the route. Missing entry = silent 403 in production (happened before on `download-report`, commit `f848f7b`).

### Build verification before every push
```bash
docker build -f Dockerfile.test -t geo-test . && docker run --rm geo-test
API_JWT_SECRET=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef npm run build
```
The Dockerfile only runs Vitest, not `next build`. Skipping the build step causes Vercel deploy failures.

---

*End of implementation plan