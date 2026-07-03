# TS-087: GEO Dashboard UX Overhaul

**Status**: DRAFT (Rev 2 — post-adversarial-review)
**Source**: UX Audit (April 9, 2026) + additional findings
**Adversarial Review**: TS-087-adversarial-review-1.md (7 blocking issues resolved below)
**Component**: `app/sites/[id]/SitePageClient.tsx` (2,581 lines), `app/dashboard/`
**Goal**: Fix 29 UX findings, extract monolith into testable components

---

## Blocking Issues Resolved (from Adversarial Review)

| # | Issue | Resolution |
|---|-------|------------|
| B-1 | `projectedScore` in DB is crude (route.ts), not assembler's accurate version | **Backend prerequisite**: Store `computeProjectedScore()` result from assembler in DB. F-03 frontend uses this value. |
| B-2 | No "relative SOV" field exists for F-28 | **Reclassified**: F-28 now requires backend change — compute `brand_mentions / (brand + competitor_mentions)` during citation check, store as `relativeShareOfVoice`. Frontend displays it. Moved to LOW priority (backend dependency). |
| B-3 | Shell estimate 300 lines is 2.5x too low | **Updated extraction plan**: Add `useSiteData()` hook for derived data (~140 lines), `useSiteActions()` hook for handlers (~250 lines), `integration-configs.ts` for template literals (~270 lines). Shell target: ~350 lines. |
| B-4 | F-26 bundles 3 unrelated features | **Split**: F-26a (delete/archive sites), F-26b (credit transaction log), F-26c (scan cancellation — requires QStash interrupt, deprioritized to BACKLOG). |
| B-5 | F-08 ignores `SUBSCRIPTION_TIERS.maxCompetitors` | **Updated**: F-08 now sources slot limit from tier config, not hard-coded 6. |
| B-6 | F-29 credit costs aren't simple config lookups — audit cost depends on page count | **Updated**: F-29 sources from `ACTION_CREDITS` for fixed-cost actions. For audit refresh, compute `ceil(pageCount / PAGES_PER_CREDIT)` and display dynamic cost. |
| B-7 | F-01 and F-05 propose conflicting layout | **Reconciled**: Single Overview layout defined below. F-01 "What AI said" goes in Evidence section (section 2). F-16 "Start here" CTA goes at top of Health section. F-27 hero cards click to jump to relevant section/tab. |

---

## Overview Layout (reconciling F-01, F-05, F-16, F-27)

```
Section 1: HEALTH
  ├─ "Start Here" CTA card (#1 recommendation)     ← F-16
  ├─ 5 Hero Metric Cards (clickable → tabs/sections) ← F-27
  └─ Score History mini-timeline

Section 2: EVIDENCE
  ├─ What AI Actually Said (first 3 visible)        ← F-01
  ├─ Citation Visibility by Theme                    ← F-07
  └─ Share of Voice                                  ← F-15

Section 3: DIAGNOSIS
  ├─ Critical Issues table
  ├─ Geographic / Category / Buyer Intent grid
  └─ Top Recommendations preview
```

---

## Findings

### CRITICAL

| ID | Finding | Root Cause | Acceptance Criteria |
|----|---------|------------|---------------------|
| F-01 | "What AI actually said" is buried — collapsed accordion at bottom of Overview | `sovSamplesExpanded` defaults to `false`; section rendered after Critical Issues table (line ~1653) | Section moves to position 2 on Overview (below hero metrics). First 3 samples visible by default. "See all N responses" expand for rest. |
| F-02 | Score drop (43->37) with no explanation | History tab shows only `overallScore` delta; `ChangeLogEntry.pillarScores` exists but is never rendered | Each history row shows pillar-level delta breakdown on expand. Format: "+3 Structured Data, -8 Metadata, ..." with color coding. |
| F-03 | "Est. after fixes" = current score | Client-side `parseInt` of `estimatedBoost` strings extracts citation percentages and years as point deltas (e.g., "85% of citations" → 85 points). `site.projectedScore` exists in schema but DB stores crude route.ts version, not assembler's accurate `computeProjectedScore()`. | **Backend**: Store `computeProjectedScore()` result in `projectedScore` column (assembler already computes it). **Frontend**: Display `site.projectedScore` when available. Remove broken client-side `top3Boost` calc entirely. If `projectedScore` equals current score or is null, hide the line. Show delta: "Est. after fixes: 73 → 82 (+9)". |
| F-04 | Left sidebar actions lack affordance — look like nav, no confirmation before credit spend | Buttons are plain `<button>` with 10px icon, hover state only sets background color. No tooltip, no confirmation dialog. | Add tooltip on hover explaining action + cost. Add confirmation modal before any credit-spending action: "Scan Citations will check 4 AI providers. Cost: 5 credits. [Cancel] [Proceed]". Show spinner + progress text after click. |

