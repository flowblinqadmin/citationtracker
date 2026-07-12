// fetchBrandSuggestions — Firecrawl homepage scrape + one Gemini JSON call,
// validated/clamped, degrading to empty on ANY provider failure (never throws).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the Gemini SDK: getGenerativeModel().generateContent() → { response.text() }.
const generateContentMock = vi.fn();
vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { generateContent: generateContentMock };
    }
  },
}));

import { fetchBrandSuggestions } from "@/lib/suggest";

// Build a Gemini response whose text() returns `payload` (string as-is, else JSON).
function geminiReturns(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  generateContentMock.mockResolvedValueOnce({ response: { text: () => text } });
}

// Firecrawl scrape success: markdown body.
function firecrawlReturns(markdown: string) {
  return {
    ok: true,
    json: async () => ({ data: { markdown } }),
  } as unknown as Response;
}

const ORIG_KEY = process.env.FIRECRAWL_API_KEY;
const ORIG_GEMINI = process.env.GEMINI_API_KEY;

beforeEach(() => {
  vi.restoreAllMocks();
  generateContentMock.mockReset();
  process.env.FIRECRAWL_API_KEY = "fc-test";
  process.env.GEMINI_API_KEY = "gm-test";
});

afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = ORIG_KEY;
  if (ORIG_GEMINI === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIG_GEMINI;
});

describe("fetchBrandSuggestions", () => {
  it("returns the parsed brand shape on the happy path", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(firecrawlReturns("# Acme\nWe sell widgets."));
    geminiReturns({
      name: "Acme",
      competitors: [
        { name: "Globex", domain: "globex.com" },
        { name: "Initech", domain: "https://www.initech.com/" },
      ],
      prompts: ["best widget brands", "top rated widgets for small teams"],
    });

    const out = await fetchBrandSuggestions("acme.com");
    expect(out.name).toBe("Acme");
    expect(out.competitors).toEqual([
      { name: "Globex", domain: "globex.com" },
      { name: "Initech", domain: "initech.com" }, // normalized
    ]);
    expect(out.prompts).toEqual(["best widget brands", "top rated widgets for small teams"]);
  });

  it("clamps competitors to 10, prompts to 15, dedupes by domain, drops invalid rows, trims prompts to 500", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(firecrawlReturns("homepage"));
    const competitors = [
      { name: "A", domain: "dup.com" },
      { name: "A2", domain: "www.dup.com" }, // dedupe → same normalized domain
      { name: "NoDomain", domain: "not a domain!!" }, // invalid → dropped
      { name: "", domain: "empty-name.com" }, // invalid name → dropped
      ...Array.from({ length: 15 }, (_, i) => ({ name: `C${i}`, domain: `c${i}.com` })),
    ];
    const prompts = [
      "x".repeat(600), // over-length → trimmed to 500
      "",              // empty → dropped
      ...Array.from({ length: 20 }, (_, i) => `prompt number ${i}`),
    ];
    geminiReturns({ name: "Big", competitors, prompts });

    const out = await fetchBrandSuggestions("big.com");
    expect(out.competitors.length).toBeLessThanOrEqual(10);
    // dup collapsed to one
    expect(out.competitors.filter((c) => c.domain === "dup.com")).toHaveLength(1);
    expect(out.competitors.some((c) => c.name === "NoDomain")).toBe(false);
    expect(out.prompts.length).toBeLessThanOrEqual(15);
    expect(out.prompts.every((p) => p.length <= 500 && p.length > 0)).toBe(true);
    expect(out.prompts[0].length).toBe(500);
  });

  it("degrades to empty when FIRECRAWL_API_KEY is missing (no fetch call)", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    const fetchSpy = vi.spyOn(global, "fetch");
    const out = await fetchBrandSuggestions("acme.com");
    expect(out).toEqual({ name: null, competitors: [], prompts: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it("degrades to empty when the Firecrawl scrape returns 4xx", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({ ok: false, status: 402 } as Response);
    const out = await fetchBrandSuggestions("acme.com");
    expect(out).toEqual({ name: null, competitors: [], prompts: [] });
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it("degrades to empty when the LLM returns garbage (non-JSON) output", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(firecrawlReturns("homepage"));
    geminiReturns("not json at all, sorry <<<");
    const out = await fetchBrandSuggestions("acme.com");
    expect(out).toEqual({ name: null, competitors: [], prompts: [] });
  });

  it("degrades to empty when the LLM JSON fails schema validation", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(firecrawlReturns("homepage"));
    geminiReturns({ wrong: "shape", competitors: "nope" });
    const out = await fetchBrandSuggestions("acme.com");
    expect(out).toEqual({ name: null, competitors: [], prompts: [] });
  });

  // The scrape's timeout is an AbortSignal.timeout() on the fetch call. fetch is
  // mocked here, so the signal never actually fires — the real abort surfaces as
  // a rejected fetch with a DOMException named "TimeoutError". We assert the
  // degradation path by rejecting with exactly that error shape, rather than
  // pretending to drive a timer the mock can't observe.
  it("degrades to empty when the scrape rejects with a TimeoutError (abort path)", async () => {
    vi.spyOn(global, "fetch").mockRejectedValueOnce(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    const out = await fetchBrandSuggestions("acme.com");
    expect(out).toEqual({ name: null, competitors: [], prompts: [] });
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  // The Gemini call's timeout IS setTimeout-based (Promise.race against a
  // setTimeout reject), so fake timers genuinely drive the wiring: the provider
  // promise never resolves, and only advancing the clock past LLM_TIMEOUT_MS
  // (15s) makes the race reject → degrade. This exercises the timeout, not a
  // pre-rejected mock.
  it("degrades to empty when the Gemini call exceeds its timeout budget", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(firecrawlReturns("homepage"));
      generateContentMock.mockReturnValueOnce(new Promise(() => {})); // never resolves
      const pending = fetchBrandSuggestions("acme.com");
      await vi.advanceTimersByTimeAsync(15_001); // past the 15s LLM budget
      const out = await pending;
      expect(out).toEqual({ name: null, competitors: [], prompts: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("tolerates JSON wrapped in ```json fences from the model", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(firecrawlReturns("homepage"));
    geminiReturns("```json\n" + JSON.stringify({ name: "Fenced", competitors: [], prompts: ["a prompt"] }) + "\n```");
    const out = await fetchBrandSuggestions("acme.com");
    expect(out.name).toBe("Fenced");
    expect(out.prompts).toEqual(["a prompt"]);
  });
});
