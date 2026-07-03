# TS-023: Crawl Fan-out / Fan-in Pipeline

**Status:** Draft
**Author:** CoFounder
**Date:** 2026-03-04
**Downstream:** SpecMaster → ReviewMaster → ScriptDev

---

## Context

The current crawl implementation has two structural performance problems:

1. **Standard audits:** The crawl stage fires parallel individual `/scrape` calls (Phase 1), then fires `asyncCrawlUrl` jobs for failures (Phase 2), then waits a hardcoded 60 seconds before even starting to poll. Phase 2 is a domain spider — it re-discovers pages we already have from `/map`. The 60s wait is pure dead time on most sites.

2. **Bulk audits:** `submitChunkedBatchScrape` processes chunks **sequentially** — chunk 2 doesn't start until chunk 1 finishes. For 10 chunks of 50 URLs each, the crawl alone takes ~8 minutes.

The fix is a unified fan-out/fan-in architecture using Firecrawl's `/v1/batch/scrape` endpoint for both paths. Standard and bulk audits use the same code. Each chunk becomes an independent QStash job with its own timeout budget. All chunks run concurrently. Fan-in is **greedy**: each chunk completes as fast as it can and atomically increments a counter — the last chunk to finish immediately triggers the merge stage with no scheduled polling or artificial delay.

---

## Chunk Size Formula

```
num_chunks = min(10, total_pages)
chunk_size = ceil(total_pages / num_chunks)
```

| total_pages | num_chunks | chunk_size | parallelism |
|-------------|------------|------------|-------------|
| 1 | 1 | 1 | None — single batch |
| 5 | 5 | 1 | 5-way |
| 9 | 9 | 1 | 9-way |
| 10 | 10 | 1 | 10-way (max) |
| 50 | 10 | 5 | 10-way |
| 100 | 10 | 10 | 10-way |
| 500 | 10 | 50 | 10-way |
| 1000 | 10 | 100 | 10-way |

Properties:
- Pages < 10: each URL gets its own batch job — maximum parallelism, each job trivially fast
- Pages ≥ 10: always exactly 10 concurrent batch jobs — predictable cost ceiling
- 1 page: 1 chunk, no fan-out overhead at all
- No hardcoded minimum chunk size needed — formula self-regulates

The constant `10` (MAX_CHUNKS) should be a named config constant (`CRAWL_MAX_CHUNKS = 10`) to allow adjustment if Firecrawl's per-account concurrent job limit requires it.

---

## Architecture: QStash Fan-out + Greedy Fan-in

```
discover
  ↓
crawl-fanout          ← submits N chunks, enqueues N poll-chunk jobs, returns immediately
  ├→ poll-chunk-0     ← independent QStash job; polls until done, then fan-in
  ├→ poll-chunk-1
  ├→ ...
  └→ poll-chunk-N     (all N run concurrently on QStash)
      ↓ (last chunk to complete atomically triggers merge-crawl)
merge-crawl           ← flattens all chunk results, enqueues research
  ↓
research → analyze → generate → assemble
```

**Greedy fan-in:** each `poll-chunk` job completes as fast as Firecrawl allows. The last one to finish atomically increments a DB counter and sees `done === total` — it immediately enqueues `merge-crawl` with no scheduled delay. Failed chunks also increment the counter so the pipeline is never stalled by a failing chunk.

Each `poll-chunk` invocation is a fast QStash job (~3s per invocation — just one HTTP status check). If Firecrawl is still running, it re-enqueues itself with a 15s delay. No long-running inline loops, no Vercel timeout risk.

---

## New Pipeline Stages

```
discover  (unchanged)
  ↓
crawl-fanout  ← replaces crawl + poll stages (single function invocation)
  ↓
research  (unchanged)
  ↓
analyze   (unchanged)
  ↓
generate  (unchanged)
  ↓
assemble  (unchanged)
```

Three stages become one. The `poll` stage is eliminated entirely.

---

## DB Changes

### None for fan-in

No new columns needed. `crawlChunksTotal`, `crawlChunksDone`, and `crawlChunkResults` columns from the earlier draft are **not required** — the fan-in is handled in-process by `Promise.allSettled`.

### `firecrawl_jobs` table — optional monitoring

Optionally write a row per chunk (same schema as today) for observability. Not required for correctness. ScriptDev to decide based on operational need.

### Migration

No migration required unless ScriptDev opts into `firecrawl_jobs` monitoring rows.

---

## Files to Create / Modify

### Modify
| File | Change |
|------|--------|
| `lib/config.ts` | Add `CRAWL_MAX_CHUNKS = 10`, `POLL_CHUNK_INTERVAL_S = 10`, `POLL_CHUNK_CIRCUIT_BREAKER_MS = 20 * 60 * 1000` |
| `app/api/pipeline/stage/route.ts` | Add `handleCrawlFanout()`; remove `handleCrawl`, `handleCrawlBulk`, `handlePoll`; set `maxDuration = 120` for crawl-fanout (covers worst-case 50s chunk + overhead) |
| `lib/qstash.ts` | Remove `poll` from `PipelineStage` type; add `crawl-fanout` |
| `lib/services/geo-crawler.ts` | Remove `firecrawlScrapePass`, `fireFirecrawlJobs`, `fireBulkFirecrawlJobs`, `pollFirecrawlJobs`, `scrapeWithFirecrawl`, `scrapeWithFirecrawlOnce`; keep `discoverSite`, `scoreCrawlQuality`, `retryBlockedPages`, `mapDocumentToPage`, `classifyPageType` |

