# TS-013 — Pro Tier Display Fix (Hotfix P0)

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** n/a  
> **Delivery Commit:** `f25466d`  

---

## What
Fix incorrect tier detection in `geo/app/sites/[id]/page.tsx`. The current
logic sets `tier = "paid"` only when `team.creditBalance > 0`, which means
users with 0 credit balance (or uncredited teams) are shown "free" tier even
though they submitted a bulk audit as a Pro user. This hides the download
button, shows paywalls, and blocks access to the aggregate report.

## Why
Bulk audit results are inaccessible for Pro users whose team `creditBalance`
is 0 or null. This is a P0 billing UX bug — the product is unusable for the
target customer (Manipal Hospitals). Confirmed during 5-URL smoke test:
`an@flowblinq.com` authenticated as Pro (passed teamMembers gate) but result
page shows "free" tier.

## Root Cause
`page.tsx` (lines 40–45):
```typescript
let tier: "free" | "paid" = "free";
if (site.teamId) {
  const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
  if (team && team.creditBalance > 0) { tier = "paid"; ... }
}
```
The `creditBalance > 0` check conflates "has credits remaining" with "is Pro".
These are distinct: a Pro user with 0 credits is still Pro.

## Correct Logic
If `site.teamId` is non-null, the site was submitted through the Pro bulk gate
(which requires the email to be in `teamMembers`). Therefore `tier = "paid"`
unconditionally when `site.teamId` is set.

Credits still populate the `credits` field for display purposes; only tier
determination changes.

## Dependencies
None. Single file change, no schema or API changes.

## Implementation Requirements

### File to modify
`geo/app/sites/[id]/page.tsx` — lines 37–46

### Current code
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

### Replacement
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

## Acceptance Criteria
- [ ] Viewing a bulk audit result for a user with `site.teamId` non-null shows `tier = "paid"` regardless of `creditBalance`
- [ ] Download button appears for bulk audits (rendered when `tier === "paid"`)
- [ ] Paywall overlay hidden for bulk results
- [ ] Single audits with `site.teamId = null` remain `tier = "free"` (unchanged)
- [ ] `credits` field still populated correctly for display

## Risks
Low. Single-line logic change. Only affects display tier derivation — no API
calls, no DB writes, no schema changes.

## Priority
P0 — hotfix. Dispatch directly to ScriptDev, skip ReviewMaster.

## Commit target
`main` — Vercel will auto-deploy.
