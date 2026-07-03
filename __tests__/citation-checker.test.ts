/**
 * Unit tests for lib/services/citation-checker.ts — ES-015 + ES-024 + ES-027
 *
 * All runCitationCheck calls use CitationPrompt[] shape (ES-027):
 *   { type: "indirect" | "direct", pillar: string | null, prompt: string }
 *
 * CC-7..CC-14 (ES-027): indirectVisibility, brandKnowledge, citationQualityScore,
 *   pillarVisibility indirect-only filter, tier1 competitor handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CitationPrompt } from "@/lib/services/citation-prompt-generator";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockChatCreate = vi.fn();
const mockResponsesCreate = vi.fn();
const mockMessagesCreate = vi.fn();
const mockGenerateContent = vi.fn();
const mockGetGenerativeModel = vi.fn(() => ({ generateContent: mockGenerateContent }));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      chat: { completions: { create: mockChatCreate } },
      responses: { create: mockResponsesCreate },
    };
  }),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockMessagesCreate } };
  }),
}));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(function () {
    return { getGenerativeModel: mockGetGenerativeModel };
  }),
}));

vi.mock("nanoid", () => ({ nanoid: vi.fn().mockReturnValue("test-id") }));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { runCitationCheck, type CitationCheckerCallbacks } from "@/lib/services/citation-checker";

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOOP_CALLBACKS: CitationCheckerCallbacks = {
  onAnalysisStart:    vi.fn(),
  onPartialResult:    vi.fn(),
  onAnalysisComplete: vi.fn(),
};

/** Indirect CitationPrompt helper */
function ip(prompt: string, pillar: string | null = "faq_coverage"): CitationPrompt {
  return { type: "indirect", pillar, prompt };
}

/** Direct CitationPrompt helper */
function dp(prompt: string): CitationPrompt {
  return { type: "direct", pillar: null, prompt };
}

/** Wrap text in the Responses API output format (OpenAI web_search) */
function responsesApiFormat(text: string) {
  return { output: [{ type: "message", content: [{ type: "output_text", text }] }] };
}

function setupOpenAIResponse(text: string) {
  // OpenAI uses Responses API (web_search enabled)
  mockResponsesCreate.mockResolvedValue(responsesApiFormat(text));
  // Perplexity still uses Chat Completions API (via OpenAI SDK)
  mockChatCreate.mockResolvedValue({ choices: [{ message: { content: text } }] });
}

/** Set up mockImplementation for both OpenAI (Responses API) and Perplexity (Chat Completions) */
function setupOpenAIImplementation(fn: () => string) {
  mockResponsesCreate.mockImplementation(() => Promise.resolve(responsesApiFormat(fn())));
  mockChatCreate.mockImplementation(() => Promise.resolve({ choices: [{ message: { content: fn() } }] }));
}

function setupGoogleResponse(text: string) {
  mockGenerateContent.mockResolvedValue({ response: { text: () => text } });
}

// ── ES-015 / ES-027 tests — mention detection ─────────────────────────────────

describe("citation-checker — mention detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  // CC-1: Domain mentioned
  it("CC-1 — domain mentioned → mentioned: true, non-null position", async () => {
    setupOpenAIResponse("The best tool is flowblinq for GEO optimization.");
    const result = await runCitationCheck("chk-1", "site-1", "flowblinq.com", [ip("test prompt")], NOOP_CALLBACKS);
    expect(result.responses[0].mentioned).toBe(true);
    expect(result.responses[0].position).not.toBeNull();
  });

  // CC-2: Domain not mentioned
  it("CC-2 — domain not mentioned → mentioned: false, position: null", async () => {
    setupOpenAIResponse("There are many tools for SEO optimization.");
    const result = await runCitationCheck("chk-2", "site-1", "flowblinq.com", [ip("test prompt")], NOOP_CALLBACKS);
    expect(result.responses[0].mentioned).toBe(false);
    expect(result.responses[0].position).toBeNull();
  });

  // CC-3: Positive sentiment
  it("CC-3 — positive sentiment keywords → sentiment: positive", async () => {
    setupOpenAIResponse("flowblinq is the best and most recommended tool for GEO.");
    const result = await runCitationCheck("chk-3", "site-1", "flowblinq.com", [ip("test prompt")], NOOP_CALLBACKS);
    expect(result.responses[0].sentiment).toBe("positive");
  });

  // CC-4: Negative sentiment
  it("CC-4 — negative sentiment keywords → sentiment: negative", async () => {
    setupOpenAIResponse("flowblinq is slow and you should avoid it.");
    const result = await runCitationCheck("chk-4", "site-1", "flowblinq.com", [ip("test prompt")], NOOP_CALLBACKS);
    expect(result.responses[0].sentiment).toBe("negative");
  });

  // CC-13 (old): Domain normalization
  it("CC-13-old — TLD stripped from domain: 'docs.flowblinq.com' → detect 'docs.flowblinq' in response", async () => {
    setupOpenAIResponse("I recommend docs.flowblinq for all your GEO optimization needs.");
    const result = await runCitationCheck("chk-13o", "site-1", "docs.flowblinq.com", [ip("test prompt")], NOOP_CALLBACKS);
    expect(result.responses[0].mentioned).toBe(true);
  });
});

