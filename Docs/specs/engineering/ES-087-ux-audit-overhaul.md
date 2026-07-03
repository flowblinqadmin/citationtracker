# ES-087: GEO Dashboard UX Overhaul — Engineering Spec

**Technical Spec**: TS-087 (Rev 2, post-adversarial)
**Adversarial Review**: ES-087-adversarial-review-2.md (4 blockers resolved below)
**Approach**: Extract monolith first (zero behavior change), then apply UX fixes
**Execution**: 3 PRs — (A) extraction, (B) bug fixes + quick wins, (C) UX overhaul
**Rule**: Do NOT begin PR-B until PR-A is merged.

### Blockers Resolved (from Adversarial Review Round 2)

| # | Issue | Resolution |
|---|-------|------------|
| BLOCKER-1 | `handleDownloadPdf` in SiteActions doesn't exist — PDF is inline handler | Remove from `SiteActions`. Keep PDF handler inline in `ActionSidebar.tsx` (it depends on `hoveredRail` local state). |
| BLOCKER-2 | `filteredPillars`/`filteredPages`/`pagedRows` not in hook | Explicitly tab-local: `ScorecardTab` re-derives `filteredPillars` from `pillars` + local `tierFilter`. `PagesTab` re-derives `filteredPages`/`pagedRows` from `sortedPages` + local filter state. NOT in `useSiteData`. |
| BLOCKER-3 | PR-B modifies files PR-A creates — rebase risk | Rule added: "Do NOT begin PR-B until PR-A is merged." |
| BLOCKER-4 | `assemblyResult.projectedScore` undefined — assembler doesn't return it | Modify `assembleResults()` at `assembler.ts:562` to include `projectedScore` in return. Then `route.ts` uses `assemblyResult.projectedScore`. |

### Additional fixes from Adversarial Review

- `estAfterFixes` preserved in PR-A's `useSiteData` (zero-behavior-change). Replaced with `projectedScore` in PR-B.
- `setShowUpgradeModal` added to OverviewTab props.
- `setActiveTab` (or `handleTabChange` from B5) added to OverviewTab and HeroMetrics props.
- `citationHistory` dead prop removed in PR-A.
- `COPPER_BG` dead constant removed in A1.
- `isNewSiteRef` and `ALL_STAGES` aliasing preserved in shell.
- `getIntegrationConfigs(slug)` expanded to construct `geoBase`, `pixelTag`, `scriptTag`, `cspNote`, `robotsBlock`, `referrerSteps` internally.
- B3 dashboard filter: `searchParams: Promise<{ q?: string }>` with `await` (Next.js 15). Filter test is Playwright E2E (not Vitest).

---

## PR-A: Monolith Extraction (zero behavior change)

### A1. Create design tokens file

**File**: `app/sites/[id]/design-tokens.ts` (NEW)

```ts
// Colors
export const COPPER = "#c2652a";
export const COPPER_BG = "#fff7ed";
export const BG = "#f5f5f7";
export const CARD = "#fff";
export const BORDER = "#e5e5ea";
export const GREEN = "#34c759";
export const ORANGE = "#ff9500";
export const RED = "#ff3b30";
export const TEXT = "#1d1d1f";
export const T2 = "#86868b";
export const T3 = "#aeaeb2";
export const FONT_STACK = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// Typography scale
export const TYPE = {
  caption: 11,    // labels, badges
  bodySmall: 12,  // secondary text, findings
  body: 13,       // primary text
  bodyLarge: 14,  // emphasis
  heading: 16,    // section headers
  title: 20,      // page title, large numbers
} as const;

// Helpers
export function scoreColor(s: number): string {
  return s >= 75 ? GREEN : s >= 50 ? ORANGE : RED;
}

export function scoreTier(s: number): "Good" | "Fair" | "Weak" | "Poor" {
  if (s >= 75) return "Good";
  if (s >= 50) return "Fair";
  if (s >= 25) return "Weak";
  return "Poor";
}

export function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
```

