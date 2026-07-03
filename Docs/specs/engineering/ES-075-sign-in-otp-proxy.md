# ES-075 — Sign-In OTP Proxy (V0-Website → GEO Backend)

**Source:** TS-075-sign-in-otp-proxy.md
**Author:** 2-specmaster
**Date:** 2026-04-03
**Priority:** P0 (sign-in broken for returning users on V0-Website)

---

## a) Overview

Returning users on V0-Website cannot sign in — the login page requires a URL field (creates an audit, not a sign-in) and GEO returns "Audit already complete" without sending OTP for completed audits. Supabase credentials would need to be exposed on V0-Website client bundle.

**Solution:** Two new GEO API routes that proxy Supabase OTP server-side, plus a V0-Website login page rewrite to use them. GEO backend remains the single auth gateway.

**What exists:**
- `geo/lib/supabase/admin.ts` — `getSupabaseAdmin()` returns a service-role Supabase client (singleton, lazy init). Uses `SUPABASE_SERVICE_ROLE_KEY`.
- `geo/lib/services/exchange-code.ts` — `generateExchangeCode({ accessToken, refreshToken, redirect, siteToken, siteId })` returns a 60s HS256 JWT.
- `geo/app/auth/exchange/route.ts` — GET handler decodes JWT, sets Supabase session via cookies, redirects. `site_token` and `site_id` are **optional** in the payload — if empty, the hash fragment is omitted. Already handles the sign-in-without-site case.
- `geo/lib/rate-limit.ts` — DB-backed `checkRateLimit(key, limit, windowMs)` with atomic upsert. Returns `{ allowed, remaining, resetAt }`.
- `geo/app/api/consent/route.ts` — GET checks if user has accepted current TOS+EULA versions; POST records consent.
- `geo/lib/db/schema.ts` — `consentRecords` table with `userId`, `tosVersion`, `eulaVersion`.
- `geo/lib/config.ts:110-111` — `CURRENT_TOS_VERSION`, `CURRENT_EULA_VERSION`.
- `V0-Website/app/api/geo/[...path]/route.ts` — Catch-all proxy forwards `/api/geo/*` to GEO backend. IP-based rate limit 60 req/min.
- `V0-Website/app/login/page.tsx` — Current login page with email + URL fields, two-step flow (collect → otp).

**What's needed:**
- `geo/app/api/auth/otp/send/route.ts` (CREATE) — email → Supabase OTP
- `geo/app/api/auth/otp/verify/route.ts` (CREATE) — code → verify → exchange code
- `V0-Website/app/login/page.tsx` (MODIFY) — email-only → OTP → exchange code redirect

---

## b) Implementation Requirements

### b1) File: `geo/app/api/auth/otp/send/route.ts` (CREATE)

**Exports:** `POST(req: NextRequest)`

**Imports:**
```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";
```

**Request body:** `{ email: string }`

**Behavior:**

1. Parse body, extract `email`
2. Validate email format: regex `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`. Return 400 `{ error: "Invalid email format" }` if invalid.
3. Normalize: `email.trim().toLowerCase()`
4. Rate limit: `checkRateLimit(`otp_send:${email}`, 5, 15 * 60 * 1000)`. Return 429 `{ error: "Too many attempts. Try again later.", resetAt }` if blocked.
5. Get admin client: `getSupabaseAdmin()`. Return 500 `{ error: "Auth service unavailable" }` if null.
6. Call `supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })`.
   - On error: return 500 `{ error: "Failed to send verification code" }` (do NOT leak Supabase error details).
7. Return 200 `{ success: true }`

**Response types:**
- `200 { success: true }`
- `400 { error: string }`
- `429 { error: string, resetAt: number }`
- `500 { error: string }`

**Security notes:**
- Do NOT expose Supabase error messages to client (may leak user existence info)
- `signInWithOtp` with `shouldCreateUser: true` creates account on first use — this is intentional for new user onboarding
- Service role key never leaves GEO backend

### b2) File: `geo/app/api/auth/otp/verify/route.ts` (CREATE)

**Exports:** `POST(req: NextRequest)`

**Imports:**
```typescript
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { generateExchangeCode } from "@/lib/services/exchange-code";
import { db } from "@/lib/db";
import { consentRecords } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { CURRENT_TOS_VERSION, CURRENT_EULA_VERSION } from "@/lib/config";
import { checkRateLimit } from "@/lib/rate-limit";
```

**Request body:** `{ email: string, code: string }`

**Behavior:**