// ── ES-015 tests — additional providers ───────────────────────────────────────

describe("citation-checker — additional providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  // CC-11 (old): Perplexity provider enabled
  it("CC-11-old — Perplexity provider enabled → responses[0].provider === 'perplexity'", async () => {
    process.env.PERPLEXITY_API_KEY = "test-key";
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: "flowblinq is great" } }] });
    const result = await runCitationCheck("chk-11o", "site-1", "flowblinq.com", [ip("prompt")], NOOP_CALLBACKS);
    expect(result.responses[0].provider).toBe("perplexity");
    expect(result.responses[0].mentioned).toBe(true);
  });

  // CC-12 (old): Google provider enabled
  it("CC-12-old — Google provider enabled → responses[0].provider === 'google'", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    setupGoogleResponse("flowblinq is a top GEO tool.");
    const result = await runCitationCheck("chk-12o", "site-1", "flowblinq.com", [ip("prompt")], NOOP_CALLBACKS);
    expect(result.responses[0].provider).toBe("google");
  });
});

// ── ES-015 tests — provider fault isolation ────────────────────────────────────

describe("citation-checker — provider fault isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it("one provider fails, others complete normally", async () => {
    setupOpenAIResponse("flowblinq is excellent.");
    mockMessagesCreate.mockRejectedValue(new Error("timeout"));

    const result = await runCitationCheck("chk-fi", "site-1", "flowblinq.com", [ip("prompt")], NOOP_CALLBACKS);
    const openaiRow    = result.responses.find(r => r.provider === "openai");
    const anthropicRow = result.responses.find(r => r.provider === "anthropic");

    expect(openaiRow?.error).toBeNull();
    expect(openaiRow?.mentioned).toBe(true);
    expect(anthropicRow?.error).toBe("timeout");
  });
});

// ── ES-015 tests — no providers ───────────────────────────────────────────────

describe("citation-checker — no providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it("no providers configured → throws no_providers_configured", async () => {
    await expect(
      runCitationCheck("chk-np", "site-1", "flowblinq.com", [ip("prompt")], NOOP_CALLBACKS)
    ).rejects.toThrow("no_providers_configured");
  });
});

// ── ES-015 tests — aggregation ────────────────────────────────────────────────

