# ES-007: Vercel Auth Proxy — Supabase ISP Block Bypass

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#93](https://github.com/flowblinqadmin/geo/issues/93)  
> **Delivery Commit:** `1d9863d`  

---

**Source:** TS-007-vercel-auth-proxy.md
**Agent:** 2-SpecMaster
**Date:** 2026-02-28
**Priority:** SHOWSTOPPER — Indian users cannot authenticate
**Branch:** `dev-an-m2-extended`
**Repo:** flowblinqadmin/geo (local: `/home/aditya/flowblinq/geo`)
**Lang:** TypeScript / Next.js App Router

---

## a) Overview

### What This Covers

Two-file change that routes all browser-to-Supabase auth API calls through a Vercel catch-all
proxy route, eliminating the ISP-level block on `*.supabase.co` that prevents Indian users from
authenticating.

**File 1 (NEW):** `geo/app/api/auth/proxy/[...path]/route.ts`
**File 2 (MODIFY):** `geo/lib/supabase/client.ts`

### Reference

Source technical spec: `.agents/specs/technical/TS-007-vercel-auth-proxy.md`

### Current Implementation State

**`geo/lib/supabase/client.ts` (26 lines — exists):**
`createClient()` calls `createBrowserClient` with `persistSession: true` and `autoRefreshToken: true`.
No custom `fetch`. Browser JS calls `${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/*` directly — blocked for
Indian users.

**`geo/app/api/auth/proxy/` (does not exist):**
Directory and catch-all route must be created from scratch.

**Unchanged files (server-side — ISP block does not affect them):**
- `geo/lib/supabase/server.ts`
- `geo/lib/supabase/middleware.ts`
- `geo/app/auth/callback/route.ts`
- `geo/middleware.ts`

**No new environment variables required.** Uses existing `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY`.

### Why This Is Urgent

Indian users on Airtel, Jio, and BSNL are ISP-blocked from `*.supabase.co`. Every browser call to
`supabase.auth.getUser()`, token auto-refresh, and session hydration fails. This is a complete auth
outage for the Indian market.

Server-side code (middleware, API routes, auth callback) is unaffected — Vercel's servers reach
Supabase normally. Only browser JS is blocked.

---

## b) Implementation Requirements

### File 1: New Proxy Route

**Path:** `geo/app/api/auth/proxy/[...path]/route.ts`

Create all parent directories. This is a Next.js catch-all App Router route.

#### Exports required

```typescript
export const GET    = proxyAuthRequest;
export const POST   = proxyAuthRequest;
export const PUT    = proxyAuthRequest;
export const PATCH  = proxyAuthRequest;
export const DELETE = proxyAuthRequest;
export async function OPTIONS(req: NextRequest): Promise<NextResponse>
```

#### Core handler signature

```typescript
async function proxyAuthRequest(
  req: NextRequest,
  { params }: { params: { path: string[] } }
): Promise<NextResponse>
```

#### Request forwarding — step by step

1. **Await params** — Next.js 15 requires `const { path } = await params` (async params).
2. **Build target URL** — `new URL(\`\${SUPABASE_URL}/auth/v1/\${path.join("/")}\`)`.
3. **Forward query string** — iterate `req.nextUrl.searchParams` and append each key/value to target URL.
4. **Build forwarded headers** — start with empty `Headers()`, then:
   - Iterate `req.headers.entries()`; skip any key in the blocked-request-headers set (lowercase compare)
   - Always set `apikey: SUPABASE_ANON_KEY`
   - If no `authorization` header present in incoming request, set `Authorization: Bearer ${SUPABASE_ANON_KEY}`
5. **Read body** — for methods POST/PUT/PATCH/DELETE: `await req.arrayBuffer()`. For all others: undefined.
6. **Upstream fetch** — `fetch(targetUrl.toString(), { method, headers: forwardHeaders, body, redirect: "manual" })`.
   `redirect: "manual"` preserves 3xx responses for the browser to follow.
7. **Build response headers** — iterate upstream response headers; skip any key in the blocked-response-headers set; add CORS headers.
8. **Return** — `new NextResponse(await upstream.arrayBuffer(), { status: upstream.status, headers: responseHeaders })`.

#### Blocked request headers (do not forward upstream)

