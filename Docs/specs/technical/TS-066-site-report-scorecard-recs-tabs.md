# TS-066: Site Report — Scorecard & Recommendations Tabs Rebuild

## Status: READY
## Priority: 1
## Scope: SitePageClient.tsx scorecard and recommendations tab bodies

---

## What
Rebuild the scorecard and recommendations tabs to match `GEODashboardRedesignMockup-FINAL.html`.

## Why
The current implementations are functional but visually diverge from the mockup:
- **Scorecard**: has basic pillar rows (name | score | bar) but missing tier badges, descriptions, full-width bar, and the card wrapper
- **Recommendations**: has expand/collapse but missing checkboxes, numbered rows, time estimates, action blocks, and boost text

---

## Scorecard Tab (mockup lines 1123–1152)

### Current Implementation
```
[Tier filter buttons: All | Poor | Weak | Fair | Good]
[Pillar rows: name ← | → score + 60px bar]
  [Optional findings text below]
```

### Mockup Design

**Wrapper**: Single card panel (`.pn`) — `background: var(--card); border-radius: 12px; padding: 18px 20px; box-shadow: var(--sh); border: 1px solid var(--border); margin-bottom: 16px`

**Header row** (flex, space-between, margin-bottom 16px):
- Left: Title `"All N Pillars"` — panel title style (12px, 600wt, T2, uppercase)
- Right: Filter buttons

**Filter buttons** (`.pg-filter`):
- Base: `font-size: 12px; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--card); cursor: pointer; font-weight: 500`
- Active (`.pg-filter.act`): `background: var(--blue) → #C2652A; color: #fff; border-color: #C2652A`
- Layout: flex with 4px gap
- Items: "All", "Poor (N)", "Weak (N)", "Fair (N)" — only shown if count > 0

**Pillar rows** (`.sc-full-row`):
- Layout: `display: flex; align-items: center; padding: 10px 0; border-bottom: 1px solid #f0f0f2; gap: 12px; cursor: pointer`
- Hover: `background: #fafafa; margin: 0 -8px; padding: 10px 8px; border-radius: 6px`

**Row elements (left to right)**:

| Element | Class | Styles |
|---------|-------|--------|
| Pillar name | `.sc-name` | `font-size: 13px; font-weight: 500; width: 180px; flex-shrink: 0` |
| Progress bar track | `.sc-bar-wrap` | `flex: 1; height: 8px; background: #f0f0f2; border-radius: 4px; overflow: hidden` |
| Progress bar fill | `.sc-bar-fill` | `height: 100%; border-radius: 4px; transition: width .4s` — colored red/orange/yellow/green |
| Score | `.sc-score` | `font-size: 14px; font-weight: 700; width: 32px; text-align: right; flex-shrink: 0; tabular-nums` — colored |
| Tier badge | `.sc-badge` | `font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; width: 52px; text-align: center; flex-shrink: 0` |
| Description | `.sc-desc` | `font-size: 11px; color: var(--t2); width: 280px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap` |

**Tier badge colors**:
- Poor: `background: #fef2f2; color: var(--red)`
- Weak: `background: #fff8e1; color: #e65100`
- Fair: `background: #e8f5e9; color: #2e7d32`

**Score colors**:
- `.s-r` (red): `color: var(--red)` — scores < 35
- `.s-o` (orange): `color: var(--orange)` — scores 35-54
- `.s-g` (green): `color: var(--green)` — scores ≥ 55

