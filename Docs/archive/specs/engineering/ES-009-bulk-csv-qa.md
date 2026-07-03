# ES-009: Bulk CSV QA Test Suite

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#95](https://github.com/flowblinqadmin/geo/issues/95) · [#96](https://github.com/flowblinqadmin/geo/issues/96) · [#97](https://github.com/flowblinqadmin/geo/issues/97)  
> **Delivery Commit:** `2bad500`  

---

**Source:** TS-009-bulk-csv-qa.md
**Agent:** 2-SpecMaster
**Date:** 2026-03-01
**Downstream:** ReviewMaster (agent 9) — test suite generation
**GitHub Issues:** #95 (smoke), #96 (load), #97 (ZIP integrity)
**Milestone:** Launch: 1st Customer — Manipal Hospitals
**Depends on:** ES-005-m2-bulk-csv-audit.md (implementation on `dev-an-m2-extended`)
**Branch:** `dev-an-m2-extended`
**Repo:** flowblinqadmin/geo (local: `/home/aditya/flowblinq/geo`)

---

## a) Overview

### What This Covers

A three-tier integration test suite for the Bulk CSV Audit pipeline implemented in ES-005:

- **Tier 1 — Smoke** (issue #95): 5-URL end-to-end correctness (7 tests)
- **Tier 2 — Load** (issue #96): 100-URL batch scale validation (7 tests)
- **Tier 3 — ZIP Integrity** (issue #97): ZIP assembly and download (7 tests)
- **Edge cases**: 6 boundary/failure scenarios

Tests are integration tests — they hit real API routes, real Supabase, and real Firecrawl (staging keys). Each tier must be runnable independently.

### Current Implementation State

Per ES-005, the following are implemented on `dev-an-m2-extended`:
- `app/api/bulk-audit/upload/route.ts` — CSV parse + validate, create geoSites row (`auditMode: "bulk"`)
- `app/api/bulk-audit/process/route.ts` — Fan-out per URL, enqueue QStash crawl jobs
- `app/api/bulk-audit/status/[jobId]/route.ts` — Poll job state via geoSites columns
- `app/api/bulk-audit/zip/[jobId]/route.ts` — Assemble reports, build ZIP, upload to Supabase Storage
- `lib/db/schema.ts` — geoSites extended with: `auditMode`, `bulkUrls`, `bulkUrlCount`, `crawlLimit`, `creditsReserved`, `perPageResults`, `reportZipUrl`
- `lib/services/per-page-analyzer.ts`, `report-generator.ts`, `zip-builder.ts`
- Credit lifecycle: `"bulk_crawl_reserve"` and `"bulk_crawl_refund"` transaction types

**What does NOT exist yet:** test directory, fixture CSVs, test helpers. ReviewMaster creates all of these.

---

## b) Implementation Requirements

### File layout (ReviewMaster creates all of these)

```
tests/
  integration/
    bulk-csv-qa/
      fixtures/
        smoke-5urls.csv          # 5 valid URLs (mix of Manipal subpages + known-good external)
        load-100urls.csv         # 100 Manipal sitemap URLs
        invalid-urls.csv         # malformed entries (no scheme, spaces, gibberish)
        duplicate-urls.csv       # 3 URLs with 2 duplicates (total 5 rows, 3 unique)
      helpers/
        test-client.ts           # HTTP client wrapper (fetch to localhost:3030 or TEST_BASE_URL)
        db-helpers.ts            # Supabase test client, query helpers, cleanup
        wait-helpers.ts          # pollUntil(fn, timeout, interval) utility
        credit-helpers.ts        # credit balance read/write for test setup/teardown
      smoke/
        smoke.test.ts            # Tier 1 — S1–S7
      load/
        load.test.ts             # Tier 2 — L1–L7
      zip/
        zip.test.ts              # Tier 3 — Z1–Z7
      edge/
        edge.test.ts             # Edge cases E1–E6
      setup/
        global-setup.ts          # env validation, test account setup, credit seeding
        global-teardown.ts       # cleanup geoSites rows, storage files, credit transactions
```

### Environment variables required (`.env.test`)

```
TEST_BASE_URL=http://localhost:3030   # or staging URL
TEST_SUPABASE_URL=...
TEST_SUPABASE_SERVICE_KEY=...         # service role key for direct DB access in tests
TEST_USER_EMAIL=qa-bulk@flowblinq.com
TEST_USER_PASSWORD=...
TEST_FIRECRAWL_API_KEY=...
CREDITS_SEED_AMOUNT=500               # credits to seed before each tier
```

### Type interfaces (in helpers)

```ts
// helpers/test-client.ts
export interface UploadResponse {
  jobId: string;
  urlCount: number;
  creditsReserved: number;
}

export interface StatusResponse {
  jobId: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  completedCount: number;
  totalCount: number;
  failedUrls?: string[];
}

export interface ZipResponse {
  downloadUrl: string;       // signed Supabase Storage URL
  expiresAt: string;         // ISO-8601
  fileCount: number;
}
```

### Helper contracts

```ts
// helpers/db-helpers.ts
export async function getJobRow(jobId: string): Promise<GeoSitesRow>
export async function getUrlResults(jobId: string): Promise<PerPageResult[]>
export async function getCreditBalance(teamId: string): Promise<number>
export async function getCreditTransactions(teamId: string, type?: string): Promise<CreditTransaction[]>
export async function cleanupJob(jobId: string): Promise<void>  // deletes geoSites row + storage files

// helpers/wait-helpers.ts
export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  predicate: (result: T) => boolean,
  timeoutMs: number,
  intervalMs: number
): Promise<T>  // throws on timeout

// helpers/credit-helpers.ts
export async function seedCredits(teamId: string, amount: number): Promise<void>
export async function getCredits(teamId: string): Promise<number>
```

---

## c) Unit Test Plan

> Unit tests are out of scope for this spec. The bulk CSV pipeline is tested at the integration level to validate real Supabase state, real QStash fan-out, and real Firecrawl responses. Mocking these would not catch the stuck-state and concurrency bugs that matter most.
>
> If ReviewMaster adds unit tests for helpers (e.g., CSV parser, credit arithmetic), they should go in `tests/unit/bulk-csv/`.

---

## d) Integration Test Plan

### Test file: `tests/integration/bulk-csv-qa/smoke/smoke.test.ts` (Issue #95)

```
describe("Tier 1 — Smoke: 5-URL end-to-end", () => {
  let jobId: string;
  let teamId: string;
  let creditsBefore: number;

  beforeAll(async () => {
    // seed 500 credits to test account
    // authenticate and get teamId
  });

  afterAll(async () => {
    // cleanupJob(jobId)
  });
```

| Test ID | Test name | Setup | Assertion |
|---------|-----------|-------|-----------|
| S1 | Upload valid 5-URL CSV | POST /api/bulk-audit/upload with smoke-5urls.csv | `status 200`, response has `jobId` (non-empty string), geoSites row exists with `auditMode = "bulk"`, `bulkUrlCount = 5` |
| S2 | Pipeline fan-out (not serial) | Wait 5s after S1 | Query geoSites / job status; verify multiple URLs in `processing` state simultaneously (not one-at-a-time queue drain). Check QStash enqueue count via status endpoint's `processingCount > 1` within 10s |
| S3 | All URLs reach `completed` | pollUntil status.status === "completed", timeout 120s | No URL in `crawling` or `processing` after timeout; `completedCount + failedCount === totalCount` |
| S4 | Audit output per URL present | After S3 | For each completed URL: per-page result exists in DB (`perPageResults` array non-empty); Supabase Storage has corresponding report file |
| S5 | No Vercel function timeouts | Parallel with S3 | No HTTP 504 from any API route during the run (capture all responses in test client) |
| S6 | Credit reserve → reconcile | Before S1 record `creditsBefore`; after S3 | `creditTransactions` has one `"bulk_crawl_reserve"` row for this job; after completion, `"bulk_crawl_refund"` or `"bulk_crawl_debit"` reconciles to actual pages crawled; final credit balance = `creditsBefore - actualPagesUsed / PAGES_PER_CREDIT` |
| S7 | Job overall status = `completed` | After S3 | `GET /api/bulk-audit/status/{jobId}` returns `{ status: "completed" }` |

**Timeout budget:** 120 seconds total for 5-URL smoke run.

---

### Test file: `tests/integration/bulk-csv-qa/load/load.test.ts` (Issue #96)

```
describe("Tier 2 — Load: 100-URL batch", () => {
  // Separate job from smoke tier — uses load-100urls.csv
  // Seed 1000 credits before run
```

| Test ID | Test name | Assertion |
|---------|-----------|-----------|
| L1 | Upload 100-URL CSV accepted | POST /api/bulk-audit/upload returns 200 within 10s; no upload timeout |
| L2 | Concurrency — not serial | Within 30s of upload, ≥5 URLs simultaneously in `processing` state |
| L3 | Completion rate ≥95% | After pollUntil(completed or failed, 600s timeout): `completedCount / totalCount ≥ 0.95`; each `failedUrl` has a non-empty `errorReason` in DB |
| L4 | No cold-start cascade timeouts | No HTTP 504 on any API call during run; zero entries in `failedUrls` with reason containing "timeout" after first 60s |
| L5 | Throughput benchmark (log only) | Record `startTime` at upload; record `endTime` when all complete; log `totalMs`, `urlsPerMinute` — no pass/fail gate |
| L6 | ZIP generates after batch | After L3: POST /api/bulk-audit/zip/{jobId} returns 200 with valid `downloadUrl` |
| L7 | Credit reconciliation at scale | Final `creditBalance === seedAmount - ceil(completedCount / PAGES_PER_CREDIT)` — within ±1 credit rounding tolerance |

**Timeout budget:** 600 seconds (10 minutes) for 100-URL load run.

---

### Test file: `tests/integration/bulk-csv-qa/zip/zip.test.ts` (Issue #97)

```
describe("Tier 3 — ZIP Integrity", () => {
  // Uses completed jobs from smoke (5-URL) and load (100-URL) tiers
  // Must run after smoke and load tiers, or re-create jobs in setup
```

| Test ID | Test name | Assertion |
|---------|-----------|-----------|
| Z1 | ZIP structure — one file per URL | Download ZIP; extract in memory via jszip; `zip.files` count === `completedCount`; each filename is URL-slug derived (no blank entries) |
| Z2 | File format valid | Each file in ZIP: non-empty, parseable as UTF-8 HTML (contains `<html` or `<!DOCTYPE`), not truncated (> 200 bytes) |
| Z3 | Partial failure — ZIP still generates | Use edge case job with 1 forced failure; ZIP generates for remaining N-1; failed URL absent from ZIP but present in `failedUrls`; no 500 error |
| Z4 | Large ZIP — storage succeeds | 100-URL ZIP uploads to Supabase Storage without error; Storage file exists at `reportZipUrl` |
| Z5 | Download link validity | Signed URL returns HTTP 200; `Content-Type: application/zip`; `expiresAt` is ≥ 24 hours from now |
| Z6 | Re-download works | Fetch same signed URL twice; both return 200 with identical `Content-Length` (not single-use) |
| Z7 | Cross-platform ZIP format | `zip.files` entries use standard deflate (compression method 8) or stored (0); no proprietary extension fields; ZIP opens on macOS and Windows (validated structurally — no `.DS_Store`, no extra field corruption) |

---

### Test file: `tests/integration/bulk-csv-qa/edge/edge.test.ts`

| Test ID | Edge case | Setup | Assertion |
|---------|-----------|-------|-----------|
| E1 | Duplicate URLs in CSV | Upload duplicate-urls.csv (5 rows, 3 unique) | Job created with `bulkUrlCount = 3` (deduplicated); credits reserved for 3, not 5 |
| E2 | Invalid/malformed URLs | Upload invalid-urls.csv (mix of valid + malformed) | HTTP 400 or partial acceptance with `invalidUrls` list in response; pipeline only starts for valid URLs |
| E3 | CSV with 0 valid URLs | Upload CSV containing only malformed rows | HTTP 400 before job creation; no geoSites row created; no credits reserved |
| E4 | URL returns 404 during crawl | Include a known 404 URL in a smoke-like job | That URL marked `failed` with `errorReason: "crawl_failed"` or similar; job continues for other URLs; no stuck state |
| E5 | Concurrent upload by same user | Upload two CSVs in rapid succession (< 1s apart) | Second upload either returns 429 / queued state OR creates a separate job — must NOT silently overwrite the first job's row |
| E6 | Free user submits CSV | Attempt CSV upload with unauthenticated / free-tier user | HTTP 402 response; error message contains "Pro account" or equivalent; no job created; no credits deducted |

---

## e) Profiling Requirements

- **What to measure:** Time from CSV upload (POST /api/bulk-audit/upload) to job completion (`status = "completed"`) for both 5-URL and 100-URL batches.
- **Baseline expectation:** 5-URL smoke < 120s; 100-URL load < 600s.
- **Tool:** Record `Date.now()` at upload and completion in test code. Log result as `[THROUGHPUT] 5-URL: Xms | 100-URL: Yms | urls/min: Z` using `console.info` so CI captures it.
- **No automated pass/fail gate on throughput** — L5 is log-only. Gate activates when Manipal scale run is planned (TS-011).

---

## f) Load Test Plan

Covered by Tier 2 (load.test.ts). The 100-URL batch IS the load test at this stage. Full load testing at Manipal scale (8000 URLs) is deferred to TS-011 after pipeline audit (TS-010) completes.

**Concurrency validation (L2):** The test must confirm QStash fan-out is genuinely concurrent. Acceptance: within 30 seconds of upload, at least 5 URLs simultaneously report `processing` state in the DB.

---

## g) Logging & Instrumentation

### Events ReviewMaster should assert are logged (check server logs in test env)

| Event | Log level | What to check |
|-------|-----------|---------------|
| CSV uploaded | `info` | `[bulk-audit] CSV uploaded: jobId={id} urlCount={n}` |
| Fan-out started | `info` | `[bulk-audit] Enqueuing {n} jobs for jobId={id}` |
| Per-URL completion | `info` | `[bulk-audit] URL {url} completed for jobId={id}` |
| Per-URL failure | `warn` | `[bulk-audit] URL {url} failed: {reason} for jobId={id}` |
| ZIP generation | `info` | `[bulk-audit] ZIP generated: {fileCount} files, {sizeBytes} bytes for jobId={id}` |
| Credit reconcile | `info` | `[bulk-audit] Credits reconciled: reserved={n} used={m} refunded={r} for jobId={id}` |

ReviewMaster should check that at least the `info` log lines appear in test output (capture via `console.info` spy or server log file in test env). Hard assertion on credit reconcile log line — confirms billing path ran.

---

## h) Acceptance Criteria

- [ ] `tests/integration/bulk-csv-qa/` directory created with all files per the layout above
- [ ] `tests/integration/bulk-csv-qa/fixtures/` contains all 4 fixture CSVs
- [ ] Each tier runnable in isolation: `vitest run tests/integration/bulk-csv-qa/smoke`, `...load`, `...zip`, `...edge`
- [ ] `vitest run tests/integration/bulk-csv-qa` runs all tiers sequentially
- [ ] S1–S7 all pass (5-URL smoke)
- [ ] L1–L4, L6–L7 pass; L5 throughput logged
- [ ] Z1–Z7 all pass
- [ ] Edge cases E1–E6 all pass
- [ ] Z3 (partial failure ZIP) explicitly verified — critical acceptance gate
- [ ] Credit reserve/reconcile asserted at both 5-URL and 100-URL scale (S6 and L7)
- [ ] No Vercel function timeouts in any test run (S5, L4)
- [ ] Throughput numbers documented in test output (feeds Manipal planning)
- [ ] `.env.test.example` created with all required variables and safe placeholder values

---

## Notes for ReviewMaster

- **Do NOT implement pipeline features.** Test code only. If you find a gap in the implementation (e.g., missing API route), document it as a failing test with `it.todo()` and notify CoFounder.
- **Fixture CSVs:** Use real Manipal URLs for smoke-5urls.csv where possible. Use `https://manipalhospitals.com/specialities/` sub-paths. For load-100urls.csv, generate from public sitemap or use synthetic `https://manipalhospitals.com/page-{n}` paths — actual crawl validity is tested by the pipeline, not the fixture.
- **Test isolation:** Each tier should create its own job (its own geoSites row). Do not share state between smoke and load tiers in test code.
- **QStash in test env:** Confirm whether QStash is mocked in staging. If the Docker staging env (ES-008) runs a QStash mock, tests must use the mock. If QStash is real, tests must allow sufficient time for async message delivery (~5-10s).
- **Vitest config:** If `vitest.config.ts` does not exist in the geo repo, create one at `geo/vitest.config.ts` with `testTimeout: 700000` (700s for load tier) and `globalSetup` pointing to `tests/integration/bulk-csv-qa/setup/global-setup.ts`.