```
host, connection, transfer-encoding, te, trailer, upgrade,
proxy-authorization, proxy-authenticate,
x-forwarded-for, x-forwarded-host, x-forwarded-proto, x-real-ip
```

#### Blocked response headers (do not return to browser)

```
transfer-encoding, connection, keep-alive,
proxy-authenticate, proxy-authorization, te, trailer, upgrade,
content-encoding
```

`content-encoding` is stripped because Vercel re-encodes the response body and double-encoding
causes parse errors.

#### CORS headers to add to every response

```
Access-Control-Allow-Origin: <reflect incoming Origin header, or * if absent>
Access-Control-Allow-Credentials: true
```

#### OPTIONS preflight response

HTTP 204, no body, with these headers:

```
Access-Control-Allow-Origin: <reflect Origin or *>
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: authorization, apikey, content-type, x-client-info, x-supabase-api-version
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 86400
```

#### Error handling

| Condition | Response |
|-----------|----------|
| `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY` is falsy at runtime | HTTP 500 `{ error: "Proxy misconfigured" }` |
| Upstream `fetch()` throws (network error, DNS failure) | HTTP 502 `{ error: "Upstream unavailable" }` |
| Upstream returns any HTTP status | Forward verbatim (200, 201, 204, 301, 302, 400, 401, 403, 422, 429, 503, etc.) |

#### Security invariants (must hold in implementation)

- Target URL base is always `process.env.NEXT_PUBLIC_SUPABASE_URL` — never derived from the request
- Path segments joined and appended to a known fixed base — no SSRF risk
- Service role key is never referenced — anon key only
- No rate limiting at the proxy level — Supabase enforces its own; Vercel function concurrency applies

### File 2: Modified Browser Client

**Path:** `geo/lib/supabase/client.ts`

Add a `createProxyFetch` helper function and pass it as `global.fetch` in `createClient()`.

#### `createProxyFetch` function

```typescript
/**
 * Returns a custom fetch that intercepts Supabase auth API calls and reroutes
 * them through the Vercel proxy at /api/auth/proxy.
 *
 * This prevents ISP-level blocks on supabase.co from breaking auth for Indian users.
 * Only /auth/v1/* calls are intercepted. Database, storage, and realtime calls are
 * unaffected.
 */
function createProxyFetch(supabaseUrl: string): typeof fetch {
  const authPrefix = `${supabaseUrl}/auth/v1`;
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
    if (urlStr.startsWith(authPrefix)) {
      const proxyUrl = urlStr.replace(authPrefix, "/api/auth/proxy");
      return fetch(proxyUrl, init);
    }
    return fetch(input, init);
  };
}
```

#### Updated `createClient()`

```typescript
export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  return createBrowserClient(
    supabaseUrl,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
      global: {
        fetch: createProxyFetch(supabaseUrl),
      },
    }
  );
}
```

The existing JSDoc comment above `createClient()` should be updated to note the proxy fetch.

#### Why `/api/auth/proxy` (relative path) works everywhere

- Development: `http://localhost:3000/api/auth/proxy/*`
- Production: `https://geo.flowblinq.com/api/auth/proxy/*`
- Vercel preview: `https://<deploy-id>.vercel.app/api/auth/proxy/*`

No environment-specific configuration is needed.

### What Does Not Change

| File | Status | Notes |
|------|--------|-------|
| `geo/lib/supabase/server.ts` | Unchanged | Server-side, hits Supabase directly — no ISP block |
| `geo/lib/supabase/middleware.ts` | Unchanged | Server-side |
| `geo/app/auth/callback/route.ts` | Unchanged | Server-side token exchange |
| `geo/middleware.ts` | Unchanged | Server-side |
| OAuth (Google sign-in) | Unchanged | Redirect goes to accounts.google.com; callback is server-side |
| Environment variables | Unchanged | No new vars needed |
| Supabase dashboard config | Verify only | See OpsMaster dependency below |

---

## c) Unit Test Plan

**Test file 1:** `geo/app/api/auth/proxy/route.test.ts` (NEW)
**Test file 2:** `geo/lib/supabase/client.test.ts` (NEW)
**Framework:** Vitest (matches project convention — see `site-creation-limits.test.ts`)