1. Parse body, extract `email` and `code`
2. Validate email format (same regex as b1). Return 400 if invalid.
3. Validate code: must be a string of 6 digits (`/^\d{6}$/`). Return 400 `{ error: "Invalid code format" }` if not.
4. Normalize: `email.trim().toLowerCase()`
5. Rate limit: `checkRateLimit(`otp_verify:${email}`, 10, 15 * 60 * 1000)`. Return 429 if blocked. (10 attempts per 15min — more generous than send because users may mis-type.)
6. Create a Supabase client using the anon key (NOT admin client — `verifyOtp` needs user-scoped client):
   ```typescript
   const supabase = createClient(
     process.env.NEXT_PUBLIC_SUPABASE_URL!,
     process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
     { auth: { autoRefreshToken: false, persistSession: false } }
   );
   ```
7. Call `supabase.auth.verifyOtp({ email, token: code, type: "email" })`.
   - On error or no session: return 401 `{ error: "Invalid or expired code" }`
8. Extract `session.access_token` and `session.refresh_token` from the response.
9. Check consent: query `consentRecords` where `userId = session.user.id` AND `tosVersion = CURRENT_TOS_VERSION` AND `eulaVersion = CURRENT_EULA_VERSION`. If row exists → `requiresConsent = false`, else `requiresConsent = true`.
10. Generate exchange code:
    ```typescript
    const exchangeCode = await generateExchangeCode({
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      redirect: "/dashboard",
      siteToken: "",
      siteId: "",
    });
    ```
11. Return 200 `{ success: true, exchangeCode, requiresConsent }`

**Response types:**
- `200 { success: true, exchangeCode: string, requiresConsent: boolean }`
- `400 { error: string }`
- `401 { error: string }`
- `429 { error: string, resetAt: number }`
- `500 { error: string }`

**Security notes:**
- `verifyOtp` uses anon key (not service role) because it's verifying a user-initiated OTP — this is the standard Supabase pattern
- Exchange code JWT expires in 60s — one-time use window
- Empty `siteToken`/`siteId` → `/auth/exchange` skips hash fragment, redirects to `/dashboard`
- Do NOT return Supabase session tokens directly to the client — only the exchange code

### b3) File: `archive/V0-Website/app/login/page.tsx` (MODIFY)

**Current state:** Two-step flow — "collect" step (email + URL) → "otp" step. Calls `POST /api/geo/sites` to create audit + send OTP. Calls `POST /api/geo/sites/${siteId}/verify` to verify OTP.

**New state:** Two-step flow — "email" step (email only) → "otp" step. Calls `POST /api/geo/auth/otp/send` to send OTP. Calls `POST /api/geo/auth/otp/verify` to verify OTP + get exchange code.

**Changes:**

#### State variables — remove/modify:
- Remove: `url` state (no URL field)
- Remove: `siteId` state (not needed — sign-in flow doesn't create a site)
- Keep: `email`, `otp`, `step`, `loading`, `error`, `tosAccepted`
- Add: `requiresConsent` (boolean, from verify response)

#### Step 1 — Email form:
- Single email input field. No URL field.
- Label: "Sign in to FlowBlinq"
- Placeholder: "you@company.com"
- Submit handler:
  ```typescript
  const res = await fetch("/api/geo/auth/otp/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim().toLowerCase() }),
  });
  const data = await res.json();
  if (!res.ok) { setError(data.error); return; }
  setStep("otp");
  ```
- "Resend code" link on OTP step calls the same endpoint

#### Step 2 — OTP form:
- 6-digit code input (same style as current)
- TOS/EULA checkbox — show only when `requiresConsent` is unknown (first verify attempt) or `true`
- Submit handler:
  ```typescript
  const res = await fetch("/api/geo/auth/otp/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim().toLowerCase(), code: otp }),
  });
  const data = await res.json();
  if (!res.ok) { setError(data.error); return; }
  // If consent needed and not yet accepted, show consent UI
  if (data.requiresConsent && !tosAccepted) {
    setRequiresConsent(true);
    return; // user must check TOS box and re-submit
  }
  // Record consent if needed
  if (data.requiresConsent && tosAccepted) {
    await fetch("/api/geo/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tosAccepted: true }),
    });
  }
  // Redirect via exchange code
  window.location.href = `${GEO_APP_URL}/auth/exchange?code=${encodeURIComponent(data.exchangeCode)}`;
  ```

#### Step 3 — Redirect:
- Same as current: `window.location.href` to GEO exchange endpoint
- No `siteId` in URL — exchange route redirects to `/dashboard`

#### Styling:
- Keep existing V0-Website copper design theme
- Remove URL input field and its label
- Keep email input, OTP input, TOS checkbox, submit buttons
- Keep error/loading states

**Important — consent POST authorization:**
The `POST /api/geo/consent` call requires an authenticated user. Since the user isn't yet authenticated on V0-Website at this point (they haven't exchanged the code yet), consent recording must happen **after** exchange or on the GEO side. Two options:

