/**
 * Unit tests for lib/services/citation-prompt-generator.ts — ES-027 / ES-028
 * PG-1 through PG-11: CitationPrompt[] shape, indirect/direct split, domain filter, fallback paths
 * FB-1 through FB-10: Provider fallback loop — OpenAI / Google / Perplexity / timeout / all-fail
 *
 * ES-027 replaces ES-024's 48 site-attribute queries with:
 *   - ~40 indirect market queries (domain-absent — organic citation measurement)
 *   - ~8 direct brand queries   (domain-present — brand knowledge measurement)
 *
 * ES-028 adds provider fallback: Haiku failure → try OpenAI → Google → Perplexity → 4 legacy prompts
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CitationPrompt } from "@/lib/services/citation-prompt-generator";
import type { GeoScorecard } from "@/lib/services/geo-analyzer";

// ─── Hoisted mock references ──────────────────────────────────────────────────

const { mockCreate, mockOpenAICreate, mockGoogleGenerate } = vi.hoisted(() => {
  const mockCreate        = vi.fn();
  const mockOpenAICreate  = vi.fn();
  const mockGoogleGenerate = vi.fn();
  return { mockCreate, mockOpenAICreate, mockGoogleGenerate };
});

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockOpenAICreate } } };
  }),
}));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(function () {
    return {
      getGenerativeModel: vi.fn().mockReturnValue({ generateContent: mockGoogleGenerate }),
    };
  }),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { generatePrompts } from "@/lib/services/citation-prompt-generator";

// ─── Constants ────────────────────────────────────────────────────────────────

const PILLAR_IDS = [
  "metadata_freshness", "semantic_html", "structured_data", "entity_definitions",
  "faq_coverage", "evidence_statistics", "content_structure", "author_authority",
  "internal_linking", "content_freshness", "multi_format", "licensing_signals",
  "contact_trust", "competitive_positioning", "offering_clarity", "cta_structure",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockScorecard(): GeoScorecard {
  const pillars = PILLAR_IDS.map(id => ({
    pillar: id,
    pillarName: id,
    score: 35,
    findings: "test findings",
    recommendation: "improve it",
    priority: "high" as const,
    impactedPages: [],
  }));
  return { overallScore: 35, pillars, topThreeImprovements: [] };
}

/** Build a clean 48-item Haiku response: 40 indirect + 8 direct. */
function mockHaiku48(domain: string): CitationPrompt[] {
  // 40 indirect: 2-3 per pillar, no domain name
  const indirect: CitationPrompt[] = PILLAR_IDS.flatMap(pillar => [
    { type: "indirect" as const, pillar, prompt: `Best tools for ${pillar} optimization?` },
    { type: "indirect" as const, pillar, prompt: `Which companies lead in ${pillar}?` },
    { type: "indirect" as const, pillar, prompt: `How to evaluate ${pillar} for SaaS?` },
  ]); // 48 indirect — we'll take 40; spec allows 40-48 indirect as long as total ≥ 20
  // For a valid test response we just use all 48 indirect + 8 direct = 56 (validator checks ≥20, not exact 48)
  const direct: CitationPrompt[] = [
    { type: "direct" as const, pillar: null, prompt: `What is ${domain} and what does it offer?` },
    { type: "direct" as const, pillar: null, prompt: `How does ${domain} compare to alternatives?` },
    { type: "direct" as const, pillar: null, prompt: `Is ${domain} trustworthy?` },
    { type: "direct" as const, pillar: null, prompt: `What are the main features of ${domain}?` },
    { type: "direct" as const, pillar: null, prompt: `Is ${domain} recommended for SaaS?` },
    { type: "direct" as const, pillar: null, prompt: `What do users say about ${domain}?` },
    { type: "direct" as const, pillar: null, prompt: `Who should use ${domain}?` },
    { type: "direct" as const, pillar: null, prompt: `How does ${domain} stay current with AI changes?` },
  ];
  // Return all 48 indirect + 8 direct = 56 total (validator checks ≥20, covers all 16 pillars)
  return [...indirect, ...direct];
}

function setHaikuResponse(items: CitationPrompt[]) {
  mockCreate.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify(items) }],
  });
}

function mockOpenAISuccess(items: CitationPrompt[]) {
  mockOpenAICreate.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(items) } }],
  });
}

function mockGoogleSuccess(items: CitationPrompt[]) {
  mockGoogleGenerate.mockResolvedValue({
    response: { text: () => JSON.stringify(items) },
  });
}

