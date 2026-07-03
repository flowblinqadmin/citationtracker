/**
 * Unit tests for ES-023 runner.ts — dynamic maxPages + startBulkCrawl (ES-005 Task 2 & 4)
 *
 * After ES-023, startCrawl() and startBulkCrawl() delegate to QStash via enqueueStage().
 * The legacy completePipeline() is a no-op stub — its bulk-branch logic (credit
 * reconciliation, per-page analysis) now lives in handleAssemble() in stage/route.ts,
 * tested by crawl-fanout-flow.test.ts and the assemble integration tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

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
  classifyPageType: vi.fn().mockImplementation((url: string) => {
    if (url.includes("/about")) return "about";
    if (url.includes("/blog")) return "blog";
    return "homepage";
  }),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { startCrawl, startBulkCrawl, completePipeline } from "@/lib/pipeline/runner";
import { db } from "@/lib/db";
import { enqueueStage } from "@/lib/qstash";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SITE_ID = "bulk-site-abc";
const DOMAIN = "acme.io";

const BULK_URLS = [
  "https://acme.io/",
  "https://acme.io/about",
  "https://acme.io/blog",
];

function makeUpdateChain(onSet?: (d: Record<string, unknown>) => void) {
  const chain = {
    set: vi.fn().mockImplementation((d: Record<string, unknown>) => {
      onSet?.(d);
      return chain;
    }),
    where: vi.fn().mockResolvedValue([]),
  };
  return chain;
}

// ─── startCrawl() — dynamic maxPages propagation (Task 2) ────────────────────

describe("startCrawl() — maxPages forwarded to enqueueStage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(enqueueStage).mockResolvedValue(undefined);
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => makeUpdateChain());
  });

  it("passes maxPages=37 to enqueueStage when called with non-default maxPages", async () => {
    await startCrawl(SITE_ID, DOMAIN, 37);
    expect(enqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "discover", maxPages: 37 })
    );
  });

  it("defaults to maxPages=100 when not supplied", async () => {
    await startCrawl(SITE_ID, DOMAIN);
    expect(enqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "discover", maxPages: 100 })
    );
  });

  it("passes maxPages=20 (FREE_MAX_PAGES) to enqueueStage for free-tier callers", async () => {
    await startCrawl(SITE_ID, DOMAIN, 20);
    expect(enqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "discover", maxPages: 20 })
    );
  });
});

// ─── startBulkCrawl() (Task 4) ────────────────────────────────────────────────

describe("startBulkCrawl()", () => {
  let capturedSets: Record<string, unknown>[];

  beforeEach(() => {
    vi.clearAllMocks();
    capturedSets = [];
    vi.mocked(enqueueStage).mockResolvedValue(undefined);
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeUpdateChain((d) => capturedSets.push(d))
    );
  });

  it("does NOT enqueue 'discover' — bulk path skips discovery", async () => {
    await startBulkCrawl(SITE_ID, DOMAIN, BULK_URLS);
    const discoverCalls = vi.mocked(enqueueStage).mock.calls.filter(
      ([p]) => p.stage === "discover"
    );
    expect(discoverCalls).toHaveLength(0);
  });

  it("enqueues 'crawl-fanout' with the correct siteId and domain", async () => {
    await startBulkCrawl(SITE_ID, DOMAIN, BULK_URLS);
    expect(enqueueStage).toHaveBeenCalledWith({
      siteId: SITE_ID,
      domain: DOMAIN,
      stage: "crawl-fanout",
    });
  });

  it("writes synthetic discoveryData containing all bulk URLs with pipelineStatus='crawling'", async () => {
    await startBulkCrawl(SITE_ID, DOMAIN, BULK_URLS);

    const crawlingWrite = capturedSets.find(
      (s) => s.pipelineStatus === "crawling" && s.discoveryData != null
    );
    expect(crawlingWrite).toBeDefined();

    const dd = crawlingWrite!.discoveryData as { urls: string[]; totalPages: number; hasLlmsTxt: boolean };
    expect(dd.totalPages).toBe(BULK_URLS.length);
    expect(dd.urls).toEqual(BULK_URLS);
    expect(dd.hasLlmsTxt).toBe(false);
  });

  it("sets pipelineStatus='failed' and rethrows when enqueueStage throws", async () => {
    vi.mocked(enqueueStage).mockRejectedValue(new Error("QStash down"));

    await expect(startBulkCrawl(SITE_ID, DOMAIN, BULK_URLS)).rejects.toThrow("QStash down");

    const failSet = capturedSets.find((s) => s.pipelineStatus === "failed");
    expect(failSet).toBeDefined();
    expect(String(failSet!.pipelineError)).toContain("QStash down");
  });
});

// ─── completePipeline() ───────────────────────────────────────────────────────
// Credit reconciliation and per-page analysis moved to handleAssemble() in
// stage/route.ts. Tested by crawl-fanout-flow.test.ts.

describe("completePipeline()", () => {
  it("is a deprecated no-op stub — always returns 'not-ready'", async () => {
    expect(await completePipeline(SITE_ID, DOMAIN)).toBe("not-ready");
  });
});
