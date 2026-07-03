# Local / E2E test environment (integration review 2026-06-09, #5 — env hygiene)

**Problem this addresses:** test vs live keys were split across `.env` (test Stripe `sk_test_` / valid Firecrawl) and `.env.local` (LIVE `sk_live_` Stripe / dead Firecrawl), with the **live** key as the default-loaded value. That's risky — a local checkout test can hit live Stripe and create real objects/charges. (`.env*` files are never committed, so this lives in docs.)

**Rule:** for local/E2E runs, launch the dev server + tests with **test-mode** values explicitly; never let a `sk_live_` key be the one the dev server loads.

## Required values for a full local run

| Var | Value | Notes |
|-----|-------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | `http://127.0.0.1:54321` | local Supabase |
| `SUPABASE_DATABASE_URL` / `DATABASE_URL` | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` | highest-priority key forces local DB |
| `SUPABASE_SERVICE_ROLE_KEY` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | well-known supabase-demo local keys | safe (in `playwright.config.ts`) |
| `STRIPE_SECRET_KEY` | **`sk_test_…`** — never `sk_live_` | a real test key exists in `.env` |
| `STRIPE_WEBHOOK_SECRET` | a test value | `billing-lifecycle.spec.ts` signs against it |
| `STRIPE_*_PRICE_ID` | test-mode price IDs | **absent today** — needed for subscription-checkout E2E |
| `FIRECRAWL_API_KEY` | a **valid** key | crawl can't run without it (the `.env.local` one is dead) |
| `LOCAL_PIPELINE=1` + `PIPELINE_CALLBACK_URL=http://localhost:3000` + `CRON_SECRET` (≥32 chars) | run the pipeline locally without a QStash tunnel (poll-first, #1) |
| `LLM_LOCAL=1` + `LLM_BASE_URL=http://localhost:4321/v1` | route OpenAI-compatible LLM calls to local LM Studio (#2) |

## Recommended fix (follow-up)
- Add a `scripts/dev/with-test-env.sh` wrapper that sources a gitignored `.env.test` (test keys only) and refuses to start if `STRIPE_SECRET_KEY` begins with `sk_live_`.
- Add test-mode Stripe price IDs so the subscription-upgrade browser E2E (`upgrade-modal-pricing`, `auth-flow:43`) can pass instead of being blocked.
