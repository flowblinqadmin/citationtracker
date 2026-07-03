# Production Handoff — Consolidation Branch `consolidation/prod-handoff-2026-06-05`

**Prepared for:** Aditya Netoor (to push to prod)
**Prepared by:** Adithya Rao (ar@flowblinq.com) via Claude consolidation session
**Date:** 2026-06-05
**Base:** `origin/main` @ `d6d22ef`

---

> Architecture & design patterns embodied in this work: see [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md).

## What this branch is
A single additive branch consolidating every piece of genuinely-new (not-yet-in-main)
work from the preview branches created over the last few days. ~60 branches were triaged;
~40 were already fully merged into main (`ahead:0`). The rest were analyzed by per-branch
agents + a governor pass. This branch contains only the **net-new, non-regressive** work.

## Verification status (local — run before push)
| Gate | Result |
|------|--------|
| Docker Vitest baseline (origin/main) | 3880 passed, **1 pre-existing failure**, 77 skipped |
| Docker Vitest after consolidation | **3928 passed, 0 failed, 77 skipped** (282 files) — +48 tests, additive |
| `next build` (host) | **✓ Compiled successfully**, 55/55 static pages generated |
| Clean Vercel-parity build (node:22, `npm ci` + `next build`, tracked-only files) | **✓ PASS** — full route table generated. Caught & fixed an undeclared `better-sqlite3` dep (pipeline-studio reverted). |
| Playwright E2E (`--list`) | **144 tests registered & valid** (incl. new `perf/beacon-mobile-perf.spec.ts`). Full run needs local Supabase — run before deploy (see note 6). |
| Governor no-functionality-lost audit | **SAFE** — all 10 subsumed branches present; exclusions (GMC/otp) verified non-regressive |

The single pre-existing main failure (`UpgradeModal.free-tier.test.tsx`, stale `/pricing`
assertion) is **fixed** in this branch (commit `92ef6dd`). Additivity proven: baseline
3880→3928 passing, the 1 prior failure resolved, **zero new failures**.

> **Push policy:** Do NOT push until all three gates pass locally. Vercel deploys only
> from `main` and only for commits authored by `ar@flowblinq.com` (already set).

---

## Branches SUBSUMED by this branch (archive these after merge)
Each is named in its merge/cherry-pick commit (`Subsumed-Branch:` trailer / `-x` provenance).

| Subsumed branch | How | Commit |
|---|---|---|
| `fix/supabase-getuser-middleware` | merge --no-ff | `a31b8c6` |
| `fix/beacon-mobile-perf` | merge --no-ff | `03e80c5` |
| `fix/middleware-allowlist-crawl-webhook` (+ added test) | merge --no-ff | `3334676`, `dfbb919` |
| `geo-007-recrawl-ledger` | merge --no-ff | `21ea026` |
| `fix/logged-in-audit-autoverify-clean` | merge --no-ff | `e08ddda` |
| `feat/beacon-supabase-edge` | additive port (supabase/functions/) | `dd127af` |
| `fix/ga-pipe-reader-cursor-advance` (+ subsumes `fix/ga-pipe-main-wire-sink-secrets`) | merge --no-ff | `6d7d11e` |
| `feat/ga4-type-aware-sink` | merge --no-ff | `907b745` |
| `ci/ga-pipe-release-workflow` | merge --no-ff | `ea8210b` |
| `cleo-overhaul` (local) — 3 of 8 commits cherry-picked | cherry-pick -x | `b9459df`,`6c10f92`,`12f6c8b` |

### Branches deliberately NOT merged (already in main or would regress)
- `fix/otp-login-consent-uxgap` — all 3 "new" commits are **no-ops already in main**.
- `local-fix/gmc-completion-2026-04-28` — all 9 commits **superseded** by newer main work;
  merging would REVERT main's header-auth / token-expiry / `purchase.id` team_id fixes. **Do not merge.**