### Setup

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
```

Mock `process.env` before each test:
```typescript
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
});
```

Mock global `fetch` using `vi.fn()` to control upstream responses.

### Suite 1: Proxy route — request forwarding (`route.test.ts`)

| Test | Input | Expected |
|------|-------|----------|
| Forwards GET to correct upstream path | `GET /api/auth/proxy/user` | Upstream called at `https://test.supabase.co/auth/v1/user` |
| Forwards multi-segment path | `params.path = ["admin", "users"]` | Upstream URL ends with `/auth/v1/admin/users` |
| Forwards query string | `?grant_type=refresh_token` | Upstream URL has `?grant_type=refresh_token` |
| Sets `apikey` header always | Any request | Upstream fetch called with `apikey: test-anon-key` |
| Sets default Authorization when absent | Request with no Authorization | Upstream gets `Authorization: Bearer test-anon-key` |
| Preserves explicit Authorization | Request with `Authorization: Bearer user-jwt` | Upstream gets `Authorization: Bearer user-jwt` |
| Strips `host` from forwarded headers | Request with `host: geo.flowblinq.com` | Upstream called without `host` header |
| Strips `x-forwarded-for` | Request with `x-forwarded-for: 1.2.3.4` | Not in upstream headers |
| Forwards POST body | POST with JSON body `{email, password}` | Upstream receives same body as ArrayBuffer |
| No body on GET | GET request | Upstream called with `body: undefined` |

### Suite 2: Proxy route — response handling (`route.test.ts`)

| Test | Upstream mock | Expected response |
|------|---------------|-------------------|
| Returns upstream status verbatim (200) | Returns 200 | Response status 200 |
| Returns upstream 401 | Returns 401 | Response status 401 |
| Returns upstream 204 (sign-out) | Returns 204 | Response status 204 |
| Strips `content-encoding` from response | Returns with `content-encoding: gzip` | Response has no `content-encoding` |
| Strips `transfer-encoding` | Returns with `transfer-encoding: chunked` | Not in response headers |
| Sets CORS `Allow-Origin` from Origin | Request from `https://geo.flowblinq.com` | Response `Access-Control-Allow-Origin: https://geo.flowblinq.com` |
| Sets CORS `Allow-Origin` fallback | Request with no Origin | Response `Access-Control-Allow-Origin: *` |
| Sets `Access-Control-Allow-Credentials: true` | Any request | Header is `"true"` |

### Suite 3: OPTIONS preflight (`route.test.ts`)

| Test | Expected |
|------|----------|
| OPTIONS returns 204 | Status 204, no body |
| Includes all allowed methods | `Access-Control-Allow-Methods` contains GET, POST, PUT, PATCH, DELETE, OPTIONS |
| Includes required headers list | `Access-Control-Allow-Headers` contains `apikey` and `content-type` |
| Max-Age is 86400 | `Access-Control-Max-Age: 86400` |
| Reflects Origin | With `Origin: https://geo.flowblinq.com`, response allows that origin |

### Suite 4: Error handling (`route.test.ts`)

| Test | Condition | Expected |
|------|-----------|----------|
| Upstream network failure | `fetch()` throws `TypeError: fetch failed` | Returns HTTP 502, body `{ error: "Upstream unavailable" }` |
| Missing SUPABASE_URL | `process.env.NEXT_PUBLIC_SUPABASE_URL = ""` | Returns HTTP 500, body `{ error: "Proxy misconfigured" }` |
| Missing SUPABASE_ANON_KEY | `process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ""` | Returns HTTP 500, body `{ error: "Proxy misconfigured" }` |

### Suite 5: `createProxyFetch` intercept logic (`client.test.ts`)

Export `createProxyFetch` as a named export (or test indirectly). If exporting for test:
```typescript
export { createProxyFetch }; // add to client.ts test-export
```

