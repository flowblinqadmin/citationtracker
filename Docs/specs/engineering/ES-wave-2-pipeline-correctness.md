# ES-Wave-2 — Pipeline Correctness (B1 + B2 + B3)

**Branch:** `fix/wave-2-pipeline-correctness` (from `bc34913`).
**Source plan:** `docs/specs/orchestration/2026-04-26-bugfix-plan.md` §Wave 2.
**Source UAT:** `docs/uat/2026-04-26-issues.md` rows B1, B2, B3.
**Pivot:** `waves-1to6-cd-pivot-2026-04-26` — gate is Vitest GREEN + Docker CI GREEN. **No Playwright globalSetup** required for Wave 2 landing; Playwright UAT consolidated post-Wave-6.
**Scope:** spec / design only. ScriptDev implements next (B1 + B2 immediately; B3 awaits Shastri/Aditya option ratify).

---

## Overview

Three pipeline-correctness defects surfaced in 2026-04-26 UAT:

- **B1 (HIGH)** — terminal failures inside `app/api/pipeline/stage/route.ts` do NOT consistently flip `geo_sites.pipeline_status` to `"failed"`. Walmart's first audit failed with an Anthropic 401 during `extract-trees`; credits were correctly refunded, but the DB row stayed `pending`, so the dashboard rendered "Discovering pages…" forever (zombie-pending). Root: while a `markFailed()` helper EXISTS at `app/api/pipeline/stage/route.ts:99-119`, not every error exit reaches it (some throws bubble out before the outer catch at line 1280 runs `markFailed`; some failure-class paths exit without throwing so the outer catch never fires).
- **B2 (HIGH)** — `app/api/auth/otp/send/route.ts` already JSON-encodes its outer `catch` (line 58-64) and its inner returns. The actual reported failure-mode (`Unexpected end of JSON input` in the browser) traces to `checkRateLimit()` at `lib/rate-limit.ts` returning `{ allowed: false, remaining: 0, resetAt }` from a thrown DB-write failure path that escapes the route's outer try/catch. Audit: every catch in `otp/send` MUST return `NextResponse.json({error}, {status: 5xx})`; transitively every catch reachable from `checkRateLimit` (or any helper called from `otp/send`) must NOT throw past the route boundary without an upstream handler.
- **B3 (HIGH — SURFACE TO SHASTRI)** — `POST /api/sites` re-audit flow for an existing `complete` site (lines 334-363) gates on `email_verified` + `authEmail === emailLower` and either (a) early-returns "Audit already complete" with `skipVerify:true` but **NO pipeline restart**, or (b) sends a fresh OTP without restarting the pipeline. Pro users submitting the same domain twice see OTP emails arrive and nothing else happens — re-audit intent is silently ignored. Three product-semantics options below; ES authors all three with tradeoff matrix; **does NOT pick** — Shastri/Aditya ratifies before ScriptDev implements B3.

---

## B1 — Stage failure DB write contract

### B1 ACs

