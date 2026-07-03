# ES-032 — Radar Chart: Show for Zero-Value Pillar Visibility

**Date:** 2026-03-05
**Priority:** P2 (UX bug — misleading empty state)
**Technical Spec:** TS-032-radar-zero-pillar-visibility.md
**Status:** READY — dispatch to ReviewMaster

---

## a) Overview

2-line change in `app/components/citation-analytics.tsx`. The radar chart gate `hasAnyPillarData = radarData.some(d => d.value > 0)` incorrectly hides the radar when all 16 pillars are present but all at 0 (domain not cited in indirect queries). This shows a misleading empty-state message implying prompts haven't been run, when in fact the check ran and the result is zero citation — which is meaningful signal. Fix: gate on presence of pillar keys, not non-zero values.

No server changes. No DB changes. No other files.

---

## b) Implementation Requirements

### File: `geo/app/components/citation-analytics.tsx`

#### Change 1 — line 166: replace `hasAnyPillarData` with `hasPillarStructure`

**Before:**
```typescript
const hasAnyPillarData = radarData.some(d => d.value > 0);
```

**After:**
```typescript
// Show radar if pillar structure was computed (any pillars present), even if all values are 0.
// Only show empty state if pillarVisibility has NO entries (no check run yet, or pre-TS-029 data).
const hasPillarStructure = Object.keys(scores.pillarVisibility).length > 0;
```

#### Change 2 — line 171 and 188: update gate variable and empty-state message

**Before:**
```typescript
{hasAnyPillarData ? (
  <ResponsiveContainer ...>
    ...
  </ResponsiveContainer>
) : (
  <p style={{ color: TEXT_2, fontSize: 13 }}>Pillar data requires 40+ indirect prompts — run another check to populate.</p>
)}
```

**After:**
```typescript
{hasPillarStructure ? (
  <ResponsiveContainer ...>
    ...
  </ResponsiveContainer>
) : (
  <p style={{ color: TEXT_2, fontSize: 13 }}>No pillar data yet. Run a citation check to see GEO Pillar Visibility.</p>
)}
```

These are the only two changes. The `radarData` mapping (line 163), `ResponsiveContainer`/`RadarChart` internals, and all other sections (score triptych, provider bars, competitor bars) are untouched.

---

## c) Unit Test Plan

**File:** `geo/__tests__/citation-analytics.test.tsx` (new or extend existing)

**Framework:** Vitest + React Testing Library.

### Test cases

| ID | Name | Input `pillarVisibility` | Expected |
|----|------|--------------------------|----------|
| RZ-1 | Radar renders when all 16 pillars at 0 | `{ faq_coverage: 0, author_authority: 0, ... }` (16 keys, all 0) | `<RadarChart>` present in DOM; empty-state `<p>` absent |
| RZ-2 | Empty state shown when pillarVisibility is `{}` | `{}` | Empty-state text "No pillar data yet. Run a citation check..." present; `<RadarChart>` absent |
| RZ-3 | Radar renders with non-zero values (unchanged) | `{ faq_coverage: 67, author_authority: 33 }` | `<RadarChart>` present; non-zero spokes rendered |
| RZ-4 | Score triptych, provider bars, competitor bars unchanged | Any valid scores | Other sections unaffected by gate change |
| RZ-5 | All existing citation-analytics tests pass | Existing fixtures | No regressions |

**Coverage target:** Both branches of `hasPillarStructure` (empty object → false; any keys → true).

---

## d) Integration Test Plan

No dedicated integration test needed. RZ-1..RZ-3 cover all meaningful rendering states. The existing E2E citation-analytics tests cover the broader component.

---

## e–g) Profiling / Load / Logging

Not applicable — pure conditional rendering change with no performance or logging impact.

---

## h) Acceptance Criteria

| AC | Criterion | Test |
|----|-----------|------|
| AC-1 | 16 pillars all at 0 → radar renders (flat ring), no empty state | RZ-1 |
| AC-2 | `pillarVisibility = {}` → empty state "No pillar data yet…", no radar | RZ-2 |
| AC-3 | Non-zero pillar values → radar renders correctly, unchanged | RZ-3 |
| AC-4 | All existing citation-analytics tests pass | RZ-5 |
| AC-5 | Score triptych, provider bars, competitor bars unaffected | RZ-4 |