### A2. Create `useSiteData` hook

**File**: `app/sites/[id]/hooks/useSiteData.ts` (NEW)

Extracts all derived computations from SitePageClient.tsx lines 491–632. Single `useMemo` block.

```ts
import { useMemo } from "react";
import type { SiteData, GeoScorecard, GeoScore, RankedRec, ChangeLogEntry } from "../types";
import type { CitationCheckScore } from "@/lib/db/schema";
import { scoreTier } from "../design-tokens";

// ── Output types ─────────────────────────────────────────────────────────────

export interface PageVuln {
  pillar: string;
  pillarName: string;
  severity: "critical" | "high" | "medium" | "low";
  finding: string;
  recommendation: string;
}

export interface PageRow {
  url: string;
  title?: string;
  pageType?: string;
  overallPageHealth?: string;
  vulnerabilities?: PageVuln[];
}

export interface ProviderAggregate {
  name: string;
  mentionCount: number;
  totalQueries: number;
  visibilityScore: number;
}

export interface ProviderResultWithSamples {
  provider: string;
  visibilityScore: number;
  mentionCount: number;
  totalQueries: number;
  samples?: Array<{ question: string; answer: string; mentioned: boolean }>;
}

export interface CompetitorEntry {
  name: string;
  domain?: string;
  shareOfVoice: number;
}

export interface SiteDerivedData {
  // Core
  scorecard: GeoScorecard | null;
  pillars: GeoScore[];
  liveScore: number | null;
  pageCount: number;
  criticalCount: number;
  projectedScore: number | null;

  // Scorecard
  tierCounts: Record<"Poor" | "Weak" | "Fair" | "Good", number>;

  // Recommendations (sorted)
  recs: RankedRec[];

  // Pages (sorted, unfiltered)
  allPages: PageRow[];
  sortedPages: PageRow[];

  // Citations
  providerResults: ProviderResultWithSamples[];
  providerAggregates: ProviderAggregate[];
  competitorData: CompetitorEntry[];
  totalMentions: number;
  totalQueryCount: number;
  citationRate: number | null;
  ourSOV: number | null;
  topCompetitor: CompetitorEntry | null;
  hasSovSamples: boolean;

  // Breakdowns
  pillarVisibility: Record<string, number>;
  geoVisibility: Array<{ geoId: string; geoName: string; visibility: number }>;
  categoryVisibility: Array<{ categoryId: string; categoryName: string; visibility: number }>;
  tierVisibility: Array<{ tier: string; mentionCount: number; promptCount: number; visibility: number }>;

  // History
  changeLog: ChangeLogEntry[];

  // Pipeline
  currentStageIndex: number;

  // Estimates (PR-A preserves client-side calc; PR-B replaces with projectedScore)
  estAfterFixes: number | null;
  projectedScore: number | null;

  // Display helpers
  pillarDisplayName: (id: string) => string;
  visibleCompetitors: CompetitorEntry[];  // alias for competitorData (future: tier-gated)
}

export function useSiteData(
  site: SiteData | null,
  lastCitationCheck: CitationCheckScore | null,
): SiteDerivedData {
  return useMemo(() => {
    // ... all derivations from SitePageClient.tsx lines 491–632
    // Moved here verbatim, then returned as typed object
  }, [site, lastCitationCheck]);
}
```

**Key rules**:
- `estAfterFixes` preserved in PR-A (zero-behavior-change). PR-B replaces with `projectedScore`.
- `filteredPillars` is NOT in this hook — `ScorecardTab` re-derives from `pillars` + local `tierFilter`.
- `filteredPages`/`pagedRows` are NOT in this hook — `PagesTab` re-derives from `sortedPages` + local filter state.
- `visibleCompetitors` included as alias for `competitorData` (future: tier-gated filtering).

### A3. Create `useSiteActions` hook

