# ES-060: Citation Intelligence Visualization Overhaul

**Source:** TS-060-visualization-overhaul.md
**Author:** SpecMaster (Agent 2)
**Date:** 2026-03-25
**Branch:** `dev-an-geo`
**Depends on:** ES-057 (dimensional UI), ES-059 (brand detection)
**Assigned to:** DaVinci (Agent 10)
**Design spine:** Apple HIG + Tufte "Visual Display of Quantitative Information"

---

## a) Overview

### What this covers
36 visualization fixes across 4 component files transforming conservative tables/text into data-dense, Tufte-compliant charts with Apple HIG interactivity. No backend changes. No new data requirements.

### Current implementation state
- **citation-analytics.tsx** (427 lines): 16-point radar (9 zeros on V2), text-only score overview, competitor SOV bars without brand reference, no hover states
- **dimensional-intelligence.tsx**: Being created by ES-057 — tables with progress bars, text cards for dominance
- **citation-history.tsx** (233 lines): Hardcoded Y-grid lines at [20, 30, 40], no version banner
- **citation-monitor.tsx**: Italic "Generating insight…" text for loading state

### Files involved
| File | Action | Fixes |
|------|--------|-------|
| `app/components/citation-analytics.tsx` | **MODIFY** | B1, B2, B9, C1, C2, C6, D1, D2, D3, D4 |
| `app/components/dimensional-intelligence.tsx` | **MODIFY** | E1, E2, E3, E4, B7, C3, C4, C5, E5, E6 |
| `app/components/citation-history.tsx` | **MODIFY** | B8 |
| `app/components/citation-monitor.tsx` | **MODIFY** | C7 |

---

## b) Implementation Requirements

### FILE 1: `app/components/citation-analytics.tsx`

---

#### B1 — Radar Chart: 7 Buyer Pillars for V2

**Current state** (lines 293-335): 16-point radar using `PILLARS` (all 16 pillar keys). V2 checks have 9 pillars at zero.

**Existing V2 detection** (lines 261-262): Already reads `promptArchitectureVersion` from result.

**Implementation:**

Define the 7 V2 buyer pillars (these are the pillars that map to the 5 seed template angles):

```typescript
const V2_BUYER_PILLARS = [
  "competitive_positioning",  // discovery
  "offering_clarity",         // clarity
  "evidence_statistics",      // evaluation
  "contact_trust",            // trust
  "author_authority",         // evaluation
  "licensing_signals",        // readiness
  "cta_structure",            // readiness
];
```

Conditional pillar list:
```typescript
const isV2 = (result as { promptArchitectureVersion?: number }).promptArchitectureVersion === 2;
const activePillars = isV2 ? V2_BUYER_PILLARS : PILLARS;
const radarData = activePillars.map(p => ({
  subject: PILLAR_LABELS[p] ?? p,
  score:   scores.pillarVisibility[p] ?? 0,
  fullMark: 100,
}));
```

**Direct labels at vertices:** Use Recharts `customTick` on `PolarAngleAxis`:

```typescript
function HorizontalAxisTick({ payload, x, y, cx, cy, ...rest }: any) {
  const score = radarData.find(d => d.subject === payload.value)?.score ?? 0;
  const color = pillarColor(score);
  // Offset label away from center
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const offsetX = x + (dx / dist) * 14;
  const offsetY = y + (dy / dist) * 8;
  const anchor = offsetX > cx ? "start" : offsetX < cx ? "end" : "middle";

  return (
    <g>
      <text x={offsetX} y={offsetY} textAnchor={anchor} fill={TEXT_3} fontSize={10} fontWeight={600}
            dominantBaseline="central">
        {payload.value}
      </text>
      <text x={offsetX} y={offsetY + 12} textAnchor={anchor} fill={color} fontSize={9} fontWeight={700}
            dominantBaseline="central">
        {score}%
      </text>
    </g>
  );
}
```

Apply: `<PolarAngleAxis dataKey="subject" tick={<HorizontalAxisTick />} />`

Remove the `<Tooltip>` from radar chart — data is now directly labeled.

---

#### B2 — Score Overview Arc Gauges

