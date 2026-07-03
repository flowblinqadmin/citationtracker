# Manipal Crawl Runbook — 8000-URL Audit

## 1. Go / No-Go

**GO — CONFIRM CREDIT BALANCE BEFORE RUNNING**

8,000 URLs × 1 credit/URL = 8,000 credits needed. Standard plan allocates 100,000
credits/month. The Manipal crawl consumes 8% of monthly allocation — well within limits
under any normal usage pattern. Operator must confirm current balance on the Firecrawl
dashboard before triggering the run. If balance < 8,000, a single $47 top-up (35,000
credits) clears the deficit. Rate limits present no blocking risk at sequential
one-chunk-at-a-time submission.

---

## 2. Account State

| Field | Value |
|-------|-------|
| Plan | Standard ($83/mo billed annually) |
| Credits/month | 100,000 |
| Credits needed (8,000 URLs) | 8,000 |
| Credits remaining | **VERIFY ON DASHBOARD** — https://www.firecrawl.dev/app |
| Surplus / deficit | Surplus if balance ≥ 8,000 (expected: yes) |
| Billing reset | **VERIFY ON DASHBOARD** — check if mid-cycle |
| Overage policy | Charged (no hard stop) — auto-recharge packs available |

---

## 3. Cost Model

| Item | Value |
|------|-------|
| Credits per URL | 1 (standard batch scrape) |
| Total credits for 8,000 URLs | 8,000 |
| % of monthly allocation | 8% |
| Top-up required | None expected — verify balance first |
| Top-up option if deficit | $47 for 35,000 credits (~$0.00134/credit) |

If top-up is needed: purchase on dashboard → credits available immediately → run.

---

## 4. Timing Estimate

| Item | Value |
|------|-------|
| Chunks | 16 (500 URLs each) |
| Concurrent browsers (Standard) | 50 |
| Internal rounds per chunk | 500 / 50 = 10 rounds |
| Estimated scrape time per round | ~4s/page |
| Chunk duration estimate | ~3–5 min (scraping + Firecrawl overhead) |
| Polling overhead per chunk | 15s × ~15 polls = ~4 min (runs concurrently) |
| Effective time per chunk | ~4–5 min |
| **Total estimated run time** | **~64–80 min (≈ 1h 5m–1h 20m)** |

Note: chunks run sequentially (one at a time). Heartbeat updates `updatedAt` after each
chunk to bypass the 15-min staleness guard in `completePipeline()`.

---

## 5. Rate Limit Assessment

| Check | Limit | Our Usage | Safe? |
|-------|-------|-----------|-------|
| `POST /v1/batch/scrape` | 500 req/min | 1 req/chunk, 16 total | ✅ Yes |
| Concurrent batch jobs | No explicit limit stated | 1 at a time (sequential) | ✅ Yes |
| Status polling | 1,500 req/min (crawl/status) | 4 req/min (15s interval) | ✅ Yes |
| Concurrent browsers | 50 | 500 URLs/chunk, internal to Firecrawl | ✅ Yes |
| Per-hour cap | None documented | ~16 chunk submissions/hr | ✅ Yes |

No blocking rate limit identified. Sequential submission with 15s polling intervals is
conservative. No mitigation required.

---

## 6. Pre-Run Checklist

- [ ] Firecrawl dashboard: confirm credit balance ≥ 8,000 — https://www.firecrawl.dev/app
- [ ] If deficit: purchase $47 top-up on dashboard, confirm credit refresh
- [ ] DB migration #100 applied to production (coordinate with Adithya Rao)
- [ ] `firecrawl_jobs` table confirmed present in production DB (`SELECT 1 FROM firecrawl_jobs LIMIT 1`)
- [ ] `.env.production` has `FIRECRAWL_API_KEY` set (non-placeholder value)
- [ ] Test Supabase project isolated from production — no cross-contamination risk
- [ ] Test Pro account with sufficient Flowblinq credits ready for the bulk submit
- [ ] Staging run (100 URLs) completed without errors — ES-009 Tier 2 passed
- [ ] `docs/pipeline-failure-recovery.md` read by run operator
- [ ] Billing reset date checked: if reset is < 24h away, consider waiting to run post-reset

---

## 7. Monitoring During the Run

**Firecrawl dashboard:** Watch active jobs and credit balance decrement in real time.

**Supabase:**
```sql
SELECT chunk_index, status, url_count, array_length(urls_completed, 1) AS done
FROM firecrawl_jobs
WHERE site_id = '<site-id>'
ORDER BY chunk_index;
```
Watch `status` transitions: `scraping` → `completed` (or `failed`).

**Vercel logs:** Filter for `[chunked-crawl]` prefix. Expected output:
```
[chunked-crawl] Chunk 0 started — 500 URLs, jobId=fc-xxx
[chunked-crawl] Chunk 0 done — 498 scraped, 2 failed, retrying
[chunked-crawl] Chunk 0 retry complete — 500 total
[chunked-crawl] Chunk 1 started — ...
```
One `Chunk N done` log every ~4–5 min. If no log for >15 min, check Firecrawl dashboard
for job status before assuming failure.

---

## 8. If Run Fails Mid-Way

See `docs/pipeline-failure-recovery.md` for full procedure. Summary:

1. **Identify last completed chunk** — query `firecrawl_jobs` for `status = 'completed'`
   and note `urls_completed` arrays from those rows.
2. **Collect remaining URLs** — subtract `urls_completed` from the original `bulk_urls`
   list on the `geo_sites` row.
3. **Re-trigger** — call `submitChunkedBatchScrape(siteId, remainingUrls, pageMap)` with
   the delta list; it will chunk and submit only the outstanding URLs.
