# OPS-010: Pipeline Architecture Audit — Firecrawl-Only + Native Retry/Resume

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#88](https://github.com/flowblinqadmin/geo/issues/88) · [#98](https://github.com/flowblinqadmin/geo/issues/98)  
> **Delivery Commit:** `14b06c8`  

---

**Source:** TS-010-pipeline-audit.md
**Agent:** 2-SpecMaster
**Date:** 2026-03-01
**Downstream:** OpsMaster (agent 3)
**GitHub Issue:** #98
**Milestone:** Launch: 1st Customer — Manipal Hospitals
**Priority:** P0-critical — prerequisite to any large Manipal crawl run
**Branch:** `dev-an-m2-extended`
**Repo:** flowblinqadmin/geo (local: `/home/aditya/flowblinq/geo`)

---

## a) Overview

### What This Covers

A five-task audit and implementation that makes the crawl pipeline Firecrawl-only and resilient at 8000-URL scale:

1. **Audit** — Find all Jina and Apify references in the codebase
2. **Remove** — Delete Jina/Apify from the pipeline; Firecrawl handles all crawling
3. **Map** — Document Firecrawl Standard plan capabilities (polling, partial results, retry, resume)
4. **Implement** — Chunked job submission (> 500 URLs) + `firecrawl_job_id` persistence to DB
5. **Document** — `docs/pipeline-failure-recovery.md`

### Current Implementation State

Per TS-010 known state:

| Crawler | Role | Status |
|---------|------|--------|
| Firecrawl | URL discovery (map phase) + bulk pipeline per-page scrape (ES-005) | Active |
| Jina | Primary single-page crawler | Possibly still present — Task 1 confirms |
| Apify | Fallback crawler | Possibly still present — Task 1 confirms |

The bulk path (ES-005) is already Firecrawl-only. The single-URL audit path (`lib/services/geo-crawler.ts` — `jinaPass()`, `discoverSite()`) likely still calls Jina. OpsMaster confirms by reading source.

**Working assumption:** After removal, Firecrawl handles all crawl paths. URLs where Firecrawl returns no content are marked `failed` — no silent Jina fallback.

---

## b) Implementation Requirements

### Task 1 — Audit crawler usage

**Read-only. No file modifications.**

Run these searches across the codebase:

```bash
grep -r "jina" /home/aditya/flowblinq/geo/src /home/aditya/flowblinq/geo/app /home/aditya/flowblinq/geo/lib --include="*.ts" -l
grep -ri "JINA" /home/aditya/flowblinq/geo --include="*.ts" -l
grep -r "apify" /home/aditya/flowblinq/geo/src /home/aditya/flowblinq/geo/app /home/aditya/flowblinq/geo/lib --include="*.ts" -l
grep -ri "APIFY" /home/aditya/flowblinq/geo --include="*.ts" -l
grep -i "jina\|apify" /home/aditya/flowblinq/geo/.env.example 2>/dev/null
grep -i "jina\|apify" /home/aditya/flowblinq/geo/.env.local 2>/dev/null
```

Also read `lib/services/geo-crawler.ts` fully to understand the current multi-crawler flow.

**Output:** Annotated list of files, line ranges, and what each reference does. Classify each as:
- `remove` — active crawl call that must be replaced with Firecrawl or `failed` marker
- `config` — env var / API key reference (remove from .env.example; revoke key)
- `type/comment` — dead code or documentation (safe to delete)

---

### Task 2 — Remove Jina and Apify

**Modifies:** `lib/services/geo-crawler.ts` and any other files from Task 1 audit list.

#### 2.1 In `lib/services/geo-crawler.ts`

The current likely structure:
```ts
export async function crawlPage(url: string): Promise<CrawledPage> {
  // Try Jina first
  const jinaResult = await jinaPass(url);
  if (jinaResult.success) return jinaResult.data;
  
  // Fallback to Apify
  const apifyResult = await apifyPass(url);
  if (apifyResult.success) return apifyResult.data;
  
  // Fallback to Firecrawl
  return await firecrawlPass(url);
}
```

**After removal:**
```ts
export async function crawlPage(url: string): Promise<CrawledPage> {
  const result = await firecrawlPass(url);
  if (!result.success) {
    return { url, status: "failed", errorReason: result.error ?? "firecrawl_no_content" };
  }
  return result.data;
}
```

Remove: `jinaPass()`, `apifyPass()`, their imports, and any Jina/Apify API key reads from `process.env`.

#### 2.2 Remove from `.env.example`