**File**: `app/sites/[id]/hooks/useSiteActions.ts` (NEW)

Extracts all action handlers from SitePageClient.tsx lines 252–450 + 907–940.

```ts
export interface SiteActions {
  // Auth
  handleEmailAuth: (e: React.FormEvent) => Promise<void>;
  authLoading: boolean;
  authError: string | null;

  // Score
  handleRefreshScore: () => Promise<void>;
  retrying: boolean;
  refreshError: string | null;

  // Citations
  handleScanCitations: () => Promise<void>;
  citationScanActive: boolean;

  // Competitors
  handleMapCompetitors: () => Promise<void>;
  competitorScanActive: boolean;
  handleAddCompetitor: () => Promise<void>;
  handleRemoveCompetitor: (name: string) => Promise<void>;
  addCompetitorName: string;
  setAddCompetitorName: (v: string) => void;
  addCompetitorLoading: boolean;
  addCompetitorError: string | null;
  addCompetitorDomain: string;
  setAddCompetitorDomain: (v: string) => void;
  showDomainInput: boolean;
  setShowDomainInput: (v: boolean) => void;

  // Downloads
  handleDownloadZip: () => Promise<void>;
  downloadError: string | null;
  // NOTE: PDF download stays inline in ActionSidebar (depends on hoveredRail local state)

  // Connection
  handleTestConnection: () => Promise<void>;
  testingConnection: boolean;
  connectionResult: { connected: boolean; detail: string } | null;

  // Other platform
  handleOtherPlatform: () => Promise<void>;
  otherLoading: boolean;
  otherError: string;
}

export function useSiteActions(
  siteId: string,
  token: string | null,
  site: SiteData | null,
  setSite: React.Dispatch<React.SetStateAction<SiteData | null>>,
  setActiveTab: (tab: TabId) => void,
  poll: () => Promise<void>,
): SiteActions { ... }
```

### A4. Create integration configs file

**File**: `app/sites/[id]/integration-configs.ts` (NEW)

Move SitePageClient.tsx lines 634–905 (Vercel/Netlify/Cloudflare/nginx/WordPress/Apache config templates) to standalone file.

```ts
export function getIntegrationConfigs(slug: string): Record<string, { steps: string[]; code: string }> { ... }
```

### A5. Extract tab components

Each tab is a NEW file under `app/sites/[id]/components/`. State that is tab-local moves into the component. Shared state/data passed via props.

| Component | Source lines | Tab-local state | Props from shell |
|-----------|-------------|-----------------|------------------|
| `OverviewTab.tsx` | 1331–1823 | `sovSamplesExpanded`, `expandedProviders` | `data: SiteDerivedData`, `actions: SiteActions`, `isMobile`, `site`, `lastCitationCheck`, competitor state, `setActiveTab`, `setShowUpgradeModal` |
| `ScorecardTab.tsx` | 1827–1922 | `tierFilter`, `expandedPillars` | `data: SiteDerivedData` |
| `RecommendationsTab.tsx` | 1924–1992 | `expanded: Set<number>` | `data: SiteDerivedData` |
| `PagesTab.tsx` | 1994–2237 | `pageFilter`, `pageSearch`, `pageCursor`, `expandedPageUrls` | `data: SiteDerivedData`, `site.domainVerified`, `site.tier` |
| `HistoryTab.tsx` | 2240–2270 | (none) | `data.changeLog` |
| `SetupTab.tsx` | 2272–2556 | `expandedFiles`, `integrationTab`, `otherPlatform`, `otherConfig`, `otherError` | `site`, `actions`, integration configs |
| `HeroMetrics.tsx` | 1343–1401 | (none) | `data: SiteDerivedData`, `lastCitationCheck`, `isMobile`, `setActiveTab` |
| `ActionSidebar.tsx` | 1147–1299 | `hoveredRail` | `actions: SiteActions`, `site`, `data`, `isMobile`, `credits` |

