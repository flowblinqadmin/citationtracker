# TS-007: Vercel Auth Proxy — Supabase Bypass for Indian Users

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#93](https://github.com/flowblinqadmin/geo/issues/93)  
> **Delivery Commit:** `1d9863d`  

---

## What

Route all browser-to-Supabase auth API calls through a Vercel proxy endpoint (`/api/auth/proxy/[...path]`). The browser never directly contacts `*.supabase.co` — it talks to `geo.flowblinq.com/api/auth/proxy/...` instead, and Vercel forwards server-to-server. This eliminates the ISP-level block on Supabase endpoints affecting Indian users.

## Why

Supabase's auth domain (`*.supabase.co`) is being blocked by Indian ISPs/networks. This breaks:
- Auth check on landing page (`supabase.auth.getUser()`)
- Token refresh (`autoRefreshToken: true`)
- Authenticated user session hydration on any page load
- OAuth sign-in initiation (to a lesser extent — see §5)

This is a production showstopper. Server-side code (middleware, API routes) running on Vercel is unaffected because Vercel's servers can reach Supabase fine. Only browser JS is blocked.

**Interim fix scope:** Proxy-only solution. No changes to auth model, session storage, or middleware. Deferred: full self-hosted auth (if block becomes permanent).

---

## Architecture

```
Before:
  Browser JS → supabase.co/auth/v1/* (BLOCKED for Indian users)
  Vercel middleware → supabase.co/auth/v1/* (works fine)

After:
  Browser JS → geo.flowblinq.com/api/auth/proxy/* → Vercel → supabase.co/auth/v1/* (works)
  Vercel middleware → supabase.co/auth/v1/* (unchanged)
```

---

## 1. New Proxy Route

**File:** `geo/app/api/auth/proxy/[...path]/route.ts` (NEW)

Catch-all handler that forwards all HTTP methods to the real Supabase auth API.

```typescript
import { NextRequest, NextResponse } from "next/server";

// The real Supabase URL — accessed server-to-server, no ISP blocking
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Headers that must NOT be forwarded upstream (hop-by-hop / Vercel internals)
const BLOCKED_REQUEST_HEADERS = new Set([
  "host", "connection", "transfer-encoding", "te",
  "trailer", "upgrade", "proxy-authorization", "proxy-authenticate",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
  "x-real-ip",
]);

// Headers that must NOT be forwarded to the browser from Supabase
const BLOCKED_RESPONSE_HEADERS = new Set([
  "transfer-encoding", "connection", "keep-alive",
  "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade",
  "content-encoding", // Vercel re-encodes
]);

async function proxyAuthRequest(
  req: NextRequest,
  { params }: { params: { path: string[] } }
): Promise<NextResponse> {
  const pathSegments = (await params).path;
  const targetPath = pathSegments.join("/");
  const targetUrl = new URL(`${SUPABASE_URL}/auth/v1/${targetPath}`);

  // Forward query string
  req.nextUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.set(key, value);
  });

  // Build forwarded headers
  const forwardHeaders = new Headers();
  forwardHeaders.set("apikey", SUPABASE_ANON_KEY);

  for (const [key, value] of req.headers.entries()) {
    if (!BLOCKED_REQUEST_HEADERS.has(key.toLowerCase())) {
      forwardHeaders.set(key, value);
    }
  }

  // Ensure Authorization is set (some calls use anon key as Bearer)
  if (!forwardHeaders.has("authorization")) {
    forwardHeaders.set("authorization", `Bearer ${SUPABASE_ANON_KEY}`);
  }

  // Forward body for methods that have one
  const hasBody = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
  const body = hasBody ? await req.arrayBuffer() : undefined;

  const upstream = await fetch(targetUrl.toString(), {
    method: req.method,
    headers: forwardHeaders,
    body: hasBody ? body : undefined,
    // Do not follow redirects — return them to the browser
    redirect: "manual",
  });

  // Build response headers
  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (!BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  }
  // Allow browser JS to read the response (CORS for same-origin is implicit)
  responseHeaders.set("Access-Control-Allow-Origin", req.headers.get("origin") ?? "*");
  responseHeaders.set("Access-Control-Allow-Credentials", "true");

  const responseBody = await upstream.arrayBuffer();

  return new NextResponse(responseBody, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = proxyAuthRequest;
export const POST = proxyAuthRequest;
export const PUT = proxyAuthRequest;
export const PATCH = proxyAuthRequest;
export const DELETE = proxyAuthRequest;

// Handle CORS preflight
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": req.headers.get("origin") ?? "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400",
    },
  });
}
```

**Security notes:**
- The proxy only forwards to `NEXT_PUBLIC_SUPABASE_URL` — hardcoded, not user-controlled
- Path segments are joined and appended to a known base URL — no SSRF risk
- Service role key is never used here — anon key only
- No rate limit needed on the proxy itself — Supabase enforces its own rate limits, and Vercel function limits apply

---

## 2. Browser Client Override

**File:** `geo/lib/supabase/client.ts`

Modify `createClient()` to intercept auth API calls and reroute them through the proxy.

