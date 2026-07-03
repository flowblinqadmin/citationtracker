# TS-064: Site Report — Chrome & Layout Final Match

## Status: READY
## Priority: 2
## Scope: SitePageClient.tsx — header, tabs, rail, audit bar, domain switcher (NOT tab content)

---

## What
Verify and fix the persistent UI shell of the site report page against `GEODashboardRedesignMockup-FINAL.html`.

## Why
The chrome was rebuilt in this session with several rounds of corrections. This spec captures remaining known gaps so nothing is missed.

## Current State (what's already done)
- Header: ✅ 56px, #FAF9F5, rgba border, 3-zone layout, 10px 24px padding
- Back button: ✅ 22px, 300wt, T2 color
- Domain + chevron: ✅ 15px, 600wt, TEXT color, popover
- Center brand: ✅ 17px, 700wt, 3px letter-spacing, copper
- Credits badge: ✅ gradient, 20px radius, ✦ icon
- Tabs: ✅ 13px, 500wt, active = TEXT color + copper underline
- Rail: ✅ 78px, 12px 6px padding, 4px gap, pill border-radius, compound shadow
- Rail items: ✅ 8px 4px padding, 66px width, 10px radius
- Rail credit badges: ✅ copper-tinted bg, copper text
- Audit bar: ✅ 20px circles, ✓ for done, gradient connectors, progress bar + %
- Domain switcher: ✅ popover with search, 320px min-width

## Remaining Gaps

### 1. Back button color
- **Mockup inline**: `color: rgb(134, 134, 139)` (T2 = #86868b) BUT the CSS override says `color: #C2652A !important`
- **Resolution**: The flowblinq-v2 override at line 237 says `.hdr-l .back { color: #C2652A !important; }` — so the FINAL back button should be copper
- **Implementation**: Currently T2 — needs change to COPPER

### 2. Audit bar sticky top
- **Mockup**: `top: 52px` (CSS base hdr height) but header is overridden to 56px by !important
- **Resolution**: Use 56px for consistency with our header
- **Implementation**: ✅ Already 56px

### 3. Domain switcher strip
- **Mockup**: `.domain-switcher { display: none !important; }` — hidden
- **Implementation**: ✅ Not rendered (replaced by header popover)

### 4. Rail icon SVG size
- **Mockup**: `.rail-icon svg { width: 18px; height: 18px; stroke-width: 1.8 }`
- **Implementation**: Using 16×16 with 1.5 stroke-width
- **Fix**: Change to 18×18 with 1.8 stroke-width

### 5. Rail hover states
- **Mockup**: `.rail-item:hover { background: #f0f0f2 }` and `.rail-item:hover .rail-label { color: var(--text) }`
- **Implementation**: No hover state on rail items
- **Fix**: Add state management for hovered rail item

### 6. Rail icon hover backgrounds
- **Mockup**: Refresh hover `#c8e6c9`, Cite hover `#d1c4e9`, Compete hover `#ffe0b2`, Download hover `#bbdefb`
- **Implementation**: No icon bg change on hover
- **Fix**: Add hover state that darkens the icon background

### 7. Content padding-left
- **Mockup**: `.db { padding-left: 92px !important }`
- **Implementation**: ✅ Already 92px

### 8. Sign-out button style
- **Mockup**: `font-size:12px;color:var(--t2)` (inline override — smaller, muted)
- **Implementation**: Using SignOutButton component defaults
- **Fix**: Pass size/color props or override inline

## Files to Modify
1. `app/sites/[id]/SitePageClient.tsx` — back button color, SVG sizes, rail hover, sign-out style

## Acceptance Criteria
- Chrome matches mockup pixel-for-pixel
- All interactive states (hover, popover) work
- Docker build succeeds

## Risks
- Low risk — CSS-only changes to existing elements