**Current state** (lines 399-407): Three text values in a flex row with `<strong>` tags.

**Replace with inline SVG arc gauges.** Each gauge is a 240° arc (not full circle — leaves a gap at bottom for aesthetics).

**SVG Arc Gauge component:**

```typescript
function ScoreArc({ value, label, size = 80 }: { value: number; label: string; size?: number }) {
  const r = (size - 8) / 2;          // radius with stroke inset
  const cx = size / 2;
  const cy = size / 2;
  const startAngle = 150;            // degrees (7 o'clock)
  const endAngle = 390;              // degrees (5 o'clock) — 240° sweep
  const sweepAngle = endAngle - startAngle; // 240°

  // Track arc (full 240°)
  const trackPath = describeArc(cx, cy, r, startAngle, endAngle);
  // Value arc (proportional to score)
  const valueEnd = startAngle + (value / 100) * sweepAngle;
  const valuePath = describeArc(cx, cy, r, startAngle, Math.max(startAngle + 1, valueEnd));

  const color = value >= 60 ? GREEN : value >= 20 ? AMBER : RED;

  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
      background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12,
      padding: "16px 20px 12px",
      boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
    }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <path d={trackPath} fill="none" stroke={TRACK} strokeWidth={6} strokeLinecap="round" />
        {value > 0 && (
          <path d={valuePath} fill="none" stroke={color} strokeWidth={6} strokeLinecap="round" />
        )}
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
              fill={color} fontSize={20} fontWeight={700} fontFamily="system-ui">
          {value}%
        </text>
      </svg>
      <span style={{ fontSize: 11, fontWeight: 500, color: TEXT_2 }}>{label}</span>
    </div>
  );
}

// Arc path helper (SVG arc commands)
function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const startRad = (startDeg * Math.PI) / 180;
  const endRad = (endDeg * Math.PI) / 180;
  const x1 = cx + r * Math.cos(startRad);
  const y1 = cy + r * Math.sin(startRad);
  const x2 = cx + r * Math.cos(endRad);
  const y2 = cy + r * Math.sin(endRad);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
}
```

**Render:**
```typescript
<div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
  <ScoreArc value={scores.indirectVisibility} label="Overall Visibility" />
  <ScoreArc value={scores.brandKnowledge} label="Brand Knowledge" />
  <ScoreArc value={scores.citationQualityScore} label="Citation Quality" />
</div>
```

---

#### B9 — Brand in Competitor SOV Chart

**Current state** (lines 340-383): Competitor bars sorted by SOV, brand NOT included.

**Fix:** Add the user's domain as the first bar with ACCENT color (`#b45309`).

Compute brand's own SOV from `scores.indirectVisibility` (or derive from provider results):

```typescript
// Insert brand as first entry
const brandEntry = {
  name: domain.replace(/^www\./, "").replace(/\.(com|io|co|net|org).*$/, "") + " (you)",
  shareOfVoice: scores.indirectVisibility,
  rankedAbove: 0,
  sentiment: "positive" as const,
  isBrand: true,
};
const competitorRows = [brandEntry, ...scores.competitorData
  .sort((a, b) => b.shareOfVoice - a.shareOfVoice)
  .slice(0, 7)  // 7 competitors + 1 brand = 8 total
  .map(c => ({ ...c, isBrand: false }))
];
```

In `<Cell>` fill, check `isBrand`:
```typescript
<Cell key={i} fill={entry.isBrand ? ACCENT : (entry.sentiment === "positive" ? GREEN : entry.sentiment === "negative" ? RED : AMBER)} />
```

Direct label at bar end (remove tooltip dependency):
```typescript
<Bar dataKey="shareOfVoice" radius={[0, 4, 4, 0]}
  label={{ position: "right", fill: TEXT_2, fontSize: 10, formatter: (v: number) => `${v}%` }}>
```

---

#### C1 — Hover States

Add to the `<style>` block (lines 387-397):

```css
.ca-interactive:hover { background-color: ${TRACK} !important; }
.ca-interactive:active { background-color: rgba(0,0,0,0.06) !important; }
.ca-interactive { transition: background-color 0.15s ease; cursor: pointer; }
```