```typescript
import { createBrowserClient } from "@supabase/ssr";

/**
 * Rewrites Supabase auth API calls to go through the Vercel proxy.
 * This prevents ISP-level blocks on supabase.co from affecting Indian users.
 * Database/realtime calls are not affected — they don't go through the browser client.
 */
function createProxyFetch(supabaseUrl: string): typeof fetch {
  const authPrefix = `${supabaseUrl}/auth/v1`;
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (urlStr.startsWith(authPrefix)) {
      const proxyUrl = urlStr.replace(authPrefix, "/api/auth/proxy");
      return fetch(proxyUrl, init);
    }
    return fetch(input, init);
  };
}

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

This is the minimal change. No env var changes, no config changes. The proxy URL is always `/api/auth/proxy` (same origin), which:
- Works in development (`localhost:3000/api/auth/proxy`)
- Works in production (`geo.flowblinq.com/api/auth/proxy`)
- Works in Vercel preview deployments (relative path)

---

## 3. What Changes vs. What Doesn't

| Component | Changes | Notes |
|-----------|---------|-------|
| `lib/supabase/client.ts` | Add custom fetch that rewrites auth URLs | Minimal — only intercepts auth calls |
| `app/api/auth/proxy/[...path]/route.ts` | NEW catch-all proxy | ~80 lines |
| `lib/supabase/server.ts` | None | Server-side still hits Supabase directly (no ISP block) |
| `lib/supabase/middleware.ts` | None | Middleware is server-side — unaffected |
| `lib/supabase/authenticated-client.ts` | None | Server-side only |
| `app/auth/callback/route.ts` | None | Server-side — unaffected |
| OAuth flow | None | OAuth redirect goes to OAuth provider (Google/GitHub), not Supabase directly. `/auth/callback` token exchange is server-side. Both unaffected. |
| Environment variables | None | No new vars needed |
| Supabase dashboard config | See §5 (OpsMaster) | CORS and allowed URLs |

---

## 4. Auth Flow Walkthrough (Post-Proxy)

### Landing page auth check (existing users)
```
Browser JS: createClient().auth.getUser()
  → fetch("/api/auth/proxy/user", { Authorization: Bearer <token> })
  → Vercel proxy → fetch("supabase.co/auth/v1/user", ...)
  → returns { user } or 401
```

### Token refresh
```
@supabase/ssr auto-refresh: fetch("/api/auth/proxy/token?grant_type=refresh_token", { body: { refresh_token } })
  → Vercel proxy → supabase.co/auth/v1/token
  → returns new { access_token, refresh_token }
```

### Google OAuth sign-in
```
Browser: supabase.auth.signInWithOAuth({ provider: "google" })
  → constructs redirect URL locally (no network call in PKCE flow)
  → browser redirects to accounts.google.com (not supabase.co)
  → Google redirects to geo.flowblinq.com/auth/callback?code=...
  → /auth/callback (server-side) calls supabase.auth.exchangeCodeForSession(code)
  → server-to-server call to supabase.co (unblocked)
  ✓ Fully unaffected by proxy
```

### Sign-out
```
Browser: supabase.auth.signOut()
  → fetch("/api/auth/proxy/logout", { method: "POST" })
  → Vercel proxy → supabase.co/auth/v1/logout
```

---

## 5. Supabase Dashboard Config (OpsMaster)

The following Supabase config items should be verified/updated:

### 5a. Allowed redirect URLs
Verify that `geo.flowblinq.com/auth/callback` is in the Supabase dashboard under:
**Authentication → URL Configuration → Redirect URLs**

No change expected — this should already be set. But confirm.

### 5b. Site URL
Confirm **Authentication → URL Configuration → Site URL** = `https://geo.flowblinq.com`

### 5c. CORS
Supabase auth API CORS is controlled by the `apikey` header — no explicit CORS config needed. The proxy adds the correct `apikey` header, so Supabase will accept the requests.

No Supabase config changes are expected to be required. OpsMaster confirms and documents.

---

## 6. Testing

1. **Proxy responds correctly:** `curl geo.flowblinq.com/api/auth/proxy/health` returns Supabase health endpoint response
2. **getUser() works:** Log in, visit landing page, confirm `supabase.auth.getUser()` succeeds (check Network tab — request goes to `/api/auth/proxy/user`)
3. **Token refresh works:** Set token expiry to 1 minute, confirm auto-refresh fires through proxy
4. **OAuth unaffected:** Google sign-in still works end-to-end
5. **Sign-out works:** Clears session correctly
6. **Indian network test:** Test from Indian IP (BhartiAirtel, Jio, BSNL) — confirm all auth flows succeed

---

## 7. Deferred

- If Supabase block becomes permanent: evaluate self-hosting Supabase Auth or migrating to a different auth provider
- Realtime/Storage also use supabase.co — if those become blocked, extend proxy or use Vercel Edge for those too (currently not used in geo.flowblinq.com)

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Proxy adds latency to every auth call | One Vercel function hop ≈ 20-50ms — acceptable for auth |
| Proxy becomes a single point of failure for auth | Same risk as any Vercel function. Deploy as edge function if needed. |
| Indian users hit ISP block during PKCE `authorize` redirect | PKCE URL is constructed client-side — no Supabase network call. Low risk. |
| Supabase updates auth endpoint URLs | Proxy pattern is URL-prefix-based — resilient to path changes |
| Request body too large for proxy | Supabase auth payloads are small (tokens, passwords) — no concern |
