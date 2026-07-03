# TS-070 — Free Tier: Status Bar + Session Cookie Fixes

**Author:** CoFounder (Agent 1)
**Date:** 2026-03-30
**Priority:** P0 — live user-facing bug (jose@kappo.in unable to use dashboard)
**Scope:** `app/sites/[id]/SitePageClient.tsx`, `app/verify/[id]/page.tsx`, `app/sites/[id]/page.tsx`

---

## What

Two bugs in the free-tier OTP→audit→dashboard flow cause a broken experience for new users:

1. **Status bar not rendering** — After OTP verify, the exchange route redirects to `/sites/:id#st=TOKEN&sid=ID`. The token is in the hash fragment (invisible to server). Server renders `safeSite=null`, client has no site data, polling never starts → status bar never appears, page looks broken during audit.

2. **Session cookies not established** — `router.replace()` to `/auth/exchange?code=...` performs a client-side navigation to a Route Handler. The exchange route sets cookies via `cookies().set()`, but client-side fetch responses don't apply `Set-Cookie` headers to the browser cookie jar. Result: no Supabase session → `/dashboard` redirects to login.

---

## Why

Every free-tier user who verifies via OTP hits both bugs. They see a blank/broken page during audit (no progress bar), and cannot access `/dashboard` afterward. The completion email link works (uses `?token=` query param) but direct dashboard access fails. This is the primary conversion path for new users.

---

## Root Cause Analysis

### Bug 1: Status bar dead-end

**File:** `app/sites/[id]/page.tsx` line 90

```typescript
const safeSite = token && site.accessToken === token ? { ... } : null;
```

When arriving via exchange redirect (`/sites/:id#st=TOKEN&sid=ID`):
- `searchParams.token` = `undefined` (hash is client-only)
- `safeSite` = `null`
- SitePageClient renders with `site=null`

**File:** `app/sites/[id]/SitePageClient.tsx` lines 172-222

Client-side useEffect reads token from hash → `setToken(value)`. But:
- `site` state is still `null`
- Polling guard at line 219: `if (!isActiveStatus(site?.pipelineStatus) || !token) return;`
- `isActiveStatus(null)` = `false` → polling never starts → site stays null forever

**Dead-end:** Token available, but no mechanism to perform initial site data fetch.

### Bug 2: Session cookies lost

**File:** `app/verify/[id]/page.tsx` line 84

```typescript
router.replace(`/auth/exchange?code=${encodeURIComponent(data.exchangeCode)}`);
```

`router.replace` (Next.js App Router) navigates client-side. When the target is a Route Handler (`app/auth/exchange/route.ts`), Next.js internally fetches it. The response includes `Set-Cookie` headers, but **fetch responses do not set browser cookies** — only full-page navigations do.

The earlier `setSession()` call at line 73 uses the Supabase browser client, which stores tokens. But the server-side middleware expects cookies set by `@supabase/ssr`, creating a mismatch: client thinks it's logged in, server doesn't.

---

## Fix Specification

### Fix 1: Initial fetch when token available but site is null

**File:** `app/sites/[id]/SitePageClient.tsx`

Add a new useEffect after the token-loading effect (after line 193):

```typescript
// ── Initial fetch: token loaded (e.g. from hash) but server passed site=null ──
useEffect(() => {
  if (token && !site && tokenReady) {
    poll();
  }
}, [token, site, tokenReady, poll]);
```

This covers the exchange-redirect case: token arrives from hash, site is null from server, so we immediately fetch. Once `site` is populated with `pipelineStatus`, the existing polling interval (line 218-222) takes over.

**Guard:** The `poll()` function already has `if (!token) return;` at line 205, so double-calls are safe. The `setSite()` inside `poll()` will trigger re-renders that activate the status bar and the regular polling interval.

### Fix 2: Full-page navigation for exchange route

**File:** `app/verify/[id]/page.tsx` line 84

Replace:
```typescript
router.replace(`/auth/exchange?code=${encodeURIComponent(data.exchangeCode)}`);
```

With:
```typescript
window.location.href = `/auth/exchange?code=${encodeURIComponent(data.exchangeCode)}`;
```

This performs a full browser navigation → server processes the request → `Set-Cookie` headers are applied → Supabase session cookie is set → redirect to `/sites/:id#st=...&sid=...` works correctly.

**Side effect:** Full navigation is slightly slower than `router.replace` (full page load vs client-side transition). Acceptable — this happens once per OTP verify, and correctness matters more than 200ms.

### Fix 3: Remove redundant `setSession` call

**File:** `app/verify/[id]/page.tsx` lines 68-81

The `setSession()` call is now redundant since the exchange route handles cookie-setting server-side via full navigation. However, keep it as a **fallback** for the case where `exchangeCode` is not returned (e.g., `API_JWT_SECRET` not set). The try-catch already makes it non-fatal.

No change needed — leave as-is.

---

## Files Changed

