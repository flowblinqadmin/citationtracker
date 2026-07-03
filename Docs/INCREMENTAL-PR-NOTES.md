# Incremental hardening on top of `main` (PR notes) — 2026-06-09

Branch: `fix/audit-incremental-on-main`, based on `origin/main` (cofounder's bug-hunt PR #192 / FIX-001..032).

## Context
A parallel audit + fix effort ran against the same `d6d22ef` baseline. The cofounder's `main` is broadly **ahead** and is the correct base — it independently fixed nearly all of the audit (RLS, billing unification + interval multiplier, ledger gte-guards, maxPages threading, provisioning tx, crawl-completeness FIX-029..032, Edge beacon hardening). This branch adds **only the verified gaps** their main is missing. Their base passes its own suite (3993) and is not regressed by these additions.

## My additions (each verified red-on-their-base → green, tests included)
| Commit | Finding | What their base had | What I added |
|--------|---------|---------------------|--------------|
| 64c4f90 | NEW-S-01/02/03 | RLS enable-only (anon SELECT → 0 rows, silent); no CHECK constraints | `REVOKE ALL FROM anon,authenticated` (hard 42501 denial) + DB CHECK on tier/status + `credit_balance/monthly_pages_used >= 0`. Real-DB integration tests. |
| cdf500a | NEW-AI-03 | `lib/claude.ts` gpt-5.4 sent `max_tokens` → 400 (dead fallback) | `max_completion_tokens` for the OpenAI reasoning model |
| cdf500a | NEW-AI-04 | geo-analyzer scorecard parse unguarded → truncated JSON hard-fails the audit | fence-strip + try/catch + graceful 17-pillar fallback |
| cdf500a | NEW-AI-07 | citation-prompt-generator detection on `gemini-2.5-flash-lite` (hallucinates) | → `gemini-2.5-flash` |
| 9b67a08 | NEW-C-02 | checkout description `*5` pages | `* PAGES_PER_CREDIT` (correct page count on Stripe) |

## Verification
- Unit (Docker vitest): **4030 passed / 0 failed**.
- Integration (real Postgres :54322, local Supabase synced to current schema; Docker reaches host via `host.docker.internal`): **234 passed / 0 failed**, incl. anon-role hard-denial + CHECK-constraint rejection proofs.
- Their base verified green before adding (3993) — none of their work is regressed.

## Confirmed: cofounder's work reviewed, no errors found
Spot-checked their key fixes for correctness: interval multiplier (`tier.credits * months`, 3/12 ✓), billing unification (credits not pages ✓), credit-deduction atomicity (`gte` guard + ledger-in-tx ✓), RLS dynamic loop ✓, maxPages discriminated payload ✓, crawl-completeness FIX-031 (the real root-cause of Pro low-page reports) ✓. All sound.

## Remaining (still GAP on BOTH branches — genuine open bugs, next iterations)
- NEW-A-01/A-05: webhook still blind-`SET`s over an existing customer's team (no reconcile/ownership guard). *My branch had a guard; porting onto their differing webhook.*
- NEW-W-06/L-12: idempotency keyed only on subscriptionId; topup SELECT outside tx → port event.id-in-tx idempotency.
- NEW-W-05: renewal email next-date hardcoded +31d.
- NEW-AI-02 / NEW-L-01: assemble complete-path never clears `creditsReserved` → double-refund on stage re-entry (unfixed on both).
- NEW-AI-01: cron re-enqueue omits `runNumber` → duplicate fan-out (unfixed on both).
- NEW-AI-06: citation 0% indistinguishable from no-data (unfixed on both).
- NEW-A-02: free-audit gmail-alias bypass; NEW-A-06: signup per-IP-only rate limit (unfixed on both).
- NEW-P-01: `monthlyPagesUsed` not reconciled on under-crawl (unfixed on both).

## Status: COMPLETE — PR #193

All loop deliverables done (PR: https://github.com/flowblinqadmin/geo/pull/193, feature branch → main, additive; main untouched):
- [x] My unique gaps ported: RLS REVOKE+CHECK, AI-03/04/07, checkout copy, NEW-A-01 reconcile + event.id idempotency + NEW-W-05.
- [x] Both-branches bugs fixed: assemble double-refund (NEW-L-01/AI-02), cron runNumber (NEW-AI-01), citation no-data (NEW-AI-06), gmail-alias (NEW-A-02).
- [x] LLM calls centralized (`lib/llm/openai-route.ts`) — was scattered on main.
- [x] Pipeline prod-workload simulated on local LM Studio (gemma-4-12b), 3/3 — `__tests__/system/prod-sim-local-llm.test.ts`.
- [x] Architecture + customer-journey docs (`docs/ARCHITECTURE.md`, `docs/CUSTOMER-JOURNEY.md`) — code-grounded, Mermaid.
- [x] Verification: unit 4092/0, integration all green on real DB, `next build` passes.
- [x] Sonnet used for all code generation.

All audit findings are now closed:
- [x] NEW-P-01 — `subscriptionPagesReserved` column + idempotent reconcile of unused subscription pages in handleAssemble (real-DB integration test).
- [x] NEW-A-06 — per-email DB-persisted rate limit on the unauthenticated signup checkout (alongside per-IP).
- Product-requirement check: SUBSCRIPTION_TIERS internally consistent + match the advertised offering ($99/$249/$499; credits=billing, pages=advertised, per-audit caps 100/500/∞). The cofounder also added the `sites: 1/5/10/20` cap, closing the audit's BUG-009 (TS-079 sites-per-account).

Final state: **13 delta commits**, unit 4101/0, integration 250/0 on real DB, `next build` passes, prod-sim 3/3 on local gemma.
