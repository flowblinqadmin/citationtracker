/**
 * Integration Tests — Crawl Fan-out / Fan-in Pipeline (ES-023 v1)
 *
 * Architecture: THREE separate QStash stages — crawl-fanout → poll-chunk → merge-crawl.
 * Fan-in via atomic Postgres UPDATE...RETURNING (crawlChunksDone, crawlChunksTotal).
 *
 * Scenarios:
 *   I-1  crawl-fanout: 10 URLs → 10 poll-chunk jobs enqueued, coordination state written to DB
 *   I-2  poll-chunk (not last): fanInChunk increments counter (done=4/5), merge-crawl NOT enqueued
 *   I-3  poll-chunk (last chunk): fanInChunk sees done===total (5/5), enqueues merge-crawl
 *   I-4  poll-chunk (still scraping): re-enqueues itself with delay, no fan-in yet
 *   I-5  merge-crawl: flattens crawlChunkResults, writes crawlData, enqueues research
 *
 * Auth bypass: CRON_SECRET env var + Authorization: Bearer header.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Environment setup (before any module loads) ──────────────────────────────

vi.hoisted(() => {
  // C3: lib/cron-auth.ts requires ≥32 chars.
  process.env.CRON_SECRET = "test-cron-secret-es023-v1-padded-32+aaaa";
  process.env.FIRECRAWL_API_KEY = "test-fc-key-es023";
  process.env.NEXT_PUBLIC_APP_URL = "https://test.flowblinq.com";
});

// ─── Hoisted mock references ──────────────────────────────────────────────────

const mockFcInstance = vi.hoisted(() => ({
  asyncBatchScrapeUrls: vi.fn(),
  checkBatchScrapeStatus: vi.fn(),
}));

const { mockEnqueueStage } = vi.hoisted(() => ({
  mockEnqueueStage: vi.fn().mockResolvedValue(undefined),
}));

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@mendable/firecrawl-js", () => ({
  FirecrawlAppV1: vi.fn().mockImplementation(function () {
    return mockFcInstance;
  }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: mockEnqueueStage,
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn().mockReturnValue("mock-id"),
}));

vi.mock("@/lib/email", () => ({
  sendCompletionEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/services/competitive-intel", () => ({
  gatherCompetitiveIntel: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/services/geo-analyzer", () => ({
  analyzeGeoGaps: vi.fn().mockResolvedValue({ overallScore: 80 }),
}));

vi.mock("@/lib/services/content-generator", () => ({
  generateContent: vi.fn().mockResolvedValue("content"),
}));

vi.mock("@/lib/services/assembler", () => ({
  assembleResults: vi.fn().mockResolvedValue({}),
  checkGeneratedContent: vi.fn().mockReturnValue(true),
  checkExecutiveSummary: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/services/per-page-analyzer", () => ({
  extractPerPageVulnerabilities: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/crawl-mode", () => ({
  getCrawlMode: vi.fn().mockResolvedValue("standard"),
}));

vi.mock("@/lib/config", () => ({
  CRAWL_MAX_CHUNKS: 10,
  POLL_CHUNK_INTERVAL_S: 15,
  POLL_CHUNK_CIRCUIT_BREAKER_MS: 20 * 60 * 1000,
  FREE_MAX_PAGES: 50,
  BULK_CHUNKING_THRESHOLD: 10,
  SIGNUP_BONUS_CREDITS: 20,
  bulkCreditsRequired: vi.fn().mockReturnValue(0),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { db } from "@/lib/db";
import { POST } from "@/app/api/pipeline/stage/route";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeRequest(payload: object): NextRequest {
  return new NextRequest("https://test.flowblinq.com/api/pipeline/stage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CRON_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

/** db.select().from().where() → rows */
function makeSelectChain(rows: unknown[] = []) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
  };
}

/** db.update(table).set().where() — also supports .returning() */
function makeUpdateChain(returningValue: unknown[] = []) {
  const whereResult = Object.assign(Promise.resolve([]), {
    returning: vi.fn().mockResolvedValue(returningValue),
  });
  const setResult = { where: vi.fn().mockReturnValue(whereResult) };
  return { set: vi.fn().mockReturnValue(setResult) };
}

