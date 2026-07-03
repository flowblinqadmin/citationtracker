# TS-062 — Site Report Page Rebuild

**Date:** 2026-03-25
**Author:** CoFounder (Agent 1)
**Status:** Amended — HolePoker review complete (HP-102–HP-116)

---

## What

Rebuild `app/sites/[id]/page.tsx`, `SitePageClient.tsx`, and `ResultsDashboard.tsx` to match the new design spec in `geo/docs/frontend/FlowBlinqGEO-ImplementationSpec.md` and `GEODashboardRedesignMockup-FINAL.html`.

The site report page is the detailed per-domain view with 6 tabs, a left action rail, domain switcher, and real-time pipeline status bar during active scans.

---

## Why

The current `ResultsDashboard.tsx` (2,234 lines) is a single-file monolith with no tab structure, no action rail, and no domain switcher. The new design introduces Apple HIG three-zone toolbar, 6 named tabs, a fixed left rail for all actions, and integrates the Sprint 34–37 visualization components (dimensional-intelligence, citation-analytics, citation-history) into a coherent tab structure.

---

## Dependencies

- `app/sites/[id]/page.tsx` — server component, keep + extend
- `app/sites/[id]/SitePageClient.tsx` — **REPLACE**
- `app/sites/[id]/ResultsDashboard.tsx` — **DELETE**
- `app/components/citation-monitor.tsx` — **KEEP**, integrate into Overview tab
- `app/components/citation-analytics.tsx` — **KEEP**, integrate into Overview tab
- `app/components/citation-history.tsx` — **KEEP**, integrate into History tab
- `app/components/dimensional-intelligence.tsx` — **KEEP**, integrate into Overview tab
- `app/components/UpgradeModal.tsx` — keep, used in action rail credit gates
- `geo/docs/frontend/FlowBlinqGEO-ImplementationSpec.md` — design authority
- `geo/docs/frontend/GEODashboardRedesignMockup-FINAL.html` — visual reference

---

## Design Notes

**Font (HP-114):** The final mockup (`GEODashboardRedesignMockup-FINAL.html`) loads Inter via Google Fonts and overrides all system-ui references. `SitePageClient.tsx` must load Inter: add `<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">` to the page `<head>` (or equivalent `next/font/google` import). Inter takes precedence over `system-ui` from the implementation spec.

---

## Auth Model (unchanged)

All client-side API calls use the per-site `accessToken` (stored in sessionStorage under key `geo-token-${siteId}`). The token is passed to `SitePageClient` as `initialToken` prop from the server component (which reads it from DB, already gated by team membership check at `/dashboard/domains/:id`).

No auth model changes. Existing `GET /api/sites/[id]?token=`, `POST /api/sites/[id]/citation-check`, etc. are used as-is.

---

## Files Changed

### `app/sites/[id]/page.tsx` — Extend (not replace)

Server component. Currently fetches site, derives tier/credits, preloads last citation check. Keep all of this.

**Add to server fetch:**
- `geoSites.discoveredCompetitors` — for competitor chips in Overview
- `geoSites.brandKeywords` — for brand detection context
- `geoSites.extractedCategories` — for category display in Overview
- `geoSites.perPageResults` — for Pages tab
- All other existing fields already fetched

Pass all data as props to the new `SitePageClient`.

Also: fetch all other team domains for the domain switcher dropdown (HP-111: include GEO score + page count to match mockup rendering):
```typescript
const allTeamDomains = site.teamId
  ? await db.select({
      id: geoSites.id,
      domain: geoSites.domain,
      geoScorecard: geoSites.geoScorecard,   // for overallScore display
      crawlData: geoSites.crawlData,          // for pages.length subtitle
    })
      .from(geoSites).where(eq(geoSites.teamId, site.teamId))
  : [];
```

### `app/sites/[id]/ResultsDashboard.tsx` — DELETE

Replaced by the new tab-based layout in `SitePageClient.tsx`.

