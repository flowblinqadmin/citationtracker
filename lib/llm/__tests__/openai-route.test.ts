/**
 * Unit tests for lib/llm/openai-route.ts
 *
 * Verifies:
 * - openAILikeBaseUrl() defaults to api.openai.com, overrides via LLM_BASE_URL
 * - resolveOpenAIModel() preserves production pin when local routing is off,
 *   returns local model when LLM_LOCAL=1 or LLM_BASE_URL is set
 * - openAIApiKey() returns OPENAI_API_KEY when set, falls back to "local"
 *   when in local mode, and "" otherwise
 * - isLocalLLM() reflects both LLM_LOCAL and LLM_BASE_URL signals
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Helper to isolate env changes per test
function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void
): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("openAILikeBaseUrl", () => {
  it("returns api.openai.com/v1 when LLM_BASE_URL is not set", () => {
    withEnv({ LLM_BASE_URL: undefined }, () => {
      // Re-import fresh to avoid module-level caching
      const { openAILikeBaseUrl } = require("@/lib/llm/openai-route");
      expect(openAILikeBaseUrl()).toBe("https://api.openai.com/v1");
    });
  });

  it("returns the LLM_BASE_URL value when set", () => {
    withEnv({ LLM_BASE_URL: "http://localhost:4321/v1" }, () => {
      const { openAILikeBaseUrl } = require("@/lib/llm/openai-route");
      expect(openAILikeBaseUrl()).toBe("http://localhost:4321/v1");
    });
  });

  it("arbitrary override URLs are passed through unchanged", () => {
    withEnv({ LLM_BASE_URL: "http://my-llm-host:8000/v1" }, () => {
      const { openAILikeBaseUrl } = require("@/lib/llm/openai-route");
      expect(openAILikeBaseUrl()).toBe("http://my-llm-host:8000/v1");
    });
  });
});

describe("isLocalLLM", () => {
  it("returns false when neither LLM_LOCAL nor LLM_BASE_URL is set", () => {
    withEnv({ LLM_LOCAL: undefined, LLM_BASE_URL: undefined }, () => {
      const { isLocalLLM } = require("@/lib/llm/openai-route");
      expect(isLocalLLM()).toBe(false);
    });
  });

  it("returns true when LLM_LOCAL=1", () => {
    withEnv({ LLM_LOCAL: "1", LLM_BASE_URL: undefined }, () => {
      const { isLocalLLM } = require("@/lib/llm/openai-route");
      expect(isLocalLLM()).toBe(true);
    });
  });

  it("returns true when LLM_BASE_URL is set (even without LLM_LOCAL)", () => {
    withEnv({ LLM_LOCAL: undefined, LLM_BASE_URL: "http://localhost:4321/v1" }, () => {
      const { isLocalLLM } = require("@/lib/llm/openai-route");
      expect(isLocalLLM()).toBe(true);
    });
  });

  it("returns false when LLM_LOCAL is set to something other than '1'", () => {
    withEnv({ LLM_LOCAL: "0", LLM_BASE_URL: undefined }, () => {
      const { isLocalLLM } = require("@/lib/llm/openai-route");
      expect(isLocalLLM()).toBe(false);
    });
  });
});

describe("resolveOpenAIModel", () => {
  it("returns the defaultModel pin unchanged in production mode", () => {
    withEnv({ LLM_LOCAL: undefined, LLM_BASE_URL: undefined }, () => {
      const { resolveOpenAIModel } = require("@/lib/llm/openai-route");
      expect(resolveOpenAIModel("gpt-5.4")).toBe("gpt-5.4");
      expect(resolveOpenAIModel("gpt-5.4-mini")).toBe("gpt-5.4-mini");
    });
  });

  it("returns the default local model (google/gemma-4-12b) when LLM_LOCAL=1", () => {
    withEnv({ LLM_LOCAL: "1", LLM_LOCAL_MODEL: undefined, LLM_BASE_URL: undefined }, () => {
      const { resolveOpenAIModel } = require("@/lib/llm/openai-route");
      expect(resolveOpenAIModel("gpt-5.4")).toBe("google/gemma-4-12b");
    });
  });

  it("returns LLM_LOCAL_MODEL when set", () => {
    withEnv({ LLM_LOCAL: "1", LLM_LOCAL_MODEL: "mistral/mistral-7b", LLM_BASE_URL: undefined }, () => {
      const { resolveOpenAIModel } = require("@/lib/llm/openai-route");
      expect(resolveOpenAIModel("gpt-5.4")).toBe("mistral/mistral-7b");
    });
  });

  it("returns local model when only LLM_BASE_URL is set (no LLM_LOCAL)", () => {
    withEnv({ LLM_LOCAL: undefined, LLM_BASE_URL: "http://localhost:4321/v1", LLM_LOCAL_MODEL: undefined }, () => {
      const { resolveOpenAIModel } = require("@/lib/llm/openai-route");
      expect(resolveOpenAIModel("gpt-5.4-mini")).toBe("google/gemma-4-12b");
    });
  });

  it("preserves the exact production pin strings used in the pipeline (FIX-026 guard)", () => {
    // These are the exact strings used in claude.ts, content-generator.ts, citation-prompt-generator.ts
    withEnv({ LLM_LOCAL: undefined, LLM_BASE_URL: undefined }, () => {
      const { resolveOpenAIModel } = require("@/lib/llm/openai-route");
      expect(resolveOpenAIModel("gpt-5.4")).toBe("gpt-5.4");
      expect(resolveOpenAIModel("gpt-5.4-mini")).toBe("gpt-5.4-mini");
    });
  });
});

describe("openAIApiKey", () => {
  it("returns OPENAI_API_KEY when set in production mode", () => {
    withEnv({ OPENAI_API_KEY: "sk-prod-key", LLM_LOCAL: undefined, LLM_BASE_URL: undefined }, () => {
      const { openAIApiKey } = require("@/lib/llm/openai-route");
      expect(openAIApiKey()).toBe("sk-prod-key");
    });
  });

  it("returns OPENAI_API_KEY even in local mode (explicit key takes priority)", () => {
    withEnv({ OPENAI_API_KEY: "sk-prod-key", LLM_LOCAL: "1", LLM_BASE_URL: undefined }, () => {
      const { openAIApiKey } = require("@/lib/llm/openai-route");
      expect(openAIApiKey()).toBe("sk-prod-key");
    });
  });

  it("returns 'local' when LLM_LOCAL=1 and no OPENAI_API_KEY is set", () => {
    withEnv({ OPENAI_API_KEY: undefined, LLM_LOCAL: "1", LLM_BASE_URL: undefined }, () => {
      const { openAIApiKey } = require("@/lib/llm/openai-route");
      expect(openAIApiKey()).toBe("local");
    });
  });

  it("returns '' when no key and not in local mode", () => {
    withEnv({ OPENAI_API_KEY: undefined, LLM_LOCAL: undefined, LLM_BASE_URL: undefined }, () => {
      const { openAIApiKey } = require("@/lib/llm/openai-route");
      expect(openAIApiKey()).toBe("");
    });
  });

  it("returns 'local' when LLM_BASE_URL set but no OPENAI_API_KEY", () => {
    withEnv({ OPENAI_API_KEY: undefined, LLM_LOCAL: undefined, LLM_BASE_URL: "http://localhost:4321/v1" }, () => {
      const { openAIApiKey } = require("@/lib/llm/openai-route");
      expect(openAIApiKey()).toBe("local");
    });
  });
});