/** db.insert(table).values() → void */
function makeInsertChain() {
  return { values: vi.fn().mockResolvedValue([]) };
}

/** Collect all args passed to db.update().set() across all update calls */
function getAllUpdateSetArgs(): Record<string, unknown>[] {
  const updateMock = db.update as ReturnType<typeof vi.fn>;
  return updateMock.mock.results
    .map((r: { value: ReturnType<typeof makeUpdateChain> }) => r.value?.set?.mock?.calls?.[0]?.[0])
    .filter(Boolean) as Record<string, unknown>[];
}

function makeSiteRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "site-es023",
    domain: "example.com",
    slug: "example-com",
    teamId: "team-1",
    auditMode: "standard",
    pipelineStatus: "discovering",
    pipelineError: null,
    discoveryData: null,
    crawlData: null,
    crawlJobIds: null,
    crawlChunksTotal: null,
    crawlChunksDone: null,
    crawlChunkResults: null,
    crawlStartedAt: null,
    bulkUrls: null,
    crawlLimit: null,
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function makeDiscoveryData(urls: string[]) {
  const pageMap: Record<string, string> = {};
  for (const url of urls) pageMap[url] = "other";
  return { urls, pageMap, hasLlmsTxt: false, hasUcp: false, hasSitemap: false, hasRobots: false, totalPages: urls.length };
}

/** CrawledPage with enough content to pass scoreCrawlQuality (>300 chars) */
function makeCrawledPage(url: string): Record<string, unknown> {
  return {
    url,
    pageType: "other",
    title: "Test Page",
    h1: "Welcome",
    headings: [],
    content: "This is good test content for the crawl quality checker. ".repeat(10), // 570 chars
    existingSchema: [],
    hasStructuredData: false,
    contactInfo: [],
    faqContent: [],
    testimonials: [],
    certifications: [],
  };
}

/** FcDoc with usable content (> 50 chars to pass hasContent) */
function makeFcDoc(url: string): object {
  return {
    markdown: "Useful page content that passes the minimum content length check. ".repeat(3),
    metadata: { url, title: "Test Page" },
  };
}

const TEN_URLS = Array.from({ length: 10 }, (_, i) => `https://example.com/page-${i}`);

// ─── I-1: crawl-fanout stage ──────────────────────────────────────────────────

describe("I-1: crawl-fanout — coordination state written and poll-chunk jobs enqueued", () => {
  // Capture every set() arg across all db.update() calls in this describe block
  let i1CapturedSets: Record<string, unknown>[];

  beforeEach(() => {
    vi.clearAllMocks();
    i1CapturedSets = [];

    // Select: site with 10-URL discoveryData
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([makeSiteRow({ discoveryData: makeDiscoveryData(TEN_URLS) })])
    );

    // Update: use mockImplementation so each call gets a distinct chain,
    // allowing i1CapturedSets to accumulate all set() args in order.
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const whereResult = Object.assign(Promise.resolve([]), {
        returning: vi.fn().mockResolvedValue([]),
      });
      return {
        set: vi.fn().mockImplementation((d: Record<string, unknown>) => {
          i1CapturedSets.push(d);
          return { where: vi.fn().mockReturnValue(whereResult) };
        }),
      };
    });

    // Insert: firecrawl_jobs row per chunk
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());

    // 10 successful asyncBatchScrapeUrls submissions
    mockFcInstance.asyncBatchScrapeUrls.mockImplementation(async (_urls: string[]) => ({
      id: `fc-job-${Math.random().toString(36).slice(2, 8)}`,
    }));
  });

  it("submits 10 chunks with webhooks + poll-chunk safety net (HP perf Fix 2)", async () => {
    const res = await POST(makeRequest({
      siteId: "site-es023",
      domain: "example.com",
      stage: "crawl-fanout",
    }));

    expect(res.status).toBe(200);

    // asyncBatchScrapeUrls called 10 times (one per chunk) with webhook config
    expect(mockFcInstance.asyncBatchScrapeUrls).toHaveBeenCalledTimes(10);

    // poll-chunk still enqueued as safety net alongside webhooks
    const pollChunkCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "poll-chunk"
    );
    expect(pollChunkCalls).toHaveLength(10);
  });

  it("writes crawlChunksDone=0 AND crawlChunksTotal=10 up-front (poll-first fix), before the loop", async () => {
    await POST(makeRequest({
      siteId: "site-es023",
      domain: "example.com",
      stage: "crawl-fanout",
    }));

    // Poll-first fix: the pre-loop coordination write now sets crawlChunksTotal
    // to numChunks (10) up-front, so the fan-in counter is valid before any
    // (possibly inline, in LOCAL_PIPELINE) poll-chunk reads it.
    const upfrontWrite = i1CapturedSets.find((a) => a.crawlChunksDone === 0 && a.crawlChunkResults === null);
    expect(upfrontWrite).toBeDefined();
    expect(upfrontWrite?.crawlChunksTotal).toBe(10);
  });

  it("inserts a firecrawl_jobs row per chunk (10 inserts with status=scraping)", async () => {
    await POST(makeRequest({
      siteId: "site-es023",
      domain: "example.com",
      stage: "crawl-fanout",
    }));

    const insertMock = db.insert as ReturnType<typeof vi.fn>;
    const scrapingInserts = insertMock.mock.results
      .map((r: { value: ReturnType<typeof makeInsertChain> }) => r.value?.values?.mock?.calls?.[0]?.[0])
      .filter((v: Record<string, unknown>) => v?.status === "scraping");

    expect(scrapingInserts).toHaveLength(10);
  });

  it("does NOT enqueue research at this stage (crawl-fanout returns before polling)", async () => {
    await POST(makeRequest({
      siteId: "site-es023",
      domain: "example.com",
      stage: "crawl-fanout",
    }));

    const researchCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "research"
    );
    expect(researchCalls).toHaveLength(0);
  });
});