- `fix/security-audit-2026-05-27` (hardening already in main), `stripe-promo-codes-upi` (subset),
  `fix/ga-pipe-main-wire-sink-secrets` (subset), `fix-f2-revoked-race`, `dev-sprint-10`,
  `fix/HP-272-consent-ui` (docs-only).
- From `cleo-overhaul`, EXCLUDED (local tooling, not prod): `.claude` config, GMC hero scripts,
  gmc docs/images, cost-model docs (`095bf29`,`72832bc`,`88d810d`,`23f193b`).
- **`cleo-overhaul` `0a8e4b5` pipeline-studio admin panel — cherry-picked then REVERTED** (`e561d2f`).
  It imports an **undeclared native dep `better-sqlite3`** (and `vitest` in app code), which **breaks
  the clean `npm ci` + `next build` Vercel build**. It's also dev-only gated (`notFound` in prod) and
  has zero tests. Held for a follow-up PR with proper dependency management + tests + review. The work
  remains intact on the local `cleo-overhaul` branch.

---

## ⚠️ Items requiring your attention before / right after deploy

1. **Supabase Edge tracking functions** (`supabase/functions/track-collect`, `track-slug`):
   deploy + secrets are infra steps, NOT in this code push. Before flipping clients:
   set `IP_HASH_SECRET`, `PUBLIC_COLLECT_URL`, `GEO_SAMPLE_RATE=1.0`, pick geo vendor
   (Cloudflare or ipinfo.io). Deploy: `supabase functions deploy track-collect track-slug --no-verify-jwt`.
   Run `supabase/functions/_verify/run-all.sh`. Deno tests: `deno test supabase/functions/` (NOT Vitest).

2. **RLS — closes the recurring `rls_disabled_in_public` leak (3-layer guard):**
   - Migration `lib/db/migrations/20260605-enable-rls-all-tables.sql` (idempotent, all public tables).
   - `npm run check:rls` — run against staging+prod; exits non-zero if any public table lacks RLS.
   - `lib/db/rls-migration.test.ts` — build fails if the migration is removed/weakened.
   **Live finding (2026-06-05):** `check:rls` against prod shows **only `pipeline_health_state`**
   currently lacks RLS (added by the May-21 migration without it); the other 23 tables already have
   it. **Action:** apply the migration (or `ALTER TABLE public.pipeline_health_state ENABLE ROW LEVEL
   SECURITY;`) to prod, then confirm `npm run check:rls` prints OK and the Supabase advisor clears.
   Safe: app uses postgres driver + service_role (both bypass RLS); no anon PostgREST data path exists.

3. **Numbered migration 003** (`migrations/003-geo-site-view-missing-cols.sql`): fills a gap in the
   `migrations/` numbered set (001,002,_003_,004,006). Columns already exist in `schema.ts`; idempotent.
   Verify against live `geo_site_view` before applying — prod may already have the columns via `drizzle-kit push`.

4. **pipeline-studio admin panel — NOT in this branch** (reverted, see above). It broke the clean
   Vercel build (undeclared `better-sqlite3`). Needs a follow-up PR adding `better-sqlite3` as a
   proper (optional) dependency, removing the `vitest` import from app code, adding tests, and review.

5. **ga-pipe (C++)** in `api-clients/cpp/` is NOT covered by the Node/Docker Vitest suite —
   gated by its own CMake/ctest via `.github/workflows/ga-pipe-release.yml` (fires only on
   `ga-pipe-v*` tags + cpp PRs, not on branch merge). Recommended follow-up tests:
   Catch2 case for the GA4 Inja `type=="engagement"` conditional; Vitest assertion for the new
   `/api/v1/page_views` fields (`type`, `time_on_page_ms`, `session_id`).

---

## Post-push: archive subsumed remote branches
After this branch is merged to `main` and deployed, archive the subsumed remotes (rename to
`archive/*`). **This mutates the remote — get explicit approval first.** Commands provided in
`docs/consolidation/archive-subsumed-branches.sh` (dry-run by default).