Apply `.ca-interactive` class to:
- `ThemeRow` button (line 118)
- Each platform card in citation-monitor.tsx
- Expandable competitor panels
- All clickable elements

---

#### C2 — Score Overview Visual Containment

Handled by `ScoreArc` component in B2 — each gauge is wrapped in a card with border, border-radius 12, and subtle shadow.

---

#### C6 — Table Headers

Update `thStyle` wherever used:
```typescript
const thStyle: React.CSSProperties = {
  textAlign: "left", padding: "8px 12px",
  color: TEXT_2,    // was TEXT_3
  fontWeight: 500,  // was implicit/lower
  fontSize: 12,     // was 11
};
```

---

#### D1+D2 — Horizontal Text + Direct Labels on Radar

Handled by `HorizontalAxisTick` custom tick in B1. All labels render horizontally with score value below.

---

#### D3 — Spell Out Abbreviations

First occurrence replacements:
- Section heading "COMPETITOR SHARE OF VOICE" stays (heading context is clear)
- Chart header or subtitle: "Share of Voice (SOV)" on first use
- "Avg Position" → "Average Position" in history table header (citation-history.tsx line 151)
- "Q&A" → keep as-is (universally understood)

---

#### D4 — Mixed Case for Data Labels

Section headings stay uppercase (design convention). Data labels within sections use mixed case:
- Pillar labels: already mixed case in `PILLAR_LABELS` ✓
- Provider names: already `textTransform: capitalize` ✓
- No changes needed — current implementation is correct.

---

### FILE 2: `app/components/dimensional-intelligence.tsx`

**Note:** This file is being created by ES-057. These modifications apply ON TOP of ES-057's implementation.

---

#### E1 — Geographic Visibility Horizontal Bar Chart

**Replace** ES-057 §Section 2 table with a Recharts horizontal `<BarChart>`.

```typescript
import { BarChart, Bar, XAxis, YAxis, Cell, LabelList } from "recharts";
import { ResponsiveContainer } from "recharts";

// Data prep (inside component)
const geoData = data.geoVisibility
  .sort((a, b) => a.visibility - b.visibility) // worst first
  .slice(0, 12); // cap at 12 rows

// Render
<ResponsiveContainer width="100%" height={Math.max(160, geoData.length * 36)}>
  <BarChart data={geoData} layout="vertical" margin={{ left: 100, right: 48, top: 4, bottom: 4 }}>
    <XAxis type="number" domain={[0, 100]} tick={{ fill: TEXT_2, fontSize: 10 }}
           axisLine={{ stroke: BORDER }} tickLine={false} />
    <YAxis type="category" dataKey="geoName" tick={{ fill: TEXT_2, fontSize: 11 }}
           width={100} axisLine={false} tickLine={false} />
    <Bar dataKey="visibility" radius={[0, 4, 4, 0]} barSize={20}>
      <LabelList dataKey="visibility" position="right" fill={TEXT_2} fontSize={10}
                 formatter={(v: number) => `${v}%`} />
      {geoData.map((entry, i) => (
        <Cell key={i} fill={entry.visibility >= 40 ? GREEN : entry.visibility >= 15 ? AMBER : RED} />
      ))}
    </Bar>
  </BarChart>
</ResponsiveContainer>
```

**Competitor expand** remains — show a "▸ 3 competitors" link below each geo bar. On click, expand inline small multiple (see E3). Keep expandable pattern from ES-057.

---

#### E2 — Category Visibility Horizontal Bar Chart

Same pattern as E1, keyed on `categoryName`/`categoryId`. Placed beside E1 as small multiple on desktop:

```css
/* Desktop: side by side */
@media (min-width: 1024px) {
  .di-chart-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
}
/* Mobile/tablet: stacked */
@media (max-width: 1023px) {
  .di-chart-pair { display: flex; flex-direction: column; gap: 24px; }
}
```

---

#### E3 — Competitor Per-Geo Small Multiples

**Gate:** Only render if `locationCompetitors` has ≥2 entries.