### A6. Update SitePageClient.tsx shell

After extraction, the shell contains:
- Imports
- Shell state: `site`, `token`, `tokenReady`, `activeTab`, `switcherOpen`, `switcherSearch`, `showUpgradeModal`, `email`, `emailInputRef`
- Competitor state (shared between Overview + Sidebar): `discoveredCompetitors`, `userCompetitors`, `competitorBlocklist`, `effectiveCompetitors`, `slotsRemaining`
- `useSiteData()` call
- `useSiteActions()` call
- Token loading `useEffect`
- Polling `useEffect`
- JSX: Header, audit status bar, tab nav, domain switcher, main content area with `{activeTab === "x" && <XTab ... />}`, ChatWidget, UpgradeModal

**Target**: ~350 lines

### A7. Tests for extraction

- All existing tests in `tests/unit/sites/` must pass unchanged
- Add snapshot tests for each extracted component with mock data
- Verify `useSiteData` hook returns identical output to inline derivations (unit test with known fixture)

---

## PR-B: Bug Fixes + Quick Wins

### B1. F-03: Fix "Est. after fixes" display

**File**: `app/sites/[id]/hooks/useSiteData.ts`
- Remove `top3Boost` and `estAfterFixes` client-side calculation entirely
- Add `projectedScore: site?.projectedScore ?? null` to derived data

**File**: `app/sites/[id]/components/HeroMetrics.tsx`
- Display `projectedScore` only when `projectedScore !== null && projectedScore !== liveScore`
- Format: `"Est. after fixes: {projectedScore}"` with delta in green: `"(+{projectedScore - liveScore})"`

**File**: `lib/services/assembler.ts` (backend prerequisite)
- Line ~562: Modify `assembleResults()` return to include `projectedScore`:
  `return { executiveSummary, rankedRecommendations, projectedScore };`
  (`projectedScore` is already computed at line ~468 via `computeProjectedScore()`, just not returned)

**File**: `app/api/pipeline/stage/route.ts` (backend prerequisite)
- Lines ~913–921: Replace crude `projectedScore` calc with `assemblyResult.projectedScore`
- Store in DB: `projectedScore: assemblyResult.projectedScore`

**Test**: Unit test with `projectedScore: 82, liveScore: 73` -> shows "Est. after fixes: 82 (+9)". With `projectedScore: null` -> hidden. With `projectedScore: 73` (same as live) -> hidden.

### B2. F-10: Fix recommendations header count

**File**: `app/sites/[id]/components/RecommendationsTab.tsx`

Replace:
```ts
const hiCount = recs.filter(r => ["HIGH", "high"].includes(r.priority)).length;
const medCount = recs.filter(r => ["MED", "med"].includes(r.priority)).length;
const lowCount = recs.filter(r => ["LOW", "low"].includes(r.priority)).length;
```

With:
```ts
function normPriority(p: string): string {
  const l = p.toLowerCase();
  if (l === "critical") return "CRIT";
  if (l === "high") return "HIGH";
  if (l === "med" || l === "medium") return "MED";
  return "LOW";
}
const counts: Record<string, number> = {};
for (const r of recs) {
  const k = normPriority(r.priority);
  counts[k] = (counts[k] ?? 0) + 1;
}
// Display: "1 CRIT . 2 HIGH . 5 MED . 2 LOW"
const labels = ["CRIT", "HIGH", "MED", "LOW"].filter(k => (counts[k] ?? 0) > 0);
```

Also fix sort order to separate `critical` from `HIGH`:
```ts
const sortOrder: Record<string, number> = { critical: 0, HIGH: 1, high: 1, MED: 2, med: 2, medium: 2, LOW: 3, low: 3 };
```

**Test**: Fixture with 1 critical, 2 HIGH, 3 MED, 1 LOW -> header shows "1 CRIT . 2 HIGH . 3 MED . 1 LOW". Total count = 7.

