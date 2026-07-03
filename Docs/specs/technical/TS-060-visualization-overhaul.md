# TS-060: Citation Intelligence Visualization Overhaul

**Author:** CoFounder (Agent 1)
**Date:** 2026-03-25
**Branch:** `dev-an-geo`
**Depends on:** TS-058 (V2 prompts), TS-059 (brand detection + categories), ES-057 (dimensional UI)
**Assigned to:** DaVinci (Agent 10)
**Design spine:** Apple HIG + Tufte "Visual Display of Quantitative Information"

---

## Context

The citation check UI is functionally complete but visually conservative. All Tier 2-4 data (geo visibility, category visibility, buyer intent, competitor landscape, dominance) is computed and stored but displayed as basic tables and progress bars. The radar chart still shows 16 pillars (9 at zero for V2 checks). Score overview cards are unstyled text. Interactive elements have no hover feedback. No animations.

**Competitive gap:** OptimizeGEO.ai ($499-$3,999/mo) shows zero product UI on their site. Our visualizations ARE the differentiator — every chart we build is something they don't show. Data density and direct labeling should be our advantage.

---

## Design Principles (from DaVinci CLAUDE.md)

### Tufte Laws
1. Above all else, show the data
2. Maximize data-ink ratio — every pixel earns its place
3. Erase non-data-ink (chartjunk) — no decorative elements that don't represent data
4. Label data directly on the graphic — no legends requiring eye travel
5. Horizontal text only — no vertical axis labels
6. Shades of gray before color — gray has natural ordering
7. Favor horizontal graphics ~1.618:1 (golden ratio)
8. Small multiples for comparison — same structure, different data
9. Never use pie charts
10. Tables over pie charts — always

### Apple HIG
1. Direct manipulation feedback — all interactive elements respond to touch/hover
2. Visual hierarchy — most important data is largest/boldest
3. Motion for continuity — subtle transitions between states
4. Legibility — minimum contrast ratios, readable at all sizes
5. Progressive disclosure — show summary, reveal detail on demand

### Existing Design Tokens
```
TEXT    = "#1c1917"   TEXT_2  = "#78716c"   TEXT_3  = "#a8a29e"
BORDER = "rgba(0,0,0,0.07)"   TRACK  = "#e8e5e0"
GREEN  = "#16a34a"   AMBER  = "#d97706"   RED    = "#dc2626"
ACCENT = "#b45309"   BG     = "#faf8f5"   CARD   = "#ffffff"
```

---

## Fixes (36 items organized by file)

### FILE: app/components/citation-analytics.tsx

#### B1 — Radar Chart: 7 Buyer Pillars (CRITICAL)
**Current:** 16-point radar with 9 at zero for V2 checks — chartjunk.
**Fix:** V2 checks render 7-point radar (buyer pillars only). V1 checks keep 16-point.
**Tufte:** B2 (erase non-data-ink). A 16-point radar with 9 zero axes is 56% wasted ink.
**Implementation:** Conditional pillar list based on `promptArchitectureVersion`. Direct labels at each vertex (no tooltip-required hover). Horizontal text only — angle labels positioned outside the polygon.

#### B2 — Score Overview Cards (MAJOR)
**Current:** Three KPI values (Visibility %, Brand Knowledge %, Quality %) as bare inline text.
**Fix:** Replace with three compact ring/arc gauges. Each ring shows score 0-100 with color fill (RED <20, AMBER 20-59, GREEN ≥60). Score value centered inside ring. Label below.
**Tufte:** B1 (show the data). Current design hides the visual magnitude.
**HIG:** Visual hierarchy — these are the 3 most important numbers on the page.

#### B9 — Brand in Competitor SOV Chart (MAJOR)
**Current:** Horizontal bar chart shows only competitors. User's own brand missing.
**Fix:** Add brand as first bar in distinct color (ACCENT). Label: "{brand} (you)". Sort remaining by SOV descending.
**Tufte:** B5 (compared to what?). Without the brand bar, competitors float without reference point.

#### C1 — Hover States (MAJOR)
**Current:** Platform cards, expandable rows, buttons have zero hover feedback.
**Fix:** Add `transition: background-color 0.15s ease` on all interactive elements. Hover: TRACK background. Active: slightly darker. Cursor: pointer on all clickable elements.
**HIG:** Direct manipulation feedback.

