# geo — GEO Audit Platform

## Commands

```bash
# Dev
npm run dev          # Next.js dev server (localhost:3000)
npm run build        # Production build
npm run lint         # ESLint

# Tests (ALWAYS use Docker — node v25 breaks Vitest)
docker build -f Dockerfile.test -t geo-test .
docker run --rm geo-test          # Run full test suite (1041 tests)

# E2E tests (Playwright — requires dev server running or auto-starts)
npx playwright test               # Runs against localhost:3000

# DB migrations
npx drizzle-kit push              # Push schema to dev DB
```

## Git / Deploy

```bash
# REQUIRED before every commit — Vercel only deploys commits by ar@flowblinq.com
git config user.email "ar@flowblinq.com"
git config user.name "Adithya Rao"

# Set remote with token before pushing (token in .github_token)
git remote set-url origin "https://flowblinqadmin:<token>@github.com/flowblinqadmin/geo.git"
```

- Deploys only from `main` — feature branches don't auto-deploy
- Vercel team: `team_WTotc3kUUfsSAG6qpDyf8Eig` / project: `prj_XNVFZw5w9fheh30LBpGmu3pSceM0`

## Stack

- Next.js 15 App Router, Drizzle ORM, Supabase auth, Stripe, QStash
- Crawler: Firecrawl only (Jina/Apify removed). Discovery uses `mapUrl`, crawl uses batch jobs with polling. Job IDs in `crawlJobIds` column for cross-invocation resume.
- DB driver: `postgres` (not `@neondatabase/serverless`)
- Tests: Vitest inside Docker (`Dockerfile.test`) + Playwright E2E (`e2e/`)

## Environment

| File | Purpose |
|------|---------|
| `.env.local` | Dev — local Postgres on port 5432 |
| `.env.vercel-prod` | Prod DB URL (`DATABASE_URL_UNPOOLED`) |
| `.github_token` | GitHub PAT for push (`GITHUB_TOKEN=ghp_...`) |

## Key Files

| Path | Purpose |
|------|---------|
| `lib/qstash.ts` | QStash client + `enqueueStage()` helper |
| `app/api/pipeline/stage/route.ts` | 7-stage pipeline handler (discover→assemble) |
| `middleware.ts` | Allowlist-only routing — new API routes MUST be added to `ALWAYS_ALLOWED` or they get 403 in prod |
| `lib/db/schema.ts` | Drizzle schema — `geoSites` (incl. `batchId`, `otpAttempts`, `crawlJobIds`), `teams`, `creditTransactions`, `rateLimits` |
| `lib/rate-limit.ts` | Rate limiting — OTP brute-force (DB columns on `geoSites`) + IP rate limits (`rate_limits` table) |
| `app/api/auth/proxy/[...path]/route.ts` | Supabase auth proxy — required because `*.supabase.co` is blocked by Indian ISPs |
| `lib/config.ts` | All magic numbers (FREE_MAX_PAGES, PAID_MAX_PAGES, FREE_AUDIT_LIMIT, subscription tiers, per-action credits) |
| `COST_MODEL.md` | Full cost model: tiers, credit system, per-stage API calls, models, token counts |
| `app/components/UpgradeModal.tsx` | Shared upgrade modal — used by `BuyCreditsButton` + `ResultsDashboard` |
| `lib/supabase/admin.ts` | Supabase admin client (service role key) — user creation, session tokens |
| `lib/services/provision-team.ts` | Shared team provisioning — used by OTP verify + OAuth callback |
| `e2e/auth-flow.spec.ts` | Playwright E2E: verify OTP → upgrade → Stripe flow |
| `e2e/helpers/db.ts` | E2E helpers: create test sites with known OTP |

## Auth & User Flow

Two entry paths:

