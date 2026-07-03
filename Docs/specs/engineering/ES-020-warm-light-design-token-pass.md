# ES-020: Warm-Light Design Token Pass

**Status:** Draft
**Author:** SpecMaster (2-specmaster)
**Date:** 2026-03-03
**Source TS:** TS-020-warm-light-design-token-pass.md
**Priority:** P2
**Downstream:** ReviewMaster → ScriptDev
**Branch:** New branch off `dev-sprint-8` after PR #116 merges

---

## a) Overview

Applies a consistent warm-light color theme across 9 UI pages. All 9 files use inline `style={{}}` objects (no Tailwind, no CSS variables). This is a color token substitution pass — no layout changes, no functional changes.

**Reference technical spec:** TS-020-warm-light-design-token-pass.md
**Design commits on main:** `8577eb1`, `f00af4e`, `c9ef384`

### Current state (read during spec)

| File | Current theme | Action |
|------|--------------|--------|
| `app/page.tsx` | Dark (`#000` bg, `#fff` text) | **Replace** |
| `app/auth/login/page.tsx` | Dark (`BG="#000"`, `TEXT_PRIMARY="#fff"`) | **Replace** |
| `app/dashboard/page.tsx` | Warm-light (`BG="#faf8f5"`) | **Verify only** — already done |
| `app/dashboard/HoverCard.tsx` | Warm-light (`#ffffff` cards, `#1c1917` text) | **Verify only** — already done |
| `app/pricing/page.tsx` | Dark (`BG="#000"`, `BLUE="#2563eb"` accent) | **Replace** |
| `app/sites/[id]/ResultsDashboard.tsx` | Dark (constants at top of file) | **Replace** |
| `app/sites/[id]/SitePageClient.tsx` | Dark (`BG="#000"`, module-level constants) | **Replace** |
| `app/sites/[id]/page.tsx` | Mixed — access-denied block is dark | **Replace** error block only |
| `app/verify/[id]/page.tsx` | Dark (`#000`, `#0a0a0a`, `#222`) | **Replace** |

**No changes to:** any TypeScript logic, props, hooks, API calls, event handlers, or functional behavior.

---

## b) Implementation Requirements

### Canonical Warm-Light Token Map

Apply these substitutions. All values are exact CSS color strings.

| Dark token | Warm-light replacement | Role |
|-----------|------------------------|------|
| `#000` / `#000000` | `#FAF8F5` | Page background |
| `#0a0a0a` / `#050505` | `#FFFFFF` | Input / card surface |
| `#111` / `#1a1a1a` (background use) | `#FAF8F5` | Subtle background tint |
| `#fff` / `#ffffff` (text) | `#1A1A1A` | Primary text |
| `#888` / `#999` / `#aaa` | `#78716C` | Secondary text (stone-500) |
| `#666` / `#555` / `#444` | `#78716C` | Muted text — consolidate to stone-500 |
| `#222` / `#333` (border) | `#E8E4DE` | Borders |
| `#111` / `#1a1a1a` (border) | `#E8E4DE` | Borders |
| `#2563eb` (blue accent) | `#B45309` | Accent (amber-700, matches dashboard) |
| `#333` (disabled button bg) | `#D1CBC2` | Disabled state |
| White button (`#fff` bg, `#000` text) | `#1A1A1A` bg, `#FFFFFF` text | Primary CTA |
| `borderLeft: "3px solid #fff"` | `3px solid #B45309` | Accent border |

**Semantic colors — do NOT change:**
- `#ef4444` / `#dc2626` (red — errors)
- `#22c55e` / `#16a34a` (green — success, scores)
- `#f59e0b` / `#d97706` (amber — warnings, pending states)
- `#fef3c7` / `#fffbeb` (yellow tint — in-progress badges)
- `#f0fdf4` / `#fef2f2` (semantic feedback backgrounds — keep)
- `#bbf7d0` / `#fecaca` (semantic feedback borders — keep)

---

### Per-File Instructions

#### 1. `app/page.tsx`

Module-level constants do not exist — colors are inline throughout. Apply token map to all inline style objects.

