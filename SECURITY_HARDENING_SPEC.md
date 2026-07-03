# GEO Platform Security Hardening — Full Spec

**Repo:** `C:\Users\adith\My Drive\Claudeled\geo`
**Deployment:** `geo.flowblinq.com` (Vercel Pro)
**Context:** Closed SaaS platform. No public homepage. Every legitimate user arrives via an emailed link. Customer websites' AI files must remain publicly accessible to crawlers. Everything else is a wall.

---

## PHILOSOPHY

This is not a public website. Treat it like a private API with two public-facing exceptions:
1. `/api/serve/*` — customer AI files (must be open to the world, including AI bots)
2. `/sites/[id]` and `/verify/[id]` — report/verify pages accessed via emailed links only

Everything else: **403, no body, no information.**

---

## COMPLETE ROUTE ALLOWLIST

| Route | Access | Why |
|-------|--------|-----|
| `/api/serve/[slug]/llms.txt` | Public, all | Customer AI file — AI crawlers need this |
| `/api/serve/[slug]/llms-full.txt` | Public, all | Customer AI file |
| `/api/serve/[slug]/business.json` | Public, all | Customer AI file |
| `/api/serve/[slug]/schema.json` | Public, all | Customer AI file |
| `/api/serve/[slug]/schema.js` | Public, all | Customer AI file |
| `/sites/[id]` | Public, all | Report page — accessed via emailed link |
| `/verify/[id]` | Public, all | Email verify page — accessed via emailed link |
| `/api/sites/[id]` GET | Bearer token | Polling from report page |
| `/api/sites/[id]/auth` POST | Open (rate limited) | Email gate — needed before token exists |
| `/api/sites/[id]/info` GET | Open (rate limited) | Shows masked email on gate page |
| `/api/sites/[id]/regenerate` POST | Bearer token | Report page action |
| `/api/sites/[id]/verify-domain` POST | Bearer token | Report page action |
| `/api/sites/[id]/verify-connection` POST | Bearer token | Report page action |
| `/api/sites/[id]/verify` POST | Bearer token | Email verification flow |
| `/api/integration-instructions` POST | Bearer token | Report page action |
| `/api/pipeline/run` POST | CRON_SECRET | Internal only — Vercel cron / server |
| `/api/cron/recrawl` GET | CRON_SECRET | Vercel cron only |
| `/api/admin/sites` GET | ADMIN_SECRET | Your admin tooling only |
| `/api/report/[shareToken]` GET | Open (shareToken acts as key) | Public share link |
| `/_next/*` | Open | Next.js internals |
| `/favicon.ico` | Open | Browser default request |
| **EVERYTHING ELSE** | **403, no body** | Wall |

---

## TASK 1 — Create `middleware.ts` (core of everything)

Create `middleware.ts` at the repo root. This runs at the edge before any serverless function.

**Logic:**
```
1. Block malicious UAs → 403
2. Block malicious paths → 403
3. If path is on allowlist → pass through
4. Everything else → 403
```

