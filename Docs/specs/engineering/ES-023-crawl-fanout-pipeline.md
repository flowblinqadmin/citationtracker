# ES-023: Crawl Fan-out / Fan-in Pipeline

**Status:** Ready for implementation
**Author:** SpecMaster
**Date:** 2026-03-04
**Source spec:** TS-023-crawl-fanout-pipeline.md
**Priority:** P1
**Downstream:** ReviewMaster → ScriptDev

---

## a) Overview

Replaces the current two-phase crawl architecture with a unified fan-out/fan-in architecture using Firecrawl's `/v1/batch/scrape` endpoint. Both standard and bulk audits use the same code path.

**Current state:**
- `handleCrawl()` — Phase 1 scrape pass (`firecrawlScrapePass`) + Phase 2 `asyncCrawlUrl` jobs + hardcoded 60s delay before poll
- `handleCrawlBulk()` — calls `submitChunkedBatchScrape()`, which processes 500-URL chunks **sequentially**
- `handlePoll()` — polls asyncCrawlUrl jobs with exponential backoff
- `lib/services/chunked-firecrawl.ts` — synchronous sequential chunk runner; to be **deleted**

**New state:**
- `handleCrawlFanout()` — submits all chunks concurrently via `asyncBatchScrapeUrls` in ~5-10s, enqueues one independent `poll-chunk` QStash job per chunk, returns immediately
- `handlePollChunk()` — independent QStash job per chunk; polls one Firecrawl batch job; re-enqueues itself if still running; on completion calls fan-in
- `handleMergeCrawl()` — triggered by the last `poll-chunk` via Postgres atomic counter; flattens all chunk results, quality-checks, enqueues research
- Fan-in: Postgres atomic `UPDATE ... RETURNING` — last chunk to complete atomically observes `done === total` and enqueues `merge-crawl`. Greedy: each chunk completes as fast as it can and the final one instantly fires the next stage.

**Latency improvement:**
- Standard audits: crawl phase 80-140s → ~25-27s (~1.5-2 min saved)
- Bulk audits (500 pages): crawl phase ~500s sequential → ~50s parallel (~7 min saved)

---

## b) Implementation Requirements

### 1. DB — `lib/db/schema.ts`

Add 4 columns to the `geoSites` table definition:

```typescript
// Crawl fan-out coordination (ES-023 / TS-023)
crawlChunksTotal:  integer("crawl_chunks_total"),
crawlChunksDone:   integer("crawl_chunks_done"),
crawlChunkResults: jsonb("crawl_chunk_results").$type<CrawledPage[][]>(),
crawlStartedAt:    timestamp("crawl_started_at"),
```

`CrawledPage` is imported from `@/lib/services/geo-crawler`. `crawlChunkResults` is an array of arrays: `crawlChunkResults[n]` holds the `CrawledPage[]` from chunk `n`. `merge-crawl` flattens via `.flat()`.

The existing `crawlJobIds` column is kept (backward compat for in-flight jobs during rollout).

---

### 2. Migration — `drizzle/migrations/0003_add_crawl_fanout_columns.sql`

```sql
ALTER TABLE geo_sites ADD COLUMN crawl_chunks_total  integer;
ALTER TABLE geo_sites ADD COLUMN crawl_chunks_done   integer;
ALTER TABLE geo_sites ADD COLUMN crawl_chunk_results jsonb;
ALTER TABLE geo_sites ADD COLUMN crawl_started_at    timestamp;
```

---

### 3. `lib/config.ts`

**Add:**
```typescript
// Crawl fan-out pipeline (TS-023)
export const CRAWL_MAX_CHUNKS = 10;                           // max concurrent Firecrawl batch jobs
export const POLL_CHUNK_INTERVAL_S = 15;                      // seconds between poll-chunk retries
export const POLL_CHUNK_CIRCUIT_BREAKER_MS = 20 * 60 * 1000; // 20 min hard limit per chunk
```

**Remove** (no longer referenced after chunked-firecrawl.ts is deleted):
- `FIRECRAWL_CHUNK_SIZE`
- `FIRECRAWL_POLL_INTERVAL_MS`
- `FIRECRAWL_MAX_RETRIES`
- `BULK_CHUNKING_THRESHOLD`

