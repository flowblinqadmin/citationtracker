# ES-100 — Security & Production Readiness Remediation Plan

**Audit Date:** 2026-04-12
**Overall Score:** 6.2/10
**Target Score:** 8.5/10 (post-remediation)

---

## Phase 1 — Pre-Hire Blockers (Fix Before Onboarding Senior Engineers)

**Estimated total effort: 2–3 days**

### CRIT-1: accessToken Has No Expiry — Permanent Cross-Tenant Access

- [ ] Add `tokenExpiresAt` column to `geoSites` in `lib/db/schema.ts`
- [ ] Run `npx drizzle-kit push` to apply migration
- [ ] Set `tokenExpiresAt = now + 90 days` in `app/api/sites/[id]/verify/route.ts` at token creation
- [ ] Enforce expiry check in `app/api/sites/[id]/route.ts:26-28`
- [ ] Enforce expiry check in `app/api/sites/[id]/regenerate/route.ts:29`
- [ ] Enforce expiry check in `app/api/sites/[id]/citation-check/route.ts:83`
- [ ] Enforce expiry check in `app/api/sites/[id]/competitor-discovery/route.ts`
- [ ] Rotate token on regenerate action
- [ ] Add test: expired token returns 401

**Effort:** 4–6 hours
**Risk:** CRITICAL — leaked token = permanent cross-tenant read access
**CWE:** CWE-613

---

### CRIT-2: XSS via LLM Response in dangerouslySetInnerHTML

- [ ] `npm install dompurify @types/dompurify`
- [ ] Create `lib/utils/sanitize-html.ts` wrapper around DOMPurify
- [ ] Fix `app/components/citation-monitor.tsx:156, 279, 310, 341` — wrap `renderMd()` output with `DOMPurify.sanitize()`
- [ ] Fix `app/components/commerce-report/competitive-landscape.tsx:365`
- [ ] Fix `app/components/commerce-report/agent-simulation.tsx:444, 472`
- [ ] Fix `app/components/commerce-report/commerce-verdict.tsx:73`
- [ ] Add test: XSS payload in `renderMd()` is stripped

**Effort:** 2–3 hours
**Risk:** CRITICAL — attacker-controlled website → stored XSS → session theft
**CWE:** CWE-79

---

### CRIT-3: No Rate Limit on Citation Check — Credit Drain Race

- [ ] Add `checkRateLimit("citation_check:" + siteId, 1, 30_000)` at top of `app/api/sites/[id]/citation-check/route.ts`
- [ ] Add test: second request within 30s returns 429

**Effort:** 30 minutes
**Risk:** CRITICAL — concurrent requests race the credit deduction
**CWE:** CWE-770

---

### CRIT-4: POST /api/sites Has No Rate Limit — Unbounded Email Spam

- [ ] Add `checkRateLimit("sites_create:" + ip, 10, 60_000)` at line 49 of `app/api/sites/route.ts`
- [ ] Add test: 11th request within 60s returns 429

**Effort:** 30 minutes
**Risk:** CRITICAL — 10K POST requests = 10K SendGrid emails, domain reputation burned
**CWE:** CWE-770

---

### L-2: Add Content-Security-Policy Header

- [ ] Add CSP to `middleware.ts` security headers block (~line 100): `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' *.supabase.co *.upstash.io; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self';`
- [ ] Test: verify no console errors from CSP on dashboard, results page, auth flow

**Effort:** 1 hour
**Risk:** LOW — browser-level backstop for CRIT-2 XSS

---

### L-1: Clean .env Files from Git History

