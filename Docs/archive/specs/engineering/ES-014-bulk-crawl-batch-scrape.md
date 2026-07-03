# ES-014: Fix Bulk Crawl — Use batch/scrape for ≤500 URLs

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#100](https://github.com/flowblinqadmin/geo/issues/100)  
> **Delivery Commit:** `f08c9ea`  

---

**Source:** TS-014-bulk-crawl-batch-scrape.md
**Agent:** 2-SpecMaster
**Date:** 2026-03-02
**Priority:** P1 — blocks 5-URL smoke test and Manipal launch
**Downstream:** ReviewMaster (agent 9) → ScriptDev (agent 6)
**Branch:** `dev-sprint-7` → PR → main
**Repo:** flowblinqadmin/geo (local: `/home/aditya/flowblinq/geo`)

---

## a) Overview

### What This Covers

Fix `handleCrawlBulk` in `geo/app/api/pipeline/stage/route.ts` to use
`submitChunkedBatchScrape` (exact URL scraping via `POST /v1/batch/scrape`) for
≤500 URL bulk audits, instead of `fireBulkFirecrawlJobs` (domain spider via
`asyncCrawlUrl`). For ≤500 URLs, data is collected synchronously — no poll
stage needed. The >500 URL async path is unchanged.

### Root Cause (confirmed by source read)

`handleCrawlBulk` (lines 179–218 of `stage/route.ts`) unconditionally calls
`fireBulkFirecrawlJobs(domain, urlsToProcess)` — a domain spider that discovers
pages by crawling, not by scraping the provided URL list. For a CSV with 5
specific Manipal pages, the spider may find 0–1 pages (domain has few
crawlable paths). The fix routes ≤500 URLs through `submitChunkedBatchScrape`,
which scrapes exactly the URLs provided.

### Current State (confirmed by source read)

| Symbol | Status |
|--------|--------|
| `fireBulkFirecrawlJobs` | Imported (line 22), used in `handleCrawlBulk` (line 208) |
| `submitChunkedBatchScrape` | Exported from `lib/services/chunked-firecrawl.ts` (line 196) — **NOT imported in stage/route.ts** |
| `BULK_CHUNKING_THRESHOLD` | Defined in `lib/config.ts` — **NOT imported in stage/route.ts** |
| `enqueueStage` | Already imported (line 38) |
| `StagePayload` | Already imported (line 38) |
| `CrawledPage` | Already imported (line 27) |

---

## b) Implementation Requirements

### File: `geo/app/api/pipeline/stage/route.ts`

#### Change 1 — Add two imports (after line 38)

```typescript
import { submitChunkedBatchScrape } from "@/lib/services/chunked-firecrawl";
import { BULK_CHUNKING_THRESHOLD, bulkCreditsRequired, FREE_MAX_PAGES } from "@/lib/config";
```

Note: `bulkCreditsRequired` and `FREE_MAX_PAGES` are already imported at line 37.
Only add `BULK_CHUNKING_THRESHOLD` to the existing config import line — do not
duplicate the import. Exact edit:

**Current line 37:**
```typescript
import { bulkCreditsRequired, FREE_MAX_PAGES } from "@/lib/config";
```
**Replace with:**
```typescript
import { bulkCreditsRequired, FREE_MAX_PAGES, BULK_CHUNKING_THRESHOLD } from "@/lib/config";
```

And add after line 38:
```typescript
import { submitChunkedBatchScrape } from "@/lib/services/chunked-firecrawl";
```

#### Change 2 — Replace `handleCrawlBulk` body (lines 179–218)

**Replace the entire function body** (keeping the function signature unchanged):

