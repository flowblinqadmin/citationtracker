# TS-Wave-7 — Playwright globalSetup auth investigation (deferred)

> **Author:** CoFounder (Agent 1)
> **Date:** 2026-04-26
> **Priority:** P2 — deferred from Wave 1 of bugfix-orchestration; future wave to pick up
> **Origin:** Shastri pivot corr `waves-1to6-cd-pivot-2026-04-26` (2026-04-26 05:30Z) — Wave 1 token-handling product fix landed Vitest+Docker-CI green at e2e-comprehensive-suite tip `7cbeab1`; Playwright globalSetup investigation extracted to its own TS

---

## 1. Problem

The `e2e/helpers/login.ts` `loginViaOtp` helper, used by `e2e/helpers/global-setup-auth.ts` to bootstrap an authenticated `storageState.json` for every Playwright spec, currently CANNOT establish a session that is recognized by the docker-baked production middleware running on the UAT stack (compose chain `.docker-test/compose.override.yml` + `.docker-test/compose.uat-local.yml`).

After 7 distinct iterations during Wave 1, all observable state aligns (cookie name, JWT issuer, container env, test user existence) but `curl /dashboard --cookie sb-127-auth-token=<baked>` still returns `307 → /auth/login?redirectTo=%2Fdashboard`. The middleware reads the cookie and rejects the session for an opaque reason.

## 2. Iteration ledger (Wave 1, 2026-04-26)

| # | Blocker | Resolution commit | Class |
|---|---------|-------------------|-------|
| 1 | docker→prod Supabase, no test user in prod auth.users | `907da36` Option A overlay (`compose.uat-local.yml`) → local Supabase backing via `host.docker.internal` | infra |
| 2 | Mailpit silent-drop for OTP after Send Code | superseded by `d48854a` admin.generateLink bypass | infra/test-infra |
| 3 | /auth/login doesn't consume `#access_token=` hash fragment | superseded by `a02683c` cookie-bake approach | test-infra |
| 4 | admin.generateLink emits implicit-flow hash; /auth/callback only handles PKCE `?code=` | `a02683c` pivot to context.addCookies via @supabase/ssr setSession | test-infra |
| 5 | Cookie name `sb-127-auth-token` mismatched container's `sb-host-auth-token` (project_ref divergence) | `6e98b48` rename based on `PLAYWRIGHT_SUPABASE_URL` env | test-infra |
| 6 | JWT iss=`http://127.0.0.1:54321` but middleware expected `host.docker.internal` URL | `8df9dfd` overlay to `network_mode: host` aligns 127.0.0.1 on both sides | infra |
| 7 | **OPAQUE — middleware reads correct cookie but rejects session** | unresolved at session end | unknown |

## 3. Iteration-7 known state

- Container `NEXT_PUBLIC_SUPABASE_URL = http://127.0.0.1:54321` (verified via `docker exec geo-geo-1 env`)
- Helper produces `sb-127-auth-token` with valid base64-encoded session value (~2638 chars; format `[access_token, refresh_token, ...]`)
- Direct `curl http://localhost:3030/dashboard --cookie 'sb-127-auth-token=<baked>'` → 307 → /auth/login (proves middleware reads cookie + rejects, not cookie-not-sent)
- Test user `00000000-0000-4000-8000-0000000000a1` exists in local `auth.users` with `email_confirmed_at` set
- `@supabase/ssr 0.8.0` used by helper; container Next 16 production bundle uses bundled-equivalent version
- JWT minted via host-process call to `127.0.0.1:54321/auth/v1`; `iss` claim matches container's configured Supabase URL after iteration-6 fix
- `admin.generateLink({type: 'magiclink'})` → `verifyOtp({type: 'magiclink', token_hash})` chain produces `session: {access_token, refresh_token, expires_at, token_type: 'bearer', user: {...}}` with no error

## 4. Remaining hypotheses (un-validated)