| Test | Input URL | Expected |
|------|-----------|----------|
| Intercepts auth URL | `https://test.supabase.co/auth/v1/user` | Calls `fetch("/api/auth/proxy/user", init)` |
| Intercepts token endpoint with query | `https://test.supabase.co/auth/v1/token?grant_type=refresh_token` | Calls `fetch("/api/auth/proxy/token?grant_type=refresh_token", init)` |
| Does not intercept REST | `https://test.supabase.co/rest/v1/geo_sites` | Calls `fetch` with original URL |
| Does not intercept realtime | `https://test.supabase.co/realtime/v1/websocket` | Original URL |
| Does not intercept different Supabase instance | `https://other.supabase.co/auth/v1/user` | Original URL (only matches configured `supabaseUrl`) |
| Preserves `init` options | POST with body and headers | `init` passed through unchanged to proxied fetch |
| Handles `URL` object input | `new URL("https://test.supabase.co/auth/v1/user")` | Correctly extracted and proxied |
| Handles `Request` object input | `new Request("https://test.supabase.co/auth/v1/user")` | Uses `.url` property |

### Coverage target

85% line coverage on `geo/app/api/auth/proxy/[...path]/route.ts`.

---

## d) Integration Test Plan

**Test file:** `geo/app/api/auth/proxy/integration.test.ts` (NEW, Vitest)

These tests verify the browser client and proxy route work together. Use a mock HTTP server
(e.g. `msw` or a simple `http.createServer`) that listens locally and simulates Supabase auth
responses.

### Scenario 1: `getUser()` routed through proxy

1. Set `NEXT_PUBLIC_SUPABASE_URL` to point to a local mock server.
2. Mock server responds to `GET /auth/v1/user` with `{ id: "u1", email: "test@example.com" }`.
3. Instantiate `createClient()` with a valid session token.
4. Call `client.auth.getUser()`.
5. Assert: mock server received request at `/auth/v1/user` (not called directly by browser — in test environment this is verified by the mock receiving it).
6. Assert: `apikey` header present in request received by mock server.
7. Assert: returned data matches `{ id: "u1", email: "test@example.com" }`.

### Scenario 2: Token refresh routed through proxy

1. Mock server responds to `POST /auth/v1/token?grant_type=refresh_token` with new token payload.
2. Trigger `client.auth.refreshSession({ refresh_token: "rt-123" })`.
3. Assert: request arrived at mock server `/auth/v1/token`.
4. Assert: new session tokens returned to caller.

### Scenario 3: Non-auth calls bypass proxy

1. Mock a Supabase REST endpoint `/rest/v1/geo_sites`.
2. Perform a Supabase database query via the browser client.
3. Assert: request goes directly to `${SUPABASE_URL}/rest/v1/geo_sites` — NOT to `/api/auth/proxy`.

### Scenario 4: Upstream error propagation

1. Mock server returns HTTP 503 on `/auth/v1/user`.
2. Call `client.auth.getUser()`.
3. Assert: the supabase-js client surfaces an error (does not swallow 503 as success).

### Failure mode tests

| Scenario | Expected |
|----------|----------|
| Proxy route unreachable (mock returns network error) | `getUser()` returns error, call completes within 5 seconds (no hang) |
| Upstream returns malformed JSON | Proxy forwards raw bytes; supabase-js client handles parse error gracefully |
| Upstream returns 301 redirect with `Location` | `redirect: "manual"` — proxy returns 301 to caller; not silently followed |

---

## e) Profiling Requirements

### What to Measure

- Added latency per auth call: before (direct to supabase.co) vs. after (through Vercel proxy)
- Proxy function cold start time (first invocation after idle period)
- Sustained throughput: auth checks from concurrent landing page sessions

### Baseline Expectations

| Metric | Target |
|--------|--------|
| Proxy-added latency (p99) | < 100ms |
| Cold start | < 500ms |
| Token refresh (end-to-end including proxy) | < 2 seconds |

### Profiling Approach

1. **Vercel Dashboard → Functions tab:** Monitor duration for `api/auth/proxy/[...path]` invocations.
2. **Browser DevTools Network panel:** Filter by `/api/auth/proxy`; inspect TTFB column.
3. **Structured log in proxy route:** `console.log(JSON.stringify({ event: "auth_proxy", method, path, status, durationMs }))` — enables Vercel log queries for p50/p95/p99.
4. **Pre/post comparison:** Deploy to Vercel preview. Compare auth TTFB in DevTools between current production and the preview deployment.

---

## f) Load Test Plan

### Scenarios

**Scenario 1 — Sustained landing page sessions**
50 concurrent virtual users, each calling `GET /api/auth/proxy/user` with a valid Bearer token.
Duration: 5 minutes. Token auto-refresh simulated every 60 seconds.