| File | Change |
|------|--------|
| `app/sites/[id]/SitePageClient.tsx` | Add initial-fetch useEffect (~4 lines) |
| `app/verify/[id]/page.tsx` | `router.replace` → `window.location.href` (1 line) |

---

## Dependencies

- None. Both fixes are self-contained changes to existing files.
- No schema changes, no new packages, no migration.

---

## Interfaces

### Fix 1 contract

The new useEffect calls the existing `poll()` function which hits `GET /api/sites/:id?token=TOKEN`. Response shape is unchanged (`SiteData`). The `setSite()` call inside `poll()` populates the component state, which:
- Activates the status bar via `isActiveStatus(site?.pipelineStatus)`
- Starts the 3-second polling interval via the existing useEffect at line 218

### Fix 2 contract

`window.location.href` triggers a full GET to `/auth/exchange?code=JWT`. The exchange route's response (302 redirect with `Set-Cookie` headers) is unchanged. The browser follows the redirect and applies cookies normally.

---

## Acceptance Criteria

### AC-1: Status bar renders during active audit (exchange redirect flow)
- User submits free audit, verifies OTP
- After redirect via exchange route to `/sites/:id#st=...&sid=...`
- Status bar appears at top with pipeline stages (Connect → Read → ... → Finalize)
- Status bar updates as pipeline progresses (polling works)
- Status bar disappears when pipeline completes

### AC-2: Session cookies established after OTP verify
- User submits free audit, verifies OTP
- Browser has `sb-*` Supabase session cookies after redirect
- User can navigate to `/dashboard` and see their audit listed
- User can refresh `/dashboard` and session persists

### AC-3: Completion email link still works
- After audit completes, completion email link (`/sites/:id?token=TOKEN`) still renders the full results page
- No regression in token-based access

### AC-4: Existing paid-tier flow unaffected
- Pro users who submit audits from dashboard (already authenticated) see status bar and dashboard as before
- No change in behavior for users who already have a Supabase session

### AC-5: Docker CI passes
- `docker build -f Dockerfile.test -t geo-test . && docker run --rm geo-test` passes with all existing + new tests

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `window.location.href` causes flash/flicker during redirect | Low | Exchange route responds with 302 in <100ms; users won't notice |
| Initial fetch races with polling interval | Low | `poll()` is safe to call concurrently — it's a pure GET, and `setSite()` is idempotent |
| Hash token exposed in browser history | Low | Already the case today; `replaceState` in token-loading effect (line 189) clears hash after reading |

---

## Test Plan

### Unit Tests (Vitest)

**T-070-1: Initial fetch fires when token set but site is null**
- Mount SitePageClient with `site=null`, `initialToken=undefined`
- Simulate hash fragment `#st=TOKEN&sid=SITE_ID`
- Assert: `GET /api/sites/:id?token=TOKEN` is called within one tick
- Assert: After fetch resolves, `site` state is populated
- Assert: Status bar renders (check for `data-testid="audit-status-bar"` or pulsing dot)

**T-070-2: Polling starts after initial fetch populates site**
- Same setup as T-070-1, but mock fetch returns `pipelineStatus: "crawling"`
- Assert: 3-second polling interval is established
- Assert: Subsequent fetches occur every 3 seconds

**T-070-3: No double-fetch when site already populated from server**
- Mount SitePageClient with valid `site` data and `initialToken` set
- Assert: No extra fetch on mount (existing polling handles it)

**T-070-4: Email gate still renders when no token available**
- Mount SitePageClient with `site=null`, no token anywhere
- Wait for `tokenReady=true`
- Assert: Email gate form renders (data-testid="email-gate")

### Playwright E2E Tests

**E-070-1: Free tier OTP → status bar → dashboard flow**
- Navigate to homepage, submit a URL with test email
- Enter OTP code (mock or intercept via API)
- Assert: After redirect, status bar is visible with pipeline stages
- Navigate to `/dashboard`
- Assert: Dashboard loads (not redirected to login)
- Assert: At least one domain row is visible

**E-070-2: Completion email link renders results**
- Given a completed audit with known `siteId` and `accessToken`
- Navigate to `/sites/:id?token=TOKEN`
- Assert: GEO score is visible
- Assert: Executive summary is visible

**Note:** Playwright tests require a running dev server and may need OTP interception. Use the existing `test-geo@pcg-ww.com` email for live E2E, or mock the OTP endpoint for local runs.

---

## Implementation Notes for ScriptDev

1. **SitePageClient.tsx** — Add the useEffect after line 193. Add `data-testid="audit-status-bar"` to the status bar container (line 591) for test targeting.
2. **verify/[id]/page.tsx** — Single-line change at line 84. Do NOT remove the `setSession()` block above it (lines 68-81) — it's a fallback.
3. **Tests** — Place unit tests in `__tests__/free-tier-status-session.test.ts`. Place Playwright tests in `e2e/free-tier-flow.spec.ts` (create `e2e/` dir if needed).
4. **Docker CI** — Vitest tests are auto-picked up by `npm test`. Playwright tests run separately (not in Docker CI unless configured). Ensure vitest passes in Docker.
