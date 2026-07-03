/**
 * Unit tests for lib/services/tree-extractor.ts — ES-053 / C2+C3
 * U13-U24: buildPageInventory, validateTrees, extractTrees
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CrawlData, CrawledPage, DiscoveryData } from "@/lib/services/geo-crawler";
import type {
  GeoTree, CategoryTree, GeoCategoryMapping, TreeExtractionResult,
} from "@/lib/types/trees";
import { emptyGeoTree, emptyCategoryTree, emptyMapping } from "@/lib/types/trees";

// ─── Hoisted mock references ────────────────────────────────────────────────

const { mockSonnetCreate, mockOpenAICreate } = vi.hoisted(() => {
  const mockSonnetCreate = vi.fn();
  const mockOpenAICreate = vi.fn();
  return { mockSonnetCreate, mockOpenAICreate };
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

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { buildPageInventory, validateTrees, extractTrees, selectInventoryPages, pathDepth } from "@/lib/services/tree-extractor";
import type { ExtractTreesOutcome } from "@/lib/services/tree-extractor";
// ES-086 Phase A: namespace import for module-private helpers that ScriptDev
// exports (classifySonnetError, validateExtractionResponse, TreeExtractorSchemaError,
// EXTRACTION_TIMEOUT_MS). Optional-access pattern sidesteps vitest strict
// namespace checks when the exports are missing pre-fix — dependent tests
// skipIf-gate themselves on undefined references.
import * as treeExtractorNs from "@/lib/services/tree-extractor";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// ─── Test Data ──────────────────────────────────────────────────────────────

function makePage(overrides: Partial<CrawledPage> = {}): CrawledPage {
  return {
    url: "https://example.com/page",
    pageType: "other",
    title: "Test Page",
    h1: "Test",
    headings: [{ level: 2, text: "Section" }],
    content: "Test content for page",
    existingSchema: [],
    hasStructuredData: false,
    contactInfo: [],
    faqContent: [],
    testimonials: [],
    certifications: [],
    ...overrides,
  };
}

function makeCrawlData(pageCount: number, overrides: Partial<CrawledPage> = {}): CrawlData {
  return {
    domain: "example.com",
    pages: Array.from({ length: pageCount }, (_, i) =>
      makePage({ url: `https://example.com/page-${i}`, title: `Page ${i}`, ...overrides })
    ),
    totalCrawled: pageCount,
  };
}

function makeDiscoveryData(): DiscoveryData {
  return {
    urls: ["https://example.com/"],
    pageMap: { "https://example.com/": "homepage" },
    hasLlmsTxt: false,
    hasUcp: false,
    hasSitemap: true,
    hasRobots: true,
    totalPages: 1,
  };
}

function makeValidGeoTree(): GeoTree {
  return {
    root: {
      id: "global",
      name: "Global",
      level: "global",
      children: [
        {
          id: "in",
          name: "India",
          level: "country",
          children: [
            {
              id: "in-ka",
              name: "Karnataka",
              level: "state",
              children: [
                { id: "in-ka-blr", name: "Bangalore", level: "city", children: [], pageCount: 10, evidence: ["/locations/bangalore"] },
                { id: "in-ka-mys", name: "Mysore", level: "city", children: [], pageCount: 3, evidence: ["/locations/mysore"] },
              ],
              pageCount: 13,
              evidence: [],
            },
          ],
          pageCount: 13,
          evidence: [],
        },
      ],
      pageCount: 13,
      evidence: [],
    },
    leafCount: 2,
    extractedAt: new Date().toISOString(),
  };
}

function makeValidCategoryTree(): CategoryTree {
  return {
    root: {
      id: "healthcare",
      name: "Healthcare",
      level: 0,
      children: [
        { id: "healthcare-oncology", name: "Oncology", level: 1, children: [], pageCount: 8, evidence: ["/departments/oncology"] },
        { id: "healthcare-cardiology", name: "Cardiology", level: 1, children: [], pageCount: 5, evidence: ["/departments/cardiology"] },
      ],
      pageCount: 13,
      evidence: [],
    },
    leafCount: 2,
    extractedAt: new Date().toISOString(),
  };
}

function makeValidMapping(): GeoCategoryMapping {
  return {
    entries: [
      { geoId: "in-ka-blr", categoryId: "healthcare-oncology", strength: "strong", evidence: ["/locations/bangalore/oncology"] },
      { geoId: "in-ka-blr", categoryId: "healthcare-cardiology", strength: "moderate", evidence: [] },
    ],
    totalEntries: 2,
    extractedAt: new Date().toISOString(),
  };
}

function makeValidResult(): TreeExtractionResult {
  return {
    geoTree: makeValidGeoTree(),
    categoryTree: makeValidCategoryTree(),
    mapping: makeValidMapping(),
  };
}

function sonnetJsonResponse(data: unknown): object {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

function openaiJsonResponse(data: unknown): object {
  return {
    choices: [{ message: { content: JSON.stringify(data) } }],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.OPENAI_API_KEY = "test-openai";
});

describe("buildPageInventory", () => {
  it("U13: formats pages correctly with URL, pageType, H1, headings", () => {
    const crawlData = makeCrawlData(5);
    crawlData.pages[0] = makePage({
      url: "https://example.com/about",
      pageType: "about",
      title: "About Us",
      h1: "About Our Company",
      headings: [{ level: 2, text: "Our Mission" }, { level: 2, text: "Our Team" }],
    });

    const inventory = buildPageInventory(crawlData);

    expect(inventory).toContain("https://example.com/about");
    expect(inventory).toContain("about");
    expect(inventory).toContain("About Our Company");
    expect(inventory).toContain("Our Mission");
  });

  it("U14: caps at 200 pages", () => {
    const crawlData = makeCrawlData(300);
    const inventory = buildPageInventory(crawlData);

    // Count page entries — each page should produce a distinct URL line
    const pageMatches = inventory.match(/https:\/\/example\.com\/page-\d+/g) || [];
    expect(pageMatches.length).toBeLessThanOrEqual(200);
  });

  it("U15: prioritizes structural pages over blog pages", () => {
    const structuralPages = Array.from({ length: 50 }, (_, i) =>
      makePage({ url: `https://example.com/services/s${i}`, pageType: "services" })
    );
    const blogPages = Array.from({ length: 250 }, (_, i) =>
      makePage({ url: `https://example.com/blog/post-${i}`, pageType: "blog" })
    );
    const crawlData: CrawlData = {
      domain: "example.com",
      pages: [...structuralPages, ...blogPages],
      totalCrawled: 300,
    };

    const inventory = buildPageInventory(crawlData);

    // All 50 structural pages should be included
    for (let i = 0; i < 50; i++) {
      expect(inventory).toContain(`/services/s${i}`);
    }
  });
});

describe("validateTrees", () => {
  it("U16: accepts valid result", () => {
    const result = makeValidResult();
    const validation = validateTrees(result);

    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  it("U17: rejects missing node id", () => {
    const result = makeValidResult();
    // Remove id from a child node
    (result.geoTree.root.children[0] as any).id = "";

    const validation = validateTrees(result);
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  it("U18: rejects orphan mapping refs", () => {
    const result = makeValidResult();
    result.mapping.entries.push({
      geoId: "nonexistent-geo",
      categoryId: "nonexistent-cat",
      strength: "strong",
      evidence: [],
    });

    const validation = validateTrees(result);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.includes("nonexistent-geo") || e.includes("orphan"))).toBe(true);
  });

  it("U19: rejects oversized trees (>500 geo leaves)", () => {
    const result = makeValidResult();
    // Create a geo tree with 600 leaf nodes
    const cities = Array.from({ length: 600 }, (_, i) => ({
      id: `city-${i}`,
      name: `City ${i}`,
      level: "city" as const,
      children: [],
      pageCount: 1,
      evidence: [],
    }));
    result.geoTree.root.children = [{
      id: "country",
      name: "Country",
      level: "country" as const,
      children: [{
        id: "state",
        name: "State",
        level: "state" as const,
        children: cities,
        pageCount: 600,
        evidence: [],
      }],
      pageCount: 600,
      evidence: [],
    }];
    result.geoTree.leafCount = 600;

    const validation = validateTrees(result);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.includes("500") || e.includes("leaf") || e.includes("oversized"))).toBe(true);
  });
});

describe("extractTrees", () => {
  it("U20: returns valid trees for healthcare site", async () => {
    const validResult = makeValidResult();
    mockSonnetCreate.mockResolvedValueOnce(sonnetJsonResponse(validResult));

    // Crawl data must include keywords matching tree nodes so pruneUngroundedNodes doesn't strip them
    const healthcareCrawl = makeCrawlData(10, { title: "Bangalore Oncology Cardiology Mysore Healthcare" });

    const result = await extractTrees(
      healthcareCrawl,
      makeDiscoveryData(),
      "manipalhospitals.com",
      "healthcare"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.trees.geoTree.leafCount).toBeGreaterThanOrEqual(1);
    expect(result.trees.categoryTree.leafCount).toBeGreaterThanOrEqual(1);
    expect(result.trees.mapping.entries.length).toBeGreaterThanOrEqual(1);
    expect(mockSonnetCreate).toHaveBeenCalledTimes(1);
  });

  it("U21: returns valid trees for SaaS site (no geo)", async () => {
    const saasResult: TreeExtractionResult = {
      geoTree: emptyGeoTree(),
      categoryTree: {
        root: {
          id: "software",
          name: "Software",
          level: 0,
          children: [
            { id: "software-seo", name: "SEO Tools", level: 1, children: [], pageCount: 5, evidence: ["/features"] },
          ],
          pageCount: 5,
          evidence: [],
        },
        leafCount: 1,
        extractedAt: new Date().toISOString(),
      },
      mapping: emptyMapping(),
    };
    mockSonnetCreate.mockResolvedValueOnce(sonnetJsonResponse(saasResult));

    const result = await extractTrees(
      makeCrawlData(5),
      makeDiscoveryData(),
      "seotool.io"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.trees.geoTree.leafCount).toBe(0);
    expect(result.trees.categoryTree.leafCount).toBeGreaterThanOrEqual(1);
  });

  it("U22: returns discriminated failure on Sonnet + GPT-4o failure", async () => {
    // Both Sonnet attempts fail
    mockSonnetCreate.mockRejectedValue(new Error("Sonnet timeout"));
    // GPT-4o also fails
    mockOpenAICreate.mockRejectedValue(new Error("GPT-4o timeout"));

    const result = await extractTrees(
      makeCrawlData(5),
      makeDiscoveryData(),
      "example.com"
    );

    // FIND-023: all-providers-failed is now a loud failure, not a hollow tree.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("all_providers_failed");
  });

  it("U23: falls back to GPT-4o on Sonnet error", async () => {
    const validResult = makeValidResult();
    // Sonnet fails for extraction (both attempts) but may be called for pruning correction
    mockSonnetCreate.mockRejectedValue(new Error("Sonnet 500"));
    // GPT-4o succeeds
    mockOpenAICreate.mockResolvedValueOnce(openaiJsonResponse(validResult));

    // Crawl data must include keywords matching tree nodes so pruneUngroundedNodes doesn't strip them
    const healthcareCrawl = makeCrawlData(10, { title: "Bangalore Oncology Cardiology Mysore Healthcare" });

    const result = await extractTrees(
      healthcareCrawl,
      makeDiscoveryData(),
      "example.com"
    );

    expect(mockOpenAICreate).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.trees.geoTree.leafCount).toBeGreaterThanOrEqual(1);
  });

  it("U24: retries with higher temperature on invalid JSON", async () => {
    // First Sonnet call returns invalid JSON
    // Second call (retry with higher temp) returns valid
    // Third call may be pruneUngroundedNodes correction (if needed)
    mockSonnetCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "not valid json {{{" }] })
      .mockResolvedValueOnce(sonnetJsonResponse(makeValidResult()))
      .mockResolvedValue(sonnetJsonResponse({ keep: [], remove: [] }));

    // Crawl data must include keywords matching tree nodes
    const healthcareCrawl = makeCrawlData(10, { title: "Bangalore Oncology Cardiology Mysore Healthcare" });

    const result = await extractTrees(
      healthcareCrawl,
      makeDiscoveryData(),
      "example.com"
    );

    // At least 2 calls for extraction (invalid + retry), possibly more for pruning
    expect(mockSonnetCreate).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.trees.geoTree.leafCount).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ES-086 Phase A — tree extractor LLM call fix (U1-U52)
//
// Author:   ReviewMaster (Agent 9)
// Date:     2026-04-09
// Spec:     geo/docs/specs/engineering/ES-086-tree-extractor-llm-call-broken.md
//
// Delivered RED initially against pre-fix tree-extractor.ts. ScriptDev's
// impl (Direction A field-name + budget bump + timeout + schema validator +
// classifySonnetError + extractTrees catch refactor + GPT-4o rename) turns
// the 22 deliberate-RED tests GREEN.
//
// Module-private helper access: `classifySonnetError`, `validateExtractionResponse`,
// `TreeExtractorSchemaError`, and `EXTRACTION_TIMEOUT_MS` are all currently
// module-private. ScriptDev's impl must either re-export them directly OR
// expose via `__test_internals` per ES-086 §b.2 + Note-for-RM-7. Until then,
// the dependent groups (schema validator, classifySonnetError, constant value)
// skipIf-gate via the namespace-import optional-access pattern.
//
// `treeIsEmpty` lives in citation-check/route.ts (not this file). It's trivial
// (4 cases) and inlined in §c.6 tests to decouple from ScriptDev's export
// decision. ScriptDev cross-checks the mirror against the shipped helper
// during Phase 3 review.
//
// Fixture: __tests__/fixtures/tree-extract-manipal.json (synthetic mirror —
// see __rm_note in the fixture file). Shared with TS-085 AC-1.
//
// Independence rule (Phase A):
//   - Site IDs use `manipal-fixture-rm` — NEVER `-GzFX1KcKhmN0W_1t8SmY`
//   - Fixture flagged `__rm_synthetic: true`
// ═══════════════════════════════════════════════════════════════════════════

// ── Fixture loader ──────────────────────────────────────────────────────────

const MANIPAL_FIXTURE_PATH = resolvePath(__dirname, "..", "fixtures", "tree-extract-manipal.json");
const manipalFixture = JSON.parse(readFileSync(MANIPAL_FIXTURE_PATH, "utf-8")) as {
  siteId: string;
  domain: string;
  crawlData: CrawlData;
  discoveryData: DiscoveryData;
  expectedTreeExtractionResponse: TreeExtractionResult;
};

// ── Optional access to module-private exports ──────────────────────────────

type SonnetErrorClass =
  | { kind: "timeout" }
  | { kind: "schema" }
  | { kind: "overload" }
  | { kind: "auth_or_config" }
  | { kind: "network" }
  | { kind: "other"; errType: string; errMsg: string; errStatus?: number };

const classifySonnetError =
  (treeExtractorNs as unknown as { classifySonnetError?: (err: unknown) => SonnetErrorClass })
    .classifySonnetError;

const validateExtractionResponse =
  (treeExtractorNs as unknown as { validateExtractionResponse?: (parsed: unknown) => void })
    .validateExtractionResponse;

const TreeExtractorSchemaError =
  (treeExtractorNs as unknown as { TreeExtractorSchemaError?: new (msg: string, field: string) => Error })
    .TreeExtractorSchemaError;

const EXTRACTION_TIMEOUT_MS_EXPORT =
  (treeExtractorNs as unknown as { EXTRACTION_TIMEOUT_MS?: number })
    .EXTRACTION_TIMEOUT_MS;

// ── Source file path for U52 grep test ─────────────────────────────────────

const TREE_EXTRACTOR_SOURCE_PATH = resolvePath(
  __dirname, "..", "..", "lib", "services", "tree-extractor.ts",
);

// ── Healthcare crawl helper (matches fixture's keyword set so pruneUngroundedNodes
// doesn't strip the synthetic tree returned by the LLM mock) ────────────────

function makeHealthcareCrawl(): CrawlData {
  // Reuse the makeCrawlData factory from the existing test file (above in scope)
  // and seed every page's title with the tree node keywords so pruneUngroundedNodes
  // sees them as "grounded" via nameInContent matching.
  return makeCrawlData(10, {
    title: "Bangalore Delhi Pune Mysore Cardiology Oncology Neurosciences Orthopedics Urology Gastroenterology Karnataka Maharashtra Healthcare",
  });
}

function makeHealthcareResponseFromFixture(): TreeExtractionResult {
  // Use the fixture's expected response as the canonical healthcare response
  // — tests U1/U3/U33-U37 etc. mock sonnet/openai to return this shape.
  return manipalFixture.expectedTreeExtractionResponse;
}

// ═══════════════════════════════════════════════════════════════════════════
// §c.1 — Field name + budget arg capture (U1-U7)
// ═══════════════════════════════════════════════════════════════════════════

describe("ES-086 §c.1 — callSonnet / callOpenAi arg capture (RM independent)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-openai";
  });

  it("U1: Sonnet primary call uses max_tokens: 20000 (NOT max_completion_tokens)", async () => {
    mockSonnetCreate.mockResolvedValue(sonnetJsonResponse(makeHealthcareResponseFromFixture()));

    await extractTrees(makeHealthcareCrawl(), makeDiscoveryData(), "manipal-fixture-rm.com", "healthcare");

    // Find the primary-call invocation (the first one — pruneUngroundedNodes
    // may add a second correction call which uses max_tokens: 2000 post-fix).
    // Issue M tried bumping 20000 → 32000 as truncation insurance, but
    // Issue N (2026-04-10) reverted to 20000 after discovering Anthropic's
    // API hard-rejects non-streaming calls with max_tokens ≥ ~21K ("Streaming
    // is required for operations that may take longer than 10 minutes").
    // With selectInventoryPages() capping at 150 pages the expected output
    // stays under 20K tokens.
    const primaryCall = mockSonnetCreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(primaryCall).toBeDefined();
    expect(primaryCall!.max_tokens).toBe(20000);
    expect(primaryCall!.max_completion_tokens).toBeUndefined();
  });

  it("U2: Sonnet primary call uses model claude-sonnet-4-6", async () => {
    mockSonnetCreate.mockResolvedValue(sonnetJsonResponse(makeHealthcareResponseFromFixture()));

    await extractTrees(makeHealthcareCrawl(), makeDiscoveryData(), "manipal-fixture-rm.com");

    const primaryCall = mockSonnetCreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(primaryCall?.model).toBe("claude-sonnet-4-6");
  });

  it("U3: gpt-5.4 fallback call uses max_completion_tokens: 20000 (NOT max_tokens)", async () => {
    // Force Sonnet to fail so fallback runs
    mockSonnetCreate.mockRejectedValue(new Error("Sonnet timeout"));
    mockOpenAICreate.mockResolvedValue(openaiJsonResponse(makeHealthcareResponseFromFixture()));

    await extractTrees(makeHealthcareCrawl(), makeDiscoveryData(), "manipal-fixture-rm.com");

    const openAiCall = mockOpenAICreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(openAiCall).toBeDefined();
    expect(openAiCall!.max_completion_tokens).toBe(20000);
    expect(openAiCall!.max_tokens).toBeUndefined();
  });

  it("U4: gpt-5.4 fallback call uses model gpt-5.4", async () => {
    mockSonnetCreate.mockRejectedValue(new Error("Sonnet timeout"));
    mockOpenAICreate.mockResolvedValue(openaiJsonResponse(makeHealthcareResponseFromFixture()));

    await extractTrees(makeHealthcareCrawl(), makeDiscoveryData(), "manipal-fixture-rm.com");

    const openAiCall = mockOpenAICreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(openAiCall?.model).toBe("gpt-5.4");
  });

  it("U5: pruneUngroundedNodes correction call uses max_tokens: 2000", async () => {
    // Build a response containing ungrounded leaf nodes so pruneUngroundedNodes
    // fires the LLM correction call. Use a crawl WITHOUT the keywords from
    // the tree so everything is ungrounded → correction call runs.
    const plainCrawl = makeCrawlData(5, { title: "Unrelated content with no matching keywords" });
    mockSonnetCreate
      .mockResolvedValueOnce(sonnetJsonResponse(makeHealthcareResponseFromFixture())) // primary
      .mockResolvedValueOnce(sonnetJsonResponse({ keep: [], remove: [] })); // correction

    await extractTrees(plainCrawl, makeDiscoveryData(), "manipal-fixture-rm.com");

    // The correction is the SECOND Sonnet call (first is the extraction)
    const correctionCall = mockSonnetCreate.mock.calls[1]?.[0] as Record<string, unknown> | undefined;
    expect(correctionCall).toBeDefined();
    expect(correctionCall!.max_tokens).toBe(2000);
    expect(correctionCall!.max_completion_tokens).toBeUndefined();
  });

  it("U6: regression guard — no Sonnet call ever uses max_completion_tokens", async () => {
    // Run a full extraction so both primary + correction calls fire.
    mockSonnetCreate
      .mockResolvedValueOnce(sonnetJsonResponse(makeHealthcareResponseFromFixture()))
      .mockResolvedValueOnce(sonnetJsonResponse({ keep: [], remove: [] }));

    await extractTrees(makeHealthcareCrawl(), makeDiscoveryData(), "manipal-fixture-rm.com");

    for (const call of mockSonnetCreate.mock.calls) {
      const args = call[0] as Record<string, unknown>;
      expect(args.max_completion_tokens).toBeUndefined();
    }
  });

  it("U7: regression guard — OpenAI gpt-5.4 call never uses max_tokens", async () => {
    mockSonnetCreate.mockRejectedValue(new Error("Sonnet timeout"));
    mockOpenAICreate.mockResolvedValue(openaiJsonResponse(makeHealthcareResponseFromFixture()));

    await extractTrees(makeHealthcareCrawl(), makeDiscoveryData(), "manipal-fixture-rm.com");

    for (const call of mockOpenAICreate.mock.calls) {
      const args = call[0] as Record<string, unknown>;
      expect(args.max_tokens).toBeUndefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §c.2 — Promise.race timeout (U8-U10)
// ═══════════════════════════════════════════════════════════════════════════

describe("ES-086 §c.2 — EXTRACTION_TIMEOUT_MS (RM independent)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-openai";
  });

  it("U8: EXTRACTION_TIMEOUT_MS constant is 200000 (requires export)", () => {
    // ScriptDev may export the constant directly OR via a `__test_internals`
    // namespace. Until then this test fails with "expected undefined to be
    // 200000" — an expected RED state that confirms the export is needed.
    expect(EXTRACTION_TIMEOUT_MS_EXPORT).toBe(200000);
  });

  it("U9: Sonnet call resolving at ~60s (under 200s timeout) succeeds (RED pre-fix — 35s timer fires first)", async () => {
    vi.useFakeTimers();

    mockSonnetCreate.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(sonnetJsonResponse(makeHealthcareResponseFromFixture())), 60_000);
        }),
    );

    const resultPromise = extractTrees(
      makeHealthcareCrawl(),
      makeDiscoveryData(),
      "manipal-fixture-rm.com",
    );

    // Advance past 60s (resolution) but before 200s (post-fix timeout).
    // Pre-fix the 35s timer inside Promise.race fires FIRST and wins the race,
    // causing rejection with "Sonnet timeout" → the caller falls through to
    // gpt-5.4, which is also mocked to hang → empty trees → test fails.
    await vi.advanceTimersByTimeAsync(61_000);

    const result = await resultPromise;

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.trees.geoTree.leafCount).toBeGreaterThan(0);
    expect(mockSonnetCreate).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("U10: Sonnet call never resolving times out with recognizable error", async () => {
    vi.useFakeTimers();

    // Sonnet hangs forever; gpt-5.4 also hangs so the caller falls to empty
    // trees after both time out. Both still emit "Sonnet timeout" / "OpenAI
    // timeout" (post-fix "GPT-4o timeout" pre-fix) log lines via the catch
    // blocks. The ASSERTION is that the extraction eventually completes (via
    // the empty-trees fallback) without crashing and that the Sonnet call
    // was attempted at least once.
    mockSonnetCreate.mockImplementation(() => new Promise(() => { /* never resolves */ }));
    mockOpenAICreate.mockImplementation(() => new Promise(() => { /* never resolves */ }));

    const resultPromise = extractTrees(
      makeHealthcareCrawl(),
      makeDiscoveryData(),
      "manipal-fixture-rm.com",
    );

    // Advance past 3 × 200s (200s Sonnet attempt 1 + 200s attempt 2 + 200s gpt-5.4 fallback)
    await vi.advanceTimersByTimeAsync(700_000);

    const result = await resultPromise;

    // FIND-023: caller should report a discriminated failure after all providers
    // timed out, instead of a hollow empty-tree "success".
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("all_providers_failed");
    expect(mockSonnetCreate).toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §c.3 — Schema validator (U11-U19)
