# TS-057: Dimensional Intelligence UI

**Author:** CoFounder (Agent 1)
**Date:** 2026-03-24
**Branch:** `dev-an-geo`
**Depends on:** ES-053 (trees), ES-054 (dimensional aggregation), ES-056 (competitor intelligence)
**Scope:** Frontend only — new UI sections in citation monitor to surface Tier 2-4 data

---

## Problem

The backend computes and stores dimensional intelligence data (geo visibility, category visibility, tier visibility, location competitors, category competitors, dominance map, and real prompt discovery) — confirmed working in production logs:

```
[citation-check.location-competitors] nilehq.com: locationCount=1
[citation-check.category-competitors] nilehq.com: categoryCount=3
[citation-check.dominance-map] nilehq.com: entries=5
```

But the frontend has **zero UI components** that render this data. Users see only the original pillar ladder, provider breakdown, and global competitor SOV chart. The entire Tier 2-4 investment is invisible.

---

## Goal

Add new UI sections to the citation check results page that display:
1. Geographic visibility breakdown (which cities/regions the brand is visible in)
2. Category/service visibility breakdown (which services the brand is visible for)
3. Buyer intent tier visibility (buy vs solve vs learn)
4. Per-location competitor landscape (who dominates in each city)
5. Per-category competitor landscape (who dominates in each service)
6. Dominance gap analysis with actionable insights
7. Real prompt discovery results (actual user questions from PAA/Reddit/Quora)

---

## Existing UI Structure

**File:** `app/components/citation-monitor.tsx`
**File:** `app/components/citation-analytics.tsx`

Current render order in "Latest Scan" tab:
1. Hero bar (overall score, tier badge, sub-score pills)
2. Platform cards (per-provider visibility)
3. **CitationAnalytics** component:
   - Score Overview (3-column: visibility, brand knowledge, quality)
   - Provider Visibility (inline text)
   - GEO Pillar Visibility (ranked table with expandable Q&A)
   - Theme Coverage (radar chart)
   - Competitor Share of Voice (horizontal bar chart)
4. Full Research toggle (prompts + responses)

**Insertion point:** After CitationAnalytics (after the existing Competitor Share of Voice section), before Full Research toggle. This is where dimensional intelligence naturally extends the analysis.

---

## Data Available (from CitationCheckScore)

All data is already stored on the `citationCheckScores` row and available via the SSE `complete` event. Types are in `lib/types/citation.ts`.

```typescript
// Tier 2: Dimensional Visibility
geoVisibility:        GeoVisibility[]       // { geoId, geoName, promptCount, mentionCount, visibility }
categoryVisibility:   CategoryVisibility[]   // { categoryId, categoryName, promptCount, mentionCount, visibility }
tierVisibility:       TierVisibility[]       // { tier: "buy"|"solve"|"learn", promptCount, mentionCount, visibility }
visibilityGapAnalysis: VisibilityGapEntry[]  // { dimension, id, name, visibility, gap, recommendation }

// Tier 4: Competitive Intelligence
locationCompetitors:  LocationCompetitor[]   // { geoId, geoName, competitors: CompetitorEntry[] }
categoryCompetitors:  CategoryCompetitor[]   // { categoryId, categoryName, competitors: CompetitorEntry[] }
dominanceMap:         DominanceMap | null     // { entries: DominanceEntry[], computedAt, insights?: string[] }
realPromptDiscovery:  RealPromptDiscovery[]  // { source, query, context, url }
```

---

## UI Sections to Build

### Section 1: Buyer Intent Breakdown

**Data:** `tierVisibility: TierVisibility[]`

Three horizontal progress bars showing visibility by buyer intent stage:
- **Buy** (purchase-intent queries) — % visibility
- **Solve** (problem-solving queries) — % visibility
- **Learn** (research queries) — % visibility

Color: green if ≥40%, amber if 15-39%, red if <15%.

This is a compact 3-row section. Always show if tierVisibility has data.

### Section 2: Geographic Performance

**Data:** `geoVisibility: GeoVisibility[]`

Table or card grid showing visibility per location:
- Row per geoName (city/region)
- Columns: Location, Prompts, Mentions, Visibility %
- Progress bar per row
- Sorted by visibility ascending (worst first — actionable)

If `locationCompetitors` exists for the same geoId, show an expandable row with top 3 competitors (domain, SOV%, rankedAboveBrand%).

Skip section entirely if geoVisibility is empty.

### Section 3: Category/Service Performance

**Data:** `categoryVisibility: CategoryVisibility[]`

Same layout as Geographic Performance but for service categories:
- Row per categoryName
- Columns: Category, Prompts, Mentions, Visibility %
- Progress bar per row
- Sorted by visibility ascending

If `categoryCompetitors` exists for the same categoryId, show expandable row with top 3 competitors.

Skip section entirely if categoryVisibility is empty.

