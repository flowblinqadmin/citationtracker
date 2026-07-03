# ES-025 — Auth Session Fix: Free OTP Users Get Supabase Session on Verify

**Date:** 2026-03-05
**Priority:** P0 — blocker for upgrade flow (free users hit 401 on checkout)
**Status:** Implemented
**Branch:** main (merged via PR #130 sprint-11)
**Depends on:** Supabase admin client (`lib/supabase/admin.ts`), `lib/services/provision-team.ts`

---

## a) Problem

Free audit users verified their email via a 6-digit OTP (`POST /api/sites/[id]/verify`). After verification, they were redirected to `/sites/[id]` with a site-level `accessToken` stored in `sessionStorage`. This `accessToken` is sufficient to poll the pipeline and view results.

However, clicking "Upgrade Now" on the results page triggered `POST /api/checkout`, which requires a valid Supabase session. Free OTP users had no Supabase session — they had never gone through Supabase's own auth flow. The request returned 401, and the client redirected them to the login page instead of Stripe.

**Root cause:** The OTP verify flow authenticated users against the platform's own DB (`geoSites.verificationCode` hash check) but never established a Supabase session. The upgrade path assumed a Supabase session was always present.

---

## b) Solution

Create a Supabase auth user and establish a session during OTP verification, without adding a separate login step.

**Mechanism:** Supabase's admin API generates a session token server-side via `generateLink({ type: "magiclink" })`. The `"magiclink"` is a Supabase API parameter — no magic link email is sent. The `hashed_token` from that response is returned to the client as `authOtp`. The client calls `supabase.auth.verifyOtp({ token_hash: authOtp, type: "magiclink" })`, which sets Supabase session cookies. The token is consumed immediately in the same verify flow.

**Result:** After OTP verify, the user has both:
- A site-level `accessToken` (stored in `sessionStorage`, used for polling)
- A Supabase session (cookies, used for authenticated API calls like checkout)

---

## c) Files Changed

| File | Change |
|------|--------|
| `app/api/sites/[id]/verify/route.ts` | Creates Supabase user, provisions team with `skipBonus: true`, generates `authOtp` via `generateLink` |
| `app/verify/[id]/page.tsx` | Calls `supabase.auth.verifyOtp({ token_hash: authOtp, type: "magiclink" })` after successful API response |
| `app/auth/callback/route.ts` | Refactored to use shared `ensureTeamForUser(userId, email)` (no `skipBonus` — OAuth users get bonus) |
| `lib/services/provision-team.ts` | New shared service — idempotent team provisioning for both OTP and OAuth paths |
| `lib/supabase/admin.ts` | New singleton admin client using `SUPABASE_SERVICE_ROLE_KEY` |

---

## d) Implementation Detail

### `app/api/sites/[id]/verify/route.ts`

After OTP validation passes, the following auth block runs:

```typescript
const admin = getSupabaseAdmin();
if (admin) {
  // 1. Create Supabase user (or find existing one)
  const { data: createData, error: createErr } = await admin.auth.admin.createUser({
    email: site.ownerEmail,
    email_confirm: true,
  });
  if (createErr?.message?.includes("already been registered")) {
    // Look up userId from teamMembers by email
    const [member] = await db.select()...
    supaUserId = member?.userId;
  } else {
    supaUserId = createData.user.id;
  }

  // 2. Provision team (0 credits for free users)
  if (supaUserId) {
    const { teamId } = await ensureTeamForUser(supaUserId, email, { skipBonus: true });
    // Link site to team if not already linked
  }

  // 3. Generate session token (Supabase API uses "magiclink" type — no email sent)
  const { data: linkData } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: site.ownerEmail,
  });
  authOtp = linkData.properties.hashed_token;
}
```

The entire block is wrapped in try/catch. Failures are logged as `console.error` and treated as non-fatal — the verify response still returns `success: true` and the user can view results via `accessToken`.

The API response shape when `authOtp` is available:

```json
{
  "success": true,
  "siteId": "abc123",
  "accessToken": "nanoid32chars",
  "authOtp": "supabase_hashed_token",
  "email": "user@example.com"
}
```

### `app/verify/[id]/page.tsx`

After the API call succeeds:

```typescript
if (data.authOtp) {
  try {
    const supabase = createClient();
    await supabase.auth.verifyOtp({
      token_hash: data.authOtp,
      type: "magiclink",
    });
  } catch {
    // Non-fatal — user can still view results via accessToken
  }
}
router.push(`/sites/${data.siteId}?token=${data.accessToken}`);
```

The `verifyOtp` call sets `sb-*` cookies in the browser. Subsequent requests to authenticated routes (checkout, dashboard) carry these cookies and receive 200 instead of 401.

### `lib/services/provision-team.ts`

Handles three cases idempotently:

```
1. User already has teamMembers row → return existing teamId (no-op)
2. Email matches pending invite (userId is null) → accept invite
3. First login → create team + owner membership
   - skipBonus: false (OAuth) → creditBalance = SIGNUP_BONUS_CREDITS (20)
   - skipBonus: true (OTP verify) → creditBalance = 0
   - Auto-link orphan geoSites rows with matching ownerEmail
```

### `app/auth/callback/route.ts`

Before this fix, `auth/callback` had inline team-creation logic. It now delegates to `ensureTeamForUser`:

```typescript
const user = data.session.user;
await ensureTeamForUser(user.id, user.email);  // skipBonus defaults to false
```

This eliminates code duplication and ensures the OAuth path gets the signup bonus while the OTP path does not.

### `lib/supabase/admin.ts`

Singleton pattern with null-safe return:

```typescript
export function getSupabaseAdmin(): SupabaseClient | null {
  if (_admin) return _admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _admin;
}
```

`autoRefreshToken: false` and `persistSession: false` are intentional — the admin client is server-side only and must not attempt browser cookie operations.

---

## e) Business Rules

| Rule | Implementation |
|------|---------------|
| Free OTP users start with 0 credits | `skipBonus: true` in `ensureTeamForUser` → `creditBalance: 0` |
| Free OTP users get `FREE_MAX_PAGES` (20) pages per audit | `maxPages = FREE_MAX_PAGES` passed to `enqueueStage` when `creditBalance === 0` |
| OAuth users get `SIGNUP_BONUS_CREDITS` (20) on first team creation | `skipBonus: false` (default) in OAuth callback |
| Upgrade: 100 credits for $10 | Stripe checkout → webhook → `creditBalance += CREDITS_PER_PACK` |
| Credits × `PAGES_PER_CREDIT` (5) = max pages for paid audits | `Math.min(creditBalance * 5, ABSOLUTE_MAX_PAGES)` in verify route |
| Free user can view results without Supabase session | `accessToken` in `sessionStorage` is sufficient for polling and result display |
| Free user needs Supabase session to upgrade | `authOtp` → `verifyOtp` establishes the session during OTP verify |

---

## f) E2E Test Coverage

**Test file:** `e2e/auth-flow.spec.ts` (Playwright)

| Test | What it covers |
|------|---------------|
| OTP verify establishes Supabase session | POST verify with correct code; assert `sb-*` cookies are set |
| Upgrade redirect goes to Stripe (not login) | After OTP verify, click "Upgrade Now"; assert redirect is Stripe, not `/auth/login` |
| Session survives page refresh | Reload `/sites/[id]`; assert user still authenticated (no 401) |
| Data isolation between users | Two different emails; assert each only sees their own sites |
| Wrong OTP is rejected | 5 wrong codes; assert lockout response |

**Helper:** `e2e/helpers/db.ts` — creates test `geoSites` rows with known OTP hash (`SHA-256("999888")`) to bypass Resend for E2E tests.

---

## g) Environment Variable Requirements

| Variable | Where set | Purpose |
|----------|-----------|---------|
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel dashboard (prod) + `.env.local` (dev) | Admin client for `createUser` and `generateLink` |
| `NEXT_PUBLIC_SUPABASE_URL` | Already set | Required alongside service role key for admin client init |

**Action required for new deployments:** Add `SUPABASE_SERVICE_ROLE_KEY` to Vercel project settings. Without it, free OTP users will not receive a Supabase session. The platform degrades gracefully (users can still view results), but "Upgrade Now" will redirect to login instead of Stripe.

To find the key: Supabase dashboard → Project Settings → API → `service_role` (secret).

---

## h) Security Considerations

- `SUPABASE_SERVICE_ROLE_KEY` is server-only. Never prefixed `NEXT_PUBLIC_`. Never included in client bundles.
- `generateLink` returns a `hashed_token`, not the raw token URL. The client uses the hash for `verifyOtp` — the raw token is never transmitted.
- Session tokens are single-use. A second `verifyOtp` call with the same `hashed_token` fails.
- The auth block is non-fatal. If admin key is missing or Supabase is down, OTP verify still succeeds — users just lack a Supabase session until they re-authenticate via the login page.
- `skipBonus: true` ensures free OTP users cannot acquire credits through the OTP path. Credits are only granted via OAuth first login or Stripe purchase.

See `SECURITY_HARDENING_SPEC.md` → "Supabase Admin Client Security" for full threat model.

---

## i) Acceptance Criteria

| # | Criterion |
|---|-----------|
| AC-1 | OTP verify response includes `authOtp` (hashed_token) and `email` when admin client is available |
| AC-2 | `verifyOtp` call on client sets `sb-*` session cookies |
| AC-3 | After OTP verify, POST `/api/checkout` returns 200 (not 401) |
| AC-4 | Free OTP user team has `creditBalance = 0` |
| AC-5 | OAuth user team has `creditBalance = SIGNUP_BONUS_CREDITS` (20) |
| AC-6 | Existing user (already has teamMembers row) — OTP verify does not create duplicate team |
| AC-7 | `SUPABASE_SERVICE_ROLE_KEY` absent → verify still returns 200; no Supabase session set; no 500 |
| AC-8 | TypeScript compiles without errors (`npx tsc --noEmit`) |
| AC-9 | Docker Vitest test suite passes (`docker run --rm geo-test`) |