**Scenario 2 — Peak spike**
200 concurrent requests to `GET /api/auth/proxy/user` within 10 seconds.
Simulates a campaign or viral traffic spike hitting the landing page.

**Scenario 3 — Refresh storm**
100 concurrent `POST /api/auth/proxy/token?grant_type=refresh_token` requests.
Simulates users returning after token expiry simultaneously.

### Success Criteria

| Metric | Target |
|--------|--------|
| p50 proxy response time | < 150ms |
| p95 proxy response time | < 400ms |
| p99 proxy response time | < 800ms |
| HTTP error rate (5xx) | < 0.1% |
| Vercel function timeout rate (10s limit) | 0% |

### Resource Bounds

- Auth payloads are small (< 4KB) — no memory pressure.
- Supabase upstream rate limits apply — do not exceed project-level auth rate limits during load test (use a test project or coordinate timing).
- Vercel Hobby: 10s timeout, 1024MB. Pro: 300s timeout, 3008MB. Auth calls complete well within 10s.

### Recommended Tool

k6 or Artillery targeting `https://geo.flowblinq.com/api/auth/proxy/user` with a valid `Authorization: Bearer <token>` header.

---

## g) Logging & Instrumentation

### Events to Log

| Event | Level | Structured fields |
|-------|-------|-------------------|
| Each proxied request (summary) | INFO | `{ event: "auth_proxy_request", method, path, status, durationMs }` |
| Upstream 4xx response | WARN | `{ event: "auth_proxy_upstream_error", path, status }` |
| Upstream 429 (rate limited) | WARN | `{ event: "auth_proxy_rate_limited", path, retryAfter }` |
| Upstream network error | ERROR | `{ event: "auth_proxy_network_failure", path, error: err.message }` |
| Proxy misconfiguration | ERROR | `{ event: "auth_proxy_misconfigured", missing: "SUPABASE_URL" \| "SUPABASE_ANON_KEY" }` |

Emit all logs via `console.log(JSON.stringify(...))` for Vercel structured log ingestion (matches
existing convention in `geo/app/api/sites/route.ts`).

### Do NOT Log

- `Authorization` header values or any JWT/token string
- Request or response body content (contains credentials)
- User IP addresses

### Metrics Pattern

Add `const startTime = Date.now()` at function entry; compute `durationMs = Date.now() - startTime`
before returning.

```typescript
console.log(JSON.stringify({
  event: "auth_proxy_request",
  method: req.method,
  path: targetPath,
  status: upstream.status,
  durationMs: Date.now() - startTime,
}));
```

Log once per request, after the upstream response is received.

---

## h) Acceptance Criteria

- [ ] `GET /api/auth/proxy/health` returns any response (proves route is deployed and proxy is wired)
- [ ] Browser DevTools Network tab shows `/api/auth/proxy/user` on landing page load — no direct `*.supabase.co` calls from browser
- [ ] Token auto-refresh fires via `POST /api/auth/proxy/token?grant_type=refresh_token` (verify by setting short expiry in staging)
- [ ] Google OAuth sign-in completes end-to-end (OAuth redirect → Google → `/auth/callback` server-side exchange — all unaffected)
- [ ] `supabase.auth.signOut()` routes through `/api/auth/proxy/logout` and clears session
- [ ] Supabase database queries do NOT route through proxy (Network tab: REST calls go directly to `*.supabase.co`)
- [ ] No tokens or Authorization header values appear in Vercel function logs
- [ ] Unit tests pass: 85%+ line coverage on proxy route file
- [ ] Integration test: `getUser()` reaches mock Supabase server via proxy path
- [ ] No new environment variables added
- [ ] Tested from Indian IP (Airtel, Jio, or BSNL): all auth flows succeed where they previously failed

---

## OpsMaster Dependency

OpsMaster must verify (no code changes expected) in the Supabase dashboard:

1. **Redirect URLs:** `https://geo.flowblinq.com/auth/callback` is listed under Authentication → URL Configuration → Redirect URLs.
2. **Site URL:** `https://geo.flowblinq.com` is set as Site URL.
3. **CORS:** No explicit CORS change needed — proxy adds the correct `apikey` header that Supabase uses to accept cross-origin auth requests.

OpsMaster should log confirmation in their status file or post an announcement.