### `app/sites/[id]/SitePageClient.tsx` — Full rebuild

`"use client"` component. Owns all client-side state and polling. Structured as follows:

---

#### Top-level structure

```tsx
<div class="site-page">
  <Header />                        // fixed, 52px, z-index 100
  <AuditStatusBar />                // sticky below header, conditional
  <TabBar />                        // 6 tabs
  <DomainSwitcher />                // dropdown, conditional open state
  <ActionRail />                    // fixed left, z-index 80
  <main class="db">                 // left-padded 80px for rail
    <StatsRow />
    <TabContent activeTab={tab} />
  </main>
</div>
```

---

#### Header — Apple HIG Three-Zone Toolbar

Single horizontal bar, 52px height, `position: sticky; top: 0; z-index: 100`.

```
[← domain.com ▾]    FLOWBLINQ GEO    [✦ N credits] [Sign out]
```

- **Leading zone:** Back chevron (22px, weight 300, `--t2`) + domain name (15px, weight 600, `--text`) + dropdown indicator `▾`. Click domain name → toggles `DomainSwitcher`. Click chevron → `router.push('/dashboard')`.
- **Center zone:** "FLOWBLINQ GEO" wordmark (17px, weight 700, 3px letter-spacing, `--copper`). `position: absolute; left: 50%; transform: translateX(-50%)`.
- **Trailing zone:** Credits badge (copper gradient pill, links to Stripe checkout via `POST /api/checkout`) + Sign out button.

#### Domain Switcher Dropdown

Positioned below the header leading zone. Contains:
- Search input (filters domains list)
- List of all team domains. Each row: domain name + GEO score right-aligned (from `geoScorecard.overallScore`, shown as "–" if null) + page count subtitle (from `crawlData.pages.length`, e.g. "42 pages"). HP-111: matches mockup which shows GEO scores in the switcher.
- Clicking a domain navigates to `/sites/:id?token=<accessToken>`

The token for other domains is not known client-side. On domain select: navigate to `/dashboard/domains/:newId` which server-redirects with the correct token.

#### Audit Status Bar

Shown only when `pipelineStatus` is one of the 6 active values. `position: sticky; top: 52px; z-index: 90`. On mount: sets `--audit-bar-height: 52px` on `:root`. On unmount: resets to `0px` (see Tab Bar section for mechanism).

```
Left:  ● Refreshing audit   99 pages · started N min ago
Center: [1]—[2]—[3]—[4]—[5]—[6]  (numbered circles connected by lines)
Right:  [████░░░░] 42%  ~3 min remaining
```

Background: `linear-gradient(135deg, #fffbf5, #fff7ed)`. Border-bottom: `1px solid #f0e0d0`.

Step numbering uses the same `ALL_STAGES` mapping from existing code (HP-112: use verbatim — do not invent labels):
```
discovery→1, crawling→2, researching→3, analyzing→4, generating→5, assembling→6
```
Step labels in the status bar center area come from the same `ALL_STAGES` array in `app/sites/[id]/SitePageClient.tsx`.

#### Tab Bar

6 tabs at `position: sticky; top: calc(52px + var(--audit-bar-height, 0px))` (HP-108: CSS variable mechanism — no hardcoded conditional).

**Mechanism:** When `AuditStatusBar` mounts (scan active), JS executes `document.documentElement.style.setProperty('--audit-bar-height', '52px')`. When it unmounts (scan complete/failed), JS resets: `document.documentElement.style.setProperty('--audit-bar-height', '0px')`. This keeps the tab bar sticky offset in sync with the audit bar's presence without layout thrash or JavaScript class toggling.

```
Overview | Scorecard | Recommendations | Pages | History | Setup
```

Active tab: `color: --copper; border-bottom: 2px solid --copper; font-weight: 600`.
Inactive: `color: --t2; border-bottom: 2px solid transparent`.

#### Left Action Rail

`position: fixed; top: 50%; left: 0; transform: translateY(-50%); width: 78px`.

