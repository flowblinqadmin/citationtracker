# Flowblinq GEO — Specification Index

> Canonical registry of all Technical Specs (TS) and Engineering Specs (ES/OPS).
> Maps each spec to its delivery commit, implementation status, and affected areas.
> Maintained by CoFounder agent. Last updated: 2026-03-02.

---

## Summary

| Count | Category |
|-------|----------|
| 16 | Technical Specs (TS) |
| 13 | Engineering / Ops Specs (ES / OPS) |
| 14 | Delivered to production (`origin/main`) |
| 1 | Delivered, awaiting Vercel deploy (`f08c9ea` blocked — see TS-014) |
| 1 | Planned (TS-015, blocked on smoke test re-run) |

---

## Technical Specifications

### TS-001 — M2 Freemium Launch Analysis

| Field | Value |
|-------|-------|
| **File** | `TS-001-m2-freemium-launch-analysis.md` |
| **Status** | Analysis complete — informed TS-002 through TS-007 |
| **Commit** | N/A (strategic analysis, no direct commit) |
| **Author** | CoFounder |
| **Date** | 2026-02-01 |

Pre-sprint analysis of the Flowblinq M2 freemium launch requirements. Identified credit floor,
free-tier gates, URL normalization, and auth proxy as critical prerequisites. Spawned TS-002 through TS-007.

---

### TS-002 — Bulk CSV Audit (M2 Sprint 1)

| Field | Value |
|-------|-------|
| **File** | `TS-002-bulk-csv-audit.md` / `TS-002-m2-sprint1-config-and-gating.md` |
| **Status** | Delivered |
| **Commit** | `2bad500` — `feat(m2): bulk CSV audit, URL normalization, auth proxy, Firecrawl-only pipeline` |
| **Author** | CoFounder → SpecMaster → ScriptDev |

Specifies the bulk CSV upload flow: `POST /api/upload-bulk`, CSV parsing, multi-URL audit pipeline,
team credit deduction (`bulkCreditsRequired`), and the M2 paywall.

**Key files:** `app/api/upload-bulk/route.ts`, `app/page.tsx`, `lib/services/bulk-verify.ts`

---

### TS-003 — M2 Sprint 2: Paywall UX

| Field | Value |
|-------|-------|
| **File** | `TS-003-m2-sprint2-paywall-ux.md` |
| **Status** | Delivered |
| **Commit** | `2bad500` (bundled with Sprint 1 delivery) |

UI components for the credit paywall: upgrade prompt, credit balance display, Pro tier badge.

**Key files:** `components/paywall.tsx`, `app/sites/[id]/page.tsx`

---

### TS-004 — M2 Sprint 3: Security & Ops

| Field | Value |
|-------|-------|
| **File** | `TS-004-m2-sprint3-security-and-ops.md` |
| **Status** | Delivered |
| **Commit** | `507ab9f` — `fix(security): address critical auth proxy, SSRF, and credit-ledger findings` |

Security hardening: SSRF prevention, domain validation, credit ledger race condition fix,
auth proxy input sanitization.

**Key files:** `lib/services/geo-crawler.ts`, `lib/db/schema.ts`, `app/api/auth/[...nextauth]/route.ts`

---

### TS-005 — Sample CSV Template

| Field | Value |
|-------|-------|
| **File** | `TS-005-sample-csv-template.md` |
| **Status** | Delivered |
| **Commit** | `983927a` — `fix: allow /sample-bulk-audit.csv through middleware` |

Static sample CSV served at `/sample-bulk-audit.csv` to guide users on upload format.

**Key files:** `public/sample-bulk-audit.csv`, `middleware.ts`

---

### TS-006 — URL Normalization

| Field | Value |
|-------|-------|
| **File** | `TS-006-url-normalization.md` |
| **Status** | Delivered |
| **Commit** | `2bad500` / `da24ee8` — dedup fix for rebase merge |