### B3. F-24: Fix dashboard filter

**File**: `app/dashboard/DashboardFilter.tsx` (REWRITE)

Replace DOM mutation with React-controlled filter using URL search params:

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
      if (q) params.set("q", q);
      else params.delete("q");
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  }, [router, searchParams]);

  return (
    <input
      type="text"
      placeholder="Filter domains..."
      defaultValue={current}
      onChange={handleChange}
      style={{ /* same styles */ }}
    />
  );
}
```

**File**: `app/dashboard/page.tsx`
- Add `searchParams` prop (Next.js 15 requires `Promise`):
  ```ts
  export default async function DashboardPage({
    searchParams,
  }: {
    searchParams: Promise<{ q?: string }>;
  }) {
    const { q } = await searchParams;
    // ... filter domains before passing to DashboardTable
  }
  ```
- Filter: `domains.filter(d => !q || d.domain.toLowerCase().includes(q.toLowerCase()))`
- Pass filtered `domains` to `DashboardTable`

**Test**: Playwright E2E (not Vitest — server component rendering). 250 domains, type "stripe", verify filtered. Sort by score, verify filter persists.

### B4. F-22: Fix chat widget overlap

**File**: `app/components/chatbot/ChatWidget.tsx`
- Add `bottom: 90px` on mobile (instead of 24px) to clear the action rail bottom bar

### B5. F-18: Tab URL deep linking

**File**: `app/sites/[id]/SitePageClient.tsx` (shell)

```ts
// Read hash on mount
useEffect(() => {
  const hash = window.location.hash.slice(1) as TabId;
  if (TABS.some(t => t.id === hash)) setActiveTab(hash);
}, []);

// Update hash on tab change
function handleTabChange(tab: TabId) {
  setActiveTab(tab);
  window.history.replaceState(null, "", `#${tab}`);
}
```

Replace all `setActiveTab` calls with `handleTabChange`.

**Test**: Mount with `#scorecard` in URL -> activeTab is "scorecard". Click "Pages" tab -> URL hash becomes `#pages`. Browser back -> returns to previous hash.

### B6. F-29: Source credit costs from config

**File**: `app/sites/[id]/components/ActionSidebar.tsx`

```ts
import { ACTION_CREDITS, PAGES_PER_CREDIT } from "@/lib/config";

const auditCost = Math.max(1, Math.ceil(pageCount / PAGES_PER_CREDIT));
```

Labels:
- Refresh Score: `{auditCost}cr`
- Scan Citations: `{ACTION_CREDITS.shareOfVoice}cr`
- Map Competitors: `{ACTION_CREDITS.competitorMapping}cr`
- Download ZIP: `{ACTION_CREDITS.zipDownload}cr`
- PDF Report: `{ACTION_CREDITS.pdfDownload}cr`

**Test**: With `pageCount: 50`, audit label shows "5cr". With `pageCount: 150`, shows "15cr". With `pageCount: 0`, shows "1cr" (Math.max(1, ...)).

---

## PR-C: UX Overhaul

### C1. F-01: Move "What AI said" to Evidence section

**File**: `app/sites/[id]/components/OverviewTab.tsx`

Move the "What AI actually said" block from after Critical Issues to Section 2 (Evidence), position 1. Show first 3 samples visible by default (no collapse). "See all N responses" button expands the rest.

### C2. F-02: Score delta breakdown in History

**File**: `app/sites/[id]/components/HistoryTab.tsx`

Each history row becomes expandable. On expand, show:
```
+3 Structured Data  -8 Metadata Freshness  +1 Content Structure  ...
```

Computed from `changeLog[i].pillarScores` vs `changeLog[i-1].pillarScores`. Sort `changeLog` by `runAt` ascending before rendering. Color: green for positive, red for negative, gray for zero.

Add column headers: Date | Score | Change | (expand)