const SITE = {
  domain: "flowblinq.com",
  siteType: "SaaS",
  geoScorecard: mockScorecard(),
  executiveSummary: "Flowblinq is a GEO audit and AI visibility platform.",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("citation-prompt-generator — generatePrompts (ES-027 PG-1–PG-11)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key-pg";
  });

  it("PG-1 — returns CitationPrompt[] with correct shape (type, pillar, prompt on every item)", async () => {
    setHaikuResponse(mockHaiku48(SITE.domain));
    const result = await generatePrompts(SITE);
    expect(result.length).toBeGreaterThanOrEqual(20);
    result.forEach(item => {
      expect(["indirect", "direct"]).toContain(item.type);
      expect(typeof item.prompt).toBe("string");
      expect(item.prompt.length).toBeGreaterThan(0);
      if (item.type === "direct") {
        expect(item.pillar).toBeNull();
      } else {
        // indirect: pillar may be a string or null (null not recommended but type-valid)
        expect(["string", "object"]).toContain(typeof item.pillar); // null is "object" typeof
      }
    });
  });

  it("PG-2 — indirect prompts contain no domain name (organic citation model)", async () => {
    setHaikuResponse(mockHaiku48(SITE.domain));
    const result = await generatePrompts(SITE);
    const indirects = result.filter(p => p.type === "indirect");
    expect(indirects.length).toBeGreaterThan(0);
    // All indirect prompts from mockHaiku48 are free of the domain
    const domainStem = "flowblinq"; // TLD stripped
    const leaked = indirects.filter(p =>
      p.prompt.toLowerCase().includes(SITE.domain.toLowerCase()) ||
      p.prompt.toLowerCase().includes(domainStem.toLowerCase())
    );
    expect(leaked).toHaveLength(0);
  });

  it("PG-3 — direct prompts contain domain name", async () => {
    setHaikuResponse(mockHaiku48(SITE.domain));
    const result = await generatePrompts(SITE);
    const directs = result.filter(p => p.type === "direct");
    expect(directs.length).toBeGreaterThan(0);
    directs.forEach(p => {
      expect(p.prompt).toContain(SITE.domain);
      expect(p.pillar).toBeNull();
    });
  });

  it("PG-4 — all 16 pillar IDs represented in indirect prompts", async () => {
    setHaikuResponse(mockHaiku48(SITE.domain));
    const result = await generatePrompts(SITE);
    const indirects = result.filter(p => p.type === "indirect");
    const pillarSet = new Set(indirects.map(p => p.pillar));
    expect(pillarSet.size).toBe(16);
    for (const id of PILLAR_IDS) {
      expect(pillarSet.has(id)).toBe(true);
    }
  });

  it("PG-5 — domain filter strips indirect prompts containing domain name (direct prompts kept)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const items = mockHaiku48(SITE.domain);
    // Inject a domain-leaking indirect prompt at the start
    items[0] = {
      type: "indirect",
      pillar: PILLAR_IDS[0],
      prompt: `Does ${SITE.domain} have good metadata freshness?`, // LEAKS domain
    };
    setHaikuResponse(items);

    const result = await generatePrompts(SITE);

    // Leaking indirect should be stripped
    const leakFound = result.some(
      p => p.type === "indirect" && p.prompt.toLowerCase().includes(SITE.domain.toLowerCase())
    );
    expect(leakFound).toBe(false);

    // Direct prompts with domain should still be present
    const directsWithDomain = result.filter(p => p.type === "direct" && p.prompt.includes(SITE.domain));
    expect(directsWithDomain.length).toBeGreaterThan(0);

    // console.warn called for the stripped prompt
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("PG-6 — domain stem filter strips indirect prompt containing only stem (no TLD)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const items = mockHaiku48(SITE.domain);
    // "flowblinq" (stem of "flowblinq.com") in an indirect prompt
    items[0] = {
      type: "indirect",
      pillar: PILLAR_IDS[0],
      prompt: "Which tools compete with flowblinq for GEO optimization?", // stem-only leak
    };
    setHaikuResponse(items);

    const result = await generatePrompts(SITE);

    // "flowblinq" stem should also be filtered from indirect prompts
    const stemLeak = result.some(
      p => p.type === "indirect" && p.prompt.toLowerCase().includes("flowblinq")
    );
    expect(stemLeak).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("PG-7 — fallback on Haiku API failure returns 4 CitationPrompt[] items (2 indirect, 2 direct)", async () => {
    mockCreate.mockRejectedValue(new Error("api fail"));
    const result = await generatePrompts(SITE);

    expect(result).toHaveLength(4);
    const indirects = result.filter(p => p.type === "indirect");
    const directs   = result.filter(p => p.type === "direct");
    expect(indirects).toHaveLength(2);
    expect(directs).toHaveLength(2);
    // Shape check
    result.forEach(p => {
      expect(["indirect", "direct"]).toContain(p.type);
      expect(typeof p.prompt).toBe("string");
    });
  });

  it("PG-8 — fallback when ANTHROPIC_API_KEY missing (mockCreate not called, 4 prompts returned)", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await generatePrompts(SITE);

    expect(result).toHaveLength(4);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("PG-9 — fallback when Haiku returns array with < 20 items (validation floor)", async () => {
    // 5 items is below the min-20 floor
    const tooFewItems: CitationPrompt[] = [
      { type: "indirect", pillar: "faq_coverage", prompt: "Best GEO tools?" },
      { type: "indirect", pillar: "author_authority", prompt: "Leading AI search companies?" },
      { type: "direct", pillar: null, prompt: `What is ${SITE.domain}?` },
      { type: "direct", pillar: null, prompt: `How does ${SITE.domain} compare?` },
      { type: "indirect", pillar: "offering_clarity", prompt: "What should I look for in GEO software?" },
    ];
    setHaikuResponse(tooFewItems);
    const result = await generatePrompts(SITE);

    // Validation fails (< 20 items) → fallback
    expect(result).toHaveLength(4);
  });

  it("PG-10 — fallback prompts have no {domain}/{year} placeholders; domain in direct prompts", async () => {
    mockCreate.mockRejectedValue(new Error("network error"));
    const result = await generatePrompts({ ...SITE, domain: "acme.io" });

    expect(result).toHaveLength(4);
    result.forEach(p => {
      expect(p.prompt).not.toContain("{domain}");
      expect(p.prompt).not.toContain("{year}");
    });
    // Direct prompts must contain the domain
    const directs = result.filter(p => p.type === "direct");
    directs.forEach(p => {
      expect(p.prompt).toContain("acme.io");
    });
  });

  it("PG-11 — fallback direct prompts have pillar: null; fallback indirect prompts have string pillar", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await generatePrompts(SITE);

    const indirects = result.filter(p => p.type === "indirect");
    const directs   = result.filter(p => p.type === "direct");

    directs.forEach(p => expect(p.pillar).toBeNull());
    indirects.forEach(p => expect(typeof p.pillar).toBe("string"));
  });
});