5 buttons + 1 separator:

| Button | Icon | BG | Color | Credit badge | API call |
|--------|------|----|-------|-------------|----------|
| Refresh Score | circular-arrows | `#e8f5e9` | `#34c759` | — | `POST /api/sites/:id/regenerate?token=` |
| Scan Citations | @-arrow custom | `#ede7f6` | `#5856d6` | 5cr | `POST /api/sites/:id/citation-check?token=` |
| Map Competitors | people-plus SVG | `#fff3e0` | `#ff9500` | 2cr | `POST /api/sites/:id/competitor-discovery?token=` |
| — separator — | 1px line | | | | |
| Download ZIP | download-arrow | `#e3f2fd` | `#007aff` | — | `GET /api/sites/:id/download-report?token=` |
| Download Report | document | `#f5f5f7` | `--t3` | — | Disabled, tooltip "Coming soon" (HP-109: mockup shows neutral gray, not pink — pink was an error in the original spec) |

Each button: 32×32px icon container, label text below (10px, `--t2`), credit badge as copper pill below label.

Credit-consuming actions (Scan Citations, Map Competitors): show confirmation dialog if credits < cost. Deduct from local state optimistically after success.

**Refresh Score — 402 handling:** If `POST /api/sites/:id/regenerate` returns 402 (`insufficient_credits`), show an inline error state on the button (red border, tooltip "Not enough credits") and do NOT transition the row to scanning state.

**Scan Citations — SSE wiring:** The citation-check route returns a `text/event-stream` (not JSON). The action rail button should invoke the same SSE consumer already used by the `CitationMonitor` component. Pass a `onScanStart` callback prop to `CitationMonitor`; the action rail button triggers this callback, which initiates the SSE stream internally. `CitationMonitor` handles all stream events, progress display, and final state update.

**Map Competitors — SSE wiring:** The competitor-discovery route also returns a `text/event-stream`. Implement a dedicated SSE consumer in `SitePageClient` that:
1. Opens an `EventSource`-style fetch to `POST /api/sites/:id/competitor-discovery?token=`
2. Reads the stream via `ReadableStream` reader
3. On `{ type: "complete", competitors: [...], creditsUsed: 2 }` event: updates `discoveredCompetitors` state and deducts 2 credits from local credit balance
4. On error: shows inline error state on the button

#### Stats Row

```
{pageCount} pages crawled · {qaCount} Q&A moments · {pillarCount} pillars · {criticalCount} critical issues · Last scanned {date}
```

During active scan: append " · Scores will update when scan completes" in `--copper`.

`qaCount` = total Q&A pairs across all pillars in `geoScorecard`. `pillarCount` = `geoScorecard.pillars.length`. `criticalCount` = pillars with `score < 25` or `priority === 'critical'`.

#### Polling

Keep exact polling logic from existing `SitePageClient.tsx`:
- Poll `GET /api/sites/:id?token=` every 3 seconds when status is active
- Stop polling when `pipelineStatus === 'complete' | 'failed' | 'pending'`
- On completion: update all tab content from new data

---

#### Tab Content — Overview

The most complex tab. Contains (in order, top to bottom):

**1. KPI cards row (5 cards)**
- AI Visibility % — from `lastCitationCheck.overallVisibility`
- GEO Audit Score — from `geoScorecard.overallScore`
- Est. After Fixes — from top 3 recommendations' `boostEstimate` summed with current score (cap 100)
- Citation Rate — from `lastCitationCheck.overallVisibility` (same field)
- Citation Quality — from `lastCitationCheck.citationQualityScore`

**2. Competitor chips**
- From `discoveredCompetitors` array. Horizontal scrollable chip row. Each chip: domain name.
- If empty: "No competitors mapped yet" with Map Competitors CTA.

**3. Score history chart**
- From `citationCheckScores` history (existing `CitationHistory` component handles this).
- Or render inline as a simple line chart if `CitationHistory` already handles the full History tab (see History tab below).
- Note: Use a simple sparkline here in Overview, not the full History table.