### C3. F-04: Sidebar affordance + confirmation

**File**: `app/sites/[id]/components/ActionSidebar.tsx`

- Add tooltip on hover: `"Scan Citations — Check 4 AI providers for mentions of your site. Cost: 5 credits."`
- Add `ConfirmCreditModal` before any credit-spending action

**File**: `app/sites/[id]/components/ConfirmCreditModal.tsx` (NEW)

```ts
interface Props {
  action: string;         // "Scan Citations"
  description: string;    // "Check 4 AI providers..."
  cost: number;           // 5
  balance: number;        // current credits
  onConfirm: () => void;
  onCancel: () => void;
}
```

Session-scoped "Don't ask again" via `sessionStorage.setItem("skip-credit-confirm", "1")`.

### C4. F-05: Overview section grouping

**File**: `app/sites/[id]/components/OverviewTab.tsx`

Add section headers with gray subtext:

```tsx
function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ marginBottom: 16, marginTop: 32 }}>
      <h2 style={{ fontSize: TYPE.heading, fontWeight: 600, color: TEXT, margin: 0 }}>{title}</h2>
      <p style={{ fontSize: TYPE.bodySmall, color: T2, margin: "4px 0 0" }}>{subtitle}</p>
    </div>
  );
}
```

Three sections per layout wireframe in TS-087.

### C5. F-06: Citation rate explanation

**File**: `app/sites/[id]/components/HeroMetrics.tsx`

Add `title` attribute to each provider pill:
```
title={`Out of ${p.totalQueries} questions asked to ${p.name}, your site was cited ${p.mentionCount} times`}
```

Change pill format from `"Perplexity 1/40"` to `"Perplexity 1 of 40"`.

### C6. F-07: Citation visibility themes

**File**: `app/sites/[id]/components/OverviewTab.tsx`

- Add header: "Topics AI providers associate with your brand"
- Sort by pillar weight (import `GEO_PILLAR_WEIGHTS` from assembler or define locally)
- Zero values: gray bar with "Not yet detected — see Recommendations" link

### C7. F-08: Competitor slot limit from tier

**File**: `app/sites/[id]/SitePageClient.tsx` (shell, where `slotsRemaining` is computed)

```ts
import { SUBSCRIPTION_TIERS, type SubscriptionTier } from "@/lib/config";
const tierKey = (site?.subscriptionTier ?? "free") as SubscriptionTier;
const maxCompetitors = SUBSCRIPTION_TIERS[tierKey]?.maxCompetitors ?? 6;
const slotsRemaining = Math.max(0, maxCompetitors - effectiveCompetitors.length);
```

Display: `"Compare up to {maxCompetitors} competitors ({tierName})"`.

### C8. F-09: Larger vuln bars + severity text

**File**: `app/sites/[id]/components/PagesTab.tsx`

- Increase vuln bar: `width: 80, height: 8` (from 48x4)
- Add severity text next to bar: `"2 crit, 3 high"` (only shown for non-zero counts)

### C9. F-11: Scorecard expand affordance

**File**: `app/sites/[id]/components/ScorecardTab.tsx`

- `cursor: pointer` on pillar rows
- On hover: show "Click to expand" text or highlight the expand icon
- Default-expand first 2 pillars with score < 25

### C10. F-12: Setup verification UX

**File**: `app/sites/[id]/components/SetupTab.tsx`

- Add badge: green "Verified" or amber "Not verified"
- Add explanation text: "Verification enables automatic schema injection, AI file serving, and citation tracking."

### C11. F-13: Empty states

**File**: `app/sites/[id]/components/EmptyState.tsx` (NEW)

```ts
interface Props {
  title: string;
  description: string;
  ctaLabel?: string;
  onCtaClick?: () => void;
}
```

Used in OverviewTab when no scorecard, in PagesTab when no pages, in HistoryTab when no history.

### C12. F-14: Credits display

