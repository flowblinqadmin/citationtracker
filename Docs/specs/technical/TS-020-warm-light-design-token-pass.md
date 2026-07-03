# TS-020: Warm-Light Design Token Pass

**Status:** Draft
**Author:** CoFounder
**Date:** 2026-03-03
**Downstream:** SpecMaster → ReviewMaster → ScriptDev
**Priority:** P2 (aesthetic, non-blocking for feature work)

---

## Context

During the merge of `origin/main` into `dev-sprint-8-es016`, ScriptDev preserved sprint-8's dark theme as the base for all 9 UI pages to avoid overwriting functional additions (brand monitoring, citation UI, bulk audit improvements). However, `origin/main` had progressed to a warm-light design system (design commits: `8577eb1`, `f00af4e`, `c9ef384`) with a cohesive color token set.

The decision: **adopt warm-light as the production theme**. This TS specifies applying the warm-light design tokens across all affected pages without disturbing any functional additions made in sprints 7–9.

---

## What Changed in Main (Warm-Light)

The warm-light pass on main introduced:
- Background: `#FAF8F5` (warm off-white) replacing dark `#0a0a0a`
- Primary text: `#1A1A1A` replacing `#ededed`
- Accent: warm amber/gold tones replacing cool blue
- Card surfaces: `#FFFFFF` with `border: 1px solid #E8E4DE`
- Hero section: reduced subtitle bottom margin (`48px → 24px`, already applied)
- Consistent `font-family: var(--font-geist-sans)` usage

Affected files (9 UI pages from conflict report):
- `app/page.tsx`
- `app/auth/login/page.tsx`
- `app/dashboard/page.tsx`
- `app/dashboard/HoverCard.tsx`
- `app/pricing/page.tsx`
- `app/sites/[id]/ResultsDashboard.tsx`
- `app/sites/[id]/SitePageClient.tsx`
- `app/sites/[id]/page.tsx`
- `app/verify/[id]/page.tsx`

---

## Approach

1. **Audit main's design token commits** (`8577eb1`, `f00af4e`, `c9ef384`) to extract the canonical warm-light color values and spacing rules.
2. **Apply token by token** to each affected file — do not wholesale replace file content.
3. **Preserve all sprint-8 functional additions** untouched: brand monitoring tab, citation UI, bulk audit components, API visibility sections.
4. **Verify visually** (Vercel preview deploy) before merging.

---

## Acceptance Criteria

1. All 9 pages render with warm-light palette (background `#FAF8F5`, text `#1A1A1A`, warm accent).
2. No sprint-7/8/9 functional feature is missing or broken after token application.
3. `npm run build` passes with no TS errors.
4. All existing tests still pass (no functional regressions).
5. Vercel preview deploy shows consistent warm-light theme across all pages.

---

## Dependencies

- Must be done **after** ES-019 implementation lands (do not do this in parallel with ES-019 — avoid UI file conflicts).
- Branch: new branch off `dev-sprint-8` (post ES-019 merge).

---

## Out of Scope

- New UI components or layout changes
- Mobile responsiveness improvements
- Dark mode toggle (not planned)
