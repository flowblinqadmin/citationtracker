# TS-065: Site Report — Overview Tab Content Rebuild

## Status: READY
## Priority: 1 (highest — this is the main visible gap)
## Scope: SitePageClient.tsx overview tab body + removal of old component imports

---

## What
Complete rebuild of the overview tab content to match `GEODashboardRedesignMockup-FINAL.html` lines 1026–1121. This replaces the current implementation which renders CitationMonitor, CitationAnalytics, and DimensionalIntelligence components with their own incompatible layouts (radar charts, arc gauges, etc.).

## Why
The current overview tab renders 3 imported components that have completely different visual designs from the mockup. The mockup shows a specific layout with horizontal bar charts, a competitor comparison bar, a timeline, and a structured grid — none of which exist in the current implementation.

## What Gets Removed
The overview tab currently renders these components inline:
1. `<CitationMonitor>` — live scanning UI, providers, themes, Q&A (renders its own complex layout)
2. `<DimensionalIntelligence>` — buyer intent arcs, geo/category bars, dominance map, gap analysis
3. `<CitationAnalytics>` — arc gauges, radar chart, theme rows, competitor share-of-voice

**These components are NOT deleted** — they remain in the codebase. They are simply no longer rendered in the overview tab. The scan-start callback from CitationMonitor must be preserved (moved to inline logic or a thin wrapper).

## What Gets Built (section by section, top to bottom)

### Section 1: Five KPI Cards
**Layout**: `display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 16px`

**Card container**: `.sc` class — `background: var(--card); border-radius: 12px; padding: 16px 18px; box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04); border: 1px solid var(--border)`

**Card label**: `font-size: 11px; font-weight: 600; color: var(--t2); text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px`

**Card value**: `font-size: 32px; font-weight: 700; letter-spacing: -1px; line-height: 1.1`

#### Card 1: AI Visibility
- Value: `{overallVisibility}%` colored by score (orange if moderate, green if high, red if low)
- Subtext: `"Moderate · Indirect {indirect}% / Direct {direct}%"` (12px, T2)
- Data source: `lastCitationCheck.overallVisibility`, `.indirectVisibility`, `.directVisibility`

#### Card 2: GEO Audit Score
- Value: `{score}` colored by score + `/100` in 18px T3
- Below value: **Gradient score bar** (`.sbm`):
  - Height: 4px, border-radius: 2px
  - Background: `linear-gradient(to right, var(--red) 0% 30%, var(--orange) 30% 50%, var(--yellow) 50% 70%, var(--green) 70%)`
  - Position marker (`.sbk`): 10px circle, TEXT bg, white 2px border, box-shadow, positioned at `left: {score}%`
- Subtext: `"Est. after fixes: {estAfterFixes}"` (12px, T2)
- Data source: `scorecard.overallScore`, computed `estAfterFixes`

#### Card 3: Citation Rate
- Value: `{rate}%` colored by score
- Below value: **Per-provider pills** (`.pr`):
  - Each pill: `font-size: 10px; padding: 2px 7px; border-radius: 4px; font-weight: 600`
  - Colors: red (`.pp.z`) for 0, orange (`.pp.m`), green (`.pp.h`)
  - Format: `"ProviderName N/M"` (e.g., "Perplexity 0/44")
- Data source: `lastCitationCheck.overallVisibility`, per-provider breakdown from citation data