**Option A (recommended):** Move consent recording into `/api/auth/otp/verify`. Add optional `tosAccepted: boolean` to the verify request body. If `tosAccepted: true` and user has no consent record, create one before returning the exchange code. This keeps everything in a single round-trip and avoids auth chicken-and-egg.

**Option B:** Record consent on GEO `/auth/exchange` route after session is established. More complex, not recommended.

**Use Option A.** Update `b2` verify endpoint to accept optional `tosAccepted` field:
- If `tosAccepted === true` in request body AND user has no consent record → insert consent record (using `session.user.id`, `session.user.email`, IP from request headers, user agent from request headers)
- Set `requiresConsent = false` in response after recording

---

## c) Unit Test Plan

**File:** `geo/__tests__/auth-otp.test.ts` (CREATE)
**Framework:** Vitest
**Minimum coverage:** 90% of new code

### OTP Send Tests

| # | Test Case | Input | Expected |
|---|-----------|-------|----------|
| U1 | Valid email → success | `{ email: "a@b.com" }` | 200, `{ success: true }`, signInWithOtp called |
| U2 | Missing email → 400 | `{}` | 400, `{ error: "Invalid email format" }` |
| U3 | Invalid email format → 400 | `{ email: "notanemail" }` | 400, `{ error: "Invalid email format" }` |
| U4 | Rate limited → 429 | 6th call in 15min | 429, `{ error: "Too many attempts..." }` |
| U5 | Supabase admin unavailable → 500 | getSupabaseAdmin returns null | 500, `{ error: "Auth service unavailable" }` |
| U6 | Supabase signInWithOtp fails → 500 | signInWithOtp returns error | 500, `{ error: "Failed to send verification code" }` |
| U7 | Email normalized to lowercase | `{ email: "A@B.COM" }` | signInWithOtp called with "a@b.com" |
| U8 | Email trimmed | `{ email: "  a@b.com  " }` | signInWithOtp called with "a@b.com" |

### OTP Verify Tests

| # | Test Case | Input | Expected |
|---|-----------|-------|----------|
| U9 | Valid code → success, no consent needed | `{ email: "a@b.com", code: "123456" }` | 200, `{ success: true, exchangeCode: "jwt...", requiresConsent: false }` |
| U10 | Valid code → consent needed | User has no consent record | 200, `{ requiresConsent: true }` |
| U11 | Valid code + tosAccepted → consent recorded | `{ tosAccepted: true }`, no prior consent | 200, `{ requiresConsent: false }`, consent row inserted |
| U12 | Invalid code → 401 | verifyOtp returns error | 401, `{ error: "Invalid or expired code" }` |
| U13 | Missing code → 400 | `{ email: "a@b.com" }` | 400, `{ error: "Invalid code format" }` |
| U14 | Non-6-digit code → 400 | `{ email: "a@b.com", code: "12345" }` | 400, `{ error: "Invalid code format" }` |
| U15 | Non-numeric code → 400 | `{ email: "a@b.com", code: "abcdef" }` | 400, `{ error: "Invalid code format" }` |
| U16 | Missing email → 400 | `{ code: "123456" }` | 400 |
| U17 | Rate limited → 429 | 11th call in 15min | 429 |
| U18 | Exchange code contains correct redirect | Verify success | JWT payload has `redirect: "/dashboard"` |
| U19 | Exchange code has empty siteToken/siteId | Verify success | JWT payload has `site_token: ""`, `site_id: ""` |
| U20 | Supabase verifyOtp returns no session → 401 | verifyOtp returns data but no session | 401 |
| U21 | Consent recorded with correct IP/UA | `tosAccepted: true` | consent row has correct IP and user agent |

### Login Page Tests (V0-Website)