- (A) **Middleware getUser network-hit failure:** middleware likely calls `supabase.auth.getUser()` server-side which hits Supabase auth `/auth/v1/user`. If that returns 401/null for the baked access_token, the cookie is parsed but the session is rejected. Needs middleware-side log instrumentation to confirm.
- (B) **Production-bundle Edge runtime divergence:** Next 16 production middleware runs in Edge runtime; cookie value handling may differ subtly from `next dev` Node runtime even though same source. Possibly the JWT verification path or cookie-decoder behaves differently.
- (C) **Transient session not persisted in auth backend:** `admin.generateLink → verifyOtp` may produce a session that's "client-memory valid" but not registered in the `auth.sessions` table; middleware's `getUser` fetch returns null because backend has no session record.
- (D) **JWT aud/amr/role claim mismatch:** the JWT minted via verifyOtp may have a claim shape (`aud="authenticated"` vs `aud="anon"`, `amr=[{method:"otp"}]` vs different) that middleware rejects via implicit policy.

## 5. Proposed investigation steps (for the agent picking this up)

1. **Add temporary diagnostic logging** to `middleware.ts` (or wherever the auth gate lives) at the rejection path. Log: cookie name detected, cookie value length, JWT decode result, getUser response (success/error/user-id). Rebuild docker image, recreate geo container, re-run spec, capture log, identify which path rejects.
2. **Compare against working session:** capture the cookie set by an actual successful UI login (Mailpit-driven OTP, when mailer is healthy), inspect via `docker exec` of any container or browser DevTools. Diff against helper-baked cookie. Find the structural difference.
3. **Probe `auth.sessions` table** (or whichever table backs Supabase session persistence) before/after helper bake to confirm whether the session row exists.
4. **Decode the JWT claims** (helper-baked vs Mailpit-baked) and diff them — `aud`, `amr`, `iss`, `role`, `aal` — find the rejected field.
5. **If middleware uses `@supabase/ssr` createServerClient + getUser**, replicate that exact code path in a one-off test script run from the host (Playwright host-process can call the same library) to reproduce the rejection in a less-coupled environment.

## 6. Out of scope

- Wave 7 does NOT require any product code change to fix Wave 1's product bugs. Wave 1 product fix (G1 + G3) is already merged at `7cbeab1` with Vitest 2989/2989 + Docker CI green.
- Wave 7 is also NOT a blocker for Waves 2–6, which run with the redefined gate (Vitest + Docker CI per Shastri pivot corr `waves-1to6-cd-pivot-2026-04-26`).
- Consolidated manual UAT after Wave 6 happens against the prod-creds compose stack; Wave 7 only matters when re-establishing automated Playwright UAT for future regression suites.

## 7. Acceptance criteria

- AC-1: Diagnostic-instrumented middleware run identifies the exact rejection reason (one or more of hypotheses A–D ruled in/out with evidence).
- AC-2: `e2e/helpers/login.ts` updated to produce a session that the docker-baked middleware accepts, OR an alternative architecture (e.g., in-container Playwright runner) replaces the host-process auth-bake pattern.
- AC-3: A Playwright spec running against the UAT stack with the local-Supabase overlay can complete a full audit-page load + 5-button action chain end-to-end without 401, exercising the Wave 1 token-rotation behavior end-to-end.
- AC-4: Documentation in `docs/specs/ops/playwright-uat-runbook.md` covering the resolved auth pattern + how to add new Playwright specs that pass the gate.

## 8. References

- Origin Shastri dispatch: corr `bugfix-orchestration-2026-04-26` (Wave 1 dispatch)
- Re-scoping pivot: corr `waves-1to6-cd-pivot-2026-04-26` (defer to Wave 7)
- Wave 1 surfaced surface: corr `6eb10a88-b44f-4b2a-b982-a2d634ef651a` (7-iteration ledger)
- Final landed Wave 1 tip: `7cbeab1` on `e2e-comprehensive-suite` (post-merge)
- Wave 1 branch chain (preserved at `fix/wave-1-token-handling` tip `8df9dfd`): 8 commits including all test-infra investments

## 9. Open questions

- Is the docker production-bundle middleware running on Edge runtime or Node runtime? (`next.config.js` `experimental.serverComponentsExternalPackages` and explicit `runtime` exports affect this.)
- Does the prod-creds path ever experience the same rejection class? (No — the walmart audit at session start completed cleanly with full action-button chain. Suggests the bake-vs-real-login asymmetry is the issue, not the docker bundle itself.)
- Is there a simpler test-mode auth bypass already in the codebase (e.g., `TEST_AUTH_TOKEN` env that middleware honors)? Should be flagged as Rule 2 violation if so, but worth confirming.