#### Card 4: Competitive SOV (Share of Voice)
- Value: `{sov}%` colored blue (#007aff)
- Subtext: `"Leading · {competitor} {pct}%, {competitor2} {pct2}%"` (12px, T2)
- Data source: computed from citation check competitor data

#### Card 5: Citation Quality
- Value: `{quality}%` colored green if high
- Subtext: `"When cited, quality is high"` (12px, T2)
- Data source: `lastCitationCheck.citationQualityScore`

### Section 2: Competitor Comparison Bar
**Layout**: `background: #FFFFFF; border: 1px solid rgba(0,0,0,0.06); border-radius: 8px; padding: 12px 18px; margin: 16px 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap`

- **Label**: `"Comparing against"` — 10px, 600wt, uppercase, letter-spacing 1px, color #aeaeb2
- **Chips**: One per competitor — `padding: 4px 10px; background: #f5f5f7; border: 1px solid rgba(0,0,0,0.06); border-radius: 6px; font-size: 12px; font-weight: 500; color: #1d1d1f` with × dismiss button (11px, T3, hover red)
- **Add button**: `"+ Add competitor"` — dashed border `1px dashed rgba(0,0,0,0.15)`, 12px, 500wt, T2 color, hover copper
- Data source: `discoveredCompetitors`

### Section 3: Score History Timeline Bar
**Layout**: `background: #FFFFFF; border: 1px solid rgba(0,0,0,0.06); border-radius: 8px; padding: 14px 18px; margin: 0 0 16px 0; display: flex; align-items: center; gap: 16px`

- **Label**: `"Score History"` — 10px, 600wt, uppercase, letter-spacing 1px, color #aeaeb2
- **Track**: `flex: 1; height: 32px; position: relative` with a 2px horizontal line at center (#e5e5ea)
- **Points**: Circles (10px, copper bg, white 2px border) at each historical scan date
  - Above: score (11px, 700wt)
  - Below: date (10px, T2)
  - Future point: gray (#e5e5ea), opacity 0.4, "Next scan" label
- **CTA text**: `"Run additional scans to track progress"` — 11px, T2, italic
- Data source: `citationHistory` (dates + scores from previous checks)

### Section 4: Two-Column Grid
**Layout**: `display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px`

Each panel: `background: var(--card); border-radius: 12px; padding: 18px 20px; box-shadow: var(--sh); border: 1px solid var(--border)`

Panel title: `font-size: 12px; font-weight: 600; color: var(--t2); text-transform: uppercase; letter-spacing: .5px; margin-bottom: 14px`

#### Left Panel: Citation Visibility by Theme
- **Rows** (one per theme, worst first):
  - Label: `font-size: 12px; font-weight: 500; width: 100px; text-align: right`
  - Bar track: `flex: 1; height: 14px; background: #f0f0f2; border-radius: 3px`
  - Bar fill: colored by score (red/orange/yellow/green/gray for 0%)
  - Value: `font-size: 12px; font-weight: 600; width: 36px; text-align: right` colored by score
- Bottom note: `"N themes with zero visibility — highest-priority opportunities"` (11px, T3)
- Data source: theme scores from `lastCitationCheck` (grouped by pillar themes)

#### Right Panel: GEO Audit — Critical Issues
- Title includes count: `"Critical Issues (N of M pillars)"` — count in 400wt T3
- **Table** (`.sct`):
  - Thead: `font-size: 10px; font-weight: 600; color: var(--t3); uppercase; letter-spacing: .5px; padding: 0 0 8px; border-bottom: 1px solid var(--border)`
  - Columns: Pillar, Score, Finding
  - Score column: `text-align: right; width: 50px; font-weight: 700; tabular-nums` colored red/orange
  - Finding column: `font-size: 11px; color: var(--t2); padding-left: 12px`
  - Row: `padding: 7px 0; font-size: 13px; border-bottom: 1px solid #f0f0f2`
  - First column: `font-weight: 500`
- **Link**: `"View all N pillars →"` — 11px, copper color, cursor pointer, margin-top 10px
  - Clicking switches to scorecard tab
- Data source: `pillars` filtered to critical (score < 40)

### Section 5: Three-Column Grid
**Layout**: `display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 16px`

Same panel styling as Section 4.

#### Column 1: Share of Voice
- **Rows** (brand first, then competitors by SOV descending):
  - Label: `font-size: 12px; width: 110px; text-align: right; font-weight: 500`
    - "You" label: `font-weight: 700; color: var(--blue)` (#007aff)
  - Bar track: `flex: 1; height: 18px; background: #f0f0f2; border-radius: 4px`
  - Bar fill: blue for brand (`.cf.yf { background: var(--blue) }`), gray for competitors
  - Value: `font-size: 12px; font-weight: 600; width: 36px; tabular-nums`
- Data source: computed from citation check data (brand vs competitor visibility shares)

#### Column 2: Geographic + Category Performance
- **Geographic Performance** section:
  - Rows with location labels, bars (blue at 0.7 opacity), values
  - Label: `font-size: 12px; width: 80px; text-align: right; font-weight: 500`
  - Bar: `height: 14px; background: #f0f0f2; border-radius: 3px`
  - Fill: `background: var(--blue); opacity: .7`
  - Spacing: 16px gap between sections
- **Category Performance** section (below geographic):
  - Same layout, orange fill bars `background: var(--orange)`
- Data source: geographic/category breakdowns from citation data

#### Column 3: Buyer Intent Coverage + Top Recommendations
- **Buyer Intent** (3 stats in grid):
  - Layout: `display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px`
  - Each stat: centered, label (11px, T2, 500wt), value (20px, 700wt, colored), prompt count (10px, T3)
  - Categories: Buy, Solve, Learn
- **Top Recommendations** section (below, with 16px spacer):
  - Title: panel title style
  - Rows: `padding: 10px 0; border-bottom: 1px solid #f0f0f2; gap: 12px; display: flex; align-items: center`
  - Each row: [checkbox circle] [rank number] [priority badge] [title] [time estimate]
    - Checkbox: `18×18; border: 2px solid var(--border); border-radius: 50%` hover blue
    - Rank: `12px; 700wt; T3; width: 20px`
    - Priority badge: `10px; 700wt; 2px 6px padding; 4px radius` — HIGH=red, MED=orange, LOW=gray
    - Title: `13px; 600wt; flex: 1`
    - Time: `11px; T2`
  - Link: `"View all N recommendations →"` — copper, 11px

## Data Mapping (VERIFIED against DB schema + pipeline code)

| Mockup Element | Data Source | Field Path | Confirmed |
|---------------|------------|------------|-----------|
| AI Visibility % | lastCitationCheck | `overallVisibility` (integer 0-100) | ✅ |
| Direct/Indirect split | lastCitationCheck | `indirectVisibility`, `brandKnowledge` (both integer 0-100) | ✅ |
| GEO Audit Score | scorecard | `overallScore` | ✅ |
| Est. After Fixes | site | `projectedScore` (server computes) or `estAfterFixes` (client) | ✅ |
| Citation Rate % | lastCitationCheck | `overallVisibility` (same metric) | ✅ |
| Per-provider pills | lastCitationCheck | `providerResults` (jsonb ProviderResult[]: {provider, visibilityScore, mentionCount, totalQueries}) | ✅ |
| Competitive SOV | lastCitationCheck | `competitorData` (jsonb CompetitorCitationData[]: {name, shareOfVoice, mentionCount}) | ✅ |
| Citation Quality | lastCitationCheck | `citationQualityScore` (integer 0-100) | ✅ |
| Competitors | site | `discoveredCompetitors` (jsonb: {name, url, score?}) | ✅ |
| Score History | site | `changeLog` (jsonb ChangeLogEntry[]: {runAt, overallScore, pillarScores}) — NOT citationHistory | ✅ corrected |
| Theme visibility bars | lastCitationCheck | `pillarVisibility` (jsonb Record<string, number> — pillar ID → %) | ✅ |
| Critical pillars | scorecard.pillars | filtered where score < 40 | ✅ |
| Share of Voice | lastCitationCheck | `competitorData[].shareOfVoice` (0-100 per competitor) | ✅ |
| Geo performance | lastCitationCheck | `geoVisibility` (jsonb GeoVisibility[]: {geoName, visibility}) | ✅ |
| Category performance | lastCitationCheck | `categoryVisibility` (jsonb CategoryVisibility[]: {categoryName, visibility}) | ✅ |
| Buyer intent | lastCitationCheck | `tierVisibility` (jsonb TierVisibility[]: {tier: "buy"|"solve"|"learn", visibility, promptCount, mentionCount}) | ✅ |
| Top recommendations | site | `rankedRecommendations` ({rank, title, priority, pillar, estimatedBoost, specificAction, effort}) | ✅ |

### Key Field Name Corrections
- **Score History**: Use `site.changeLog` (GEO audit score over time), NOT `citationHistory` (citation check scores)
- **Provider data**: Field is `providerResults`, not "providerScores"
- **Competitor SOV**: Field is `competitorData[].shareOfVoice`, not "shareOfVoice" at top level
- **Theme bars**: Field is `pillarVisibility` (Record<string, number>), not "themeScores"
- **Buyer intent**: Field is `tierVisibility` with `tier` discriminator, not "buyerIntentScores"
- **Geo/Category**: Fields are `geoVisibility` and `categoryVisibility`, not "geoScores"/"categoryScores"
- **Recommendation time**: No `estimatedTime` field. Use `effort` ("low"→"30 min", "medium"→"1–2 hrs", "high"→"half day") as display mapping
- **Recommendation action**: Field is `specificAction`, not "action"

## Scan-Start Callback Preservation
The `CitationMonitor` component currently handles the scan-start registration via `onScanStart` prop. When we remove it from the overview tab, we need to:
1. Keep the `citationMonitorOnScanStart` ref
2. Move the scan registration to the rail's "Scan Citations" button directly
3. The scan itself (POST to `/api/sites/{id}/citation-check`) is already handled by `handleScanCitations()` — no component needed

## Files to Modify
1. `app/sites/[id]/SitePageClient.tsx` — rewrite overview tab body (lines ~719–841)

## Files NOT Modified (kept as-is)
1. `app/components/citation-monitor.tsx` — kept for potential future use
2. `app/components/citation-analytics.tsx` — kept
3. `app/components/dimensional-intelligence.tsx` — kept
4. `app/components/citation-history.tsx` — kept (still used in history tab, see TS-067)

## Acceptance Criteria
1. Overview tab renders all 5 sections matching mockup layout
2. KPI card 2 has gradient score bar with position marker
3. KPI card 3 has per-provider pills
4. Competitor bar has chips with dismiss + add button
5. Timeline shows historical scan points
6. Two-column grid: theme bars + critical issues table
7. Three-column grid: SOV + geo/category + intent/recs
8. All data is sourced from existing props (no new API calls)
9. No radar charts, arc gauges, or old component layouts visible
10. Docker build succeeds

## Risks
- **Data availability**: ✅ VERIFIED — All fields exist in the `citationCheckScores` table and are populated by the citation check pipeline (Tiers 1-4). The `geoSites.changeLog` provides GEO audit score history. See data mapping table above.
- **Graceful degradation**: If a field is null/empty (no citation check run yet, no competitors discovered), each section must show a sensible fallback (em-dash, "Run citation check" prompt, etc.)
- **Scan callback**: Removing CitationMonitor from the render tree means the scan button in the rail must work independently. The existing `handleScanCitations()` already handles this — just need to verify it still works without CitationMonitor mounted.
- **Free tier gating**: The server component truncates data for free tier users. Overview sections that depend on citation data will show empty states for free tier (no citation check available). Per-page and detailed recommendation data is null for free tier.