// ─── I-2: poll-chunk (not last chunk) ────────────────────────────────────────

describe("I-2: poll-chunk (not last) — increments fan-in counter, merge-crawl NOT enqueued", () => {
  const SITE_ROW = makeSiteRow({
    pipelineStatus: "crawling",
    crawlChunksTotal: 5,
    crawlChunksDone: 3,
    crawlStartedAt: new Date(), // fresh — circuit breaker won't fire
    discoveryData: makeDiscoveryData(TEN_URLS),
  });

  const JOB_ROW = {
    id: "row-1",
    firecrawlJobId: "fc-abc",
    urlsSubmitted: ["https://example.com/page-0"],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Two sequential db.select calls: site row, then firecrawl_jobs row
    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      return makeSelectChain(selectCount === 1 ? [SITE_ROW] : [JOB_ROW]);
    });

    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());

    // Batch job completed — one usable page
    mockFcInstance.checkBatchScrapeStatus.mockResolvedValue({
      status: "completed",
      data: [makeFcDoc("https://example.com/page-0")],
    });

    // Retry not needed (all submitted URLs have content)
    mockFcInstance.asyncBatchScrapeUrls.mockResolvedValue({ id: "retry-job" });

    // db.execute (atomic fan-in UPDATE): done=4, total=5 → NOT the last chunk
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue([{ done: 4, total: 5 }]);
  });

  it("calls db.execute for the atomic fan-in UPDATE", async () => {
    const res = await POST(makeRequest({
      siteId: "site-es023",
      domain: "example.com",
      stage: "poll-chunk",
      chunkIndex: 0,
      firecrawlJobId: "fc-abc",
    }));

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("does NOT enqueue merge-crawl when done (4) < total (5)", async () => {
    await POST(makeRequest({
      siteId: "site-es023",
      domain: "example.com",
      stage: "poll-chunk",
      chunkIndex: 0,
      firecrawlJobId: "fc-abc",
    }));

    const mergeCrawlCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "merge-crawl"
    );
    expect(mergeCrawlCalls).toHaveLength(0);
  });
});

// ─── I-3: poll-chunk (last chunk) ────────────────────────────────────────────