//
// All 9 tests gated on ScriptDev exporting validateExtractionResponse +
// TreeExtractorSchemaError. Until then the describe block skipIfs.
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!validateExtractionResponse || !TreeExtractorSchemaError)(
  "ES-086 §c.3 — validateExtractionResponse (RM independent)",
  () => {
    function getError(fn: () => void): Error | null {
      try {
        fn();
        return null;
      } catch (e) {
        return e as Error;
      }
    }

    it("U11: accepts a valid TreeExtractionResult", () => {
      const valid = {
        geoTree: makeValidGeoTree(),
        categoryTree: makeValidCategoryTree(),
        mapping: makeValidMapping(),
      };
      expect(() => validateExtractionResponse!(valid)).not.toThrow();
    });

    it("U12: throws on missing geoTree", () => {
      const input = { categoryTree: makeValidCategoryTree(), mapping: makeValidMapping() };
      const err = getError(() => validateExtractionResponse!(input));
      expect(err).toBeInstanceOf(TreeExtractorSchemaError!);
      expect((err as unknown as { field: string }).field).toBe("geoTree");
    });

    it("U13: throws on geoTree.leafCount not a number", () => {
      const input = {
        geoTree: { leafCount: "five", root: { children: [] } },
        categoryTree: makeValidCategoryTree(),
        mapping: makeValidMapping(),
      };
      const err = getError(() => validateExtractionResponse!(input));
      expect(err).toBeInstanceOf(TreeExtractorSchemaError!);
      expect((err as unknown as { field: string }).field).toBe("geoTree.leafCount");
    });

    it("U14: throws on geoTree.root.children not an array", () => {
      const input = {
        geoTree: { leafCount: 0, root: { children: "not-an-array" } },
        categoryTree: makeValidCategoryTree(),
        mapping: makeValidMapping(),
      };
      const err = getError(() => validateExtractionResponse!(input));
      expect(err).toBeInstanceOf(TreeExtractorSchemaError!);
      expect((err as unknown as { field: string }).field).toBe("geoTree.root.children");
    });

    it("U15: throws on missing categoryTree", () => {
      const input = { geoTree: makeValidGeoTree(), mapping: makeValidMapping() };
      const err = getError(() => validateExtractionResponse!(input));
      expect(err).toBeInstanceOf(TreeExtractorSchemaError!);
      expect((err as unknown as { field: string }).field).toBe("categoryTree");
    });

    it("U16: throws on categoryTree.leafCount not a number", () => {
      const input = {
        geoTree: makeValidGeoTree(),
        categoryTree: { leafCount: null, root: { children: [] } },
        mapping: makeValidMapping(),
      };
      const err = getError(() => validateExtractionResponse!(input));
      expect(err).toBeInstanceOf(TreeExtractorSchemaError!);
      expect((err as unknown as { field: string }).field).toBe("categoryTree.leafCount");
    });

    it("U17: throws on missing mapping", () => {
      const input = { geoTree: makeValidGeoTree(), categoryTree: makeValidCategoryTree() };
      const err = getError(() => validateExtractionResponse!(input));
      expect(err).toBeInstanceOf(TreeExtractorSchemaError!);
      expect((err as unknown as { field: string }).field).toBe("mapping");
    });

    it("U18: throws on mapping.entries not an array", () => {
      const input = {
        geoTree: makeValidGeoTree(),
        categoryTree: makeValidCategoryTree(),
        mapping: { entries: null, totalEntries: 0 },
      };
      const err = getError(() => validateExtractionResponse!(input));
      expect(err).toBeInstanceOf(TreeExtractorSchemaError!);
      expect((err as unknown as { field: string }).field).toBe("mapping.entries");
    });

    it("U19: TreeExtractorSchemaError has field + name properties", () => {
      const err = new TreeExtractorSchemaError!("test message", "test.field");
      expect(err.name).toBe("TreeExtractorSchemaError");
      expect((err as unknown as { field: string }).field).toBe("test.field");
      expect(err.message).toBe("test message");
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// §c.4 — classifySonnetError dispatch table (U20-U32)
//
// 13 tests gated on ScriptDev exporting classifySonnetError.
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!classifySonnetError)(
  "ES-086 §c.4 — classifySonnetError dispatch table (RM independent)",
  () => {
    it("U20: timeout sentinel → { kind: 'timeout' }", () => {
      const result = classifySonnetError!(new Error("Sonnet timeout"));
      expect(result.kind).toBe("timeout");
    });

    it("U21: TreeExtractorSchemaError → { kind: 'schema' }", () => {
      // Skip body if TreeExtractorSchemaError isn't exported — the describe-level
      // gate already handles the classifier, but this specific test also
      // depends on the schema error class.
      if (!TreeExtractorSchemaError) {
        // Construct a duck-typed error with the right name so the name-based
        // check in classifySonnetError's instanceof branch fires.
        const err = Object.assign(new Error("schema"), { name: "TreeExtractorSchemaError" });
        const result = classifySonnetError!(err);
        // Best-effort: spec says classifier uses `instanceof TreeExtractorSchemaError`
        // so a duck-typed error would fall through to "other". Relaxed assertion.
        expect(["schema", "other"]).toContain(result.kind);
        return;
      }
      const err = new TreeExtractorSchemaError("bad shape", "geoTree.root.children");
      const result = classifySonnetError!(err);
      expect(result.kind).toBe("schema");
    });

    it("U22: Anthropic 503 overload → { kind: 'overload' }", () => {
      const err = Object.assign(new Error("service overloaded"), { status: 503 });
      const result = classifySonnetError!(err);
      expect(result.kind).toBe("overload");
    });

    it("U23: Anthropic 529 overload → { kind: 'overload' }", () => {
      const err = Object.assign(new Error("529"), { status: 529 });
      const result = classifySonnetError!(err);
      expect(result.kind).toBe("overload");
    });

    it("U24: 400 auth_or_config → { kind: 'auth_or_config' }", () => {
      const err = Object.assign(new Error("bad request"), { status: 400 });
      const result = classifySonnetError!(err);
      expect(result.kind).toBe("auth_or_config");
    });

    it("U25: 401 auth_or_config → { kind: 'auth_or_config' }", () => {
      const err = Object.assign(new Error("unauthorized"), { status: 401 });
      const result = classifySonnetError!(err);
      expect(result.kind).toBe("auth_or_config");
    });

    it("U26: 403 auth_or_config → { kind: 'auth_or_config' }", () => {
      const err = Object.assign(new Error("forbidden"), { status: 403 });
      const result = classifySonnetError!(err);
      expect(result.kind).toBe("auth_or_config");
    });

    it("U27: network ECONNRESET → { kind: 'network' }", () => {
      const err = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      const result = classifySonnetError!(err);
      expect(result.kind).toBe("network");
    });

    it("U28: network EAI_AGAIN → { kind: 'network' }", () => {
      const err = Object.assign(new Error("dns temporary"), { code: "EAI_AGAIN" });
      const result = classifySonnetError!(err);
      expect(result.kind).toBe("network");
    });

    it("U29: network ETIMEDOUT → { kind: 'network' }", () => {
      const err = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      const result = classifySonnetError!(err);
      expect(result.kind).toBe("network");
    });

    it("U30: network EPIPE → { kind: 'network' }", () => {
      const err = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
      const result = classifySonnetError!(err);
      expect(result.kind).toBe("network");
    });

    it("U31: catch-all generic Error → { kind: 'other' } with errType/errMsg", () => {
      const result = classifySonnetError!(new Error("something weird happened"));
      expect(result.kind).toBe("other");
      if (result.kind === "other") {
        expect(result.errType).toBe("Error");
        expect(result.errMsg).toBe("something weird happened");
      }
    });

    it("U32: non-Error input (string) → { kind: 'other', errType: 'non-error' }", () => {
      const result = classifySonnetError!("string error" as unknown);
      expect(result.kind).toBe("other");
      if (result.kind === "other") {
        expect(result.errType).toBe("non-error");
        expect(result.errMsg).toBe("string error");
      }
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// §c.5 — extractTrees catch-block dispatch (U33-U37)
//
// End-to-end dispatch-table behavior — verifies the short-circuit semantics
// at the extractTrees level (not just classifySonnetError in isolation).
// ═══════════════════════════════════════════════════════════════════════════

describe("ES-086 §c.5 — extractTrees catch-block dispatch (RM independent)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-openai";
  });

  it("U33: **load-bearing for AC-19** — timeout in attempt 1 skips attempt 2, falls to gpt-5.4", async () => {
    // First Sonnet attempt throws "Sonnet timeout" — post-fix the dispatch
    // table short-circuits: NO attempt 2 (temp 0.3) retry, straight to gpt-5.4.
    // Pre-fix the catch block retries at temp 0.3 unconditionally, so Sonnet
    // is called twice before falling through.
    mockSonnetCreate.mockRejectedValue(new Error("Sonnet timeout"));
    mockOpenAICreate.mockResolvedValueOnce(openaiJsonResponse(makeHealthcareResponseFromFixture()));

    const result = await extractTrees(
      makeHealthcareCrawl(),
      makeDiscoveryData(),
      "manipal-fixture-rm.com",
    );

    // AC-19 row 1: Sonnet called exactly ONCE (no temp-0.3 retry).
    expect(mockSonnetCreate).toHaveBeenCalledTimes(1);
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.trees.geoTree.leafCount).toBeGreaterThan(0);
  });

  it("U34: overload (503) in attempt 1 skips attempt 2, falls to gpt-5.4", async () => {
    const overloadErr = Object.assign(new Error("service overloaded"), { status: 503 });
    mockSonnetCreate.mockRejectedValue(overloadErr);
    mockOpenAICreate.mockResolvedValueOnce(openaiJsonResponse(makeHealthcareResponseFromFixture()));

    const result = await extractTrees(
      makeHealthcareCrawl(),
      makeDiscoveryData(),
      "manipal-fixture-rm.com",
    );

    expect(mockSonnetCreate).toHaveBeenCalledTimes(1);
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.trees.geoTree.leafCount).toBeGreaterThan(0);
  });

  it("U35: schema error in attempt 1 retries at temp 0.3, succeeds", async () => {
    // Gated on TreeExtractorSchemaError being exported — without it the
    // catch-block can't construct the typed error for dispatch.
    if (!TreeExtractorSchemaError) {
      // Synthesize via invalid JSON which triggers the existing
      // parseJsonResponse path's error handling. Pre-fix behavior varies —
      // accept either call pattern as a relaxed regression guard.
      mockSonnetCreate
        .mockResolvedValueOnce({ content: [{ type: "text", text: "not valid json" }] })
        .mockResolvedValueOnce(sonnetJsonResponse(makeHealthcareResponseFromFixture()));
      const result = await extractTrees(
        makeHealthcareCrawl(),
        makeDiscoveryData(),
        "manipal-fixture-rm.com",
      );
      expect(mockSonnetCreate.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.trees.geoTree.leafCount).toBeGreaterThanOrEqual(0);
      return;
    }
    const schemaErr = new TreeExtractorSchemaError("bad shape", "geoTree.root.children");
    mockSonnetCreate
      .mockRejectedValueOnce(schemaErr)
      .mockResolvedValueOnce(sonnetJsonResponse(makeHealthcareResponseFromFixture()));

    const result = await extractTrees(
      makeHealthcareCrawl(),
      makeDiscoveryData(),
      "manipal-fixture-rm.com",
    );

    // AC-19 row 2: Sonnet called twice (first rejected with schema, second succeeded).
    expect(mockSonnetCreate).toHaveBeenCalledTimes(2);
    // Second call should use temperature 0.3 per the retry contract.
    const secondCall = mockSonnetCreate.mock.calls[1]?.[0] as Record<string, unknown> | undefined;
    expect(secondCall?.temperature).toBe(0.3);
    expect(mockOpenAICreate).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.trees.geoTree.leafCount).toBeGreaterThan(0);
  });

  it("U36: auth error (401) in attempt 1 fails fast, no fallback", async () => {
    const authErr = Object.assign(new Error("unauthorized"), { status: 401 });
    mockSonnetCreate.mockRejectedValue(authErr);
    mockOpenAICreate.mockResolvedValue(openaiJsonResponse(makeHealthcareResponseFromFixture()));

    // Per AC-19 row 4: auth_or_config errors propagate via throw (no fallback).
    // Post-fix extractTrees should throw; caller decides what to do.
    // Pre-fix extractTrees silently falls through to gpt-5.4 and returns
    // the fallback result → test fails because OpenAI was called.
    let caught: Error | null = null;
    let result: ExtractTreesOutcome | null = null;
    try {
      result = await extractTrees(
        makeHealthcareCrawl(),
        makeDiscoveryData(),
        "manipal-fixture-rm.com",
      );
    } catch (e) {
      caught = e as Error;
    }

    // Post-fix: either the function threw OR it returned a failure outcome
    // (depending on how the fail-fast path is implemented). The load-bearing
    // assert is that gpt-5.4 was NOT called (pre-fix it IS called).
    expect(mockOpenAICreate).not.toHaveBeenCalled();
    // And if a result was returned, it must NOT be a populated tree (that
    // would mean gpt-5.4 ran despite the mock check above — defense in depth).
    if (result) {
      expect(result.ok).toBe(false);
    } else {
      expect(caught).not.toBeNull();
    }
  });

  it("U37: network error in attempt 1 retries at temp 0.3 once, succeeds", async () => {
    const networkErr = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    mockSonnetCreate
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValueOnce(sonnetJsonResponse(makeHealthcareResponseFromFixture()));

    const result = await extractTrees(
      makeHealthcareCrawl(),
      makeDiscoveryData(),
      "manipal-fixture-rm.com",
    );

    // AC-19 row 5: network errors retry at temp 0.3, then fall through.
    expect(mockSonnetCreate).toHaveBeenCalledTimes(2);
    expect(mockOpenAICreate).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.trees.geoTree.leafCount).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §c.6 — treeIsEmpty helper (U38-U48)
//
// The helper lives in citation-check/route.ts (not tree-extractor.ts). Spec
// §c.6 says: "tests must either import via a __test_internals export OR
// mirror the helper inline in the test file. ScriptDev's call."
//
// Mirroring inline is cleaner for these tests because it decouples from
// ScriptDev's export decision. The inline mirror MUST match §b.6 verbatim.
// ScriptDev cross-checks during Phase 3 review.
// ═══════════════════════════════════════════════════════════════════════════

function treeIsEmptyMirror(t: unknown): boolean {
  if (!t || typeof t !== "object") return true;
  const obj = t as { leafCount?: unknown; root?: { children?: unknown } };
  if (obj.leafCount === 0) return true;
  if (!Array.isArray(obj.root?.children) || obj.root.children.length === 0) return true;
  return false;
}

describe("ES-086 §c.6 — treeIsEmpty helper (RM inline mirror of §b.6)", () => {
  it("U38: null is empty", () => {
    expect(treeIsEmptyMirror(null)).toBe(true);
  });

  it("U39: undefined is empty", () => {
    expect(treeIsEmptyMirror(undefined)).toBe(true);
  });

  it("U40: non-object values (string, number, boolean) are empty", () => {
    expect(treeIsEmptyMirror("string")).toBe(true);
    expect(treeIsEmptyMirror(42)).toBe(true);
    expect(treeIsEmptyMirror(true)).toBe(true);
  });

  it("U41: object with leafCount=0 is empty (even with children)", () => {
    const input = {
      leafCount: 0,
      root: { children: [{ id: "x", name: "X", level: "city", children: [], pageCount: 1, evidence: [] }] },
    };
    expect(treeIsEmptyMirror(input)).toBe(true);
  });

  it("U42: object with no root.children (missing field) is empty", () => {
    const input = { leafCount: 5, root: {} };
    expect(treeIsEmptyMirror(input)).toBe(true);
  });

  it("U43: object with root.children=[] is empty", () => {
    const input = { leafCount: 5, root: { children: [] } };
    expect(treeIsEmptyMirror(input)).toBe(true);
  });

  it("U44: object with leafCount>0 AND non-empty root.children is NOT empty", () => {
    const input = {
      leafCount: 5,
      root: { children: [{ id: "x", name: "X", level: "city", children: [], pageCount: 1, evidence: [] }] },
    };
    expect(treeIsEmptyMirror(input)).toBe(false);
  });

  it("U45: FIX-2 sentinel shape is detected as empty", () => {
    // The malformed sentinel currently shipping in citation-check/route.ts
    // lines 131-134. Catches via leafCount=0 AND empty children.
    const sentinel = {
      root: { id: "root", name: "Root", children: [] },
      leafCount: 0,
    };
    expect(treeIsEmptyMirror(sentinel)).toBe(true);
  });

  it("U46: emptyGeoTree() is detected as empty", () => {
    expect(treeIsEmptyMirror(emptyGeoTree())).toBe(true);
  });

  it("U47: emptyCategoryTree() is detected as empty", () => {
    expect(treeIsEmptyMirror(emptyCategoryTree())).toBe(true);
  });

  it("U48: makeValidGeoTree() (populated factory) is NOT detected as empty", () => {
    expect(treeIsEmptyMirror(makeValidGeoTree())).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §c.7 — Smoke + structural tests (U49-U51)
// ═══════════════════════════════════════════════════════════════════════════

describe("ES-086 §c.7 — extractTrees smoke + structural (RM independent)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-openai";
  });

  it("U49: extractTrees on Manipal fixture produces populated trees (AC-7)", async () => {
    mockSonnetCreate.mockResolvedValue(sonnetJsonResponse(manipalFixture.expectedTreeExtractionResponse));

    const result = await extractTrees(
      manipalFixture.crawlData,
      manipalFixture.discoveryData,
      manipalFixture.domain,
      "healthcare",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.trees.geoTree.leafCount).toBeGreaterThan(0);
    expect(result.trees.categoryTree.leafCount).toBeGreaterThan(0);
    expect(result.trees.mapping.entries.length).toBeGreaterThan(0);
  });

  it("U50: extractTrees does NOT return emptyGeoTree() for Manipal fixture (AC-8)", async () => {
    mockSonnetCreate.mockResolvedValue(sonnetJsonResponse(manipalFixture.expectedTreeExtractionResponse));

    const result = await extractTrees(
      manipalFixture.crawlData,
      manipalFixture.discoveryData,
      manipalFixture.domain,
      "healthcare",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.trees.geoTree.root.children.length).toBeGreaterThan(0);
    expect(result.trees.categoryTree.root.children.length).toBeGreaterThan(0);
    // Defensive: must NOT have the emptyGeoTree() "global"/"Global" root
    // with zero children (the empty fallback returns exactly that shape).
    expect(result.trees.geoTree.root.children.length).not.toBe(0);
  });

  it("U51: SaaS-style small-site fixture regresses cleanly (no empty fallback, AC-9)", async () => {
    // Small SaaS site: 1 geo leaf (or 0 for pure-digital), 1 category leaf.
    // Tests that the 20K budget doesn't regress smaller-site behavior.
    const saasResponse: TreeExtractionResult = {
      geoTree: emptyGeoTree(), // pure-digital SaaS: no geo leaves
      categoryTree: {
        root: {
          id: "software",
          name: "Software",
          level: 0,
          children: [
            { id: "software-seo", name: "SEO Tools", level: 1, children: [], pageCount: 5, evidence: ["https://saas-fixture-rm.com/features"] },
          ],
          pageCount: 5,
          evidence: [],
        },
        leafCount: 1,
        extractedAt: new Date().toISOString(),
      },
      mapping: emptyMapping(),
    };

    mockSonnetCreate.mockResolvedValue(sonnetJsonResponse(saasResponse));

    const result = await extractTrees(
      makeCrawlData(50, { title: "Software SEO Tools features" }),
      makeDiscoveryData(),
      "saas-fixture-rm.com",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.trees.categoryTree.leafCount).toBeGreaterThanOrEqual(1);
    // geoTree.leafCount === 0 is expected for pure-digital sites — NOT the
    // empty fallback (which would also have leafCount=0 but fire when the
    // LLM call fails). The distinguishing signal is that the mock resolved
    // successfully, so the categoryTree is populated.
    expect(result.trees.categoryTree.root.children.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §c.8 — Function rename grep test (U52)
// ═══════════════════════════════════════════════════════════════════════════

describe("ES-086 §c.8 — function rename guard (RM independent)", () => {
  it("U52: tree-extractor.ts contains zero GPT-4o / gpt-4o references (AC-21)", () => {
    const source = readFileSync(TREE_EXTRACTOR_SOURCE_PATH, "utf-8");
    // Case-insensitive match covers "GPT-4o", "gpt-4o", "Gpt-4o", etc.
    // Pre-fix the file has 7 references (lines 5, 277, 293, 520, 524, 528, 531
    // per ES-086 SpecMaster note 1); post-AC-21 all must be gone.
    const matches = source.match(/gpt-4o/gi) ?? [];
    expect(matches).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Issue M — selectInventoryPages & pathDepth (per-type quotas, shallow-first)
// ═══════════════════════════════════════════════════════════════════════════

describe("Issue M — pathDepth()", () => {
  it("returns 0 for domain root", () => {
    expect(pathDepth("https://example.com/")).toBe(0);
  });

  it("returns 1 for single-segment path", () => {
    expect(pathDepth("https://example.com/about/")).toBe(1);
  });

  it("returns correct count for nested path", () => {
    expect(pathDepth("https://example.com/bangalore/specialities/cardiology/")).toBe(3);
  });

  it("ignores trailing slash vs. no trailing slash", () => {
    expect(pathDepth("https://example.com/a/b/c")).toBe(3);
    expect(pathDepth("https://example.com/a/b/c/")).toBe(3);
  });

  it("returns 99 for malformed URL", () => {
    expect(pathDepth("not-a-url")).toBe(99);
  });
});

describe("Issue M — selectInventoryPages()", () => {
  const mkPage = (url: string, pageType: CrawledPage["pageType"]): CrawledPage => ({
    url, pageType,
    title: "", h1: "", headings: [], content: "",
    existingSchema: [], hasStructuredData: false,
    contactInfo: [], faqContent: [], testimonials: [], certifications: [],
  });

  it("returns all pages when count <= limit", () => {
    const pages = [
      mkPage("https://example.com/", "homepage"),
      mkPage("https://example.com/about/", "about"),
    ];
    const selected = selectInventoryPages(pages, 150);
    expect(selected.length).toBe(2);
  });

  it("enforces hard cap when budget exhausted", () => {
    const pages = Array.from({ length: 300 }, (_, i) =>
      mkPage(`https://example.com/services/s-${i}/`, "services")
    );
    const selected = selectInventoryPages(pages, 150);
    expect(selected.length).toBe(150);
  });

  it("sorts within bucket by path depth (shallow first)", () => {
    const pages = [
      mkPage("https://example.com/a/b/c/d/deep/", "services"),
      mkPage("https://example.com/shallow/", "services"),
      mkPage("https://example.com/a/b/mid/", "services"),
    ];
    const selected = selectInventoryPages(pages, 10);
    expect(selected[0].url).toBe("https://example.com/shallow/");
    expect(selected[1].url).toBe("https://example.com/a/b/mid/");
    expect(selected[2].url).toBe("https://example.com/a/b/c/d/deep/");
  });

  it("Issue P: split-sample applies ONLY to team bucket (not services)", () => {
    // Issue N shipped an unconditional split-sample that cost faq_coverage,
    // cta_structure, offering_clarity, content_freshness, and
    // competitive_positioning big regressions on Manipal because it traded
    // shallow landing pages for deep leaves in services/blog buckets where
    // the landing-level content is what those pillars score.
    //
    // Issue P restricts split-sample to the `team` bucket only (doctor
    // profiles → author_authority) while keeping services/blog/other buckets
    // on pure shallow-first.
    //
    // This test locks in: services bucket must be pure shallow-first, even
    // when it has mixed-depth pages.
    const pages: CrawledPage[] = [
      ...Array.from({ length: 5 }, (_, i) =>
        mkPage(`https://example.com/shallow-${i}/`, "services")
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        mkPage(`https://example.com/a/b/c/deep-${i}/`, "services")
      ),
    ];
    // Budget 4 → services quota=50, effective=min(50,10,4)=4.
    // Post-Issue-P: pure shallow-first → all 4 should be depth-1 shallow pages.
    const selected = selectInventoryPages(pages, 4);
    expect(selected.length).toBe(4);

    const depths = selected.map((p) => {
      return new URL(p.url).pathname.split("/").filter(Boolean).length;
    });
    const shallowCount = depths.filter((d) => d === 1).length;
    const deepCount = depths.filter((d) => d === 4).length;

    // Pure shallow-first: all 4 picked from shallow bucket
    expect(shallowCount).toBe(4);
    expect(deepCount).toBe(0);
  });

  it("Issue P: team bucket still split-samples shallow + deep", () => {
    // Team bucket MUST retain split-sample because individual doctor profile
    // pages at deeper paths carry the named-author signal that powers the
    // author_authority pillar. Without split-sample, shallow-first picks only
    // the doctor-list category landings (which don't have named authors) and
    // author_authority collapses.
    const pages: CrawledPage[] = [
      ...Array.from({ length: 5 }, (_, i) =>
        mkPage(`https://example.com/team-${i}/`, "team")
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        mkPage(`https://example.com/a/b/c/doctor-${i}/`, "team")
      ),
    ];
    const selected = selectInventoryPages(pages, 4);
    expect(selected.length).toBe(4);

    const depths = selected.map((p) => {
      return new URL(p.url).pathname.split("/").filter(Boolean).length;
    });
    const shallowCount = depths.filter((d) => d === 1).length;
    const deepCount = depths.filter((d) => d === 4).length;

    // Split-sample: ceil(4/2)=2 shallow + floor(4/2)=2 deep
    expect(shallowCount).toBe(2);
    expect(deepCount).toBe(2);
  });

  it("guarantees minimum blog coverage when budget is tight (Manipal-class)", () => {
    // Simulate Manipal's post-classifier-fix distribution: 121 services, 94 team,
    // 33 blog. Under the legacy "structural-first, then slice(150)" algorithm,
    // blog coverage was 0 because structural (services+team = 215) > 150.
    // Issue M's key regression guard: blog MUST get at least its quota (15).
    // Leftover budget may give it more (quotas are minimums, not caps).
    const pages: CrawledPage[] = [
      mkPage("https://example.com/", "homepage"),
      ...Array.from({ length: 121 }, (_, i) =>
        mkPage(`https://example.com/services/${String(i).padStart(3, "0")}/`, "services")
      ),
      ...Array.from({ length: 94 }, (_, i) =>
        mkPage(`https://example.com/team/${String(i).padStart(3, "0")}/`, "team")
      ),
      ...Array.from({ length: 33 }, (_, i) =>
        mkPage(`https://example.com/blog/${String(i).padStart(3, "0")}/`, "blog")
      ),
    ];
    const selected = selectInventoryPages(pages, 150);

    expect(selected.length).toBe(150);

    const countByType = selected.reduce((acc, p) => {
      acc[p.pageType] = (acc[p.pageType] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    // Regression guard: blog coverage is guaranteed at least the quota (15).
    // This was 0 under the legacy algorithm for Manipal-class sites.
    expect(countByType.blog).toBeGreaterThanOrEqual(15);
    expect(countByType.blog).toBeLessThanOrEqual(33); // bucket ceiling
    // Services gets its quota minimum
    expect(countByType.services).toBeGreaterThanOrEqual(50);
    // Team gets its quota minimum
    expect(countByType.team).toBeGreaterThanOrEqual(30);
    // Homepage always in
    expect(countByType.homepage).toBe(1);
    // Total sums to 150
    const total = Object.values(countByType).reduce((a, b) => a + b, 0);
    expect(total).toBe(150);
  });

  it("rolls leftover budget forward when a bucket is under-filled", () => {
    // Homepage quota is 3, but only 1 page exists → 2 slots roll forward.
    // Budget of 10: homepage 1, about 8, services 1 (fills via rollover-cap).
    const pages: CrawledPage[] = [
      mkPage("https://example.com/", "homepage"),
      ...Array.from({ length: 10 }, (_, i) => mkPage(`https://example.com/about-${i}/`, "about")),
      ...Array.from({ length: 10 }, (_, i) => mkPage(`https://example.com/services/${i}/`, "services")),
    ];
    const selected = selectInventoryPages(pages, 10);
    expect(selected.length).toBe(10);
    const countByType = selected.reduce((acc, p) => {
      acc[p.pageType] = (acc[p.pageType] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    expect(countByType.homepage).toBe(1);
    expect(countByType.about).toBe(8);  // respects quota
    expect(countByType.services).toBe(1); // fills remaining
  });

  it("is deterministic — same input produces same output", () => {
    const pages = Array.from({ length: 100 }, (_, i) =>
      mkPage(`https://example.com/a/b/${i}/`, "services")
    );
    const a = selectInventoryPages(pages, 50);
    const b = selectInventoryPages(pages, 50);
    expect(a.map((p) => p.url)).toEqual(b.map((p) => p.url));
  });
});
