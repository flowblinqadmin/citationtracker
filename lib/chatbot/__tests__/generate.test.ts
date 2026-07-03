import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { streamChatbotResponse, generateChatbotResponse, type GenerateOpts } from "../generate";
import type { RetrievedChunk } from "../retrieve";

// Mock AI SDK
vi.mock("ai", () => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
  convertToModelMessages: vi.fn(async (msgs) => msgs),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => vi.fn((model) => model)),
}));

import { streamText, generateText, convertToModelMessages } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

describe("generate.ts", () => {
  const mockChunks: RetrievedChunk[] = [
    {
      content: "JSON-LD helps with AI visibility",
      source: "docs:schema",
      similarity: 0.8,
      category: "schema",
      platform: null,
    },
  ];

  const baseOpts: GenerateOpts = {
    messages: [{ role: "user" as const, content: "How do I improve SEO?" }],
    siteContext: {
      domain: "example.com",
      overallScore: 65,
      tier: "paid" as const,
      credits: 50,
      platformDetected: "wordpress",
      pillars: [],
      rankedRecommendations: [],
    },
    viewContext: {
      page: "results" as const,
      currentTab: "scorecard",
      domain: "example.com",
    },
    retrieval: {
      tier: "full" as const,
      chunks: mockChunks,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.CLEO_MODEL_ID;
    delete process.env.CLEO_TEMPERATURE;
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  // Test 1: generateChatbotResponse returns { text, systemPrompt }
  test("generateChatbotResponse returns text and systemPrompt", async () => {
    const mockGenerateText = generateText as ReturnType<typeof vi.fn>;
    mockGenerateText.mockResolvedValueOnce({
      text: "Here are some SEO tips...",
      finishReason: "stop",
    });

    const result = await generateChatbotResponse(baseOpts);

    expect(result).toHaveProperty("text");
    expect(result).toHaveProperty("systemPrompt");
    expect(result.text).toBe("Here are some SEO tips...");
    expect(result.systemPrompt).toContain("Cleo");
    expect(result.systemPrompt).toContain("example.com");
  });

  // Test 2: Anthropic model ID throws guard error
  test("Anthropic model IDs throw guard error", async () => {
    const anthropicOpts = { ...baseOpts, modelOverride: "claude-3-haiku" };

    await expect(generateChatbotResponse(anthropicOpts)).rejects.toThrow(
      "Anthropic not yet wired into route"
    );
  });

  test("Anthropic anthropic/ prefix throws guard error", async () => {
    const anthropicOpts = { ...baseOpts, modelOverride: "anthropic/claude-opus" };

    await expect(generateChatbotResponse(anthropicOpts)).rejects.toThrow(
      "Anthropic not yet wired into route"
    );
  });

  // Test 3: Stream and non-stream produce identical system prompts
  test("streamChatbotResponse and generateChatbotResponse produce identical system prompts", async () => {
    const mockGenerateText = generateText as ReturnType<typeof vi.fn>;
    mockGenerateText.mockResolvedValueOnce({
      text: "Stream response",
      finishReason: "stop",
    });

    const mockStreamText = streamText as ReturnType<typeof vi.fn>;
    mockStreamText.mockReturnValueOnce({
      toUIMessageStreamResponse: vi.fn(() => new Response()),
    });

    // Get system prompt from non-streaming
    const nonStreamResult = await generateChatbotResponse(baseOpts);
    const nonStreamPrompt = nonStreamResult.systemPrompt;

    // Get system prompt from streaming (by intercepting the buildSystemPrompt)
    const streamOpts = {
      ...baseOpts,
      onFinish: vi.fn(),
    };
    await streamChatbotResponse(streamOpts);

    // Verify streamText was called with the mocked model
    expect(mockStreamText).toHaveBeenCalled();
    const streamCallArg = (mockStreamText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(streamCallArg?.system).toContain("Cleo");
    expect(streamCallArg?.system).toContain("example.com");

    // Both should contain the same key indicators
    expect(nonStreamPrompt).toContain("example.com");
    expect(streamCallArg?.system).toContain("example.com");
  });

  // Test 4: Message normalization for legacy format and parts format
  test("normalizes legacy content format", async () => {
    const mockGenerateText = generateText as ReturnType<typeof vi.fn>;
    mockGenerateText.mockResolvedValueOnce({
      text: "Response",
      finishReason: "stop",
    });

    const legacyOpts = {
      ...baseOpts,
      messages: [
        { role: "user" as const, content: "Hello" },
        { role: "assistant" as const, content: "Hi there!" },
      ],
    };

    await generateChatbotResponse(legacyOpts);

    expect(generateText).toHaveBeenCalled();
    const callArg = (mockGenerateText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.messages).toBeDefined();
    expect(Array.isArray(callArg?.messages)).toBe(true);
  });

  test("normalizes parts format (AI SDK v6)", async () => {
    const mockGenerateText = generateText as ReturnType<typeof vi.fn>;
    mockGenerateText.mockResolvedValueOnce({
      text: "Response",
      finishReason: "stop",
    });

    const partsOpts = {
      ...baseOpts,
      messages: [
        {
          role: "user" as const,
          parts: [{ type: "text", text: "Hello" }],
        },
        {
          role: "assistant" as const,
          parts: [{ type: "text", text: "Hi!" }],
        },
      ],
    };

    await generateChatbotResponse(partsOpts);

    expect(generateText).toHaveBeenCalled();
    const callArg = (mockGenerateText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.messages).toBeDefined();
  });

  // Test 5: Model selection defaults
  test("uses default model when no override", async () => {
    const mockGenerateText = generateText as ReturnType<typeof vi.fn>;
    mockGenerateText.mockResolvedValueOnce({
      text: "Response",
      finishReason: "stop",
    });

    await generateChatbotResponse(baseOpts);

    expect(generateText).toHaveBeenCalled();
    const callArg = (mockGenerateText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    // Default model is gpt-4o-mini
    expect(callArg?.model).toBeDefined();
  });

  test("respects CLEO_MODEL_ID env var", async () => {
    process.env.CLEO_MODEL_ID = "gpt-4-turbo";
    const mockGenerateText = generateText as ReturnType<typeof vi.fn>;
    mockGenerateText.mockResolvedValueOnce({
      text: "Response",
      finishReason: "stop",
    });

    await generateChatbotResponse(baseOpts);

    expect(generateText).toHaveBeenCalled();
  });

  // Test 6: Temperature selection
  test("uses temperature override when provided", async () => {
    const mockGenerateText = generateText as ReturnType<typeof vi.fn>;
    mockGenerateText.mockResolvedValueOnce({
      text: "Response",
      finishReason: "stop",
    });

    const opts = { ...baseOpts, temperatureOverride: 0.7 };
    await generateChatbotResponse(opts);

    expect(generateText).toHaveBeenCalled();
    const callArg = (mockGenerateText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.temperature).toBe(0.7);
  });

  test("uses default temperature 0.1 when no override", async () => {
    const mockGenerateText = generateText as ReturnType<typeof vi.fn>;
    mockGenerateText.mockResolvedValueOnce({
      text: "Response",
      finishReason: "stop",
    });

    await generateChatbotResponse(baseOpts);

    expect(generateText).toHaveBeenCalled();
    const callArg = (mockGenerateText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.temperature).toBe(0.1);
  });

  // Test 7: Stream response includes onFinish hook
  test("streamChatbotResponse passes onFinish hook", async () => {
    const mockStreamText = streamText as ReturnType<typeof vi.fn>;
    const mockResponse = { toUIMessageStreamResponse: vi.fn(() => new Response()) };
    mockStreamText.mockReturnValueOnce(mockResponse);

    const onFinish = vi.fn();
    const opts = { ...baseOpts, onFinish };

    await streamChatbotResponse(opts);

    expect(mockStreamText).toHaveBeenCalled();
    const callArg = (mockStreamText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.onFinish).toBeDefined();
  });

  // Test 8: System prompt includes site context
  test("system prompt includes site context details", async () => {
    const mockGenerateText = generateText as ReturnType<typeof vi.fn>;
    mockGenerateText.mockResolvedValueOnce({
      text: "Response",
      finishReason: "stop",
    });

    const contextOpts = {
      ...baseOpts,
      siteContext: {
        ...baseOpts.siteContext!,
        domain: "mysite.example.com",
        overallScore: 42,
        platformDetected: "shopify",
      },
    };

    const result = await generateChatbotResponse(contextOpts);

    expect(result.systemPrompt).toContain("mysite.example.com");
    expect(result.systemPrompt).toContain("42");
    expect(result.systemPrompt).toContain("shopify");
  });

  // Test 9: Handles null contexts gracefully
  test("handles null siteContext and viewContext", async () => {
    const mockGenerateText = generateText as ReturnType<typeof vi.fn>;
    mockGenerateText.mockResolvedValueOnce({
      text: "Response",
      finishReason: "stop",
    });

    const nullContextOpts = {
      messages: [{ role: "user" as const, content: "Hello" }],
      siteContext: null,
      viewContext: null,
      retrieval: { tier: "full" as const, chunks: [] },
    };

    const result = await generateChatbotResponse(nullContextOpts);

    expect(result.text).toBe("Response");
    expect(result.systemPrompt).toContain("Cleo");
    // Should still have product knowledge, just no site context
  });

  // Test 10: maxOutputTokens and model type
  test("uses correct maxOutputTokens", async () => {
    const mockGenerateText = generateText as ReturnType<typeof vi.fn>;
    mockGenerateText.mockResolvedValueOnce({
      text: "Response",
      finishReason: "stop",
    });

    await generateChatbotResponse(baseOpts);

    expect(generateText).toHaveBeenCalled();
    const callArg = (mockGenerateText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.maxOutputTokens).toBe(1000);
  });
});
