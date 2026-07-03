# TS-090 — Security & Production Readiness Remediation

> **Author:** CoFounder (upstream of Rao's ES-100 draft on `fix/security-audit-remediation`)
> **Source audit:** ES-100-security-audit-remediation.md (2026-04-12, Rao) — overall score 6.2/10
> **Target score after remediation:** 8.5/10
> **Main HEAD at TS authoring:** `70645cbae6f3fcd09add526c215cdef7979f715b`
> **Spec authoring date:** 2026-04-15

---

## 1. Problem

A production-readiness audit on 2026-04-12 surfaced 4 critical vulnerabilities, 5 medium-severity defects, and a cluster of lower-severity hardening gaps. Several findings on the original ES-100 reference files that no longer exist on main (`app/components/commerce-report/*`, `lib/pipeline-studio/admin-auth.ts`) — those have been verified against the tree and dropped or rescoped here.

This TS converts the remaining, code-verified findings into a shippable engineering spec. Items have been re-grouped by **risk class** (rather than by hiring milestone as in ES-100), since the original phasing was tied to onboarding timing which is no longer the driver.

## 2. Why (impact of not shipping)

| Finding | Exposure today |
|---|---|
| CRIT-1 permanent accessToken | Any token leak = permanent cross-tenant read access. Token also survives site regenerate. |
| CRIT-2 stored XSS via LLM markup | Attacker-controlled website → malicious content in citation extract → `dangerouslySetInnerHTML` renders it in-app → session theft. Attack chain is fully reachable from a free audit. |
| CRIT-3 citation-check race | Two concurrent requests credit-debit once each but both succeed; unbounded drain of paid credits. |
| CRIT-4 sites POST unbounded | Attacker fires 10K `POST /api/sites` → 10K verification emails from SendGrid → domain reputation burned; SendGrid suspension possible. |
| MED-2 host-header spoof | QStash signature verification uses `req.headers.get("host")` as the third-option URL fallback; an attacker-proxied request could bypass signature verification. Mitigated by Vercel's edge but not airtight. |
| MED-3 OTP concurrent bypass | Select-then-update race allows ~2× intended OTP attempts before lockout, undermining brute-force protection. |
| MED-4 tokens in JSON body | Any XSS (see CRIT-2) can read session + siteToken out of the verify response and exfiltrate. |
| MED-5 semaphore not cluster-safe | 10 Vercel instances × 3 = 30 concurrent LLM re-extractions instead of intended 3. Budget and rate-limit blast. |
| MED-6 raw token in email URL | Completion email embeds `accessToken` raw. SendGrid logs it, corporate email gateways scan it, any log exfiltration yields permanent access. |
| OBS-1 no observability | Production pipeline failures are invisible today. Customer sites can sit "stuck" indefinitely (confirmed by live Manipal incident 2026-04-09). |
| COMP-1/2 DPDP gaps | No right-to-erasure endpoint; raw IP addresses stored indefinitely. |

## 3. Scope

This TS delivers **three classes of work** against `origin/main` HEAD `70645cba`:

- **Class A — Critical (ship ASAP):** CRIT-1, CRIT-2, CRIT-3, CRIT-4, L-1, L-2
- **Class B — Medium hardening:** MED-2, MED-3, MED-4, MED-5, MED-6
- **Class C — Observability & compliance:** OBS-1, COMP-1, COMP-2, hygiene

**Out of scope:**
- MED-1 from ES-100 — stale. `lib/pipeline-studio/admin-auth.ts` does not exist on main (verified 2026-04-15). There is no `app/api/admin/` route tree either. If admin surface returns in a future branch, re-file as a new finding.
- Rescoping CRIT-2 — ES-100 cited `app/components/commerce-report/*` files which do not exist on main. Only `app/components/citation-monitor.tsx` usages are in scope.
- `feat/ux-overhaul-es087` (ES-087) work — unrelated.

## 4. Dependencies

**Existing and available (verified):**

| Dependency | Location | Used by |
|---|---|---|
| `checkRateLimit(key, limit, windowMs)` | `lib/rate-limit.ts:15` — DB-backed via `rate_limits` table with `ON CONFLICT DO UPDATE` | CRIT-3, CRIT-4 |
| `geoSites` schema — `accessToken`, `otpAttempts`, `otpLockedUntil` columns | `lib/db/schema.ts` | CRIT-1, MED-3 |
| `lib/services/exchange-code.ts` | exists; exchange-code pattern already used in verify route at line ~307 | MED-6 |
| `SECURITY_HEADERS` object | `middleware.ts:98-106` | L-2 |
| Upstash Redis client (`@upstash/redis` via QStash SDK) | `package.json` existing | MED-5 |
| `@qstash/next` `Receiver` | `app/api/pipeline/stage/route.ts:1122` | MED-2 (untouched) |

**New dependencies:**

| Package | Purpose | Scope |
|---|---|---|
| `dompurify` + `@types/dompurify` | HTML sanitization wrapper | CRIT-2 |
| `@sentry/nextjs` | Observability | OBS-1 |

**Schema migration required:**
- `geoSites.tokenExpiresAt timestamp` (CRIT-1)
- `geoSites.tokenRotatedAt timestamp` (CRIT-1, for audit trail)
- Tracking tables may need `ipHash text` plus legacy `ip` nullable during transition (COMP-2)

## 5. Fix inventory (code-verified)

### Class A — Critical

**CRIT-1 — accessToken has no expiry; permanent cross-tenant access on leak**

- Current state: `geoSites.accessToken` is a `nanoid(32)` set once in `app/api/sites/[id]/verify/route.ts:321` and never rotated. Enforcement occurs at 4 verified call sites:
  - `app/api/sites/[id]/route.ts:26` (`if (site.accessToken !== token)`)
  - `app/api/sites/[id]/regenerate/route.ts:29`
  - `app/api/sites/[id]/citation-check/route.ts:83`
  - `app/api/sites/[id]/competitor-discovery/route.ts:28`
- Fix:
  - Add `tokenExpiresAt: timestamp("token_expires_at")` and `tokenRotatedAt: timestamp("token_rotated_at")` to `geoSites` in `lib/db/schema.ts`
  - Apply with `npx drizzle-kit push`
  - On token creation (verify route line 321 and 341), set `tokenExpiresAt = new Date(Date.now() + 90 * 86400_000)`
  - At each of the 4 enforcement sites above, add an expiry check after the equality check: `if (site.tokenExpiresAt && site.tokenExpiresAt < new Date()) return 401`
  - Extend `regenerate/route.ts` to rotate the token (issue new `nanoid(32)`, reset `tokenExpiresAt`, write `tokenRotatedAt`)
  - **Re-login self-recovery (HP-224) + OTP gate (HP-237, SECURITY) + split primitives (HP-239):** the verify route also handles already-verified re-logins (`site.emailVerified === true`). Today that branch echoes the stored `accessToken` verbatim — after CRIT-1 expiry checks activate, a user whose token has aged past day 90 is locked out: the regenerate rotation path rejects their expired bearer before they can rotate, and no other OTP-gated recovery gate exists. Fix: treat verify-as-rotation for the re-login path — if `tokenExpiresAt` is NULL or past current time, issue a fresh token and reset expiry; if still valid, preserve it unchanged. See ES-090 §b.2 step 2 re-login path for the engineering detail. **Security note (HP-237):** the re-login branch on main @ `70645cba` today checks only `code.length === 6` and never invokes `verifyCode()` — pre-HP-224 this was passive impersonation; post-HP-224 it amplifies into active DoS + token theft (attacker's call fires the rotation, silently invalidating the legitimate user's session). The amended spec requires a 4-condition OTP precondition before rotation: pending `verificationCode`, unexpired `codeExpiresAt`, `verifyCode(code, stored)` matches, and `otpAttempts` / `otpLockedUntil` brute-force protections apply symmetrically with fresh-verify. Rotation is gated on OTP possession + email-mailbox control — same trust evidence fresh-verify requires — closing the auth-bypass surface while preserving HP-224's self-recovery semantics. **Primitive split (HP-239):** the existing `checkAndIncrementOtpAttempt` primitive conflates lockout-read and attempt-increment in one atomic call, which would have created a pure-DoS vector on the re-login path (attacker POSTs any 6-char code → unconditional counter increment → lockout of the real owner). Fix: split into `checkOtpLock` (pure read) + `incrementOtpAttempt` (pure write, only called on `verifyCode` failure). Canonical 4-condition gate order is enforced at the helper level so no future refactor can re-introduce the counter-inflation path. See ES-090 §b.2 for canonical order + split-primitive signatures + §c.1 U2e-bf..U2k for the structural regression tests.
    - **Trade-off acknowledgment (HP-242):** post-HP-237 + HP-239 fixes, the re-login path remains subject to a **narrower lockout-DoS vector**. An attacker who knows siteId and waits for (or induces) a real owner's fresh OTP request can submit 5 wrong codes within the OTP validity window, tripping `otpLockedUntil` for 15 minutes per §b.9 MED-3 semantics. The real owner's legitimate retry is blocked during the lockout window, replayable indefinitely at 5 POSTs per 15-min cycle per site. This is inherent to brute-force protection: shared lockout semantics across fresh-verify and re-login mean the cost is borne by the real owner, not the service. Mitigations are **ops-level**, not code-level for this sprint: (1) observability — alert on ≥ N `otpAttempts`/`otpLockedUntil` transitions per site per hour (wired via §b.13 OBS-1 Sentry); (2) admin-unlock primitive — `UPDATE geoSites SET otpLockedUntil = NULL, otpAttempts = 0 WHERE id = $1` documented in the support runbook so legitimate owner lockouts can be cleared on request. **Deferred to a later sprint:** code-level hardening (tunable lockout window per path, proof-of-work challenge, per-IP rate-limit cap layered on top of the per-site counter). Accepting this trade-off explicitly — a lockout-DoS is preferable to a no-gate bypass (HP-237) or a counter-inflation-DoS that requires zero evidence of OTP possession (HP-239).
  - **geoSiteView mirror (Amendment 3, Aditya-accepted 2026-04-15):** GET `/api/sites/[id]` reads from the `geoSiteView` read-optimized view, not the `geoSites` base table. Without a `tokenExpiresAt` mirror column on the view, the HP-197 NULL-as-expired code-check at `route.ts:26` sees `undefined` for every request and fails-close with 401 TOKEN_EXPIRED on every authenticated call. Fix: add nullable `tokenExpiresAt` to `geoSiteView` and propagate via `lib/services/site-view-sync.ts` on both full-sync and lightweight-sync paths. See ES-090 §b.1 for schema + sync detail.
- Test: expired token returns 401 at each of the 4 sites; regenerate rotation invalidates old token; **re-login with expired token rotates transparently and returns a usable new token (HP-224)**.

**CRIT-2 — Stored XSS via LLM response through `dangerouslySetInnerHTML`**

- Current state: `app/components/citation-monitor.tsx` defines `renderMd()` at line 10 and feeds its output into `dangerouslySetInnerHTML` at lines **156, 279, 310, 341**. `renderMd` performs markdown-to-HTML transform without sanitization.
- Fix:
  - `npm install dompurify @types/dompurify`
  - Create `lib/utils/sanitize-html.ts` exporting `sanitizeMarkdown(html: string): string` that wraps `DOMPurify.sanitize()` with a hardened config (allow basic inline tags, forbid `<script>`, `<iframe>`, event handlers, and `javascript:` URLs).
  - Replace `renderMd(...)` calls with `sanitizeMarkdown(renderMd(...))` at the 4 cited lines.
- Test: XSS payload (`<img src=x onerror=alert(1)>`, `javascript:` URL in link, `<script>` tag) in LLM answer text renders stripped; benign markdown (bold, italic, links) survives.
- Note: ES-100's references to `app/components/commerce-report/*` are omitted — the directory does not exist on main.

**CRIT-3 — No rate limit on citation-check; credit-drain race**

- Current state: `app/api/sites/[id]/citation-check/route.ts` auth check at line 83; no rate-limit guard. Credit deduction happens in-handler.
- Fix:
  - Immediately after the auth check (line 83+), add:
    ```ts
    const rl = await checkRateLimit(`citation_check:${id}`, 1, 30_000);
    if (!rl.ok) return NextResponse.json({ error: "Too Many Requests" }, { status: 429 });
    ```
  - Follows the existing `checkRateLimit` pattern used at `app/api/chatbot/route.ts:51` and `app/api/auth/otp/send/route.ts:25`.
- Test: two back-to-back requests within 30 s; second returns 429. Credit balance decremented exactly once.

**CRIT-4 — `POST /api/sites` not rate-limited; unbounded SendGrid spam**

- Current state: `app/api/sites/route.ts:47` defines `POST`. Line 52 captures IP from `x-forwarded-for`. Line 54-55 branches into bulk (credit-gated, intentionally IP-rate-limit-free per comment). `checkRateLimit` is imported at line 8 but never invoked.
- Fix:
  - Add IP rate limit at the start of the **single-audit branch only** (i.e., after the `if (bulkUrls !== undefined) { ... return ... }` block). This preserves the existing credit-gated bulk behaviour.
  - Pattern: `const rl = await checkRateLimit("sites_create:" + ip, 10, 60_000); if (!rl.ok) return 429.`
- Test: 11th single-audit POST from same IP inside 60 s returns 429. Bulk submissions unaffected.

**L-2 — Content-Security-Policy header**

- Current state: `middleware.ts:98-106` defines `SECURITY_HEADERS` (X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy, HSTS, X-Permitted-Cross-Domain-Policies). No CSP.
- Fix: Add a `"Content-Security-Policy"` entry to `SECURITY_HEADERS`. Draft policy (must be validated against dashboard / results page / auth flow with DevTools open before shipping):
  ```
  default-src 'self';
  script-src 'self' 'unsafe-inline' 'unsafe-eval';
  connect-src 'self' *.supabase.co *.upstash.io *.sentry.io;
  img-src 'self' data: blob: https:;
  style-src 'self' 'unsafe-inline';
  font-src 'self' data:;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  ```
- Test: open dashboard, results page, verify page, audit submission flow. No CSP-blocked console entries. Dashboard still renders.

**L-1 — `.env*` hygiene**

- Current state: multiple tracked `.env*` files in repo root (`.env.vercel-prod`, etc.). `.gitignore` doesn't block them.
- Fix:
  - Update `.gitignore` to exclude all `.env*` except `.env.example` and `.env.local.supabase`.
  - `git rm --cached` the currently-tracked env files (values are already in Vercel env, redundant on disk).
  - Accept that values remain in history — separate work item to rotate exposed secrets is OUT OF SCOPE of this TS and must be handled manually by Aditya.
  - Add a pre-commit hook (via `.husky/` or similar) rejecting `.env*` files other than allow-listed.
- Test: `git check-ignore .env.vercel-prod` returns true. Pre-commit hook blocks a staged `.env.test` file.

### Class B — Medium hardening

**MED-2 — `PIPELINE_CALLBACK_URL` falls back to `Host` header**

- Current state: `app/api/pipeline/stage/route.ts:1123-1127`:
  ```ts
  const baseUrl =
    process.env.PIPELINE_CALLBACK_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    `https://${req.headers.get("host")}`;
  ```
- Fix: Remove the host-header fallback. Require one of the two env vars to be set. If neither is present, `verifyAuth` returns false (fail-closed). Add a build-time check (in an init module or at the top of the file) that throws if `PIPELINE_CALLBACK_URL` is missing in production.
- Test: Local build with neither env var set fails startup. Request with spoofed `Host` header still verifies against the env-configured URL.

**MED-3 — OTP attempt counter race (select-then-update)**

- Current state: `lib/rate-limit.ts:58-97` selects `otpAttempts` + `otpLockedUntil`, conditionally updates, and returns. Two concurrent calls can both read `otpAttempts = 4`, both increment to 5, one wins — net allowed attempts doubled.
- Fix: Replace with a single atomic statement:
  ```ts
  const [row] = await db.update(geoSites)
    .set({ otpAttempts: sql`${geoSites.otpAttempts} + 1` })
    .where(eq(geoSites.id, siteId))
    .returning({ otpAttempts: geoSites.otpAttempts, otpLockedUntil: geoSites.otpLockedUntil });
  ```
  Then check `row.otpAttempts >= 5` → apply lockout in a second UPDATE (acceptable: lockout write is idempotent).
- Test: concurrent `checkOtpAttempts` calls from two worker threads respect the limit deterministically (run 20 concurrent; count blocked ≥ 15).

**MED-4 — Session tokens returned in JSON body**

- Current state: `app/api/sites/[id]/verify/route.ts:550-556` returns `{ success, siteId, accessToken, authOtp?, email?, exchangeCode? }` as JSON. The client at `app/verify/[id]/page.tsx` calls `supabase.auth.setSession()` on these.
- Fix:
  - Set `accessToken`, Supabase `accessToken`, and `refreshToken` via `NextResponse` cookies with `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=<90d for siteToken, shorter for session>`.
  - Remove the tokens from the JSON body (keep `success`, `siteId`, `redirect`).
  - Refactor `app/verify/[id]/page.tsx` to stop reading tokens from the response. Supabase session is hydrated server-side via cookies on the next request.
- Test: after OTP verify, cookies are set with `HttpOnly; Secure; SameSite=Strict`. Client JS (`document.cookie`) cannot read them. Dashboard navigation loads fully authenticated.
- Risk flag: This change touches the critical OTP → dashboard hydration flow. Must pass the full onboarding integration test suite before merge.

**MED-5 — `activeReextractions` in-process semaphore not cluster-safe**

- Current state: `app/api/sites/[id]/citation-check/route.ts:47-52` uses a module-level `let activeReextractions = 0` counter capped at `MAX_CONCURRENT_REEXTRACTIONS = 3`. Comment at line 48-50 explicitly flags this as v1 and identifies Redis as the intended upgrade path. Test harness at `__test_internals` (lines 55+) imports both `setActiveReextractions` and `getActive`.
- Fix: Replace with a Redis-backed counter using the existing Upstash client pattern.
  - Key: `reextract:global`. Use atomic `INCR` with a TTL (guard against leaked slots).
  - On success → `DECR`. On failure → `DECR` (already the current pattern).
  - Preserve `__test_internals` by routing test mode to an in-memory stub when `process.env.NODE_ENV === "test"`.
- Test: simulate two Vercel instances (two test processes) hitting the route concurrently; total concurrency never exceeds 3.

**MED-6 — Raw `accessToken` in completion email URL**

- Current state: `app/api/pipeline/stage/route.ts:1093-1100`:
  ```ts
  if (completedSite?.ownerEmail && completedSite.accessToken) {
    await sendCompletionEmail(
      completedSite.ownerEmail,
      domain,
      siteId,
      completedSite.accessToken,  // raw token in email link
      ...
    );
  }
  ```
- Fix: Replace the raw `accessToken` argument with a short-lived exchange code via `lib/services/exchange-code.ts` (pattern already used in the verify route at line ~307). Set exchange-code TTL to 7 days. The completion email link becomes `…?code=<exchangeCode>` and the landing page exchanges the code for a session + siteToken on first click.
- Test: completion email link works once; replaying the link after 7 days shows "link expired"; replaying after exchange returns a fresh session on a trusted device.

### Class C — Observability & compliance

**OBS-1 — Observability**

- Current state: No Sentry. No `/api/health`. All pipeline logging via `console.warn` / `console.error`. Manipal "stuck at extracting" incident on 2026-04-09 had no alert — surfaced only by live customer exercise.
- Fix:
  - `npm install @sentry/nextjs`; run `npx @sentry/wizard` or hand-write `sentry.client.config.ts` and `sentry.server.config.ts`.
  - Replace `console.warn` / `console.error` call sites in `app/api/pipeline/stage/route.ts`, `app/api/sites/route.ts`, `app/api/auth/proxy/[...path]/route.ts`, and credit-deduction paths with `Sentry.captureException` or structured breadcrumbs.
  - Add `app/api/health/route.ts`: returns `{ ok, version, uptimeMs, db: "ok"|"fail" }` after a cheap `SELECT 1` against Postgres.
  - Add `/api/health` to `middleware.ts` `ALWAYS_ALLOWED` list so it's not auth-gated.
  - Configure Sentry alerts:
    - pipeline stage failure rate > 5% over 10 min
    - credit deduction error rate > 0
    - auth proxy error rate > 1% over 10 min
  - External uptime monitor (Betterstack or similar) hitting `/api/health` every 60s from two regions.
- Test: health endpoint returns 200 when DB reachable, 503 otherwise. A deliberately-thrown error in `stage` surfaces in Sentry with stage + siteId breadcrumbs.

**COMP-1 — DPDP right-to-erasure**

- Current state: No account-delete route. `team_members`, `geo_sites`, `credit_transactions`, `team_domains`, `consent_records` (schema verified) retain PII indefinitely.
- Fix:
  - `DELETE /api/account` — authenticated by session cookie. Resolves team(s) the user owns; for each:
    - Cascade delete: `geo_sites` (cascade triggers remove per_page rows, crawl chunks, citation responses), `team_domains`, `credit_transactions`, `consent_records`.
    - Soft-anonymize: `geo_crawl_logs.ip` → null, `geo_page_views.ip` → null, `geo_crawl_logs.user_agent` → null.
    - Remove `team_members` rows.
  - Send confirmation email.
  - Write to an admin audit log (new table `admin_audit_log`) with `action = "account_deletion"`, `email`, `deleted_at`.
- Test: delete a fixture account; verify zero rows in all listed tables where the email matches; anonymized logs retain row but null PII.

**COMP-2 — Hash raw IPs**

- Current state: `geo_crawl_logs.ip` and `geo_page_views.ip` (schema-verified columns) store raw IPs indefinitely.
- Fix:
  - Add `ipHash: text("ip_hash")` column alongside existing `ip` (don't drop `ip` in this migration — backfill first).
  - Daily salt: `IP_HASH_KEY` env var; compute `salt = HMAC-SHA256(IP_HASH_KEY, YYYY-MM-DD)`.
  - On insert: `ipHash = SHA256(salt + raw_ip)`; stop writing `raw_ip`.
  - Backfill job: walk existing rows, compute hash using the row's date as salt source, write `ipHash`, null `ip`.
  - After backfill complete + one-week safety window, drop `ip` column (separate follow-up TS).
- Test: new inserts have `ip_hash` populated and `ip = null`. Historical row hashes are stable when re-computed from raw IP + same date salt.

### Hygiene (lowest priority, bundle into one PR)

- Remove `apify-client` from `package.json` (confirm via `grep -rn "apify" lib/ app/ --include="*.ts"` — zero non-doc references expected).
- Remove `mongodb` from devDependencies (same confirmation grep).
- Lazy-load `puppeteer-core` + `@sparticuz/chromium-min` — extract into a dynamic `import()` inside the one function that uses them, so cold-start bundle doesn't pay the cost.
- Replace the `console.log` at `app/api/auth/proxy/[...path]/route.ts:144` with structured `console.info` (or Sentry breadcrumb once OBS-1 lands).
- Verify `vercel.json` has cron definitions for `/api/cron/recrawl` and `/api/cron/process-queue` (grep first; only add if missing).

## 6. Interfaces / contracts

**No new public API surface.** All fixes are either internal hardening (rate limits, sanitization), schema-additive (tokenExpiresAt, ipHash columns), or endpoint additions that don't break existing contracts (/api/health, DELETE /api/account).

**Breaking change in one place**: MED-4 removes `accessToken` / `refreshToken` / `authOtp` from the `POST /api/sites/[id]/verify` JSON response body. Any non-browser consumer relying on that response must migrate to cookies. Verified there are no such consumers in the codebase (`exchangeCode` field remains in body as fallback path).

## 7. Acceptance criteria

ScriptDev may ship in multiple PRs, but the following must all land before TS-090 is considered complete:

- [ ] AC-1 — Schema columns `tokenExpiresAt`, `tokenRotatedAt`, `ipHash` added; migration applied via `drizzle-kit push`; `docker run --rm geo-test` passes.
- [ ] AC-2 — All 4 token-gated routes (`sites/[id]/route.ts:26`, `regenerate/route.ts:29`, `citation-check/route.ts:83`, `competitor-discovery/route.ts:28`) return 401 for expired tokens.
- [ ] AC-3 — `dompurify` installed; `lib/utils/sanitize-html.ts` exports `sanitizeMarkdown`; `citation-monitor.tsx:156,279,310,341` wrap `renderMd()` output. XSS payload test case stripped.
- [ ] AC-4 — `citation_check:${siteId}` rate limit at citation-check route; second call within 30 s returns 429.
- [ ] AC-5 — `sites_create:${ip}` rate limit in single-audit branch of `app/api/sites/route.ts`; 11th POST in 60 s returns 429; bulk path unaffected.
- [ ] AC-6 — `Content-Security-Policy` appears in `SECURITY_HEADERS` in `middleware.ts`; dashboard + results + verify pages load with zero CSP console violations.
- [ ] AC-7 — `.env*` (except allow-listed) removed from tracked files, pre-commit hook rejects new `.env*`.
- [ ] AC-8 — PIPELINE_CALLBACK_URL host-header fallback removed; build fails if env not set in production; signature verification uses env-configured URL.
- [ ] AC-9 — OTP attempt increment is single atomic UPDATE RETURNING; concurrent test (20 parallel) blocks ≥ 15.
- [ ] AC-10 — Verify route sets session + siteToken as HttpOnly cookies; response body no longer contains `accessToken` / `authOtp`; full OTP → dashboard integration test passes.
- [ ] AC-11 — `activeReextractions` replaced with Upstash Redis counter; cross-process concurrency test never exceeds 3 slots.
- [ ] AC-12 — Completion email uses exchange-code; raw `accessToken` no longer appears in any outbound email payload; 7-day TTL enforced.
- [ ] AC-13 — `@sentry/nextjs` installed; `sentry.client.config.ts` + `sentry.server.config.ts` present; a forced error in the pipeline stage handler surfaces in Sentry.
- [ ] AC-14 — `/api/health` returns 200 with DB-connected payload; added to `ALWAYS_ALLOWED` in middleware; external uptime monitor configured.
- [ ] AC-15 — `DELETE /api/account` removes/anonymizes PII across 5 listed tables + logs; confirmation email sent; audit row written.
- [ ] AC-16 — New inserts to `geo_crawl_logs` and `geo_page_views` store `ipHash` (SHA-256 with daily HMAC salt); raw `ip` null going forward; backfill job runs clean.
- [ ] AC-17 — Hygiene bundle: `apify-client` and `mongodb` removed from `package.json`; puppeteer lazy-loaded; stray `console.log` fixed; cron config verified.

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| MED-4 (HttpOnly cookie migration) breaks OTP flow for existing users mid-session | Roll behind a feature flag; run full integration suite; ship behind a staged canary deploy |
| CRIT-2 CSP misconfiguration breaks third-party embeds (Stripe, Supabase) | Start in `Content-Security-Policy-Report-Only` mode for 1 week; review violations; only then switch to enforcing |
| MED-5 Redis counter leak on process crash | Set TTL on the Upstash key (e.g. 5 min) so leaked slots auto-expire; log discrepancies between expected and actual decrements |
| CRIT-1 token expiry bricks active customers whose tokens are about to expire | Backfill `tokenExpiresAt = now + 90 days` for all existing rows at migration time; add email nudge when `tokenExpiresAt < 14 days` |
| COMP-2 backfill writes to `ipHash` race with live inserts | Batch backfill with `LIMIT` + `WHERE ip_hash IS NULL`; new inserts use new path from day one so races don't double-hash |
| L-1 env scrub doesn't purge values from git history | Out of scope; flagged separately to Aditya |

## 9. Out of scope (explicit)

- **ES-087 UX overhaul** — separate branch (`feat/ux-overhaul-es087`), already has its own specs.
- **MED-1 (admin-auth bypass)** — `lib/pipeline-studio/admin-auth.ts` does not exist on main (verified). Refile if/when re-introduced.
- **Commerce-report XSS fixes** — directory does not exist on main. Only `citation-monitor.tsx` is in scope.
- **Secret rotation for values already in git history** — operational work, must be done by Aditya manually.
- **Hiring / onboarding sequencing** — dropped per Aditya's direction on 2026-04-15. Fixes are sequenced by risk class, not by hire timing.

## 10. Notes for SpecMaster

- Every file path, line number, schema field, and symbol in this TS was verified against `origin/main` HEAD `70645cba` on 2026-04-15.
- When writing ES-090, please run the same verifications — if any line drifts by more than ~5 lines by then, re-verify.
- Existing ES-100 on Rao's branch `fix/security-audit-remediation` is an input artifact only; it is superseded by this TS and the forthcoming ES-090. Recommend Rao delete `docs/specs/engineering/ES-100-security-audit-remediation.md` from his branch before merge, or we will delete it post-merge to avoid number collision.