**4. Citation Visibility (CitationMonitor)**
- Render `<CitationMonitor>` component in full (existing component from Sprint 34).
- Props: `siteId`, `accessToken` (token), `domain`, `lastCheck` (latest citation check), `history` (citation history array), `discoveredCompetitors`, `citationNarrative`.

**5. Dimensional Intelligence (DimensionalIntelligence)**
- Render `<DimensionalIntelligence>` component (existing component from Sprint 34).
- Props: pass `geoScorecard` data.

**6. Citation Analytics (CitationAnalytics)**
- Render `<CitationAnalytics>` component (existing component from Sprint 37).
- Props: pass `lastCitationCheck` + `discoveredCompetitors`.

**7. Critical Issues table**
- Pillars from `geoScorecard.pillars` where `score < 25` or `priority === 'critical'`.
- Columns: Pillar | Score | Top Finding.
- Top finding from matching `recommendations` where `pillar === pillarName`.

**8. Top Recommendations (preview — 3 items)**
- First 3 items from ranked recommendations, each with priority badge + pillar + action text.
- "View all →" link switches to Recommendations tab.

---

#### Tab Content — Scorecard

All pillars from `geoScorecard.pillars`. Severity filter bar (HP-106: dynamic, not static 4 buttons):
- "All" button always shown
- One button per tier **actually present** in the current data, with count in parentheses: e.g. "Poor (3)" "Weak (5)" "Fair (2)"
- Sorted order: Poor → Weak → Fair → Good
- Tiers with zero matching pillars are omitted entirely
- This reconciles the TS-062 spec (4 levels) with the mockup (3 buttons) — both are correct; the mockup simply reflects that "Good" had no entries in the sample data

Each pillar row:
- Pillar name (13px, 600)
- Severity badge (color-coded)
- Score (16px, 700)
- Description / top finding (12px, `--t2`)
- Score bar (60px, colored)

---

#### Tab Content — Recommendations

All items from `recommendations.rankedRecommendations` (existing JSONB field). Sorted by priority: HIGH → MED → LOW.

Each recommendation (expandable):
- Priority badge (HIGH=red, MED=orange, LOW=gray)
- Pillar name
- Time estimate
- **Collapsed:** problem statement (1 line)
- **Expanded:** full problem + action + boost estimate

"Expand all / Collapse all" toggle at top.

---

#### Tab Content — Pages

From `perPageResults` array. Searchable + filterable table.

Columns: Path | Fixes | Status
- Status: good / needs work / poor (colored badge)
- `fixes` count from `perPageFixes` array matched by URL

**Status filter buttons (HP-116):** All | Good | Needs Work | Poor — rendered above the search input. Active filter has copper underline. "All" is default. Both status filter and search text apply simultaneously (AND logic).

Search: client-side filter by path substring.
Pagination: 25 rows per page.

---

#### Tab Content — History

Render `<CitationHistory>` component (existing Sprint 35 component) in full.
Props: `siteId`, `accessToken`, `history` (array of citation check records).

Also show "Refresh Score" button (same as action rail) at top right of this tab.

---

#### Tab Content — Setup

Two sections:

**AI Files:**
List of served AI files. Each row: filename + served URL + status (green checkmark or warning).
Files: `llms.txt`, `llms-full.txt`, `business.json`, `schema.json`, `urls.txt`.
Check each via `site.generatedLlmsTxt != null`, etc.
Link each to its `/api/serve/:slug/...` URL.

**Domain Verification:**
Show current verification status (`site.domainVerified`).
If not verified: show DNS instructions + verify button (`POST /api/sites/:id/verify-domain`).
If verified: green checkmark.

---

## Acceptance Criteria

**AC-1:** Page renders at `/sites/:id?token=` with new Apple HIG three-zone header.

