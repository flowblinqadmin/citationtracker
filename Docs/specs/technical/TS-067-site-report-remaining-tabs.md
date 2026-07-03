# TS-067: Site Report — Pages, History & Setup Tabs Rebuild

## Status: READY
## Priority: 1
## Scope: SitePageClient.tsx pages, history, and setup tab bodies

---

## What
Rebuild the pages, history, and setup tabs to match `GEODashboardRedesignMockup-FINAL.html`.

## Why
These tabs exist in the current implementation but their styling diverges from the mockup. The pages tab needs filter pill buttons (not underline-style), the history tab currently delegates to CitationHistory component (which has its own layout), and the setup tab needs file cards + verification flow matching the mockup.

---

## Pages Tab (mockup lines ~1101–1120 CSS, HTML structure)

### Current Implementation
- Status filter buttons (underline style, copper active)
- Search input
- Table with URL, status, fixes columns
- Pagination (prev/next + "X–Y of Z")

### Mockup Design

**Controls row** (`.pg-controls`):
- `display: flex; align-items: center; gap: 8px; margin-bottom: 12px; justify-content: space-between`

**Filter buttons** (`.pg-filter`):
- Base: `font-size: 12px; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--card); cursor: pointer; font-weight: 500`
- Active: `background: #C2652A; color: #fff; border-color: #C2652A` (!important override from blue)
- Layout: flex with 4px gap
- Items: All, Good, Needs Work, Poor (with counts)

**Search input** (`.pg-search`):
- `font-size: 13px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border); width: 260px; outline: none`
- Focus: `border-color: #C2652A` (!important)

**Table** (`.pg-table`):
- Header: `font-size: 10px; font-weight: 600; color: var(--t3); uppercase; letter-spacing: .5px; padding: 8px 0; border-bottom: 1px solid var(--border); cursor: pointer`
- Cells: `padding: 8px 0; font-size: 13px; border-bottom: 1px solid #f0f0f2`
- URL column: `color: var(--blue) → #C2652A; max-width: 500px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px`
- Status badge: `font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; text-transform: uppercase`
  - Needs work: `background: #fff8e1; color: #e65100`
  - Poor: `background: #fef2f2; color: var(--red)`
  - Good: `background: #e8f5e9; color: #2e7d32` (implied)
- Fixes column: `font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; background: #fef2f2; color: var(--red)` (only shown if fixes > 0)

**Pagination** (`.pg-pag`):
- `display: flex; align-items: center; gap: 8px; justify-content: center; margin-top: 16px`
- Buttons: `.btn` base style, `font-size: 12px; padding: 4px 10px`
- Counter: `font-size: 12px; color: var(--t2)`

### Key Differences from Current
1. Filter buttons: pill style (filled active) instead of underline
2. Search width: 260px (current may differ)
3. Table th padding: 8px 0 (not 10px 16px)
4. Table td padding: 8px 0 (not 10px 16px)
5. Status badge: 4px radius (not 100/pill)
6. URL color: copper (not blue, from !important override)

---

## History Tab (mockup lines ~1121–1132 CSS)

### Current Implementation
- "Refresh Score" button
- Delegates to `<CitationHistory>` component which renders:
  - Sparkline SVG chart
  - Check history table
  - Provider consistency table
  - Top competitors list

### Mockup Design

**History rows** (`.hist-row`):
- `display: flex; align-items: center; padding: 12px 0; border-bottom: 1px solid #f0f0f2; gap: 16px`

**Row elements**:

| Element | Class | Styles |
|---------|-------|--------|
| Date | `.hist-date` | `font-size: 13px; font-weight: 600; width: 140px; flex-shrink: 0` |
| Score | `.hist-score` | `font-size: 20px; font-weight: 700; width: 50px; flex-shrink: 0` |
| Delta | `.hist-delta` | `font-size: 12px; font-weight: 600; width: 60px; flex-shrink: 0` — .up=green, .dn=red, .flat=T3 |
| Progress bar | `.hist-bar` | `flex: 1; height: 6px; background: #f0f0f2; border-radius: 3px; overflow: hidden` |
| Bar fill | `.hist-fill` | `height: 100%; border-radius: 3px` — colored by score |

**Empty state** (`.hist-empty`):
- `text-align: center; padding: 60px 20px`
- SVG icon: 64×64, opacity 0.3
- Title: `font-size: 15px; font-weight: 600; margin-bottom: 6px`
- Subtitle: `font-size: 13px; color: var(--t2); max-width: 360px; margin: 0 auto`