### HIGH

| ID | Finding | Root Cause | Acceptance Criteria |
|----|---------|------------|---------------------|
| F-05 | Overview is information overload — no reading path | 8+ sections dumped flat with no visual hierarchy | Group into 3 labeled sections: **Health** (hero metrics + score history), **Evidence** (citations + "What AI said" + SOV), **Diagnosis** (critical issues + recommendations preview). Add section headers with gray subtext. |
| F-06 | Citation Rate "1/40" denominator unexplained | Provider pills show `mentionCount/totalQueries` with no label | Add tooltip: "Out of N questions asked to {Provider}, your site was cited X times." Natural language in pill: "{Provider} X of N". |
| F-07 | Citation Visibility by Theme — all zeros, no guidance | Themes rendered alphabetically, zero values get no treatment | Sort by potential impact. Zero-state shows ghost text "Not yet detected" with link to relevant recommendation. Add one-liner header explaining what themes are. |
| F-08 | Competitor mapping "slots full" — no edit flow, wrong limit | Slot limit hard-coded at 6, ignores `SUBSCRIPTION_TIERS.maxCompetitors` (3/5/10/20 per tier). "x" remove exists but no "add" when full. | Source slot limit from `SUBSCRIPTION_TIERS[site.tier].maxCompetitors`. Display "Compare up to N competitors (Tier)". Add "Edit" toggle for add/remove controls. Show source label per competitor (auto-detected vs user-added). |
| F-09 | Pages tab — tiny vuln bars, no severity text | Pages already sorted worst-first (poor→needs-work→good, then by crit+high count desc). But vuln bars are 48x4px — nearly invisible. No severity count text. | Make vuln bars larger (min 80px wide, 8px tall). Add severity count text per page: "2 critical, 3 high". Make page type badges filterable. (Sort is already correct — do not change.) |
| F-10 | Recommendations header count missing CRIT | Header counts only HIGH/MED/LOW, excludes `critical` and `medium` priority values | Count all priority levels: CRIT, HIGH, MED, LOW. Normalize casing before counting. Format: "1 CRIT . 2 HIGH . 5 MED . 2 LOW". |
| F-18 | Tab navigation doesn't update URL | `activeTab` is local state only, no URL hash/path update | Sync `activeTab` with URL hash (`#scorecard`, `#pages`, etc.). Read hash on mount. Update hash on tab change. Support deep linking and browser back/forward. |
| F-24 | Dashboard "Filter domains..." input is dead | `DashboardFilter` uses `document.querySelectorAll("[data-domain]")` DOM mutation. This desyncs with React re-renders (e.g., after sort) | Replace DOM mutation with React-controlled filter. Pass filter state up to parent or use URL search params. Filter must work with 233+ domains. |
| F-27 | Hero metric cards not clickable | Cards are plain `<div>` with no cursor, no click handler | Make each card clickable: AI Visibility -> Citations tab (or scan), GEO Score -> Scorecard tab, Citation Rate -> Citations detail, SOV -> Competitors section, Quality -> expand quality detail. Show `cursor: pointer` and hover lift. |

### MEDIUM