**AC-2:** Back chevron navigates to `/dashboard`. Domain name click opens domain switcher dropdown.

**AC-3:** Domain switcher shows all team domains. Selecting one navigates correctly.

**AC-4:** "FLOWBLINQ GEO" wordmark is centered regardless of left/right zone widths.

**AC-5:** Credits badge shows current balance; click triggers Stripe checkout.

**AC-6:** Audit status bar is hidden when site is not scanning. Appears (sticky below header) when `pipelineStatus` is active. Shows correct step number in pipeline visualization.

**AC-7:** Tab bar switches active tab correctly. Active tab has copper underline and weight 600.

**AC-8:** Action rail is fixed on left edge, vertically centered. All 5 buttons render with correct icon, background, and color. Download Report button uses `#f5f5f7` background and `--t3` icon color (not pink — HP-109).

**AC-9:** Credit badges (5cr, 2cr) appear below Scan Citations and Map Competitors labels.

**AC-10:** Download ZIP correctly links to `/api/sites/:id/download-report?token=`. Download Report shows "Coming soon" tooltip.

**AC-10a:** Refresh Score button shows inline error state (red border + tooltip "Not enough credits") when regenerate returns 402.

**AC-10b:** Scan Citations invokes CitationMonitor's SSE handler via callback prop. Map Competitors opens SSE stream directly, updates `discoveredCompetitors` state on complete event.

**AC-11:** Stats row shows correct values. "Scores will update" copper suffix appears during active scan.

**AC-12:** Overview tab renders all 8 sections in order. KPI cards show correct values.

**AC-13:** Existing `CitationMonitor`, `CitationAnalytics`, `CitationHistory`, `DimensionalIntelligence` components render correctly in their respective tab positions. No props regressions.

**AC-14:** Scorecard tab severity filter shows only tiers present in data with counts. "All" always shown. Zero-match tiers omitted. (HP-106)

**AC-15:** Recommendations tab: HIGH items appear before MED before LOW. Expand/collapse works.

**AC-16:** Pages tab: status filter buttons (All | Good | Needs Work | Poor) and search both apply. Pagination works (25/page). (HP-116)

**AC-17:** History tab: `CitationHistory` component renders fully. Refresh button triggers regenerate.

**AC-18:** Setup tab: AI files list shows correct served URLs. Domain verification flow works.

**AC-19:** Polling: status updates every 3 seconds during active scan. Stops on completion. Tab content reflects updated data after scan completes.

**AC-20:** Token from `initialToken` prop is stored in sessionStorage on mount. All API calls use token correctly.

---

## Risks

1. **ResultsDashboard.tsx is 2,234 lines** — significant amount of logic to audit before deleting. DaVinci must confirm all functionality is accounted for in the new design before removing.

2. **Existing component prop contracts** — `CitationMonitor`, `CitationAnalytics`, `CitationHistory`, `DimensionalIntelligence` have specific prop types. The new `SitePageClient` must pass exactly the right shapes. DaVinci wrote these components (ES-060) so he knows the contracts.

3. **Domain switcher token problem** — navigating to another domain requires its accessToken. The current solution (navigate to `/dashboard/domains/:id` which server-redirects with the correct token) adds a redirect hop. Acceptable for now.

4. **Tab content layout on mobile** — spec is desktop-first. Left rail collapses or repositions on narrow viewports. Spec does not specify mobile breakpoints — implement desktop only, defer mobile.

5. **Est. After Fixes calculation** — boosting estimate is approximate. If `recommendations.rankedRecommendations` doesn't contain `boostEstimate` fields, use a fixed placeholder ("~+15 pts") rather than failing to render.

---

## Out of Scope

- PDF download (deferred)
- Mobile responsive layout (desktop only)
- WebSocket scan stream (polling at 3s interval is sufficient)
- Public/unauthenticated view changes (existing behavior preserved — this spec only touches `SitePageClient.tsx` and `ResultsDashboard.tsx`, not the token verification logic in `page.tsx`)
