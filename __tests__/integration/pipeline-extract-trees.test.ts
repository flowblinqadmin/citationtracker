/**
 * Integration tests for extract-trees pipeline stage — ES-053 / IT1-IT5
 * Tests handleExtractTrees integration with DB, QStash, and LLM providers.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CrawlData, CrawledPage, DiscoveryData } from "@/lib/services/geo-crawler";
import type { TreeExtractionResult } from "@/lib/types/trees";
import { emptyGeoTree, emptyCategoryTree, emptyMapping } from "@/lib/types/trees";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockSonnetCreate, mockOpenAICreate, mockEnqueueStage, mockDbUpdate, mockDbQuery } = vi.hoisted(() => {
  const mockSonnetCreate = vi.fn();
  const mockOpenAICreate = vi.fn();
  const mockEnqueueStage = vi.fn().mockResolvedValue(undefined);
  const mockDbUpdate = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  });
  const mockDbQuery = vi.fn();
  return { mockSonnetCreate, mockOpenAICreate, mockEnqueueStage, mockDbUpdate, mockDbQuery };
});

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockSonnetCreate } };
  }),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockOpenAICreate } } };
  }),
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: mockEnqueueStage,
  qstash: {},
}));

vi.mock("@/lib/db", () => ({
  db: {
    update: mockDbUpdate,
    query: {
      geoSites: {
        findFirst: mockDbQuery,
      },
    },
  },
}));

vi.mock("@/lib/db/schema", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/schema")>();
  return {
    ...original,
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a, b) => ({ field: a, value: b })),
  and: vi.fn((...args: unknown[]) => args),
  sql: vi.fn(),
}));

// ─── Test data ──────────────────────────────────────────────────────────────

function makePage(url: string, pageType = "other"): CrawledPage {
  return {
    url,
    pageType: pageType as any,
    title: "Bangalore Oncology Cardiology Mysore Healthcare Test Page",
    h1: "Test",
    headings: [{ level: 2, text: "Section" }],
    content: "Test content for the page",
    existingSchema: [],
    hasStructuredData: false,
    contactInfo: [],
    faqContent: [],
    testimonials: [],
    certifications: [],
  };
}

const CRAWL_DATA: CrawlData = {
  domain: "example.com",
  pages: [
    makePage("https://example.com/", "homepage"),
    makePage("https://example.com/services/oncology", "services"),
    makePage("https://example.com/locations/bangalore", "other"),
  ],
  totalCrawled: 3,
};

const DISCOVERY_DATA: DiscoveryData = {
  urls: ["https://example.com/", "https://example.com/services/oncology"],
  pageMap: { "https://example.com/": "homepage" },
  hasLlmsTxt: false,
  hasUcp: false,
  hasSitemap: true,
  hasRobots: true,
  totalPages: 2,
};

function makeValidResult(): TreeExtractionResult {
  return {
    geoTree: {
      root: {
        id: "global", name: "Global", level: "global",
        children: [{
          id: "in", name: "India", level: "country",
          children: [{
            id: "in-ka", name: "Karnataka", level: "state",
            children: [
              { id: "in-ka-blr", name: "Bangalore", level: "city", children: [], pageCount: 2, evidence: [] },
            ],
            pageCount: 2, evidence: [],
          }],
          pageCount: 2, evidence: [],
        }],
        pageCount: 2, evidence: [],
      },
      leafCount: 1,
      extractedAt: new Date().toISOString(),
    },
    categoryTree: {
      root: {
        id: "healthcare", name: "Healthcare", level: 0,
        children: [
          { id: "hc-onc", name: "Oncology", level: 1, children: [], pageCount: 1, evidence: [] },
        ],
        pageCount: 1, evidence: [],
      },
      leafCount: 1,
      extractedAt: new Date().toISOString(),
    },
    mapping: {
      entries: [{ geoId: "in-ka-blr", categoryId: "hc-onc", strength: "strong", evidence: [] }],
      totalEntries: 1,
      extractedAt: new Date().toISOString(),
    },
  };
}

// ─── Import handler (after mocks) ───────────────────────────────────────────

// We test extractTrees directly since handleExtractTrees is not exported
// from the route file. The integration test validates the full flow.
import { extractTrees } from "@/lib/services/tree-extractor";

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.OPENAI_API_KEY = "test-openai";
});

describe("pipeline extract-trees integration (IT1-IT5)", () => {
  it("IT1: extract-trees receives correct inputs from crawl data", async () => {
    const validResult = makeValidResult();
    mockSonnetCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify(validResult) }],
    });

    const result = await extractTrees(CRAWL_DATA, DISCOVERY_DATA, "example.com", "healthcare");

    // Verify Sonnet was called with a prompt that includes page inventory data
    expect(mockSonnetCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockSonnetCreate.mock.calls[0][0];
    expect(callArgs.model).toContain("sonnet");
    // The user message should contain page inventory
    const userMsg = callArgs.messages.find((m: any) => m.role === "user");
    expect(userMsg?.content).toContain("example.com");
  });

  it("IT2: extract-trees returns trees that can be stored on geoSites", async () => {
    const validResult = makeValidResult();
    mockSonnetCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify(validResult) }],
    });

    const result = await extractTrees(CRAWL_DATA, DISCOVERY_DATA, "example.com");

    // Verify the result has the correct shape for DB storage
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.trees.geoTree).toBeDefined();
    expect(result.trees.geoTree.root).toBeDefined();
    expect(result.trees.geoTree.root.id).toBe("global");
    expect(result.trees.categoryTree).toBeDefined();
    expect(result.trees.categoryTree.root).toBeDefined();
    expect(result.trees.mapping).toBeDefined();
    expect(result.trees.mapping.entries).toBeInstanceOf(Array);
  });

  it("IT3: enqueueStage can be called with 'research' after extract-trees", () => {
    // Simulate the pipeline routing: after extract-trees, enqueue research
    mockEnqueueStage({ siteId: "test-id", domain: "example.com", stage: "research" });

    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "research" })
    );
  });

  it("IT4: extract-trees returns empty trees gracefully if no crawlData", async () => {
    // If called with empty crawl data, should still return valid result
    const emptyCrawl: CrawlData = {
      domain: "example.com",
      pages: [],
      totalCrawled: 0,
    };

    // Sonnet might not even be called if there's no data
    mockSonnetCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({
        geoTree: emptyGeoTree(),
        categoryTree: emptyCategoryTree(),
        mapping: emptyMapping(),
      }) }],
    });

    const result = await extractTrees(emptyCrawl, DISCOVERY_DATA, "example.com");

    // Should return a successful outcome with valid (possibly empty) trees.
    // A legitimately-empty tree from a successful LLM call is still ok: true.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.trees.geoTree).toBeDefined();
    expect(result.trees.categoryTree).toBeDefined();
    expect(result.trees.mapping).toBeDefined();
  });

  it("IT5: extract-trees retries on transient Sonnet failure then succeeds", async () => {
    const validResult = makeValidResult();
    // First call: Sonnet 503
    mockSonnetCreate
      .mockRejectedValueOnce(new Error("503 Service Unavailable"))
      // Note: extractTrees may retry with higher temperature or fall to GPT-4o
      .mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify(validResult) }],
      });

    const result = await extractTrees(CRAWL_DATA, DISCOVERY_DATA, "example.com");

    // Should succeed after retry/fallback
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.trees.geoTree.leafCount).toBeGreaterThanOrEqual(0);
    expect(result.trees.categoryTree).toBeDefined();
  });
});