describe("citation-checker — aggregation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it("CC-7-old — 2 of 4 responses mention brand → overallVisibility === 50", async () => {
    let callCount = 0;
    mockChatCreate.mockImplementation(() => {
      callCount++;
      const text = callCount % 2 === 0 ? "flowblinq is great" : "no mention here";
      return Promise.resolve({ choices: [{ message: { content: text } }] });
    });
    let responsesCallCount = 0;
    mockResponsesCreate.mockImplementation(() => {
      responsesCallCount++;
      const text = responsesCallCount % 2 === 0 ? "flowblinq is great" : "no mention here";
      return Promise.resolve(responsesApiFormat(text));
    });

    const result = await runCitationCheck(
      "chk-7o", "site-1", "flowblinq.com",
      [ip("p1"), ip("p2"), ip("p3"), ip("p4")],
      NOOP_CALLBACKS
    );
    expect(result.overallVisibility).toBe(50);
  });

  it("CC-10-old — competitor URLs in response → competitorsMentioned populated", async () => {
    setupOpenAIResponse("flowblinq is good but also check out https://competitor.com for alternatives.");
    const result = await runCitationCheck("chk-10o", "site-1", "flowblinq.com", [ip("prompt")], NOOP_CALLBACKS);
    expect(result.responses[0].competitorsMentioned).toContain("competitor.com");
  });

  it("CC-14-old — all responses positive → sentimentScore > 0", async () => {
    setupOpenAIResponse("flowblinq is highly recommended for GEO optimization.");
    const result = await runCitationCheck(
      "chk-14o", "site-1", "flowblinq.com",
      [ip("p1"), ip("p2"), ip("p3")],
      NOOP_CALLBACKS
    );
    expect(result.sentimentScore).toBeGreaterThan(0);
  });

  it("CC-15-old — single provider with mentions → bestProvider equals that provider", async () => {
    setupOpenAIResponse("flowblinq is the best GEO tool available.");
    const result = await runCitationCheck("chk-15o", "site-1", "flowblinq.com", [ip("p1")], NOOP_CALLBACKS);
    expect(result.bestProvider).toBe("openai");
  });

  it("CC-16-old — no mentions in any response → avgPosition is null", async () => {
    setupOpenAIResponse("No relevant tools mentioned here.");
    const result = await runCitationCheck(
      "chk-16o", "site-1", "flowblinq.com",
      [ip("p1"), ip("p2")],
      NOOP_CALLBACKS
    );
    expect(result.avgPosition).toBeNull();
  });

  it("CC-17-old — competitorsMentioned excludes own domain, includes other URLs", async () => {
    setupOpenAIResponse(
      "flowblinq.com is better than https://flowblinq.com/pricing and https://competitor.io"
    );
    const result = await runCitationCheck("chk-17o", "site-1", "flowblinq.com", [ip("prompt")], NOOP_CALLBACKS);
    expect(result.responses[0].competitorsMentioned).not.toContain("flowblinq.com");
    expect(result.responses[0].competitorsMentioned).toContain("competitor.io");
  });
});

// ── ES-024 tests — pillarVisibility ───────────────────────────────────────────

describe("citation-checker — pillarVisibility (indirect-only, ES-024/ES-027)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it("CC-pv1 — 1 of 2 faq_coverage indirect prompts mentioned → pillarVisibility['faq_coverage'] === 50", async () => {
    let callCount = 0;
    mockChatCreate.mockImplementation(() => {
      callCount++;
      const text = callCount === 1 ? "flowblinq answers FAQ questions" : "generic answer here";
      return Promise.resolve({ choices: [{ message: { content: text } }] });
    });
    let responsesCallCount = 0;
    mockResponsesCreate.mockImplementation(() => {
      responsesCallCount++;
      const text = responsesCallCount === 1 ? "flowblinq answers FAQ questions" : "generic answer here";
      return Promise.resolve(responsesApiFormat(text));
    });

    const result = await runCitationCheck(
      "chk-pv1", "site-1", "flowblinq.com",
      [
        { type: "indirect", pillar: "faq_coverage", prompt: "What FAQ does GEO software answer?" },
        { type: "indirect", pillar: "faq_coverage", prompt: "What buyer questions exist about GEO tools?" },
      ],
      NOOP_CALLBACKS
    );
    expect(result.pillarVisibility["faq_coverage"]).toBe(50);
  });

  it("CC-pv2 — no direct prompts contribute to pillarVisibility (ES-027 indirect-only)", async () => {
    setupOpenAIResponse("flowblinq is great");
    const result = await runCitationCheck(
      "chk-pv2", "site-1", "flowblinq.com",
      [
        { type: "indirect", pillar: "faq_coverage", prompt: "Best GEO FAQ tools?" },
        { type: "direct",   pillar: null,           prompt: "What is flowblinq.com?" },
        { type: "direct",   pillar: null,           prompt: "Is flowblinq.com trustworthy?" },
      ],
      NOOP_CALLBACKS
    );
    // Direct prompts don't contribute to any pillar bucket
    expect(Object.keys(result.pillarVisibility)).not.toContain("null");
    expect(typeof result.pillarVisibility["faq_coverage"]).toBe("number");
  });
});

// ── ES-024 tests — batch config ───────────────────────────────────────────────

