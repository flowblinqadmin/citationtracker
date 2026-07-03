# FlowBlinq Citations — citation-tracking microservice

Thin service at `geo.flowblinq.com/citations` (multi-zone path routing). Teams
create brands, manage prompt lists, and run them across GPT/Perplexity/Gemini
on a schedule — billed in geo credits. **The deployed geo service + shared
Postgres are the backend; this repo copies no backend logic.**

## Commands

```bash
npm run dev          # Next.js dev server
npm run typecheck    # tsc --noEmit — the real type gate (build ignores errors)
npm run lint         # ESLint
npm test             # Vitest — DB-backed tests need TEST_DATABASE_URL (see below)
npm run test:e2e     # Playwright — needs geo's local Supabase running (see below)
npx knip             # unused files/deps/exports — must be clean
```

Node path on this machine: `/opt/homebrew/bin/node`.

### Test databases

- **Unit/DB suite**: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/postgres npm test`.
  Bring one up with `docker run -d --name cite-test-pg -e POSTGRES_PASSWORD=postgres -p 54329:5432 postgres:16-alpine`,
  then apply `lib/db/test-schema.sql` + `lib/db/migrations/*.sql` with psql. Without
  TEST_DATABASE_URL the DB-backed tests skip (calculator/middleware/gate tests still run).
- **E2E**: uses **geo's local Supabase stack** (`supabase start` in ../geo — GoTrue :54321,
  Postgres :54322), mirroring production's shared-project model. Apply the same two SQL
  files to :54322 once. Playwright seeds its own user/team and signs in through
  @supabase/ssr so the cookies match what the middleware reads.
- The drift test (`lib/db/__tests__/schema-drift.test.ts`) compares the schema mirror
  against whatever TEST_DATABASE_URL points to — point it at prod (read-only) for the
  pre-deploy check.

## Geo contract (pinned — verify before changing anything here)

This service depends on the DEPLOYED geo app (`GEO_ORIGIN`, default
https://geo.flowblinq.com) and its database. Verified against prod 2026-07-03.

1. **Execution**: `POST {GEO_ORIGIN}/api/tracker/worker` with
   `Authorization: Bearer <CRON_SECRET>` (same secret as geo's Vercel env) and
   body `{runId, clientId, cursor: 0}`. Geo's runner rebuilds the worklist from
   the DB (active prompt versions × 3 platforms), FILTERED by `runs.scope`
   ({promptVersionIds?, platforms?}, NULL = full — geo migration
   20260703-tracker-run-scope-sentiment; empty/unknown scope values fall back
   to full, never empty). It executes, persists responses/citations (with
   `responses.sentiment` classified via Gemini for team_* orgs when the brand
   is mentioned), stores metrics on the run row, and self-resumes long runs
   via geo's QStash. Scoped runs REQUIRE that geo deploy to be live — an old
   runner ignores scope and executes the full worklist while we billed a
   subset.
2. **Scheduling**: geo's hourly cron (`/api/cron/tracker-run`) auto-creates and
   enqueues scheduled runs for ANY `tracker.clients` row with
   `run_frequency != 'manual'` and a due `next_run_at`, and recovers stale runs.
   This service never calls it — it just sets those columns.
3. **Tables** (shared DB): `tracker.orgs/clients/prompts/prompt_versions/runs/
   responses/citations` + `public.teams/team_members/credit_transactions/
   rate_limits`. Declarations in `lib/db/schema.ts` are MIRRORS — geo owns the
   tables; this repo never emits migrations for them. A geo tracker migration
   must be mirrored here (schema-drift test enforces).
4. **Do NOT use** geo's `/api/tracker/*` CRUD routes — they authorize via
   `tracker.members` rows (the PCG agency's API). This service NEVER creates
   members rows; its users must stay invisible to geo's tracker UI.
5. **Tenancy bridge**: one `tracker.orgs` row per geo team (id `team_<teamId>`),
   no members rows. Every tracker-table query goes through `lib/tracker-db.ts`
   org scoping — PCG's live data shares these tables.

## Credits & pricing

- Flat 1 credit per prompt PER MODEL (1 credit = $0.10). Full 3-model run of
  1 prompt = 3 credits; 1 prompt × 1 model = 1 credit. Constants in
  `lib/pricing.ts`; a margin test asserts a credit covers the priciest model's
  cost × 1.3 (`MODEL_COST_ESTIMATES` — review quarterly).
- Brand domains are REQUIRED at creation: geo's `isBrandMentioned` returns
  false without a domain (mentions + sentiment dead), and citation stats key
  on it. Citation figures shown in the UI come from `listRunsWithStats` /
  `getRunTopDomains` (brand-domain matching over tracker.citations) — geo's
  stored run.metrics citation numbers match a PCG article list this service
  doesn't use and are always 0 here (only brandMentionRate is reused).
- Manual runs debit upfront (402 gate). Scheduled runs are debited post-hoc by
  `/api/cron/reconcile` (balance may go negative → manual runs blocked).
  Failed runs refunded; revived-after-refund runs re-debited.
- Ledger idempotency: `credit_transactions.site_id = runId` with types
  `citation_run` / `citation_run_refund` / `citation_redebit` (geo precedent:
  BB-03 uses site_id for Stripe session ids). Enforced by a partial unique
  index (the ONE migration this repo ships).

## Citation verification (hallucination guard)

Every team-org citation gets a permanent verdict in `citation_checks` (owned
by THIS service): `verified` (live + brand mentioned) / `no_mention` (live,
brand absent — hallucinated relevance) / `dead` / `unverifiable`. Hourly cron
`/api/cron/verify-citations`: SSRF-guarded direct fetch (visible-text keyword
match, tags/hrefs stripped; bot-block statuses 401/403/407/429/451 are NOT
dead) → unsettled verdicts escalate to a Firecrawl scrape (renders JS, passes
bot walls; markdown matched with link targets stripped). `FIRECRAWL_API_KEY`
in Vercel env (from geo's account). UI: dead links dropped, `no_mention`
badged, per-model attribution on top cited pages.

## AI Search (Google AI Overview)

Hourly cron `/api/cron/ai-search`: each active team prompt is run as a Google
query via a Firecrawl SERP scrape; `lib/ai-search.ts` parses the AI Overview
block (line-start "AI Overview" heading only — the "not available" banner and
inline phrases must not match), brand mention (visible text), and cited
sources. Snapshots in `ai_search_snapshots` (service-owned), re-checked
daily; latest per prompt is served at `/api/brands/[id]/ai-search` and shown
in the Overview panel.

## Auth

Login lives on geo. Same origin (path routing) → the shared Supabase session
cookie authenticates here. `middleware.ts` is default-deny: static + /api/cron/*
skip the session; every other API 401s and every page redirects to geo login
without one. Identity flows via x-user-id/x-user-email headers stamped by
`lib/supabase/middleware.ts` (verified via getUser, never getSession.user).
Keep `@supabase/*` versions in lockstep with geo (cookie format).

## Env

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Shared Supabase Postgres (pooler, port 6543) |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same Supabase project as geo |
| `CRON_SECRET` | MUST equal geo's (worker auth + own cron). Rotating it = update both Vercel projects |
| `GEO_ORIGIN` | Deployed geo origin (defaults to https://geo.flowblinq.com) |

Vercel project: `citationtracker` (adithya-raos-projects-ccfb49af).

## Hard rules

- **NEVER commit `.env*` or any secrets.** Scan staged content before commit.
- **NEVER push without explicit user approval.** Run tests first.
- **No migrations for geo-owned tables** — mirrors only.
- **All tracker-table access goes through `lib/tracker-db.ts`** (org-scoped).
  No `tracker*` schema imports elsewhere (grep gate in tests).
- New API routes: middleware is default-deny — public routes must be added to
  `PUBLIC_PATHS` deliberately and covered in `middleware.test.ts`.
