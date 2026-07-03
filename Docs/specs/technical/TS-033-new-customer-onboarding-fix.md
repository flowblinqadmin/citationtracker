# TS-033 — New Customer Onboarding: Fix Pro Gate + Stripe Webhook Silent Drop

**Date:** 2026-03-05
**Status:** Draft — pending SpecMaster ES conversion
**Priority:** P1 (blocks all new customer acquisition)

---

## What

Two bugs that together prevent a brand-new customer from successfully submitting an audit and purchasing credits:

1. **Primary (P1 blocker):** `POST /api/sites` blocks any email not already in `teamMembers` with a 402: `"Free audits are temporarily paused. Sign up for a Pro account to run an audit."` — new customers are never in `teamMembers` before signing up, so the entire onboarding funnel is dead.

2. **Secondary:** Stripe webhook silently returns HTTP 200 (no error, no Stripe retry) when `teamId` is missing or empty in session metadata — payments are silently dropped with no visibility.

---

## Why (Root Cause)

### Bug 1 — Pro gate at submission (`api/sites/route.ts`)

Lines 178-188:
```typescript
const [proMember] = await db.select().from(teamMembers).where(eq(teamMembers.email, emailLower));
const isProMember = !!proMember || isInternalEmail;

if (!isProMember) {
  // Free-tier single audits temporarily paused
  return NextResponse.json(
    { error: "Free audits are temporarily paused. Sign up for a Pro account to run an audit." },
    { status: 402 }
  );
}
```

**The problem:** `isProMember` is true only if the submitted email already exists in `teamMembers`. But a brand-new customer's email only enters `teamMembers` **after** they sign up (auth/callback creates team + inserts teamMembers row). The intended funnel is:
1. Customer submits domain + email on landing page → gets results
2. Upgrades / signs up → team created → auto-linked to site → paid features

Step 1 is permanently blocked for all new customers. This is not the intended behavior of the "temporary pause" — it was meant to stop anonymous abuse, not block the onboarding funnel.

**Error Adithya saw:** "Free audits are temporarily paused. Sign up for a Pro account to run an audit." — paraphrased as "you are not a pro tier user, you cannot buy credits."

### Bug 2 — Stripe webhook silent drop (`api/webhooks/stripe/route.ts`)

Lines 31-34:
```typescript
if (!teamId || !userId) {
  console.error("[stripe-webhook] Missing teamId or userId in metadata for session:", session.id);
  return NextResponse.json({ ok: true }); // 200 so Stripe doesn't retry
}
```

**The problem:** When `teamId = ""` (empty string — set by checkout route when user has no team membership: `teamId ?? ""`), the condition `!teamId` is truthy for empty string. The webhook returns HTTP 200, so **Stripe considers the payment processed** and never retries. Credits are silently not added. There's no alert or monitoring hook.

In the current checkout route:
```typescript
teamId = membership?.teamId;
// ...
metadata: {
  teamId: teamId ?? "",  // ← "" if no membership
  userId: user.id,
},
```

---

## Dependencies

- `geo/app/api/sites/route.ts` — single-domain submission path (lines 178-188)
- `geo/app/api/checkout/route.ts` — Stripe session creation
- `geo/app/api/webhooks/stripe/route.ts` — payment completion handler

---

## Interfaces

### Fix 1 — Remove `!isProMember` gate from single-domain path

**Before (blocking):**
```typescript
const [proMember] = await db.select().from(teamMembers).where(eq(teamMembers.email, emailLower));
const isProMember = !!proMember || isInternalEmail;

if (!isProMember) {
  return NextResponse.json(
    { error: "Free audits are temporarily paused. Sign up for a Pro account to run an audit." },
    { status: 402 }
  );
}
```

**After (allows new customers through):**
```typescript
// Remove the isProMember gate entirely from the single-domain path.
// Bulk audit gate (above, line 74-80) still requires Pro.
// Single-domain audits are open: new customers get free-tier results,
// sign up to unlock paid features. Credits are the gate for re-runs.
```