| AC | Target (file:line on branch tip `bc34913`) | Failure scenario | DB-write contract | Verify |
|----|---------------------------------------------|------------------|-------------------|--------|
| AC-B1-1 | `stage/route.ts:461` `await markFailed(siteId, "All ${numChunks} chunk submissions failed for ${domain}")` | All Firecrawl chunk submissions fail | EXISTING — `markFailed` writes `pipeline_status='failed', pipeline_error=<reason>`. Verify the call site is awaited (it is) and the function actually flushes the DB write (it does). Add IT covering this path. | Vitest IT (mock Firecrawl + db) |
| AC-B1-2 | `stage/route.ts:584` `await markFailed(siteId, "Crawl quality too low: ...")` | Crawl returns < min usable pages | EXISTING. Same verify-by-IT. | Vitest IT |
| AC-B1-3 | `stage/route.ts:1277` `await markFailed(siteId, err).catch(() => {})` (re-enqueue retry failed) | Stage retry exhausted AND re-enqueue failed | EXISTING but the trailing `.catch(() => {})` SWALLOWS markFailed's own DB-write failure. Contract: if markFailed itself throws (DB outage), retry markFailed once; on second failure log and re-throw so QStash sees a non-200 and re-fires the stage (which then catches and tries markFailed again). | Vitest UT (mock db.update to throw twice → assert second-throw bubbles) |
| AC-B1-4 | `stage/route.ts:1282` `await markFailed(siteId, err)` (permanent failure, retries exhausted) | Stage permanently failed after MAX_STAGE_RETRIES=2 | EXISTING. Verify db.update completes BEFORE the function returns (no fire-and-forget). | Vitest IT |
| AC-B1-5 | `stage/route.ts` extract-trees + research + analyze + assemble paths — confirm each throws on permanent failure (NOT silent return) so the outer catch at line 1280 fires `markFailed`. ES-082 RetryValidationExhausted at line 834 is the canonical model — every other terminal-failure path SHOULD throw analogously. | Any LLM-provider 401/403/5xx exhausted retries within an inner stage handler | If the inner handler catches and silently returns: REFACTOR to throw the original error so the outer catch + markFailed fires. ScriptDev audits each `handleX()` (research, analyze, extract-trees, generate, assemble, mergeCrawl, postComplete) and adds throw-on-permanent-failure. | Vitest IT per stage |
| AC-B1-6 | `markFailed` itself at `stage/route.ts:99-119` — verify the UPDATE statement is awaited AND the connection isn't lazily committed. | `markFailed` invocation | DB-write contract: `UPDATE geo_sites SET pipeline_status='failed', pipeline_error=<reason>, credits_reserved=NULL, crawl_job_ids=NULL, crawl_chunks_done=NULL, crawl_chunks_total=NULL, crawl_chunk_results=NULL, updated_at=NOW() WHERE id=<siteId>` MUST commit synchronously before the function returns. Verify via IT that a SELECT post-call sees the new state. | Vitest IT |
| AC-B1-7 | New invariant: NO terminal failure path may exit `POST()` (the QStash webhook entry) without either (a) `pipeline_status='complete'` written by the success path OR (b) `pipeline_status='failed'` written by markFailed. The QStash 200 response signals "I handled this, don't retry" — but the DB must reflect the outcome. | Any pipeline run | Add a final assertion at the QStash entry point: BEFORE returning 200, re-fetch the site's `pipeline_status` and assert it is one of `{complete, failed}` (NOT `pending`/`crawling`/`extract_trees`/etc unless explicitly the next-stage's pre-state). If the assertion fails, log a CRITICAL warning + call `markFailed(siteId, "Pipeline exited stage without writing terminal status")` as a safety net. | Vitest IT (UAT-style: induce extract-trees failure → assert final DB row is `failed` not `pending`) |