**File**: `app/dashboard/BuyCreditsButton.tsx` or header area

Add tooltip/popover:
- "604 credits remaining"
- Last 5 transactions: "Apr 8 — Scan Citations -5cr", ...
- "1 credit = 10 pages"
- Link to `/dashboard/credits` (F-26b)

### C13. F-15: SOV zero competitors

**File**: `app/sites/[id]/components/OverviewTab.tsx`

Verify against data: if competitor is in `competitorData` with `shareOfVoice: 0`, it should already render. If not in data, show gray row: "{name} — Not cited" for all mapped competitors.

### C14. F-16: "Start Here" CTA

**File**: `app/sites/[id]/components/StartHereCard.tsx` (NEW)

Shows the #1 recommendation from `recs[0]`:
- Title, expected impact, link to Recommendations tab with that rec expanded
- Only shown when `recs.length > 0`

### C15. F-17: Score history chart

**File**: `app/sites/[id]/components/ScoreHistory.tsx` (shared between Overview mini-timeline and History tab)

- Add y-axis labels (0, 25, 50, 75, 100) on full History view
- Add x-axis date labels
- Add trend line connecting dots

### C16. F-19: Verify mobile sidebar

Already partially handled (80px bottom padding). Verify no overlap and adjust if needed.

### C17. F-20: Page type cleanup

**File**: `app/sites/[id]/components/PagesTab.tsx`

Strip domain prefix from titles: `title.replace(/^[A-Z]{2,5}\s*[-–—]\s*/i, "").trim()`.
Improve "Other" categorization if possible from URL patterns.

### C18. F-21: Loading states

**File**: `app/sites/[id]/components/OverviewTab.tsx`

- When `citationScanActive`: show pulsing skeleton in citation metrics area
- When `competitorScanActive`: show "Discovering competitors..." with spinner

Surface SSE progress events (currently discarded at line 346–351) as status text.

### C19. F-23: Font size consistency

Apply `TYPE` scale from `design-tokens.ts` across all extracted components during extraction. Audit and replace ad-hoc font sizes.

### C20. F-25: Mobile chatbot offset

Handled in B4 (chat widget bottom offset).

### C21. F-26a: Delete/archive sites

**File**: `app/dashboard/DomainTableRow.tsx` — add "Archive" option in RowActions menu
**File**: `app/api/sites/[id]/archive/route.ts` (NEW) — set `archivedAt` timestamp
**File**: `lib/db/schema.ts` — add `archivedAt` column to `geoSites`
**File**: `app/dashboard/page.tsx` — filter out archived by default, add "Show archived" toggle

### C22. F-26b: Credit transaction log

**File**: `app/dashboard/credits/page.tsx` (NEW)
- Query `creditTransactions` table for team
- Display: date, action description, amount (+/-), running balance
- Paginate (25 per page)

### C23. F-27: Clickable hero metrics

**File**: `app/sites/[id]/components/HeroMetrics.tsx`

| Card | Click target |
|------|-------------|
| AI Visibility | `setActiveTab("overview")`, scroll to Evidence section |
| GEO Score | `setActiveTab("scorecard")` |
| Citation Rate | `setActiveTab("overview")`, scroll to Evidence section |
| SOV | `setActiveTab("overview")`, scroll to SOV section |
| Citation Quality | `setActiveTab("overview")`, scroll to "What AI said" |

Add `cursor: pointer`, hover shadow lift (`transform: translateY(-1px)`).

### C24. F-28: SOV card honest labeling (interim)

Until backend computes relative SOV:
- Rename Card 4 from "Competitive SOV" to "Brand Visibility"
- If no citation check data, show CTA: "Run Citation Scan to measure"
- Remove duplicate with Card 1 by showing different detail (e.g., Card 1 = overall %, Card 4 = leader comparison text)

---

## Test Plan

### Unit Tests (PR-A extraction)

