# OPS-007: Auth Proxy Deployment — Supabase Config & Verification

**Status:** Ready for pre-deployment execution
**Priority:** P0 — Production blocker
**Related spec:** TS-007-vercel-auth-proxy.md
**Date:** 2026-02-28
**Owner:** OpsMaster (3)

---

## Context

Supabase auth endpoints (`*.supabase.co`) are ISP-blocked for Indian users (Jio, Airtel, BSNL).
SpecMaster is implementing the code fix (Vercel proxy route + browser client override per TS-007).
This document covers:

1. Supabase dashboard config checklist (pre-deployment)
2. CSP finding from `next.config.ts`
3. Post-deployment verification steps
4. Rollback plan
5. T008 deferral note
6. Infra runbook entry for this proxy pattern

---

## 1. Supabase Dashboard Config Checklist

These are verification steps only — no new config is expected to be required. Confirm and check
off before the proxy goes live.

**Access path:**
Supabase Dashboard -> Project -> Authentication -> URL Configuration

---

### 1a. Site URL

| Setting  | Required value               | Action                              |
|----------|------------------------------|-------------------------------------|
| Site URL | `https://geo.flowblinq.com`  | Verify. If different, update it.    |

**Why it matters:** Supabase uses Site URL as the default redirect for email-based auth flows
(magic links, password reset). If wrong, email-triggered auth will land on the wrong host.

**Expected state:** Already set. Confirm only.

---

### 1b. Redirect URLs

| URL                                                   | Required         | Action                              |
|-------------------------------------------------------|------------------|-------------------------------------|
| `https://geo.flowblinq.com/auth/callback`             | Yes              | Verify present. Add if missing.     |
| `https://geo.flowblinq.com/**` (wildcard)             | Optional         | Acceptable alternative to specific path |
| `https://*-flowblinq.vercel.app/auth/callback`        | Optional (QA)    | Add if Vercel preview QA is needed  |
| `http://localhost:3000/auth/callback`                 | Development      | Should already exist for local dev  |

**Why it matters:** Supabase only redirects OAuth flows to URLs in this allowlist. If
`geo.flowblinq.com/auth/callback` is absent, OAuth sign-in will fail with a
`redirect_uri_mismatch` error.

**Expected state:** Already set (the app uses this callback today). Confirm only.

**Note on the proxy:** `/api/auth/proxy/*` is a server-side Vercel function — it is not an OAuth
redirect target. The redirect URL list does not need updating for the proxy to function.

---

### 1c. CORS Configuration

**Action required: None.**

Supabase auth API CORS is governed by the `apikey` header. When a valid anon key is present,
Supabase accepts requests from any origin. The proxy adds `apikey: <SUPABASE_ANON_KEY>` to every
upstream request. Therefore:

- No explicit CORS allowlist needs to be configured in the Supabase dashboard
- Supabase will respond correctly to proxy-forwarded requests
- The proxy itself sets `Access-Control-Allow-Origin` on responses back to the browser

**Confirmed: No Supabase CORS dashboard changes required.**

---

### 1d. No Other Dashboard Changes Required

| Area                       | Change needed | Reason                                          |
|----------------------------|---------------|-------------------------------------------------|
| Auth providers (Google)    | No            | OAuth redirect URIs already set                 |
| Email templates            | No            | Not affected by proxy                           |
| JWT expiry                 | No            | No change to token lifecycle                    |
| Rate limits                | No            | Supabase enforces its own; proxy is transparent |
| Billing / plan             | No            | No new Supabase features used                   |

---

## 2. next.config.ts CSP Finding

**File:** `geo/next.config.ts`

The Content Security Policy `connect-src` directive currently reads:

```
connect-src 'self' https://*.supabase.co https://api.stripe.com https://generativelanguage.googleapis.com https://api.openai.com
```

**Assessment:**

- `'self'` covers `geo.flowblinq.com/api/auth/proxy/*` — browser-to-proxy auth calls work under
  CSP with no changes.