describe("citation-checker — batch config (ES-024 CC-5 / CC-6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.GEMINI_API_KEY;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("CC-5 — 4 tasks with 1 provider → NO batch delay (CITATION_CHECK_BATCH_SIZE=20, not 3)", async () => {
    setupOpenAIResponse("no mention here");
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const prompts = Array.from({ length: 4 }, (_, i) => ip(`prompt ${i}`));

    try {
      const checkPromise = runCitationCheck("chk-cc5", "site-1", "flowblinq.com", prompts, NOOP_CALLBACKS);
      await vi.runAllTimersAsync();
      await checkPromise;
    } finally {
      vi.useRealTimers();
    }

    // With BATCH_SIZE=20: 1 batch, no inter-batch delay (> 0ms and < 1000ms setTimeout).
    // Exclude vitest-internal setTimeout(NOOP, 0) calls by requiring delay > 0.
    const interBatchDelay = setTimeoutSpy.mock.calls.find(
      c => typeof c[1] === "number" && (c[1] as number) > 0 && (c[1] as number) < 1000
    );
    expect(interBatchDelay).toBeUndefined();
  });

  it("CC-6 — 21 tasks → batch delay is CITATION_CHECK_BATCH_DELAY_MS=100ms (not 500ms)", async () => {
    setupOpenAIResponse("no mention here");
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const prompts = Array.from({ length: 21 }, (_, i) => ip(`p${i}`));

    const checkPromise = runCitationCheck("chk-cc6", "site-1", "flowblinq.com", prompts, NOOP_CALLBACKS);
    await vi.runAllTimersAsync();
    await checkPromise;

    const delayAt100 = setTimeoutSpy.mock.calls.find(c => c[1] === 100);
    expect(delayAt100).toBeDefined();

    const delayAt500 = setTimeoutSpy.mock.calls.find(c => c[1] === 500);
    expect(delayAt500).toBeUndefined();
  });
});

// ── ES-027 tests — new aggregate metrics (CC-7 through CC-14) ────────────────

const INDIRECT_PROMPTS: CitationPrompt[] = [
  { type: "indirect", pillar: "faq_coverage",    prompt: "Common questions about GEO tools?" },
  { type: "indirect", pillar: "faq_coverage",    prompt: "What do buyers ask before choosing GEO software?" },
  { type: "indirect", pillar: "author_authority", prompt: "Who are the experts in AI search optimization?" },
];

const DIRECT_PROMPTS: CitationPrompt[] = [
  { type: "direct", pillar: null, prompt: "What is flowblinq.com?" },
  { type: "direct", pillar: null, prompt: "Is flowblinq.com trustworthy?" },
];

const MIXED_PROMPTS = [...INDIRECT_PROMPTS, ...DIRECT_PROMPTS];