`normalizeUrl()` utility: trim whitespace, add https scheme, remove trailing slashes,
remove www prefix for comparison, dedup array. Prevents duplicate site creation.

**Key files:** `lib/utils.ts` (`normalizeUrl`), `app/page.tsx`, `app/api/upload-bulk/route.ts`

---

### TS-007 — Vercel Auth Proxy

| Field | Value |
|-------|-------|
| **File** | `TS-007-vercel-auth-proxy.md` |
| **Status** | Delivered |
| **Commit** | `1d9863d` — `fix(auth,url,csv): ES-007 auth proxy + ES-006 URL normalization + ES-005-sample` |

Auth proxy endpoint (`/api/auth/[...nextauth]/route.ts`) to forward authentication through
Vercel's edge network, bypassing CSRF issues in the M2 deployment.

**Key files:** `app/api/auth/[...nextauth]/route.ts`, `middleware.ts`

---

### TS-008 — Local Docker Staging

| Field | Value |
|-------|-------|
| **File** | `TS-008-local-docker-staging.md` |
| **Status** | Specified, partial delivery |
| **Commit** | N/A (infrastructure; external to geo repo) |

Docker Compose configuration for local staging environment: Next.js app + Supabase + Redis.
Enables testing without hitting production Vercel/Supabase.

---

### TS-009 — Bulk CSV QA

| Field | Value |
|-------|-------|
| **File** | `TS-009-bulk-csv-qa.md` |
| **Status** | Delivered (test suite) |
| **Commit** | Bundled in `2bad500` and subsequent test commits |

QA specification for bulk CSV audit: edge cases (empty file, malformed URLs, duplicates,
oversized CSV), expected error responses, and credit deduction accuracy.

**Key files:** `__tests__/bulk-verify.test.ts`, `__tests__/bulk-config.test.ts`

---

### TS-010 — Pipeline Audit (OPS)

| Field | Value |
|-------|-------|
| **File** | `TS-010-pipeline-audit.md` |
| **Status** | Delivered |
| **Commit** | `14b06c8` — `feat(pipeline): OPS-010 — Firecrawl-only pipeline + chunked batch/scrape` |

Full audit of the GEO pipeline stages: crawl → research → analyze → finalize.
Identified: stage timeout issue, Firecrawl sync for Pro vs async for free,
chunked batch/scrape foundation added.

**Key files:** `app/api/pipeline/stage/route.ts`, `lib/services/chunked-firecrawl.ts`

---

### TS-011 — Single Audit Pro Gate Hotfix

| Field | Value |
|-------|-------|
| **File** | `TS-011-single-audit-pro-gate-hotfix.md` |
| **Status** | Delivered |
| **Commit** | `233ac6c` — `hotfix: restore Pro gate on single-audit path (TS-011)` |

The Pro gate was accidentally removed from the single-audit path during a rebase.
This hotfix restores `requiresPro()` check on `POST /api/sites` for free-tier users.

**Key files:** `app/api/sites/route.ts`

---

### TS-012 — Firecrawl Limits Audit

| Field | Value |
|-------|-------|
| **File** | `TS-012-firecrawl-limits-audit.md` |
| **Status** | Delivered (analysis + config) |
| **Commit** | `53a588a` — `feat(pipeline): crawl mode abstraction — firecrawl sync for Pro, async-only for free` |

Audit of Firecrawl API rate limits and concurrency constraints. Outcome: crawl mode
abstraction (`getCrawlMode`) — sync scrape for Pro (fast), async crawl for free (slower, cheaper).

**Key files:** `lib/config.ts` (`BULK_CHUNKING_THRESHOLD`, `getCrawlMode`), `lib/services/geo-crawler.ts`

---

### TS-013 — Pro Tier Display Fix

| Field | Value |
|-------|-------|
| **File** | `TS-013-pro-tier-display-fix.md` |
| **Status** | Delivered |
| **Commit** | `f25466d` — `hotfix: fix Pro tier display for 0-credit users (TS-013)` |