```typescript
async function handleCrawlBulk(siteId: string, domain: string): Promise<void> {
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) throw new Error("Site not found");

  const allUrls = (site.bulkUrls as string[] | null) ?? [];
  const crawlLimit = (site.crawlLimit as number | null) ?? allUrls.length;
  const urlsToProcess = allUrls.slice(0, crawlLimit);

  // Build synthetic discoveryData from the CSV URLs
  const pageMap: Record<string, ReturnType<typeof classifyPageType>> = {};
  for (const url of urlsToProcess) {
    pageMap[url] = classifyPageType(url);
  }
  const discoveryData = {
    urls: urlsToProcess,
    pageMap,
    hasLlmsTxt: false,
    hasUcp: false,
    hasSitemap: false,
    hasRobots: false,
    totalPages: urlsToProcess.length,
  };

  await db.update(geoSites).set({
    discoveryData: discoveryData as unknown as Record<string, unknown>,
    pipelineStatus: "crawling",
    updatedAt: new Date(),
  }).where(eq(geoSites.id, siteId));

  if (urlsToProcess.length <= BULK_CHUNKING_THRESHOLD) {
    // ── Synchronous exact-URL scraping via batch/scrape ──────────────────────
    // submitChunkedBatchScrape collects all pages before returning.
    // No poll stage needed — advance directly to research.
    const pages = await submitChunkedBatchScrape(siteId, urlsToProcess, pageMap);

    await db.update(geoSites).set({
      crawlData: { domain, pages, totalCrawled: pages.length } as unknown as Record<string, unknown>,
      crawlJobIds: [],   // no async jobs for ≤500 URL path
      updatedAt: new Date(),
    }).where(eq(geoSites.id, siteId));

    console.warn(JSON.stringify({
      event: "bulk_crawl_batch_complete",
      siteId,
      urlCount: urlsToProcess.length,
      pagesCollected: pages.length,
    }));

    // Skip poll — advance directly to research
    await enqueueStage({ siteId, domain, stage: "research", crawlStartedAt: new Date().toISOString() });

  } else {
    // ── Large bulk: async domain spider via asyncCrawlUrl (unchanged) ─────────
    const jobIds = await fireBulkFirecrawlJobs(domain, urlsToProcess);

    await db.update(geoSites).set({ crawlJobIds: jobIds, updatedAt: new Date() })
      .where(eq(geoSites.id, siteId));

    console.warn(JSON.stringify({
      event: "bulk_crawl_started",
      siteId,
      urlCount: urlsToProcess.length,
      jobCount: jobIds.length,
    }));

    await enqueueStage(
      { siteId, domain, stage: "poll", isBulk: true, crawlStartedAt: new Date().toISOString(), pollCount: 0 },
      60
    );
  }
}
```

**No other functions in `stage/route.ts` are modified.**

#### Downstream stage compatibility

`enqueueStage("research", { crawlStartedAt })` — verify `StagePayload` accepts
`crawlStartedAt` as optional on the research stage. From source (line 299):
`await enqueueStage({ siteId, domain, stage: "research", crawlStartedAt })` — already
done in the existing poll→research path. No change needed in research/analyze/generate/assemble.

---

## c) Unit Test Plan

**Test file:** `geo/__tests__/bulk-pipeline.test.ts` (already exists per test inventory)

Add or update tests for `handleCrawlBulk`:

| Test ID | Scenario | Setup | Assertion |
|---------|----------|-------|-----------|
| BP-1 | ≤500 URLs → uses batch/scrape | `urlsToProcess.length = 5`, mock `submitChunkedBatchScrape` returns 5 pages | `submitChunkedBatchScrape` called once; `fireBulkFirecrawlJobs` NOT called; `enqueueStage` called with `stage: "research"` (not `"poll"`) |
| BP-2 | ≤500 URLs → crawlJobIds is empty | Same as BP-1 | DB `update` called with `crawlJobIds: []` |
| BP-3 | ≤500 URLs → crawlData written | Same as BP-1, pages = `[{url: "https://example.com", ...}]` | DB `update` called with `crawlData` containing `pages` and `totalCrawled: 5` |
| BP-4 | >500 URLs → uses async spider | `urlsToProcess.length = 501` | `fireBulkFirecrawlJobs` called; `submitChunkedBatchScrape` NOT called; `enqueueStage` called with `stage: "poll"` |
| BP-5 | Exact threshold boundary | `urlsToProcess.length = 500` | Batch/scrape path taken (≤500) |
| BP-6 | One above threshold | `urlsToProcess.length = 501` | Async spider path taken (>500) |

**Mock requirements:**
```typescript
vi.mock("@/lib/services/chunked-firecrawl", () => ({
  submitChunkedBatchScrape: vi.fn().mockResolvedValue([
    { url: "https://example.com", pageType: "home", ... }
  ]),
}));
vi.mock("@/lib/services/geo-crawler", () => ({
  fireBulkFirecrawlJobs: vi.fn().mockResolvedValue(["fc-job-1"]),
  classifyPageType: vi.fn().mockReturnValue("generic"),
  // ... other exports as needed
}));
vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn().mockResolvedValue(undefined),
}));
```

