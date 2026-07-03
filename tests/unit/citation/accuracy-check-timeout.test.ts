/**
 * HP-256 regression: Haiku accuracy-check must not block on a stuck SDK call.
 *
 * The accuracy-check call inside runCitationCheck's direct-samples block
 * lacked a timeout wrapper. If the Anthropic SDK hung (network, rate-limit,
 * model loadshed), the entire citation-check route would block for the SDK
 * default (~10 min). Fix: Promise.race against TIMEOUT_MS (30s). On
 * timeout the catch branch logs a structured warning and leaves
 * accuracyLabel/accuracyNote as their initial nulls.
 *
 * This test pins the timeout behavior by mocking the Anthropic messages.create
 * to NEVER resolve, advancing fake timers past TIMEOUT_MS, and asserting the
 * call completes (the surrounding code returns successfully) with
 * accuracyLabel undefined/null on the produced samples.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

function responsesApiFormat(text: string) {
  return { output: [{ type: "message", content: [{ type: "output_text", text }] }] };
}

describe("HP-256 — accuracy-check Promise.race timeout", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    process.env.OPENAI_API_KEY = "test-key";
    // ANTHROPIC_API_KEY intentionally unset so queryAnthropic is NOT registered
    // in the provider list. The accuracy-check below still instantiates the
    // mocked Anthropic SDK (the module mock ignores apiKey) — but the route
    // no longer runs a separate 30s queryAnthropic timeout in series before
    // hitting the accuracy-check timeout.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.GEMINI_API_KEY;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  it("TO-1 — Anthropic messages.create never resolves → accuracy-check times out, route still completes, sample has no accuracyLabel", async () => {
    // OpenAI direct-prompt returns a response that triggers the accuracy block.
    mockResponsesCreate.mockResolvedValue(responsesApiFormat("flowblinq is a GEO platform"));
    // Anthropic accuracy-check call never resolves.
    mockMessagesCreate.mockImplementation(() => new Promise(() => { /* never */ }));

    const prompts: CitationPrompt[] = [
      { type: "direct", pillar: null, prompt: "what is flowblinq" },
    ];

    const promise = runCitationCheck(
      "chk-to1",
      "site-1",
      "flowblinq.com",
      prompts,
      NOOP_CALLBACKS,
      undefined,
      undefined,
      undefined,
      "# flowblinq\nA GEO optimization platform that helps brands audit and improve their AI visibility across LLM-driven search.",
    );

    // Advance past TIMEOUT_MS (30s) — the Promise.race against the
    // never-resolving messages.create must reject via the setTimeout branch.
    await vi.advanceTimersByTimeAsync(31_000);

    const result = await promise;

    // The route completes successfully and produces __direct__ samples.
    const directSamples = result.pillarQA["__direct__"]?.samples ?? [];
    expect(directSamples.length).toBeGreaterThan(0);
    // On timeout the catch branch leaves accuracyLabel undefined/null.
    expect(directSamples[0].accuracyLabel ?? null).toBeNull();
    expect(directSamples[0].accuracyNote ?? null).toBeNull();
    // Structured warning logged identifying timeout vs other error.
    expect(warnSpy).toHaveBeenCalled();
    const warnCall = warnSpy.mock.calls.find(args =>
      typeof args[0] === "string" && args[0].includes("[accuracy-check]") && args[0].includes("timeout"),
    );
    expect(warnCall).toBeDefined();
  }, 60_000);
});