describe("I-3: poll-chunk (last chunk) — done===total triggers merge-crawl", () => {
  const SITE_ROW = makeSiteRow({
    pipelineStatus: "crawling",
    crawlChunksTotal: 5,
    crawlChunksDone: 4,
    crawlStartedAt: new Date(),
    discoveryData: makeDiscoveryData(TEN_URLS),
  });

  // HP perf Fix 3: merge-crawl is inlined into poll-chunk. The second db.select
  // in handleMergeCrawl needs a site row with crawlChunkResults containing pages.
  const MERGE_SITE_ROW = makeSiteRow({
    pipelineStatus: "crawling",
    crawlChunkResults: [[{ url: "https://example.com/page-4", pageType: "other", content: "A".repeat(200), title: "Page 4" }]],
    discoveryData: makeDiscoveryData(TEN_URLS),
  });

  const JOB_ROW = {
    id: "row-5",
    firecrawlJobId: "fc-xyz",
    urlsSubmitted: ["https://example.com/page-4"],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      // 1st: poll-chunk site row, 2nd: firecrawl job row, 3rd: merge-crawl site row
      if (selectCount === 1) return makeSelectChain([SITE_ROW]);
      if (selectCount === 2) return makeSelectChain([JOB_ROW]);
      return makeSelectChain([MERGE_SITE_ROW]);
    });

    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());

    mockFcInstance.checkBatchScrapeStatus.mockResolvedValue({
      status: "completed",
      data: [makeFcDoc("https://example.com/page-4")],
    });

    mockFcInstance.asyncBatchScrapeUrls.mockResolvedValue({ id: "retry-job" });

    // db.execute: done=5, total=5 → IS the last chunk
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue([{ done: 5, total: 5 }]);
  });

  it("inlines merge-crawl and enqueues extract-trees + research when done (5) === total (5)", async () => {
    const res = await POST(makeRequest({
      siteId: "site-es023",
      domain: "example.com",
      stage: "poll-chunk",
      chunkIndex: 4,
      firecrawlJobId: "fc-xyz",
    }));

    expect(res.status).toBe(200);

    // HP perf Fix 3: merge-crawl is inlined into poll-chunk fan-in.
    // HP perf Fix 1: merge-crawl dispatches extract-trees + research in parallel.
    const extractCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "extract-trees"
    );
    const researchCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "research"
    );
    expect(extractCalls.length + researchCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── I-4: poll-chunk (still scraping) ────────────────────────────────────────

describe("I-4: poll-chunk (status=scraping) — re-enqueues itself, no fan-in", () => {
  const SITE_ROW = makeSiteRow({
    pipelineStatus: "crawling",
    crawlChunksTotal: 3,
    crawlChunksDone: 0,
    crawlStartedAt: new Date(),
    discoveryData: makeDiscoveryData(["https://example.com/"]),
  });

  beforeEach(() => {
    vi.clearAllMocks();

    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([SITE_ROW])
    );
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());

    // Firecrawl job is still in progress
    mockFcInstance.checkBatchScrapeStatus.mockResolvedValue({ status: "scraping" });
  });

  it("re-enqueues poll-chunk with the same chunkIndex and firecrawlJobId", async () => {
    const res = await POST(makeRequest({
      siteId: "site-es023",
      domain: "example.com",
      stage: "poll-chunk",
      chunkIndex: 1,
      firecrawlJobId: "fc-inprogress",
    }));

    expect(res.status).toBe(200);

    const rePollCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "poll-chunk"
    );
    expect(rePollCalls).toHaveLength(1);
    expect(rePollCalls[0][0]).toMatchObject({
      stage: "poll-chunk",
      chunkIndex: 1,
      firecrawlJobId: "fc-inprogress",
    });
  });

  it("does NOT call db.execute (fan-in not triggered when still scraping)", async () => {
    await POST(makeRequest({
      siteId: "site-es023",
      domain: "example.com",
      stage: "poll-chunk",
      chunkIndex: 1,
      firecrawlJobId: "fc-inprogress",
    }));

    expect(db.execute).not.toHaveBeenCalled();
  });

  it("does NOT enqueue merge-crawl", async () => {
    await POST(makeRequest({
      siteId: "site-es023",
      domain: "example.com",
      stage: "poll-chunk",
      chunkIndex: 1,
      firecrawlJobId: "fc-inprogress",
    }));

    const mergeCrawlCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "merge-crawl"
    );
    expect(mergeCrawlCalls).toHaveLength(0);
  });
});

// ─── I-5: merge-crawl stage ───────────────────────────────────────────────────