- `https://*.supabase.co` in `connect-src` is currently harmless to leave in place. It would be
  needed if any non-auth browser-side Supabase calls exist (Realtime, Storage). Remove it only
  during a future hardening pass, after confirming no direct browser-to-supabase.co calls remain.

**No CSP changes are required before or after deploying the proxy.**

---

## 3. Post-Deployment Verification Steps

Execute these steps immediately after the proxy route is deployed to production.

### Step 1 — Proxy health check

```
GET https://geo.flowblinq.com/api/auth/proxy/health
```

Expected: HTTP 200. Response body is the Supabase health JSON (e.g. `{"status":"ok"}`).

Failure mode: HTTP 500 or timeout -> proxy route not deployed, or env vars missing on Vercel.

---

### Step 2 — Network tab check (browser devtools)

1. Open `https://geo.flowblinq.com` in an incognito window.
2. Open DevTools -> Network tab -> filter by XHR/Fetch.
3. Reload or initiate sign-in.
4. Confirm auth API calls go to `geo.flowblinq.com/api/auth/proxy/*`, NOT `*.supabase.co`.

What to look for:
- `GET /api/auth/proxy/user` — session validation on page load
- `POST /api/auth/proxy/token` — token exchange or refresh

Failure mode: Calls still going to `*.supabase.co` -> browser client override not deployed.

---

### Step 3 — Authenticated session check

1. Sign in with an existing account.
2. Visit dashboard or any protected page.
3. Confirm the page loads correctly (no auth errors, no redirect back to login).

What this verifies: `getUser()` round-trip works end-to-end through the proxy.

---

### Step 4 — Token refresh check

In a test environment with reduced token expiry (or wait for the natural refresh cycle):

1. Let the access token expire or use a short-expiry test setup.
2. Confirm auto-refresh fires and the session remains active.
3. In Network tab: look for `POST /api/auth/proxy/token?grant_type=refresh_token`.

Failure mode: Session drops after token expiry -> proxy not forwarding token refresh correctly.

---

### Step 5 — Sign-out check

1. Click sign-out.
2. Confirm redirect to login page.
3. In Network tab: confirm `POST /api/auth/proxy/logout` returned 200.

---

### Step 6 — Google OAuth sign-in check

1. Initiate Google OAuth sign-in.
2. Confirm redirect to `accounts.google.com` succeeds.
3. After Google auth, confirm redirect lands at `https://geo.flowblinq.com/auth/callback`.
4. Confirm user lands on `/dashboard` after callback.

Note: OAuth initiation does not contact Supabase from the browser in PKCE flow. The callback
handler (`/auth/callback`) is server-side and unaffected by the proxy. This step is a sanity
check that the existing callback flow is not regressed.

---

### Step 7 — Indian network test (core acceptance criterion)

This is the definitive test for the production blocker.

Options for obtaining an Indian IP:
- VPN with Indian exit node (Jio/Airtel/BSNL IP range)
- BrowserStack with a device located in India
- Indian team member or test user running the flow

Test steps:
1. From Indian IP, load `https://geo.flowblinq.com`.
2. Confirm the page auth check completes without timeout or Supabase connectivity error.
3. Sign in or verify existing session — confirm no errors.
4. If an error occurs, check Network tab to confirm whether the request went to the proxy or
   directly to `*.supabase.co`.

Acceptance criterion: All auth flows work from Indian ISP networks without timeout or
connectivity errors.

---

## 4. Rollback Plan

The proxy introduces no infrastructure changes — it is a single Vercel function route plus a
browser client modification. Rollback is low-risk and fast.

### Rollback triggers

Roll back if any of the following occur post-deployment:

- Auth success rate drops materially (monitor Supabase Dashboard -> Auth -> Logs)
- Users unable to sign in from non-Indian networks (regression on global traffic)
- Proxy health check returns non-200
- Session errors on page load that were not present before deployment