---

### 4. `lib/qstash.ts`

**Update `PipelineStage` type** — replace `"crawl"` and `"poll"` with three new stages:

```typescript
export type PipelineStage =
  | "discover"
  | "crawl-fanout"   // replaces "crawl"
  | "poll-chunk"     // replaces "poll"
  | "merge-crawl"    // new
  | "research"
  | "analyze"
  | "generate"
  | "assemble";
```

**Update `StagePayload` interface** — add fields for poll-chunk, remove fields only used by old crawl/poll:

```typescript
export interface StagePayload {
  siteId: string;
  domain: string;
  stage: PipelineStage;
  maxPages?: number;         // discover + crawl-fanout (standard audit)
  chunkIndex?: number;       // poll-chunk: which chunk this job handles (0-based)
  firecrawlJobId?: string;   // poll-chunk: Firecrawl batch job ID to poll
  stageRetryCount?: number;  // retry counter (unchanged)
}
```

Remove `isBulk`, `crawlStartedAt`, `pollCount` after confirming no remaining callers outside route.ts.

---

### 5. `lib/services/geo-crawler.ts`

#### 5a) Remove these functions (superseded by fan-out architecture)
- `firecrawlScrapePass()`
- `fireFirecrawlJobs()`
- `fireBulkFirecrawlJobs()`
- `pollFirecrawlJobs()`
- `scrapeWithFirecrawl()`
- `scrapeWithFirecrawlOnce()`

`retryBlockedPages()` is kept (not called from route.ts after this change; removal is a follow-up cleanup).

#### 5b) Move in from `chunked-firecrawl.ts` (before deleting that file)

These are needed by `handlePollChunk` in route.ts. Move verbatim and export `mapDocumentToPage`:

```typescript
// Minimum markdown length to consider a page usable
const MIN_CONTENT_LENGTH = 50;

function hasContent(md: string): boolean {
  return md.replace(/\s+/g, " ").trim().length >= MIN_CONTENT_LENGTH;
}

function extractFaq(text: string): { question: string; answer: string }[] { /* verbatim */ }

export type FcDoc = {
  markdown?: string;
  metadata?: { title?: string; url?: string; sourceURL?: string; [key: string]: unknown };
};

/**
 * Map a Firecrawl Document to a CrawledPage.
 * Returns null if content is too thin or URL is missing.
 */
export function mapDocumentToPage(
  doc: FcDoc,
  pageMap: Record<string, PageType>
): CrawledPage | null { /* verbatim from chunked-firecrawl.ts */ }
```

`hasContent` and `extractFaq` stay unexported.

#### 5c) Add new exported function

```typescript
/**
 * Compute fan-out chunk count and chunk size from total page count.
 *
 * Formula: num_chunks = min(CRAWL_MAX_CHUNKS, total_pages)
 *          chunk_size = ceil(total_pages / num_chunks)
 *
 * Edge case: totalPages === 0 → returns { numChunks: 0, chunkSize: 0 }
 *
 * Examples:
 *   1   → { numChunks: 1,  chunkSize: 1 }
 *   9   → { numChunks: 9,  chunkSize: 1 }
 *   10  → { numChunks: 10, chunkSize: 1 }
 *   50  → { numChunks: 10, chunkSize: 5 }
 *   100 → { numChunks: 10, chunkSize: 10 }
 *   500 → { numChunks: 10, chunkSize: 50 }
 */
export function computeChunks(totalPages: number): { numChunks: number; chunkSize: number } {
  if (totalPages === 0) return { numChunks: 0, chunkSize: 0 };
  const numChunks = Math.min(CRAWL_MAX_CHUNKS, totalPages);
  const chunkSize = Math.ceil(totalPages / numChunks);
  return { numChunks, chunkSize };
}
```

Import `CRAWL_MAX_CHUNKS` from `@/lib/config`.

---

### 6. `lib/services/chunked-firecrawl.ts`

**Delete this file.** Move `mapDocumentToPage`, `hasContent`, `extractFaq`, `FcDoc` to `geo-crawler.ts` first (§5b above).

---

### 7. `app/api/pipeline/stage/route.ts`

#### 7a) Update imports