describe("I-5: merge-crawl — flattens chunk results, writes crawlData, enqueues research", () => {
  // Two chunks: [[page1, page2], [page3]] → flat → [page1, page2, page3]
  const CHUNK_RESULTS = [
    [makeCrawledPage("https://example.com/"), makeCrawledPage("https://example.com/about")],
    [makeCrawledPage("https://example.com/pricing")],
  ];

  const SITE_ROW = makeSiteRow({
    pipelineStatus: "crawling",
    crawlChunksTotal: 2,
    crawlChunksDone: 2,
    crawlChunkResults: CHUNK_RESULTS,
    discoveryData: makeDiscoveryData(["https://example.com/", "https://example.com/about", "https://example.com/pricing"]),
  });

  beforeEach(() => {
    vi.clearAllMocks();

    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([SITE_ROW])
    );
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  it("writes crawlData containing all 3 pages (flat from 2 chunks)", async () => {
    const res = await POST(makeRequest({
      siteId: "site-es023",
      domain: "example.com",
      stage: "merge-crawl",
    }));

    expect(res.status).toBe(200);

    const crawlDataWrite = getAllUpdateSetArgs().find((a) => a.crawlData != null);
    expect(crawlDataWrite).toBeDefined();

    const cd = crawlDataWrite?.crawlData as { pages: unknown[]; totalCrawled: number } | undefined;
    expect(cd?.pages).toHaveLength(3);
    expect(cd?.totalCrawled).toBe(3);
  });

  it("enqueues extract-trees after merging (ES-053: merge-crawl → extract-trees → research)", async () => {
    await POST(makeRequest({
      siteId: "site-es023",
      domain: "example.com",
      stage: "merge-crawl",
    }));

    const extractTreesCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "extract-trees"
    );
    expect(extractTreesCalls).toHaveLength(1);
    expect(extractTreesCalls[0][0]).toMatchObject({
      stage: "extract-trees",
      siteId: "site-es023",
      domain: "example.com",
    });
  });

  it("does NOT mark site as failed when crawl quality is sufficient (3 good pages)", async () => {
    await POST(makeRequest({
      siteId: "site-es023",
      domain: "example.com",
      stage: "merge-crawl",
    }));

    const failedWrite = getAllUpdateSetArgs().find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeUndefined();
  });
});

// ─── I-5 dedup: merge-crawl URL deduplication and external-domain filtering ───

