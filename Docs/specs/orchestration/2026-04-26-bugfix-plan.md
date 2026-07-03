# Bug-fix orchestration plan — 2026-04-26

Owner: CoFounder (autonomous execution)
Source-of-truth issues: `docs/uat/2026-04-26-issues.md`
Base branch: `e2e-comprehensive-suite` (tip `dfbe76a`, pushed to origin)

## Operating constraints

1. **All work LOCAL.** No `git push` to origin for any wave until Shastri ratifies UAT pass and explicitly authorizes push.
2. **Per-wave branch from `e2e-comprehensive-suite`.** Naming: `fix/wave-N-<topic>` — e.g. `fix/wave-1-token-handling`. Local-only; not pushed.
3. **Per-wave UAT gate.** Each wave must pass full UAT in the local docker stack at `/home/aditya/flowblinq/geo` using the `.docker-test/compose.uat-local.yml` overlay (LOCAL Supabase backing — reuses the existing 7 `supabase_*_geo` containers via `host.docker.internal:54321/54322`) before proceeding to the next wave. UAT shape: trigger the affected user flow end-to-end via the wave's Playwright spec against the deterministic seeded fixture; verify expected logs + DB state + UI behavior. Rationale: docker stack validates the bake; Playwright UAT validates code logic against deterministic fixtures; prod-creds smoke is a separate final-integration concern. Today's walmart audit already proved the prod-bake path; we don't need to prove it again per wave. Amended 2026-04-26 per Shastri ratify of Option A (corr `wave-1-option-a-2026-04-26`).
4. **Tests required.** Each wave ships with Vitest unit/integration coverage for new logic + Playwright E2E coverage for UX-visible fixes. Failing tests block UAT.
5. **HolePoker first.** Each wave's spec runs through HP adversarial review before implementation. CoFounder rules autonomously on MAJOR-or-lower findings; surfaces HIGH-severity to Shastri with option matrix.
6. **Branch hygiene.** Worktree clean between waves. Each wave merges (or is rebased) onto e2e-comprehensive-suite at successful gate; worktree returns to e2e-comprehensive-suite tip before Wave N+1 begins.

## Autonomous decisions CoFounder makes without round-trip

- Implementation choices within a spec
- Test scaffolding + coverage decisions
- Commit messages + commit grouping
- ScriptDev/HighDev/RM dispatch sequencing
- MAJOR-or-lower HolePoker finding resolutions
- Lint/format/type-fix iterations
- `.gitignore` / `.dockerignore` / config-file additions when warranted
- Bug fixes within scope (e.g., a B1 fix exposes a related B-series issue — fix in the same PR)

## Surface to Shastri (option matrix required)

