# Beacon Migration — Security Verification Harness

19 integration-level security checks for the Supabase Edge Function migration of
`/api/t/collect` and `/api/t/[slug]` (the "beacon" routes). These tests are the
**must-pass gate** before flipping client traffic from Vercel Fluid to Supabase
Edge per `/Users/adithya/.claude/plans/check-and-ensure-security-snazzy-nest.md`.

This harness lives in `supabase/functions/_verify/` and does NOT collide with
the build agent's shared module directory at `supabase/functions/_shared/`.

## Prerequisites

These checks are **integration-level**. They require:

1. The build agent's `supabase/functions/{_shared,track-collect,track-slug}/`
   modules to exist and be deployable.
2. Either:
   - A locally running Supabase project: `supabase start && supabase functions serve track-collect && supabase functions serve track-slug`, OR
   - A staging-deployed Edge Function endpoint.
3. `psql` on `$PATH` for DB-state checks (#18).
4. `curl` on `$PATH` (every HTTP check).
5. `supabase` CLI on `$PATH` and authenticated (#2 only).
6. `node` and `pnpm`/`npm` on `$PATH` (#19 — runs `node scripts/check-runtime-policy.ts`).
7. `git`, `grep`, `find` on `$PATH` (source-grep checks #1, #6, #17).

## Required environment variables

| Var | Used by | Description |
|---|---|---|
| `SUPABASE_URL` | 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17 | Edge Function root, e.g. `http://127.0.0.1:54321` for local or `https://<ref>.supabase.co` for staging |
| `SUPABASE_DB_URL` | 18 | Postgres URL for DB-state assertions, e.g. `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| `SUPABASE_PROJECT_REF` | 2 | Project ref slug for `supabase secrets list --project-ref <ref>` |
| `TEST_SLUG` | 14, 16, 17 | Slug present in `geo_sites` for the staging/local env. Defaults to `verify-test` |
| `REPO_ROOT` | 1, 6, 17, 19 | Path to the `geo` repo root. Defaults to two parents up from `_verify/` |

## How to run

```bash
# Full run (recommended path before flip):
export SUPABASE_URL=http://127.0.0.1:54321
export SUPABASE_DB_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres'
export SUPABASE_PROJECT_REF=your-ref
export TEST_SLUG=verify-test
cd supabase/functions/_verify
./run-all.sh
```

Run a single check:

```bash
./checks/14-slug-rate-limit.sh
```

## Exit codes

Each check uses these conventions:

- `0` — PASS
- `1` — FAIL (real test failure — the migration is NOT safe to ship)
- `2` — SKIP (precondition unmet, e.g. env var missing, script not built yet).
  Reported but does not block.

`run-all.sh` aggregates: it prints a summary and exits 0 only if all
non-skipped checks pass.

## What each check covers

| # | Check | Spec line |
|---|---|---|
| 1 | No service-role import in beacon source | sec-verify #1 |
| 2 | `supabase secrets list` shows expected secrets only | sec-verify #2 |
| 3 | `verify_jwt = false` for track-collect and track-slug only | sec-verify #3 |
| 4 | CORS allowlist echoes allowed origin + credentials | sec-verify #4 |
| 5 | CORS rejects untrusted origin (no credentials) | sec-verify #5 |
| 6 | Log statements never write raw IP / full UA at info level | sec-verify #6 |
| 7 | Method restriction — GET on track-collect → 405 | sec-verify #7 |
| 8 | Body cap — Content-Length > 8KB → 413 | sec-verify #8 |
| 9 | Flat-object guard — nested props → `event_props = null` | sec-verify #9 |
| 10 | Props key limit — 51 keys → `event_props = null` | sec-verify #10 |
| 11 | Type enum coercion — `<script>` → `pageview` | sec-verify #11 |
| 12 | UTM try/catch — malformed URL → utm_* null, no 500 | sec-verify #12 |
| 13 | Field truncation — 5000-char `u` → stored as 2048 | sec-verify #13 |
| 14 | track-slug rate limit — 110/min → last 10 are 429 | sec-verify #14 |
| 15 | Rate-limit isolation — `slug-serve:` and `beacon:` keys independent | sec-verify #15 |
| 16 | Malicious UA block — sqlmap on track-slug → 403 | sec-verify #16 |
| 17 | No hardcoded `geo.flowblinq.com/api/t/collect` in emitted JS | sec-verify #17 |
| 18 | `ip_hash` column written — 64 hex chars, non-null | sec-verify #18 |
| 19 | Runtime-policy CI script passes | sec-verify #19 |

## Idempotency

All checks clean up after themselves where possible:
- Rate-limit checks wait for the 60s window to reset before exit.
- DB state checks only SELECT; they don't mutate.
- Beacon POST inserts are tagged with a `props.test_run` value so cleanup is grep-able.

To purge test rows from the DB:

```sql
DELETE FROM geo_page_views WHERE event_props->>'test_run' = '_verify-harness';
DELETE FROM rate_limits WHERE key LIKE 'beacon:%' OR key LIKE 'slug-serve:%';
```

## Caveats

- These tests assume the build agent has shipped at least commit #10 (per the plan's incremental commit list — `_shared/*` ports complete, both handler `index.ts` files present). If run earlier, most checks will SKIP or fail with connection-refused.
- Tests are intentionally **integration-level**. Unit tests for individual ported controls live alongside the build agent's modules at `supabase/functions/_shared/__tests__/`.
- Check #19 will SKIP until commit #14 (the build agent's later phase) lands `scripts/check-runtime-policy.ts`.
- Check #5 (CORS rejection) is server-side only — the harness verifies the
  response headers; the actual browser-level block is a manual DevTools step
  documented in the plan.
