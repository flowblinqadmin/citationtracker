/**
 * ES-082 Phase A — content-generator.ts llms.txt generation tests (U1-U14)
 *
 * Author:   ReviewMaster (Agent 9)
 * Date:     2026-04-09
 * Spec:     geo/docs/specs/engineering/ES-082-llms-txt-empty-generation-fix.md (§c.1, §b.2, §b.3)
 *
 * RED-state expectations (delivered before ScriptDev's fix):
 *   - U2, U3, U14, U6, U7  → fail until Direction A lands
 *                            (LlmsGenerationLengthExhausted, 8000-token bump,
 *                            reasoning-share warning)
 *   - U8-U13               → SKIPPED via skipIf until ScriptDev exports
 *                            buildShortLlmsTxtPrompt via __test_internals
 *                            (Direction B prompt builder)
 *   - U1, U4, U5           → pass on current implementation (happy paths +
 *                            negative guards that work either way)
 *
 * Independence rule (Phase A):
 *   - Fixture identifier `manipal-fixture-rm`, NOT the literal site ID
 *     `-GzFX1KcKhmN0W_1t8SmY` ScriptDev source uses.
 *   - Fixture is the synthetic mirror at `__tests__/fixtures/manipal-site.json`.
 *     ScriptDev replaces with redacted production extract during Phase B —
 *     U9 snapshot must be regenerated then.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockOpenAICreate } = vi.hoisted(() => ({
  mockOpenAICreate: vi.fn(),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockOpenAICreate } } };
  }),
}));

// ── Imports under test ───────────────────────────────────────────────────────
//
// Use a namespace import so missing exports (Direction A error class,
// Direction B __test_internals) resolve to `undefined` instead of failing
// to load the module. Tests that depend on missing exports skipIf-gate
// themselves so the file still runs cleanly.

import * as contentGen from "@/lib/services/content-generator";
const { generateLlmsTxt } = contentGen;

const LlmsGenerationLengthExhausted =
  (contentGen as unknown as { LlmsGenerationLengthExhausted?: new (...a: any[]) => Error })
    .LlmsGenerationLengthExhausted;

const __test_internals =
  (contentGen as unknown as {
    __test_internals?: {
      buildShortLlmsTxtPrompt?: (args: {
        domain: string;
        context: string;
        improvements: string;
        geoScorecard: unknown;
        pagesWithFaq: string[];
        hasNamedTeam: boolean;
        hasEvidence: boolean;
        freshnessScore: number;
      }) => { system: string; user: string };
    };
  }).__test_internals;

const buildShortLlmsTxtPrompt = __test_internals?.buildShortLlmsTxtPrompt;

// ── Fixture loader ───────────────────────────────────────────────────────────

const FIXTURE_PATH = resolve(__dirname, "..", "fixtures", "manipal-site.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as {
  id: string;
  domain: string;
  crawlData: { domain: string; pages: any[]; totalCrawled: number };
  geoScorecard: { overallScore: number; pillars: any[]; topThreeImprovements: string[] };
  generatedLlmsFullTxt: string;
};

// ── OpenAI response builder ──────────────────────────────────────────────────

interface MockOpenAIArgs {
  content: string;
  finishReason?: string;
  completionTokens?: number;
  reasoningTokens?: number;
}

function mockOpenAIResponse(args: MockOpenAIArgs) {
  return {
    choices: [
      {
        message: { content: args.content },
        finish_reason: args.finishReason ?? "stop",
      },
    ],
    usage: {
      completion_tokens: args.completionTokens ?? args.content.length / 4,
      completion_tokens_details: {
        reasoning_tokens: args.reasoningTokens ?? 0,
      },
    },
  };
}

// Realistic safe content with no hallucinated entities — uses ONLY entities
// present in the fixture (info@manipalhospitals.com, +91-80-2222-1111,
// manipalhospitals.com, Dr Anil Kumar / Priya Raghavan / Ravi Menon).
//
// verifyAndCorrectContent runs at the end of generateLlmsTxt and would call
// OpenAI a second time if it found hallucinated entities. By keeping our
// mock content entity-clean, we avoid that second call entirely and isolate
// the unit-under-test to the short/full generation pair.
const SAFE_SHORT = [
  "# Manipal Hospitals",
  "> Manipal Hospitals is one of India's largest multi-specialty hospital networks.",
  "",
  "## About",
  "Manipal Hospitals operates 33 hospitals across 17 cities in India.",
  "",
  "## Products/Services",
  "- Cardiac Sciences",
  "- Oncology",
  "- Neurosciences",
  "",
  "## Key Concepts",
  "**Quaternary Care**: refers to highly specialised consultative care.",
].join("\n");

const SAFE_FULL = SAFE_SHORT + "\n\n## Content\n- Cardiac Sciences overview\n";

function setupHappyPathOpenAIMock() {
  mockOpenAICreate.mockImplementation(async (req: any) => {
    const userMsg: string = req?.messages?.find((m: any) => m.role === "user")?.content ?? "";
    const isFullCall = userMsg.includes("comprehensive llms-full.txt");
    return mockOpenAIResponse({
      content: isFullCall ? SAFE_FULL : SAFE_SHORT,
      finishReason: "stop",
      completionTokens: 800,
      reasoningTokens: 0,
    });
  });
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY = "test-key";
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
});

// ═══════════════════════════════════════════════════════════════════════════
// Group A — happy path + Direction A throw semantics (U1-U7)
// ═══════════════════════════════════════════════════════════════════════════

describe("ES-082 §c.1 — generateLlmsTxt: Direction A guards (RM independent)", () => {
  it("U1: returns valid result on happy path (≥200 chars, # H1, > blockquote)", async () => {
    setupHappyPathOpenAIMock();

    const result = await generateLlmsTxt(
      fixture.domain,
      fixture.crawlData as never,
      fixture.geoScorecard as never,
    );

    expect(result.llmsTxt.length).toBeGreaterThan(200);
    expect(result.llmsTxt).toMatch(/^#\s+\S/m);
    expect(result.llmsTxt).toMatch(/^>\s+\S/m);
    expect(result.llmsFullTxt.length).toBeGreaterThan(0);
  });

  describe.skipIf(!LlmsGenerationLengthExhausted)("Direction A error class", () => {
    it("U2: throws LlmsGenerationLengthExhausted on short call empty + finish_reason=length", async () => {
      mockOpenAICreate.mockImplementation(async (req: any) => {
        const userMsg: string = req?.messages?.find((m: any) => m.role === "user")?.content ?? "";
        const isFullCall = userMsg.includes("comprehensive llms-full.txt");
        if (isFullCall) {
          return mockOpenAIResponse({
            content: SAFE_FULL,
            finishReason: "stop",
            completionTokens: 800,
            reasoningTokens: 0,
          });
        }
        // short call: empty + length
        return mockOpenAIResponse({
          content: "",
          finishReason: "length",
          completionTokens: 8000,
          reasoningTokens: 8000,
        });
      });

      await expect(
        generateLlmsTxt(fixture.domain, fixture.crawlData as never, fixture.geoScorecard as never),
      ).rejects.toThrow(LlmsGenerationLengthExhausted as any);

      // Detailed field assertions on the thrown error
      let caught: any;
      try {
        await generateLlmsTxt(fixture.domain, fixture.crawlData as never, fixture.geoScorecard as never);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(LlmsGenerationLengthExhausted as any);
      expect(caught.call).toBe("short");
      expect(caught.finishReason).toBe("length");
      expect(caught.reasoningTokens).toBe(8000);
    });

    it("U3: throws LlmsGenerationLengthExhausted on full call empty + finish_reason=length", async () => {
      mockOpenAICreate.mockImplementation(async (req: any) => {
        const userMsg: string = req?.messages?.find((m: any) => m.role === "user")?.content ?? "";
        const isFullCall = userMsg.includes("comprehensive llms-full.txt");
        if (isFullCall) {
          return mockOpenAIResponse({
            content: "",
            finishReason: "length",
            completionTokens: 6000,
            reasoningTokens: 6000,
          });
        }
        return mockOpenAIResponse({
          content: SAFE_SHORT,
          finishReason: "stop",
          completionTokens: 800,
          reasoningTokens: 0,
        });
      });

      let caught: any;
      try {
        await generateLlmsTxt(fixture.domain, fixture.crawlData as never, fixture.geoScorecard as never);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(LlmsGenerationLengthExhausted as any);
      expect(caught.call).toBe("full");
    });
  });

  it("U4: does NOT throw when content is empty but finish_reason='stop' (model legitimately empty)", async () => {
    // Direction A only catches the length-exhaustion combo. An empty result
    // with finish_reason="stop" is the model's choice, not a budget burn —
    // generateLlmsTxt should return it (downstream validators in the
    // pipeline-stage handler catch this separately via length check).
    mockOpenAICreate.mockImplementation(async () => {
      return mockOpenAIResponse({
        content: "",
        finishReason: "stop",
        completionTokens: 0,
        reasoningTokens: 0,
      });
    });

    await expect(
      generateLlmsTxt(fixture.domain, fixture.crawlData as never, fixture.geoScorecard as never),
    ).resolves.toBeDefined();
  });

  it("U5: does NOT throw when content is non-empty even if finish_reason='length' (truncated mid-output)", async () => {
    // Model hit the budget mid-stream but still emitted content. The error
    // is ONLY for the empty-and-length combo per ES-082 §b.2 Change 2.
    mockOpenAICreate.mockImplementation(async (req: any) => {
      const userMsg: string = req?.messages?.find((m: any) => m.role === "user")?.content ?? "";
      const isFullCall = userMsg.includes("comprehensive llms-full.txt");
      return mockOpenAIResponse({
        content: isFullCall ? SAFE_FULL : SAFE_SHORT,
        finishReason: "length",
        completionTokens: 2000,
        reasoningTokens: 0,
      });
    });

    const result = await generateLlmsTxt(
      fixture.domain,
      fixture.crawlData as never,
      fixture.geoScorecard as never,
    );
    expect(result.llmsTxt.length).toBeGreaterThan(0);
  });

  it("U6: emits llms_short_high_reasoning_share warning when reasoning > 70% of completion", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockOpenAICreate.mockImplementation(async (req: any) => {
      const userMsg: string = req?.messages?.find((m: any) => m.role === "user")?.content ?? "";
      const isFullCall = userMsg.includes("comprehensive llms-full.txt");
      // 80% reasoning ratio on the short call
      return mockOpenAIResponse({
        content: isFullCall ? SAFE_FULL : SAFE_SHORT,
        finishReason: "stop",
        completionTokens: 1000,
        reasoningTokens: isFullCall ? 0 : 800,
      });
    });

    await generateLlmsTxt(
      fixture.domain,
      fixture.crawlData as never,
      fixture.geoScorecard as never,
    );

    const warnCalls = warnSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("llms_short_high_reasoning_share"));

    expect(warnCalls.length).toBeGreaterThan(0);
    const payload = JSON.parse(warnCalls[0]);
    expect(payload.event).toBe("llms_short_high_reasoning_share");
    expect(payload.ratio).toBeCloseTo(0.8, 1);

    warnSpy.mockRestore();
  });

  it("U7: does NOT emit reasoning warning when ratio is exactly 70% (boundary)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockOpenAICreate.mockImplementation(async (req: any) => {
      const userMsg: string = req?.messages?.find((m: any) => m.role === "user")?.content ?? "";
      const isFullCall = userMsg.includes("comprehensive llms-full.txt");
      return mockOpenAIResponse({
        content: isFullCall ? SAFE_FULL : SAFE_SHORT,
        finishReason: "stop",
        completionTokens: 1000,
        reasoningTokens: 700, // exactly 70%
      });
    });

    await generateLlmsTxt(
      fixture.domain,
      fixture.crawlData as never,
      fixture.geoScorecard as never,
    );

    const warnCalls = warnSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("llms_short_high_reasoning_share"));

    // Spec §b.2 Change 3: condition is `> 0.7`, so exactly 0.7 must NOT fire.
    expect(warnCalls.length).toBe(0);

    warnSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group B — Direction B prompt builder (U8-U13)
//
// All gated on the __test_internals export from content-generator.ts.
// Spec §b.3 introduces buildShortLlmsTxtPrompt as a module-private helper;
// ScriptDev exports it via `__test_internals` for unit-test access.
// Until then these tests skip cleanly.
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!buildShortLlmsTxtPrompt)("ES-082 §c.1 — Direction B prompt builder (RM independent)", () => {
  function makeArgs(overrides: Partial<{
    geoScorecard: any;
    pagesWithFaq: string[];
    hasNamedTeam: boolean;
    hasEvidence: boolean;
    freshnessScore: number;
  }> = {}) {
    return {
      domain: "manipalhospitals.com",
      context: "Manipal Hospitals is a multi-specialty hospital network.",
      improvements: "Add MedicalSpecialty schema; expand FAQ; add AI bot directives",
      geoScorecard: overrides.geoScorecard ?? fixture.geoScorecard,
      pagesWithFaq: overrides.pagesWithFaq ?? [],
      hasNamedTeam: overrides.hasNamedTeam ?? false,
      hasEvidence: overrides.hasEvidence ?? false,
      freshnessScore: overrides.freshnessScore ?? 70,
    };
  }

  it("U8: prompt is flat — contains no conditional 'if X then' language", () => {
    const { user } = buildShortLlmsTxtPrompt!(makeArgs());
    // Spec §b.3 + TS-082 §2.2: the whole point of Direction B is that the
    // model never sees conditional language. All branching is pre-resolved
    // in TypeScript. Prompt must contain no substring matching the patterns
    // that trigger reasoning-mode planning.
    expect(user).not.toMatch(/\bif\b/i);
    expect(user).not.toMatch(/\bunless\b/i);
    expect(user).not.toMatch(/\botherwise\b/i);
    expect(user).not.toMatch(/\bonly include if\b/i);
  });

  it("U9: snapshot of rendered Direction B user prompt (synthetic Manipal fixture)", () => {
    // Snapshot test against the synthetic fixture. ScriptDev will need to
    // regenerate this snapshot if/when the fixture is replaced with a
    // production extract — flagged in __rm_synthetic field of the fixture.
    const { user } = buildShortLlmsTxtPrompt!(
      makeArgs({
        pagesWithFaq: [
          "https://www.manipalhospitals.com/specialties/cardiac-sciences/",
          "https://www.manipalhospitals.com/specialties/oncology/",
        ],
        hasNamedTeam: true,
        hasEvidence: true,
        freshnessScore: 45,
      }),
    );
    expect(user).toMatchSnapshot();
  });

  it("U10: pillar-aware customization — entity_definitions < 75 → '5-8' terms, ≥ 75 → '3-5' terms", () => {
    const lowScorecard = {
      ...fixture.geoScorecard,
      pillars: [{ pillar: "entity_definitions", pillarName: "Entity Definitions", score: 50, findings: "", recommendation: "", priority: "high", impactedPages: [] }],
    };
    const highScorecard = {
      ...fixture.geoScorecard,
      pillars: [{ pillar: "entity_definitions", pillarName: "Entity Definitions", score: 90, findings: "", recommendation: "", priority: "low", impactedPages: [] }],
    };

    const lowPrompt = buildShortLlmsTxtPrompt!(makeArgs({ geoScorecard: lowScorecard }));
    const highPrompt = buildShortLlmsTxtPrompt!(makeArgs({ geoScorecard: highScorecard }));

    expect(lowPrompt.user).toContain("5-8");
    expect(highPrompt.user).toContain("3-5");
  });

  it("U11: Team section appears only when hasNamedTeam=true", () => {
    const withTeam = buildShortLlmsTxtPrompt!(makeArgs({ hasNamedTeam: true }));
    const withoutTeam = buildShortLlmsTxtPrompt!(makeArgs({ hasNamedTeam: false }));

    expect(withTeam.user).toContain("## Team");
    expect(withoutTeam.user).not.toContain("## Team");
  });

  it("U12: Evidence section appears only when hasEvidence=true", () => {
    const withEvidence = buildShortLlmsTxtPrompt!(makeArgs({ hasEvidence: true }));
    const withoutEvidence = buildShortLlmsTxtPrompt!(makeArgs({ hasEvidence: false }));

    expect(withEvidence.user).toContain("## Evidence");
    expect(withoutEvidence.user).not.toContain("## Evidence");
  });

  it("U13: FAQ section appears only when pagesWithFaq is non-empty + lists URLs as bullets", () => {
    const withFaq = buildShortLlmsTxtPrompt!(
      makeArgs({
        pagesWithFaq: [
          "https://www.manipalhospitals.com/specialties/cardiac-sciences/",
          "https://www.manipalhospitals.com/specialties/oncology/",
        ],
      }),
    );
    const withoutFaq = buildShortLlmsTxtPrompt!(makeArgs({ pagesWithFaq: [] }));

    expect(withFaq.user).toContain("## FAQ");
    expect(withFaq.user).toContain("https://www.manipalhospitals.com/specialties/cardiac-sciences/");
    expect(withoutFaq.user).not.toContain("## FAQ");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group C — Direction A token bump (U14)
// ═══════════════════════════════════════════════════════════════════════════

describe("ES-082 §c.1 — generateLlmsTxt: Direction A token bump (RM independent)", () => {
  it("U14: short-call max_completion_tokens is 8000 (was 2000 pre-fix)", async () => {
    setupHappyPathOpenAIMock();

    await generateLlmsTxt(
      fixture.domain,
      fixture.crawlData as never,
      fixture.geoScorecard as never,
    );

    // Capture all create() calls and find the short call (the one whose user
    // message does NOT contain "comprehensive llms-full.txt").
    const calls = mockOpenAICreate.mock.calls.map((c) => c[0] as any);
    const shortCall = calls.find((req) => {
      const userMsg: string = req?.messages?.find((m: any) => m.role === "user")?.content ?? "";
      return !userMsg.includes("comprehensive llms-full.txt");
    });

    expect(shortCall).toBeDefined();
    expect(shortCall.max_completion_tokens).toBe(8000);
  });
});
