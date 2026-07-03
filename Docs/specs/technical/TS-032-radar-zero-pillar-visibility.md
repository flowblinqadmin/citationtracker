# TS-032 — Radar Chart: Show for Zero-Value Pillar Visibility

**Date:** 2026-03-05
**Status:** Draft — pending SpecMaster ES conversion
**Priority:** P2 (UX bug — misleading empty state)

---

## What

Fix the radar chart in `CitationAnalytics` so it renders even when all pillar visibility values are 0 (domain not cited in indirect queries), and update the empty-state message for the true "no data" case.

---

## Why (Root Cause)

In `app/components/citation-analytics.tsx`, the radar visibility gate is:

```typescript
const hasAnyPillarData = radarData.some(d => d.value > 0);
```

This returns `false` when `pillarVisibility` has all 16 pillars defined but all at 0 (e.g., `sebamedindia.com` with `indirect_visibility = 0%`). The domain IS getting 40 indirect prompts — it just isn't being cited in them.

The empty-state message shown is:

> "Pillar data requires 40+ indirect prompts — run another check to populate."

This is **misleading**: the domain already has 40 indirect prompts. The issue is citation visibility, not prompt count.

The all-zero radar chart is **informative UX** — it shows the user their domain isn't being cited in any GEO pillar category, motivating GEO optimization work.

---

## Dependencies

- `app/components/citation-analytics.tsx` — Section B (radar) gating condition

---

## Interface Change

### Before (broken gating):
```typescript
const hasAnyPillarData = radarData.some(d => d.value > 0);

// ...
{hasAnyPillarData ? (
  <ResponsiveContainer ...>
    <RadarChart ...>...</RadarChart>
  </ResponsiveContainer>
) : (
  <p style={{ color: TEXT_2, fontSize: 13 }}>Pillar data requires 40+ indirect prompts — run another check to populate.</p>
)}
```

### After (correct gating):
```typescript
// Show radar if pillar structure was computed (any pillars present), even if all values are 0.
// Only show empty state if pillarVisibility has NO entries at all (no check run yet, or pre-TS-029 data).
const hasPillarStructure = Object.keys(scores.pillarVisibility).length > 0;

// ...
{hasPillarStructure ? (
  <ResponsiveContainer ...>
    <RadarChart ...>...</RadarChart>
  </ResponsiveContainer>
) : (
  <p style={{ color: TEXT_2, fontSize: 13 }}>No pillar data yet. Run a citation check to see GEO Pillar Visibility.</p>
)}
```

---

## Acceptance Criteria

1. **AC-1** — When `pillarVisibility` has 16 entries all at 0 (domain not cited in indirect queries), the radar chart renders (showing all spokes at zero / flat ring).
2. **AC-2** — When `pillarVisibility` is `{}` (empty object — pre-TS-029 DB rows or no check run), the empty state "No pillar data yet. Run a citation check to see GEO Pillar Visibility." is shown.
3. **AC-3** — When `pillarVisibility` has non-zero values (domain cited in indirect queries), the radar renders with the correct spoke heights — unchanged from current behavior.
4. **AC-4** — All existing citation-monitor / citation-analytics tests pass.
5. **AC-5** — No change to the score triptych, provider bars, or competitor bars sections.

---

## Risks

- Very low risk — 2-line change in a conditional block.
- No server-side changes required.
- No DB changes required.
- Behavior change only on the "all zeros" case (previously empty state → now shows flat radar).

---

## Out of Scope

- Improving the GEO optimization recommendations based on zero-pillar domains.
- Changing the prompt count or retry logic.