For the **top 3 geo locations** (by visibility, ascending — same as E1 sort):

```typescript
const top3Geos = data.geoVisibility
  .sort((a, b) => a.visibility - b.visibility)
  .slice(0, 3);

// For each geo, find matching locationCompetitors
const geoCompSmall = top3Geos
  .map(geo => {
    const lc = data.locationCompetitors.find(c => c.geoId === geo.geoId);
    if (!lc || lc.competitors.length === 0) return null;
    // Add brand entry
    return {
      geoName: geo.geoName,
      bars: [
        { name: domain.replace(/\.[a-z]+$/i, "") + " (you)", sov: geo.visibility, isBrand: true },
        ...lc.competitors.slice(0, 3).map(c => ({ name: c.domain.replace(/\.[a-z]+$/i, ""), sov: c.shareOfVoice, isBrand: false })),
      ],
    };
  })
  .filter(Boolean);
```

Each small multiple: compact horizontal bar chart (120px height) with geo name as title. Same bar styling as E1. Brand bar uses ACCENT color.

Layout: `display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px;`

If `locationCompetitors` has <2 entries, fall back to ES-057's expandable table pattern.

---

#### E4 — Dominance Diverging Bars

**Replace** ES-057 §Section 4 with a diverging horizontal bar chart.

Each row = one `DominanceEntry`. Two bars grow in opposite directions from a center axis:
- **Left:** Your SOV (ACCENT color, growing leftward)
- **Right:** Leader SOV (RED color, growing rightward)

```typescript
function DominanceDivergingRow({ entry, maxSov }: { entry: DominanceEntry; maxSov: number }) {
  const yourPct = (entry.brandSOV / maxSov) * 100;
  const leaderPct = (entry.topBrandSOV / maxSov) * 100;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: `1px solid ${BORDER}` }}>
      {/* Your SOV — right-aligned bar */}
      <div style={{ flex: 1, display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 10, color: ACCENT, fontWeight: 600 }}>{entry.brandSOV}%</span>
        <div style={{ height: 16, width: `${yourPct}%`, background: ACCENT, borderRadius: "4px 0 0 4px", minWidth: entry.brandSOV > 0 ? 4 : 0 }} />
      </div>
      {/* Center label */}
      <div style={{ width: 80, textAlign: "center", fontSize: 10, color: TEXT_2, flexShrink: 0 }}>
        {entry.geoId ? `Geo ${entry.geoId.slice(0, 8)}` : "Global"}
      </div>
      {/* Leader SOV — left-aligned bar */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4 }}>
        <div style={{ height: 16, width: `${leaderPct}%`, background: RED, borderRadius: "0 4px 4px 0", minWidth: entry.topBrandSOV > 0 ? 4 : 0 }} />
        <span style={{ fontSize: 10, color: RED, fontWeight: 600 }}>{entry.topBrandSOV}%</span>
      </div>
    </div>
  );
}
```

Header row: "You" (ACCENT) on left, "Leader" (RED) on right. Sort by `gap` descending (biggest gap first). Cap at 8 entries.

If no entries but `dominanceMap.insights` exist, render insight cards (keep ES-057 §Section 4 insight card pattern).

---

#### B7 — Buyer Intent Arc Gauges

**Replace** ES-057 §Section 1 progress bars with 3 compact arc gauges (same `ScoreArc` component from B2, but with `size={72}`).

```typescript
const tierLabels: Record<string, string> = { buy: "Buy", solve: "Solve", learn: "Learn" };

<div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
  {data.tierVisibility.map(tv => (
    <ScoreArc key={tv.tier} value={tv.visibility} label={tierLabels[tv.tier] ?? tv.tier} size={72} />
  ))}
</div>
```

Sub-text below each gauge: `{tv.mentionCount}/{tv.promptCount} prompts` (9px, TEXT_3).

---

#### C3 — Section Transitions (Staggered Fade-In)

Add CSS keyframes to the `<style>` block:

