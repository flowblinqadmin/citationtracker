# FlowBlinq Citations — citation-tracking microservice

Service at `geo.flowblinq.com/citations` (multi-zone path routing). Teams
create brands, manage prompt lists, and run them across ChatGPT/Perplexity/
Gemini/Claude on a schedule — billed in geo credits. **The run-execution
engine lives IN THIS REPO (`lib/engine/`, ported from geo 2026-07); geo
provides only login, credit purchase, the `/citations` rewrite, and the
shared Postgres.**

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
  Postgres :54322), mirroring production's shared-project model. Apply the same SQL
  files to :54322 once. Playwright seeds its own user/team and signs in through
  @supabase/ssr so the cookies match what the middleware reads. E2E sets
  `E2E_FAKE_PROVIDERS=1` (worker-route seam: deterministic provider stubs) so the
  REAL runner executes with no provider keys or network, and pins
  `CITATIONS_WORKER_BASE` to the dev server so nothing can touch prod.
- The drift test (`lib/db/__tests__/schema-drift.test.ts`) compares the schema mirror
  against whatever TEST_DATABASE_URL points to — point it at prod (read-only) for the
  pre-deploy check.

## The engine (`lib/engine/` — ported from geo, PR194 security fixes included)

- **Worker**: `POST /api/cron/tracker-worker` — auth is QStash `upstash-signature`
  (verified against the exact public URL `${CITATIONS_WORKER_BASE}/api/cron/tracker-worker`)
  OR `Bearer CRON_SECRET` (constant-time). maxDuration 800; the runner pauses
  before `TRACKER_WORKER_DEADLINE_MS` and self-resumes via `lib/engine/enqueue.ts`
  (QStash raw REST, regional `QSTASH_URL`, `Upstash-Retries: 0`). Fatal errors →
  `failRun` + HTTP 200 `{ok:false}` — the scheduler cron's stale recovery is the
  retry path, never QStash retries. Local dev (no QSTASH_TOKEN): direct
  fire-and-forget call with the cron Bearer.
- **Runner** (`runner.ts`): worklist = active prompt versions × platforms,
  filtered by `runs.scope` ({promptVersionIds?, platforms?}, NULL = full;
  empty/unknown scope falls back to full, never empty). team_* orgs run 4
  platforms (`platformsForOrg`) with the anti-hallucination
  `GROUNDED_CITATION_SYSTEM_PROMPT` and Gemini sentiment classification;
  non-team (PCG) runs stay 3-platform, unsteered, unclassified. Zero-citation
  prompts re-run once (both attempts stored). Resume is attempt-aware (R17);
  response+citations insert in one transaction (R28) gated by the
  `tracker_responses_run_pv_platform_attempt_uniq` index; metrics recompute is
  recoverable (R12); errored responses stay out of rate denominators (R04).