| ID | Finding | Root Cause | Acceptance Criteria |
|----|---------|------------|---------------------|
| F-11 | Scorecard expand affordance weak | Only a tiny "down" arrow. No hover cursor change visible. | Add "Click to expand" on hover. Change cursor to pointer. Default top 2-3 critical pillars to expanded. Make expand icon more prominent. |
| F-12 | Setup tab — domain verification feels abandoned | No status badge, no explanation of what verification enables | Add verified/unverified badge. Add explanation: "Verification enables: automatic schema injection, AI file serving, citation tracking." If optional, say so. |
| F-13 | No empty states for new users | Plain text "Run a GEO audit..." with no visual treatment | Design proper empty state: illustration placeholder, "Your AI visibility report starts here", big CTA "Run Your First Scan (Free)", "Takes about 2 minutes" estimate. |
| F-14 | Credits display confusing — no context | "604 credits" in header with no explanation of costs or how to get more | Add credits tooltip showing: recent transactions (last 5), cost per action, link to pricing. |
| F-15 | Share of Voice chart missing 0% competitors | Only shows competitors with >0% SOV; others hidden | Show all mapped competitors even at 0%. Gray bar for 0% with "Not cited" label. |
| F-16 | No "What should I do first?" CTA | User must synthesize scorecard + recs + pages themselves | Add "Start Here" card at top of Overview: #1 recommendation title, link to its detail, expected impact. |
| F-25 | Mobile chatbot icon covers other icons | ChatWidget positioned bottom-right, overlaps sidebar action buttons on mobile | Increase bottom offset on mobile to clear sidebar buttons. Or hide chatbot on mobile when sidebar is visible. z-index coordination. |

### LOW

| ID | Finding | Root Cause | Acceptance Criteria |
|----|---------|------------|---------------------|
| F-17 | Score History chart minimal | Only dots/bars, no axes, no labels | Add proper x-axis (dates) and y-axis (0-100) labels. Add trend line. Show scan dates clearly. |
| F-19 | Mobile sidebar overlaps content | Sidebar uses `position: fixed` at left, overlaps on narrow viewports | Collapse sidebar to bottom bar on mobile (partially done). Ensure no overlap with main content. |
| F-20 | Page type categorization inconsistent | "FTF -" prefix on titles, "Other" catch-all too broad | Strip domain-prefix from titles. Improve `classifyPageType` for better categorization of "Other" pages. |
| F-21 | No loading states on action buttons | SSE events exist but no skeleton/spinner shown in the tab area after click | Add skeleton loaders in the target area while action is processing. Show progress text sourced from SSE events. |
| F-22 | Chat widget overlaps scorecard last row | ChatWidget bottom-right position conflicts with table content | Add bottom padding/margin to scorecard container to account for chat widget height. |
| F-23 | Font size inconsistency (10-14px) | Inline styles with ad-hoc sizes, no typographic scale | Define typographic scale: 11px (caption), 12px (body-small), 13px (body), 14px (body-large), 16px+ (headings). Apply consistently. |
| F-26a | No delete/archive for sites | Feature doesn't exist | Add archive button per site row in dashboard. Soft-delete via `archivedAt` timestamp in DB. Archived sites hidden from dashboard by default, "Show archived" toggle to reveal. |
| F-26b | No credit transaction log | Feature doesn't exist | Add `/dashboard/credits` page. Query `creditTransactions` table. Show: date, action, amount, balance. Link from credits display in header. |
| F-26c | No scan cancellation | Feature doesn't exist, QStash jobs can't be cancelled mid-flight | **BACKLOG**: Add `cancelledAt` column on `geoSites`. Stage handlers check on entry and bail. Add cancel button during active pipeline. Complex due to QStash fire-and-forget. Defer to separate spec. |
| F-28 | Cards 1 (AI Visibility) and 4 (Competitive SOV) show identical data | Both render `lc?.overallVisibility`. No separate "relative SOV" metric exists in schema. | **Backend prerequisite**: Compute `brand_mentions / (brand + competitor_mentions)` during citation check, store as new field. **Frontend**: Card 4 uses new field. Until backend ships, show "Run Citation Scan" CTA if no data, or label Card 4 honestly as "Your Visibility" to avoid implying competitor comparison. |
| F-29 | Credit cost labels hard-coded in JSX | Literal "10cr", "5cr" strings, not from `ACTION_CREDITS` config | Import `ACTION_CREDITS` from `lib/config.ts`. For fixed-cost actions (citations, competitors, download, PDF), display `ACTION_CREDITS[action]`. For audit refresh, compute dynamic cost: `Math.max(1, Math.ceil(pageCount / PAGES_PER_CREDIT))` credits. |

---

## Architecture: Monolith Extraction

`SitePageClient.tsx` (2,581 lines) must be split before UX fixes are applied.

### Target Structure