Delete lines referencing `JINA_API_KEY`, `APIFY_TOKEN`, or equivalent. Add comment:
```
# Jina and Apify removed 2026-03-01 (TS-010). Firecrawl handles all crawl paths.
```

#### 2.3 No feature regression requirement

After removal, a single-URL audit must still complete. Acceptance gate: run the existing single-URL audit flow manually (or via existing test suite if ES-002/003/004 tests exist) and confirm `pipelineStatus = "completed"` with a non-empty report.

---

### Task 3 — Map Firecrawl API capabilities

**Read + external fetch. No file modifications.**

Fetch Firecrawl API documentation and fill in the findings table. Firecrawl docs base URL: `https://docs.firecrawl.dev`

Specific pages to check:
- `/features/crawl` — job submission, polling, partial results
- `/features/scrape` — single-page endpoint
- `/api-reference/crawl` — endpoint schemas, rate limits, webhooks
- `/pricing` or account dashboard — confirm Standard plan tier and per-crawl limits

#### Findings table to complete:

| Capability | Question | Finding (OpsMaster fills this in) |
|------------|----------|----------------------------------|
| Job polling | Can we poll a crawl job ID for completion? What endpoint? | TBD |
| Partial results | If crawl fails mid-way, are completed-so-far pages returned via polling? | TBD |
| Per-URL retry | Can we submit only the failed URLs from a job to a new job? | TBD |
| Webhook callbacks | Does Firecrawl push completion/failure events, or is polling the only option? | TBD |
| Native resume | Is there a built-in resume-from-checkpoint API? | TBD |
| Batch size limit | Max URLs per crawl job on Standard plan? | TBD |
| Rate limits | Max concurrent jobs? Max requests per minute? | TBD |

**CRITICAL GATE:** After completing Task 3, OpsMaster must **stop and ping CoFounder** with the findings before implementing Task 4. Task 4 design depends on what Firecrawl actually supports.

Write findings to a temporary file at: `docs/firecrawl-capability-findings.md` (will be incorporated into failure recovery doc in Task 5).

---

### Task 4 — Implement chunked job submission

**Prerequisite:** Task 3 findings reviewed and approved by CoFounder before starting this task.

#### 4.1 DB schema addition: `firecrawl_jobs` table

Check `lib/db/schema.ts` first. If `firecrawl_jobs` table already exists with a different schema, **adapt rather than replace** — document the delta.

If it does not exist, add to `lib/db/schema.ts`:

```ts
export const firecrawlJobs = pgTable("firecrawl_jobs", {
  id:               uuid("id").defaultRandom().primaryKey(),
  bulkAuditJobId:   uuid("bulk_audit_job_id").references(() => geoSites.id),
  firecrawlJobId:   text("firecrawl_job_id").notNull(),
  chunkIndex:       integer("chunk_index").notNull(),
  urlCount:         integer("url_count").notNull(),
  status:           text("status").notNull().default("pending"),
                    // "pending" | "running" | "partial" | "completed" | "failed"
  urlsSubmitted:    jsonb("urls_submitted").$type<string[]>().notNull(),
  urlsCompleted:    jsonb("urls_completed").$type<string[]>().default([]),
  createdAt:        timestamp("created_at").defaultNow(),
  updatedAt:        timestamp("updated_at").defaultNow(),
});
```

Migration file: `lib/db/migrations/20260301-firecrawl-jobs.sql`

Generate with: `npx drizzle-kit generate` then apply: `npx drizzle-kit push`

#### 4.2 Chunking logic: `lib/services/chunked-firecrawl.ts`

**New file.** Core chunking orchestration.

```ts
// Chunk size determined by Task 3 findings (Firecrawl max batch size)
// Placeholder: FIRECRAWL_CHUNK_SIZE = 500 (confirm from Task 3 before implementing)
export const FIRECRAWL_CHUNK_SIZE = 500;

export async function submitChunkedCrawl(
  bulkAuditJobId: string,
  urls: string[]
): Promise<void>
// - Splits urls into ceil(urls.length / FIRECRAWL_CHUNK_SIZE) chunks
// - For each chunk:
//   1. POST to Firecrawl /crawl endpoint → firecrawl_job_id
//   2. INSERT firecrawl_jobs row with status "running"
//   3. Immediately begin polling (see pollChunk)
// - Uses exponential backoff between chunk submits if rate-limited (429)

export async function pollChunk(
  firecrawlJobsRowId: string,
  firecrawlJobId: string
): Promise<void>
// - Polls Firecrawl GET /crawl/{firecrawl_job_id} at POLL_INTERVAL (15s)
// - On completion: update firecrawl_jobs row status → "completed", urlsCompleted filled
// - On partial (if Firecrawl supports): status → "partial", log completed URLs
// - On failure: status → "failed"; trigger retryFailedUrls if any urlsCompleted < urlsSubmitted
// - Update updatedAt on each poll

export async function retryFailedUrls(
  bulkAuditJobId: string,
  failedUrls: string[],
  parentChunkIndex: number
): Promise<void>
// - Re-submits failedUrls as a new Firecrawl job
// - Creates new firecrawl_jobs row with chunkIndex = parentChunkIndex + 0.1 (float to indicate retry)
// - Polls and resolves same as a normal chunk
```

