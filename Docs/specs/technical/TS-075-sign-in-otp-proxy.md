# TS-075 — Sign-In OTP Proxy (V0-Website → GEO Backend)

**Author:** CoFounder (Agent 1)
**Date:** 2026-04-03
**Priority:** P0 (sign-in broken for returning users)
**Scope:** GEO app (2 new API routes) + V0-Website (login page rewrite)

---

## 1. What

Add two GEO API endpoints that proxy Supabase OTP auth server-side, and rewrite the V0-Website login page to use them. This gives V0-Website a clean email → OTP → dashboard sign-in flow without exposing Supabase credentials on the V0-Website client.

## 2. Why

Current V0-Website login page is broken for returning users:
- Requires a URL field (creates an audit, not a sign-in)
- For completed audits, GEO returns `"Audit already complete"` without sending OTP
- Supabase credentials would need to be exposed on V0-Website client bundle

Defense-in-depth: GEO backend becomes the single auth gateway. Supabase project URL and anon key stay on GEO only.

## 3. Components

### 3A. GEO Endpoint: POST /api/auth/otp/send

**File:** `geo/app/api/auth/otp/send/route.ts` (CREATE)

**Request:**
```json
{ "email": "user@example.com" }
```

**Behavior:**
1. Validate email format
2. Rate limit: 5 requests per email per 15 minutes (use existing rate-limit util)
3. Create Supabase admin client (server-side, uses SUPABASE_SERVICE_ROLE_KEY)
4. Call `supabase.auth.admin.generateLink({ type: "magiclink", email })` to trigger OTP
   - OR use standard client `supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })`
   - Server-side client avoids exposing anon key
5. Return `{ success: true }` on success
6. Return `{ error: "..." }` on failure

**Response:** `{ success: true }` or `{ error: string }`

**Note:** Use `createClient` from `@supabase/supabase-js` with service role key for server-side auth operations. Do NOT use the browser client pattern.

### 3B. GEO Endpoint: POST /api/auth/otp/verify

**File:** `geo/app/api/auth/otp/verify/route.ts` (CREATE)

**Request:**
```json
{ "email": "user@example.com", "code": "123456" }
```

**Behavior:**
1. Validate email + code format
2. Create Supabase client
3. Call `supabase.auth.verifyOtp({ email, token: code, type: "email" })`
4. If verification fails → return `{ error: "Invalid or expired code" }`
5. If verification succeeds → extract session tokens (access_token, refresh_token)
6. Check consent: query `consent_records` for this user
7. Generate exchange code JWT via existing `generateExchangeCode()`:
   ```ts
   const exchangeCode = await generateExchangeCode({
     accessToken: session.access_token,
     refreshToken: session.refresh_token,
     redirect: "/dashboard",
     siteToken: "",      // no specific site context for sign-in
     siteId: "",         // no specific site context for sign-in
   });
   ```
8. Return `{ success: true, exchangeCode, requiresConsent: !hasConsent }`

**Response:** `{ success: true, exchangeCode: string, requiresConsent: boolean }` or `{ error: string }`

### 3C. V0-Website Login Page Rewrite

**File:** `archive/V0-Website/app/login/page.tsx` (MODIFY)

**Current:** Email + URL → POST /api/geo/sites → OTP → verify → exchange code redirect
**New:** Email only → POST /api/geo/auth/otp/send → OTP → POST /api/geo/auth/otp/verify → exchange code redirect

**Step 1 — Email form:**
- Single email input field (no URL field)
- Submit calls `POST /api/geo/auth/otp/send` with `{ email }`
- On success → show OTP form
- On error → show error message

**Step 2 — OTP form:**
- 6-digit code input
- TOS/EULA checkbox (from Rao's consent gate)
- Submit calls `POST /api/geo/auth/otp/verify` with `{ email, code }`
- On success with `requiresConsent: false` → redirect to GEO dashboard via exchange code
- On success with `requiresConsent: true` → show consent UI, then redirect

**Step 3 — Redirect:**
```ts
window.location.href = `${GEO_APP_URL}/auth/exchange?code=${encodeURIComponent(exchangeCode)}`;
```

**Styling:** Match current V0-Website design (copper theme, FlowBlinq branding).

### 3D. Existing Infrastructure Reused

| Component | Location | Purpose |
|-----------|----------|---------|
| `generateExchangeCode()` | `geo/lib/services/exchange-code.ts` | Builds 60s JWT with session tokens |
| `/auth/exchange` route | `geo/app/auth/exchange/route.ts` | Decodes JWT, sets Supabase session, redirects |
| `/api/geo/[...path]` proxy | `V0-Website/app/api/geo/[...path]/route.ts` | Proxies V0-Website requests to GEO backend |
| `/api/consent` GET | `geo/app/api/consent/route.ts` | Checks if user has accepted TOS |

## 4. Dependencies

- Supabase server-side client (already available in GEO)
- `generateExchangeCode()` (already exists)
- `/auth/exchange` route (already exists)
- GEO proxy on V0-Website (already exists)

## 5. Acceptance Criteria

### 3A — OTP Send
- [ ] POST /api/auth/otp/send accepts `{ email }` and returns `{ success: true }`
- [ ] Supabase sends OTP email to the provided address
- [ ] Rate limited: 5 per email per 15 minutes
- [ ] Returns 400 for invalid email format
- [ ] Returns 429 when rate limited

### 3B — OTP Verify
- [ ] POST /api/auth/otp/verify accepts `{ email, code }` and returns `{ success, exchangeCode, requiresConsent }`
- [ ] Invalid/expired code returns `{ error: "..." }`
- [ ] Exchange code is a valid JWT decodable by `/auth/exchange`
- [ ] `requiresConsent` correctly reflects consent_records state
- [ ] Exchange code expires in 60 seconds

### 3C — Login Page
- [ ] Login page shows email-only form (no URL field)
- [ ] Submitting email triggers OTP to user's inbox
- [ ] OTP form appears after email submission
- [ ] Valid OTP redirects to GEO dashboard via exchange code
- [ ] TOS consent checkbox present on OTP step
- [ ] Error states displayed for invalid code, rate limit, network errors
- [ ] Matches V0-Website copper design theme

### End-to-end
- [ ] New user: email → OTP → consent → dashboard (account created)
- [ ] Returning user: email → OTP → dashboard (consent already recorded)
- [ ] Works via V0-Website proxy (`/api/geo/auth/otp/send` and `/api/geo/auth/otp/verify`)

## 6. Risks

| Risk | Mitigation |
|------|-----------|
| Supabase `signInWithOtp` requires anon key even server-side | Use admin client with service role key, or create a server-side Supabase client with anon key (never exposed to V0-Website client) |
| Exchange code generated without siteToken/siteId | `/auth/exchange` must handle empty site fields — redirect to /dashboard instead of /sites/[id] |
| Rate limiting bypass via proxy | GEO proxy already has IP-based rate limiting at 60 req/min |

## 7. Files Affected

| File | Action |
|------|--------|
| `geo/app/api/auth/otp/send/route.ts` | **CREATE** |
| `geo/app/api/auth/otp/verify/route.ts` | **CREATE** |
| `V0-Website/app/login/page.tsx` | **MODIFY** — rewrite to email-only flow |

---

*TS-075 — CoFounder, 2026-04-03*
