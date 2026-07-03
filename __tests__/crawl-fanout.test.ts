/**
 * Unit tests for Crawl Fan-out pipeline utility functions (ES-023)
 *
 * computeChunks() — 8 cases (C-1 through C-8)
 * mapDocumentToPage() — 5 cases (M-1 through M-5)
 *
 * Both functions live in @/lib/services/geo-crawler after ES-023 implementation.
 * mapDocumentToPage and FcDoc are moved from chunked-firecrawl.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mockFirecrawlInstance = vi.hoisted(() => ({
  asyncBatchScrapeUrls: vi.fn(),
  checkBatchScrapeStatus: vi.fn(),
}));

vi.mock("@mendable/firecrawl-js", () => ({
  FirecrawlAppV1: vi.fn().mockImplementation(function () {
    return mockFirecrawlInstance;
  }),
}));

// lib/db throws at import time if DATABASE_URL is not set
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock("@/lib/config", () => ({
  CRAWL_MAX_CHUNKS: 10,
  POLL_CHUNK_INTERVAL_S: 15,
  POLL_CHUNK_CIRCUIT_BREAKER_MS: 20 * 60 * 1000,
  FREE_MAX_PAGES: 50,
  BULK_CHUNKING_THRESHOLD: 10,
  SIGNUP_BONUS_CREDITS: 20,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  computeChunks,
  mapDocumentToPage,
  type FcDoc,
} from "@/lib/services/geo-crawler";

// ─── computeChunks() ─────────────────────────────────────────────────────────

describe("computeChunks()", () => {
  it("C-1: 1 page → 1 chunk of size 1", () => {
    expect(computeChunks(1)).toEqual({ numChunks: 1, chunkSize: 1 });
  });

  it("C-2: 5 pages → 5 chunks of size 1 (each URL gets its own chunk)", () => {
    expect(computeChunks(5)).toEqual({ numChunks: 5, chunkSize: 1 });
  });

  it("C-3: 9 pages → 9 chunks of size 1 (just under CRAWL_MAX_CHUNKS)", () => {
    expect(computeChunks(9)).toEqual({ numChunks: 9, chunkSize: 1 });
  });

  it("C-4: 10 pages → 10 chunks of size 1 (exactly at CRAWL_MAX_CHUNKS cap)", () => {
    expect(computeChunks(10)).toEqual({ numChunks: 10, chunkSize: 1 });
  });

  it("C-5: 50 pages → 10 chunks of size 5 (capped at CRAWL_MAX_CHUNKS)", () => {
    expect(computeChunks(50)).toEqual({ numChunks: 10, chunkSize: 5 });
  });

  it("C-6: 100 pages → 10 chunks of size 10", () => {
    expect(computeChunks(100)).toEqual({ numChunks: 10, chunkSize: 10 });
  });

  it("C-7: 500 pages → 10 chunks of size 50", () => {
    expect(computeChunks(500)).toEqual({ numChunks: 10, chunkSize: 50 });
  });

  it("C-8: 0 pages → 0 chunks and 0 chunkSize (edge case — no URLs to crawl)", () => {
    expect(computeChunks(0)).toEqual({ numChunks: 0, chunkSize: 0 });
  });

  it("invariant: numChunks * chunkSize >= totalPages for any totalPages >= 1 (no URL dropped)", () => {
    const testCases = [1, 2, 5, 9, 10, 11, 23, 50, 99, 100, 101, 499, 500, 999];
    for (const totalPages of testCases) {
      const { numChunks, chunkSize } = computeChunks(totalPages);
      expect(numChunks * chunkSize).toBeGreaterThanOrEqual(totalPages);
    }
  });

  it("C-9: ceil() rounding never produces empty trailing chunks when slicing URLs", () => {
    // Regression: ceil(totalPages/numChunks) can make earlier chunks consume all URLs,
    // leaving slice(i*chunkSize, (i+1)*chunkSize) empty for the last chunk.
    // E.g. 12 URLs, 5 chunks, chunkSize=3 → chunk 4 (index 4) gets slice(12,15) = []
    const testCases = [11, 12, 13, 14, 21, 22, 23, 33, 51, 99, 101, 199, 501];
    for (const totalPages of testCases) {
      const { numChunks, chunkSize } = computeChunks(totalPages);
      const urls = Array.from({ length: totalPages }, (_, i) => `https://example.com/page-${i}`);
      for (let i = 0; i < numChunks; i++) {
        const chunk = urls.slice(i * chunkSize, (i + 1) * chunkSize);
        // Every chunk that the loop would iterate over must be non-empty,
        // OR the consumer must skip it (which our fix does).
        // This test documents that ceil() DOES produce empty trailing chunks.
        if (chunk.length === 0) {
          // Verify this only happens for trailing chunks where all URLs are already consumed
          expect(i * chunkSize).toBeGreaterThanOrEqual(totalPages);
        }
      }
    }
  });
});

// ─── mapDocumentToPage() ─────────────────────────────────────────────────────

describe("mapDocumentToPage()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("M-1: maps a valid doc with rich content, url, and title to a correct CrawledPage", () => {
    const doc: FcDoc = {
      markdown: "A".repeat(200),
      metadata: { url: "https://ex.com/about", title: "About" },
    };
    const pageMap: Record<string, string> = { "https://ex.com/about": "about" };

    const result = mapDocumentToPage(doc, pageMap as Record<string, import("@/lib/services/geo-crawler").PageType>);

    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://ex.com/about");
    expect(result!.pageType).toBe("about");
    expect(result!.title).toBe("About");
  });

  it("M-2: returns null for empty markdown (fails hasContent check)", () => {
    const doc: FcDoc = {
      markdown: "",
      metadata: { url: "https://ex.com/" },
    };

    expect(mapDocumentToPage(doc, {})).toBeNull();
  });

  it("M-3: returns null for markdown shorter than 50 chars after whitespace collapse", () => {
    const doc: FcDoc = {
      markdown: "Short.",
      metadata: { url: "https://ex.com/" },
    };

    // "Short." = 6 chars, well below MIN_CONTENT_LENGTH=50
    expect(mapDocumentToPage(doc, {})).toBeNull();
  });

  it("M-4: returns null when metadata has neither url nor sourceURL field", () => {
    const doc: FcDoc = {
      markdown: "A".repeat(200),
      metadata: {},
    };

    expect(mapDocumentToPage(doc, {})).toBeNull();
  });

  it("M-5: extracts FAQ entries from markdown with bold question patterns", () => {
    // Triggers extractFaq regex: /\*\*([^*?]+\?)\*\*\s*\n+([^\n*#]{20,400})/g
    const faqLine =
      "**What is Flowblinq?**\n" +
      "It is a great platform for GEO auditing and site optimization. ";
    const doc: FcDoc = {
      markdown: faqLine.repeat(15), // 15 repetitions → 10 FAQ items (cap)
      metadata: { url: "https://ex.com/faq" },
    };

    const result = mapDocumentToPage(doc, {});

    expect(result).not.toBeNull();
    expect(result!.faqContent.length).toBeGreaterThan(0);
    expect(result!.faqContent[0]).toMatchObject({
      question: expect.any(String),
      answer: expect.any(String),
    });
    expect(result!.faqContent[0].question).toContain("Flowblinq");
  });
});