**Constants to define in `lib/config.ts` additions:**
```ts
export const FIRECRAWL_CHUNK_SIZE = 500;    // set from Task 3 actual max
export const FIRECRAWL_POLL_INTERVAL_MS = 15_000;
export const FIRECRAWL_MAX_RETRIES = 2;
export const BULK_CHUNKING_THRESHOLD = 500; // use chunking if urlCount > this
```

#### 4.3 Integrate into bulk pipeline

In `app/api/bulk-audit/process/route.ts`:
- Current: fans out per-URL QStash jobs directly
- After: if `urlCount > BULK_CHUNKING_THRESHOLD`, call `submitChunkedCrawl()` instead of direct QStash fan-out
- If `urlCount ≤ BULK_CHUNKING_THRESHOLD`, existing per-URL QStash path unchanged

This keeps the existing 5-URL and 100-URL paths intact. Chunking activates only for Manipal-scale runs.

---

### Task 5 — Document failure recovery model

**New file:** `docs/pipeline-failure-recovery.md`

Maximum 200 lines. Must cover:

1. **What triggers a Firecrawl job failure** — timeout, rate limit (429), server error (500), URL unreachable
2. **How the pipeline detects failure** — polling interval (15s), error code from GET /crawl/{id}
3. **What data is preserved on partial failure** — `firecrawl_jobs.urlsCompleted` written on every poll cycle; even on failure, completed pages are not re-crawled
4. **How re-submission of failed URLs works** — `retryFailedUrls()` automatically triggered on chunk failure (up to `FIRECRAWL_MAX_RETRIES`); manual trigger via admin endpoint (document endpoint path)
5. **Operator responsibilities** — what is automatic vs manual; when to intervene
6. **How a failed Manipal run would be resumed** — query `firecrawl_jobs` for `status = "failed"` or `"partial"`; re-run `retryFailedUrls()` for those rows; no re-crawl of `urlsCompleted` URLs

Incorporate findings from `docs/firecrawl-capability-findings.md` (Task 3 output).

---

## c) Unit Test Plan

**Scope:** Unit tests for chunking logic only. Integration tests for full pipeline are out of scope for this spec (covered by ES-009 Tier 2).

**Test file:** `tests/unit/chunked-firecrawl/chunked-firecrawl.test.ts`

| Test case | Input | Expected output |
|-----------|-------|-----------------|
| Chunk split — exact multiple | 1000 URLs, chunk size 500 | 2 chunks of 500 |
| Chunk split — remainder | 501 URLs, chunk size 500 | 2 chunks: [500, 1] |
| Chunk split — under threshold | 100 URLs, chunk size 500 | 1 chunk of 100 |
| Chunk split — empty input | 0 URLs | 0 chunks, no DB write |
| retryFailedUrls — empty failed list | 0 failed URLs | No-op, no Firecrawl call |
| Backoff on 429 | Mock Firecrawl returning 429 twice then 200 | Retried with exponential backoff; succeeds on 3rd attempt |

**Mock requirements:**
- Mock `firecrawl-js` or Firecrawl HTTP calls via `vitest.mock`
- Mock Supabase DB client for DB-write assertions
- Do NOT use real Firecrawl API in unit tests

---

## d) Integration Test Plan

**Scope:** Partial-failure scenario test (Task 4 acceptance gate).

**Test file:** `tests/integration/pipeline-audit/partial-failure.test.ts`

| Test case | Setup | Assertion |
|-----------|-------|-----------|
| Mock Firecrawl 500 on first chunk | Submit 600-URL job; mock first Firecrawl POST to return 500 | `firecrawl_jobs` row created with `status = "failed"`; retry triggered; second chunk POST succeeds |
| Retry creates new row | Same as above | New `firecrawl_jobs` row with incremented chunk index exists |
| Failed pages not re-submitted | Mock partial completion (50/100 URLs done before failure) | `urlsCompleted` has 50 entries; retry only submits remaining 50 |
| Full pipeline resume | After retry completes | `bulkAuditJob.status = "completed"` for all originally submitted URLs (or `failed` with error reason for true failures) |

