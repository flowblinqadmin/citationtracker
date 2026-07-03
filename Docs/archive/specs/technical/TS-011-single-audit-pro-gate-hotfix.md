# TS-011: HOTFIX — Restore Pro Gate on Single-Audit Path

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** n/a  
> **Delivery Commit:** `233ac6c`  

---

**Agent:** CoFounder (1)
**Date:** 2026-03-01
**Priority:** P0 — PRODUCTION ISSUE. Live on Vercel now.
**Downstream:** ES-011 → ScriptDev (fast-track)

---

## What

Restore the Pro account gate on the single-audit path (`POST /api/sites`, single-URL branch).

The gate was present in `507ab9f` (Adithya Rao, Feb 28) and was accidentally dropped during the rebase conflict resolution when merging `dev-an-m2-extended` into `main`.

## Why This Is Critical

Without the gate, any authenticated user (or bot) can submit unlimited single-URL audits without consuming credits. The credit system only enforces limits on the bulk path. Single-audit is effectively free and unmetered in production right now.

Abuse vector: authenticate once → loop POST /api/sites with different URLs → unlimited free crawls.

## The Fix

**File:** `geo/app/api/sites/route.ts`
**Location:** Single-audit branch (POST handler, `isBulk === false` path), between the rate-limit check and `const domain = normalizeDomain(normalizedUrl)`.

**Insert this block:**
```typescript
// Free-tier single audits temporarily paused — Pro accounts only
if (!isInternalEmail) {
  const [proMember] = await db.select().from(teamMembers).where(eq(teamMembers.email, emailLower));
  if (!proMember) {
    return NextResponse.json(
      { error: "Free audits are temporarily paused. Sign up for a Pro account to run an audit." },
      { status: 402 }
    );
  }
}
```

This block was present verbatim in `507ab9f`. The exact insertion point (after rate limit, before domain extraction) is unchanged.

**Note:** `teamMembers` and the DB import are already in scope — no new imports needed.

## Verification

After fix:
- Non-Pro email → `POST /api/sites` → 402 with error message
- Pro email (`teamMembers` row exists) → proceeds normally
- `@flowblinq.com` emails → bypass gate (`isInternalEmail = true`)
- Existing unit test for free-tier 402 (`api-routes.test.ts`) must pass (it was removed during rebase — restore it too)

## Deployment

Merge hotfix commit directly to `main` → Vercel auto-deploys.
No DB migration required. No schema changes.

## Acceptance Criteria

- [ ] Gate block restored in `app/api/sites/route.ts` single-audit path
- [ ] Non-Pro user gets 402 on single-audit attempt
- [ ] Pro user (in `teamMembers`) proceeds to audit
- [ ] `@flowblinq.com` internal emails bypass gate
- [ ] Unit test for 402 free-tier gate restored in `api-routes.test.ts`
- [ ] All 743 tests pass
- [ ] Deployed to Vercel (main push)