Users with 0 credits were incorrectly shown as "Free" tier despite being Pro.
Fix: `isPro` derived from `teamId` presence (team association), not `creditBalance > 0`.

**Key files:** `app/sites/[id]/page.tsx`, `components/pro-badge.tsx`

---

### TS-014 — Bulk Crawl Batch/Scrape

| Field | Value |
|-------|-------|
| **File** | `TS-014-bulk-crawl-batch-scrape.md` |
| **Status** | Committed to `origin/main`; **Vercel deploy blocked** (see note) |
| **Commit** | `f08c9ea` — `feat(ES-014): handleCrawlBulk branching — batch/scrape for ≤500 URLs` |
| **Author** | CoFounder → SpecMaster → ScriptDev |

Core bulk audit improvement: for ≤500 URLs, skip the domain spider (`asyncCrawlUrl`) and
use Firecrawl's `POST /v1/batch/scrape` to scrape exact URLs directly. Eliminates the
"0 usable pages" failure for deep-linked URL sets (e.g., hospital specialty pages).

**Vercel note:** `f08c9ea` was pushed by `ANittur` account; Vercel rejects it because
ANittur is not in the `adithya-raos-projects` Vercel team. See GitHub issue #105.

**DB dependency:** Requires `firecrawl_jobs` table (migration #100) — see GitHub issue #106.

**Key files:** `app/api/pipeline/stage/route.ts` (`handleCrawlBulk`),
`lib/services/chunked-firecrawl.ts`, `lib/db/schema.ts` (`firecrawlJobs`)

---

### TS-015 — AI Citation Monitoring

| Field | Value |
|-------|-------|
| **File** | `TS-015-ai-citation-monitoring.md` |
| **Status** | Spec written; **blocked** on smoke test re-run (TS-014 deploy + migration #100) |
| **Commit** | N/A (not implemented yet) |
| **Author** | CoFounder |
| **Date** | 2026-03-02 |

New feature: check whether the brand/domain is cited by ChatGPT, Claude, Perplexity, and
Gemini when users ask relevant queries. Surfaces as "AI Visibility" tab on `/sites/[id]`.
5 credits per check. SSE streaming. Results persisted to `citation_checks` table.

**New dependencies:** `PERPLEXITY_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`
**DB dependency:** `citation_checks` table (migration #101)
**GitHub issue:** #104

---

## Engineering Specifications

### ES-002 — M2 Sprint 1: Config & Gating

| Field | Value |
|-------|-------|
| **File** | `ES-002-m2-sprint1-config-and-gating.md` |
| **Commit** | `2bad500` |

Implementation details for credit floor, free-tier gate, `bulkCreditsRequired()` formula.

---

### ES-003 — M2 Sprint 2: Paywall UX

| Field | Value |
|-------|-------|
| **File** | `ES-003-m2-sprint2-paywall-ux.md` |
| **Commit** | `2bad500` |

Component specs for paywall UI: upgrade modal, credit display, Pro badge.

---

### ES-004 — M2 Sprint 3: Security & Ops

| Field | Value |
|-------|-------|
| **File** | `ES-004-m2-sprint3-security-and-ops.md` |
| **Commit** | `507ab9f` |

Implementation details for SSRF fix, credit race fix, domain validation.

---

### ES-005 — M2 Bulk CSV Audit (Implementation)

| Field | Value |
|-------|-------|
| **File** | `ES-005-m2-bulk-csv-audit.md` |
| **Commit** | `2bad500` / `1d9863d` |

Full implementation spec: `upload-bulk` route, CSV parsing, bulk pipeline trigger,
`bulkCreditsRequired` deduction, site-group model.

---

### ES-005b — Sample CSV Template

| Field | Value |
|-------|-------|
| **File** | `ES-005-sample-csv-template.md` |
| **Commit** | `983927a` |

Static file deployment + middleware allowlist for `/sample-bulk-audit.csv`.

---

### ES-006 — URL Normalization

| Field | Value |
|-------|-------|
| **File** | `ES-006-url-normalization.md` |
| **Commit** | `2bad500` / `da24ee8` |

Implementation of `normalizeUrl()` in `lib/utils.ts`.

---

### ES-007 — Vercel Auth Proxy

| Field | Value |
|-------|-------|
| **File** | `ES-007-vercel-auth-proxy.md` |
| **Commit** | `1d9863d` |

Auth proxy implementation at `app/api/auth/[...nextauth]/route.ts`.

---

### ES-008 — Local Docker Staging

| Field | Value |
|-------|-------|
| **File** | `ES-008-local-docker-staging.md` |
| **Commit** | N/A (infrastructure) |

Docker Compose spec for local dev environment.

---

### ES-009 — Bulk CSV QA

| Field | Value |
|-------|-------|
| **File** | `ES-009-bulk-csv-qa.md` |
| **Commit** | `2bad500` + test commits |

Test cases and validation logic for bulk CSV audit.

---

### ES-011 — Single Audit Pro Gate Hotfix

| Field | Value |
|-------|-------|
| **File** | `ES-011-single-audit-pro-gate-hotfix.md` |
| **Commit** | `233ac6c` |

Implementation of `requiresPro()` re-insertion in single-audit route.

---

### ES-013 — Pro Tier Display Fix

| Field | Value |
|-------|-------|
| **File** | `ES-013-pro-tier-display-fix.md` |
| **Commit** | `f25466d` |

Implementation: `isPro = !!teamId` instead of `creditBalance > 0`.

---

### ES-014 — Bulk Crawl Batch/Scrape

| Field | Value |
|-------|-------|
| **File** | `ES-014-bulk-crawl-batch-scrape.md` |
| **Commit** | `f08c9ea` |

Implementation of `handleCrawlBulk` branching + `submitChunkedBatchScrape` in
`lib/services/chunked-firecrawl.ts`. `firecrawlJobs` schema in `lib/db/schema.ts`.

---

### OPS-010 — Pipeline Audit

| Field | Value |
|-------|-------|
| **File** | `OPS-010-pipeline-audit.md` |
| **Commit** | `14b06c8` |

Pipeline stage-by-stage audit. Foundation for TS-014 chunked scrape approach.

---

### OPS-012 — Firecrawl Limits Audit

| Field | Value |
|-------|-------|
| **File** | `OPS-012-firecrawl-limits-audit.md` |
| **Commit** | `53a588a` |

API limits documentation and crawl mode abstraction rationale.

---

### OPS-013 — Credits Provisioning

| Field | Value |
|-------|-------|
| **File** | `OPS-013-credits-provision.md` |
| **Commit** | N/A (operational task, Supabase direct) |

10,000 credits provisioned for `an@flowblinq.com` (2026-03-02). Completed.

---

## Pending Migrations

| Migration | Description | Status |
|-----------|-------------|--------|
| #100 | `CREATE TABLE firecrawl_jobs` | **Pending** — blocked on Adithya Rao (issue #106) |
| #101 | `CREATE TABLE citation_checks` | **Planned** — part of TS-015 / ES-015 |

---

## Open GitHub Issues (Sprint 7)

| Issue | Title | Priority |
|-------|-------|----------|
| #95 | Re-run 5-URL Manipal smoke test | P0 — blocked on #105 + #106 |
| #96 | 100-URL Manipal test | P0 — blocked on #95 |
| #97 | ZIP verification | P1 |
| #101 | OTP rate limiter (security) | P1 |
| #102 | batchId column security | P1 |
| #104 | TS-015: AI Citation Monitoring | P1 — blocked on smoke test |
| #105 | Add ANittur to Vercel team | P0 — blocks #95, #96 |
| #106 | Run DB migration #100 (firecrawl_jobs) | P0 — blocks #95, #96 |

---

_Maintained by CoFounder (Agent 1) | Flowblinq Sprint 7 | 2026-03-02_