---

## e) Profiling Requirements

- **What to measure:** Time per chunk submit + poll cycle overhead for a 500-URL chunk
- **Tool:** Wrap `submitChunkedCrawl()` calls with `performance.now()` timestamps; log `[chunked-crawl] chunk {i}: submitMs={n}, pollCycleMs={n}`
- **Baseline expectation:** Submit call < 2s; polling overhead < 100ms per cycle
- **Log level:** `info` (visible in production, not debug-only)

---

## f) Load Test Plan

Out of scope for this spec. TS-011 (Firecrawl limits audit for 8000-URL run) covers load testing the chunked pipeline at Manipal scale.

---

## g) Logging & Instrumentation

| Event | Level | Format |
|-------|-------|--------|
| Chunk submitted | `info` | `[chunked-crawl] Chunk {i}/{total} submitted: firecrawl_job_id={id} urls={n}` |
| Chunk poll cycle | `debug` | `[chunked-crawl] Polling chunk {i}: status={s} completed={n}/{total}` |
| Chunk completed | `info` | `[chunked-crawl] Chunk {i} completed: {n} URLs in {ms}ms` |
| Chunk failed | `warn` | `[chunked-crawl] Chunk {i} FAILED: {n} URLs failed. Retrying {m} URLs.` |
| Retry submitted | `warn` | `[chunked-crawl] Retry job submitted for chunk {i}: firecrawl_job_id={id}` |
| Jina/Apify call detected (runtime guard) | `error` | `[pipeline] UNEXPECTED Jina/Apify call detected — removal incomplete` |
| Rate limit backoff | `warn` | `[chunked-crawl] Rate limited (429). Backoff {n}s before chunk {i}` |

Add a runtime guard in the crawl path: if somehow a Jina/Apify call is made (shouldn't happen after Task 2), log at `error` level and throw. This prevents silent regression.

---

## h) Acceptance Criteria

- [ ] Task 1: Jina/Apify audit list produced (all files, line ranges, classifications)
- [ ] Task 2: `grep -r "jina\|apify" geo/lib geo/app --include="*.ts"` returns zero results
- [ ] Task 2: Single-URL audit completes successfully after Jina/Apify removal
- [ ] Task 3: Firecrawl capability findings documented in `docs/firecrawl-capability-findings.md`
- [ ] Task 3: **CoFounder pinged with findings before Task 4 implementation begins**
- [ ] Task 4: `firecrawl_jobs` table exists in DB with correct schema
- [ ] Task 4: `lib/services/chunked-firecrawl.ts` created with `submitChunkedCrawl`, `pollChunk`, `retryFailedUrls`
- [ ] Task 4: `FIRECRAWL_CHUNK_SIZE` constant set based on Task 3 findings (not placeholder)
- [ ] Task 4: `app/api/bulk-audit/process/route.ts` uses chunking for `urlCount > BULK_CHUNKING_THRESHOLD`
- [ ] Task 4: `firecrawl_job_id` persisted to DB for every submitted chunk
- [ ] Task 4: Partial-failure scenario tested — mock 500 → retry → resume (see integration test)
- [ ] Task 5: `docs/pipeline-failure-recovery.md` created, < 200 lines, covers all 6 required topics
- [ ] Unit tests for chunking logic pass
- [ ] No Jina/Apify API keys in `.env.example`
- [ ] Runtime Jina/Apify guard in place (throws + logs `error` if called)

---

## Notes for OpsMaster

- **Read before writing.** Read `lib/services/geo-crawler.ts` fully before making any changes. The actual structure may differ from the assumed structure above.
- **Task 3 is a hard gate on Task 4.** Do not begin implementation until CoFounder reviews capability findings. The chunking design (batch size, polling strategy, retry approach) all depend on what Firecrawl actually supports.
- **Preserve error handling.** Task 2 says remove Jina/Apify branches, NOT remove error handling. Firecrawl failures must still be caught and marked `failed` cleanly.
- **Coordinate DB migration with ScriptDev** before applying `20260301-firecrawl-jobs.sql` — they may have active work on `dev-an-m2-extended`.
- **TS-011 is a follow-on spec** covering the actual 8000-URL Manipal crawl run preparation. This spec (TS-010 / OPS-010) is only the pipeline cleanup prerequisite.
