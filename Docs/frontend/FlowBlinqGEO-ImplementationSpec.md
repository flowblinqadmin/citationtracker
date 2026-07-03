# FlowBlinq GEO — Frontend Implementation Spec
## Design System & Component Breakdown for Agent Handoff
### Generated: March 25, 2026

---

## 1. DESIGN SYSTEM

### 1.1 CSS Variables (shared across both pages)
```css
:root {
  --bg: #f5f5f7;         /* Page background */
  --card: #fff;           /* Card/panel background */
  --text: #1d1d1f;        /* Primary text */
  --t2: #86868b;          /* Secondary text */
  --t3: #aeaeb2;          /* Tertiary/muted text */
  --border: #e5e5ea;      /* Borders and dividers */
  --orange: #ff9500;      /* Accent (warnings, highlights) */
  --green: #34c759;       /* Success/complete */
  --copper: #c2652a;      /* Brand primary (CTAs, active states, progress) */
  --copper-light: #d4803e;/* Brand secondary (gradient end) */
  --copper-bg: #fff7ed;   /* Warm background tint for scanning rows */
  --copper-badge-bg: #fff3e0; /* Badge background for scanning state */
  --r: 12px;              /* Standard border-radius */
}
```

### 1.2 Typography
- Font stack: `system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
- Note for production: The main marketing website (flowblinq.com) uses Inter. Consider migrating dashboard to Inter for visual language alignment.
- Heading style: Uppercase labels use `font-size: 11px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; color: var(--t2)`
- Body text: 13px, weight 400, color var(--text)
- Numerical emphasis: Large numbers use 28-36px, weight 700

### 1.3 Brand Mark
- Logo: FlowBlinq code-brackets icon (dark blue circle, 28x28px) + "FLOWBLINQ GEO" text
- Logo text: 16px, weight 700, color var(--copper), letter-spacing 2.5px
- Logo image source: /assets/logo.png (611x611 native, render at 28x28)

### 1.4 Credits Badge (appears on both pages)
```css
.credits-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  background: linear-gradient(135deg, #c2652a, #d4803e);
  color: #fff;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  transition: all 0.2s;
}
.credits-badge:hover {
  background: linear-gradient(135deg, #a8551f, #c2652a);
  box-shadow: 0 2px 8px rgba(194, 101, 42, 0.3);
  transform: translateY(-1px);
}
```
- Prefix sparkle character: ✦
- Text format: "✦ 8,983 credits"
- Links to: Stripe checkout page

---

## 2. CUSTOM SVG ICONS

### 2.1 Rerun Citations Icon (custom @-arrow icon)
Used in both the portfolio dashboard (table row actions) and the individual report (action rail).
```svg
<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="11" cy="11" r="3"/>
  <path d="M18 11a7 7 0 1 0-2.8 5.6"/>
  <path d="M14 11v2.5c0 .8.7 1.5 1.5 1.5"/>
  <path d="M15.2 16.6 L 22 16.6"/>
  <polyline points="19.5 14.3 22 16.6 19.5 18.9"/>
</svg>
```
- Portfolio dashboard size: 17x17px
- Action rail size: 18x18px (inside 32x32 container)
- Concept: @ symbol with outer spiral, lower arm extends right ending in arrowhead (signifies "rerun citation lookup")

### 2.2 Rerun Audit Icon
Standard circular arrow SVG:
```svg
<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 2v6h-6"/>
  <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
  <path d="M3 22v-6h6"/>
  <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
</svg>
```

### 2.3 Download ZIP Icon
```svg
<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="7 10 12 15 17 10"/>
  <line x1="12" y1="15" x2="12" y2="3"/>
</svg>
```

### 2.4 Download Report Icon
```svg
<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
  <polyline points="14 2 14 8 20 8"/>
  <line x1="16" y1="13" x2="8" y2="13"/>
  <line x1="16" y1="17" x2="8" y2="17"/>
</svg>
```

---

## 3. PAGE 1: PORTFOLIO DASHBOARD

### 3.1 Layout Structure
```
.hdr                          (fixed top bar, 52px height)
  .hdr-l > .logo              (FlowBlinq GEO logo + text)
  .hdr-r > email + .credits-badge + Sign out

.kpi-row                      (4 KPI cards in horizontal grid)
  KPI: Total Sites | Avg GEO Score | Total Critical Issues | Credits Remaining

.actions-strip                (action bar)
  button.primary "Run new audit"
  [spacer]
  input "Filter domains..."

.table-section
  .subhead "N domains · sorted by score"
  table
    thead: Domain | GEO Score | Tier | Citations | Critical | Delta | Last Scan | (actions/status)
    tbody: rows...
```

### 3.2 Header
- Left: Logo icon (28x28) + "FLOWBLINQ GEO" (copper, 16px, 700 weight, 2.5px letter-spacing)
- Right: Email address (13px, var(--t2)) + Credits badge (copper gradient pill) + "Sign out" button

### 3.3 KPI Cards
- White cards with 1px var(--border) border, border-radius var(--r)
- Credits Remaining card has copper left border (3px solid var(--copper))
- Label: 11px uppercase, letter-spacing 1.5px, color var(--t2)
- Value: 28px, weight 700
- Subtitle: 12px, color var(--t2). Exception: "1 scan in progress" subtitle in copper when active scan exists

### 3.4 Table Row — Complete State
Each completed row shows 8 columns:
1. Domain: Monogram circle (28x28, colored bg, white text) + domain name (13px, 600) + page count subtitle (11px, var(--t2))
2. GEO Score: Numeric score (16px, 700) + colored progress bar
3. Tier: Colored badge pill — GOOD (#34c759), FAIR (#ff9500), WEAK (#ff3b30), POOR (#ff2d55)
4. Citations: Bullet + percentage
5. Critical: Integer count, red if >= 5
6. Delta: Signed number, green if positive, red if negative, dash if no change
7. Last Scan: Date string
8. Actions: 4 always-visible icon buttons

### 3.5 Per-Row Action Icons
Actions appear in the last column of every completed row. They are ALWAYS visible (not hover-only).
```css
.row-actions { display: flex; align-items: center; gap: 4px; }
.row-act-sep { width: 1px; height: 16px; background: var(--border); margin: 0 4px; }
.row-act {
  width: 28px; height: 28px; border: none; background: transparent;
  border-radius: 6px; cursor: pointer; color: var(--t3);
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
```

4 actions in order:
1. Rerun Audit (circular-arrow icon, 17px) — hover color: var(--copper)
2. Rerun Citations (@-arrow custom icon, 17px) — hover color: #007aff (blue)
3. -- separator --
4. Download ZIP (download icon, 17px) — hover color: var(--green)
5. Download Report (document icon, 17px) — hover color: #5856d6 (purple)

Each icon has a tooltip via CSS ::after pseudo-element using data-tip attribute.

### 3.6 Table Row — Scanning State (New Audit)
```css
.row-scanning {
  background: #fff7ed;
  box-shadow: inset 3px 0 0 #c2652a;
}
```
- Domain cell: monogram + domain name + subtitle "Discovering pages..." in copper
- Score: dash
- All data cells: dash
- Last Scan: "Now"
- Status column: Pipeline status (see 3.8)

### 3.7 Table Row — Scanning State (Refresh Audit)
- Background: same warm tint
- Score: shown at 0.4 opacity with gray underlay bar
- Tier/Citations/Critical: still visible (from prior scan)
- Last Scan: "Refreshing"
- Status column: Pipeline status

### 3.8 Pipeline Status (in Status Column)
```css
.pipeline-status { display: flex; flex-direction: column; gap: 4px; min-width: 140px; }
```
- Top line: pulsing copper dot (CSS animation) + "STEP N OF 6" label (10px, copper, uppercase)
- Progress bar: 6 segment divs — done=green, active=orange pulsing, pending=gray
- Bottom label: Step name (10px, var(--t2))

6 Pipeline Steps: Discovering pages, Reading content, Landscape analysis, Running audit, Building profile, Finalizing

---

## 4. PAGE 2: INDIVIDUAL REPORT

### 4.1 Layout Structure
```
.hdr                          (fixed top bar, ~44px)
  .hdr-l                      (leading: back chevron + domain switcher)
  .hdr-brand-center           (center: FLOWBLINQ GEO wordmark, absolute)
  .hdr-r                      (trailing: credits badge + sign out)

.audit-status-bar             (sticky below header — shown ONLY during active scan)

#tabBar.tabs                  (6 tabs)

.domain-switcher              (horizontal domain list)

.action-rail-v2               (fixed left rail)

.db                           (main content, left-padded ~80px)
```

### 4.2 Header — Apple HIG Three-Zone Toolbar
Single horizontal line following Apple HIG toolbar pattern.

Leading zone: back-chevron + domain-name + dropdown-indicator
```
< manipalhospitals.com v
```
- Back chevron: 22px, weight 300, color var(--t2). On hover: color var(--text). Navigates to portfolio dashboard.
- Domain name: 15px, weight 600, color var(--text). Clickable, opens domain switcher dropdown.
- No vertical stacking. Everything on one horizontal line.

Center zone (absolute positioned):
- "FLOWBLINQ GEO" wordmark: 17px, weight 700, letter-spacing 3px, color var(--copper)

Trailing zone:
- Credits badge (copper gradient pill, links to Stripe checkout)
- "Sign out" text button

### 4.3 Audit Status Bar (Conditional)
Only shown during active scan. Sticky at top: 52px.
```css
.audit-status-bar {
  position: sticky; top: 52px; z-index: 90;
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 24px;
  background: linear-gradient(135deg, #fffbf5, #fff7ed);
  border-bottom: 1px solid #f0e0d0;
}
```

Left: pulsing copper dot + "Refreshing audit" (14px, 600, copper) + "99 pages · started 1 min ago" (12px, var(--t2))
Center: 6-step pipeline visualization (numbered circles connected by lines)
Right: progress bar (120px, 4px tall) + percentage + time estimate

### 4.4 Tab Bar
6 tabs: Overview | Scorecard | Recommendations | Pages | History | Setup
```css
.tab { padding: 10px 18px; font-size: 13px; font-weight: 500; color: var(--t2); border-bottom: 2px solid transparent; }
.tab.active { color: var(--copper); border-bottom-color: var(--copper); font-weight: 600; }
```
Tab-to-view mapping: Overview->view-overview, Scorecard->view-scorecard, Recommendations->view-recs, Pages->view-pages, History->view-history, Setup->view-setup

### 4.5 Left Action Rail
Fixed, vertically centered on left edge.
```css
.action-rail-v2 {
  position: fixed; top: 50%; left: 0; transform: translateY(-50%);
  width: 78px; padding: 12px 6px;
  background: var(--card); border-radius: 0 14px 14px 0;
  box-shadow: 2px 0 12px rgba(0,0,0,0.06);
  display: flex; flex-direction: column; gap: 4px; z-index: 80;
}
```

5 buttons with separator between action group and download group:

| Action | Icon | Container BG | Icon Color | Credit Badge |
|--------|------|-------------|------------|--------------|
| Refresh Score | circular-arrows | #e8f5e9 | #34c759 | — |
| Scan Citations | @-arrow custom | #ede7f6 | #5856d6 | 5cr |
| Map Competitors | people-plus | #fff3e0 | #ff9500 | 2cr |
| -- separator -- | 1px line | | | |
| Download ZIP | download-arrow | #e3f2fd | #007aff | — |
| Download Report | document | #fce4ec | #e91e63 | — |

Credit badges appear below label text as subtle copper pills (8px, rgba copper bg).

### 4.6 Stats Row
```
99 pages crawled · 108 Q&A moments · 16 pillars · 7 critical issues · Last scanned Mar 23, 2026
```
When scanning: append "Scores will update when scan completes" in copper

### 4.7-4.12 Tab Content
See the finalized mockup HTML files for exact content structure of each tab:
- Overview: 5 KPI cards, competitor chips, score history chart, citation visibility bars, critical issues table, SOV/geo/category/intent panels, top recommendations
- Scorecard: All 16 pillars with severity filter
- Recommendations: 10 items sorted by priority (HIGH/MED/LOW), expandable
- Pages: Searchable/filterable table with pagination (97 pages, 5 pages)
- History: Score history table + refresh button
- Setup: AI files listing + domain DNS verification flow

---

## 5. INTERACTION BEHAVIORS

### 5.1 Domain Switcher (Header)
- Click domain name -> dropdown with search + domain list with page counts
- Selecting navigates to that domain's report

### 5.2 Action Rail Buttons
- Refresh Score: POST /api/sites/:id/audit -> starts scan -> shows audit status bar
- Scan Citations: POST /api/sites/:id/citations (costs 5 credits)
- Map Competitors: POST /api/sites/:id/competitors (costs 2 credits)
- Download ZIP: GET -> downloads AI files as ZIP
- Download Report: GET -> downloads PDF report

### 5.3 Pipeline Status Transitions
1. Audit starts -> status bar slides in, header shows "Scanning" badge
2. Pipeline steps animate through 6 stages (real-time via WebSocket)
3. On completion: status bar collapses, badge returns to "Complete", data refreshes

### 5.4 Credits Badge
- Shows current balance, click navigates to Stripe checkout
- Balance updates after credit-consuming actions

---

## 6. DATA CONTRACT (Frontend <-> Backend)

### 6.1 Portfolio Dashboard Data
```typescript
interface DashboardData {
  user: { email: string; credits: number };
  sites: Site[];
  scanning: ScanStatus[];
}
interface Site {
  id: string;
  domain: string;
  pageCount: number;
  geoScore: number;
  tier: 'GOOD' | 'FAIR' | 'WEAK' | 'POOR';
  citationRate: number;
  criticalIssues: number;
  delta: number | null;
  lastScan: string;
}
interface ScanStatus {
  siteId: string;
  domain: string;
  step: 1 | 2 | 3 | 4 | 5 | 6;
  stepName: string;
  isNewSite: boolean;
  startedAt: string;
  estimatedMinutes: number;
}
```

### 6.2 Individual Report Data
```typescript
interface ReportData {
  site: Site;
  overview: {
    aiVisibility: number;
    geoAuditScore: number;
    estAfterFixes: number;
    citationRate: { total: number; perEngine: Record<string, string> };
    competitiveSOV: { score: number; leaders: Record<string, number> };
    citationQuality: number;
  };
  competitors: string[];
  scoreHistory: { date: string; score: number }[];
  citationVisibility: Record<string, number>;
  criticalIssues: { pillar: string; score: number; finding: string }[];
  pillars: Pillar[];
  recommendations: Recommendation[];
  pages: PageResult[];
  aiFiles: AIFile[];
  domainVerified: boolean;
  scanStatus?: ScanStatus;
}
interface Pillar { name: string; severity: 'Poor'|'Weak'|'Fair'|'Good'; description: string; }
interface Recommendation { priority: 'HIGH'|'MED'|'LOW'; pillar: string; timeEstimate: string; problem: string; action: string; boost: string; }
interface PageResult { path: string; fixes: number; status: 'good'|'needs work'|'poor'; }
interface AIFile { name: string; servedAt: string; details?: string; }
```

### 6.3 API Endpoints
```
GET  /api/dashboard              -> DashboardData
GET  /api/sites/:id/report       -> ReportData
POST /api/sites/:id/audit        -> { scanId }
POST /api/sites/:id/citations    -> { success } (5 credits)
POST /api/sites/:id/competitors  -> { success } (2 credits)
GET  /api/sites/:id/download/zip -> binary ZIP
GET  /api/sites/:id/download/pdf -> binary PDF
GET  /api/sites/:id/scan-status  -> ScanStatus | null
WS   /api/sites/:id/scan-stream  -> real-time ScanStatus (WebSocket)
POST /api/credits/checkout        -> { stripeUrl }
GET  /api/user/credits            -> { credits: number }
```

---

## 7. APPLE HIG COMPLIANCE NOTES

1. Toolbar three-zone layout (Leading / Center / Trailing) per HIG Toolbars > Item Groupings
2. Back chevron only — no text label per HIG Toolbars > Navigation
3. Domain switcher as document menu — next to title per HIG Toolbars > Leading Edge
4. Always-visible action icons — not hover-gated per HIG Accessibility + Pointing Devices
5. Single action surface — actions in rail only, not duplicated in header per HIG Toolbars
6. Pipeline status as Live Activity — deterministic progress per HIG Live Activities
7. View title under 15 characters per HIG Toolbars > Titles
8. Credits badge as prominent trailing action per HIG Toolbars > Actions

---

## 8. VISUAL REFERENCE FILES

Open these finalized HTML mockups in a browser to see the exact target state:
- GEOPortfolioDashboardMockup-FINAL.html
- GEODashboardRedesignMockup-FINAL.html

All CSS is inline in style tags. No external dependencies except the logo.png image.