**B1 ScriptDev impl shape:**
1. Audit every inner stage handler (`handleResearch`, `handleAnalyze`, `handleExtractTrees`, `handleGenerateChunk`, `handleAssemble`, `handleMergeCrawl`, `handlePostComplete`) for catches that swallow errors. Each MUST re-throw on permanent failure.
2. Wrap the AC-B1-3 `.catch(() => {})` swallow with a 1-retry helper: if markFailed itself fails, retry once after 1s, then re-throw to QStash (non-200 → QStash retries the stage → next attempt's outer catch tries markFailed again).
3. Add the AC-B1-7 safety-net: at the very end of `POST()` (before `return new NextResponse(null, { status: 200 })` at the existing QStash exit point), re-fetch + assert + safety-net markFailed.

**B1 UAT shape (matches plan §Wave 2 UAT gate):** induce extract-trees permanent failure (e.g. mock Anthropic to throw 401 in test env) → run pipeline against a fixture site → after pipeline returns, `SELECT pipeline_status FROM geo_sites WHERE id = <siteId>` returns `'failed'`, NOT `'pending'`. The credit-refund path (`stage/route.ts:121-148`) is already covered by ES-wave-1's two-phase reserve-then-refund spec; verify credits AND pipeline_status both transition correctly.

**B1 AC count: 7.**

---

## B2 — OTP send 5xx JSON-body contract

### B2 ACs

| AC | Target | Catch / exit point | JSON-body contract | Verify |
|----|--------|---------------------|---------------------|--------|
| AC-B2-1 | `app/api/auth/otp/send/route.ts:58-64` outer `catch (err)` | Any thrown error in the POST handler | EXISTING — already returns `NextResponse.json({error: "Failed to send verification code"}, {status: 500})`. Verify and add UT pinning the contract so a future regression is caught. | Vitest UT |
| AC-B2-2 | `app/api/auth/otp/send/route.ts:25` `checkRateLimit(...)` — if it throws (DB-insert failure), the throw bubbles to the AC-B2-1 catch. Verify this is the actual path the reported `Unexpected end of JSON input` traced through. | `checkRateLimit` DB write fails | The outer catch DOES handle this (current code). UAT-reported empty body MAY have traced to a different version of the code; spec requires a UT that mocks `checkRateLimit` to throw → asserts response.status=500, response.headers['content-type']='application/json', response.json() returns `{error: ...}`. | Vitest UT |
| AC-B2-3 | `lib/rate-limit.ts:checkRateLimit` itself — review for any code path that returns a Promise that rejects without a clear shape. Refactor: every reject from `checkRateLimit` MUST be a thrown `Error` with a non-empty message so the outer route catch can serialize it. | `checkRateLimit` internal failure | Contract: `checkRateLimit` MUST throw an `Error` (never reject with `undefined` or a string-primitive). Add a UT that exercises the reject path. | Vitest UT |
| AC-B2-4 | Audit sibling OTP routes for the same shape: `app/api/auth/otp/verify/route.ts`, `app/api/auth/proxy/[...path]/route.ts`, `app/api/sites/route.ts` (uses `sendVerificationEmail`). Every catch MUST `return NextResponse.json({error: ...}, {status: 5xx})`. No bare `return`, no `return new NextResponse(null)`, no thrown errors past the route boundary. | Each sibling route's catch blocks | Same JSON-body contract as AC-B2-1. | Vitest UT per route (3 sibling routes; minimum 3 UTs) |
| AC-B2-5 | New invariant: every API route handler MUST end its catch with `return NextResponse.json({error: <string>}, {status: 4xx-or-5xx})`. Add a CI lint or a grep test that flags any catch in `app/api/**/route.ts` followed by a bare `return` or a `throw` — both are violations. | All `app/api/**/route.ts` | Vitest grep guard (similar to UT-26 from ES-e2e-fixtures). Negative cases: `} catch (err) { return; }` → flag. `} catch (err) { throw err; }` → flag. `} catch (err) { console.error(err); return new NextResponse(); }` → flag (no JSON body). | Vitest UT (grep-style) |

**B2 ScriptDev impl shape:**
1. AC-B2-1/2: pin the existing contract with a UT (mock `checkRateLimit` to throw → assert JSON 500 body).
2. AC-B2-3: tighten `checkRateLimit` reject path; assert all rejects are `Error` instances.
3. AC-B2-4: audit + patch the 3 sibling OTP/verify/proxy routes; add per-route UTs.
4. AC-B2-5: ship a grep-guard UT that scans `app/api/**/route.ts` for the banned catch shapes.

**B2 UAT shape:** simulate a `rate_limits` DB-insert failure (e.g. drop the table in a test env) → POST `/api/auth/otp/send` → response is `Content-Type: application/json` with body `{ error: <string> }` and status 500. NEVER an empty body.

**B2 AC count: 5.**

---

## B3 — Pro re-audit gate (RATIFIED: Option (a) Pro-session auto-pass)

**Ratify:** Aditya via Shastri corr `wave-2-b3-option-a-2026-04-26` selected **Option (a)** with 5 hardening additions. ScriptDev is unblocked to implement after HP B3 re-review of this amendment.

### Current state (verified at `app/api/sites/route.ts:318-384`)

`POST /api/sites` for an existing site has 4 branches keyed off `pipelineStatus`:
- `complete + emailVerified + authEmail === emailLower` → early-return `{accessToken, skipVerify: true, "Audit already complete"}` — **NO pipeline restart**.
- `complete + emailVerified + (unauth OR mismatched email)` → send fresh OTP, return "Check your email" — **NO pipeline restart**.
- `complete + !emailVerified` → handled at line 323 (resend verification) — **NO pipeline restart**.
- `failed` → reset `emailVerified=false, pipelineStatus='pending', pipelineError=null` + send OTP — **pipeline DOES restart after OTP verify**.
- in-progress → return existing id — **NO action**.

UAT trace: Pro user submits same domain at 02:22 + 02:24, both trigger the `complete + authEmail-mismatch` branch (or the OTP-resend branch if email_verified happened to be false on the existing row), both send OTP emails, neither restarts. Re-audit intent silently swallowed.

### Ratified shape — Option (a) Pro-session auto-pass

When `POST /api/sites` is called for an existing site AND `authEmail === ownerEmail` AND the JWT user is a member of the site's `team_id` (per AC-B3-1), bypass the OTP gate and trigger the same `buildRegeneratePatch` path used by `app/api/sites/[id]/regenerate/route.ts:18-25` (rotate `accessToken` via `nanoid(32)`, reset `pipeline_status='pending'`, clear `pipeline_error`, set `updated_at`). Re-audit starts immediately, zero friction. Aligned with ES-wave-1 token-rotation contract (AC-1/AC-5 router.refresh handle the client-side token rotation).

ScriptDev impl shape: add a branch at `app/api/sites/route.ts:334-345` BEFORE the existing `skipVerify:true` early-return — when the AC-B3-1 team-membership check passes, call the regenerate helper (or inline the patch) and return the new accessToken with the response body indicating the pipeline has been restarted. Pre-AC-B3-3 audit-log insert lands on the same code path. The 4 fall-through paths (failed JWT / non-member / mismatched email / unauth) all funnel into the existing OTP block — no 401/403 short-circuits, OTP is the safety net.

### B3 ACs (5 hardening ACs per Shastri ratify)

**AC-B3-1: Defense-in-depth team-membership check.** The `authEmail === ownerEmail` predicate alone is insufficient — a former teammate whose email happens to match a site's `owner_email` (e.g. owner_email was set when teammate created the site, then teammate left the team but kept their email/JWT) would silently auto-pass. Spec: in addition to the email match, query `team_members` and verify `eq(teamMembers.userId, jwtUserId) AND eq(teamMembers.teamId, site.teamId)` returns at least one row. On miss → fall through to the existing OTP path (NO 403 short-circuit; the user might still own the site under a different team or via legitimate OTP). Pseudocode:
```ts
const isMember = await db.select().from(teamMembers)
  .where(and(eq(teamMembers.userId, jwtUserId), eq(teamMembers.teamId, site.teamId)))
  .limit(1);
if (authEmail === ownerEmail && isMember.length > 0) {
  // auto-pass branch (regenerate + audit log)
} else {
  // fall through to OTP block; no early return, no 403
}
```
**Verifier (Vitest UT):** mock `team_members` query to return empty → assert response goes through the OTP block (200 with "Check your email"), not the auto-pass branch. Mock with one matching row → assert auto-pass branch fires (regenerate called, accessToken returned).

**AC-B3-2: Graceful fallback on JWT failure.** If the Supabase JWT is expired / malformed / missing / fails verification, the request MUST fall through to the OTP path. The user gets OTP'd as a fallback; never hard-blocked with 401 from this code path. Pseudocode:
```ts
let jwtUserId: string | null = null;
try {
  const session = await getSupabaseSession();
  jwtUserId = session?.user?.id ?? null;
} catch {
  /* fall through — OTP is the safety net */
}
// Auto-pass requires jwtUserId !== null AND AC-B3-1 membership; else OTP.
```
**Verifier (Vitest UT):** mock `getSupabaseSession` to throw → assert no 401 returned; instead OTP-block fires (200 with "Check your email"). Mock to return null session → same assertion.

**AC-B3-3: Audit log on every re-audit.** Insert one row per successful re-audit into a new `re_audit_actions` table. Schema (small migration acceptable in this wave):
```sql
CREATE TABLE re_audit_actions (
  id           text PRIMARY KEY,
  actor_user_id text,                     -- nullable for OTP path (no JWT user)
  actor_email   text NOT NULL,
  site_id       text NOT NULL,
  team_id       text,                     -- nullable for sites with no team yet
  mechanism     text NOT NULL,            -- 'pro_session' | 'access_token' | 'otp'
  created_at    timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_re_audit_actions_team_created ON re_audit_actions (team_id, created_at DESC);
```
Insert from `app/api/sites/route.ts` after a successful re-audit trigger, with `mechanism` set to whichever auth path fired (`pro_session` for AC-B3-1 auto-pass, `access_token` for the existing token-validated regenerate route, `otp` for the OTP-verified re-audit). Critical for incident response if JWT compromise is later suspected. The `(team_id, created_at DESC)` index supports per-team timeline queries.
**Verifier (Vitest UT):** mock successful auto-pass → assert `INSERT INTO re_audit_actions` fires once with `mechanism='pro_session'` + correct `actor_user_id` / `actor_email` / `site_id` / `team_id`. Mock OTP-path re-audit → assert insert with `mechanism='otp'`.

**AC-B3-4: SameSite cookie attribute verification.** Confirm Supabase auth cookies default to `SameSite=Lax` (or `Strict`). CSRF mitigation depends on this — auto-pass is a state-changing GET-trigger-able operation if SameSite is None. Audit grep: `grep -rn 'sameSite' lib/supabase/ lib/db/auth* middleware.ts` — verify nowhere is `'None'` or `'none'`. If overridden, REVERT to default (Supabase SDK default is `Lax` per recent versions). If a legitimate use case for `None` exists in this codebase, surface to Shastri before merging Wave 2.
**Verifier (Vitest UT or static-analysis grep):** repo-wide grep returns zero hits for `sameSite.*[Nn]one`. Optional: a runtime UT mounting an auth-cookie-setter and asserting the resulting `Set-Cookie` header includes `SameSite=Lax` (or `Strict`).

**AC-B3-5: Per-team re-audit rate limit.** 10 re-audits per team per hour. Reuse existing `rate_limits` table; key shape `re_audit_team:<teamId>`. Returns HTTP 429 with `Retry-After` header (seconds until next bucket open) when the limit is hit. Implementation reuses `checkRateLimit()` at `lib/rate-limit.ts`. Pseudocode:
```ts
const rl = await checkRateLimit(`re_audit_team:${site.teamId}`, 10, 60 * 60 * 1000);
if (!rl.allowed) {
  return NextResponse.json(
    { error: "Too many re-audits for this team. Please try again later." },
    { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
  );
}
```
The rate-limit check fires BEFORE the AC-B3-1 membership check (cheap pre-filter). Per-team (NOT per-user) ceiling so a malicious actor can't burn through team-budget by rotating through compromised users; the team is the cost-bearing entity.
**Verifier (Vitest UT):** simulate 11 re-audit requests in the same hour for the same team → first 10 succeed (or take the OTP path), 11th returns 429 with `Retry-After` header populated and integer-seconds value > 0.

### Alternatives considered (rejected)

| Option | Rejection rationale |
|--------|---------------------|
| **(b) Always require fresh OTP for re-audit; UI surfaces explicit step** | Worst UX for Pro users (OTP every re-audit despite valid Supabase JWT). Strongest security but over-conservative for a Pro user who has already proven email ownership via JWT. The defense-in-depth additions in (a) — team-membership check (AC-B3-1) + audit log (AC-B3-3) + rate limit (AC-B3-5) — close the security gap (a) had over (b) without imposing OTP friction. |
| **(c) Session-bound skip (last_verified_session_id)** | Over-engineered for marginal security gain. Schema migration + session-tracking middleware + fallback OTP path = HIGH complexity. Threat model: legitimate user on a new device gets OTP'd anyway (which the (a) AC-B3-2 JWT-fallback path already handles cleanly). The session-id binding adds little beyond what JWT expiry already provides. |

**Original `B3 SURFACE payload` is now CLOSED — Option (a) ratified per Shastri corr `wave-2-b3-option-a-2026-04-26`.**

**B3 AC count: 5 (5 hardening ACs for Option (a) — supersedes prior placeholder ACs).**

---

## Test strategy

**Vitest UTs (per AC above):**
- B1: 7 ITs (one per AC) — mock db + verify `pipeline_status='failed'` post-call.
- B2: 5 UTs — mock `checkRateLimit` to throw, mock sibling routes' catches, ship grep-guard UT.
- B3: 1 cross-cutting UT (re-audit-intent never silent) + 1-3 option-specific UTs (depends on ratify).

**Vitest ITs (Docker CI green required per pivot):**
- B1: end-to-end stage-failure simulation (mock external provider 401 → drive `POST /api/pipeline/stage` → assert DB row is `failed`).
- B2: end-to-end OTP-send under rate-limit-DB-failure (drop `rate_limits` table in test env → POST → assert JSON 500 body).
- B3: end-to-end Pro re-audit (per chosen option).

**Playwright per-wave: NOT REQUIRED per pivot `waves-1to6-cd-pivot-2026-04-26`.** A consolidated UAT Playwright spec covering B1+B2+B3 will be authored post-Wave-6 if needed; not blocking Wave 2 landing.

---

## Out of scope

- **C series** (UX polish, copy fixes, accessibility) → Wave 5.
- **D series** (infra, CI, monitoring) → Wave 6 or later.
- **B4-B6** (other API issues if any surface during implementation) → separate dispatch; NOT Wave 2.
- **G2** (completion-email link routes) → Wave 4.
- **Token-rotation grace window** (G1 alternative — server accepts both old + new) — explicitly out per ES-wave-1.
- **Pipeline-status auto-recovery** (zombie-pending sweeper that flips stale `pending` rows to `failed` after N hours) — could be a follow-up Wave 6 ops task; NOT this ES.

---

## Verification gate (pivot-aligned)

**Per pivot `waves-1to6-cd-pivot-2026-04-26`:** Wave 2 lands when:
1. Vitest GREEN — all UTs from §B1/§B2/§B3 ACs pass.
2. Docker CI GREEN — all ITs pass against the containerised local Supabase.
3. New unit/integration coverage GREEN — no regressions in existing pipeline / OTP / sites tests.
4. **No Playwright globalSetup requirement** — explicitly per pivot.
5. B3 implementation gated on Shastri ratify of one option; B1 + B2 land independently and can ship before B3 ratify.

UAT-style induced-failure tests (per plan §Wave 2 UAT gate) live as Vitest ITs, not Playwright specs. Consolidated Playwright UAT post-Wave-6 if needed.
