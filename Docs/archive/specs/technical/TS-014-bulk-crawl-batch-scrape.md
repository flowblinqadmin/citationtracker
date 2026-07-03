# TS-014 — Fix Bulk Crawl: Use batch/scrape for ≤500 URLs

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#100](https://github.com/flowblinqadmin/geo/issues/100)  
> **Delivery Commit:** `f08c9ea`  

---

## What
Fix `handleCrawlBulk` in `geo/app/api/pipeline/stage/route.ts` to use
`submitChunkedBatchScrape` (POST `/v1/batch/scrape` — exact URL scraper) for
≤500 URL bulk audits instead of `fireBulkFirecrawlJobs` (asyncCrawlUrl —
domain spider).

## Why
`asyncCrawlUrl` is a **domain spider**: it discovers pages by crawling the
domain and filtering by `includePaths`. It does NOT guarantee scraping the
exact URLs provided. In the 5-URL smoke test with `example.com`, the spider
found only 1 accessible page (example.com has no real /about, /pricing, etc.).

For bulk audits, customers provide an exact list of URLs they want analyzed.
We must scrape those exact URLs, not discover whatever happens to exist on the
domain. `POST /v1/batch/scrape` does this correctly.

Additionally, this eliminates the 60-second QStash poll delay and async job
polling overhead for small audits, making results faster.

## Root Cause
`handleCrawlBulk` (pipeline/stage/route.ts ~line 208) always calls
`fireBulkFirecrawlJobs`, which uses `asyncCrawlUrl`. The chunked batch/scrape
path (`submitChunkedBatchScrape`) was implemented in `runner.ts` (deprecated
path) but was never wired into the QStash pipeline.

## Architecture Change

### Current flow (broken for ≤500 URLs):
```
handleCrawlBulk → fireBulkFirecrawlJobs (asyncCrawlUrl)
                → store jobIds → enqueueStage("poll", 60s)
                → handlePoll (polls Firecrawl async jobs)
                → enqueueStage("research")
```

### New flow for ≤500 URLs (exact URL scraping):
```
handleCrawlBulk → submitChunkedBatchScrape (POST /v1/batch/scrape)
                → store crawlData directly (pages already collected)
                → enqueueStage("research")  ← skip poll entirely
```

### Flow for >500 URLs (unchanged — keep async domain spider):
```
handleCrawlBulk → fireBulkFirecrawlJobs (asyncCrawlUrl)
                → store jobIds → enqueueStage("poll", 60s)
                → handlePoll → enqueueStage("research")
```

## Dependencies
- `submitChunkedBatchScrape` already exists at `geo/lib/services/chunked-firecrawl.ts`
- `BULK_CHUNKING_THRESHOLD = 500` already defined in `geo/lib/config.ts`
- `CrawledPage` type already imported in `pipeline/stage/route.ts`

## Implementation Requirements

### File to modify
`geo/app/api/pipeline/stage/route.ts` — `handleCrawlBulk` function (lines ~179–218)

### Imports to add (if not already present)
```typescript
import { submitChunkedBatchScrape } from "@/lib/services/chunked-firecrawl";
import { BULK_CHUNKING_THRESHOLD } from "@/lib/config";
```

### New `handleCrawlBulk` logic (pseudocode):
```typescript
async function handleCrawlBulk(siteId: string, domain: string): Promise<void> {
  // ... existing setup: fetch site, build pageMap, write discoveryData + "crawling" status ...

  if (urlsToProcess.length <= BULK_CHUNKING_THRESHOLD) {
    // Synchronous exact-URL scraping — data collected here, no poll stage needed
    const pages = await submitChunkedBatchScrape(siteId, urlsToProcess, pageMap);

    await db.update(geoSites).set({
      crawlData: { domain, pages, totalCrawled: pages.length } as unknown as Record<string, unknown>,
      crawlJobIds: [],   // no async jobs
      updatedAt: new Date(),
    }).where(eq(geoSites.id, siteId));

    console.warn(JSON.stringify({ event: "bulk_crawl_batch_complete", siteId, urlCount: urlsToProcess.length, pagesCollected: pages.length }));

    // Skip poll — advance directly to research
    await enqueueStage({ siteId, domain, stage: "research", crawlStartedAt: new Date().toISOString() });

  } else {
    // Large bulk set — async domain spider via asyncCrawlUrl (unchanged)
    const jobIds = await fireBulkFirecrawlJobs(domain, urlsToProcess);
    await db.update(geoSites).set({ crawlJobIds: jobIds, updatedAt: new Date() })
      .where(eq(geoSites.id, siteId));
    console.warn(JSON.stringify({ event: "bulk_crawl_started", siteId, urlCount: urlsToProcess.length, jobCount: jobIds.length }));
    await enqueueStage({ siteId, domain, stage: "poll", isBulk: true, crawlStartedAt: new Date().toISOString(), pollCount: 0 }, 60);
  }
}
```

### CrawledPage format compatibility
`submitChunkedBatchScrape` returns `CrawledPage[]`. This is the same type
that `handlePoll` produces via `pollFirecrawlJobs`. The `crawlData` shape
`{ domain, pages, totalCrawled }` is already what downstream stages expect.

### Check handleResearch/handleAnalyze accept crawlStartedAt
`enqueueStage("research")` passes `crawlStartedAt`. Verify `handleResearch`
accepts this field (it may already be optional in StagePayload). No logic
change needed in research/analyze/generate/assemble stages.

## Acceptance Criteria
- [ ] 5-URL smoke test: all 5 provided URLs scraped (not domain-discovered)
- [ ] Result shows ≥5 crawled pages (assuming URLs are accessible)
- [ ] `crawlJobIds` is `[]` for ≤500 URL bulk audits (no async jobs)
- [ ] Pipeline advances through research → analyze → generate → assemble without hanging at poll
- [ ] >500 URL path unchanged (still uses asyncCrawlUrl + poll)
- [ ] Existing 743 tests still pass

## Risks
- `submitChunkedBatchScrape` polls synchronously within the Vercel function.
  For ≤500 URLs (1 chunk), this should complete well within the 300s function
  limit. Monitor for timeouts if pages are slow to scrape.
- asyncCrawlUrl path for >500 URLs unchanged — no regression risk there.

## Priority
P1 — blocks 5-URL smoke test and Manipal launch.

## Commit target
`dev-sprint-7` branch → PR → merge to main.