| # | Test Case | Input | Expected |
|---|-----------|-------|----------|
| U22 | Email form rendered (no URL field) | Initial render | Email input visible, no URL input |
| U23 | Submit email → OTP step | Enter email, submit | fetch called to /api/geo/auth/otp/send, step changes to "otp" |
| U24 | OTP step shows code input | step = "otp" | 6-digit input visible |
| U25 | Submit OTP → redirect | Valid OTP response | window.location.href set to exchange URL |
| U26 | Error state on invalid code | API returns 401 | Error message displayed |
| U27 | Rate limit error displayed | API returns 429 | "Too many attempts" shown |
| U28 | Resend code calls send endpoint | Click "Resend" | fetch called to /api/geo/auth/otp/send again |
| U29 | TOS checkbox shown when consent needed | requiresConsent = true | Checkbox visible |
| U30 | Loading state during submit | During fetch | Button disabled, spinner shown |

**Mocks:**
- `getSupabaseAdmin()` → mock Supabase client with `auth.signInWithOtp` stub
- `createClient()` → mock Supabase client with `auth.verifyOtp` stub
- `generateExchangeCode()` → returns "mock-jwt-token"
- `checkRateLimit()` → returns `{ allowed: true, remaining: 4, resetAt: ... }`
- `db` → mock for consent record queries/inserts
- `fetch` (V0-Website tests) → vi.fn()
- `window.location.href` → vi.fn() setter

---

## d) Integration Test Plan

**File:** `geo/__tests__/integration/auth-otp.integration.test.ts` (CREATE)
**Framework:** Vitest

| # | Test Case | Scenario |
|---|-----------|----------|
| IT1 | Full OTP flow: send → verify → exchange code valid | Send OTP, verify with valid code, confirm exchange code is a decodable JWT with correct payload |
| IT2 | Rate limit enforced on send | Call send 6 times with same email, confirm 6th returns 429 |
| IT3 | Rate limit enforced on verify | Call verify 11 times with same email, confirm 11th returns 429 |
| IT4 | Invalid code rejected | Send OTP, verify with wrong code, confirm 401 |
| IT5 | Consent check returns correct value | Create user with/without consent record, verify `requiresConsent` flag |
| IT6 | tosAccepted records consent | Verify with `tosAccepted: true`, confirm consent row created in DB |
| IT7 | Exchange code accepted by /auth/exchange | Generate exchange code from verify, call /auth/exchange with it, confirm redirect |
| IT8 | Email normalization consistent across send/verify | Send with "A@B.COM", verify with "a@b.com", confirm they match |

**Mocks:**
- Supabase `signInWithOtp` and `verifyOtp` → mocked at the Supabase client level (no real Supabase calls)
- Database → real test DB or in-memory

---

## e) Profiling Requirements

| Metric | Target | Tool |
|--------|--------|------|
| OTP send latency (excl. Supabase) | < 50ms | Performance.mark/measure |
| OTP verify + exchange code gen | < 100ms (excl. Supabase + DB) | Performance.mark/measure |
| Consent DB query | < 20ms | Drizzle query logging |

The Supabase OTP calls are the bottleneck (network round-trip to Supabase). Our code overhead must stay minimal.

---

## f) Load Test Plan

| Scenario | Target | Success Criteria |
|----------|--------|-----------------|
| 50 concurrent OTP sends (different emails) | All succeed within 5s | p99 < 5s, 0 errors |
| Rate limit saturation (single email) | 5 succeed, 6th blocked | 429 returned, no leak |
| 50 concurrent OTP verifies | All respond within 5s | p99 < 5s, 0 errors |

Tool: k6 or artillery. Supabase mocked for load tests (test our code, not Supabase).

---

## g) Logging & Instrumentation

| Event | Level | Fields |
|-------|-------|--------|
| `auth.otp.send.request` | info | email (hashed), ip |
| `auth.otp.send.rate_limited` | warn | email (hashed), ip, resetAt |
| `auth.otp.send.success` | info | email (hashed) |
| `auth.otp.send.error` | error | email (hashed), error type (NOT Supabase detail) |
| `auth.otp.verify.request` | info | email (hashed), ip |
| `auth.otp.verify.rate_limited` | warn | email (hashed), ip, resetAt |
| `auth.otp.verify.success` | info | email (hashed), requiresConsent, consentRecorded |
| `auth.otp.verify.failed` | warn | email (hashed), ip (potential brute force) |
| `auth.otp.verify.error` | error | email (hashed), error type |

**Email hashing:** Log first 3 chars + `***` + domain for debugging without exposing PII. E.g. `adi***@flowblinq.com`.

---

## h) Acceptance Criteria

### OTP Send

