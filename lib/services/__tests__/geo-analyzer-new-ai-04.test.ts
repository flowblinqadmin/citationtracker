/**
 * NEW-AI-04 regression test
 *
 * `analyzeGeoGaps` called `GeoScorecardSchema.parse(JSON.parse(raw))` with no
 * try/catch and no markdown-fence stripping.  A truncated or fenced LLM
 * response (e.g. "```json\n{…incomplete") would throw SyntaxError /
 * ZodError and hard-fail the entire audit (retried twice, then permanently
 * failed).
 *
 * After the fix the function must:
 *   1. Not throw when the LLM returns a markdown-fenced valid JSON string
 *      (fence-stripping retained).
 *   2. THROW on truncated/unparseable JSON so the stage fails and QStash
 *      retries. (2026-06-10 revision: the original graceful-empty-scorecard
 *      fallback completed the audit with a customer-visible 0/100 on the very
 *      first live truncation — silently wrong data is worse than a visible
 *      retry/failure.)
 *
 * LOCAL-LLM branch (LLM_LOCAL=1):
 *   4. callGemini POSTs to LLM_BASE_URL/chat/completions with model from
 *      resolveOpenAIModel and returns choices[0].message.content.
 *   5. With LLM_LOCAL unset, callGemini uses the GoogleGenerativeAI path
 *      (existing mock still intercepts; tests stay green).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CrawlData } from "@/lib/services/geo-crawler";
import type { CompetitiveIntel } from "@/lib/services/competitive-intel";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCrawlData(): CrawlData {
  return {
    domain: "example.com",
    totalCrawled: 1,
    pages: [
      {
        url: "https://example.com/",
        pageType: "homepage",
        title: "Example",
        h1: "Example",
        headings: [],
        content: "Hello world.",
        existingSchema: [],
        hasStructuredData: false,
        schemaBlocks: [],
        contactInfo: [],
        faqContent: [],
        testimonials: [],
        certifications: [],
      } as unknown as CrawlData["pages"][number],
    ],
  };
}

function makeCompetitiveIntel(): CompetitiveIntel {
  return {
    topCompetitors: [],
    brandPerception: "",
    competitivePosition: "",
    competitorGeoStatus: [],
    industryContext: "Software",
    groundTruthIndustry: {
      industry: "Software",
      source: "none",
      schemaTypes: [],
      confidence: "low",
    },
  };
}

// ── Mock @google/generative-ai ───────────────────────────────────────────────
//
// vi.mock() factories are hoisted to the top of the file by Vitest before any
// `let` declarations run.  If we close over a plain `let` variable the factory
// captures `undefined` at hoist time.  The fix is vi.hoisted() which runs
// its callback in the same hoisted scope, giving us a mutable ref the factory
// can reliably close over.

const { geminiRef } = vi.hoisted(() => ({
  geminiRef: { raw: "" as string },
}));

vi.mock("@google/generative-ai", () => ({
  // Use `function` keyword so Vitest SSR treats this as a constructable mock.
  // Arrow-function bodies are mangled by the SSR transform and lose their
  // constructor prototype, causing `new GoogleGenerativeAI(...)` to throw.
  GoogleGenerativeAI: vi.fn().mockImplementation(function () {
    return {
      getGenerativeModel: vi.fn().mockReturnValue({
        generateContent: vi.fn().mockResolvedValue({
          response: { text: () => geminiRef.raw },
        }),
      }),
    };
  }),
}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe("analyzeGeoGaps — NEW-AI-04: parse resilience", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    geminiRef.raw = "";
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.GEMINI_API_KEY;
  });

  it("does NOT throw when the LLM returns markdown-fenced valid JSON (was RED before fix)", async () => {
    // Build a complete, valid scorecard wrapped in markdown fences — this is
    // exactly the pattern that caused the pre-fix SyntaxError.
    const validScorecard = {
      overallScore: 42,
      pillars: [
        {
          pillar: "metadata_freshness",
          pillarName: "Metadata Freshness",
          score: 50,
          findings: "Test finding.",
          recommendation: "Test rec.",
          priority: "medium",
          impactedPages: [],
        },
      ],
      topThreeImprovements: ["Fix A"],
    };

    geminiRef.raw = "```json\n" + JSON.stringify(validScorecard) + "\n```";

    const { analyzeGeoGaps } = await import("@/lib/services/geo-analyzer");
    await expect(
      analyzeGeoGaps(makeCrawlData(), makeCompetitiveIntel()),
    ).resolves.toBeDefined();
  });

  it("THROWS on truncated/unparseable JSON so the stage fails and QStash retries", async () => {
    // Truncated JSON — simulates a response that was cut off mid-token.
    geminiRef.raw = '{"overallScore": 42, "pillars": [{"pillar": "metadat';

    const { analyzeGeoGaps } = await import("@/lib/services/geo-analyzer");

    // 2026-06-10: a zero-score fallback here surfaced as a COMPLETED audit
    // scoring 0/100 live (flowblinq.com, real score 72). Parse failure must
    // propagate so the pipeline retries / fails visibly.
    await expect(
      analyzeGeoGaps(makeCrawlData(), makeCompetitiveIntel()),
    ).rejects.toThrow(/parse scorecard/i);
  });

  it("rejects with a descriptive error (never a zero scorecard) on garbage input", async () => {
    geminiRef.raw = "not json at all {broken";

    const { analyzeGeoGaps } = await import("@/lib/services/geo-analyzer");
    await expect(
      analyzeGeoGaps(makeCrawlData(), makeCompetitiveIntel()),
    ).rejects.toThrow(/parse scorecard/i);
  });

  it("strips leading ``` fence and parses correctly", async () => {
    const validScorecard = {
      overallScore: 75,
      pillars: [
        {
          pillar: "metadata_freshness",
          pillarName: "Metadata Freshness",
          score: 75,
          findings: "OK.",
          recommendation: "Good.",
          priority: "low",
          impactedPages: [],
        },
      ],
      topThreeImprovements: [],
    };

    // Only a leading fence (no closing fence) — another common LLM pattern
    geminiRef.raw = "```\n" + JSON.stringify(validScorecard);

    const { analyzeGeoGaps } = await import("@/lib/services/geo-analyzer");
    await expect(
      analyzeGeoGaps(makeCrawlData(), makeCompetitiveIntel()),
    ).resolves.toBeDefined();
  });
});

// ── callGemini — LLM_LOCAL=1 branch ─────────────────────────────────────────

describe("callGemini — LOCAL-LLM: routes through OpenAI-compatible gateway", () => {
  let capturedUrl: string | null = null;
  let capturedBody: Record<string, unknown> | null = null;

  // Build a minimal valid scorecard JSON so analyzeGeoGaps doesn't blow up
  // when it tries to parse the mock response further down the pipeline.
  const validScorecardJson = JSON.stringify({
    overallScore: 55,
    pillars: [
      {
        pillar: "metadata_freshness",
        pillarName: "Metadata Freshness",
        score: 55,
        findings: "ok",
        recommendation: "ok",
        priority: "medium",
        impactedPages: [],
      },
    ],
    topThreeImprovements: ["improve"],
  });

  beforeEach(() => {
    // Set local-LLM env vars
    process.env.LLM_LOCAL = "1";
    process.env.LLM_BASE_URL = "http://localhost:4321/v1";
    process.env.LLM_LOCAL_MODEL = "google/gemma-4-12b";
    // No Gemini key — ensures we'd fail if we fell through to the Gemini path
    delete process.env.GEMINI_API_KEY;

    capturedUrl = null;
    capturedBody = null;

    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: validScorecardJson } }],
        }),
      } as unknown as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LLM_LOCAL;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_LOCAL_MODEL;
  });

  it("POSTs to LLM_BASE_URL/chat/completions (not the Gemini API)", async () => {
    // Re-import to pick up the new env vars
    vi.resetModules();
    const { analyzeGeoGaps } = await import("@/lib/services/geo-analyzer");

    await analyzeGeoGaps(makeCrawlData(), makeCompetitiveIntel()).catch(() => {
      // parse errors further in pipeline are acceptable — we only care about the fetch call
    });

    expect(capturedUrl).toContain("localhost:4321");
    expect(capturedUrl).toContain("/chat/completions");
    expect(capturedUrl).not.toContain("generativelanguage.googleapis.com");
  });

  it("uses the model returned by resolveOpenAIModel (google/gemma-4-12b via LLM_LOCAL_MODEL)", async () => {
    vi.resetModules();
    const { analyzeGeoGaps } = await import("@/lib/services/geo-analyzer");

    await analyzeGeoGaps(makeCrawlData(), makeCompetitiveIntel()).catch(() => {});

    expect(capturedBody).not.toBeNull();
    expect(capturedBody).toHaveProperty("model", "google/gemma-4-12b");
  });

  it("sends max_completion_tokens: 32768 in the request body", async () => {
    vi.resetModules();
    const { analyzeGeoGaps } = await import("@/lib/services/geo-analyzer");

    await analyzeGeoGaps(makeCrawlData(), makeCompetitiveIntel()).catch(() => {});

    // 2026-06-10: raised from 16000 to match the prod budget — gemma (local
    // reasoning model) spends thinking tokens from the same allowance.
    expect(capturedBody).toHaveProperty("max_completion_tokens", 32768);
  });

  it("returns the content from choices[0].message.content", async () => {
    vi.resetModules();
    // Test callGemini directly by exercising it through analyzeGeoGaps and
    // observing that the fetch mock's response reaches the scorecard parser
    // (no throw means content was received and processed)
    const { analyzeGeoGaps } = await import("@/lib/services/geo-analyzer");

    // The mock returns validScorecardJson — analyzeGeoGaps should parse it
    const result = await analyzeGeoGaps(makeCrawlData(), makeCompetitiveIntel());
    expect(result).toHaveProperty("overallScore");
    expect(typeof result.overallScore).toBe("number");
  });

  it("includes a system message when systemInstruction is provided", async () => {
    vi.resetModules();
    // analyzeGeoGaps makes 2+ fetch calls: the primary scorecard call (with a
    // system instruction) and then the grounding-correction call (no system).
    // Capture ALL calls and check the FIRST one has a system message.
    const allBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      allBodies.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: validScorecardJson } }],
        }),
      } as unknown as Response;
    }) as typeof fetch;

    const { analyzeGeoGaps } = await import("@/lib/services/geo-analyzer");

    await analyzeGeoGaps(makeCrawlData(), makeCompetitiveIntel()).catch(() => {});

    // The first fetch call (primary scorecard) always includes a system instruction
    expect(allBodies.length).toBeGreaterThan(0);
    const firstBody = allBodies[0];
    expect(firstBody).toHaveProperty("messages");
    const msgs = firstBody.messages as Array<{ role: string; content: string }>;
    const systemMsg = msgs?.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.content).toBeTruthy();
  });
});
