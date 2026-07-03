# Consolidation Plan — Production Handoff (2026-06-05)

**Goal:** Consolidate all preview branches' genuinely-new work onto one branch
(`consolidation/prod-handoff-2026-06-05`, based on latest `origin/main`) for handoff to
Aditya Netoor to push to prod. Merge must be **additive** (no work lost, no anti-patterns),
with unit + integration + functional **tests written BEFORE each merge** and passing after.

## Hard constraints (from the directive + repo memory)
- New work lives only on `consolidation/prod-handoff-2026-06-05`.
- Nothing pushed to remote without (a) local Docker Vitest + `next build` + Playwright passing,
  and (b) explicit user approval.
- Every merge commit names the subsumed branch.
- Subsumed remote branches archived (renamed `archive/<name>`) only **after** the merge lands.
- Governor agents verify no functionality is dropped.

## Branch triage (patch-id verified — SHA-ahead ≠ content-new)

### IN SCOPE — genuinely-new work
| Group | Branch | True new commits | Notes |
|---|---|---|---|
| A | `feat/beacon-supabase-edge` | 23 | New `supabase/functions/` (track-collect, track-slug) + `_shared`. Purely additive (dir absent in main). |
| A | `fix/otp-login-consent-uxgap` | 3 of 7 | Only Stripe-promo-codes / `/pricing` removal / e2e are new; `/pricing` page **already gone** in main → verify each commit isn't already redundant. |
| A | `geo-007-recrawl-ledger` | 1 | Scheduled recrawl + ledger credit spend (cron). |
| A | `fix/supabase-getuser-middleware` | 1 | Forward `getUser()`-verified identity in middleware. |
| A | `fix/middleware-allowlist-crawl-webhook` | 1 | Allow-list `/api/pipeline/crawl-webhook` (was 403). Jun 4. |
| A | `fix/logged-in-audit-autoverify-clean` | 1 | Auto-verify logged-in audits + tier-gated per-audit pages. |
| A | `fix/beacon-mobile-perf` | 1 | Mobile main-thread jank fix (current pushed branch). |
| B | `fix/ga-pipe-reader-cursor-advance` | 3 | ES-088 C++ ga-pipe fixes in `api-clients/cpp/` (isolated; main never touches → low risk). Supersets `fix/ga-pipe-main-wire-sink-secrets`. |
| B | `feat/ga4-type-aware-sink` | 1 | GA4 type-aware sink. |
| B | `ci/ga-pipe-release-workflow` | 1 | GitHub Actions cross-platform binary release. |
| C | `local-fix/gmc-completion-2026-04-28` | 9 | GMC PDF branding v3.1 + audit_purchase pipeline wiring. Touches audit_purchase → verify vs main's evolution. |
| D | `cleo-overhaul` (local) | 8 | pipeline-studio admin panel, DB migration 003, GMC hero gen. Local-only, never preview-deployed. |

### OUT OF SCOPE — already in main or redundant
- `fix/security-audit-2026-05-27` — hardening already in main (only a deploy-retrigger chore remains).
- `stripe-promo-codes-upi` — subset of `fix/otp-login-consent-uxgap`.
- `fix/ga-pipe-main-wire-sink-secrets` — subset of `fix/ga-pipe-reader-cursor-advance`.
- `fix-f2-revoked-race`, `dev-sprint-10` — March test-isolation tweaks, far behind.
- `fix/HP-272-consent-ui` — docs spec draft only.
- ~40 branches with `ahead:0` — fully subsumed by main already.

## Plus: recurring Supabase RLS vuln
`rls_disabled_in_public` on prod project `mkwjqntnlmogwjqxezqw` — enable RLS on all public
tables + bake into migrations. Tracked as Phase 3b. (memory: `project_supabase_rls_recurring.md`)

## Execution phases
0. **Discovery & true-delta map** — DONE.
1. **Per-branch deep analysis + governor completeness pass** (multi-agent, read-only).
2. **Sequence merges; write tests AHEAD of each merge** — isolated dirs first (ga-pipe, supabase/functions), riskiest last (GMC/audit_purchase, cleo migration).
3. **Execute additive merges** — tests pass after each; commits name subsumed branch. + Phase 3b RLS fix.
4. **Final governor audit + full Docker Vitest + `next build` + Playwright + handoff doc.** No push w/o approval.

## FINAL MERGE DECISIONS (post Phase-1 multi-agent analysis + governor)

### SKIP — already in main or would regress (verified)
- `fix/otp-login-consent-uxgap` — **all 3 "new" commits are no-ops already in main** (Stripe promo, /pricing removal, e2e spec all present byte-for-byte). Skip.
- `local-fix/gmc-completion-2026-04-28` — **all 9 commits superseded by newer main work**; merging would REVERT main's header-auth, 30-day token-expiry, and `purchase.id` team_id fixes. **Do not merge** (regression risk). Archive.
- `fix/security-audit-2026-05-27`, `stripe-promo-codes-upi`, `fix/ga-pipe-main-wire-sink-secrets` (subset of reader-cursor-advance), `fix-f2-revoked-race`, `dev-sprint-10`, `fix/HP-272-consent-ui`.

### MERGE — in this order (risk-sequenced; tests land with/before each)
1. **`fix/supabase-getuser-middleware`** — auth foundation FIRST (other branches depend on getUser pattern). Ships 2 new test files + fitness function. Medium risk (core auth) → full suite after.
2. **`fix/beacon-mobile-perf`** — isolated, ships unit + perf-e2e tests. Clean.
3. **`fix/middleware-allowlist-crawl-webhook`** — 1 line; **ADD missing middleware test** (governance gap) before commit.
4. **`geo-007-recrawl-ledger`** — clean; ships 285-line cron test. Touches `vercel.json` cron + ledger insert.
5. **`fix/logged-in-audit-autoverify-clean`** — confirmed NOT in main; after #1 (depends on getUser). Ships 152-line test.
6. **`feat/beacon-supabase-edge`** — **port additively** (copy new `supabase/functions/` tree + hand-apply package.json + supabase/config.toml additions; do NOT full-merge — 214-commit divergence → 15 conflicts in those 2 files only). Deno tests (run `deno test`, not Vitest).
7. **ga-pipe group**: `fix/ga-pipe-reader-cursor-advance` + `feat/ga4-type-aware-sink` + `ci/ga-pipe-release-workflow` — 0 conflicts, isolated `api-clients/cpp/`. Add: Vitest test for new `/api/v1/page_views` fields; Catch2 test for GA4 Inja conditional. C++ gated by ctest/GHA, not Docker Vitest.
8. **`cleo-overhaul` (local) — 3 of 8 commits shipped**: `5828fe4` migration 003 (idempotent; flag for prod verify — cols already in schema.ts), `2ca4cf4` cron/budget tests, `bfa5d9f` gitignore. **Reverted**: `0a8e4b5` pipeline-studio admin — broke the clean Vercel build (undeclared `better-sqlite3`), dev-only + untested; held for a follow-up PR. **Excluded**: `.claude` config, GMC hero scripts, gmc docs/images, cost docs (`095bf29`,`72832bc`,`88d810d`,`23f193b`).
9. **Phase 3b: Supabase RLS fix** — enable RLS on public tables + bake into a migration.

### Test-gate strategy
- Baseline: full Docker Vitest on consolidation base (== origin/main) → record pass count (analysts cite ~3863 pass, 2 pre-existing unrelated failures).
- After each merge: relevant targeted tests; full Docker suite after the batch. Final: full suite + `next build` + Playwright. Additive ⇒ final pass count ≥ baseline + new tests, no NEW failures.