### Key Differences from Current
1. **Remove CitationHistory component** from this tab
2. Replace with simple history rows (date, score, delta, bar)
3. Data source: `citationHistory` prop — iterate and show each check
4. Delta computed as difference from previous check's score
5. No sparkline, no provider table, no competitor ranking — just clean rows
6. Empty state if no history

---

## Setup Tab (mockup lines ~1133–1151 CSS)

### Current Implementation
- AI Files section (list of file links)
- Domain verification section (DNS record + verify button)

### Mockup Design

**Section container** (`.setup-section`):
- `margin-bottom: 24px`
- Heading: `font-size: 15px; font-weight: 600; margin-bottom: 12px`

**File cards** (`.setup-files` grid):
- `display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin-bottom: 8px`
- Each card (`.setup-file`):
  - `background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; box-shadow: var(--sh)`
  - File name: `font-size: 13px; font-weight: 600; color: #C2652A; margin-bottom: 2px` (copper, not blue)
  - File path: `font-size: 11px; color: var(--t2)`

**Status indicator** (`.setup-status`):
- `display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; margin-bottom: 16px`
- Green dot: `8px; border-radius: 50%; background: var(--green)`

**Setup steps** (`.setup-steps`):
- Numbered list (CSS counter)
- Each step: `display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid #f0f0f2; font-size: 13px`
- Step number: `11px; 700wt; T3; #f0f0f2 bg; 24px circle; border-radius: 50%`

**Code block** (`.setup-code`):
- `background: #f0f0f2; border-radius: 8px; padding: 12px 16px; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; margin-top: 12px; display: flex; justify-content: space-between; align-items: center`
- Copy button: `font-size: 11px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--card)`
- Copy hover: `background: #C2652A; color: #fff; border-color: #C2652A` (!important override)

**Verify button** (`.verify-btn`):
- `background: #C2652A; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 12px` (!important override)
- Hover: `opacity: .85`

### Key Differences from Current
1. File cards: grid layout with cards (current is likely a list)
2. File name color: copper (not blue)
3. Setup steps: numbered circles + bordered rows
4. Code block: styled with copy button that turns copper on hover
5. Verify button: copper bg (not dark)

---

## Files to Modify
1. `app/sites/[id]/SitePageClient.tsx` — rewrite pages tab (~937-1038), history tab (~1041-1056), setup tab (~1059-1115)

## Components to Remove from Tab Render
- `<CitationHistory>` — currently rendered in history tab → replaced with inline rows

## Acceptance Criteria
1. Pages: pill-style filter buttons (copper active), 260px search, table with 8px padding, copper URLs, proper status badges
2. History: simple flex rows (date, score, delta, bar) or empty state — no sparklines/provider tables
3. Setup: file cards in grid, numbered steps, copper verify button, copy-to-clipboard code block
4. All tabs handle empty/null data gracefully
5. Docker build succeeds

## Data Field Corrections (VERIFIED)

### Pages Tab
- **Status field**: Not `status` — use `overallPageHealth` ("good" | "needs-work" | "poor")
- **Fixes count**: Count `perPageFixes[matching url].pillarFixes.length` or `vulnerabilities.length`
- **URL display**: Available as `perPageResults[].url`
- **Free tier**: `perPageResults` is null — show "Upgrade to see per-page analysis"

### History Tab
- **GEO audit score history**: Use `site.changeLog` (jsonb ChangeLogEntry[]), NOT `citationHistory`
  - Each entry: `{ runAt: string, overallScore: number, projectedScore: number, pillarScores: Record<string, number> }`
  - Delta computed as: `entry[i].overallScore - entry[i-1].overallScore`
  - Up to 52 entries (last 52 runs)
- **Citation check history** (`citationHistory` prop): Still available for potential future use, but the mockup shows GEO score history, not citation scores
- **If changeLog is null/empty**: Show empty state

### Setup Tab
- **File fields** (all on site object): `generatedLlmsTxt`, `generatedLlmsFullTxt`, `generatedBusinessJson`, `generatedSchemaBlocks`
- **Verification**: `domainVerified` (boolean), `verifyToken` (string)
- **Free tier**: All generated file fields are null — show "Upgrade" or "Not generated" state

## Risks
- **History data**: ✅ RESOLVED — Use `site.changeLog` for GEO audit score history, not `citationHistory`
- **Setup tab data**: File generation fields are populated after pipeline completion. Show "Not generated yet" for null fields.
- **Free tier gating**: Pages tab shows null perPageResults, setup tab shows null files — need appropriate empty states