```css
@keyframes fadeSlideIn {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
.di-section {
  animation: fadeSlideIn 0.3s ease forwards;
  opacity: 0;
}
.di-section:nth-child(1) { animation-delay: 0ms; }
.di-section:nth-child(2) { animation-delay: 100ms; }
.di-section:nth-child(3) { animation-delay: 200ms; }
.di-section:nth-child(4) { animation-delay: 300ms; }
.di-section:nth-child(5) { animation-delay: 400ms; }
.di-section:nth-child(6) { animation-delay: 500ms; }
```

Wrap each section `<div>` with `className="di-section"`.

---

#### C4 — Pillar Label Truncation Fix

In `ThemeRow` (citation-analytics.tsx line 139):

```typescript
// OLD:
style={{ fontSize: 12, fontWeight: 600, color: ..., flex: "0 0 90px", flexShrink: 0 }}

// NEW:
style={{ fontSize: 12, fontWeight: 600, color: ..., minWidth: 70, maxWidth: 120, flexShrink: 0 }}
```

Add `title` attribute for full text on hover:
```typescript
<span ... title={label}>{label}</span>
```

Mobile CSS override (add to existing `<style>` block):
```css
@media (max-width: 640px) {
  .ca-theme-row-label { min-width: 60px !important; max-width: 90px !important; white-space: normal !important; line-height: 1.3 !important; }
}
```

---

#### C5 — Mobile Competitor Badge

**Current** (line 393): `.ca-theme-competitor-badge { display: none !important; }` on mobile.

**Replace with reflow:**
```css
@media (max-width: 640px) {
  .ca-theme-competitor-badge {
    display: block !important;
    margin-top: 2px;
    margin-left: 26px;  /* align with label indent */
  }
}
```

Restructure the `ThemeRow` button to use `flex-wrap: wrap` so the badge wraps below the label on mobile.

---

#### E5 — Trend Sparklines Per Dimension

**Gate:** Only render if component receives `history` prop with ≥3 entries that have V2 `promptArchitectureVersion`.

**New prop on `DimensionalIntelligence`:**
```typescript
interface DimensionalIntelligenceProps {
  result: CitationCheckResult | CitationCheckScore | null;
  domain: string;
  history?: CitationCheckScore[];  // NEW — for trend sparklines
}
```

**Sparkline component (inline SVG, 40×16px):**
```typescript
function MiniSparkline({ values }: { values: number[] }) {
  if (values.length < 3) return null;
  const w = 40, h = 16;
  const max = Math.max(...values, 1);
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - (v / max) * h;
    return `${x},${y}`;
  });
  const latest = values[values.length - 1];
  const first = values[0];
  const color = latest > first ? GREEN : latest < first ? RED : TEXT_3;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "inline-block", verticalAlign: "middle", marginLeft: 8 }}>
      <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}
```

**Data extraction:** For each geoId/categoryId, extract the visibility value from the last 5 history entries:
```typescript
const geoTrends = new Map<string, number[]>();
if (history && history.length >= 3) {
  const v2History = history
    .filter(h => (h as any).promptArchitectureVersion === 2)
    .slice(0, 5)
    .reverse(); // chronological
  for (const check of v2History) {
    for (const geo of (check.geoVisibility ?? []) as GeoVisibility[]) {
      const trend = geoTrends.get(geo.geoId) ?? [];
      trend.push(geo.visibility);
      geoTrends.set(geo.geoId, trend);
    }
  }
}
```

Render `<MiniSparkline values={geoTrends.get(geo.geoId) ?? []} />` inline in each bar chart row label area.

---

#### E6 — Prompt Architecture Version Banner

**Gate:** `history` prop contains both V1 (`promptArchitectureVersion !== 2`) and V2 checks.

Render a subtle divider in the history component:
```typescript
// In citation-history.tsx, between V1 and V2 rows:
<tr>
  <td colSpan={6} style={{
    padding: "8px 12px",
    background: `${AMBER}08`,
    borderTop: `1px solid ${AMBER}30`,
    borderBottom: `1px solid ${AMBER}30`,
    fontSize: 11,
    color: AMBER,
    fontWeight: 500,
  }}>
    Measurement upgraded — scores after this date use improved prompts
  </td>
</tr>
```