The rest of the single-domain path (domain dedup check, OTP send, pipeline enqueue) stays unchanged. The free-tier crawl limit (`FREE_MAX_PAGES`) already caps page count for users with no credits.

### Fix 2 — Stripe webhook: fail loudly on missing teamId

**Before (silent drop):**
```typescript
if (!teamId || !userId) {
  console.error("[stripe-webhook] Missing teamId or userId in metadata for session:", session.id);
  return NextResponse.json({ ok: true }); // 200 so Stripe doesn't retry
}
```

**After (explicit error + Stripe retry):**
```typescript
if (!teamId || !userId) {
  console.error("[stripe-webhook] CRITICAL: Missing teamId or userId in metadata for session:", session.id, "metadata:", session.metadata);
  return NextResponse.json({ error: "Missing team or user context" }, { status: 500 }); // 500 → Stripe retries
}
```

This means a broken checkout session (e.g., user has no team) will be retried by Stripe (up to its retry policy), giving us time to identify and manually fix the issue rather than silently dropping the payment.

### Fix 3 — Checkout: guard against missing teamId before creating session

**Before:**
```typescript
teamId = membership?.teamId;
// ...
metadata: {
  teamId: teamId ?? "",
```

**After:**
```typescript
teamId = membership?.teamId;
if (!teamId) {
  console.error("[checkout] User has no team membership:", user.id);
  return NextResponse.json({ error: "Account not fully set up. Please sign out and sign back in." }, { status: 409 });
}
// ...
metadata: {
  teamId: teamId,  // guaranteed non-empty
```

This surfaces the issue to the user immediately (409 Conflict) rather than letting them pay and silently losing the credits.

---

## Acceptance Criteria

1. **AC-1** — A brand new email (not in `teamMembers`) can submit a single-domain audit via `POST /api/sites` and receives a 201 with the site ID and OTP sent message.
2. **AC-2** — The new customer's site has `teamId = null` and `pipelineStatus = pending` after submission (free-tier pipeline).
3. **AC-3** — After signing up (auth/callback), the orphan site is auto-linked to the new team (existing behavior, verified unchanged).
4. **AC-4** — Bulk audit gate (`POST /api/sites` with CSV) still requires `teamMembers` entry — unchanged.
5. **AC-5** — Stripe webhook returns HTTP 500 (not 200) when `teamId` or `userId` is missing in session metadata.
6. **AC-6** — Checkout returns HTTP 409 (not 200 with a Stripe session) when the authenticated user has no `teamMembers` entry.
7. **AC-7** — Existing happy-path flows (Pro user submits domain, verifies OTP, runs citation check, buys credits) are unchanged.

---

## Risks

- **Low risk for Fix 1:** removing the gate restores the original behavior before the free-tier pause was added. Crawl cost per new submission is bounded by `FREE_MAX_PAGES` (already enforced downstream). No DB schema changes.
- **Low risk for Fix 2:** changing 200 → 500 on missing-teamId means Stripe will retry up to 3 times (spread over hours). If the issue is structural (team creation failed), retries also fail — but the payment is not silently lost; it shows as failed in Stripe dashboard.
- **Low risk for Fix 3:** 409 response before Stripe session is created means no Stripe payment was initiated — no money movement at all. User sees an actionable error.

---

## Out of Scope

- Reintroducing a rate-limit or abuse-prevention mechanism for free single-domain audits — separate task if needed.
- Fixing the auth/callback orphan auto-link for existing users submitting new domains from the landing page (verify route already handles this for existing users; lower priority).

---

## Reproduction

1. Use a fresh email not in `teamMembers`.
2. `POST /api/sites` with `{ url: "https://example.com", email: "fresh@example.com" }`.
3. Expected (after fix): `201 { id: "...", message: "Verification code sent." }`.
4. Actual (before fix): `402 { error: "Free audits are temporarily paused. Sign up for a Pro account to run an audit." }`.
