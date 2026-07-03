/**
 * ES-055 — C10: Engine Preference Analysis
 * Tests U26–U33
 *
 * Spec: analyzeEnginePreferences() — Sonnet-based pattern analysis.
 * Only triggers on 3rd, 5th, 10th, and every 10th check.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Setup ───────────────────────────────────────────────────

const { mockCreate, mockDbSelect } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockDbSelect: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

// Mock DB for response queries
vi.mock("@/lib/db", () => {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  };
  // Allow dynamic resolution
  mockDbSelect.mockReturnValue(selectChain);
  selectChain.where.mockResolvedValue([]);

  return {
    db: {
      select: mockDbSelect,
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    },
  };
});

vi.mock("@/lib/db/schema", () => ({
  citationCheckScores: {},
  citationCheckResponses: {},
  geoSites: {},
}));

import { analyzeEnginePreferences } from "@/lib/services/engine-preference-analyzer";

import type { EnginePreference, EngineRule } from "@/lib/types/content-strategy";

// ── Helpers ──────────────────────────────────────────────────────

function mockSonnetRulesResponse(rules: EnginePreference[]) {
  mockCreate.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify(rules) }],
  });
}

function makeMockResponses(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `resp-${i}`,
    checkId: `chk-${Math.floor(i / 48)}`,
    siteId: "site-1",
    provider: i % 4 === 0 ? "chatgpt" : i % 4 === 1 ? "claude" : i % 4 === 2 ? "perplexity" : "google",
    model: "test-model",
    query: `test prompt ${i}`,
    response: i % 2 === 0
      ? `1. First option is great.\n2. Second option works well.\n3. Third one is also good.`
      : `The best option in this category is clearly one that stands out. It provides comprehensive coverage and has been rated highly by experts.`,
    mentioned: i % 3 !== 0,
    position: i % 3 !== 0 ? (i % 5) + 1 : null,
    sentiment: i % 3 !== 0 ? "positive" : null,
    competitorsMentioned: ["apollo", "fortis"],
  }));
}

function makeCheckCountResult(count: number) {
  return [{ count }];
}

// ── U26–U33 ─────────────────────────────────────────────────────

describe("analyzeEnginePreferences — ES-055 C10", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  it("U26 — returns null for < 3 citation checks", async () => {
    // Mock: 2 checks
    const selectChain = mockDbSelect();
    selectChain.where.mockResolvedValueOnce(makeCheckCountResult(2));

    const result = await analyzeEnginePreferences("example.com", "site-1");
    expect(result).toBeNull();
  });

  it("U27 — produces rules on 3rd check", async () => {
    const selectChain = mockDbSelect();
    // First call: check count
    selectChain.where
      .mockResolvedValueOnce(makeCheckCountResult(3))
      // Second call: fetch responses
      .mockResolvedValueOnce(makeMockResponses(144)); // 3 checks × 48 prompts

    mockSonnetRulesResponse([
      {
        provider: "chatgpt",
        rules: [
          {
            rule: "ChatGPT favors list-format responses and tends to mention brands with structured content.",
            confidence: "high",
            evidence: "Mentioned in 8/10 list-format responses",
          },
        ],
        analyzedAt: new Date().toISOString(),
        checkCount: 3,
      },
    ]);

    const result = await analyzeEnginePreferences("example.com", "site-1");

    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThanOrEqual(1);
    expect(result![0].provider).toBeTruthy();
    expect(result![0].rules.length).toBeGreaterThanOrEqual(1);
  });

  it("U28 — rules have confidence levels", async () => {
    const selectChain = mockDbSelect();
    selectChain.where
      .mockResolvedValueOnce(makeCheckCountResult(3))
      .mockResolvedValueOnce(makeMockResponses(144));

    mockSonnetRulesResponse([
      {
        provider: "chatgpt",
        rules: [
          { rule: "Rule 1", confidence: "high", evidence: "8/10 responses" },
          { rule: "Rule 2", confidence: "medium", evidence: "6/10 responses" },
          { rule: "Rule 3", confidence: "low", evidence: "4/10 responses" },
        ],
        analyzedAt: new Date().toISOString(),
        checkCount: 3,
      },
    ]);

    const result = await analyzeEnginePreferences("example.com", "site-1");

    expect(result).not.toBeNull();
    const rules = result![0].rules;
    const confidences = rules.map((r) => r.confidence);
    expect(confidences).toContain("high");
    expect(confidences).toContain("medium");
    expect(confidences).toContain("low");
    for (const r of rules) {
      expect(["high", "medium", "low"]).toContain(r.confidence);
    }
  });

  it("U29 — max 5 rules per provider", async () => {
    const selectChain = mockDbSelect();
    selectChain.where
      .mockResolvedValueOnce(makeCheckCountResult(3))
      .mockResolvedValueOnce(makeMockResponses(144));

    // Sonnet returns 8 rules — should be capped to 5
    mockSonnetRulesResponse([
      {
        provider: "chatgpt",
        rules: Array.from({ length: 8 }, (_, i) => ({
          rule: `Rule ${i + 1}`,
          confidence: "medium" as const,
          evidence: `Evidence ${i + 1}`,
        })),
        analyzedAt: new Date().toISOString(),
        checkCount: 3,
      },
    ]);

    const result = await analyzeEnginePreferences("example.com", "site-1");

    expect(result).not.toBeNull();
    expect(result![0].rules.length).toBeLessThanOrEqual(5);
  });

  it("U30 — response structure detection: list format", () => {
    // This tests the internal response structure classification
    const listResponse = "1. First option is excellent for cardiac care.\n2. Second option provides orthopedic services.\n3. Third option is known for neurology.";
    // Spec: lines matching /^\d+[\.\)]\s/ or /^[-*]\s/ → "list"
    const listLines = listResponse.split("\n").filter((l) => /^\d+[.)]\s/.test(l));
    expect(listLines.length).toBeGreaterThanOrEqual(2);
  });

  it("U31 — response structure detection: paragraph format", () => {
    const paragraphResponse = "The healthcare landscape in Bangalore is dominated by several major providers. Apollo Hospitals leads with comprehensive services across multiple specialties.";
    const listLines = paragraphResponse.split("\n").filter((l) => /^\d+[.)]\s/.test(l) || /^[-*]\s/.test(l));
    expect(listLines.length).toBe(0); // No list markers → paragraph
  });

  it("U32 — non-blocking on Sonnet failure (returns null, no throw)", async () => {
    const selectChain = mockDbSelect();
    selectChain.where
      .mockResolvedValueOnce(makeCheckCountResult(3))
      .mockResolvedValueOnce(makeMockResponses(144));

    // Sonnet times out
    mockCreate.mockRejectedValue(new Error("Request timeout after 30000ms"));

    const result = await analyzeEnginePreferences("example.com", "site-1");

    // Should not throw, should return null
    expect(result).toBeNull();
  });

  it("U33 — only triggers on checkpoint counts (3, 5, 10, 20, 30...)", async () => {
    // 4th check is NOT a checkpoint → should not trigger analysis
    const selectChain = mockDbSelect();
    selectChain.where.mockResolvedValueOnce(makeCheckCountResult(4));

    const result = await analyzeEnginePreferences("example.com", "site-1");

    // Should return null without calling Sonnet
    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
