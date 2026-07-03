/**
 * Unit tests for lib/pipeline/runner.ts (ES-023)
 *
 * startCrawl()        — enqueues "discover" via QStash; on error marks site failed
 * startBulkCrawl()    — builds synthetic discoveryData, enqueues "crawl-fanout"
 * completePipeline()  — deprecated no-op stub, always returns "not-ready"
 *
 * All external dependencies are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks — hoisted before all imports ──────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    update: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn(),
}));

vi.mock("@/lib/services/geo-crawler", () => ({
  classifyPageType: vi.fn().mockReturnValue("other"),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { startCrawl, startBulkCrawl, completePipeline } from "@/lib/pipeline/runner";
import { db } from "@/lib/db";
import { enqueueStage } from "@/lib/qstash";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SITE_ID = "site-test-123";
const DOMAIN = "example.com";

function makeUpdateChain(onSet?: (data: Record<string, unknown>) => void) {
  const chain = {
    set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
      onSet?.(data);
      return chain;
    }),
    where: vi.fn().mockResolvedValue([]),
  };
  return chain;
}

// ─── startCrawl() ─────────────────────────────────────────────────────────────

describe("startCrawl()", () => {
  let capturedSets: Record<string, unknown>[];

  beforeEach(() => {
    vi.clearAllMocks();
    capturedSets = [];
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeUpdateChain((d) => capturedSets.push(d))
    );
    vi.mocked(enqueueStage).mockResolvedValue(undefined);
  });

  it("enqueues the 'discover' stage with correct siteId, domain, and default maxPages", async () => {
    await startCrawl(SITE_ID, DOMAIN);

    expect(enqueueStage).toHaveBeenCalledOnce();
    expect(enqueueStage).toHaveBeenCalledWith({
      siteId: SITE_ID,
      domain: DOMAIN,
      stage: "discover",
      maxPages: 100,
    });
  });

  it("passes a custom maxPages to enqueueStage when provided", async () => {
    await startCrawl(SITE_ID, DOMAIN, 20);

    expect(enqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ maxPages: 20 })
    );
  });

  it("does not touch the DB on success", async () => {
    await startCrawl(SITE_ID, DOMAIN);

    expect(db.update).not.toHaveBeenCalled();
  });

  it("sets pipelineStatus='failed' with the error message and rethrows when enqueueStage throws", async () => {
    vi.mocked(enqueueStage).mockRejectedValue(new Error("QStash unavailable"));

    await expect(startCrawl(SITE_ID, DOMAIN)).rejects.toThrow("QStash unavailable");

    const failUpdate = capturedSets.find((s) => s.pipelineStatus === "failed");
    expect(failUpdate).toBeDefined();
    expect(String(failUpdate!.pipelineError)).toContain("QStash unavailable");
  });
});

// ─── startBulkCrawl() ─────────────────────────────────────────────────────────

describe("startBulkCrawl()", () => {
  let capturedSets: Record<string, unknown>[];

  const BULK_URLS = [
    "https://example.com/p1",
    "https://example.com/p2",
    "https://example.com/p3",
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    capturedSets = [];
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeUpdateChain((d) => capturedSets.push(d))
    );
    vi.mocked(enqueueStage).mockResolvedValue(undefined);
  });

  it("writes synthetic discoveryData and sets pipelineStatus='crawling' before enqueuing", async () => {
    await startBulkCrawl(SITE_ID, DOMAIN, BULK_URLS);

    const crawlingUpdate = capturedSets.find((s) => s.pipelineStatus === "crawling");
    expect(crawlingUpdate).toBeDefined();
    expect(crawlingUpdate!.discoveryData).toBeDefined();
    const dd = crawlingUpdate!.discoveryData as { urls: string[]; totalPages: number };
    expect(dd.urls).toEqual(BULK_URLS);
    expect(dd.totalPages).toBe(BULK_URLS.length);
  });

  it("enqueues 'crawl-fanout' (not 'discover') for bulk audits", async () => {
    await startBulkCrawl(SITE_ID, DOMAIN, BULK_URLS);

    expect(enqueueStage).toHaveBeenCalledOnce();
    expect(enqueueStage).toHaveBeenCalledWith({ siteId: SITE_ID, domain: DOMAIN, stage: "crawl-fanout" });
  });

  it("sets pipelineStatus='failed' with the error message and rethrows when enqueueStage throws", async () => {
    vi.mocked(enqueueStage).mockRejectedValue(new Error("QStash down"));

    await expect(startBulkCrawl(SITE_ID, DOMAIN, BULK_URLS)).rejects.toThrow("QStash down");

    const failUpdate = capturedSets.find((s) => s.pipelineStatus === "failed");
    expect(failUpdate).toBeDefined();
    expect(String(failUpdate!.pipelineError)).toContain("QStash down");
  });
});

// ─── completePipeline() ───────────────────────────────────────────────────────

describe("completePipeline()", () => {
  it("is a deprecated no-op stub that always returns 'not-ready'", async () => {
    const result = await completePipeline(SITE_ID, DOMAIN);
    expect(result).toBe("not-ready");
  });
});
