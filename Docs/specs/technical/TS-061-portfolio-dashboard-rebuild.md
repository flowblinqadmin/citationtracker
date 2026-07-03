# TS-061 — Portfolio Dashboard Rebuild

**Date:** 2026-03-25
**Author:** CoFounder (Agent 1)
**Status:** Amended — HolePoker review complete (HP-102–HP-116)

---

## What

Rebuild `app/dashboard/page.tsx` and its sub-components to match the new design spec in `geo/docs/frontend/FlowBlinqGEO-ImplementationSpec.md` and `GEOPortfolioDashboardMockup-FINAL.html`.

The portfolio dashboard is the authenticated home screen showing all team domains with their GEO scores, scanning states, and quick actions.

---

## Why

The current dashboard uses a card-based layout (`HoverCard.tsx`) with minimal data. The new design introduces: a copper design system, KPI summary cards, a full-featured sortable data table with inline pipeline status, and per-row action icons. This is the primary product surface for authenticated users.

---

## Dependencies

- `app/dashboard/page.tsx` (server component — to be rebuilt in place)
- `app/dashboard/BuyCreditsButton.tsx` — keep, integrate into new header
- `app/dashboard/SignOutButton.tsx` — keep, integrate into new header
- `app/dashboard/PaymentToast.tsx` — keep, unchanged
- `app/dashboard/ApiAccessSection.tsx` — keep, position below table
- `app/dashboard/HoverCard.tsx` — **DELETE** (replaced by table rows)
- `geo/docs/frontend/FlowBlinqGEO-ImplementationSpec.md` — design authority
- `geo/docs/frontend/GEOPortfolioDashboardMockup-FINAL.html` — visual reference

---

## Design System

All CSS variables per spec §1.1. Key values:
```
--copper: #c2652a  (CTAs, active states, progress)
--copper-light: #d4803e
--copper-bg: #fff7ed  (scanning row tint)
--bg: #f5f5f7
--card: #fff
--border: #e5e5ea
--green: #34c759
--orange: #ff9500
```

Font: `Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`

**Inter import:** Add `<link rel="preconnect" href="https://fonts.googleapis.com">` and `<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">` to the page `<head>` (or equivalent `next/font` import). Inter is the font used in the final mockup and takes precedence over system-ui per HP-114.

---

## Files Changed

### `app/dashboard/page.tsx` — Full rebuild

**Server component.** Keeps direct DB queries via Drizzle. No new API routes.

**Extended DB query** — current fetch is missing fields needed by new design. Add to the per-domain select:
- `geoSites.geoScorecard` — for `overallScore`, `pillars` (criticalIssues count)
- `geoSites.previousRunSnapshot` — for delta calculation
- `geoSites.crawlData` — for page count (`crawlData.pages.length`)

**Derived fields** (computed server-side from raw DB data):
- `overallScore: number | null` — `geoScorecard.overallScore ?? null`
- `tier: 'GOOD' | 'FAIR' | 'WEAK' | 'POOR' | null` — derived from overallScore:
  - ≥ 75 → GOOD, ≥ 50 → FAIR, ≥ 25 → WEAK, < 25 → POOR, null → null
- `criticalIssues: number` — count of pillars where `priority === 'critical'` or `score < 25` in `geoScorecard.pillars`. Default 0.
- `delta: number | null` — `overallScore - previousRunSnapshot.geoScorecard.overallScore`. Null if no previous snapshot.
- `pageCount: number` — `(crawlData as { pages?: unknown[] })?.pages?.length ?? 0`
- `citationRate: number | null` — from latest `citationCheckScores` row for this site: `overallVisibility`. Requires a separate query per-domain OR a LEFT JOIN on `citationCheckScores` ordered by `createdAt DESC`.

**Citation rate query:** One additional DB query after domains are fetched:
```typescript
const siteIds = domains.map(d => d.siteId);
const latestCitations = await db
  .select({ siteId: citationCheckScores.siteId, rate: citationCheckScores.overallVisibility })
  .from(citationCheckScores)
  .where(inArray(citationCheckScores.siteId, siteIds))
  .orderBy(desc(citationCheckScores.createdAt))
  // deduplicate: one row per siteId (use DISTINCT ON or filter in JS)
```
Then build a `Map<siteId, overallVisibility>` and attach to each domain row.