**Blocked user agents** (50+ patterns):
- Scanners: nikto, sqlmap, nmap, masscan, zgrab, nuclei, acunetix, nessus, openvas, burpsuite, metasploit, w3af, havij
- CMS scanners: wpscan, wpbot, cms-checker, joomscan
- Scrapers: ahrefsbot, semrushbot, mj12bot, dotbot, blexbot, dataforseobot
- Fingerprinters: faviconhash, zgrab, shodan
- Empty user agent (except /api/* and /_next/*)

**Blocked paths** (35+ patterns):
- WordPress: /wp-admin, /wp-login.php, /xmlrpc.php, /wp-json, /wp-config, /wp-content, /wp-includes
- PHP files: any path ending in .php
- Config/secrets: /.env, /.git, /.svn, /.htaccess, /web.config, /.vscode
- DB dumps: *.sql, *.sql.gz, *.bak, *.old, *.orig
- Admin panels: /phpmyadmin, /adminer, /administrator
- Dependency dirs: /node_modules, /vendor, /composer.json, /package.json
- Server metadata: /debug, /server-status, /trace, /.well-known/security.txt

**Allowlist regex patterns** (check after UA/path blocking):
```typescript
const ALWAYS_ALLOWED = [
  /^\/_next\//,
  /^\/favicon\.ico$/,
  /^\/api\/serve\//,              // customer AI files — fully open
  /^\/api\/report\//,             // public share reports
  /^\/sites\/[^/]+$/,             // /sites/[id]
  /^\/verify\/[^/]+$/,            // /verify/[id]
  /^\/api\/sites\/[^/]+\/auth$/,  // email gate (rate limited in route)
  /^\/api\/sites\/[^/]+\/info$/,  // masked email lookup (rate limited in route)
  /^\/api\/pipeline\/run$/,       // cron — auth handled in route
  /^\/api\/cron\//,               // cron — auth handled in route
  /^\/api\/admin\//,              // admin — auth handled in route
  /^\/api\/sites/,                // all /api/sites/* — auth handled in route
  /^\/api\/integration-instructions$/, // auth handled in route
];
```

If path matches allowlist → NextResponse.next() with security headers.
If nothing matches → `new NextResponse(null, { status: 403 })` — no body, no info.

**Security headers on ALL passing responses:**
```
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Permitted-Cross-Domain-Policies: none
```

NOTE: Do NOT add CSP in middleware — report page uses inline style props. Skip CSP.

**Middleware matcher:**
```typescript
export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
```

---

## TASK 2 — Replace in-memory rate limiting with Upstash Redis

**Install:**
```bash
npm install @upstash/ratelimit @upstash/redis
```

Connect Upstash Redis via Vercel Marketplace → add to geo project → env vars auto-populate.

**Create `lib/geo-rate-limit.ts`:**
```typescript
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

export const ipLimiters = {
  siteCreate:   new Ratelimit({ redis, limiter: Ratelimit.fixedWindow(3,  "1 h"),  prefix: "rl:ip:site-create" }),
  auth:         new Ratelimit({ redis, limiter: Ratelimit.fixedWindow(10, "15 m"), prefix: "rl:ip:auth" }),
  regenerate:   new Ratelimit({ redis, limiter: Ratelimit.fixedWindow(5,  "1 h"),  prefix: "rl:ip:regen" }),
  verifyDomain: new Ratelimit({ redis, limiter: Ratelimit.fixedWindow(10, "15 m"), prefix: "rl:ip:verify-domain" }),
  verifyConn:   new Ratelimit({ redis, limiter: Ratelimit.fixedWindow(10, "15 m"), prefix: "rl:ip:verify-conn" }),
  info:         new Ratelimit({ redis, limiter: Ratelimit.fixedWindow(20, "15 m"), prefix: "rl:ip:info" }),
};

export const emailLimiters = {
  siteCreate: new Ratelimit({ redis, limiter: Ratelimit.fixedWindow(2, "24 h"), prefix: "rl:email:site-create" }),
};

export const siteLimiters = {
  authBrute: new Ratelimit({ redis, limiter: Ratelimit.fixedWindow(5, "15 m"), prefix: "rl:site:auth-brute" }),
};

export function getIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
```

**Usage pattern in every route:**
```typescript
import { ipLimiters, getIp } from "@/lib/geo-rate-limit";

const ip = getIp(req);
const { success } = await ipLimiters.auth.limit(ip);
if (!success) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
```

---

## TASK 3 — Lock down `/api/pipeline/run`

File: `app/api/pipeline/run/route.ts`

Currently: no auth. Anyone can trigger a full Firecrawl + OpenAI pipeline run.

Add at top of handler:
```typescript
const secret = req.headers.get("authorization")?.replace("Bearer ", "")
  ?? req.nextUrl.searchParams.get("secret");

if (!secret || secret !== process.env.CRON_SECRET) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

Only callable by: Vercel Cron (?secret=CRON_SECRET) or internal server fetch (Authorization: Bearer CRON_SECRET).

---

## TASK 4 — Rate limit `/api/sites` POST (site creation)

File: `app/api/sites/route.ts`

After parsing request body, add:
- IP limit: ipLimiters.siteCreate.limit(ip) — 3/hour per IP → 429
- Email limit: emailLimiters.siteCreate.limit(email.toLowerCase()) — 2/24h per email → 429
- URL validation:
```typescript
let parsed: URL;
try { parsed = new URL(url); } catch {
  return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
}
if (!["http:", "https:"].includes(parsed.protocol)) {
  return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
}
const privateRanges = [/^localhost/, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];
if (privateRanges.some(r => r.test(parsed.hostname))) {
  return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
}
```

---

## TASK 5 — Rate limit remaining endpoints

| File | Limiter |
|------|---------|
| `app/api/sites/[id]/auth/route.ts` | ipLimiters.auth (IP) + siteLimiters.authBrute (siteId, on failure) |
| `app/api/sites/[id]/regenerate/route.ts` | ipLimiters.regenerate |
| `app/api/sites/[id]/verify-domain/route.ts` | ipLimiters.verifyDomain |
| `app/api/sites/[id]/verify-connection/route.ts` | ipLimiters.verifyConn |
| `app/api/sites/[id]/info/route.ts` | ipLimiters.info |

Auth brute force detail: after a wrong-email failure, call siteLimiters.authBrute.limit(siteId). On subsequent requests, check this limiter FIRST — if !success, return 429 immediately before any DB lookup. Caps guesses at 5 per site per 15 min.

---

## TASK 6 — Vercel WAF Custom Rules (Dashboard — no code)

Vercel Dashboard → geo.flowblinq.com → Firewall → Configure.
Start all rules in **Log mode for 24h**, then switch to Deny.

**Rule 1 — Pipeline endpoint lockdown**
- If: Path equals /api/pipeline/run OR /api/cron/recrawl
- Then: Rate Limit → Fixed Window, 60s, 10 requests, key by IP
- Persistent: Block 60 minutes

**Rule 2 — API POST rate limit**
- If: Path starts with /api/ AND Method is POST AND Path does NOT start with /api/serve/
- Then: Rate Limit → Fixed Window, 60s, 20 requests, key by IP
- Persistent: Block 15 minutes

**Rule 3 — Block admin externally**
- If: Path starts with /api/admin/ AND source IP NOT in [your known IPs]
- Then: Deny (hard block, no persistent needed)

**Rule 4 — Deny missing User-Agent on API**
- If: Path starts with /api/ AND User-Agent is missing
- Then: Deny

**Rule 5 — Serve endpoint rate limit**
- If: Path starts with /api/serve/
- Then: Rate Limit → Fixed Window, 60s, 60 requests, key by IP
- No persistent — legitimate AI crawlers must not be permanently blocked

---

## TASK 7 — Update `robots.txt`

File: `app/robots.ts`

```typescript
export default function robots() {
  return {
    rules: [
      {
        userAgent: "*",
        disallow: "/",
      },
      {
        userAgent: ["GPTBot", "ChatGPT-User", "ClaudeBot", "PerplexityBot",
                    "OAI-SearchBot", "Googlebot", "Bingbot", "DuckDuckBot"],
        allow: "/api/serve/",
        disallow: "/",
      },
    ],
    host: "https://geo.flowblinq.com",
  };
}
```

---

## TASK 8 — Verify `/api/integration-instructions` hardening

Confirm `app/api/integration-instructions/route.ts` requires Bearer token and pulls slug/domain from DB server-side. Done in previous session — verify and move on.

---

## ENVIRONMENT VARIABLES NEEDED

Add to Vercel dashboard for geo project:
```
UPSTASH_REDIS_REST_URL=        # from Vercel Marketplace Upstash install
UPSTASH_REDIS_REST_TOKEN=      # from Vercel Marketplace Upstash install
```

Already set (verify):
```
CRON_SECRET=    # used for /api/pipeline/run and /api/cron/recrawl
ADMIN_SECRET=   # used for /api/admin/sites
```

---

## COMMIT ORDER

Each task is a separate commit with --author="Adithya Rao <ar@flowblinq.com>":

1. `feat(security): add middleware — allowlist-only routing, block all unknown paths`
2. `feat(security): add Upstash Redis rate limiting — lib/geo-rate-limit.ts`
3. `fix(security): lock down /api/pipeline/run with CRON_SECRET auth`
4. `feat(security): rate limit site creation — IP + email limits + URL validation`
5. `feat(security): rate limit auth, regenerate, verify-domain, verify-connection, info`
6. `feat(security): update robots.txt — disallow all, allow serve/* for AI crawlers only`

After all tasks: write MongoDB handoff `--from [session-id] --to repo --type handoff`.

---

## WHAT THIS ACHIEVES

| Threat | Outcome |
|--------|---------|
| Homepage browse / random probe | 403, no body, no info |
| WordPress/PHP scanner | 403 at edge middleware, zero function cold start cost |
| Credit-burning pipeline attack | Blocked by WAF Rule 1 + CRON_SECRET auth |
| Email bombing site creation | Blocked by Upstash IP + email rate limits |
| Auth brute force on report | 5 attempts per site per 15 min then hard lockout |
| Legitimate customer | Arrives at /sites/[id]?token=... via email, full access |
| AI crawlers (GPTBot etc.) | Hit /api/serve/[slug]/* freely, robots.txt guides them |
| Your Vercel cron jobs | Hit /api/pipeline/run + /api/cron/recrawl with CRON_SECRET |
| Your admin tooling | Hits /api/admin/sites with ADMIN_SECRET |

---

## SUPABASE ADMIN CLIENT SECURITY

### Overview

`lib/supabase/admin.ts` exposes a service-role Supabase client used exclusively during OTP verification to create auth users and generate session tokens server-side. The service role key bypasses all Supabase RLS policies — it must never reach the browser.

### Key constraints

**`SUPABASE_SERVICE_ROLE_KEY` is server-only.**
- Never prefixed `NEXT_PUBLIC_`. Accessing it from a Client Component would expose it in the browser bundle.
- All usage is inside route handlers (`app/api/`) which run on the server only.
- The singleton instance (`_admin`) is module-scoped server memory — not serialized or sent to the client.

**Graceful degradation when key is absent.**
- `getSupabaseAdmin()` returns `null` when `NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` are not set.
- All call sites check the return value: `const admin = getSupabaseAdmin(); if (admin) { ... }`.
- Auth steps are wrapped in try/catch and marked non-fatal — users can still view results via `accessToken` without a Supabase session.
- This allows the build, test suite (Docker), and local dev without the key to complete without errors.

**Required Vercel environment variable:**
```
SUPABASE_SERVICE_ROLE_KEY=<service role JWT from Supabase dashboard>
```
Must be set in the Vercel project settings for production auth to function. Without it, free OTP users will not get a Supabase session and "Upgrade Now" will require re-login.

### verifyOtp token_hash flow

The OTP verify route uses Supabase's `generateLink` API (with `type: "magiclink"` — a Supabase API parameter, NOT a user-facing magic link) to create a one-time session token. No email is sent. Only the `hashed_token` is returned to the client:

```
Server:
  admin.auth.admin.generateLink({ type: "magiclink", email })
  → linkData.properties.hashed_token (a server-computed SHA-256 of the raw token)
  → returned to client as { authOtp: hashed_token }

Client:
  supabase.auth.verifyOtp({ token_hash: authOtp, type: "magiclink" })
  → sets session cookies
```

**What is never exposed:**
- The raw token URL is never returned to the client or logged.
- The `hashed_token` is the value that Supabase verifies server-side — it cannot be reversed to reconstruct the raw token.
- The `accessToken` (site-level auth for polling) is a separate `nanoid(32)` with no Supabase semantics.

**Single-use guarantee:**
- Supabase invalidates the session token after `verifyOtp` is called once.
- A second `verifyOtp` call with the same token returns an error; the route will not attempt to re-generate.
- OTP attempts are capped at 5 per site (DB-backed, survives restarts) — separate from the session token mechanism.

### skipBonus prevents free-tier credit inflation

`ensureTeamForUser(userId, email, { skipBonus: true })` creates the team with `creditBalance: 0`.

This prevents a user from:
1. Submitting a free OTP audit
2. Getting a Supabase session via the `verifyOtp` mechanism
3. Exploiting that session to bypass the paid tier and access credit-consuming features

Free OTP users get a fixed page allotment (`FREE_MAX_PAGES = 20 pages`) baked into the `enqueueStage` call. They have no credit balance to drain and cannot trigger paid-tier pipeline behavior until they purchase credits via Stripe.