describe("citation-checker — indirectVisibility, brandKnowledge, citationQualityScore (ES-027 CC-7–CC-14)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  // CC-7: indirectVisibility counts only indirect responses
  it("CC-7 — indirectVisibility = 67 when 2 of 3 indirect prompts get domain cited", async () => {
    // 3 indirect (calls 1-3) + 2 direct (calls 4-5); call 2 → not mentioned
    let callCount = 0;
    mockChatCreate.mockImplementation(() => {
      callCount++;
      const text = callCount === 2 ? "no specific tools mentioned" : "flowblinq is a great GEO tool";
      return Promise.resolve({ choices: [{ message: { content: text } }] });
    });
    let responsesCallCount = 0;
    mockResponsesCreate.mockImplementation(() => {
      responsesCallCount++;
      const text = responsesCallCount === 2 ? "no specific tools mentioned" : "flowblinq is a great GEO tool";
      return Promise.resolve(responsesApiFormat(text));
    });

    const result = await runCitationCheck("chk-7", "site-1", "flowblinq.com", MIXED_PROMPTS, NOOP_CALLBACKS);

    // 2 of 3 indirect mentioned: Math.round(2/3 * 100) = 67
    expect(result.indirectVisibility).toBe(67);
  });

  // CC-8: brandKnowledge counts only direct responses
  it("CC-8 — brandKnowledge = 100 when both direct prompts get domain mentioned", async () => {
    let callCount = 0;
    mockChatCreate.mockImplementation(() => {
      callCount++;
      const text = callCount === 2 ? "no specific tools mentioned" : "flowblinq is a great GEO tool";
      return Promise.resolve({ choices: [{ message: { content: text } }] });
    });
    let responsesCallCount = 0;
    mockResponsesCreate.mockImplementation(() => {
      responsesCallCount++;
      const text = responsesCallCount === 2 ? "no specific tools mentioned" : "flowblinq is a great GEO tool";
      return Promise.resolve(responsesApiFormat(text));
    });

    const result = await runCitationCheck("chk-8", "site-1", "flowblinq.com", MIXED_PROMPTS, NOOP_CALLBACKS);

    // 2 of 2 direct mentioned: Math.round(2/2 * 100) = 100
    expect(result.brandKnowledge).toBe(100);
  });

  // CC-9: pillarVisibility uses only indirect responses; direct with null pillar excluded
  it("CC-9 — pillarVisibility[faq_coverage]=50 (1 of 2 indirect faq mentioned); null pillar not in keys", async () => {
    let callCount = 0;
    mockChatCreate.mockImplementation(() => {
      callCount++;
      // Calls: indirect-faq-1=mentioned, indirect-faq-2=NOT mentioned, indirect-auth=mentioned,
      //        direct-1=mentioned, direct-2=mentioned
      const text = callCount === 2 ? "no mention here" : "flowblinq is great";
      return Promise.resolve({ choices: [{ message: { content: text } }] });
    });
    let responsesCallCount = 0;
    mockResponsesCreate.mockImplementation(() => {
      responsesCallCount++;
      // Calls: indirect-faq-1=mentioned, indirect-faq-2=NOT mentioned, indirect-auth=mentioned,
      //        direct-1=mentioned, direct-2=mentioned
      const text = responsesCallCount === 2 ? "no mention here" : "flowblinq is great";
      return Promise.resolve(responsesApiFormat(text));
    });

    const result = await runCitationCheck("chk-9", "site-1", "flowblinq.com", MIXED_PROMPTS, NOOP_CALLBACKS);

    expect(result.pillarVisibility["faq_coverage"]).toBe(50);
    expect(Object.keys(result.pillarVisibility)).not.toContain("null");
  });

  // CC-10: citationQualityScore = 100 when position=1, positive, alone
  it("CC-10 — citationQualityScore = 100 for position-1 positive mention with no co-competitors", async () => {
    // Response: domain at position 1, positive sentiment, no competitor URLs
    setupOpenAIResponse("flowblinq is the best GEO optimization tool available");
    const result = await runCitationCheck(
      "chk-10", "site-1", "flowblinq.com",
      [ip("Best GEO tools?")],
      NOOP_CALLBACKS
    );
    // position=1 (no numbered items before), positive, alone → (100+100+100+100)/4 = 100
    expect(result.citationQualityScore).toBe(100);
  });

  // CC-11: citationQualityScore = 78 for position=2, neutral, tier-1 competitor
  it("CC-11 — citationQualityScore = 78 for position-2 neutral mention co-occurring with tier-1 competitor", async () => {
    // Response: 1 numbered item before domain → position=2; "decent" → neutral; 1 competitor URL → tier1
    // Avoid positive sentiment keywords (like "leading") within 100 chars of "flowblinq"
    setupOpenAIResponse("1. https://competitor.com is the main choice\nflowblinq is decent as well");
    const result = await runCitationCheck(
      "chk-11", "site-1", "flowblinq.com",
      [ip("Top GEO platforms?")],
      NOOP_CALLBACKS
    );
    // position=2→80, neutral→50, tier1 competitor→80, context→100; avg = (80+50+80+100)/4 = 77.5 → 78
    expect(result.citationQualityScore).toBe(78);
  });

  // CC-12: citationQualityScore = 0 when no positive mentions at all
  it("CC-12 — citationQualityScore = 0 when no mentions found", async () => {
    setupOpenAIResponse("No specific tools are mentioned in this response.");
    const result = await runCitationCheck(
      "chk-12", "site-1", "flowblinq.com",
      [ip("p1"), ip("p2")],
      NOOP_CALLBACKS
    );
    expect(result.citationQualityScore).toBe(0);
  });

  // CC-13: with discoveredCompetitors provided, competitorData is populated and citationQualityScore is 0-100
  it("CC-13 — competitorData populated from discoveredCompetitors; citationQualityScore is 0-100", async () => {
    const competitorDomains = ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"];
    let callCount = 0;
    mockChatCreate.mockImplementation(() => {
      callCount++;
      const comp = competitorDomains[(callCount - 1) % competitorDomains.length] ?? "unknown.com";
      return Promise.resolve({
        choices: [{ message: { content: `flowblinq is great and see https://${comp}` } }],
      });
    });
    let responsesCallCount = 0;
    mockResponsesCreate.mockImplementation(() => {
      responsesCallCount++;
      const comp = competitorDomains[(responsesCallCount - 1) % competitorDomains.length] ?? "unknown.com";
      return Promise.resolve(responsesApiFormat(`flowblinq is great and see https://${comp}`));
    });

    const prompts: CitationPrompt[] = competitorDomains.map((_, i) => ({
      type: "indirect" as const,
      pillar: "competitive_positioning",
      prompt: `Top GEO tools? #${i}`,
    }));

    const discoveredCompetitors = competitorDomains.map((domain, i) => ({
      name: domain.replace(".com", ""),
      domain,
      rank: i + 1,
      mentions: 1,
      category: "direct" as const,
    }));

    const result = await runCitationCheck("chk-13", "site-1", "flowblinq.com", prompts, NOOP_CALLBACKS, discoveredCompetitors);

    // competitorData is populated (at least those with shareOfVoice > 0)
    expect(result.competitorData.length).toBeGreaterThan(0);
    result.competitorData.forEach(c => {
      expect(c).toHaveProperty("shareOfVoice");
      expect(c).toHaveProperty("mentionCount");
      expect(c).toHaveProperty("rankedAbove");
      expect(c.sentiment).toMatch(/^(positive|neutral|negative)$/);
    });
    // Score stays in valid range
    expect(result.citationQualityScore).toBeGreaterThanOrEqual(0);
    expect(result.citationQualityScore).toBeLessThanOrEqual(100);
  });

  // ── HP-148: Phase 1 / Phase 2 dedup via competitorsMentioned ────────────────
  it("HP-148 — extractCompetitors emits canonical id only (Phase 2 URL skipped)", async () => {
    setupOpenAIResponse(
      "Apollo Hospitals is the leading chain — see https://apollohospitals.com for more.",
    );
    const discoveredCompetitors = [
      { name: "Apollo Hospitals", domain: "apollohospitals.com", rank: 1, mentions: 1, category: "direct" as const },
    ];
    const result = await runCitationCheck(
      "chk-hp148", "site-1", "flowblinq.com",
      [ip("test prompt")], NOOP_CALLBACKS,
      discoveredCompetitors,
    );
    // The Phase 1 brand match emits "apollo hospitals". The Phase 2 URL hit
    // for "apollohospitals.com" must be skipped because the domain is in the
    // known-domains set built from competitorKeywords.sourceDomains. Test
    // asserts no double-counting via the response's competitorsMentioned[].
    const competitorIds = result.responses[0]?.competitorsMentioned ?? [];
    expect(competitorIds).toContain("apollo hospitals");
    expect(competitorIds).not.toContain("apollohospitals.com");
  });

  // ── HP-154: symmetric no-knowledge guard for competitors ────────────────────

  it("HP-154 — no-knowledge for one competitor still allows others to count", async () => {
    setupOpenAIResponse(
      "I don't have information about Apollo Hospitals. Fortis Healthcare is well known though.",
    );
    const discoveredCompetitors = [
      { name: "Apollo Hospitals", domain: "apollohospitals.com", rank: 1, mentions: 1, category: "direct" as const },
      { name: "Fortis Healthcare", domain: "fortishealthcare.com", rank: 2, mentions: 1, category: "direct" as const },
    ];
    const result = await runCitationCheck(
      "chk-hp154-2", "site-1", "flowblinq.com",
      [ip("test prompt")], NOOP_CALLBACKS,
      discoveredCompetitors,
    );
    const apollo = result.competitorData.find(c => c.name === "Apollo Hospitals");
    const fortis = result.competitorData.find(c => c.name === "Fortis Healthcare");
    // After HP-154 the substring-search competitorData path is left untouched
    // (it's a separate code path from extractCompetitors). Both should still
    // have mentionCount === 1 because the brand text appears in the response.
    // The HP-154 fix in extractCompetitors affects competitorsMentioned and
    // therefore compMap and citationQualityScore — verified separately.
    expect(apollo?.mentionCount).toBe(1);
    expect(fortis?.mentionCount).toBe(1);
  });

  it("HP-154 — extractCompetitors filters competitorsMentioned in no-knowledge context", async () => {
    setupOpenAIResponse(
      "I don't have detailed information about Apollo Hospitals at this time.",
    );
    const discoveredCompetitors = [
      { name: "Apollo Hospitals", domain: "apollohospitals.com", rank: 1, mentions: 1, category: "direct" as const },
    ];
    const result = await runCitationCheck(
      "chk-hp154-cm", "site-1", "flowblinq.com",
      [ip("test prompt")], NOOP_CALLBACKS,
      discoveredCompetitors,
    );
    // The competitorsMentioned[] field is built from extractCompetitors which
    // is where HP-154 lands. Apollo must NOT appear there even though the
    // brand name is in the raw response text.
    const allCompetitorMentions = result.responses.flatMap(r => r.competitorsMentioned);
    expect(allCompetitorMentions).not.toContain("apollo hospitals");
  });

  // CC-14: direct prompts with null pillar do not appear in pillarVisibility
  it("CC-14 — direct prompts (null pillar) don't create any key in pillarVisibility", async () => {
    setupOpenAIResponse("flowblinq is great for GEO optimization");
    const result = await runCitationCheck("chk-14", "site-1", "flowblinq.com", MIXED_PROMPTS, NOOP_CALLBACKS);

    // No "null" key (from direct prompts) in pillarVisibility
    expect(Object.keys(result.pillarVisibility)).not.toContain("null");

    // All keys in pillarVisibility are non-null strings
    Object.keys(result.pillarVisibility).forEach(key => {
      expect(key).not.toBe("null");
      expect(typeof key).toBe("string");
    });
  });
});