1. **Free audit (OTP verify)** — User enters domain + email → gets 6-digit OTP → verifies at `/verify/[id]`
   - Server: creates Supabase user (admin API), provisions team with **0 credits** (`skipBonus: true`)
   - Server exchanges `hashed_token` for session tokens by calling GoTrue `/auth/v1/verify` directly, returns `access_token` + `refresh_token`
   - Client: calls `supabase.auth.setSession()` with the returned tokens (old `verifyOtp()` approach silently failed through auth proxy)
   - Client uses `router.replace` (not `push`) to prevent back-navigation to OTP page
   - Free users get `FREE_MAX_PAGES` (20 pages) — NOT credits. No signup bonus.
   - **Free audit limit**: 2 free audits per email (distinct domains), configured via `FREE_AUDIT_LIMIT` in `lib/config.ts`
   - Site gets `accessToken` stored in sessionStorage for results page access

2. **OAuth callback** — User signs in via Google OAuth → `/auth/callback`
   - Calls `ensureTeamForUser()` with default options → gets `SIGNUP_BONUS_CREDITS` (20 credits)
   - Paid users: credits determine `maxPages` via `PAGES_PER_CREDIT`

**Credit model:**
- Free tier: 0 credits, 20 pages max per audit, max 2 free audits per email
- Paid tier (credits > 0): credits × `PAGES_PER_CREDIT`, capped at `ABSOLUTE_MAX_PAGES`, unlimited audits
- Upgrade: UpgradeModal (variable 1-50 packs) → POST `/api/checkout?quantity=N` → Stripe → webhook reads `creditPacks` from session metadata → adds credits

**Auth proxy:** Supabase is blocked in India (Airtel, Jio, BSNL). All browser Supabase auth calls are proxied through `/api/auth/proxy/[...path]` (Vercel → Supabase). The client config in `lib/supabase/client.ts` intercepts auth requests and reroutes them. Note: server-side OTP token exchange calls GoTrue directly (not through proxy).

**Bulk audits:** CSV upload creates multiple sites sharing a `batchId` (nanoid). The verify route queries siblings by `batchId` — NOT by `verificationCode` (which gets cleared after verification). Credits are reserved per-site in a transaction with reconciliation after crawl.

**Data isolation:** Sites are linked to teams via `teamId`. `accessToken` in sessionStorage grants read access. Supabase session required for checkout/upgrade.

## Local Supabase (E2E Testing)

E2E tests run against a local Supabase instance. OTP emails are captured by Mailpit (no real emails sent).

**Prerequisites:** Docker + `brew install supabase/tap/supabase`

**Setup:**
```bash
supabase start                    # Start local Supabase (first run pulls images)
npm run db:push:local             # Push Drizzle schema to local DB
```

**Ports:**
| Service | Port | URL |
|---------|------|-----|
| API (GoTrue) | 54321 | http://127.0.0.1:54321 |
| Postgres | 54322 | postgresql://postgres:postgres@127.0.0.1:54322/postgres |
| Studio | 54323 | http://127.0.0.1:54323 |
| Mailpit (email) | 54324 | http://127.0.0.1:54324 |

**Running E2E tests:**
```bash
supabase start && npm run db:push:local   # Ensure local Supabase is up
npm run test:e2e                           # Playwright runs against local Supabase
```

**Switching local ↔ remote:** Playwright config auto-sets local Supabase env vars. The dev server started by Playwright uses local Supabase. Your standalone `npm run dev` still uses `.env.local` (remote Supabase).

**Keys:** `.env.local.supabase` contains well-known default keys (safe to commit). Copy to `.env.local` to use local Supabase for manual dev.

## HARD RULES — Never violate these

- **NEVER commit or stage `.env*`, `.github_token`, or any file containing secrets/credentials.** Before every `git add`, verify no env files are included. If a secret is accidentally staged, run `git reset HEAD <file>` immediately — do not push.
- **NEVER push without explicit user approval** — always run Docker tests first.
- **ALWAYS run tests before committing**: `docker run --rm geo-test`. If tests fail, fix before committing.
- **Vercel env vars must be updated manually via the Vercel dashboard.** Never assume CLI access. Set `DATABASE_URL`, `QSTASH_TOKEN`, and any new vars through the UI, then redeploy.
- **Supabase connections**: distinguish pooler (port 6543, `DATABASE_URL` with `?pgbouncer=true`) vs direct (port 5432, `DATABASE_URL_UNPOOLED`). Migrations and one-off scripts use direct. App runtime uses pooler. Confirm which one before running any DB command.
- **Read actual code before proposing changes.** Check the relevant files in `app/api/`, `lib/`, and `lib/db/schema.ts` before suggesting architecture or schema changes.