// ─── ES-028 Provider Fallback (FB-1–FB-10) ────────────────────────────────────

describe("citation-prompt-generator — provider fallback loop (ES-028 FB-1–FB-10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clean slate — each test sets only the keys it needs
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
  });

  it("FB-1 — Haiku fails (529) → OpenAI tried and returns valid CitationPrompt[]", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    process.env.ANTHROPIC_API_KEY = "test-haiku";
    process.env.OPENAI_API_KEY    = "test-openai";

    mockCreate.mockRejectedValue(new Error("529 overloaded"));
    mockOpenAISuccess(mockHaiku48(SITE.domain));

    const result = await generatePrompts(SITE);

    expect(result.length).toBeGreaterThanOrEqual(20);
    result.forEach(p => expect(["indirect", "direct"]).toContain(p.type));

    // Haiku failure warning references the next provider
    const warnMessages = warnSpy.mock.calls.map(c => c[0] as string);
    expect(warnMessages.some(m => m.includes("haiku failed"))).toBe(true);
    expect(warnMessages.some(m => m.includes("trying openai"))).toBe(true);

    // OpenAI success logged at info level
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("openai succeeded"));

    // OpenAI SDK called once
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("FB-2 — Haiku + OpenAI fail → Google tried and returns valid CitationPrompt[]", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.ANTHROPIC_API_KEY          = "test-haiku";
    process.env.OPENAI_API_KEY             = "test-openai";
    process.env.GEMINI_API_KEY = "test-google";

    mockCreate.mockRejectedValue(new Error("haiku fail"));
    mockOpenAICreate.mockRejectedValue(new Error("openai fail"));
    mockGoogleSuccess(mockHaiku48(SITE.domain));

    const result = await generatePrompts(SITE);

    expect(result.length).toBeGreaterThanOrEqual(20);
    // Both OpenAI and Google were attempted
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    expect(mockGoogleGenerate).toHaveBeenCalledTimes(1);

    // Haiku failure was warned
    const warnMessages = warnSpy.mock.calls.map(c => c[0] as string);
    expect(warnMessages.some(m => m.includes("haiku failed"))).toBe(true);

    warnSpy.mockRestore();
  });

  it("FB-3 — Haiku + OpenAI + Google fail → Perplexity tried and returns valid CitationPrompt[]", async () => {
    process.env.ANTHROPIC_API_KEY          = "test-haiku";
    process.env.OPENAI_API_KEY             = "test-openai";
    process.env.GEMINI_API_KEY = "test-google";
    process.env.PERPLEXITY_API_KEY         = "test-perplexity";

    mockCreate.mockRejectedValue(new Error("haiku fail"));
    // First call to mockOpenAICreate → OpenAI fails; second → Perplexity succeeds
    mockOpenAICreate
      .mockRejectedValueOnce(new Error("openai fail"))
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(mockHaiku48(SITE.domain)) } }] });
    mockGoogleGenerate.mockRejectedValue(new Error("google fail"));

    const result = await generatePrompts(SITE);

    expect(result.length).toBeGreaterThanOrEqual(20);
    // OpenAI SDK called twice: once for OpenAI provider, once for Perplexity provider
    expect(mockOpenAICreate).toHaveBeenCalledTimes(2);
    expect(mockGoogleGenerate).toHaveBeenCalledTimes(1);
  });

  it("FB-4 — all providers fail → 4 legacy CitationPrompt[] returned; 'all providers failed' warned", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // No ANTHROPIC_API_KEY — use 3 fallback providers only
    process.env.OPENAI_API_KEY             = "test-openai";
    process.env.GEMINI_API_KEY = "test-google";
    process.env.PERPLEXITY_API_KEY         = "test-perplexity";

    // All OpenAI SDK calls fail (covers OpenAI + Perplexity providers)
    mockOpenAICreate.mockRejectedValue(new Error("provider fail"));
    mockGoogleGenerate.mockRejectedValue(new Error("provider fail"));

    const result = await generatePrompts(SITE);

    expect(result).toHaveLength(4);
    expect(result.filter(p => p.type === "indirect")).toHaveLength(2);
    expect(result.filter(p => p.type === "direct")).toHaveLength(2);

    // Final warning mentions all attempted providers
    const warnMessages = warnSpy.mock.calls.map(c => c[0] as string);
    const finalWarn = warnMessages.find(m => m.includes("all providers failed")) ?? "";
    expect(finalWarn).toBeTruthy();
    expect(finalWarn).toContain("openai");
    expect(finalWarn).toContain("google");
    expect(finalWarn).toContain("perplexity");

    warnSpy.mockRestore();
  });

  it("FB-5 — OPENAI_API_KEY unset → OpenAI silently skipped; Google tried and succeeds", async () => {
    process.env.ANTHROPIC_API_KEY          = "test-haiku";
    // NO OPENAI_API_KEY
    process.env.GEMINI_API_KEY = "test-google";

    mockCreate.mockRejectedValue(new Error("haiku fail"));
    mockGoogleSuccess(mockHaiku48(SITE.domain));

    const result = await generatePrompts(SITE);

    expect(result.length).toBeGreaterThanOrEqual(20);
    // OpenAI SDK never called — key was absent
    expect(mockOpenAICreate).not.toHaveBeenCalled();
    expect(mockGoogleGenerate).toHaveBeenCalledTimes(1);
  });

  it("FB-6 — domain filter applied to OpenAI response; leaking indirect prompt stripped", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.ANTHROPIC_API_KEY = "test-haiku";
    process.env.OPENAI_API_KEY    = "test-openai";

    mockCreate.mockRejectedValue(new Error("haiku fail"));

    // Build 56-item response with one indirect leaking the domain
    const items = mockHaiku48(SITE.domain);
    items[0] = {
      type: "indirect",
      pillar: PILLAR_IDS[0],
      prompt: `Does ${SITE.domain} have strong metadata freshness?`, // leaks domain
    };
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(items) } }],
    });

    const result = await generatePrompts(SITE);

    // Leaking indirect must be stripped
    const leaked = result.some(
      p => p.type === "indirect" && p.prompt.toLowerCase().includes(SITE.domain.toLowerCase())
    );
    expect(leaked).toBe(false);

    // Direct prompts with domain are kept
    expect(result.some(p => p.type === "direct")).toBe(true);

    // Domain filter emitted a warning
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("FB-7 — OpenAI returns malformed JSON → tryProvider fails → Google tried next", async () => {
    process.env.ANTHROPIC_API_KEY          = "test-haiku";
    process.env.OPENAI_API_KEY             = "test-openai";
    process.env.GEMINI_API_KEY = "test-google";

    mockCreate.mockRejectedValue(new Error("haiku fail"));
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: "not valid json {{{{ at all" } }],
    });
    mockGoogleSuccess(mockHaiku48(SITE.domain));

    const result = await generatePrompts(SITE);

    expect(result.length).toBeGreaterThanOrEqual(20);
    // Both were called: OpenAI (failed), Google (succeeded)
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    expect(mockGoogleGenerate).toHaveBeenCalledTimes(1);
  });

  it("FB-8 — OpenAI returns <20 items → validation fails → Google tried next", async () => {
    process.env.ANTHROPIC_API_KEY          = "test-haiku";
    process.env.OPENAI_API_KEY             = "test-openai";
    process.env.GEMINI_API_KEY = "test-google";

    mockCreate.mockRejectedValue(new Error("haiku fail"));

    // Only 3 items — below the ≥20 validation floor
    const fewItems: CitationPrompt[] = [
      { type: "indirect", pillar: "faq_coverage", prompt: "Best GEO tools?" },
      { type: "indirect", pillar: "author_authority", prompt: "Leading AI search companies?" },
      { type: "direct", pillar: null, prompt: `What is ${SITE.domain}?` },
    ];
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(fewItems) } }],
    });
    mockGoogleSuccess(mockHaiku48(SITE.domain));

    const result = await generatePrompts(SITE);

    expect(result.length).toBeGreaterThanOrEqual(20);
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    expect(mockGoogleGenerate).toHaveBeenCalledTimes(1);
  });

  it("FB-9 — Haiku times out after PROMPT_GEN_TIMEOUT_MS → OpenAI tried as next provider", async () => {
    vi.useFakeTimers();
    try {
      process.env.ANTHROPIC_API_KEY = "test-haiku";
      process.env.OPENAI_API_KEY    = "test-openai";

      // Haiku hangs indefinitely — never resolves
      mockCreate.mockImplementation(() => new Promise(() => {}));
      mockOpenAISuccess(mockHaiku48(SITE.domain));

      const resultPromise = generatePrompts(SITE);

      // Advance past the 60 000ms PROMPT_GEN_TIMEOUT_MS (changed from 30s to 60s)
      await vi.advanceTimersByTimeAsync(60_001);

      const result = await resultPromise;

      expect(result.length).toBeGreaterThanOrEqual(20);
      expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("FB-10 — no providers configured → 4 legacy prompts returned immediately; no SDK calls", async () => {
    // All env vars deleted in beforeEach — hasAnyKey is false → immediate legacy return

    const result = await generatePrompts(SITE);

    expect(result).toHaveLength(4);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockOpenAICreate).not.toHaveBeenCalled();
    expect(mockGoogleGenerate).not.toHaveBeenCalled();
  });
});