Detect transition: iterate history (sorted newest-first), find the boundary where `promptArchitectureVersion` changes from 2 to 1 (or undefined).

---

### FILE 3: `app/components/citation-history.tsx`

---

#### B8 — History Sparkline Y-Grid Fix

**Current** (lines 118-120): Hardcoded `[20, 30, 40]` as Y grid positions in SVG coordinates.

**Fix:** Calculate grid lines from actual data:

```typescript
const minV = Math.min(...sparklineValues);
const maxV = Math.max(...sparklineValues);
const medianV = [...sparklineValues].sort((a, b) => a - b)[Math.floor(sparklineValues.length / 2)];

// Convert visibility values to SVG Y coordinates
const toY = (v: number) => 10 + (1 - v / 100) * (60 - 20);

const gridLines = [
  { y: toY(minV), label: `${minV}%` },
  { y: toY(medianV), label: `${medianV}%` },
  { y: toY(maxV), label: `${maxV}%` },
].filter((g, i, arr) => {
  // Remove duplicates (within 3px)
  return !arr.slice(0, i).some(prev => Math.abs(prev.y - g.y) < 3);
});
```

Render with labels:
```typescript
{gridLines.map((g, i) => (
  <g key={i}>
    <line x1={10} y1={g.y} x2={290} y2={g.y} stroke={BORDER} strokeWidth={0.5} />
    <text x={6} y={g.y + 3} fill={TEXT_3} fontSize={7} textAnchor="end">{g.label}</text>
  </g>
))}
```

---

### FILE 4: `app/components/citation-monitor.tsx`

---

#### C7 — Narrative Loading Skeleton

**Current** (line 808): `<span style={{ color: TEXT_3, fontStyle: "italic" }}>Generating insight…</span>`

**Replace with skeleton shimmer:**

```typescript
function NarrativeSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="skeleton-bar" style={{ width: "90%", height: 12, borderRadius: 6, background: TRACK }} />
      <div className="skeleton-bar" style={{ width: "75%", height: 12, borderRadius: 6, background: TRACK }} />
      <div className="skeleton-bar" style={{ width: "60%", height: 12, borderRadius: 6, background: TRACK }} />
    </div>
  );
}
```

CSS in citation-monitor.tsx `<style>` block:
```css
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
.skeleton-bar {
  background: linear-gradient(90deg, ${TRACK} 25%, rgba(0,0,0,0.04) 50%, ${TRACK} 75%) !important;
  background-size: 200% 100% !important;
  animation: shimmer 1.5s infinite !important;
}
```

---

### Shared: `ScoreArc` Component

Since both `citation-analytics.tsx` (B2) and `dimensional-intelligence.tsx` (B7) need arc gauges, extract to a shared location:

**Option A (preferred):** Define `ScoreArc` and `describeArc` in `citation-analytics.tsx` and export them. Import in `dimensional-intelligence.tsx`.

**Option B:** Define in both files (duplication but simpler). DaVinci may choose either approach.

---

## c) Unit Test Plan

**File:** `__tests__/components/visualization-overhaul.test.tsx`

**Framework:** Vitest + React Testing Library

### citation-analytics.tsx tests

| # | Test | Expected |
|---|------|----------|
| UT1 | Radar renders 7 points when promptArchitectureVersion=2 | 7 axis labels visible, not 16 |
| UT2 | Radar renders 16 points when promptArchitectureVersion=1 | 16 axis labels visible |
| UT3 | Radar labels are horizontal text (no `transform: rotate`) | No rotated `<text>` elements |
| UT4 | Radar direct labels show score values at each vertex | 7 score values visible without hover |
| UT5 | ScoreArc renders green for value ≥60 | stroke color = GREEN |
| UT6 | ScoreArc renders amber for value 20-59 | stroke color = AMBER |
| UT7 | ScoreArc renders red for value <20 | stroke color = RED |
| UT8 | ScoreArc renders 0% without error | value path has negligible arc, "0%" centered |
| UT9 | Brand bar appears first in SOV chart | First bar entry name contains "(you)" |
| UT10 | Brand bar uses ACCENT color | First Cell fill = #b45309 |
| UT11 | SOV chart has direct labels (no tooltip needed) | `<LabelList>` present in rendered output |
| UT12 | Hover class applied to ThemeRow button | Button has `.ca-interactive` class |
| UT13 | Table headers use TEXT_2 color and 12px size | Header th elements match styling |
| UT14 | "Share of Voice (SOV)" — first use spelled out | Section subtitle contains "Share of Voice" |
| UT15 | Pillar label has title attribute for truncation hover | `title` prop present on label span |
| UT16 | Mobile: competitor badge not display:none | No `display: none` rule for badge on mobile |