### Section 4: Dominance Insights

**Data:** `dominanceMap: DominanceMap | null`

If dominanceMap exists and has insights:
- Display each insight string as a card/callout
- Color-code by gap severity:
  - "dominates" → red background (you're losing)
  - "competitive" → amber background (close race)
  - "lead" → green background (you're winning)

If no insights but entries exist, show a compact table:
- Columns: Location, Category, Leader, Leader SOV%, Your SOV%, Gap
- Sorted by gap descending

Skip section if dominanceMap is null or has 0 entries.

### Section 5: Real User Questions

**Data:** `realPromptDiscovery: RealPromptDiscovery[]`

Compact list of real questions users ask, grouped by source:
- Source badge: PAA (blue), Reddit (orange), Quora (red)
- Question text
- Context snippet (truncated, 150 chars)

This section is informational — shows users what real people are asking about their industry. Helps them understand why certain prompts were chosen.

Skip section if realPromptDiscovery is empty or null.

### Section 6: Visibility Gap Analysis

**Data:** `visibilityGapAnalysis: VisibilityGapEntry[]`

Actionable recommendations table:
- Row per gap entry
- Columns: Dimension (geo/category/tier badge), Area, Visibility %, Gap Description, Recommendation
- Sorted by visibility ascending (worst gaps first)
- Cap at 10 entries

Skip section if visibilityGapAnalysis is empty.

---

## Design Requirements

### Color Tokens (match existing)
- TEXT: `#1c1917`, TEXT_2: `#78716c`, TEXT_3: `#a8a29e`
- BORDER: `rgba(0,0,0,0.07)`
- GREEN: `#16a34a`, AMBER: `#d97706`, RED: `#dc2626`
- ACCENT: `#b45309`
- Card background: `#ffffff`, Page background: `#faf8f5`

### Typography (match existing)
- Section headings: uppercase, 11px, 600 weight, TEXT_3, letter-spacing 0.06em
- Data values: 14px, 500 weight
- Labels: 12px, 400 weight, TEXT_2

### Responsiveness
- Mobile (< 640px): single column, stacked cards
- Tablet (640-1024px): 2-column grid where applicable
- Desktop (1024px+): full-width tables, 3-column grids

### Progressive Disclosure
- Sections only render if their data array is non-empty
- Competitor details within geo/category sections are expandable (collapsed by default)
- Real User Questions section collapsed by default with "Show N real questions" toggle

---

## Implementation Location

**Primary file:** `app/components/citation-analytics.tsx`

Add new sections after the existing "Competitor Share of Voice" section. All new sections are stateless — they just render data from the `result` prop.

Alternatively, create a new component `app/components/dimensional-intelligence.tsx` that accepts the relevant typed props and is rendered from `citation-monitor.tsx` after CitationAnalytics.

**Preference:** New component file to keep separation of concerns. CitationAnalytics stays focused on pillar/provider analysis. DimensionalIntelligence handles Tier 2-4 geo/category/competitor breakdowns.

---

## Data Flow

The SSE `complete` event already contains all fields. The `CitationCheckScore` type (inferred from DB schema) already includes all Tier 2-4 columns. No backend changes needed.

For the **live scan** path:
- `data.scores` in the SSE complete event includes `geoVisibility`, `categoryVisibility`, `tierVisibility`, etc.
- These need to be passed through to the new component

For the **preloaded** path (page load with lastCheck):
- `lastCheck: CitationCheckScore` already has all fields from the DB row
- Pass directly to new component

---

## Acceptance Criteria

- [ ] AC1: Tier visibility breakdown (buy/solve/learn) renders when tierVisibility is non-empty
- [ ] AC2: Geographic performance table renders when geoVisibility is non-empty
- [ ] AC3: Category performance table renders when categoryVisibility is non-empty
- [ ] AC4: Location competitors expandable within geo rows when locationCompetitors data exists
- [ ] AC5: Category competitors expandable within category rows when categoryCompetitors data exists
- [ ] AC6: Dominance insights render with color-coded severity when dominanceMap has insights
- [ ] AC7: Real user questions render grouped by source when realPromptDiscovery is non-empty
- [ ] AC8: Visibility gap analysis table renders when visibilityGapAnalysis is non-empty
- [ ] AC9: All sections hidden when their data is empty (no empty state UI)
- [ ] AC10: Responsive layout: mobile stacked, tablet 2-col, desktop full-width
- [ ] AC11: Design tokens match existing citation-monitor/analytics styling exactly
- [ ] AC12: New component receives data from both live SSE path and preloaded lastCheck path
- [ ] AC13: No new API calls — all data comes from existing CitationCheckScore fields

---

## Non-Goals

- No new backend changes (data is already computed and stored)
- No new API endpoints
- No chart libraries beyond what's already used (inline SVG for any visualizations)
- No interactivity beyond expand/collapse — this is a read-only display