**Rendered layout** (server-rendered HTML, no client JS except BuyCreditsButton/SignOutButton):

```
<header class="hdr">
  Logo + "FLOWBLINQ GEO" (copper, 16px, 700, 2.5px letter-spacing)
  | email (13px, --t2) | <BuyCreditsButton> | <SignOutButton>
</header>

<main class="main" style="max-width:1200px; margin:0 auto; padding:24px 32px 60px">
  <!-- KPI Row -->
  <div class="kpi-row"> (4 cards, grid 4-col)
    Total Sites | Avg GEO Score | Total Critical Issues | Credits Remaining
  </div>

  <!-- Actions Strip -->
  <div class="actions-strip">
    <a href="/audit" class="act-btn primary">+ Run new audit</a>
    <input placeholder="Filter domains..." (client island or static) />
  </div>

  <!-- Table -->
  <h2 class="section-title">Your Audits</h2>  <!-- HP-115: 18px, weight 700, matches mockup; omitted from original TS -->
  <div class="subhead">N domains · sorted by score</div>
  <table class="ptable">
    <thead>Domain | GEO Score | Tier | Citations | Critical | Delta | Last Scan | Actions</thead>
    <tbody> {rows} </tbody>
  </table>

  <!-- API Access (below table, unchanged) -->
  <ApiAccessSection />
</main>

<PaymentToast />
```

**KPI cards:**
1. **Total Sites** — `domains.length`. Subtitle: "1 scan in progress" in copper if any domain is actively scanning (HP-104: moved here from Credits card — mockup-accurate placement).
2. **Avg GEO Score** — mean of all non-null `overallScore`. Subtitle: "across N domains"
3. **Total Critical Issues** — sum of `criticalIssues`. Subtitle: red if > 0
4. **Credits Remaining** — `teamInfo.team.creditBalance`. Copper left border (3px solid `--copper`). Subtitle: "Buy more →" as a copper-colored link to Stripe checkout (`POST /api/checkout`) when balance < 10; no subtitle otherwise (HP-104: matches mockup).

**Table rows — complete state:**
| Col | Data | Notes |
|-----|------|-------|
| Domain | Monogram rounded square + domain + pageCount subtitle | Monogram: first char uppercase, colored bg based on domain hash, `border-radius: 6px` (HP-113: matches mockup .dom-icon rendering) |
| GEO Score | `overallScore` + 60px progress bar | Bar color: green ≥75, orange ≥50, red <50 |
| Tier | Colored badge | GOOD=#34c759, FAIR=#ff9500, WEAK=#ff3b30, POOR=#ff2d55 |
| Citations | `citationRate`% or dash | Bullet dot colored by rate |
| Critical | `criticalIssues` | Red if ≥ 5 |
| Delta | Signed `delta` | Green if positive, red if negative, dash if null |
| Last Scan | `lastCrawlAt` formatted | "Mar 23, 2026" |
| Actions | 4 icon buttons (always visible) | See §3.5 of spec |

**Row actions (always visible, not hover-only):**
1. Rerun Audit — circular-arrow SVG (§2.2). Sends `POST /api/sites/:id/regenerate?token=` directly (HP-110: no navigation hop — avoids auth redirect round-trip). On success (202): optimistically transition the row to scanning state (step 1 / discovery). On 409 (already running): show tooltip "Scan already in progress". On 402 (insufficient_credits): show tooltip "Not enough credits".
2. Rerun Citations — @-arrow custom SVG (§2.1), initiates citation-check SSE stream via client island
3. Separator (1px vertical line)
4. Download ZIP — download SVG (§2.3), `href=/api/sites/:id/download-report?token=${accessToken}`
5. Download Report — document SVG (§2.4), disabled/tooltip "Coming soon" (PDF not built)

**Note:** Action buttons 1 and 2 require client interactivity (POST + optimistic state). These should be a small `"use client"` island component (`RowActions.tsx`) that receives `siteId` and `accessToken` as props. The rest of the page remains server-rendered.

