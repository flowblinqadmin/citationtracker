# Pipeline Failure Recovery Model

**Date:** 2026-03-01
**Spec:** OPS-010 / TS-010
**Status:** Live — applies to all bulk audits > 500 URLs

---

## 1. What Triggers a Firecrawl Job Failure

A Firecrawl batch/scrape job (`POST /v1/batch/scrape`) can fail or return partial results due to:

| Cause | Firecrawl behaviour |
|-------|---------------------|
| **Rate limit (429)** | Job rejected at submit time — `startBatchScrape()` throws. No Firecrawl row created. |
| **Server error (5xx)** | Job may enter `failed` status mid-scrape. `getBatchScrapeStatus()` returns `status: "failed"`. |
| **URL unreachable** | Individual URL silently excluded from `data[]`. Job may still reach `completed`. |
| **Bot challenge / Cloudflare block** | URL returns content, but content is an error page. Caught by `hasContent()` check. |
| **Timeout** | Firecrawl expires the job after its internal SLA. Status becomes `failed` or `cancelled`. |

**What does NOT trigger a failure at our layer:** individual URL 404s. Firecrawl includes them in `data[]` with thin/empty content; we filter them out at the `mapDocumentToPage()` stage.

---

## 2. How the Pipeline Detects Failure

Detection happens in `lib/services/chunked-firecrawl.ts → pollChunkUntilDone()`.

**Poll cycle:**
1. Sleep `FIRECRAWL_POLL_INTERVAL_MS` (15 000 ms)
2. Call `fc.getBatchScrapeStatus(firecrawlJobId)`
3. Check `status`:
   - `"scraping"` → continue loop
   - `"completed"` → collect `data[]`, mark row `completed`, return
   - `"failed"` | `"cancelled"` → mark row `failed`, return empty `[]`

**Transient network errors** (thrown by `getBatchScrapeStatus`) are swallowed and the poll cycle retries on the next interval — these are not treated as job failures.

**Staleness guard** (`completePipeline()` in runner.ts): if a site stays in `crawling` status for > 15 min with no `updatedAt` movement, the cron marks it `failed`. The chunked path prevents this by calling a heartbeat update (`geoSites.updatedAt = now`) after every chunk completes.

---

## 3. What Data Is Preserved on Partial Failure

Every chunk has its own `firecrawl_jobs` row. When a job completes (even on failure):

- `urlsCompleted` is written from the `data[]` returned by the final poll
- `urlsSubmitted` is always written at submission time
- Failed rows are **not deleted** — they remain queryable

This means:
- On a chunk failure mid-run, the URLs from all previously completed chunks are already stored in `geoSites.crawlData` (written in the sequential loop)
- The failed chunk's `urlsSubmitted` tells you exactly which URLs need re-submitting
- URLs in `urlsCompleted` on a failed row were partially scraped and should not be re-crawled

---

## 4. How Re-Submission of Failed URLs Works

**Automatic retry (within a single run):**

`submitChunkedBatchScrape()` handles per-chunk retry automatically:

```
for each chunk:
  attempt 1 → submitChunk()
  diff: chunkUrls - pages.map(p => p.url) = failedUrls
  if failedUrls > 0 and retry < FIRECRAWL_MAX_RETRIES (2):
    attempt 2 → submitChunk(failedUrls)
    ...up to FIRECRAWL_MAX_RETRIES total retries
```

Each retry creates a **new `firecrawl_jobs` row** (with the same `chunkIndex` as the parent). This makes it clear which URLs were retried and whether the retry succeeded.

**Manual re-run (operator intervention):**

There is no dedicated admin endpoint for manual retry today. Operator procedure:

1. Query for failed chunks:
   ```sql
   SELECT * FROM firecrawl_jobs WHERE site_id = '<siteId>' AND status = 'failed';
   ```
2. Collect `urls_submitted` from each failed row
3. Subtract any URLs already in `geo_sites.crawl_data.pages[*].url` (already collected)
4. Re-trigger the bulk pipeline via `POST /api/sites/:id/verify` with the reduced URL list

---

## 5. Operator Responsibilities

**Automatic (no intervention needed):**
- Per-chunk retry up to `FIRECRAWL_MAX_RETRIES` (2) attempts
- Staleness heartbeat to keep the pipeline alive during long runs
- Credit reconciliation refund if actual pages < reserved (runs in `completePipeline()`)

**Manual intervention required when:**
- `pipelineStatus = "failed"` on a bulk audit site
- `firecrawl_jobs` rows show `status = "failed"` after exhausting retries
- Credit balance too low to re-run (check `teams.credit_balance`)

**Monitoring queries:**

```sql
-- Sites stuck in crawling > 30 min
SELECT id, domain, pipeline_status, updated_at
FROM geo_sites
WHERE pipeline_status = 'crawling'
  AND updated_at < now() - interval '30 minutes';

-- Failed chunk jobs
SELECT site_id, chunk_index, url_count, status, updated_at
FROM firecrawl_jobs
WHERE status = 'failed'
ORDER BY updated_at DESC;
```

---

## 6. How a Failed Manipal Run Would Be Resumed

If a Manipal 8000-URL bulk audit fails mid-run:

**Step 1 — Identify what completed:**
```sql
SELECT chunk_index, status, url_count,
       jsonb_array_length(urls_completed) AS completed_count,
       jsonb_array_length(urls_submitted) AS submitted_count
FROM firecrawl_jobs
WHERE site_id = '<manipal_site_id>'
ORDER BY chunk_index;
```

**Step 2 — Determine which URLs still need crawling:**
- Collect all `urls_submitted` from `status = 'failed'` rows
- Remove any URLs already present in `geo_sites.crawl_data.pages[*].url`
- The remainder is the resume set

**Step 3 — Re-trigger:**
- Re-submit the remaining URLs via the bulk verify endpoint
- The pipeline will create a new set of `firecrawl_jobs` rows for the new run
- Pages collected in the previous run's `crawl_data` are overwritten — save them first if you need the partial dataset:
  ```sql
  SELECT crawl_data FROM geo_sites WHERE id = '<manipal_site_id>';
  ```

**What is NOT re-crawled automatically:** The current architecture does not merge partial results across pipeline runs. A resume is a fresh pipeline start with a reduced URL list. If partial data preservation is required, that is a Task 6 / future spec.

---

## Reference: Key Constants

| Constant | Value | Location |
|----------|-------|----------|
| `FIRECRAWL_CHUNK_SIZE` | 500 URLs/chunk | `lib/config.ts` |
| `FIRECRAWL_POLL_INTERVAL_MS` | 15 000 ms | `lib/config.ts` |
| `FIRECRAWL_MAX_RETRIES` | 2 retries/chunk | `lib/config.ts` |
| `BULK_CHUNKING_THRESHOLD` | 500 URLs | `lib/config.ts` |
| Staleness guard | 15 min | `runner.ts → completePipeline()` |

---

*Source: OPS-010 / TS-010 — Firecrawl capability findings in `docs/firecrawl-capability-findings.md`*