**Remove:**
```typescript
import {
  firecrawlScrapePass,
  fireFirecrawlJobs,
  fireBulkFirecrawlJobs,
  pollFirecrawlJobs,
  retryBlockedPages,
  ...
} from "@/lib/services/geo-crawler";
import { submitChunkedBatchScrape } from "@/lib/services/chunked-firecrawl";
import { bulkCreditsRequired, FREE_MAX_PAGES, BULK_CHUNKING_THRESHOLD } from "@/lib/config";
```

**Add:**
```typescript
import {
  CRAWL_MAX_CHUNKS,
  POLL_CHUNK_INTERVAL_S,
  POLL_CHUNK_CIRCUIT_BREAKER_MS,
  FREE_MAX_PAGES,
} from "@/lib/config";
import {
  computeChunks,
  mapDocumentToPage,
  classifyPageType,
  scoreCrawlQuality,
  discoverSite,
  type FcDoc,
  type CrawledPage,
  type CrawlData,
  type DiscoveryData,
  type PageType,
} from "@/lib/services/geo-crawler";
import { FirecrawlAppV1 } from "@mendable/firecrawl-js";
```

#### 7b) Update `markFailed()`

Add fan-out column resets to avoid stale counter state on re-run:

```typescript
async function markFailed(siteId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[stage] Marking site ${siteId} failed:`, message);
  await db
    .update(geoSites)
    .set({
      pipelineStatus: "failed",
      pipelineError: message,
      crawlJobIds: null,
      crawlChunksDone: null,
      crawlChunksTotal: null,
      crawlChunkResults: null,
      updatedAt: new Date(),
    })
    .where(eq(geoSites.id, siteId));
}
```

#### 7c) Update `handleDiscover()`

```typescript
// Before:
await enqueueStage({ siteId, domain, stage: "crawl", maxPages });

