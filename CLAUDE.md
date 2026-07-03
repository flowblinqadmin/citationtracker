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
npm test             # Vitest (or in Docker: docker build -f Dockerfile.test -t cite-test . && docker run --rm cite-test)
npm run test:e2e     # Playwright (needs local Supabase + Postgres)
npx knip             # unused files/deps/exports — must be clean
```

Node path on this machine: `/opt/homebrew/bin/node`.

## Geo contract (pinned — verify before changing anything here)

This service depends on the DEPLOYED geo app (`GEO_ORIGIN`, default
https://geo.flowblinq.com) and its database. Verified against prod 2026-07-03.

1. **Execution**: `POST {GEO_ORIGIN}/api/tracker/worker` with
   `Authorization: Bearer <CRON_SECRET>` (same secret as geo's Vercel env) and
   body `{runId, clientId, cursor: 0}`. Geo's runner rebuilds the worklist from
   the DB (active prompt versions × 3 platforms), executes, persists
   responses/citations, stores metrics on the run row, and self-resumes long
   runs via geo's QStash.
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

- Flat price per prompt-execution = most-expensive-model cost × 1.3, in geo
  credits (1 credit = $0.10). Constants in `lib/config.ts`
  (`MODEL_COST_ESTIMATES` — review quarterly against provider pricing).
- Manual runs debit upfront (402 gate). Scheduled runs are debited post-hoc by
  `/api/cron/reconcile` (balance may go negative → manual runs blocked).
  Failed runs refunded; revived-after-refund runs re-debited.
- Ledger idempotency: `credit_transactions.site_id = runId` with types
  `citation_run` / `citation_run_refund` / `citation_redebit` (geo precedent:
  BB-03 uses site_id for Stripe session ids). Enforced by a partial unique
  index (the ONE migration this repo ships).

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