### dimensional-intelligence.tsx tests

| # | Test | Expected |
|---|------|----------|
| UT17 | Geo visibility renders as BarChart (not table) | Recharts `<BarChart>` present |
| UT18 | Geo bars sorted ascending (worst first) | First bar has lowest visibility |
| UT19 | Category visibility renders as BarChart | Recharts `<BarChart>` present |
| UT20 | Competitor small multiples render for top 3 geos | 3 mini charts when locationCompetitors ≥2 |
| UT21 | Small multiples include brand bar (ACCENT color) | Each mini chart has "(you)" entry |
| UT22 | Dominance diverging bars render | Left bar (ACCENT) + right bar (RED) per row |
| UT23 | Dominance sorted by gap descending | First row has largest gap |
| UT24 | Buyer intent renders as arc gauges (not progress bars) | SVG arcs present, no `<div>` progress bars |
| UT25 | Section fade-in animation classes | Each section has `.di-section` class |
| UT26 | MiniSparkline renders for ≥3 data points | SVG polyline present |
| UT27 | MiniSparkline returns null for <3 data points | No SVG rendered |
| UT28 | Green sparkline when trending up | stroke = GREEN |
| UT29 | Red sparkline when trending down | stroke = RED |
| UT30 | Version banner renders at V1↔V2 boundary | "Measurement upgraded" text present |

### citation-history.tsx tests

| # | Test | Expected |
|---|------|----------|
| UT31 | Sparkline Y-grid lines calculated from data | Grid line Y positions match min/median/max of data |
| UT32 | Y-grid dedup: no overlapping grid lines | All grid lines ≥3px apart |
| UT33 | "Average Position" spelled out | Header says "Average Position" not "Avg Position" |

### citation-monitor.tsx tests

| # | Test | Expected |
|---|------|----------|
| UT34 | Skeleton shimmer renders during narrative loading | 3 `.skeleton-bar` divs present |
| UT35 | Shimmer CSS animation applied | `animation` property includes "shimmer" |

---

## d) Integration Test Plan

**File:** `__tests__/integration/visualization-flow.test.tsx`

| # | Test | Scenario | Expected |
|---|------|----------|----------|
| IT1 | V2 check renders 7-point radar | Full render with promptArchitectureVersion=2 | 7 vertices |
| IT2 | V1 check renders 16-point radar | Full render with promptArchitectureVersion=1 | 16 vertices |
| IT3 | Score arcs + SOV chart + geo bars render together | Full result with all data | All sections visible |
| IT4 | History with mixed V1/V2 shows version banner | 2 V1 + 2 V2 checks | Banner text visible at boundary |
| IT5 | Trend sparklines render in geo bar chart | 3+ V2 history entries passed | SVG sparklines inline |
| IT6 | Mobile responsive: no info hidden | Render at 320px width | Competitor badges reflowed, not hidden |
| IT7 | Empty data: no crashes | All dimensional data empty | Clean render with no errors |

---

## e) Profiling Requirements

### What to measure
- **Render time** with realistic data (12 geo bars, 8 category bars, 3 small multiples, 8 dominance rows, 3 arc gauges, 5 sparklines)
- **Re-render cost** when parent re-renders but data unchanged

### Baseline expectations
- Initial render: < 32ms (2 frames — charts are heavier than text)
- Re-render unchanged: < 10ms

### Tool
- React DevTools Profiler
- `React.memo` the `DimensionalIntelligence` component and `ScoreArc`

---

## f) Load Test Plan