**Table row — scanning state:**
When `pipelineStatus` is one of: `discovery | crawling | researching | analyzing | generating | assembling`:
- Row background: `#fff7ed`, left inset shadow: `inset 3px 0 0 #c2652a`
- Domain subtitle: step-appropriate text (copper color) from ALL_STAGES labels
- **isNewSite detection (HP-107):** `overallScore === null` → new site scan. `overallScore !== null` → refresh scan.
- Score column: dash (new site scan) or existing score at 0.4 opacity (refresh scan)
- Last Scan column: "Now" (new site scan) or "Refreshing" (refresh scan)
- Tier, Citations, Critical columns: remain visible at 0.4 opacity during **refresh** scans (existing values). Show dash during **new site** scans.
- Actions column replaced by pipeline status widget

**Pipeline status widget:**
```
● STEP N OF 6   (pulsing copper dot + label)
[■][■][□][□][□][□]  (6 segments: green=done, orange pulsing=active, gray=pending)
"Reading your content"  (step name, 10px, --t2)
```

Pipeline step mapping — taken **verbatim** from `ALL_STAGES` in `app/sites/[id]/SitePageClient.tsx` (HP-112: do not rename or invent labels — use the canonical source):
```
discovery    → Step 1: Discovering pages
crawling     → Step 2: Reading your content
researching  → Step 3: Checking the landscape
analyzing    → Step 4: Running your AI audit
generating   → Step 5: Building your profile
assembling   → Step 6: Final checks
```

**Dashboard refresh during scanning:** The pipeline status widget in the table row requires polling. Since the page is server-rendered, introduce a `DomainTableRow` client island that receives initial `pipelineStatus` and polls `GET /api/sites/:id?token=` every 3 seconds when status is active. On completion, refreshes the row (or triggers a full router refresh via `router.refresh()`).

### `app/dashboard/HoverCard.tsx` — DELETE

Replaced by inline table row rendering.

### New file: `app/dashboard/RowActions.tsx`

Client island for per-row action buttons. Receives: `siteId`, `accessToken`, `domain`, `pipelineStatus`.
Handles: citation-check POST, rerun audit navigation, download link generation.

### New file: `app/dashboard/DomainTableRow.tsx`

Client island for scanning rows. Receives: initial site data. Polls when `pipelineStatus` is active. Renders either normal row or scanning row based on live status.

---

## Acceptance Criteria

**AC-1:** Dashboard renders at `/dashboard` for authenticated users with the copper design system (variables match spec §1.1 exactly).

**AC-2:** Header shows logo, user email, credits badge (copper gradient pill with ✦ prefix), sign out button.

**AC-3:** 4 KPI cards render with correct values. Total Sites card subtitle shows "1 scan in progress" in copper when any site is scanning. Credits card has copper left border and "Buy more →" copper link when balance < 10.

**AC-4:** Table shows all team domains sorted by `overallScore` descending (nulls last).

**AC-5:** Each completed row shows all 8 columns with correct data. `overallScore` null → dash in score column.

**AC-6:** Tier badge uses correct color per tier value.

**AC-7:** Delta column: green for positive, red for negative, dash for null.

**AC-8:** Critical issues count: red if ≥ 5.

**AC-9:** Action icons are always visible (not hover-only). Tooltips via CSS `::after` + `data-tip`.

**AC-10:** Download ZIP action links correctly to `/api/sites/:id/download-report?token=`.

**AC-11:** Scanning rows render with warm tint background and copper left inset.

**AC-12:** Pipeline status widget shows correct step number and segment coloring for each active `pipelineStatus` value.

**AC-13:** Scanning rows poll every 3 seconds. On completion, row updates to complete state without full page reload.

**AC-14:** `PaymentToast` still appears after successful credit purchase.

**AC-15:** `ApiAccessSection` renders below the table unchanged.

**AC-16:** Filter input filters table rows client-side by domain name.

---

## Risks

1. **Citation rate query cost** — querying latest `citationCheckScores` for all team domains adds a DB round-trip per page load. Mitigate: single query with `inArray` + JS dedup, not N+1.

2. **Scanning row polling + server render** — mixing server-rendered rows with client polling islands requires careful prop passing (accessToken must reach client safely). The accessToken is already present in sessionStorage on the `/sites/:id` page; here it needs to come from the server-rendered page props.

3. **Monogram color consistency** — domain initial coloring should use a deterministic hash of the domain string → CSS color. Must be consistent across re-renders.

---

## Out of Scope

- PDF download (deferred per Aditya decision 2026-03-25)
- Bulk audit mode UI (existing, not in new spec)
- Team management / invite flow (unchanged)