- **Scheduler**: hourly `/api/cron/tracker-run` at :45 — due **team** clients
  (never PCG's: their prompts must not burn OUR provider keys), stale-run
  recovery (>2h), and the GLOBAL 12-month response purge (this repo owns the
  shared table's hygiene). DB access via org-scoped helpers in tracker-db.
- **Providers** (`providers.ts`): MODELS pinned; keep in lockstep with geo's
  until its tracker is deleted. Gemini maxOutputTokens gotcha: thinking tokens
  spend the budget first — small caps return empty MAX_TOKENS responses (use
  256+; sentiment uses 256, tracker responses 1024).
- Run trigger: run route debits, inserts `tracker.runs`, publishes to OUR
  worker at `CITATIONS_WORKER_BASE` — the direct vercel.app URL, NEVER the geo
  rewrite (signature verification is exact-URL; geo must not sit in the loop).

## Geo contract (what remains shared)

1. **Auth (cookie issuance)**: login lives on geo; same origin + same Supabase
   project → its session cookie authenticates here (validated locally via
   getUser — geo is not consulted at request time).
2. **Routing**: geo's rewrite proxies `geo.flowblinq.com/citations/*` →
   `citationtracker.vercel.app/citations/*`. Browser traffic only.
3. **Shared Postgres**: `public.teams/team_members/credit_transactions/
   rate_limits` stay geo-owned (credits bought on geo, spent here) — mirror
   those, never migrate them. `tracker.*` DDL is owned by THIS repo going
   forward (geo keeps only historical migrations); mirror + migration + drift
   test travel together. **CHECK constraints don't live in mirrors** — copy
   them into `test-schema.sql` (the responses platform CHECK bit us in prod).
4. **Do NOT use** geo's `/api/tracker/*` CRUD routes — they authorize via
   `tracker.members` rows (the PCG agency's API). This service NEVER creates
   members rows; its users must stay invisible to geo's tracker UI. (Routes
   deleted from geo in the migration's final phase.)
5. **Tenancy bridge**: one `tracker.orgs` row per geo team (id `team_<teamId>`),
   no members rows. Every tracker-table query goes through `lib/tracker-db.ts`
   org scoping — PCG's live data shares these tables. `lib/engine/**` is exempt
   from the grep gate: it is machine-invoked with run/client ids that were
   org-scoped at creation.
6. **Transition window** (until geo's tracker is deleted): geo's :30 cron and
   worker still exist; CRON_SECRET must stay EQUAL across both Vercel projects,
   and the :45/:30 overlap is safe (createScheduledRun idempotent per
   (client, period); donePairs converges double execution). After deletion the
   secrets may diverge.

## Credits & pricing

- Flat 1 credit per prompt PER MODEL (1 credit = $0.10). Full 4-model run of
  1 prompt = 4 credits; 1 prompt × 1 model = 1 credit. Constants in
  `lib/pricing.ts`; a margin test asserts a credit covers the priciest model's
  cost × 1.3 (`MODEL_COST_ESTIMATES` — review quarterly).
- Brand domains are REQUIRED at creation: `isBrandMentioned` returns false
  without a domain (mentions + sentiment dead), and citation stats key on it.
  Citation figures shown in the UI come from `listRunsWithStats` /
  `getRunTopSources` (brand-domain matching over tracker.citations) — stored
  run.metrics citation numbers match a PCG article list this service doesn't
  use and are always 0 here (only brandMentionRate is reused).
- Manual runs debit upfront (402 gate). Scheduled runs are debited post-hoc by
  `/api/cron/reconcile` (balance may go negative → manual runs blocked).
  Failed runs refunded; revived-after-refund runs re-debited.
- Ledger idempotency: `credit_transactions.site_id = runId` with types
  `citation_run` / `citation_run_refund` / `citation_redebit` (geo precedent:
  BB-03 uses site_id for Stripe session ids). Enforced by a partial unique
  index migration.
- Competitors (≤10 name+domain rows, CompetitorEditor on the Overview tab)
  drive Share of AI voice + the competitor table; stats are computed live by
  domain, so past runs light up retroactively when competitors change.

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
| `CRON_SECRET` | Worker + cron auth. Must equal geo's until geo's tracker is deleted |
| `GEO_ORIGIN` | Deployed geo origin (defaults to https://geo.flowblinq.com) |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `PERPLEXITY_API_KEY` / `GEMINI_API_KEY` | Provider keys for the in-repo engine |
| `QSTASH_TOKEN` / `QSTASH_URL` | QStash publish (URL must be the REGIONAL endpoint or publishes 404) |
| `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` | Worker signature verification |
| `CITATIONS_WORKER_BASE` | Public base of THIS service (direct vercel.app URL incl. /citations basePath) |
| `FIRECRAWL_API_KEY` | Citation verification + AI Search scrapes |

Vercel project: `citationtracker` (adithya-raos-projects-ccfb49af).

## Hard rules

- **NEVER commit `.env*` or any secrets.** Scan staged content before commit.
- **NEVER push without explicit user approval.** Run tests first.
- **No migrations for geo-owned `public.*` tables** — mirrors only. `tracker.*`
  DDL now lives here: every change ships mirror + test-schema + migration +
  drift coverage together, applied to prod only at explicitly-approved deploys.
- **All tracker-table access goes through `lib/tracker-db.ts`** (org-scoped).
  No `tracker*` schema imports elsewhere (grep gate in tests; `lib/engine/**`
  exempt by design).
- New API routes: middleware is default-deny — public routes must be added to
  `PUBLIC_PATHS` deliberately and covered in `middleware.test.ts`.
- The scheduler must NEVER start or recover a non-team (PCG) run — their
  prompts on our provider keys is a billing + tenancy breach (test-enforced).
