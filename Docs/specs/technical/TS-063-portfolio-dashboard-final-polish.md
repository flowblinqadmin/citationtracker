# TS-063: Portfolio Dashboard — Final Polish

## Status: READY
## Priority: 2 (depends on TS-064-067 for site report being the main gap)
## Scope: /home/aditya/flowblinq/geo/app/dashboard/

---

## What
Fix remaining pixel-level discrepancies between the portfolio dashboard implementation and `GEOPortfolioDashboardMockup-FINAL.html`.

## Why
The chrome (header, KPI cards, table structure, row actions) was rebuilt in the current session but some values were taken from CSS class definitions rather than the final computed values with inline overrides. A few items were missed.

## Current State (what's already done)
- Header: ✅ warm white #FAF9F5, rgba border, sticky, copper logo
- Credits badge: ✅ copper gradient, ✦ icon, 20px radius
- KPI cards: ✅ 11px uppercase labels, 28px values, 12px gap, box-shadow
- Table: ✅ card container with shadow, T3 header color, 10px font, 14px padding
- DomainTableRow: ✅ 28×28 icon, 13px domain, 9px tier badge, 12px date, pipeline steps
- RowActions: ✅ 28×28 buttons, per-action hover backgrounds+colors, T3 default
- Scanning row: ✅ warm gradient, copper inset border, pipeline widget

## Remaining Gaps

### 1. Table thead background
- **Mockup**: `.ptable thead { background: #fafafa }`
- **Implementation**: No explicit thead background
- **Fix**: Add `background: "#fafafa"` to `<thead>` in page.tsx

### 2. Table row hover
- **Mockup**: `rgba(194, 101, 42, 0.03)` (!important warm tint)
- **Implementation**: No hover state (SSR table)
- **Fix**: This is a client-side concern. DomainTableRow is already "use client" — add onMouseEnter/Leave for subtle bg change. Low priority.

### 3. Score number color per value
- **Mockup**: Score number itself is colored (green for ≥60, orange for 40-59, red for <40)
- **Implementation**: Score number is always TEXT color, only bar is colored
- **Fix**: Add `color: scoreColor(liveScore)` to score number span

### 4. Score bar track color
- **Mockup**: `#f0f0f2` (slightly warm gray)
- **Implementation**: ✅ Already `#f0f0f2` in DomainTableRow

### 5. SVG icons stroke-width
- **Mockup**: `stroke-width: 2.5` for some icons (audit, zip, report)
- **Implementation**: All use `1.5`
- **Fix**: Increase to `2` for closer match (exact 2.5 may look thick in 16×16 viewport)

### 6. Action strip gap
- **Mockup**: `gap: 8px` with `flex: 1` spacer between button and filter
- **Implementation**: `gap: 12` with no spacer
- **Fix**: Change gap to 8, add `<div style={{ flex: 1 }} />` between button and filter

### 7. Empty state button
- **Mockup**: Primary button = copper, 13px, 8px/16px padding, 8px radius
- **Implementation**: 15px font, 12px/28px padding, 10px radius — larger
- **Fix**: Match mockup values

## Files to Modify
1. `app/dashboard/page.tsx` — thead bg, action strip gap, empty state button
2. `app/dashboard/DomainTableRow.tsx` — score number color
3. `app/dashboard/RowActions.tsx` — SVG stroke-width (optional)

## Acceptance Criteria
- Side-by-side screenshot comparison shows no visible difference from mockup
- All existing tests pass
- Docker build succeeds

## Risks
- Low risk — these are minor CSS value changes
- No structural or data changes required
