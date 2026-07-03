/**
 * NEW-AI-03 regression test
 *
 * The gpt-5.x reasoning model family requires `max_completion_tokens`, NOT
 * `max_tokens` (which it ignores / returns HTTP 400). The cofounder's base
 * code sent `max_tokens` — this test was RED on that code and is GREEN after
 * the fix.
 *
 * Strategy: mock globalThis.fetch so the Anthropic branch fails immediately
 * (no ANTHROPIC_API_KEY), the OpenAI branch fires, and we inspect the
 * serialised request body for the correct field name.
 *
 * LOCAL-LLM branch (LLM_LOCAL=1):
 *   When LLM_LOCAL=1 is set, callClaude must bypass Anthropic entirely and
 *   POST directly to LLM_BASE_URL/chat/completions with model from
 *   resolveOpenAIModel and max_completion_tokens = Math.max(maxTokens, 900).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("callClaude — NEW-AI-03: OpenAI gpt-5.4 must use max_completion_tokens", () => {
  let capturedOpenAIBody: Record<string, unknown> | null = null;

  beforeEach(() => {
    // Clear any Anthropic key so the function falls straight to OpenAI branch
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-openai";
    // GEMINI_API_KEY must be absent so the final Gemini fallback also fails
    // (we only care about capturing the OpenAI call)
    delete process.env.GEMINI_API_KEY;

    capturedOpenAIBody = null;

    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();

      if (urlStr.includes("openai.com")) {
        // Capture the request body for assertion
        capturedOpenAIBody = JSON.parse(init?.body as string);
        // Return a successful response so callClaude resolves
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: "ok" } }],
          }),
        } as unknown as Response;
      }

      // Any other request (Anthropic, Gemini) — fail so we don't accidentally
      // resolve from a different provider
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: { message: "unexpected provider in test" } }),
      } as unknown as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENAI_API_KEY;
  });

  it("sends max_completion_tokens (not max_tokens) in the OpenAI request body", async () => {
    // Dynamic import so the mock fetch is in place before the module runs
    const { callClaude } = await import("@/lib/claude");

    await callClaude("hello world", 400);

    expect(capturedOpenAIBody).not.toBeNull();
    // The bug: pre-fix code sent max_tokens here — this assertion was RED on
    // the cofounder's base and is GREEN after NEW-AI-03 fix.
    expect(capturedOpenAIBody).toHaveProperty("max_completion_tokens", 400);
    expect(capturedOpenAIBody).not.toHaveProperty("max_tokens");
  });

  it("sends the gpt-5.4 model identifier in the OpenAI request body", async () => {
    const { callClaude } = await import("@/lib/claude");

    await callClaude("test prompt");

    expect(capturedOpenAIBody).not.toBeNull();
    expect(capturedOpenAIBody).toHaveProperty("model", "gpt-5.4");
  });
});

// ── callClaude — LLM_LOCAL=1 branch ─────────────────────────────────────────

describe("callClaude — LOCAL-LLM: routes to local endpoint, bypasses Anthropic", () => {
  let capturedUrl: string | null = null;
  let capturedBody: Record<string, unknown> | null = null;

  beforeEach(() => {
    process.env.LLM_LOCAL = "1";
    process.env.LLM_BASE_URL = "http://localhost:4321/v1";
    process.env.LLM_LOCAL_MODEL = "google/gemma-4-12b";
    // No ANTHROPIC_API_KEY or OPENAI_API_KEY — ensures we don't leak into prod paths
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    capturedUrl = null;
    capturedBody = null;

    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "local-llm-response" } }],
        }),
      } as unknown as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.LLM_LOCAL;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_LOCAL_MODEL;
  });

  it("POSTs to LLM_BASE_URL/chat/completions (not api.anthropic.com or api.openai.com)", async () => {
    vi.resetModules();
    const { callClaude } = await import("@/lib/claude");

    await callClaude("hello", 400);

    expect(capturedUrl).toContain("localhost:4321");
    expect(capturedUrl).toContain("/chat/completions");
    expect(capturedUrl).not.toContain("anthropic.com");
    expect(capturedUrl).not.toContain("openai.com");
  });

  it("uses the model returned by resolveOpenAIModel (google/gemma-4-12b via LLM_LOCAL_MODEL)", async () => {
    vi.resetModules();
    const { callClaude } = await import("@/lib/claude");

    await callClaude("hello", 400);

    expect(capturedBody).toHaveProperty("model", "google/gemma-4-12b");
  });

  it("uses max_completion_tokens = Math.max(maxTokens, 900)", async () => {
    vi.resetModules();
    const { callClaude } = await import("@/lib/claude");

    // maxTokens < 900 → should be clamped up to 900
    await callClaude("hello", 400);
    expect(capturedBody).toHaveProperty("max_completion_tokens", 900);
  });

  it("respects maxTokens > 900 (no artificial clamp down)", async () => {
    vi.resetModules();
    const { callClaude } = await import("@/lib/claude");

    await callClaude("hello", 1200);
    expect(capturedBody).toHaveProperty("max_completion_tokens", 1200);
  });

  it("returns the content string from choices[0].message.content", async () => {
    vi.resetModules();
    const { callClaude } = await import("@/lib/claude");

    const result = await callClaude("hello", 400);
    expect(result).toBe("local-llm-response");
  });

  it("fetch is called exactly once (no Anthropic retry loop)", async () => {
    vi.resetModules();
    const { callClaude } = await import("@/lib/claude");

    await callClaude("hello", 400);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