// After:
await enqueueStage({ siteId, domain, stage: "crawl-fanout", maxPages });
```

#### 7d) Search and update all other `enqueueStage` callers

Search for any code that enqueues `stage: "crawl"` or `stage: "crawl", isBulk: true` outside route.ts and update to `stage: "crawl-fanout"`. The `isBulk` field is no longer needed.

#### 7e) Remove old handlers

Delete: `handleCrawl()`, `handleCrawlBulk()`, `handlePoll()`.

#### 7f) Add `handleCrawlFanout()`

```typescript
async function handleCrawlFanout(siteId: string, domain: string, maxPages: number): Promise<void> {
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) throw new Error("Site not found");

  // ── Build URL list ──────────────────────────────────────────────────────────
  let urls: string[];
  let pageMap: Record<string, ReturnType<typeof classifyPageType>>;

  if (site.auditMode === "bulk") {
    // Bulk: synthetic pageMap from bulkUrls, respecting crawlLimit
    const allUrls = (site.bulkUrls as string[] | null) ?? [];
    const crawlLimit = (site.crawlLimit as number | null) ?? allUrls.length;
    const urlsToProcess = allUrls.slice(0, crawlLimit);
    pageMap = {};
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
    urls = urlsToProcess;
  } else {
    // Standard: use discoveryData written by handleDiscover
    const discoveryData = site.discoveryData as DiscoveryData | null;
    if (!discoveryData) throw new Error("No discovery data — discover stage may not have completed");
    urls = Object.keys(discoveryData.pageMap).slice(0, maxPages);
    pageMap = discoveryData.pageMap;
    await updateStatus(siteId, "crawling");
  }

  // Edge case: no URLs
  if (urls.length === 0) {
    await updateStatus(siteId, "crawling", {
      crawlData: { domain, pages: [], totalCrawled: 0 } as unknown as Record<string, unknown>,
    });
    await enqueueStage({ siteId, domain, stage: "research" });
    return;
  }

  if (!process.env.FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY not set");
  const fc = new FirecrawlAppV1({ apiKey: process.env.FIRECRAWL_API_KEY });

  const { numChunks, chunkSize } = computeChunks(urls.length);
  const crawlStartedAt = new Date();

  // ── Persist coordination state BEFORE enqueuing any poll-chunk jobs ─────────
  await db.update(geoSites).set({
    crawlChunksTotal: numChunks,
    crawlChunksDone: 0,
    crawlChunkResults: [] as unknown as Record<string, unknown>[],
    crawlStartedAt,
    updatedAt: new Date(),
  }).where(eq(geoSites.id, siteId));

  // ── Submit all chunks concurrently, enqueue poll-chunk per successful job ──
  for (let chunkIndex = 0; chunkIndex < numChunks; chunkIndex++) {
    const start = chunkIndex * chunkSize;
    const chunkUrls = urls.slice(start, start + chunkSize);

    let firecrawlJobId: string | undefined;
    try {
      const result = await fc.asyncBatchScrapeUrls(chunkUrls, {
        formats: ["markdown"] as ["markdown"],
        onlyMainContent: false,
        mobile: true,
        waitFor: 2000,
      }) as { id?: string };
      firecrawlJobId = result?.id;
    } catch (err) {
      console.warn(`[crawl-fanout] asyncBatchScrapeUrls failed for chunk ${chunkIndex}:`, (err as Error).message);
    }

    if (!firecrawlJobId) {
      // Failed submission: persist failed row, atomically increment counter (treat as completed-empty)
      await db.insert(firecrawlJobs).values({
        id: nanoid(),
        siteId,
        firecrawlJobId: `failed-submission-${chunkIndex}`,
        chunkIndex,
        urlCount: chunkUrls.length,
        status: "failed",
        urlsSubmitted: chunkUrls,
        urlsCompleted: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const [{ done, total }] = await db
        .update(geoSites)
        .set({ crawlChunksDone: sql`crawl_chunks_done + 1` })
        .where(eq(geoSites.id, siteId))
        .returning({
          done: geoSites.crawlChunksDone,
          total: geoSites.crawlChunksTotal,
        });

      if (done === total) {
        await enqueueStage({ siteId, domain, stage: "merge-crawl" });
        return;
      }
      continue;
    }

    // Successful submission: persist monitoring row, enqueue independent QStash job
    await db.insert(firecrawlJobs).values({
      id: nanoid(),
      siteId,
      firecrawlJobId,
      chunkIndex,
      urlCount: chunkUrls.length,
      status: "scraping",
      urlsSubmitted: chunkUrls,
      urlsCompleted: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await enqueueStage({ siteId, domain, stage: "poll-chunk", chunkIndex, firecrawlJobId });

    console.warn(JSON.stringify({
      event: "crawl_fanout_chunk_submitted",
      siteId, chunkIndex, urlCount: chunkUrls.length, firecrawlJobId,
    }));
  }

  console.warn(JSON.stringify({
    event: "crawl_fanout_complete",
    siteId, numChunks, chunkSize,
  }));
}
```

#### 7g) Add `handlePollChunk()`

```typescript
async function handlePollChunk(
  siteId: string,
  domain: string,
  chunkIndex: number,
  firecrawlJobId: string
): Promise<void> {
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) throw new Error("Site not found");

  // Circuit breaker: 20-minute hard limit from crawl start
  const crawlStartedAt = site.crawlStartedAt ?? new Date(0);
  const elapsedMs = Date.now() - new Date(crawlStartedAt).getTime();
  if (elapsedMs > POLL_CHUNK_CIRCUIT_BREAKER_MS) {
    console.warn(JSON.stringify({
      event: "poll_chunk_circuit_breaker",
      siteId, chunkIndex, elapsedMs,
    }));
    await fanInChunk(siteId, domain, chunkIndex, []);
    return;
  }

  if (!process.env.FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY not set");
  const fc = new FirecrawlAppV1({ apiKey: process.env.FIRECRAWL_API_KEY });

  type BatchJobStatus = {
    status: "scraping" | "completed" | "failed" | "cancelled";
    data?: FcDoc[];
  };

  let jobStatus: BatchJobStatus;
  try {
    jobStatus = await fc.checkBatchScrapeStatus(firecrawlJobId) as unknown as BatchJobStatus;
  } catch (err) {
    // Transient error: re-enqueue self
    console.warn(`[poll-chunk] checkBatchScrapeStatus error for ${firecrawlJobId}:`, (err as Error).message);
    await enqueueStage({ siteId, domain, stage: "poll-chunk", chunkIndex, firecrawlJobId }, POLL_CHUNK_INTERVAL_S);
    return;
  }

  if (jobStatus.status === "scraping") {
    await enqueueStage({ siteId, domain, stage: "poll-chunk", chunkIndex, firecrawlJobId }, POLL_CHUNK_INTERVAL_S);
    return;
  }

  // Job completed or failed
  const docs: FcDoc[] = Array.isArray(jobStatus.data) ? jobStatus.data as FcDoc[] : [];
  const discoveryData = site.discoveryData as DiscoveryData | null;
  const pageMap = discoveryData?.pageMap ?? {};

  let pages: CrawledPage[] = docs
    .map((d) => mapDocumentToPage(d, pageMap))
    .filter((p): p is CrawledPage => p !== null);

  // Single inline retry for URLs that returned no usable content
  const [jobRow] = await db.select().from(firecrawlJobs)
    .where(eq(firecrawlJobs.firecrawlJobId, firecrawlJobId));
  const submittedUrls = (jobRow?.urlsSubmitted as string[] | null) ?? [];
  const successUrls = new Set(pages.map((p) => p.url));
  const failedUrls = submittedUrls.filter((u) => !successUrls.has(u));

  if (failedUrls.length > 0) {
    try {
      const retryResult = await fc.asyncBatchScrapeUrls(failedUrls, {
        formats: ["markdown"] as ["markdown"],
        onlyMainContent: false,
        mobile: true,
        waitFor: 2000,
      }) as { id?: string };

      if (retryResult?.id) {
        // Single inline poll: wait then check once (non-recursive)
        await new Promise((r) => setTimeout(r, POLL_CHUNK_INTERVAL_S * 1000));
        const retryStatus = await fc.checkBatchScrapeStatus(retryResult.id) as unknown as BatchJobStatus;
        const retryDocs: FcDoc[] = Array.isArray(retryStatus.data) ? retryStatus.data as FcDoc[] : [];
        const retryPages = retryDocs
          .map((d) => mapDocumentToPage(d, pageMap))
          .filter((p): p is CrawledPage => p !== null);
        pages = [...pages, ...retryPages];
        console.warn(`[poll-chunk] Chunk ${chunkIndex} retry: ${retryPages.length}/${failedUrls.length} recovered`);
      }
    } catch (err) {
      console.warn(`[poll-chunk] Chunk ${chunkIndex} retry failed:`, (err as Error).message);
    }
  }

  // Update firecrawl_jobs row
  await db.update(firecrawlJobs)
    .set({
      status: jobStatus.status === "completed" ? "completed" : "failed",
      urlsCompleted: pages.map((p) => p.url),
      updatedAt: new Date(),
    })
    .where(eq(firecrawlJobs.firecrawlJobId, firecrawlJobId));

  await fanInChunk(siteId, domain, chunkIndex, pages);
}
```

#### 7h) Add `fanInChunk()` helper

Atomically appends chunk pages to `crawlChunkResults` and increments `crawlChunksDone` in a single UPDATE. The first invocation that observes `done === total` enqueues `merge-crawl`.

```typescript
/**
 * Atomically append chunk pages to crawlChunkResults and increment crawlChunksDone.
 * Uses a single UPDATE to combine both writes; RETURNING guarantees exactly-one
 * merge-crawl trigger regardless of concurrent poll-chunk completions.
 *
 * crawlChunkResults is a jsonb array of CrawledPage[]; each element is one chunk's pages.
 * We wrap pages in an outer array before appending so the JSONB || operator adds it
 * as a single element (not element-by-element).
 */
async function fanInChunk(
  siteId: string,
  domain: string,
  chunkIndex: number,
  pages: CrawledPage[]
): Promise<void> {
  const chunkPagesJson = JSON.stringify(pages); // serialise CrawledPage[] as JSON array

  // Combine crawlChunkResults append + crawlChunksDone increment in one atomic UPDATE
  const [row] = await db
    .update(geoSites)
    .set({
      crawlChunkResults: sql`COALESCE(crawl_chunk_results, '[]'::jsonb) || ${chunkPagesJson}::jsonb`,
      crawlChunksDone: sql`crawl_chunks_done + 1`,
      updatedAt: new Date(),
    })
    .where(eq(geoSites.id, siteId))
    .returning({
      done: geoSites.crawlChunksDone,
      total: geoSites.crawlChunksTotal,
    });

  const done = row?.done;
  const total = row?.total;

  console.warn(JSON.stringify({
    event: "poll_chunk_fan_in",
    siteId, chunkIndex, pagesCollected: pages.length, done, total,
  }));

  if (done !== null && done !== undefined && total !== null && total !== undefined && done === total) {
    await enqueueStage({ siteId, domain, stage: "merge-crawl" });
  }
}
```

**Note on `crawlChunkResults` append:** `JSON.stringify(pages)` produces a JSON array `[page1, page2, ...]`. Appending this directly via `||` to the outer jsonb array concatenates each element individually (flattening), not as a nested array. To append `pages` as a single nested element (preserving `CrawledPage[][]` structure), wrap: `JSON.stringify([pages])`. Then `merge-crawl` reads `crawlChunkResults` as `CrawledPage[][]` and calls `.flat()`.

Correct implementation: use `JSON.stringify([pages])` (array wrapping pages array):
```typescript
const chunkPagesJson = JSON.stringify([pages]); // [[page1, page2, ...]] — appends as one element
```

#### 7i) Add `handleMergeCrawl()`

```typescript
async function handleMergeCrawl(siteId: string, domain: string): Promise<void> {
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) throw new Error("Site not found");

  // Flatten crawlChunkResults (CrawledPage[][]) into a single CrawledPage[]
  const chunkResults = (site.crawlChunkResults as CrawledPage[][] | null) ?? [];
  const allPages: CrawledPage[] = chunkResults.flat();

  const crawlData: CrawlData = {
    domain,
    pages: allPages,
    totalCrawled: allPages.length,
  };
  const crawlQuality = scoreCrawlQuality(crawlData);

  if (!crawlQuality.usable) {
    if (site.auditMode === "bulk" && crawlQuality.goodPages > 0) {
      console.warn(JSON.stringify({
        event: "merge_crawl_partial",
        siteId, goodPages: crawlQuality.goodPages, issues: crawlQuality.issues,
      }));
    } else {
      await markFailed(
        siteId,
        `Crawl quality too low: ${crawlQuality.issues.join("; ")}. Got ${crawlQuality.goodPages} usable pages.`
      );
      return;
    }
  }

  await updateStatus(siteId, "crawling", {
    crawlData: crawlData as unknown as Record<string, unknown>,
    crawlJobIds: null,
  });

  console.warn(JSON.stringify({
    event: "merge_crawl_complete",
    siteId, totalPages: allPages.length, goodPages: crawlQuality.goodPages,
  }));

  await enqueueStage({ siteId, domain, stage: "research" });
}
```

#### 7j) Update the `switch` statement in `POST()`

```typescript
case "crawl-fanout":
  await handleCrawlFanout(siteId, domain, maxPages ?? FREE_MAX_PAGES);
  break;
case "poll-chunk": {
  const { chunkIndex, firecrawlJobId } = payload;
  if (chunkIndex === undefined || !firecrawlJobId) {
    console.error("[stage] poll-chunk missing chunkIndex or firecrawlJobId", payload);
  } else {
    await handlePollChunk(siteId, domain, chunkIndex, firecrawlJobId);
  }
  break;
}
case "merge-crawl":
  await handleMergeCrawl(siteId, domain);
  break;
```

Remove the `"crawl"` and `"poll"` cases.

#### 7k) `retryableStages` — no change needed

`["research", "analyze", "generate", "assemble"]` is correct as-is. `crawl-fanout`, `poll-chunk`, `merge-crawl` must NOT be auto-retried (would create duplicate Firecrawl jobs).

#### 7l) `maxDuration` note

Module-level `maxDuration = 120` stays. Vercel does not support per-handler maxDuration in a single route file. Per-stage targets from TS-023: `crawl-fanout` 30s, `poll-chunk` 30s, `merge-crawl` 30s — all well within 120s.

---

## c) Unit Test Plan

**Test file:** `geo/__tests__/crawl-fanout.test.ts`

Mock pattern: `vi.mock("@mendable/firecrawl-js", ...)` + `vi.mock("@/lib/db", ...)` following `geo-crawler.test.ts`. Use `vi.hoisted()` for Firecrawl mock instance.

### `computeChunks()` — 8 cases

| ID | Input `totalPages` | Expected `numChunks` | Expected `chunkSize` |
|----|-------------------|----------------------|----------------------|
| C-1 | 1 | 1 | 1 |
| C-2 | 5 | 5 | 1 |
| C-3 | 9 | 9 | 1 |
| C-4 | 10 | 10 | 1 |
| C-5 | 50 | 10 | 5 |
| C-6 | 100 | 10 | 10 |
| C-7 | 500 | 10 | 50 |
| C-8 | 0 | 0 | 0 |

**Invariant check:** For any `totalPages ≥ 1`: `numChunks * chunkSize >= totalPages`.

### `mapDocumentToPage()` — 5 cases

| ID | Input | Expected |
|----|-------|----------|
| M-1 | `{ markdown: "A".repeat(200), metadata: { url: "https://ex.com/about", title: "About" } }`, pageMap `"about"` | Returns `CrawledPage` with correct url, pageType, title |
| M-2 | `{ markdown: "", metadata: { url: "https://ex.com/" } }` | `null` (empty markdown) |
| M-3 | `{ markdown: "Short.", metadata: { url: "https://ex.com/" } }` | `null` (< 50 chars) |
| M-4 | `{ markdown: "A".repeat(200), metadata: {} }` | `null` (no url) |
| M-5 | Markdown with `**Question?\n**\nAnswer...` pattern, valid metadata | `CrawledPage` with non-empty `faqContent` |

### `geo-crawler.test.ts` — required updates

**Remove** test suites for `firecrawlScrapePass()` and `fireFirecrawlJobs()` — those functions are deleted.

**Keep unchanged:** `discoverSite()`, `scoreCrawlQuality()`, `classifyPageType()` suites.

---

## d) Integration Test Plan

**Test file:** `geo/__tests__/integration/crawl-fanout-flow.test.ts`

Pattern: `vitest.integration.config.ts` (`pool: 'forks'`, `singleFork: true`, `globalSetup`/`globalTeardown`, `.env.test`). Requires `TEST_BASE_URL` and Supabase service role key.

| ID | Scenario | Pass criteria |
|----|----------|---------------|
| I-1 | **Fan-out DB state**: POST `crawl-fanout` for a 5-page site. Assert `crawlChunksTotal=5`, `crawlChunksDone=0`, 5 `firecrawl_jobs` rows with status `scraping`. | DB assertions within 15s |
| I-2 | **Fan-in exactly-once**: POST 3 `poll-chunk` payloads for a site with `crawlChunksTotal=3`. Assert exactly 1 `merge-crawl` QStash message sent. | 1 merge-crawl enqueue |
| I-3 | **Circuit breaker**: Set `crawlStartedAt` to 25 min ago in DB. POST `poll-chunk`. Assert chunk contributes 0 pages, `crawlChunksDone` incremented. | Correct fan-in, no block |
| I-4 | **All chunks fail submission**: Mock `asyncBatchScrapeUrls` to throw for all chunks. Assert `merge-crawl` is enqueued, `pipelineStatus` not `"failed"`. | merge-crawl enqueued |
| I-5 | **Bulk audit path**: Provision bulk site with 50 `bulkUrls`, `crawlLimit=50`. POST `crawl-fanout`. Assert `discoveryData.totalPages=50`, `crawlChunksTotal=10`, research enqueued after merge. | DB + QStash assertions |

---

## e) Profiling Requirements

Measure in staging with a 50-page standard audit:
- `handleCrawlFanout` wall-clock time (submission loop only): target ≤ 10s
- `handlePollChunk` wall-clock time (excluding inline retry wait): target ≤ 3s
- `handleMergeCrawl` wall-clock time: target ≤ 5s

Use log events `crawl_fanout_complete`, `poll_chunk_fan_in`, `merge_crawl_complete` for timing analysis.

---

## f) Load Test Plan

### Scenario A — Standard audit (50 pages, 10 chunks)
- 20 concurrent audits → 200 concurrent poll-chunk QStash jobs
- Success criteria: p95 crawl phase ≤ 30s

### Scenario B — Bulk audit (500 pages, 10 chunks of 50 URLs)
- 5 concurrent bulk audits
- Success criteria: p95 crawl phase ≤ 60s

### Scenario C — Fan-in race condition stress test
- 10-chunk site with all chunks completing within the same 1s window
- Verify exactly one `merge-crawl` enqueued
- Repeat 20 times

---

## g) Logging & Instrumentation

All log events use `JSON.stringify` + `console.warn`:

| Event | Stage | Fields |
|-------|-------|--------|
| `crawl_fanout_chunk_submitted` | crawl-fanout | `siteId, chunkIndex, urlCount, firecrawlJobId` |
| `crawl_fanout_complete` | crawl-fanout | `siteId, numChunks, chunkSize` |
| `poll_chunk_circuit_breaker` | poll-chunk | `siteId, chunkIndex, elapsedMs` |
| `poll_chunk_fan_in` | poll-chunk | `siteId, chunkIndex, pagesCollected, done, total` |
| `merge_crawl_partial` | merge-crawl | `siteId, goodPages, issues` |
| `merge_crawl_complete` | merge-crawl | `siteId, totalPages, goodPages` |

---

## h) Acceptance Criteria

- [ ] **AC-1** Standard audit (50 pages): crawl phase (fanout + poll-chunks + merge) completes in ≤ 30s
- [ ] **AC-2** Bulk audit (500 pages): crawl phase completes in ≤ 60s
- [ ] **AC-3** Sites with < 10 pages: `num_chunks === total_pages`
- [ ] **AC-4** 1-page site: single chunk, no fan-out overhead
- [ ] **AC-5** Fan-in is race-condition-free: `merge-crawl` enqueued exactly once regardless of simultaneous chunk completions
- [ ] **AC-6** A permanently failed chunk contributes 0 pages; pipeline does not stall
- [ ] **AC-7** Bulk partial crawl policy preserved: proceed if `goodPages > 0`
- [ ] **AC-8** `firecrawl_jobs` rows written per chunk with correct `status`, `urlsSubmitted`, `urlsCompleted`
- [ ] **AC-9** All existing integration tests pass — audit quality equivalent to pre-refactor
- [ ] **AC-10** `computeChunks()` unit tests C-1 through C-8 all pass
- [ ] **AC-11** `mapDocumentToPage()` unit tests M-1 through M-5 all pass
- [ ] **AC-12** `geo-crawler.test.ts` passes after removing `firecrawlScrapePass`/`fireFirecrawlJobs` suites
- [ ] **AC-13** `chunked-firecrawl.ts` deleted with no remaining imports
- [ ] **AC-14** Migration `0003_add_crawl_fanout_columns.sql` applied; 4 new columns on `geo_sites`
- [ ] **AC-15** `FIRECRAWL_CHUNK_SIZE`, `FIRECRAWL_POLL_INTERVAL_MS`, `FIRECRAWL_MAX_RETRIES`, `BULK_CHUNKING_THRESHOLD` removed from `lib/config.ts`

---

## Risks & Notes

| Risk | Note |
|------|------|
| `crawlChunkResults` JSONB append semantics | Use `JSON.stringify([pages])` (wrapped in outer array) so `||` appends as one nested element, not element-by-element. `merge-crawl` reads as `CrawledPage[][]` and calls `.flat()`. |
| Firecrawl concurrent batch job limit | Verify with Firecrawl before go-live. Reduce `CRAWL_MAX_CHUNKS` if limit < 10. |
| Fan-in race in Drizzle `.returning()` | Drizzle `UPDATE ... RETURNING` maps to a single atomic SQL statement — Postgres serialises concurrent updates on the same row. Only one transaction observes `done === total`. |
| Inline retry blocks 15s | poll-chunk invocations with failed URLs will block ~15s. Within 30s maxDuration target. |
| Other `enqueueStage("crawl")` callers | grep for `stage: "crawl"` across codebase — any callers outside route.ts must update to `"crawl-fanout"`. |
| `retryBlockedPages` dead code | No longer called from route.ts. Keep for now; remove in follow-up cleanup. |