```
app/sites/[id]/
  SitePageClient.tsx          # Shell: header, tab nav, tab routing, state coordination (~350 lines)
  hooks/
    useSiteData.ts            # All derived computations from site + citationCheck (~140 lines)
    useSiteActions.ts         # Action handlers: refresh, citations, competitors, download (~250 lines)
  components/
    HeroMetrics.tsx           # 5 KPI cards, clickable (~120 lines)
    ActionSidebar.tsx         # Left rail + mobile bottom bar (~150 lines)
    OverviewTab.tsx           # Health/Evidence/Diagnosis sections (~400 lines)
    ScorecardTab.tsx          # Pillar grid + expand (~150 lines)
    RecommendationsTab.tsx    # Ranked recs + expand (~120 lines)
    PagesTab.tsx              # Per-page vulns + filter/sort/paginate (~300 lines)
    HistoryTab.tsx            # Score timeline + pillar delta breakdown (~200 lines)
    SetupTab.tsx              # AI files + verification + integration (~250 lines)
    ScoreHistory.tsx          # Shared: mini-timeline on Overview + full History (~100 lines)
    ConfirmCreditModal.tsx    # Shared: "Spend N credits?" confirmation (~60 lines)
    EmptyState.tsx            # Shared: illustrated empty state (~40 lines)
    StartHereCard.tsx         # #1 recommendation CTA (~40 lines)
  integration-configs.ts      # Vercel/Netlify/Cloudflare/nginx/WP/Apache templates (~270 lines)
  design-tokens.ts            # COPPER, BG, CARD, BORDER, etc. + type scale (~40 lines)
  types.ts                    # Existing — no change
```

### Extraction Rules
- `useSiteData()` hook encapsulates all derived computations (~30 values from `site` + `lastCitationCheck`). Returns typed object; each tab receives the slice it needs.
- `useSiteActions()` hook encapsulates all action handlers (refresh, citations, competitors, download, PDF, test connection). Returns callbacks + loading/error states.
- Shell coordinates: state declarations, token loading, polling, tab routing, header, domain switcher, status bar.
- Tab-local state (filters, expanded sets, pagination cursors) moves into individual tab components.
- Design tokens and integration config templates extracted to separate files.
- `isMobile` from `useMediaQuery` passed as prop to children that need it (avoids duplicate hook calls).
- **Phase 1**: Extract with zero behavior change — pixel-perfect parity, existing tests pass.
- **Phase 2**: Apply UX fixes to extracted components.

---

## Dependencies

### Backend Prerequisites (must ship before frontend)
- **F-03**: Store `computeProjectedScore()` result from assembler.ts in `projectedScore` DB column. Currently route.ts overwrites with crude calc.
- **F-28**: Compute `brand_mentions / (brand + competitor_mentions)` during citation check, store as new `relativeShareOfVoice` field on `CitationCheckScore`.

### Verified Data Availability
- `ChangeLogEntry.pillarScores` (F-02): Confirmed stored per run at route.ts:938
- `site.projectedScore` column (F-03): Exists in schema, populated by pipeline
- `ACTION_CREDITS` (F-29): Exists in config.ts:62-73
- `SUBSCRIPTION_TIERS.maxCompetitors` (F-08): Exists in config.ts:51-55
- `creditTransactions` table (F-26b): Exists in schema

### Hidden Dependencies (from adversarial review)
- `DomainTableRow` component: Needed for F-24 dashboard filter fix
- `useMediaQuery` hook: Must decide prop-passing vs per-component import
- SSE event schema from `/api/sites/[id]/citation-check`: Needed for F-21 progress states
- `changeLog` sort order: Not guaranteed chronological — must sort by date before rendering (F-02)
- `sortOrder` map gives `critical` and `HIGH` same position (0) — must separate for stable sort (F-10)

---

## Out of Scope

- F-26c (scan cancellation) — deferred to separate spec, requires QStash interrupt design
- F-28 backend computation — separate backend spec, frontend shows honest label until ready
- Redesign of overall page layout/navigation paradigm
- New features beyond those listed

---

## Risk

| Risk | Mitigation |
|------|------------|
| Monolith extraction introduces regressions | Extract with zero behavior change first. Run existing 2700+ test suite. Snapshot test each extracted component. |
| `projectedScore` not populated for existing sites | Hide "Est. after fixes" entirely if null or equal to current. Backfill via cron optional. |
| DashboardFilter replacement breaks 233-domain dashboard | Integration test with 250+ rows. Verify sort + filter + pagination interop. Add debounce (200ms). |
| Credit confirmation modal reduces action rate | Session-scoped opt-out (not localStorage — adversarial review flagged cross-device risk). |
| F-01 + F-05 layout conflict | Resolved by unified Overview layout wireframe above. |