## Gotchas

- **Node path**: Use `/opt/homebrew/bin/node` — `node` is not in PATH in this shell
- **Tests must use Docker**: `docker run --rm geo-test` — do not run `npx vitest` directly
- **QSTASH_TOKEN missing in Vercel**: Must be added manually before pipeline works in prod
- **`after()` removed**: Pipeline now uses QStash `enqueueStage()`, not Next.js `after()`
- **Middleware allowlist**: All new API routes MUST be added to `ALWAYS_ALLOWED` in `middleware.ts` + test in `middleware.test.ts`. Missing entry = silent 403 in production (already happened once — commit `f848f7b`)
- **Rate limiting is DB-persisted** (not in-memory). Vercel cold starts reset in-memory Maps, allowing bypass across instances. OTP attempts on `geoSites` columns, IP limits in `rate_limits` table.
- **Pipeline circuit breakers**: Firecrawl poll has 20-min timeout (fails the audit). Poll uses exponential backoff (30s base, 1.4x, capped 5 min). Cron safety-net re-enqueues stale sites at current stage. QStash retries = 0.
- **Toast position**: Bottom-right (configured in `app/layout.tsx`)
- **Back button**: Verify page and home page use `router.replace` to prevent navigating back to OTP page
- **Stripe webhooks on localhost**: Requires `stripe listen --forward-to localhost:3000/api/webhooks/stripe`. Set `STRIPE_WEBHOOK_SECRET` in `.env.local` to the `whsec_...` value it prints.
- **Middleware token refresh**: `getSession()` MUST be called before extracting JWT claims. It handles token refresh via `refresh_token`. If you extract claims first and the access token is expired, you get 401 on all authenticated routes. The fix is in `lib/supabase/middleware.ts`.
- **Payment redirect refresh**: After Stripe redirects back with `?payment=success`, the dashboard uses `router.refresh()` (server component re-fetch) and the results page uses a direct `fetch()` call to re-fetch site data (because `poll()` returns early when pipeline is already complete).

<!-- VERCEL BEST PRACTICES START -->
## Best practices for developing on Vercel

These defaults are optimized for AI coding agents (and humans) working on apps that deploy to Vercel.

- Treat Vercel Functions as stateless + ephemeral (no durable RAM/FS, no background daemons), use Blob or marketplace integrations for preserving state
- Edge Functions (standalone) are deprecated; prefer Vercel Functions
- Don't start new projects on Vercel KV/Postgres (both discontinued); use Marketplace Redis/Postgres instead
- Store secrets in Vercel Env Variables; not in git or `NEXT_PUBLIC_*`
- Provision Marketplace native integrations with `vercel integration add` (CI/agent-friendly)
- Sync env + project settings with `vercel env pull` / `vercel pull` when you need local/offline parity
- Use `waitUntil` for post-response work; avoid the deprecated Function `context` parameter
- Set Function regions near your primary data source; avoid cross-region DB/service roundtrips
- Tune Fluid Compute knobs (e.g., `maxDuration`, memory/CPU) for long I/O-heavy calls (LLMs, APIs)
- Use Runtime Cache for fast **regional** caching + tag invalidation (don't treat it as global KV)
- Use Cron Jobs for schedules; cron runs in UTC and triggers your production URL via HTTP GET
- Use Vercel Blob for uploads/media; Use Edge Config for small, globally-read config
- If Enable Deployment Protection is enabled, use a bypass secret to directly access them
- Add OpenTelemetry via `@vercel/otel` on Node; don't expect OTEL support on the Edge runtime
- Enable Web Analytics + Speed Insights early
- Use AI Gateway for model routing, set AI_GATEWAY_API_KEY, using a model string (e.g. 'anthropic/claude-sonnet-4.6'), Gateway is already default in AI SDK
  needed. Always curl https://ai-gateway.vercel.sh/v1/models first; never trust model IDs from memory
- For durable agent loops or untrusted code: use Workflow (pause/resume/state) + Sandbox; use Vercel MCP for secure infra access
<!-- VERCEL BEST PRACTICES END -->
