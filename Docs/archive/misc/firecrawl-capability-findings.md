# Firecrawl Capability Findings
**Date:** 2026-03-01
**Author:** OpsMaster (OPS-010 Task 3)
**Purpose:** Inform Task 4 chunked job submission design for Manipal-scale (8000-URL) crawls.

---

## Capability Table

| Capability | Question | Finding |
|------------|----------|---------|
| Job polling | Can we poll a crawl job ID for completion? What endpoint? | Yes. `GET /v1/crawl/{jobId}`. Response includes `status` ("scraping" / "completed" / "failed"), `total`, `completed`, `creditsUsed`, `data[]`, `next` (pagination). |
| Partial results | If crawl fails mid-way, are completed-so-far pages returned via polling? | Yes. `data[]` in the polling response contains all pages scraped so far, even while `status = "scraping"`. Per-page errors available via `GET /v1/crawl/{jobId}/errors`. |
| Per-URL retry | Can we submit only the failed URLs from a job to a new job? | Not natively. Firecrawl has no "retry these URLs from job X" API. Must submit a new job (crawl or batch scrape) with the failed URL list. The codebase already uses this pattern. |
| Webhook callbacks | Does Firecrawl push completion/failure events, or is polling the only option? | Both. Webhooks supported on all plans. Events: `started`, `page` (per-page), `completed`. Payload: standard job result. Retry policy: 1 min → 5 min → 15 min on failure. Configure per-request via `webhook: { url, headers, metadata }`. |
| Native resume | Is there a built-in resume-from-checkpoint API? | **No.** No pause/resume or checkpoint API exists. Resume must be implemented application-side (track `urlsCompleted`, re-submit `urlsFailed` as a new job). |
| Batch size limit (crawl) | Max URLs per crawl job on Standard plan? | Crawl endpoint: max `limit` = **10,000 pages**. No per-plan restriction stated beyond concurrent browser cap. |
| Batch scrape endpoint | Is there a direct multi-URL scrape (not domain spider)? | **Yes.** `POST /v1/batch/scrape` accepts exact URL arrays. No documented URL count limit. Supports webhooks, partial results via polling, and `ignoreInvalidURLs`. Returns `batchId` for status polling via `GET /v1/batch/scrape/{batchId}`. |
| Rate limits (Standard) | Max concurrent jobs? Max requests per minute? | 50 concurrent browsers total. `/crawl` POST: 50 req/min. `/scrape` POST: 500 req/min. `/crawl/status` GET: 1,500 req/min. No explicit max concurrent jobs stated. |

---

## Key Architectural Finding: Use Batch Scrape, Not Crawl Jobs

The current codebase uses `asyncCrawlUrl(domain, { includePaths: [50 pathnames] })` — a **domain spider** filtered to specific paths. This has overhead:
- Firecrawl starts at the domain root and discovers URLs before scraping
- Path filters may not match exactly (URL canonicalization differences)
- Each "crawl job" may crawl additional pages beyond the target paths

**For Manipal's 8000 exact known URLs, the better approach is:**

```
POST /v1/batch/scrape
{ urls: ["https://manipal.com/page1", ...], scrapeOptions: { formats: ["markdown"] } }
```

Batch scrape takes exact URLs, no spidering overhead, more predictable credit usage. Partial results accessible via `GET /v1/batch/scrape/{batchId}`.

**Recommended for Task 4:**
- Switch from `asyncCrawlUrl` to `POST /v1/batch/scrape` for chunked submissions
- Chunk size: confirm with CoFounder, suggest **500 URLs/chunk** (10 concurrent browsers × 50 = comfortable headroom under the 50 concurrent browser cap)
- Webhook: configure per-chunk for near-real-time completion detection (avoids 15s polling loops)

---

## Implications for Task 4 Design

1. **`firecrawl_jobs.firecrawlJobId`** should store the `batchId` from batch scrape, not a crawl job ID
2. **Polling endpoint** changes to `GET /v1/batch/scrape/{batchId}`
3. **Partial failure** detection: check `data[]` count vs `urlsSubmitted` count on each poll cycle; write `urlsCompleted` incrementally
4. **Retry** remains application-side: collect `urlsSubmitted` - `urlsCompleted` after `status = "failed"` → re-submit as new batch
5. **Webhook** eliminates polling loops for normal completions; polling is only needed for in-flight jobs after restart

---

## Open Questions for CoFounder Gate Review

1. Switch from `asyncCrawlUrl` (crawl jobs) to `/v1/batch/scrape`? This is a meaningful architectural change — needs sign-off.
2. Chunk size: 500/chunk (conservative) or 1000/chunk (faster, higher concurrent browser pressure)?
3. Webhooks: should we configure them per-chunk, or rely on polling only? Webhooks require an HTTPS endpoint for Firecrawl to call back — do we have one?
4. The Standard plan has no explicit concurrent job limit. Is there an account-level limit we should check before the Manipal run?