**Bar fill colors**:
- `.fr` (red): `background: var(--red)`
- `.fo` (orange): `background: var(--orange)`
- `.fy` (yellow): `background: var(--yellow)` (#e6b800)
- `.fg` (green): `background: var(--green)`

### Data Source
- `scorecard.pillars` — array of `{ pillar, pillarName, score, findings, priority }`
- Tier derived from score: <25=Poor, 25-49=Weak, 50-74=Fair, ≥75=Good
- Sorted by score ascending (worst first) in mockup

---

## Recommendations Tab (mockup lines 1153–1199+)

### Current Implementation
```
[Expand/Collapse All button]
[Cards: priority badge | title | pillar · estimated boost]
  [Expanded: description text]
```

### Mockup Design

**Header row** (flex, space-between, margin-bottom 16px):
- Left: Title `"N Recommendations — sorted by priority"` — panel title style
- Right: Summary `"3 HIGH · 5 MED · 2 LOW"` — 12px, T2

**Recommendation cards** (`.rec-card`):
- Container: `background: var(--card); border-radius: 12px; border: 1px solid var(--border); box-shadow: var(--sh); margin-bottom: 8px; overflow: hidden`

**Card header** (`.rec-header`):
- Layout: `display: flex; align-items: center; padding: 14px 18px; gap: 12px; cursor: pointer`
- Hover: `background: #fafafa`

**Header elements (left to right)**:

| Element | Class | Styles |
|---------|-------|--------|
| Checkbox circle | `.rc` | `width: 18px; height: 18px; border: 2px solid var(--border); border-radius: 50%; flex-shrink: 0; cursor: pointer; transition: all .15s` |
| Checkbox hover | `.rc:hover` | `border-color: var(--blue) → #C2652A` |
| Checkbox done | `.rc.done` | `background: var(--green); border-color: var(--green)` |
| Rank number | `.rr` | `font-size: 12px; font-weight: 700; color: var(--t3); width: 20px; text-align: center; flex-shrink: 0` |
| Priority badge | `.rip` | `font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; flex-shrink: 0; width: 48px; text-align: center` |
| Priority HIGH | `.rip.hi` | `background: #fef2f2; color: var(--red)` |
| Priority MED | `.rip.me` | `background: #fff8e1; color: #e65100` |
| Priority LOW | `.rip.lo` | `background: #f0f0f2; color: var(--t2)` |
| Title | `.rn` | `font-size: 13px; font-weight: 600; flex: 1` |
| Time estimate | `.rt` | `font-size: 11px; color: var(--t2); flex-shrink: 0` |
| Expand arrow | inline | `font-size: 11px; color: var(--t3)` — "↓" |

**Card body** (`.rec-body`):
- Default: `display: none`
- Open: `display: block`
- Styles: `padding: 0 18px 16px 62px; font-size: 13px; color: var(--t2); line-height: 1.6`
- The 62px left padding aligns body text with title (past checkbox + rank)

**Action block** (`.rec-action`):
- `background: #C2652A; border-radius: 8px; padding: 10px 14px; margin-top: 8px; font-size: 12px; line-height: 1.5; color: #FFFFFF` (!important override)
- `<strong>Action:</strong>` label in white bold

**Boost text** (`.rec-boost`):
- `font-size: 11px; color: var(--green); font-weight: 600; margin-top: 8px; text-transform: uppercase`

### Data Source
- `site.rankedRecommendations` — array of `{ title, pillar, priority, description, estimatedBoost, action? }`
- `estimatedTime` — from recommendation data if available, else omit
- Priority counts computed from array

---

## Files to Modify
1. `app/sites/[id]/SitePageClient.tsx` — rewrite scorecard tab (lines ~844-885) and recommendations tab (lines ~888-934)

## Acceptance Criteria
1. Scorecard: card wrapper, full-width progress bars, tier badges, truncated descriptions, score colors
2. Scorecard: filter buttons match mockup pill style (copper active, not underline)
3. Recommendations: expandable cards with checkbox circles, rank numbers, time estimates
4. Recommendations: action block in copper bg with white text
5. Recommendations: boost text in green uppercase
6. Both tabs handle empty state gracefully
7. Docker build succeeds

## Data Field Corrections (VERIFIED)
- **Recommendation time**: No `estimatedTime` field exists. Use `effort` field ("low"→"30 min", "medium"→"1–2 hrs", "high"→"half day")
- **Recommendation action**: Field is `specificAction` (not "action")
- **Recommendation boost**: Field is `estimatedBoost` (string, e.g., "+12 points")
- **Recommendation evidence**: Field is `evidence` (string|null, e.g., "+41% visibility (Princeton GEO)")
- **Pillar findings**: Field exists for paid tier, null for free tier
- **Pillar priority**: One of "critical" | "high" | "medium" | "low"
- **Pillar score**: Integer 0-100, tier derived from ranges (0-24=Poor, 25-49=Weak, 50-74=Fair, 75+=Good)

## Risks
- **Free tier**: Recommendations truncated to first 3 with minimal fields. Scorecard pillars have no `findings` or `recommendation` text. Must show graceful degradation.
- **Description text**: Pillar `findings` field may be empty for free tier — show nothing or generic text
