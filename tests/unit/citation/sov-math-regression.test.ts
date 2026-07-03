/**
 * HP-253 regression: overallVisibility === indirectVisibility canonical equality.
 *
 * The pre-fix code computed `overallVisibility` and `indirectVisibility`
 * separately (citation-checker.ts old L463-467 vs L490-498) over the SAME
 * filtered set (allResponses.filter(r => r.promptType === "indirect")).
 * Both Layer-2-rebuild and the static audit confirmed y === M for every input.
 *
 * Post-fix, overallVisibility is returned as an alias of indirectVisibility.
 * This regression asserts they remain identical across the three canonical
 * input shapes: all-indirect, mixed, and all-direct.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CitationPrompt } from "@/lib/services/citation-prompt-generator";

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

import { runCitationCheck, type CitationCheckerCallbacks } from "@/lib/services/citation-checker";

const NOOP_CALLBACKS: CitationCheckerCallbacks = {
  onAnalysisStart:    vi.fn(),
  onPartialResult:    vi.fn(),
  onAnalysisComplete: vi.fn(),
};

const indirectPrompt = (prompt: string, pillar: string | null = "faq_coverage"): CitationPrompt => ({
  type: "indirect", pillar, prompt,
});
const directPrompt = (prompt: string): CitationPrompt => ({ type: "direct", pillar: null, prompt });

function responsesApiFormat(text: string) {
  return { output: [{ type: "message", content: [{ type: "output_text", text }] }] };
}

describe("HP-253 — overallVisibility === indirectVisibility canonical equality", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it("SOV-1 — all-indirect set, 2 of 4 mention brand → overallVisibility === indirectVisibility === 50", async () => {
    let n = 0;
    mockResponsesCreate.mockImplementation(() => {
      n++;
      return Promise.resolve(responsesApiFormat(n % 2 === 0 ? "flowblinq is great" : "no mention here"));
    });
    const result = await runCitationCheck(
      "chk-sov1", "site-1", "flowblinq.com",
      [indirectPrompt("p1"), indirectPrompt("p2"), indirectPrompt("p3"), indirectPrompt("p4")],
      NOOP_CALLBACKS,
    );
    expect(result.overallVisibility).toBe(result.indirectVisibility);
    expect(result.overallVisibility).toBe(50);
  });

  it("SOV-2 — mixed indirect+direct, only indirect counts toward both fields", async () => {
    let n = 0;
    mockResponsesCreate.mockImplementation(() => {
      n++;
      // All responses mention. 3 indirect + 2 direct. Both fields measure
      // indirect-only: 3/3 = 100. If overallVisibility regressed back to
      // all-queries denominator it would be 5/5 = 100 anyway — so make 1 of
      // 3 indirect a no-mention to force a divergence if regressed.
      const indirectIndex = n; // 1..3 are indirect, 4..5 are direct (in our prompt order)
      if (indirectIndex <= 3) {
        return Promise.resolve(responsesApiFormat(indirectIndex === 1 ? "no mention" : "flowblinq is great"));
      }
      return Promise.resolve(responsesApiFormat("flowblinq mentioned"));
    });
    const result = await runCitationCheck(
      "chk-sov2", "site-1", "flowblinq.com",
      [
        indirectPrompt("p1"),
        indirectPrompt("p2"),
        indirectPrompt("p3"),
        directPrompt("brand-prompt-1"),
        directPrompt("brand-prompt-2"),
      ],
      NOOP_CALLBACKS,
    );
    // Both fields must equal: 2 mentions / 3 indirect = 67%.
    // If overallVisibility regressed back to all-queries denominator it
    // would compute 4/5 = 80% — divergence assertion would fail.
    expect(result.overallVisibility).toBe(result.indirectVisibility);
  });

  it("SOV-3 — all-direct set, no indirect queries → both fields default to 0% (max(0,1) guard avoids div-by-zero)", async () => {
    mockResponsesCreate.mockResolvedValue(responsesApiFormat("flowblinq mentioned"));
    const result = await runCitationCheck(
      "chk-sov3", "site-1", "flowblinq.com",
      [directPrompt("brand-prompt-1"), directPrompt("brand-prompt-2")],
      NOOP_CALLBACKS,
    );
    // No indirect responses → both fields are 0/max(0,1) = 0%.
    expect(result.overallVisibility).toBe(result.indirectVisibility);
    expect(result.overallVisibility).toBe(0);
    // brandKnowledge measures direct-only mentions: 2/2 = 100%.
    expect(result.brandKnowledge).toBe(100);
  });
});