### Delete
| File | Reason |
|------|--------|
| `lib/services/chunked-firecrawl.ts` | Fully superseded by `handleCrawlFanout` |

---

## Latency Budget

### Per function call

| Call | Provider | Current | Target | Notes |
|------|----------|---------|--------|-------|
| `discoverSite()` → Firecrawl `/map` | Firecrawl | ~15s | ~15s | Unchanged |
| `asyncBatchScrapeUrls()` × N chunks | Firecrawl | N/A | ~1s per submission | Returns job ID immediately; all N submitted in parallel |
| `checkBatchScrapeStatus()` per poll | Firecrawl | ~1s | ~1s | Called every 10s per chunk until done |
| Firecrawl batch job (1 URL) | Firecrawl infra | N/A | ~8-10s | Trivially fast |
| Firecrawl batch job (5 URLs) | Firecrawl infra | N/A | ~15-20s | Standard audit chunk |
| Firecrawl batch job (50 URLs) | Firecrawl infra | N/A | ~40-50s | Bulk audit chunk |
| `gatherCompetitiveIntel()` | Perplexity sonar | ~30s | ~30s | Unchanged |
| `analyzeGeoGaps()` | Gemini Flash/Pro | ~45s | ~45s | Unchanged |
| `generateContent()` | Claude Sonnet | ~60-90s | ~60-90s | Unchanged |
| `assembleResults()` | Claude Sonnet | ~30s | ~30s | Unchanged |
| QStash `enqueueStage()` | Upstash | ~1s | ~1s | Unchanged |

### Per stage (wall-clock, including QStash hop)

| Stage | Current (std, 50p) | Target (std, 50p) | Current (bulk, 500p) | Target (bulk, 500p) |
|-------|-------------------|------------------|---------------------|---------------------|
| discover | ~15s | ~15s | ~15s | ~15s |
| crawl (old two-phase + 60s wait) | ~80-140s | — | ~10s submit | — |
| poll (old, external QStash loop) | — | — | ~500s sequential | — |
| **crawl-fanout (new, single stage)** | — | **~22-27s** | — | **~47-57s** |
| research | ~30s | ~30s | ~30s | ~30s |
| analyze | ~45s | ~45s | ~45s | ~45s |
| generate | ~60-90s | ~60-90s | ~60-90s | ~60-90s |
| assemble | ~30s | ~30s | ~30s | ~30s |
| QStash transitions | ~35s | ~30s | ~35s | ~30s |
| **Total** | **~295-395s (~5-6.5 min)** | **~222-267s (~4 min)** | **~715-745s (~12 min)** | **~267-307s (~4.5-5 min)** |

### Per Vercel function invocation

| Stage | `maxDuration` | Worst-case execution | Headroom |
|-------|--------------|---------------------|---------|
| `discover` | 60s | ~20s | 40s |
| `crawl-fanout` | 120s | ~55s (10 × 50-URL chunks, parallel) | 65s |
| `research` | 60s | ~35s | 25s |
| `analyze` | 120s | ~50s | 70s |
| `generate` | 120s | ~95s | 25s |
| `assemble` | 120s | ~35s | 85s |

`crawl-fanout` runs all chunks concurrently in-process. Worst case is 10 chunks of 50 URLs each completing at ~50s — comfortably within 120s budget.

---

## Config Constants

Add to `lib/config.ts`:

```typescript
export const CRAWL_MAX_CHUNKS = 10;                           // max concurrent batch jobs
export const POLL_CHUNK_INTERVAL_S = 10;                      // seconds between status checks per chunk
export const POLL_CHUNK_CIRCUIT_BREAKER_MS = 20 * 60 * 1000; // 20 min hard limit per chunk
```

---

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Firecrawl concurrent batch job limit | Medium | Verify with Firecrawl docs before implementation. Reduce `CRAWL_MAX_CHUNKS` if needed. |
| Chunk takes > 105s (Vercel soft kill) | Low | Only if Firecrawl is severely degraded. Circuit breaker at 20 min; stage retry in route.ts catches it. |
| Function crash during ~50s poll window | Low | Stage retry (up to 2 retries) re-submits all chunks from scratch. Acceptable. |
| Partial crawl quality (some chunks fail) | Medium | Existing `scoreCrawlQuality` + partial-data policy for bulk already handles this. |

---

## Acceptance Criteria

1. Standard audit (50 pages): `crawl-fanout` stage completes in ≤ 35s on a well-behaved site
2. Bulk audit (500 pages): `crawl-fanout` stage completes in ≤ 65s
3. Pages < 10: `num_chunks = total_pages` — each URL gets its own batch job
4. 1 page: single chunk, no fan-out overhead
5. A chunk that fails (Firecrawl error or circuit breaker) contributes zero pages — pipeline continues with remaining chunks' data
6. Bulk partial crawl policy preserved: proceed if `goodPages > 0` even if some chunks failed
7. `firecrawl_jobs` monitoring rows written per chunk (optional — ScriptDev to decide)
8. All existing integration tests pass — audit result quality equivalent to pre-refactor
9. `poll` stage removed from `PipelineStage` type in `lib/qstash.ts` — no orphaned stage handlers

---

## Out of Scope

- `generate` stage parallelization (separate TS-024 if approved)
- LLM stage latency — data dependencies prevent inter-stage parallelism
- Webhook-based audit completion notification