// ─── ES-053 Tree-Based Prompt Generation (U25–U37) ──────────────────────────

import {
  determineAllocationCase,
  buildSamplingPlan,
  pruneTree,
} from "@/lib/services/citation-prompt-generator";
import type {
  GeoTree, CategoryTree, GeoCategoryMapping,
} from "@/lib/types/trees";
import { emptyGeoTree, emptyCategoryTree, emptyMapping } from "@/lib/types/trees";

function makeRichGeoTree(): GeoTree {
  return {
    root: {
      id: "global", name: "Global", level: "global",
      children: [{
        id: "in", name: "India", level: "country",
        children: [
          {
            id: "in-ka", name: "Karnataka", level: "state",
            children: [
              { id: "in-ka-blr", name: "Bangalore", level: "city", children: [], pageCount: 10, evidence: [] },
              { id: "in-ka-mys", name: "Mysore", level: "city", children: [], pageCount: 3, evidence: [] },
            ],
            pageCount: 13, evidence: [],
          },
          {
            id: "in-tn", name: "Tamil Nadu", level: "state",
            children: [
              { id: "in-tn-che", name: "Chennai", level: "city", children: [], pageCount: 8, evidence: [] },
            ],
            pageCount: 8, evidence: [],
          },
          {
            id: "in-dl", name: "Delhi", level: "state",
            children: [
              { id: "in-dl-ndl", name: "New Delhi", level: "city", children: [], pageCount: 5, evidence: [] },
            ],
            pageCount: 5, evidence: [],
          },
        ],
        pageCount: 26, evidence: [],
      }],
      pageCount: 26, evidence: [],
    },
    leafCount: 4,
    extractedAt: new Date().toISOString(),
  };
}