### Rollback steps

**Option A — Revert the two changed files (preferred, clean)**

1. Revert `geo/lib/supabase/client.ts` — remove the custom fetch / proxy rewrite, restore the
   original `createBrowserClient` call.
2. Delete (or revert) `geo/app/api/auth/proxy/[...path]/route.ts`.
3. Deploy to Vercel (push commit or use Vercel dashboard instant rollback to prior deployment).

After rollback: browser auth calls return to contacting `*.supabase.co` directly. Indian users
will be blocked again, but the regression for non-Indian users is resolved.

**Option B — Vercel instant rollback (fastest)**

Vercel Dashboard -> Deployments -> select the last good deployment -> Promote to Production.
Use this if a full redeploy cycle is too slow.

**No Supabase dashboard changes are required during rollback.** The dashboard config (Site URL,
Redirect URLs) is unaffected by whether the proxy is active or not.

---

## 5. T008 Deferral Note

T008 (DMZ architecture formalization) was the pending OpsMaster task prior to this ticket.
It has been deprioritized by CoFounder pending resolution of the TS-007 production blocker.

**Status:** Deferred. Will resume after:
1. OPS-007 proxy deployment is verified stable (Indian network test passes)
2. CoFounder or CostMaster sends explicit resume signal

**T008 scope reminder:** Audit and document isolation zones per ES-004 Task 2. No code changes.
Complexity: small. Reference: `.agents/specs/engineering/ES-004-m2-sprint3-security-and-ops.md`

---

## 6. Infra Runbook Entry — Supabase Proxy Pattern

This proxy pattern is now documented as the standard approach for working around Supabase
endpoint ISP blocks.

**Pattern:** Vercel catch-all API route (`/api/auth/proxy/[...path]`) forwards browser auth
calls server-to-server to Supabase, bypassing ISP-level DNS/TCP blocks on `*.supabase.co`.

**Scope:** Auth API only (`/auth/v1/*`). Database (PostgREST), Realtime, and Storage calls are
not proxied — those do not currently go through the browser client in `geo.flowblinq.com`.

**Key implementation files:**
- `geo/app/api/auth/proxy/[...path]/route.ts` — catch-all proxy handler (new)
- `geo/lib/supabase/client.ts` — browser client with custom fetch override (modified)

**Maintenance notes:**
- If Supabase auth endpoint paths change, update `targetUrl` construction in `route.ts`.
- The browser client override is path-prefix-based — resilient to individual endpoint changes.
- No new Vercel environment variables are required. The proxy reads the existing
  `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

**If block becomes permanent:** Evaluate self-hosting Supabase Auth or migrating to an
alternative provider (Auth.js, Clerk, WorkOS). Track as a separate spec.

**If Realtime or Storage also become blocked:** Extend this proxy pattern to those endpoints,
or route through Vercel Edge. Currently not applicable — those services are not used from
the browser client in `geo.flowblinq.com`.

---

## Summary Checklist

```
PRE-DEPLOYMENT (Supabase Dashboard)
[ ] Site URL = https://geo.flowblinq.com                       (verify, no change expected)
[ ] Redirect URLs includes https://geo.flowblinq.com/auth/callback  (verify, no change expected)
[ ] CORS: no dashboard config needed                           (confirmed — apikey header covers it)
[ ] next.config.ts CSP: no changes needed                     (confirmed — 'self' covers proxy)

POST-DEPLOYMENT (verification)
[ ] GET /api/auth/proxy/health -> 200
[ ] Network tab: auth calls route to /api/auth/proxy/* (not supabase.co)
[ ] Authenticated session loads correctly on dashboard
[ ] Token refresh fires through proxy (check for /api/auth/proxy/token?grant_type=refresh_token)
[ ] Sign-out works (POST /api/auth/proxy/logout -> 200, redirect to login)
[ ] Google OAuth end-to-end still works
[ ] Indian network test passes (Jio / Airtel / BSNL)
```