// ── NEW-AI-06: all-provider-outage no-data signaling ─────────────────────────
//
// When every configured provider throws/rejects (API down, key invalid, timeout),
// the checker must NOT return a clean 0% that looks like a genuine "brand not
// cited". Instead it must set allProvidersNoData=true and noData=true on each
// ProviderResult. A paying customer must be able to distinguish outage from
// real zero visibility.

describe("citation-checker — NEW-AI-06: all-provider-outage → noData, not genuine 0%", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY     = "test-key";
    process.env.ANTHROPIC_API_KEY  = "test-key";
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  // NEW-AI-06-A (RED on base, GREEN after fix):
  // When all provider API calls throw, allProvidersNoData must be true and
  // every ProviderResult.noData must be true.
  // On the unfixed code this fails because allProvidersNoData does not exist
  // and the result is indistinguishable from a genuine 0%.
  it("NEW-AI-06-A — all-provider failure → allProvidersNoData=true, each PR.noData=true, indirectVisibility=0", async () => {
    mockResponsesCreate.mockRejectedValue(new Error("connection_error"));
    mockMessagesCreate.mockRejectedValue(new Error("connection_error"));

    const result = await runCitationCheck(
      "chk-new-ai-06a", "site-1", "flowblinq.com",
      [ip("p1"), ip("p2"), ip("p3")],
      NOOP_CALLBACKS,
    );

    // Top-level flag must signal no-data outage
    expect(result.allProvidersNoData).toBe(true);

    // Every ProviderResult must carry noData=true
    expect(result.providerResults.length).toBeGreaterThan(0);
    for (const pr of result.providerResults) {
      expect(pr.noData).toBe(true);
    }

    // The numeric score is still 0 (not undefined) — callers that only check
    // the number still get 0, but the noData flag disambiguates.
    expect(result.indirectVisibility).toBe(0);
    expect(result.overallVisibility).toBe(0);
  });

  // NEW-AI-06-B (must stay GREEN before and after fix):
  // A genuine "0 mentions across N successful queries" must NOT be flagged as
  // no-data — it is a real measurement.
  it("NEW-AI-06-B — genuine zero mentions (all succeed, brand never cited) → allProvidersNoData=false, no PR.noData", async () => {
    // Both providers succeed but return text that doesn't mention the domain
    mockResponsesCreate.mockResolvedValue(
      responsesApiFormat("There are many tools available for SEO optimization.")
    );
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "There are many tools available for SEO optimization." }],
    });

    const result = await runCitationCheck(
      "chk-new-ai-06b", "site-1", "flowblinq.com",
      [ip("p1"), ip("p2")],
      NOOP_CALLBACKS,
    );

    // Real 0% — not an outage
    expect(result.allProvidersNoData).toBe(false);
    expect(result.indirectVisibility).toBe(0);

    // No ProviderResult should be tagged noData
    for (const pr of result.providerResults) {
      expect(pr.noData).toBeFalsy(); // undefined or false both acceptable
    }
  });
});