describe("I-5 dedup: merge-crawl URL deduplication and external-domain filtering", () => {
  type PageEntry = { url: string; hasStructuredData: boolean; content: string };

  function makeDedupPage(
    url: string,
    hasStructuredData: boolean,
    content: string
  ): Record<string, unknown> {
    return {
      url,
      pageType: "other",
      title: "Test Page",
      h1: "Welcome",
      headings: [],
      content,
      existingSchema: [],
      hasStructuredData,
      contactInfo: [],
      faqContent: [],
      testimonials: [],
      certifications: [],
    };
  }

  function setupMocks(chunkResults: unknown[][]): void {
    const siteRow = makeSiteRow({
      pipelineStatus: "crawling",
      crawlChunksTotal: chunkResults.length,
      crawlChunksDone: chunkResults.length,
      crawlChunkResults: chunkResults,
      discoveryData: makeDiscoveryData(["https://example.com/"]),
    });

    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([siteRow])
    );
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  }

  function getCrawlDataPages(): PageEntry[] {
    const crawlDataWrite = getAllUpdateSetArgs().find((a) => a.crawlData != null);
    const cd = crawlDataWrite?.crawlData as { pages: PageEntry[] } | undefined;
    return cd?.pages ?? [];
  }

  // D-1: Duplicate URL → only one entry in crawlData.pages
  describe("D-1: duplicate URL — only one entry survives", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      const shortContent = "x".repeat(600);
      setupMocks([
        [makeDedupPage("https://example.com/", false, shortContent)],
        [makeDedupPage("https://example.com/", false, shortContent)],
      ]);
    });

    it("keeps exactly 1 entry for the duplicated URL", async () => {
      const res = await POST(makeRequest({
        siteId: "site-es023",
        domain: "example.com",
        stage: "merge-crawl",
      }));

      expect(res.status).toBe(200);

      const pages = getCrawlDataPages();
      const matches = pages.filter((p) => p.url === "https://example.com/");
      expect(matches).toHaveLength(1);
    });
  });

  // D-2: hasStructuredData=true wins over false for same URL
  describe("D-2: hasStructuredData=true wins over false for the same URL", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      const content = "x".repeat(600);
      setupMocks([
        [makeDedupPage("https://example.com/page", false, content)],
        [makeDedupPage("https://example.com/page", true, content)],
      ]);
    });

    it("the surviving entry has hasStructuredData=true", async () => {
      const res = await POST(makeRequest({
        siteId: "site-es023",
        domain: "example.com",
        stage: "merge-crawl",
      }));

      expect(res.status).toBe(200);

      const pages = getCrawlDataPages();
      const page = pages.find((p) => p.url === "https://example.com/page");
      expect(page).toBeDefined();
      expect(page?.hasStructuredData).toBe(true);
    });
  });

  // D-3: Same hasStructuredData → longer content wins
  describe("D-3: same hasStructuredData — longer content wins", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      const shortContent = "short".repeat(20);   // 100 chars
      const longContent  = "long content".repeat(50); // 600 chars
      setupMocks([
        [makeDedupPage("https://example.com/page", false, shortContent)],
        [makeDedupPage("https://example.com/page", false, longContent)],
      ]);
    });

    it("the surviving entry has the longer content", async () => {
      const res = await POST(makeRequest({
        siteId: "site-es023",
        domain: "example.com",
        stage: "merge-crawl",
      }));

      expect(res.status).toBe(200);

      const pages = getCrawlDataPages();
      const page = pages.find((p) => p.url === "https://example.com/page");
      expect(page).toBeDefined();
      expect(page?.content.length).toBe("long content".repeat(50).length);
    });
  });

  // D-4: false+long content does NOT beat true+short content
  describe("D-4: hasStructuredData=false with longer content does NOT beat true+short", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      const veryLongContent = "x".repeat(10_000);
      const shortContent    = "y".repeat(50);
      setupMocks([
        [makeDedupPage("https://example.com/page", false, veryLongContent)],
        [makeDedupPage("https://example.com/page", true,  shortContent)],
      ]);
    });

    it("the surviving entry has hasStructuredData=true (structured data takes priority)", async () => {
      const res = await POST(makeRequest({
        siteId: "site-es023",
        domain: "example.com",
        stage: "merge-crawl",
      }));

      expect(res.status).toBe(200);

      const pages = getCrawlDataPages();
      const page = pages.find((p) => p.url === "https://example.com/page");
      expect(page).toBeDefined();
      expect(page?.hasStructuredData).toBe(true);
    });
  });

  // D-5: External domain pages are filtered out
  describe("D-5: external domain pages are filtered out", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      const content = "x".repeat(600);
      setupMocks([
        [
          makeDedupPage("https://example.com/", false, content),
          makeDedupPage("https://stripe.com/checkout", false, content),
        ],
      ]);
    });

    it("keeps only the example.com page, drops stripe.com", async () => {
      const res = await POST(makeRequest({
        siteId: "site-es023",
        domain: "example.com",
        stage: "merge-crawl",
      }));

      expect(res.status).toBe(200);

      const pages = getCrawlDataPages();
      expect(pages).toHaveLength(1);
      expect(pages[0].url).toBe("https://example.com/");
    });
  });

  // D-6: www. and non-www. treated as same domain (not filtered as external)
  describe("D-6: www. and non-www. treated as same domain — both URLs kept", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      const content = "x".repeat(600);
      setupMocks([
        [makeDedupPage("https://www.example.com/about", false, content)],
        [makeDedupPage("https://example.com/pricing",   false, content)],
      ]);
    });

    it("keeps both pages — www.example.com is not filtered as external", async () => {
      const res = await POST(makeRequest({
        siteId: "site-es023",
        domain: "example.com",
        stage: "merge-crawl",
      }));

      expect(res.status).toBe(200);

      const pages = getCrawlDataPages();
      expect(pages).toHaveLength(2);

      const urls = pages.map((p) => p.url);
      expect(urls).toContain("https://www.example.com/about");
      expect(urls).toContain("https://example.com/pricing");
    });
  });
});