#### C2 — Score Overview Visual Containment (MAJOR)
**Current:** Score triptych has no visual structure — just text in a flex row.
**Fix:** Each score in a card with subtle border, rounded corners, light shadow. Visual containment creates hierarchy.
**HIG:** Visual hierarchy through containment.

#### D1 — Horizontal Text on Radar (MAJOR)
**Current:** Recharts radar labels may render at angles.
**Fix:** Force all radar axis labels to render horizontally. Position outside polygon with offset.
**Tufte:** B7 (horizontal text only).

#### D2 — Direct Labels on Radar (MAJOR)
**Current:** Radar uses tooltip on hover to show values.
**Fix:** Add score value directly at each vertex (9px, TEXT_2). Reader should see all 7 scores without hovering.
**Tufte:** B7 (label data directly).

#### C6 — Table Headers (MINOR)
**Current:** 11px gray uppercase — hard to scan.
**Fix:** Increase to 12px, TEXT_2 color (not TEXT_3). Slightly bolder (500 weight).
**Tufte:** B10 (type is clear, precise, modest).

#### D3 — Spell Out Abbreviations (MINOR)
**Current:** "SOV", "Avg", "Q&A" without context.
**Fix:** First use: "Share of Voice (SOV)". Subsequent: "SOV" is OK. "Avg Position" → "Average Position".
**Tufte:** B10 (words spelled out).

#### D4 — Mixed Case for Section Headings (MINOR)
**Current:** ALL-CAPS 11px uppercase section headings.
**Fix:** Keep uppercase for section headings (design convention). But ensure data labels within sections use mixed case.
**Tufte:** B7 (mixed case for readability). Exception for section headings which serve as visual dividers.

---

### FILE: app/components/dimensional-intelligence.tsx

#### E1 — Geographic Visibility Bar Chart (MAJOR)
**Current:** Expandable table rows with inline progress bars.
**Fix:** Replace with horizontal bar chart. City names on left axis (direct labels), visibility % as bar length, value at bar end. Color: GREEN ≥40%, AMBER 15-39%, RED <15%. Sorted ascending (worst first = most actionable at top).
**Tufte:** B1 (show the data), B7 (label directly), B9 (horizontal graphics).

#### E2 — Category Visibility Bar Chart (MAJOR)
**Current:** Same expandable table as geo.
**Fix:** Same horizontal bar chart pattern as E1. Category names on left. Small multiple alongside E1 for comparison.
**Tufte:** B4 (small multiples — same structure, indexed by different variable).

#### E3 — Competitor Per-Geo Small Multiples (MAJOR)
**Current:** Expandable competitor panels nested inside geo rows.
**Fix:** For top 3 geo locations, show mini horizontal bar charts (small multiples). Each shows top 3 competitors + brand. Same visual structure, different geo.
**Tufte:** B4 (small multiples), B5 (compared to what?).
**Note:** Only render if locationCompetitors has ≥2 entries. Otherwise keep expandable table.

#### E4 — Dominance Diverging Bars (MAJOR)
**Current:** Text cards with keyword-colored backgrounds OR fallback table.
**Fix:** Diverging horizontal bar chart. Left side: your SOV (ACCENT color). Right side: leader SOV (RED). Gap = visual distance between bars. One row per geo×category entry. Direct label at each bar end.
**Tufte:** B5 (compared to what?), B1 (show the data).

#### B7 — Buyer Intent Gauge (MODERATE)
**Current:** Three progress bars (Buy/Solve/Learn).
**Fix:** Three compact arc gauges (180° arcs) or donut segments. More data-dense than linear bars. Score centered inside arc. Color by threshold.
**Tufte:** B3 (data density). Arcs use space more efficiently than linear bars.

#### C3 — Section Transitions (MODERATE)
**Current:** All sections render statically.
**Fix:** Staggered fade-in using CSS `animation-delay`. Each section appears 100ms after the previous. Subtle opacity 0→1 + translateY 8px→0. CSS-only, no JS animation library needed.
**HIG:** Motion for continuity.

#### C4 — Pillar Label Truncation (MODERATE)
**Current:** Fixed 90px width truncates long labels like "Competitive Positioning".
**Fix:** Dynamic width based on content. Or use `title` attribute for full text on hover/long-press. Mobile: allow label to wrap to 2 lines.
**HIG:** Legibility.