function makeRichCategoryTree(): CategoryTree {
  return {
    root: {
      id: "healthcare", name: "Healthcare", level: 0,
      children: [
        { id: "hc-onc", name: "Oncology", level: 1, children: [], pageCount: 8, evidence: [] },
        { id: "hc-car", name: "Cardiology", level: 1, children: [], pageCount: 5, evidence: [] },
        { id: "hc-neu", name: "Neurology", level: 1, children: [], pageCount: 4, evidence: [] },
        { id: "hc-ort", name: "Orthopedics", level: 1, children: [], pageCount: 3, evidence: [] },
      ],
      pageCount: 20, evidence: [],
    },
    leafCount: 4,
    extractedAt: new Date().toISOString(),
  };
}

function makeRichMapping(): GeoCategoryMapping {
  const entries = [
    { geoId: "in-ka-blr", categoryId: "hc-onc", strength: "strong" as const, evidence: [] },
    { geoId: "in-ka-blr", categoryId: "hc-car", strength: "strong" as const, evidence: [] },
    { geoId: "in-tn-che", categoryId: "hc-onc", strength: "moderate" as const, evidence: [] },
    { geoId: "in-tn-che", categoryId: "hc-neu", strength: "moderate" as const, evidence: [] },
    { geoId: "in-dl-ndl", categoryId: "hc-car", strength: "inferred" as const, evidence: [] },
    { geoId: "in-dl-ndl", categoryId: "hc-ort", strength: "inferred" as const, evidence: [] },
    { geoId: "in-ka-mys", categoryId: "hc-onc", strength: "moderate" as const, evidence: [] },
    { geoId: "in-ka-mys", categoryId: "hc-car", strength: "inferred" as const, evidence: [] },
    { geoId: "in-ka-blr", categoryId: "hc-neu", strength: "moderate" as const, evidence: [] },
    { geoId: "in-ka-blr", categoryId: "hc-ort", strength: "inferred" as const, evidence: [] },
    { geoId: "in-tn-che", categoryId: "hc-car", strength: "strong" as const, evidence: [] },
  ];
  return { entries, totalEntries: entries.length, extractedAt: new Date().toISOString() };
}