Key changes:
- `<main>` background: `#000` → `#FAF8F5`; text color: `#fff` → `#1A1A1A`
- Nav: border `#111` → `#E8E4DE`; link `color: "#666"` → `#78716C`
- Nav button (Dashboard/Sign in): `background: "#111", border: "1px solid #333", color: "#fff"` → `background: "#FFFFFF", border: "1px solid #E8E4DE", color: "#1A1A1A"`
- Hero tag pill: `background: "#111", border: "1px solid #222", color: "#999"` → `background: "#F5F2EE", border: "1px solid #E8E4DE", color: "#78716C"`
- `h1 span`: `color: "#666"` → `#78716C`
- `p` description: `color: "#888"` → `#78716C`
- URL input: `background: "#0a0a0a"` / `"#050505"` → `#FFFFFF`; border `#222` → `#E8E4DE`; color `#fff` → `#1A1A1A`; disabled bg `#050505` → `#F5F2EE`; disabled color `#444` → `#A8A29E`
- CSV drop zone: `background: "#050505"` → `#FFFFFF`; `border: "2px dashed #333"` → `2px dashed #E8E4DE` (when active/loaded: `#22c55e` — keep)
- CSV drop zone inner text: `color: "#888"` → `#78716C`; `color: "#555"` → `#78716C`; `color: "#fff"` (Pro label) → `#1A1A1A`
- CSV pricing message: `background: "#0a0a0a", border: "1px solid #222"` → `background: "#FFFFFF", border: "1px solid #E8E4DE"`; `color: "#888"` → `#78716C`
- Email input: same as URL input
- Submit button: `background: loading ? "#333" : "#fff", color: "#000"` → `background: loading ? "#D1CBC2" : "#1A1A1A", color: "#FFFFFF"` (loading color stays correct; text always white)
- Footer note `color: "#444"` → `#78716C`
- Stats block: `background: "#0a0a0a", border: "1px solid #1a1a1a", borderLeft: "3px solid #fff"` → `background: "#FFFFFF", border: "1px solid #E8E4DE", borderLeft: "3px solid #B45309"`
- Stats text `color: "#666"` → `#78716C`
- Feature cards: `background: "#0a0a0a", border: "1px solid #1a1a1a"` → `background: "#FFFFFF", border: "1px solid #E8E4DE"`
- Feature card `h3` color `#fff` (implicit) → `#1A1A1A`
- Feature card `p` `color: "#666"` → `#78716C`
- Footer: `borderTop: "1px solid #111"` → `1px solid #E8E4DE`; `color: "#444"` → `#78716C`

#### 2. `app/auth/login/page.tsx`

Uses module-level constants at lines 64–67:
```typescript
const BG = "#000";
const BORDER = "#1a1a1a";
const TEXT_PRIMARY = "#fff";
const TEXT_SECONDARY = "#888";
```

Replace with:
```typescript
const BG = "#FAF8F5";
const BORDER = "#E8E4DE";
const TEXT_PRIMARY = "#1A1A1A";
const TEXT_SECONDARY = "#78716C";
```

Additional inline changes (not covered by constants):
- OTP input: `background: "#0a0a0a"` → `#FFFFFF`; `color: TEXT_PRIMARY` already covered
- Email input: `background: "#0a0a0a"` → `#FFFFFF`
- Submit button (active): `background: TEXT_PRIMARY` was `#fff` bg with `color: "#000"` → after constant swap, TEXT_PRIMARY = `#1A1A1A`, so button bg = `#1A1A1A`, add `color: "#FFFFFF"` explicitly (was `#000`)
- Submit button (disabled): `background: "#333"` → `#D1CBC2`; `color: "#000"` implicit → `color: "#FFFFFF"`
- "Use a different email" back button: `color: TEXT_SECONDARY` → already covered
- "Back to home" link: `color: TEXT_SECONDARY` → already covered

#### 3. `app/dashboard/page.tsx`

**No code changes.** File already uses warm-light tokens:
- `BG = "#faf8f5"` (matches `#FAF8F5`)
- `CARD = "#ffffff"` ✓
- `TEXT = "#1c1917"` (stone-900, acceptable warm-light equivalent)
- `TEXT_2 = "#78716c"` ✓
- `ACCENT = "#b45309"` ✓

Action: visual verification on Vercel preview only.

#### 4. `app/dashboard/HoverCard.tsx`

**No code changes.** File already warm-light:
- `background: "#ffffff"` ✓
- `TEXT = "#1c1917"` ✓
- `TEXT_2 = "#78716c"` ✓
- `TEXT_3 = "#a8a29e"` ✓
- Status badge backgrounds are semantic (green/amber/red) — keep

Action: visual verification only.

#### 5. `app/pricing/page.tsx`

Uses module-level constants at lines 32–38:
```typescript
const BG = "#000";
const CARD = "#0a0a0a";
const BORDER = "#1a1a1a";
const TEXT_PRIMARY = "#fff";
const TEXT_SECONDARY = "#888";
const BLUE = "#2563eb";
const GREEN = "#22c55e";
```

Replace with:
```typescript
const BG = "#FAF8F5";
const CARD = "#FFFFFF";
const BORDER = "#E8E4DE";
const TEXT_PRIMARY = "#1A1A1A";
const TEXT_SECONDARY = "#78716C";
const BLUE = "#B45309";       // warm amber replacing blue accent
const GREEN = "#22c55e";      // keep — semantic success color
```