#### C5 — Mobile Competitor Badge (MODERATE)
**Current:** Hidden entirely on <640px via `display: none`.
**Fix:** Reflow below the pillar label on mobile instead of hiding. Information should never be removed, only rearranged.
**HIG:** No information loss across breakpoints.

#### E5 — Trend Sparklines Per Dimension (MODERATE)
**Current:** No trend data in dimensional tables.
**Fix:** If citation check history has ≥3 V2 checks, show tiny inline sparkline (40×16px SVG) in the geo/category bar chart rows. Shows visibility trend over last 5 checks for that dimension.
**Tufte:** B3 (data density — sparklines maximize numbers per square inch).

#### E6 — Prompt Architecture Banner (MODERATE)
**Current:** No indicator when measurement methodology changes.
**Fix:** When history contains both V1 and V2 checks, show a subtle divider in the history timeline: "Measurement upgraded — scores after this date use improved prompts."
**Tufte:** B10 (little messages explain data).

---

### FILE: app/components/citation-history.tsx

#### B8 — History Sparkline Y-Grid Fix (MODERATE)
**Current:** Hardcoded Y grid lines at 20, 30, 40 — don't scale with data range.
**Fix:** Calculate grid lines from actual data: min, median, max of the visibility scores in history. Ensures grid lines align with meaningful data values.
**Tufte:** B5 (lie factor — misaligned grid lines misrepresent the data distribution).

---

### FILE: app/components/citation-monitor.tsx

#### C7 — Narrative Loading State (MINOR)
**Current:** Italic "Generating insight…" text.
**Fix:** Skeleton shimmer animation (pulsing gray bars) matching the expected narrative shape. Communicates "content loading" more clearly than italic text.
**HIG:** Progress indicators.

---

## NOT Doing (Tufte-Justified Removals)

1. **No pie charts anywhere.** Tufte: "Never use pie charts." Tables and bars always.
2. **No 3D effects.** Tufte: "Never depict 1D data with 2D areas or 3D volumes."
3. **No heavy grid lines.** Use muted gray or remove entirely.
4. **No chart legends.** Direct label everything.
5. **No vertical text.** Rotate nothing.

---

## Implementation Notes for DaVinci

### Chart Library
Use Recharts (already installed) for bar charts and radar. Use inline SVG for sparklines, arcs, and gauges (more control, less chartjunk).

### Animation
CSS-only for section transitions (`@keyframes fadeSlideIn`). No Framer Motion needed for this scope — keep bundle size down.

### Responsive
- Desktop (1024px+): small multiples side by side, full bar charts
- Tablet (640-1024px): stacked charts, 2-column grids
- Mobile (<640px): single column, full-width bars, labels wrap

### Testing
DaVinci should write visual regression tests for:
- Radar renders 7 points for V2, 16 for V1
- Score rings render correct colors at thresholds
- Bar charts sorted ascending
- Brand appears as first bar in SOV chart
- Sparklines render inline
- All sections have hover states
- Mobile breakpoints verified

---

## Acceptance Criteria

- [ ] AC1: Radar chart shows 7 buyer pillars for V2 checks
- [ ] AC2: Radar labels are horizontal, directly labeled with scores
- [ ] AC3: Score overview rendered as arc/ring gauges with color thresholds
- [ ] AC4: Brand included as first bar in Competitor SOV chart (ACCENT color)
- [ ] AC5: Geographic visibility as horizontal bar chart, sorted ascending
- [ ] AC6: Category visibility as horizontal bar chart, sorted ascending
- [ ] AC7: Competitor per-geo small multiples (top 3 geos, top 3 competitors + brand)
- [ ] AC8: Dominance diverging bars (your SOV vs leader SOV)
- [ ] AC9: Buyer intent as arc gauges (not progress bars)
- [ ] AC10: All interactive elements have hover states
- [ ] AC11: Section transitions with staggered fade-in
- [ ] AC12: History sparkline Y-grid calculated from data range
- [ ] AC13: Trend sparklines inline in geo/category rows (if ≥3 checks)
- [ ] AC14: Prompt architecture version banner in history
- [ ] AC15: Mobile responsive — no information hidden, only reflowed
- [ ] AC16: No chartjunk — every visual element earns its pixels
- [ ] AC17: No vertical text anywhere
- [ ] AC18: No legends — all data directly labeled