Note: `handleCrawlBulk` is not exported. ReviewMaster should test it either via
the exported POST handler with a `stage: "crawl"` + `isBulk: true` payload, or
by restructuring existing tests in `bulk-pipeline.test.ts` that already exercise
this path.

---

## d) Integration Test Plan

The existing ES-009 Tier 1 smoke test (5-URL) is the integration test for this
fix. After this change:

- Upload `smoke-5urls.csv` → 5 specific Manipal URLs
- All 5 URLs scraped via `submitChunkedBatchScrape`
- `crawlData.pages.length === 5` (or close — pages with no content marked failed)
- Pipeline advances research → analyze → generate → assemble without hanging at poll
- `crawlJobIds` is `[]` in DB

If ES-009 integration tests remain blocked on `.env.test` infra, ScriptDev must
run a manual smoke test in staging before merging.

---

## e) Profiling Requirements

- **What to measure:** Total time for `submitChunkedBatchScrape` to complete for a 5-URL batch
- **Baseline expectation:** < 60s for 5 URLs (well within 300s Vercel function limit)
- **Tool:** The existing `[chunked-crawl] Chunk 1/1 completed: {n} URLs in {ms}ms` log line in `chunked-firecrawl.ts` captures this automatically
- **For 500-URL case:** < 300s total. If approaching limit, flag to CoFounder before Manipal run.

---

## f) Load Test Plan

Covered by ES-009 Tier 2 (100-URL load test). The ≤500 path handles up to 500
URLs in one `submitChunkedBatchScrape` call (single chunk). Load testing at
Manipal scale (8000 URLs, >500 path) is covered by OPS-010/OPS-012.

---

## g) Logging & Instrumentation

New log line for ≤500 path (already in spec above):
```
[bulk_crawl_batch_complete] siteId={id} urlCount={n} pagesCollected={m}
```

This replaces the `[bulk_crawl_started]` log for the ≤500 path. The distinction
in log events makes it easy to identify which code path executed in Vercel logs.

---

## h) Acceptance Criteria

- [ ] `BULK_CHUNKING_THRESHOLD` imported in `stage/route.ts`
- [ ] `submitChunkedBatchScrape` imported from `@/lib/services/chunked-firecrawl`
- [ ] `handleCrawlBulk` routes ≤500 URLs through `submitChunkedBatchScrape`
- [ ] ≤500 path: `crawlJobIds = []` written to DB
- [ ] ≤500 path: `crawlData` with `pages` and `totalCrawled` written to DB before `enqueueStage`
- [ ] ≤500 path: `enqueueStage` called with `stage: "research"` (not `"poll"`)
- [ ] >500 path: unchanged — still `fireBulkFirecrawlJobs` + `enqueueStage("poll")`
- [ ] BP-1 through BP-6 unit tests pass
- [ ] 5-URL smoke test: all 5 provided URLs appear in `crawlData.pages`
- [ ] Pipeline completes (research → analyze → generate → assemble) without hanging
- [ ] All 743 existing tests pass
- [ ] Committed to `dev-sprint-7` branch, PR opened against `main`

---

## ReviewMaster Notes

- Focus tests on the branching logic in `handleCrawlBulk`: ≤500 takes batch/scrape,
  >500 takes async spider. Both branches must be tested.
- `handleCrawlBulk` is not exported — test via the POST handler with
  `stage: "crawl"` and `isBulk: true` in the payload (check existing
  `bulk-pipeline.test.ts` for the pattern).
- Do NOT modify `handlePoll`, `handleResearch`, or any other stage function —
  only `handleCrawlBulk` changes.
- After writing tests, notify ScriptDev via ACTIVATE-6.

## ScriptDev Notes

- Two edits: (1) add imports to line 37 + new import line after 38, (2) replace
  `handleCrawlBulk` body (lines 179–218) with new implementation above.
- Run `npm test` after each edit. All 743 tests must pass before PR.
- Branch: `dev-sprint-7`. Open PR against `main` when tests pass.