Additional inline changes:
- Feature row label: `color: "#ccc"` → `#1A1A1A` (was dark-mode lightened text; now use primary)
- Free tier "Start Audit" button: `background: "#1a1a1a", border: "1px solid ${BORDER}"` → the constant swap makes BORDER = `#E8E4DE`; update button background to `#1A1A1A` (explicit dark CTA — intentional for contrast on white card)
- Recommended badge on paid card: `background: BLUE` → now amber `#B45309` ✓ (via constant)
- Paid tier card border `2px solid ${BLUE}` → now amber ✓ (via constant)
- Paid tier card CTA button `background: BLUE` → amber ✓

#### 6. `app/sites/[id]/SitePageClient.tsx`

Uses module-level constants at lines 72–78:
```typescript
const BG = "#000";
const BORDER = "#1a1a1a";
const TEXT_PRIMARY = "#fff";
const TEXT_SECONDARY = "#888";
const GREEN = "#22c55e";
const RED = "#ef4444";
const AMBER = "#f59e0b";
```

Replace the non-semantic constants:
```typescript
const BG = "#FAF8F5";
const BORDER = "#E8E4DE";
const TEXT_PRIMARY = "#1A1A1A";
const TEXT_SECONDARY = "#78716C";
const GREEN = "#22c55e";    // keep
const RED = "#ef4444";      // keep
const AMBER = "#f59e0b";    // keep
```

Scan remaining inline styles in this file (not covered by these constants):
- Loading/progress skeleton backgrounds (`#111`, `#1a1a1a`) → `#E8E4DE`
- Any hardcoded `background: "#000"` → `#FAF8F5`
- Any hardcoded `color: "#fff"` used as text → `#1A1A1A`
- Email gate form inputs: `background: "#0a0a0a"` → `#FFFFFF`; border colors → `#E8E4DE`
- Email gate submit button (active): `#fff` bg → `#1A1A1A` bg, ensure `color: "#FFFFFF"`
- Email gate submit button (disabled): `#333` → `#D1CBC2`

#### 7. `app/sites/[id]/page.tsx`

Only the "access denied" inline block needs changes (lines 25–32). The rest of the file has no rendering beyond passing data to `SitePageClient`.

Change the access denied block:
```tsx
// BEFORE:
<main style={{ minHeight: "100vh", background: "#000", color: "#fff", ... }}>
  <h1 style={{ ... }}>Access denied</h1>
  <p style={{ color: "#666" }}>Invalid access token.</p>
  <a href="/" style={{ color: "#fff", ... }}>Start a new audit</a>

// AFTER:
<main style={{ minHeight: "100vh", background: "#FAF8F5", color: "#1A1A1A", ... }}>
  <h1 style={{ ... }}>Access denied</h1>
  <p style={{ color: "#78716C" }}>Invalid access token.</p>
  <a href="/" style={{ color: "#B45309", ... }}>Start a new audit</a>
```

#### 8. `app/verify/[id]/page.tsx`

Inline styles only (no module-level constants). Apply token map throughout.

Key changes:
- `<main>` background `#000` → `#FAF8F5`; color `#fff` → `#1A1A1A`
- `inputStyle` object (lines 81–84): `background: "#0a0a0a"` → `#FFFFFF`; `border: "1px solid #222"` → `1px solid #E8E4DE`; `color: "#fff"` → `#1A1A1A`
- Error block: `background: '#1a0000', border: '1px solid #440000'` → `background: "#FEF2F2", border: "1px solid #FECACA"` (light red, semantic — not dark/warm substitution)
- Error text: `color: '#ef4444'` → keep (semantic red)
- Success block: `background: '#001a00', border: '1px solid #004400'` → `background: "#F0FDF4", border: "1px solid #BBF7D0"` (light green, semantic)
- Submit button: disabled → `background: '#D1CBC2', color: '#78716C'`; active → `background: '#1A1A1A', color: '#FFFFFF'`
- Separator: `borderTop: '1px solid #1a1a1a'` → `1px solid #E8E4DE`
- "Did not receive" text: `color: '#666'` → `#78716C`
- Resend email input: `background: '#0a0a0a', border: '1px solid #222', color: '#fff'` → `background: "#FFFFFF", border: "1px solid #E8E4DE", color: "#1A1A1A"`
- Resend button: `background: '#1a1a1a', color: '#fff', border: '1px solid #333'` → `background: "#1A1A1A", color: "#FFFFFF", border: "1px solid #E8E4DE"` (intentional dark CTA)

#### 9. `app/sites/[id]/ResultsDashboard.tsx`

ScriptDev must read the full file (not shown in spec review — file is large). Apply token map to all module-level color constants and inline styles.

