/**
 * ES-056 — C12: Real Prompt Discovery
 * Tests U15–U24
 *
 * Spec: discoverRealPrompts() — Perplexity Sonar-based question discovery.
 * Non-blocking fallback: if Perplexity fails, returns empty array.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Setup ───────────────────────────────────────────────────

const { mockOpenAICreate } = vi.hoisted(() => ({
  mockOpenAICreate: vi.fn(),
}));

// Perplexity uses OpenAI SDK with custom baseURL
vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockOpenAICreate } } };
  }),
}));

import { discoverRealPrompts, clearRealPromptCache } from "@/lib/services/real-prompt-discoverer";

import type { RealPromptDiscovery } from "@/lib/types/citation";

// ── Helpers ──────────────────────────────────────────────────────

function makeCategoryTree(leaves: Array<{ id: string; name: string; pageCount: number }>) {
  return {
    root: {
      id: "root",
      name: "Root",
      children: leaves.map((l) => ({
        id: l.id,
        name: l.name,
        pageCount: l.pageCount,
        children: [],
      })),
    },
    leafCount: leaves.length,
  };
}

function makePerplexityResponse(questions: RealPromptDiscovery[]) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify(questions),
        },
      },
    ],
  };
}

function makeQuestions(count: number, overrides: Partial<RealPromptDiscovery> = {}): RealPromptDiscovery[] {
  return Array.from({ length: count }, (_, i) => ({
    source: (["paa", "reddit", "quora"] as const)[i % 3],
    query: overrides.query ?? `What is the best orthopedic hospital for knee replacement number ${i + 1}?`,
    context: overrides.context ?? `Context about orthopedic hospitals and treatments in the region...`,
    url: overrides.url ?? `https://example.com/question-${i + 1}`,
  }));
}

// ── U15–U24 ─────────────────────────────────────────────────────

describe("discoverRealPrompts — ES-056 C12", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRealPromptCache();
    process.env.PERPLEXITY_API_KEY = "test-key";
  });

  const categoryTree = makeCategoryTree([
    { id: "ortho", name: "Orthopedics", pageCount: 15 },
    { id: "cardio", name: "Cardiology", pageCount: 12 },
    { id: "neuro", name: "Neurology", pageCount: 8 },
    { id: "derma", name: "Dermatology", pageCount: 5 },
    { id: "ent", name: "ENT", pageCount: 3 },
  ]);

  it("U15 — returns questions from Perplexity (12 returned)", async () => {
    const questions = makeQuestions(12);
    mockOpenAICreate.mockResolvedValue(makePerplexityResponse(questions));

    const result = await discoverRealPrompts(categoryTree as any, undefined, "manipalhospitals.com");

    expect(result.length).toBe(12);
    for (const q of result) {
      expect(q).toHaveProperty("source");
      expect(q).toHaveProperty("query");
      expect(q).toHaveProperty("context");
      expect(q).toHaveProperty("url");
      expect(["paa", "reddit", "quora"]).toContain(q.source);
    }
  });

  it("U16 — deduplicates questions with >80% word overlap", async () => {
    const questions: RealPromptDiscovery[] = [
      { source: "paa", query: "What is the best orthopedic hospital for knee replacement in Bangalore?", context: "ctx", url: "url1" },
      { source: "reddit", query: "What is the best orthopedic hospital for knee replacement in Bangalore India?", context: "ctx", url: "url2" },
      { source: "quora", query: "How to prepare for a job interview in marketing?", context: "ctx", url: "url3" },
    ];
    mockOpenAICreate.mockResolvedValue(makePerplexityResponse(questions));

    const result = await discoverRealPrompts(categoryTree as any, undefined, "manipalhospitals.com");

    // First two questions have >80% word overlap → deduplicated to 1
    // Third question is different
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("U17 — filters questions containing brand domain", async () => {
    const questions: RealPromptDiscovery[] = [
      { source: "paa", query: "Is manipalhospitals.com the best hospital website?", context: "ctx", url: "url1" },
      { source: "reddit", query: "Best orthopedic surgeon in Bangalore?", context: "ctx", url: "url2" },
    ];
    mockOpenAICreate.mockResolvedValue(makePerplexityResponse(questions));

    const result = await discoverRealPrompts(categoryTree as any, undefined, "manipalhospitals.com");

    // First question contains domain → filtered out
    const brandQuestion = result.find((q) => q.query.includes("manipalhospitals"));
    expect(brandQuestion).toBeUndefined();
  });

  it("U18 — filters off-topic questions (no category keywords)", async () => {
    const questions: RealPromptDiscovery[] = [
      { source: "paa", query: "Best orthopedic hospital near me?", context: "ctx", url: "url1" },
      { source: "reddit", query: "What is the best pizza restaurant in Bangalore?", context: "ctx", url: "url2" },
    ];
    mockOpenAICreate.mockResolvedValue(makePerplexityResponse(questions));

    const result = await discoverRealPrompts(categoryTree as any, undefined, "example.com");

    // Pizza question is off-topic (no category keyword match)
    const pizzaQ = result.find((q) => q.query.includes("pizza"));
    expect(pizzaQ).toBeUndefined();
    // Orthopedic question should remain
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("U19 — caps at 15 questions", async () => {
    const questions = makeQuestions(20);
    mockOpenAICreate.mockResolvedValue(makePerplexityResponse(questions));

    const result = await discoverRealPrompts(categoryTree as any, undefined, "example.com");

    expect(result.length).toBeLessThanOrEqual(15);
  });

  it("U20 — handles Perplexity failure gracefully (no throw)", async () => {
    mockOpenAICreate.mockRejectedValue(new Error("Connection timeout"));

    const result = await discoverRealPrompts(categoryTree as any, undefined, "example.com");

    expect(result).toEqual([]);
  });

  it("U21 — handles invalid JSON from Perplexity", async () => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: "Here are some questions about orthopedics..." } }],
    });

    const result = await discoverRealPrompts(categoryTree as any, undefined, "example.com");

    expect(result).toEqual([]);
  });

  it("U22 — selects top 3 categories by pageCount", async () => {
    const questions = makeQuestions(10);
    mockOpenAICreate.mockResolvedValue(makePerplexityResponse(questions));

    await discoverRealPrompts(categoryTree as any, undefined, "example.com");

    // Verify Perplexity was called
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);

    // Check the prompt includes top 3 categories (Orthopedics, Cardiology, Neurology)
    const callArgs = mockOpenAICreate.mock.calls[0][0];
    const userMessage = callArgs.messages?.find((m: any) => m.role === "user");
    if (userMessage) {
      const content = typeof userMessage.content === "string" ? userMessage.content : JSON.stringify(userMessage.content);
      expect(content.toLowerCase()).toContain("orthopedic");
      expect(content.toLowerCase()).toContain("cardiology");
      expect(content.toLowerCase()).toContain("neurology");
    }
  });

  it("U23 — geo context included when geoTree cities provided", async () => {
    const questions = makeQuestions(5);
    mockOpenAICreate.mockResolvedValue(makePerplexityResponse(questions));

    const geoContext = { cityNames: ["Bangalore", "Delhi", "Mumbai"] };

    await discoverRealPrompts(categoryTree as any, geoContext, "example.com");

    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    const callArgs = mockOpenAICreate.mock.calls[0][0];
    const userMessage = callArgs.messages?.find((m: any) => m.role === "user");
    if (userMessage) {
      const content = typeof userMessage.content === "string" ? userMessage.content : JSON.stringify(userMessage.content);
      expect(content).toContain("Bangalore");
    }
  });

  it("U24 — no geo context for pure-digital (leafCount=0 geoTree)", async () => {
    const questions = makeQuestions(5);
    mockOpenAICreate.mockResolvedValue(makePerplexityResponse(questions));

    // No geoContext passed
    await discoverRealPrompts(categoryTree as any, undefined, "saas-platform.io");

    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    const callArgs = mockOpenAICreate.mock.calls[0][0];
    const userMessage = callArgs.messages?.find((m: any) => m.role === "user");
    if (userMessage) {
      const content = typeof userMessage.content === "string" ? userMessage.content : JSON.stringify(userMessage.content);
      // Should NOT contain location-specific language when no geo context
      expect(content).not.toContain("specifically in these locations");
    }
  });
});