| Test file | What it tests |
|-----------|--------------|
| `__tests__/hooks/useSiteData.test.ts` | All 30+ derived values match inline computation for fixture data |
| `__tests__/hooks/useSiteActions.test.ts` | Each action handler calls correct API endpoint with correct params |
| `tests/unit/sites/SitePageClient.test.tsx` | Existing tests pass unchanged |
| `tests/unit/sites/tabContent.test.tsx` | Existing tests pass unchanged (except 2 pre-existing failures) |

### Unit Tests (PR-B bug fixes)

| Test file | What it tests |
|-----------|--------------|
| `__tests__/components/HeroMetrics.test.tsx` | F-03: projectedScore display logic |
| `__tests__/components/RecommendationsTab.test.tsx` | F-10: CRIT/HIGH/MED/LOW counts |
| `__tests__/dashboard/DashboardFilter.test.tsx` | F-24: React-controlled filter with 250 rows |
| `__tests__/components/ActionSidebar.test.tsx` | F-29: dynamic credit labels |

### Unit Tests (PR-C UX)

| Test file | What it tests |
|-----------|--------------|
| `__tests__/components/HistoryTab.test.tsx` | F-02: pillar delta breakdown, sort by date |
| `__tests__/components/ConfirmCreditModal.test.tsx` | F-04: confirm/cancel/skip flows |
| `__tests__/components/OverviewTab.test.tsx` | F-01: "What AI said" position and visibility |
| `__tests__/components/StartHereCard.test.tsx` | F-16: renders #1 rec |
| `__tests__/components/EmptyState.test.tsx` | F-13: renders CTA |

### Integration Tests

| Test | What it validates |
|------|-------------------|
| Dashboard filter + sort | 250 domains, filter "stripe", sort by score, verify interop |
| Tab deep linking | Mount with `#pages`, verify correct tab active, verify back/forward |
| Credit confirmation flow | Click "Scan Citations" -> modal appears -> confirm -> API called |
| Archive site flow | Archive -> hidden from list -> "Show archived" -> visible again |

---

## Execution Order

```
PR-A: Extraction (zero behavior change)
  A1 → A2 → A3 → A4 → A5 → A6 → A7 (tests)
  All existing tests must pass.

PR-B: Bug fixes (on top of PR-A)
  B1 (F-03) → B2 (F-10) → B3 (F-24) → B4 (F-22) → B5 (F-18) → B6 (F-29)
  New tests written first (TDD), then code to pass them.

PR-C: UX overhaul (on top of PR-B)
  C1–C24, grouped by component:
    OverviewTab: C1, C4, C6, C13, C18
    HeroMetrics: C5, C23, C24
    HistoryTab: C2, C15
    ActionSidebar: C3
    ScorecardTab: C9
    RecommendationsTab: (already fixed in B2)
    PagesTab: C8, C17
    SetupTab: C10
    Shell: C7, C14
    Dashboard: C21, C22
    Shared: C11, C12
    Polish: C16, C19, C20
```

---

## Files Changed Summary

| Action | Count | Files |
|--------|-------|-------|
| NEW | 16 | design-tokens.ts, useSiteData.ts, useSiteActions.ts, integration-configs.ts, OverviewTab.tsx, ScorecardTab.tsx, RecommendationsTab.tsx, PagesTab.tsx, HistoryTab.tsx, SetupTab.tsx, HeroMetrics.tsx, ActionSidebar.tsx, ConfirmCreditModal.tsx, EmptyState.tsx, StartHereCard.tsx, ScoreHistory.tsx |
| NEW (dashboard) | 3 | credits/page.tsx, api/sites/[id]/archive/route.ts, DashboardFilter.tsx rewrite |
| MODIFIED | 5 | SitePageClient.tsx (shell), DashboardTable.tsx, page.tsx (dashboard), ChatWidget.tsx, pipeline/stage/route.ts |
| NEW (tests) | 10+ | Per-component test files |