| # | Criterion | Section |
|---|-----------|---------|
| AC1 | POST /api/auth/otp/send accepts `{ email }` and returns `{ success: true }` | b1 |
| AC2 | Supabase sends OTP email to the provided address | b1.6 |
| AC3 | Rate limited: 5 per email per 15 minutes | b1.4 |
| AC4 | Returns 400 for invalid email format | b1.2 |
| AC5 | Returns 429 with `resetAt` when rate limited | b1.4 |
| AC6 | Returns 500 if Supabase admin unavailable | b1.5 |
| AC7 | Supabase error details NOT leaked to client | b1.6 |
| AC8 | Email normalized (trimmed, lowercased) before all operations | b1.3 |

### OTP Verify

| # | Criterion | Section |
|---|-----------|---------|
| AC9 | POST /api/auth/otp/verify accepts `{ email, code }` and returns `{ success, exchangeCode, requiresConsent }` | b2 |
| AC10 | Invalid/expired code returns 401 `{ error: "Invalid or expired code" }` | b2.7 |
| AC11 | Code must be exactly 6 digits | b2.3 |
| AC12 | Exchange code is a valid 60s HS256 JWT decodable by /auth/exchange | b2.10 |
| AC13 | `requiresConsent` correctly reflects consent_records state against CURRENT_TOS_VERSION and CURRENT_EULA_VERSION | b2.9 |
| AC14 | Rate limited: 10 per email per 15 minutes | b2.5 |
| AC15 | Exchange code has `siteToken: ""` and `siteId: ""` (sign-in without site context) | b2.10 |
| AC16 | Exchange code has `redirect: "/dashboard"` | b2.10 |
| AC17 | Optional `tosAccepted: true` in request body records consent before returning exchange code | b3 Option A |
| AC18 | Consent record includes userId, email, IP address, user agent | b3 Option A |
| AC19 | Supabase session tokens NOT returned directly to client — only exchange code | b2 |

### Login Page

| # | Criterion | Section |
|---|-----------|---------|
| AC20 | Login page shows email-only form (no URL field) | b3 |
| AC21 | Submitting email calls `POST /api/geo/auth/otp/send` | b3 Step 1 |
| AC22 | OTP form appears after successful email submission | b3 Step 2 |
| AC23 | Valid OTP redirects to GEO dashboard via exchange code | b3 Step 3 |
| AC24 | TOS consent checkbox present on OTP step | b3 Step 2 |
| AC25 | Error states displayed for invalid code, rate limit, network errors | b3 |
| AC26 | Matches V0-Website copper design theme | b3 |
| AC27 | "Resend code" link available on OTP step | b3 Step 1 |

### End-to-End

| # | Criterion | Section |
|---|-----------|---------|
| AC28 | New user: email → OTP → consent → dashboard (account created) | TS-075 §5 |
| AC29 | Returning user: email → OTP → dashboard (consent already recorded) | TS-075 §5 |
| AC30 | Works via V0-Website proxy (`/api/geo/auth/otp/send` and `/api/geo/auth/otp/verify`) | b3 |
| AC31 | 30 unit tests pass | c |
| AC32 | 8 integration tests pass | d |

---

## ScriptDev Notes

1. **Two repos.** GEO routes are in `/home/aditya/flowblinq/geo/`. Login page is in `/home/aditya/flowblinq/archive/V0-Website/`. Both on branch `feat/tos-eula-consent`.
2. **Admin client for send, anon client for verify.** `signInWithOtp` needs admin/service-role client to avoid exposing anon key on V0-Website. `verifyOtp` needs anon-scoped client because it establishes a user session. Do NOT mix these.
3. **Consent chicken-and-egg.** Use Option A from §b3: add optional `tosAccepted` to the verify request body. Record consent server-side before returning the exchange code. This avoids a separate authenticated call from V0-Website (which doesn't have a session yet).
4. **Rate limit keys.** Use `otp_send:${email}` and `otp_verify:${email}` to namespace in the `rate_limits` table. The DB-backed `checkRateLimit` in `geo/lib/rate-limit.ts` handles atomic upserts.
5. **Empty siteToken/siteId.** Already handled by `/auth/exchange` — it checks `if (site_token && site_id)` before adding hash fragment. Empty strings are falsy. No changes needed to exchange-code.ts or exchange route.
6. **V0-Website proxy.** The existing `[...path]` proxy at `/api/geo/` will forward `/api/geo/auth/otp/send` → `/api/auth/otp/send` on GEO. No proxy changes needed.
7. **DaVinci Agent 10 not needed.** This is auth plumbing + form simplification, not design work.

---

*ES-075 — SpecMaster, 2026-04-03*