Pattern to find and replace:
- Any module-level constant block like `const BG = "#000"` → apply token map
- Any `background: "#000"` / `"#0a0a0a"` / `"#111"` → warm-light equivalents
- Any `color: "#fff"` used as text → `#1A1A1A`
- Any `border: "1px solid #222"` / `"#1a1a1a"` → `#E8E4DE`
- Scorecard pillar row backgrounds — likely dark card surfaces → `#FFFFFF`
- **Do not** change score colors (green/amber/red based on score values)
- **Do not** change any conditional logic that computes color from score thresholds

---

## c) Unit Test Plan

**Test file:** `geo/__tests__/warm-light-tokens.test.ts`

This spec does not introduce functional behavior — no new logic to unit test. The test plan covers regression protection: verify no functional imports or logic was accidentally changed during the token pass.

| ID | Test | Method |
|----|------|--------|
| T-1 | `app/page.tsx` renders without TypeScript errors | `npm run build` passes |
| T-2 | `app/auth/login/page.tsx` login flow: email submit, OTP verify states render | Existing auth flow tests pass |
| T-3 | `app/pricing/page.tsx` renders feature table with correct data from config | Existing `__tests__/pricing-page.test.tsx` passes |
| T-4 | `app/dashboard/HoverCard.tsx` renders domain card with score | Existing `__tests__/payment-toast.test.tsx` and dashboard tests pass |
| T-5 | `app/verify/[id]/page.tsx` 6-digit input logic unchanged | No regressions in verify flow |

**Primary test method: `npm run build`** — TypeScript compiler will catch any accidental deletion of JSX props or type errors introduced during the token substitution.

**Secondary: full test suite** — `npm test` must pass with 0 new failures.

No new test file needed — this is a visual-only change validated by the build + existing tests + Vercel preview.

---

## d) Integration Test Plan

| ID | Scenario | Method |
|----|----------|--------|
| I-1 | All 9 pages load without JS console errors on Vercel preview | Manual QA on preview deploy |
| I-2 | Login flow works end-to-end on warm-light login page | Manual QA: email → OTP → dashboard redirect |
| I-3 | Homepage form submission flow unchanged | Manual QA: enter url + email → verify page |
| I-4 | Verify page OTP input logic unchanged | Manual QA: 6-digit entry, paste, backspace navigation |
| I-5 | Pricing page "Buy Credits" link goes to /dashboard | Manual check |
| I-6 | Dashboard domain cards render correctly after token pass | Manual QA (no-op — already warm-light) |

---

## e) Profiling Requirements

Not applicable — this change is purely cosmetic with no new computation, DB queries, or API calls. No performance impact expected.

---

## f) Load Test Plan

Not applicable — no new API surface, no behavioral changes.

---

## g) Logging & Instrumentation

Not applicable — no new events, metrics, or log points.

---

## h) Acceptance Criteria

- [ ] `npm run build` passes with 0 TypeScript errors after token pass
- [ ] `npm test` passes — 0 new test failures
- [ ] All 7 dark files now render with `#FAF8F5` page background (verified on Vercel preview)
- [ ] All primary text is `#1A1A1A` (not white) on warm-light backgrounds
- [ ] All secondary/muted text is `#78716C` (stone-500)
- [ ] Card surfaces are `#FFFFFF` with `#E8E4DE` borders
- [ ] Blue accent (`#2563eb`) replaced with amber (`#B45309`) on pricing page
- [ ] Semantic colors unchanged: error red, success green, score-band colors, in-progress amber badges
- [ ] `app/dashboard/page.tsx` and `HoverCard.tsx` unchanged — visual parity confirmed
- [ ] Sprint-7/8/9 functional features untouched: brand monitoring tab, citation UI, bulk audit components, API visibility sections, all form logic

---

## Notes for ScriptDev

1. **Read ResultsDashboard.tsx in full before editing** — it's the largest file in this set and was not fully read during spec authoring. Apply token map methodically from top to bottom. Do not blindly find-replace — check each occurrence in context.

2. **Button color inversion:** In the dark theme, primary CTAs were white buttons with black text. In warm-light, invert: dark (`#1A1A1A`) button with white text. This applies to homepage submit, login/verify submit buttons. The dashboard already demonstrates this pattern correctly.

3. **`app/dashboard/page.tsx` uses `#1c1917` not `#1A1A1A`** — this is stone-900 vs a custom dark. Both are acceptable warm-light text values. Do not change the dashboard file to avoid unnecessary diff noise on already-working pages.

4. **Disabled states:** Replace `#333` disabled backgrounds with `#D1CBC2` (a warm greige). This maintains the visual hierarchy (lighter than the active `#1A1A1A` CTA) without the dark-theme-specific grey.

5. **Branch:** Create new branch off `dev-sprint-8` after PR #116 (ES-019) merges. Do not open this PR against `dev-sprint-8` until ES-019 is merged — avoids UI file conflicts with the dashboard additions in ES-019.

6. **Vercel preview required** before merge — visual confirmation is the primary acceptance check for this spec.
