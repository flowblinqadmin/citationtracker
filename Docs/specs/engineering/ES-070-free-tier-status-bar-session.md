# ES-070 — Free Tier: Status Bar + Session Cookie Fixes

**Source:** TS-070-free-tier-status-bar-session.md
**Priority:** P0 — live user-facing bug (free-tier OTP flow broken)
**Scope:** 2 files modified, ~5 lines of implementation code

---

## a) Overview

Two P0 bugs prevent every free-tier user from completing the OTP→audit→dashboard flow:

1. **Status bar not rendering** — After OTP verify, the exchange route redirects to `/sites/:id#st=TOKEN&sid=ID`. The hash fragment is invisible to the server, so `safeSite=null`. Client reads the token from the hash but has no site data, and the polling guard (`isActiveStatus(null)`) never passes. The status bar never appears; the page appears broken during the audit.

2. **Session cookies not established** — `router.replace()` to the exchange route performs a client-side fetch. The `Set-Cookie` headers in the response are ignored by the browser (fetch responses don't set cookies). Result: no Supabase session → `/dashboard` redirects to login.

### Current Implementation State

- **`app/sites/[id]/SitePageClient.tsx`** — Token-loading effect (lines 172-193) correctly reads `#st=TOKEN` from hash and sets `token` state + `tokenReady`. But no effect bridges the gap between "token available" and "site is null" — the polling interval at line 218-222 only fires when `isActiveStatus(site?.pipelineStatus)` is true, which requires `site` to already be populated.

- **`app/verify/[id]/page.tsx`** — Line 84 uses `router.replace()` for the exchange route redirect. The `setSession()` fallback (lines 68-81) works for the Supabase JS client but not for server-side middleware which reads cookies.

- **`app/sites/[id]/page.tsx`** — Line 90: `safeSite` is null when `searchParams.token` is undefined (hash-based access). This is correct server behavior; the client must handle the initial fetch.

---

## b) Implementation Requirements

### Fix 1: Initial fetch when token available but site is null

**File:** `app/sites/[id]/SitePageClient.tsx`

**Insert after line 193** (after the token-loading useEffect, before the CSS var useEffect):

```typescript
// ── Initial fetch: token loaded (e.g. from hash) but server passed site=null ──
useEffect(() => {
  if (token && !site && tokenReady) {
    poll();
  }
}, [token, site, tokenReady, poll]);
```

**Behavior:**
- When the token-loading effect sets `token` from hash and `tokenReady=true`, but `site` is still `null` (server had no matching token), this effect calls `poll()`.
- `poll()` fetches `GET /api/sites/:id?token=TOKEN`, populates `site` via `setSite()`.
- Once `site` is populated with an active `pipelineStatus`, the existing polling interval (line 218-222) takes over.
- The `poll()` function has its own `if (!token) return` guard — safe against double-calls.

**Add `data-testid`** to the status bar container for test targeting:

**At line 591** (the outer `<div>` of the status bar), add `data-testid="audit-status-bar"` to the style props:

```typescript
<div data-testid="audit-status-bar" style={{
  position: "sticky", top: 56, zIndex: 90,
  // ... rest unchanged
```

### Fix 2: Full-page navigation for exchange route

**File:** `app/verify/[id]/page.tsx`

**Line 84 — replace:**
```typescript
router.replace(`/auth/exchange?code=${encodeURIComponent(data.exchangeCode)}`);
```

**With:**
```typescript
window.location.href = `/auth/exchange?code=${encodeURIComponent(data.exchangeCode)}`;
```

**Behavior:**
- Full browser navigation → server processes request → `Set-Cookie` headers applied → Supabase session established → redirect to `/sites/:id#st=...&sid=...` works correctly.
- ~200ms slower than client-side nav (acceptable — one-time event during OTP verify).

### Fix 3: No change (keep setSession fallback)

**File:** `app/verify/[id]/page.tsx` lines 68-81

Leave `setSession()` as-is. It serves as a fallback when `exchangeCode` is not returned (e.g., `API_JWT_SECRET` not configured). The try-catch makes it non-fatal.

### Interfaces

No new interfaces, types, or API changes. Both fixes use existing `poll()` and `window.location.href`.

### Error Handling

- `poll()` already has try-catch with silent failure — no change needed.
- `window.location.href` navigation is a standard browser operation — no error handling needed.

### Performance

- Fix 1 adds one extra fetch call on the exchange-redirect path only. This fetch would have happened via polling anyway; it just fires immediately instead of never.
- Fix 2 replaces a client-side nav with a full page load. Adds ~200ms one time. Acceptable for correctness.

---

## c) Unit Test Plan

**File:** `__tests__/free-tier-status-session.test.ts`

**Framework:** Vitest + React Testing Library

**Mock requirements:**
- Mock `fetch` to intercept `GET /api/sites/:id?token=TOKEN`
- Mock `window.location.hash` for hash fragment simulation
- Mock `sessionStorage` for token persistence
- Mock `useRouter` from `next/navigation`

### Test Cases

**T-070-1: Initial fetch fires when token set but site is null**
- **Setup:** Render SitePageClient with `initialSite=null`, `initialToken=undefined`. Set `window.location.hash = "#st=MOCK_TOKEN&sid=SITE_ID"`.
- **Assert:** `fetch` called with `/api/sites/SITE_ID?token=MOCK_TOKEN` within one tick.
- **Assert:** After fetch resolves with `{ pipelineStatus: "crawling", domain: "example.com", ... }`, site state is populated.
- **Assert:** Element with `data-testid="audit-status-bar"` is in the DOM.

**T-070-2: Polling starts after initial fetch populates site with active status**
- **Setup:** Same as T-070-1. Mock fetch returns `{ pipelineStatus: "crawling" }`.
- **Assert:** After initial fetch, `setInterval` is called with 3000ms interval.
- **Assert:** Subsequent fetch calls occur every 3 seconds (advance timers).

**T-070-3: No extra fetch when site already populated from server**
- **Setup:** Render SitePageClient with valid `initialSite` (non-null, with `pipelineStatus: "complete"`) and `initialToken="TOKEN"`.
- **Assert:** No fetch calls on mount (token resolved from props, site already available).
- **Assert:** No polling interval started (status is not active).

**T-070-4: Email gate renders when no token available**
- **Setup:** Render SitePageClient with `initialSite=null`, `initialToken=undefined`, no hash fragment.
- **Assert:** After `tokenReady=true`, email gate form (`data-testid="email-gate"`) renders.
- **Assert:** No fetch calls to `/api/sites/...`.

**Minimum coverage:** 100% of new code (4 lines of implementation + 1 line data-testid).

---

## d) Integration Test Plan

**File:** `__tests__/free-tier-status-session.integration.test.ts`

### Scenarios

**IT-070-1: Hash-based token → initial fetch → status bar → polling cycle**
- Mount SitePageClient with null site, hash token.
- Mock API returns active pipeline status.
- Verify: initial fetch → status bar renders → polling ticks → status updates → polling stops on completion.

**IT-070-2: Exchange redirect path sets session cookies**
- Render VerifyPage component.
- Submit valid OTP code, mock API returns `exchangeCode`.
- Verify: `window.location.href` is set to `/auth/exchange?code=...` (not `router.replace`).

**IT-070-3: Fallback to token-based redirect when no exchangeCode**
- Render VerifyPage component.
- Submit valid OTP, mock API returns `accessToken` but no `exchangeCode`.
- Verify: `router.replace` called with `/sites/:id?token=TOKEN`.

**IT-070-4: setSession fallback still fires when authOtp present**
- Render VerifyPage.
- Mock API returns `authOtp` JSON with tokens + `exchangeCode`.
- Verify: `supabase.auth.setSession()` called before navigation.
- Verify: Navigation still uses `window.location.href`.

---

## e) Profiling Requirements

Not applicable — this is a 2-line bugfix. No new computation, no new data flow.

---

## f) Load Test Plan

Not applicable — no new API endpoints, no changes to request handling. The fix adds one initial fetch that was already in the polling path.

---

## g) Logging & Instrumentation

No new logging required. The existing `poll()` function has no logging (silent catch). The fix does not introduce new failure modes.

**Optional (not required for AC):** ScriptDev may add a `console.debug` to the new useEffect for debugging:
```typescript
console.debug('[SitePageClient] initial-fetch: token available, site null, fetching');
```

---

## h) Acceptance Criteria

| # | Criterion | Section |
|---|-----------|---------|
| AC-1 | After OTP verify + exchange redirect to `/sites/:id#st=...&sid=...`, the status bar (audit progress) appears within 1 second | §b Fix 1 |
| AC-2 | Status bar updates as pipeline progresses (polling works after initial fetch) | §b Fix 1 |
| AC-3 | Status bar disappears when pipeline completes | §b Fix 1 |
| AC-4 | After OTP verify, browser has `sb-*` Supabase session cookies | §b Fix 2 |
| AC-5 | User can navigate to `/dashboard` after OTP verify without re-login | §b Fix 2 |
| AC-6 | User can refresh `/dashboard` and session persists | §b Fix 2 |
| AC-7 | Completion email link (`/sites/:id?token=TOKEN`) still renders full results page (no regression) | §b Fix 3 |
| AC-8 | Existing paid-tier flow (already authenticated) sees status bar and dashboard as before | §b |
| AC-9 | Email gate still renders when no token is available | §c T-070-4 |
| AC-10 | `data-testid="audit-status-bar"` present on status bar container | §b Fix 1 |
| AC-11 | T-070-1 through T-070-4 unit tests pass | §c |
| AC-12 | IT-070-1 through IT-070-4 integration tests pass | §d |
| AC-13 | `docker build -f Dockerfile.test -t geo-test . && docker run --rm geo-test` passes with all existing + new tests | §c |
| AC-14 | No new packages or schema changes introduced | TS-070 §Dependencies |

### Playwright E2E Tests (run outside Docker)

**File:** `e2e/free-tier-flow.spec.ts`

**E-070-1: Free tier OTP → status bar → dashboard flow**
- Navigate to homepage, submit URL with test email.
- Enter OTP code (intercept via API or use test email `test-geo@pcg-ww.com`).
- Assert: After redirect, status bar visible (`data-testid="audit-status-bar"`).
- Navigate to `/dashboard`.
- Assert: Dashboard loads, not redirected to login.

**E-070-2: Completion email link renders results**
- Given completed audit with known `siteId` and `accessToken`.
- Navigate to `/sites/:id?token=TOKEN`.
- Assert: GEO score visible, executive summary visible.

---

## ScriptDev Notes

1. **SitePageClient.tsx** — Insert the new `useEffect` block after line 193 (after the token-loading effect's closing). Add `data-testid="audit-status-bar"` to the `<div>` at line 591.
2. **verify/[id]/page.tsx** — Single-line change at line 84: `router.replace(...)` → `window.location.href = ...`. Do NOT remove the `setSession()` block above it (lines 68-81).
3. **Tests** — Unit tests in `__tests__/free-tier-status-session.test.ts`. Integration tests in `__tests__/free-tier-status-session.integration.test.ts`. Playwright E2E in `e2e/free-tier-flow.spec.ts`.
4. **Docker CI** — Vitest tests are auto-picked up by `npm test`. Playwright tests are excluded from Docker CI.
5. **No `useRouter` removal** — `router` is still used for `router.refresh()` in `poll()` (line 212) and for the non-exchange fallback path (line 86). Do not remove the `useRouter` import.