- [ ] Update `.gitignore` to exclude all `.env*` except `.env.example` and `.env.local.supabase`
- [ ] Remove `.env.vercel`, `.env.vercel-prod`, `.env.production`, `.env.prod`, `.env.vercel-preview`, `.env.vercel-latest` from tracked files
- [ ] Run `git filter-repo` to purge from history (or accept they're in history and focus on prevention)
- [ ] Add pre-commit hook to reject `.env*` files

**Effort:** 1 hour
**Risk:** LOW — normalizes bad habit, prevents future secret leak

---

## Phase 2 — Assign to New Engineers (First Tickets)

**Estimated total effort per item: 1–4 hours each**

### MED-1: Admin Route Auth Bypass on Preview Branches

- [ ] Remove `NODE_ENV !== "production"` bypass in `lib/pipeline-studio/admin-auth.ts:12`
- [ ] Require `ADMIN_SECRET` header in all environments
- [ ] Set `ADMIN_SECRET` in Vercel preview environment variables
- [ ] OR: Enable Vercel Deployment Protection for preview branches

**Effort:** 1 hour
**Risk:** MEDIUM — preview URL = full admin access to prod DB reads

---

### MED-2: Pipeline Auth Falls Back to Host Header

- [ ] Make `PIPELINE_CALLBACK_URL` a required env var in `app/api/pipeline/stage/route.ts:1141-1143`
- [ ] Throw startup error if not set (or use build-time validation)
- [ ] Remove `req.headers.get("host")` fallback
- [ ] Verify `PIPELINE_CALLBACK_URL` is set in Vercel prod environment

**Effort:** 30 minutes
**Risk:** MEDIUM — Host header spoofing could forge QStash signatures (mitigated by Vercel network)

---

### MED-3: OTP Increment Race Condition

- [ ] Replace `SELECT then UPDATE` in `lib/rate-limit.ts:52-89` with single atomic `UPDATE geo_sites SET otp_attempts = otp_attempts + 1 WHERE id = $1 RETURNING otp_attempts, otp_locked_until`
- [ ] Add test: concurrent OTP verify calls respect attempt limit

**Effort:** 1 hour
**Risk:** MEDIUM — allows ~2x intended OTP attempts under concurrency
**CWE:** CWE-362

---

### MED-5: In-Process Semaphore Not Cross-Instance Safe

- [ ] Replace `activeReextractions` module-level counter in `app/api/sites/[id]/citation-check/route.ts:51-52`
- [ ] Use Upstash Redis atomic counter (`@upstash/redis` already available via QStash dependency)
- [ ] OR: Use DB-backed semaphore with `SELECT FOR UPDATE`
- [ ] Set global max to 3 concurrent re-extractions across all Vercel instances

**Effort:** 2–3 hours
**Risk:** MEDIUM — 10 instances × 3 = 30 concurrent LLM calls instead of 3

---

### MED-6: accessToken Sent Raw in Completion Email URL

- [ ] Replace raw `accessToken` in email link (`app/api/pipeline/stage/route.ts:1108-1114`) with short-lived JWT via `lib/services/exchange-code.ts`
- [ ] Set JWT expiry to 7 days
- [ ] Add exchange route if not already present
- [ ] Test: email link works, expired JWT shows "link expired" message

**Effort:** 2 hours
**Risk:** MEDIUM — email links logged by SendGrid + scanned by corporate email gateways

---

### MED-4: Session Tokens in JSON Response Body

- [ ] Refactor `app/api/sites/[id]/verify/route.ts:550-556` to set session tokens as `HttpOnly; Secure; SameSite=Strict` cookies
- [ ] Update client-side `app/verify/[id]/page.tsx` to remove `supabase.auth.setSession()` call
- [ ] Use server-side cookie read instead
- [ ] Test: full OTP verify → dashboard flow works with cookies

**Effort:** 4–8 hours (requires client auth flow refactor)
**Risk:** MEDIUM — any JS on the page (including XSS) can read tokens from response body
**CWE:** CWE-312

---

## Phase 3 — Post-Hire Infrastructure (First Project for Senior Engineers)

### OBS-1: Observability Setup

- [ ] Add Sentry: `npm install @sentry/nextjs`, configure `sentry.client.config.ts` + `sentry.server.config.ts`
- [ ] Replace all `console.warn`/`console.error` in pipeline stage handler with structured Sentry breadcrumbs
- [ ] Add Sentry alerts for: pipeline failure rate > 5%, credit deduction error, auth proxy error
- [ ] Add `/api/health` endpoint: check DB connectivity, return uptime + version
- [ ] Configure Betterstack/Datadog uptime monitor hitting `/api/health`
- [ ] Add structured logging with log levels (info/warn/error) gated by environment

**Effort:** 2–3 days
**Risk:** HIGH impact — currently flying blind in production
**Score impact:** Observability 2/10 → 7/10

---

### COMP-1: DPDP Data Deletion Endpoint

- [ ] Create `DELETE /api/account` or `DELETE /api/teams/[id]` endpoint
- [ ] Delete: geoSites (cascade), teamMembers, teamDomains, creditTransactions, consentRecords
- [ ] Anonymize: geoCrawlLogs, geoPageViews (set IP/email to null)
- [ ] Send confirmation email
- [ ] Add admin audit log entry
- [ ] Test: deletion removes all PII, returns 200

**Effort:** 4–6 hours
**Risk:** MEDIUM — DPDP right-to-erasure requirement

---

### COMP-2: Hash Raw IPs

- [ ] Change `geoCrawlLogs.ip` and `geoPageViews.ip` to store `SHA-256(ip + daily_salt)` instead of raw IP
- [ ] Generate daily salt from `HMAC(date, IP_HASH_KEY)` env var
- [ ] Update tracking routes to hash before insert
- [ ] Backfill existing raw IPs (or truncate if data not needed)

**Effort:** 2 hours
**Risk:** LOW — DPDP personal data compliance

---

## Phase 4 — Cleanup & Hygiene

- [ ] Remove `apify-client` from `package.json` (Apify fully removed from codebase)
- [ ] Remove `mongodb` from devDependencies (no MongoDB usage)
- [ ] Evaluate moving `puppeteer-core` + `@sparticuz/chromium-min` to lazy-loaded serverless function
- [ ] Fix `console.log` in `app/api/auth/proxy/[...path]/route.ts:144` → use `console.info` with structured format
- [ ] Verify `vercel.json` cron configuration exists for `/api/cron/recrawl` and `/api/cron/process-queue`
- [ ] Add `/api/health` to middleware `ALWAYS_ALLOWED`

---

## Score Projections

| Dimension | Current | After Phase 1 | After Phase 2 | After Phase 3 |
|---|---|---|---|---|
| Multi-tenant isolation | 5/10 | 7/10 | 9/10 | 9/10 |
| Pipeline consistency | 8/10 | 8/10 | 9/10 | 9/10 |
| Rate limiting / DDoS | 5/10 | 8/10 | 8/10 | 8/10 |
| Observability | 2/10 | 2/10 | 2/10 | 7/10 |
| Security (OWASP) | 6/10 | 8/10 | 9/10 | 9/10 |
| Compliance | 4/10 | 5/10 | 6/10 | 8/10 |
| **Overall** | **6.2** | **7.2** | **7.8** | **8.5** |

---

## Decision Summary

**Hire now.** Fix Phase 1 (2–3 days) before onboarding. Phase 2 items make excellent first tickets for new engineers. Phase 3 (observability) is the ideal first project for a senior infrastructure hire.