- HIGH-severity HolePoker findings that change the wave's scope
- Spec semantics decisions where reasonable people disagree (e.g., B3 below)
- Production-DB mutations (A1's `SET NOT NULL` reconcile) — CoFounder prepares SQL, Shastri executes
- Cost overruns: any wave projected to consume >$5 in LLM credits during dev/test
- Wave gate failures CoFounder can't resolve in two iterations

## Wave 1 — Token Handling (BLOCKER) `fix/wave-1-token-handling`

**Issues:** G1, G3
**Surface:** none expected — fix shape is well-defined

Spec scope:
- `app/sites/[id]/SitePageClient.tsx:194` token bootstrap inverted: prefer fresh `initialSite.token` over `sessionStorage.getItem`. On mismatch, overwrite stored.
- After regenerate (both `RowActions.tsx` dashboard path AND `SitePageClient.tsx` audit-page path), trigger `router.refresh()` to pull the rotated token through Next.js server props.
- Define expected behavior when `initialSite.token` is absent (read-only view per existing logic) vs present (action-enabled).

UAT gate:
- Trigger Rerun Audit from dashboard → token rotates server-side → audit page (open in another tab) is hard-refreshed → all action buttons (Map Competitors, Add Competitor, Rerun Citations, Download ZIP, Download PDF) succeed without 401.
- New unit test: sessionStorage staleness + recovery path.
- New Playwright spec: dashboard re-audit → audit-page action chain.

## Wave 2 — Pipeline Correctness `fix/wave-2-pipeline-correctness`

**Issues:** B1, B2, B3
**Surface:** B3 product semantics (matrix below)

Spec scope:
- B1: every terminal failure path in `app/api/pipeline/stage/route.ts` must `UPDATE geo_sites SET pipeline_status='failed', pipeline_error=<reason>` before returning. Audit all `Marking site failed` log call sites + ensure DB write happens.
- B2: every `catch` in `app/api/auth/otp/send/route.ts` returns `NextResponse.json({ error: ... }, { status: 5xx })`. No bare `return` or empty body.
- B3: **SURFACE TO SHASTRI** — Pro user re-audit gate semantics. Options:
  - (a) Pro session auto-passes `email_verified` gate (already authenticated via Supabase JWT) → re-audit immediately starts pipeline
  - (b) Always require fresh OTP for re-audit (current behavior) → UI must surface "verify your email" step explicitly
  - (c) Pro session: skip OTP only if same browser session as last verify; otherwise OTP

UAT gate:
- B1 test: induce extract-trees failure (e.g., temporarily nuke ANTHROPIC_API_KEY in container env, retry walmart audit) → verify DB row ends with `pipeline_status='failed'` not `pending`.
- B2 test: simulate rate_limits DB write failure → verify response is JSON `{ error: ... }`.
- B3 test: per chosen option.

## Wave 3 — Schema / Migration (BLOCKER) `fix/wave-3-schema-migration`

**Issues:** A1, A2
**Surface:** A1 prod DB ALTER coordination

Spec scope:
- A1: confirm `lib/db/migrations/20260421-add-pre-analyze-done.sql` has `ADD COLUMN IF NOT EXISTS … NOT NULL DEFAULT 0`. Add follow-up `ALTER COLUMN pre_analyze_done SET NOT NULL` (idempotent if already NOT NULL) to reconcile prod's nullable=YES drift. Update `__tests__/schema-drift.test.ts` snapshot if needed.
- A2: scaffold drizzle-kit migrations with `__drizzle_migrations` journal table; document in `docs/specs/ops/migration-runner.md`. Backfill journal entries for existing applied migrations.

UAT gate:
- Fresh DB spin-up (separate Postgres, not prod) + `db:push:local` → verify schema matches migration set + drift test passes.
- Prepare `ALTER COLUMN` SQL for Shastri to execute against prod with confirmation.

## Wave 4 — Observability `fix/wave-4-observability`

**Issues:** B5, B6, G2
**Surface:** none expected

Spec scope:
- B5: `selectTopUrlsWithGemini` catch logs the error: `console.warn("[geo-crawler] Gemini API error:", err)`. Consider URL-list chunking strategy if input >500k tokens (separate TS-spec acceptable).
- B6: `[content-generator] LLM response failed schema validation` should also emit a structured event (`{event: 'llm_json_parse_failure', ...}`) for metric tracking. Aggregate count per audit run.
- G2: Map Competitors error path in `SitePageClient.tsx:374` shows toast/inline error with server-provided message.

UAT gate:
- Trigger Gemini failure (e.g., walmart with 80k+ URLs) → verify error logged with status code + body.
- Trigger Map Competitors with stale token → verify toast appears with "Unauthorized".

## Wave 5 — UX Polish `fix/wave-5-ux-polish`

**Issues:** B4, C1, C2
**Surface:** C2 if root cause needs DaVinci redesign

Spec scope:
- B4: align `regenerate` route response. Either route returns 202 on success, or `RowActions.tsx:57` accepts both 200 and 202.
- C1: `DomainTableRow.tsx:86` polling start also fires for ~30 seconds after any RowAction click (optimistic), regardless of `liveStatus`. Prevents the missed-transition-window problem.
- C2: investigate React #418 hydration mismatch. Likely SSR vs client divergence on dashboard. May require DaVinci touch.

UAT gate:
- Click "Rerun Audit" → row transitions to "Discovering pages…" within 3s without manual refresh.
- No React hydration error in browser console after submit.

## Wave 6 — Infra Hygiene `fix/wave-6-infra-hygiene` (parallelizable with any wave)

**Issues:** D1, D2, D3, D4, D5, D6, D7, E4, E5
**Surface:** D1 Vercel mutation needs Shastri authorization

Spec scope:
- D1: prepare `vercel env rm DATABASE_URL production` + `vercel env add DATABASE_URL production <clean-value>` script. SURFACE TO SHASTRI for execution.
- D2: write `npm run env:refresh-docker` that wraps `vercel env pull` + `python3 patch-env-docker.py`. Document in runbook.
- D3: commit the existing `.dockerignore` worktree modification (added during this UAT session). Add to wave-1 branch or a separate cleanup commit.
- D5: set up named cloudflared tunnel (`cloudflared tunnel create flowblinq-uat-laptop`) with stable URL. Update `.env.docker` once.
- D6, D7, E4, E5: aggregate into `docs/specs/ops/docker-uat-runbook.md` covering env_file path resolution, NEXT_PUBLIC_* LAN gotcha, secrets-leak-avoidance.

UAT gate:
- Documentation reviewable; runbook complete enough for a fresh operator to spin up UAT without help.
- D3 commit lands on e2e-comprehensive-suite.

## Final integration step (after all waves UAT-pass)

1. Rebase each wave branch onto current `e2e-comprehensive-suite` tip
2. Run consolidated UAT (full audit cycle + all action buttons + dashboard transitions) via the LOCAL-Supabase overlay
3. **Manual prod-cred smoke:** with the operator's authenticated browser session, exercise the full walmart-style audit cycle + all 5 action buttons (Map Competitors, Add Competitor, Rerun Citations, Download ZIP, Download PDF) + dashboard re-audit transitions against the existing prod-creds docker stack (`.docker-test/compose.override.yml`). Confirms the prod-bake path remains green after all wave changes integrate. Added 2026-04-26 per Shastri ratify of Option A (corr `wave-1-option-a-2026-04-26`).
4. SURFACE TO SHASTRI: greenlight to push waves 1–6 to origin (each as separate branch for PR-ability)
5. Open PRs in GitHub: one per wave + one umbrella tracking issue

## Reporting

CoFounder posts `flowblinq_status` event at end of each wave with:
- Wave number + branch SHA
- Vitest pass count + Playwright pass count
- UAT verdict (PASS / FAIL with details)
- Any HP findings ruled MAJOR-or-lower (autonomous resolution)
- Any HIGH-severity findings surfaced + option matrix
- Open questions (B3 product decision in Wave 2; D1 Vercel mutation in Wave 6)