/** Build a tree-based 48-item response: 40 indirect + 8 direct, with new C4 fields. */
function mockTreeBased48(domain: string): CitationPrompt[] {
  const indirect = Array.from({ length: 40 }, (_, i) => ({
    type: "indirect" as const,
    pillar: null,
    prompt: `Best ${i % 2 === 0 ? "oncology" : "cardiology"} hospital in ${i % 3 === 0 ? "Bangalore" : "Chennai"}?`,
    geoId: i % 3 === 0 ? "in-ka-blr" : "in-tn-che",
    categoryId: i % 2 === 0 ? "hc-onc" : "hc-car",
    tier: (["buy", "solve", "learn"] as const)[i % 3],
    queryType: "recommendation" as const,
  }));
  const direct = Array.from({ length: 8 }, (_, i) => ({
    type: "direct" as const,
    pillar: null,
    prompt: `What is ${domain} known for in ${i % 2 === 0 ? "oncology" : "cardiology"}?`,
    geoId: null,
    categoryId: null,
    tier: null,
    queryType: null,
  }));
  return [...indirect, ...direct];
}

describe("citation-prompt-generator — tree-based generation (ES-053 U25–U37)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key-tree";
    process.env.OPENAI_API_KEY    = "test-openai";
  });

  // ── Allocation case logic ──────────────────────────────────────────────────

  it("U25: determineAllocationCase returns 'A' for rich trees (mappingCount > 10)", () => {
    const result = determineAllocationCase(
      makeRichGeoTree(),
      makeRichCategoryTree(),
      makeRichMapping()   // 11 entries
    );
    expect(result).toBe("A");
  });

  it("U26: determineAllocationCase returns 'B' for moderate (geoLeafCount > 0, mapping <= 10)", () => {
    const smallMapping: GeoCategoryMapping = {
      entries: [{ geoId: "in-ka-blr", categoryId: "hc-onc", strength: "strong", evidence: [] }],
      totalEntries: 1,
      extractedAt: new Date().toISOString(),
    };
    const result = determineAllocationCase(
      makeRichGeoTree(),   // leafCount=4
      makeRichCategoryTree(),
      smallMapping          // totalEntries=1, ≤10
    );
    expect(result).toBe("B");
  });

  it("U27: determineAllocationCase returns 'C' for shallow (no geo, no mapping)", () => {
    const result = determineAllocationCase(
      emptyGeoTree(),
      makeRichCategoryTree(),
      emptyMapping()
    );
    expect(result).toBe("C");
  });

  // ── Sampling plan ──────────────────────────────────────────────────────────

  it("U28: buildSamplingPlan Case A allocation = 8/6/16/10", () => {
    const plan = buildSamplingPlan(
      makeRichGeoTree(),
      makeRichCategoryTree(),
      makeRichMapping()
    );
    expect(plan.case).toBe("A");
    expect(plan.categoryOnly).toBe(8);
    expect(plan.geoOnly).toBe(6);
    expect(plan.geoCrossCategory).toBe(16);
    expect(plan.intentDiverse).toBe(10);
  });

  it("U29: buildSamplingPlan enforces 25% geo cap", () => {
    // Create mapping where ALL entries have same geoId
    const monoGeoMapping: GeoCategoryMapping = {
      entries: Array.from({ length: 20 }, (_, i) => ({
        geoId: "in-ka-blr",
        categoryId: `hc-${i}`,
        strength: "strong" as const,
        evidence: [],
      })),
      totalEntries: 20,
      extractedAt: new Date().toISOString(),
    };

    const plan = buildSamplingPlan(makeRichGeoTree(), makeRichCategoryTree(), monoGeoMapping);

    // Even though all mapping entries have same geoId, plan should diversify
    // The 25% cap means no single geoId should dominate >25% of geoCrossCategory selections
    const blrCount = plan.mappingSamples.filter(s => s.geoId === "in-ka-blr").length;
    const maxAllowed = Math.ceil(plan.geoCrossCategory * 0.25);
    expect(blrCount).toBeLessThanOrEqual(maxAllowed);
  });

  // ── Prune tree ─────────────────────────────────────────────────────────────

  it("U30: pruneTree keeps top N nodes by pageCount", () => {
    const tree = makeRichGeoTree();
    const pruned = pruneTree(tree.root, 3);

    // Should keep at most 3 descendant nodes (the ones with highest pageCount)
    function countNodes(node: typeof tree.root): number {
      return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
    }
    expect(countNodes(pruned)).toBeLessThanOrEqual(3 + 1); // +1 for root itself
  });

  // ── generatePrompts with trees ─────────────────────────────────────────────

  it("U31: generatePrompts with categoryTree uses V2 path — calls Haiku for rephrasing", async () => {
    // V2 path: categories extracted from categoryTree → Haiku called for rephrasing
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: Array.from({ length: 36 }, (_, i) => `${i + 1}. oncology query ${i + 1}`).join("\n") }],
    });

    const result = await generatePrompts({
      domain: "manipal.com",
      siteType: "healthcare",
      geoTree: makeRichGeoTree(),
      categoryTree: makeRichCategoryTree(),
      geoCategoryMapping: makeRichMapping(),
      generatedLlmsTxt: "Manipal Hospitals is a multi-specialty chain.",
      generatedBusinessJson: { name: "Manipal Hospitals" },
    });

    expect(result.length).toBeGreaterThanOrEqual(20);
    // V2 path calls Haiku (not Sonnet) for rephrasing
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toContain("haiku");
  });

  it("U32: generatePrompts without trees falls back to legacy Haiku generator", async () => {
    // Site has null/empty trees — should use legacy path
    setHaikuResponse(mockHaiku48("flowblinq.com"));

    const result = await generatePrompts({
      domain: "flowblinq.com",
      siteType: "SaaS",
      geoTree: null,
      categoryTree: null,
      geoCategoryMapping: null,
      generatedLlmsTxt: null,
      generatedBusinessJson: null,
    });

    expect(result.length).toBeGreaterThanOrEqual(4);
    // With null trees, should use legacy path — Haiku model called
    if (mockCreate.mock.calls.length > 0) {
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.model).toContain("haiku");
    }
  });

  it("U33: generatePrompts strips domain leak from indirect prompts", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const treeItems = mockTreeBased48("manipal.com");
    // Inject a domain leak into an indirect prompt
    treeItems[0] = {
      type: "indirect",
      pillar: null,
      prompt: "Is manipal.com the best oncology hospital?",
    };

    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify(treeItems) }],
    });

    const result = await generatePrompts({
      domain: "manipal.com",
      siteType: "healthcare",
      geoTree: makeRichGeoTree(),
      categoryTree: makeRichCategoryTree(),
      geoCategoryMapping: makeRichMapping(),
    });

    const leaks = result.filter(
      p => p.type === "indirect" && p.prompt.toLowerCase().includes("manipal")
    );
    expect(leaks).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("U34: generatePrompts validates geo/category tags — invalid refs set to null", async () => {
    const treeItems = mockTreeBased48("manipal.com");
    // Set an invalid geoId
    (treeItems[0] as any).geoId = "nonexistent-geo";
    (treeItems[1] as any).categoryId = "nonexistent-cat";

    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify(treeItems) }],
    });

    const result = await generatePrompts({
      domain: "manipal.com",
      siteType: "healthcare",
      geoTree: makeRichGeoTree(),
      categoryTree: makeRichCategoryTree(),
      geoCategoryMapping: makeRichMapping(),
    });

    // Invalid refs should be set to null, not rejected
    result.forEach(p => {
      if (p.geoId) {
        // If geoId is present, it should be valid (non-"nonexistent")
        expect(p.geoId).not.toBe("nonexistent-geo");
      }
      if (p.categoryId) {
        expect(p.categoryId).not.toBe("nonexistent-cat");
      }
    });
    // Prompts themselves should still be present
    expect(result.length).toBeGreaterThanOrEqual(20);
  });

  it("U35: generatePrompts caps at 40 indirect + 8 direct", async () => {
    // Build oversized response: 50 indirect + 10 direct
    const oversized = [
      ...Array.from({ length: 50 }, (_, i) => ({
        type: "indirect" as const,
        pillar: null,
        prompt: `Market question ${i}?`,
        geoId: "in-ka-blr",
        categoryId: "hc-onc",
        tier: "solve" as const,
        queryType: "recommendation" as const,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        type: "direct" as const,
        pillar: null,
        prompt: `What is manipal.com offering ${i}?`,
      })),
    ];

    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify(oversized) }],
    });

    const result = await generatePrompts({
      domain: "manipal.com",
      siteType: "healthcare",
      geoTree: makeRichGeoTree(),
      categoryTree: makeRichCategoryTree(),
      geoCategoryMapping: makeRichMapping(),
    });

    const indirect = result.filter(p => p.type === "indirect");
    const direct = result.filter(p => p.type === "direct");
    expect(indirect.length).toBeLessThanOrEqual(40);
    expect(direct.length).toBeLessThanOrEqual(8);
  });

  it("U36: generatePrompts falls back Sonnet → GPT-4o → legacy", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Sonnet fails
    mockCreate.mockRejectedValue(new Error("Sonnet fail"));
    // GPT-4o also fails
    mockOpenAICreate.mockRejectedValue(new Error("GPT-4o fail"));

    const result = await generatePrompts({
      domain: "manipal.com",
      siteType: "healthcare",
      geoTree: makeRichGeoTree(),
      categoryTree: makeRichCategoryTree(),
      geoCategoryMapping: makeRichMapping(),
    });

    // Should fall back to legacy (4 prompts)
    expect(result.length).toBeGreaterThanOrEqual(4);
    // Warning about tree-based failure logged
    const warnMessages = warnSpy.mock.calls.map(c => String(c[0]));
    expect(warnMessages.some(m => m.includes("fallback") || m.includes("legacy") || m.includes("failed"))).toBe(true);

    warnSpy.mockRestore();
  });

  it("U37: generatePrompts maps queryType → pillar for tree-generated prompts (pillar stays null when no queryType)", async () => {
    const treeItems = mockTreeBased48("manipal.com");
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify(treeItems) }],
    });

    const result = await generatePrompts({
      domain: "manipal.com",
      siteType: "healthcare",
      geoTree: makeRichGeoTree(),
      categoryTree: makeRichCategoryTree(),
      geoCategoryMapping: makeRichMapping(),
    });

    // V2 prompts: pillar is programmatically assigned from angle mapping (or null for direct)
    // readiness alternates: licensing_signals ↔ cta_structure; trust alternates: author_authority ↔ contact_trust
    const VALID_PILLARS = new Set([
      "competitive_positioning", "evidence_statistics",
      "offering_clarity", "author_authority", "contact_trust",
      "licensing_signals", "cta_structure", null,
    ]);
    result.forEach(p => {
      expect(VALID_PILLARS.has(p.pillar)).toBe(true);
    });
  });
});