Not applicable — frontend visualization only.

---

## g) Logging & Instrumentation

None — pure frontend visualization. No API calls, no side effects.

---

## h) Acceptance Criteria

| # | Criterion | Fix |
|---|-----------|-----|
| AC1 | Radar chart shows 7 buyer pillars for V2 checks, 16 for V1 | B1 |
| AC2 | All radar labels render horizontally with score values directly labeled | D1, D2 |
| AC3 | Score overview rendered as 3 arc gauges with color thresholds (RED <20, AMBER 20-59, GREEN ≥60) | B2 |
| AC4 | Arc gauges in visual containment cards with border + shadow | C2 |
| AC5 | Brand included as first bar (ACCENT color) in Competitor SOV chart with "(you)" label | B9 |
| AC6 | SOV chart bars have direct labels (value at bar end), no tooltip dependency | B9 |
| AC7 | Geographic visibility rendered as horizontal Recharts bar chart, sorted ascending | E1 |
| AC8 | Category visibility rendered as horizontal Recharts bar chart, sorted ascending | E2 |
| AC9 | Geo + category charts as small multiples side-by-side on desktop | E2 |
| AC10 | Competitor per-geo small multiples (top 3 geos × top 3 competitors + brand) when ≥2 locationCompetitors | E3 |
| AC11 | Dominance displayed as diverging horizontal bars (your SOV left, leader SOV right) | E4 |
| AC12 | Buyer intent displayed as arc gauges, not progress bars | B7 |
| AC13 | All interactive elements have hover states (0.15s ease transition) | C1 |
| AC14 | Section transitions with staggered 100ms fade-in + translateY animation | C3 |
| AC15 | Pillar labels dynamically sized with `title` attribute for overflow | C4 |
| AC16 | Mobile: competitor badge reflowed below label, not hidden | C5 |
| AC17 | History sparkline Y-grid calculated from actual data (min/median/max) | B8 |
| AC18 | Trend sparklines (40×16px SVG) inline in geo/category rows when ≥3 V2 checks | E5 |
| AC19 | Prompt architecture version banner at V1↔V2 boundary in history | E6 |
| AC20 | Narrative loading state shows skeleton shimmer animation | C7 |
| AC21 | "Average Position" spelled out in history table header | D3 |
| AC22 | No chartjunk: no legends (direct labels only), no vertical text, no pie charts, no 3D | Tufte |
| AC23 | Responsive: desktop 1024px+ side-by-side charts, tablet 640-1024 stacked, mobile <640 single column | All |
| AC24 | 35 unit tests pass (UT1-UT35) | §c |
| AC25 | 7 integration tests pass (IT1-IT7) | §d |

---

## ScriptDev/DaVinci Implementation Notes

1. **Chart library:** Use Recharts (already installed) for bar charts and radar. Use inline SVG for sparklines, arcs, and gauges. No new chart libraries.
2. **Animation:** CSS-only `@keyframes fadeSlideIn`. No Framer Motion. Keep bundle size down.
3. **`ScoreArc` is reusable** — used in citation-analytics.tsx (B2, 80px) and dimensional-intelligence.tsx (B7, 72px). Export from one, import in the other.
4. **`describeArc()` SVG helper** uses standard arc commands. The 240° sweep (150° to 390°) leaves a gap at the bottom for aesthetics. Test with values 0, 50, and 100.
5. **Brand SOV bar**: `scores.indirectVisibility` is the brand's overall visibility across all indirect queries — this is the correct SOV proxy. The brand's SOV is already computed; we just need to add it as a bar.
6. **Sparkline data extraction from history:** Be defensive — older checks may not have `geoVisibility` (pre-ES-054). Filter to V2 checks only.
7. **Version banner detection:** History is sorted newest-first. Walk the array and find the first index where version changes from 2 to non-2.
8. **Tufte compliance checklist:** No legends (use direct labels), no vertical text (horizontal only), no decorative elements, maximum data-ink ratio.
9. **ES-057 dependency:** dimensional-intelligence.tsx doesn't exist yet. If implementing concurrently, coordinate with ES-057 implementation or implement ES-057 first.
