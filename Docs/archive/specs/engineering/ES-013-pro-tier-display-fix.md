# ES-013: HOTFIX — Pro Tier Display Fix

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** n/a  
> **Delivery Commit:** `f25466d`  

---

**Source:** TS-013-pro-tier-display-fix.md
**Agent:** 2-SpecMaster
**Date:** 2026-03-02
**Priority:** P0 — hotfix, deploy immediately
**Downstream:** ScriptDev (agent 6) — direct, skip ReviewMaster
**Branch:** `main` (direct commit, Vercel auto-deploys)

---

## a) Overview

### What This Covers

Single-line logic fix in `geo/app/sites/[id]/page.tsx`. The tier derivation
incorrectly gates `tier = "paid"` on `creditBalance > 0`, making bulk audit
results inaccessible for Pro users with 0 credits. The fix: if `site.teamId`
is set, the site went through the Pro gate — `tier = "paid"` unconditionally.

### Current State (confirmed by source read)

Lines 37–46 of `geo/app/sites/[id]/page.tsx`:
```typescript
let tier: "free" | "paid" = "free";
let credits = 0;
if (site.teamId) {
  try {
    const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
    if (team && team.creditBalance > 0) { tier = "paid"; credits = team.creditBalance; }
    else if (team) { credits = team.creditBalance; }
  } catch { /* default to free */ }
}
```

Confirmed: exact match to TS-013. One file change, no imports, no schema changes.

---

## b) Implementation Requirements

### File: `geo/app/sites/[id]/page.tsx` — lines 37–46

**Replace:**
```typescript
let tier: "free" | "paid" = "free";
let credits = 0;
if (site.teamId) {
  try {
    const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
    if (team && team.creditBalance > 0) { tier = "paid"; credits = team.creditBalance; }
    else if (team) { credits = team.creditBalance; }
  } catch { /* default to free */ }
}
```

**With:**
```typescript
let tier: "free" | "paid" = "free";
let credits = 0;
if (site.teamId) {
  try {
    const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
    if (team) {
      tier = "paid";   // teamId present → Pro submission; credits separate from tier
      credits = team.creditBalance;
    }
  } catch { /* default to free */ }
}
```

No new imports. No other files to change.

---

## c) Unit Test Plan

Add one test to `__tests__/api-routes.test.ts` or the nearest page-level test file:

| Test | Setup | Expected |
|------|-------|----------|
| Pro user with 0 credits gets `tier = "paid"` | `site.teamId = "team-1"`, `team.creditBalance = 0` | `tier === "paid"`, `credits === 0` |
| Pro user with credits gets `tier = "paid"` | `site.teamId = "team-1"`, `team.creditBalance = 50` | `tier === "paid"`, `credits === 50` |
| No teamId stays `tier = "free"` | `site.teamId = null` | `tier === "free"`, no DB query |

If a unit test for `page.tsx` does not exist (it's a server component — harder to unit test), skip and rely on the manual acceptance check below. Do not create a test file that doesn't exist yet — that's scope beyond the hotfix.

---

## d) Integration Test Plan

Manual check before committing:

1. Load a bulk audit result URL for `an@flowblinq.com` with `site.teamId` non-null and `creditBalance = 0`
2. Confirm download button is visible (rendered when `tier === "paid"`)
3. Confirm paywall overlay is hidden
4. Load a single audit result for an anonymous user (`site.teamId = null`) — confirm still `tier = "free"`

---

## e–g) Profiling / Load / Logging

Not applicable. Single conditional change — no new DB queries, no new logging.

---

## h) Acceptance Criteria

- [ ] `tier = "paid"` for any `site.teamId` non-null, regardless of `creditBalance`
- [ ] Download button visible for bulk audit results
- [ ] Paywall overlay hidden for bulk audit results
- [ ] `site.teamId = null` remains `tier = "free"` (unchanged)
- [ ] `credits` field still populated from `team.creditBalance` (display only)
- [ ] All existing tests pass (`npm test`)
- [ ] Committed to `main` — Vercel auto-deploys

---

## ScriptDev Notes

- **One file. One block replacement.** Lines 37–46 of `geo/app/sites/[id]/page.tsx`.
- **No new imports.** No schema changes. No other files.
- **Commit to `main` directly.** Message: `hotfix: fix Pro tier display for 0-credit users (TS-013)`
- **Run `npm test` before committing.** All tests must pass.
