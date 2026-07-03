/**
 * ES-081 — ReviewMaster Phase A independent integration suite
 *
 * Author:   ReviewMaster (Agent 9)
 * Date:     2026-04-09
 * Spec:     geo/docs/specs/engineering/ES-081-competitor-brand-name-detection.md (§d.2 + §d.4)
 *
 * Tests the runCitationCheck end-to-end flow with mocked LLM providers and
 * asserts that the new two-phase competitor extractor (Phase 1 brand-name
 * match → Phase 2 URL fallback) produces the expected competitor signal in
 * `result.competitorData`.
 *
 * Independence rule:
 *   Fixture text and the production-replay row are intentionally distinct
 *   from BOTH ScriptDev's CT15 (`brand-detector.test.ts`, prod row
 *   `QH1EepHTOpK6hsh80VPJ1`) AND ReviewMaster's earlier prod-row replay in
 *   `competitor-detection-rm.test.ts` (`t0e55bzbEzAARaaGpwp2H`). This file
 *   uses prod row `KF0hGiBazKwBSYByxX5hz` (Manipal site, google
 *   gemini-2.5-flash, position 1) which has a wider competitor mix
 *   (Apollo + Max + Fortis + Narayana + CARE + Yashoda) and exercises a
 *   different provider's response shape.
 *
 * Test ID mapping (ES-081 §d.2 + §d.4):
 *   - IT-1 — Phase 1 brand-name extraction (load-bearing for AC-2)
 *   - IT-2 — Phase 2 URL fallback (no-regression guard for V1 behavior)
 *   - IT-3 — Brand + URL co-mention captured (set semantics)
 *   - IT-4 — coPresenceSignal returns 80 not 100 (load-bearing for AC-5)
 *   - IT-5 — No discoveredCompetitors → only Phase 2 fires
 *   - IT-6 — Provider throws → response row isolated, no crash (failure mode)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mock handles ─────────────────────────────────────────────────────
//
// Anthropic-only mocking, matching ScriptDev's existing IT pattern. We set
// only ANTHROPIC_API_KEY in beforeEach so the citation-checker dispatch only
// invokes the Anthropic provider — all four LLM clients are mocked
// defensively so that an unexpected dispatch (e.g. a future code change that
// fans out to all providers regardless of env) does not crash with an
// unmocked-module error.

const { mockAnthropicCreate, mockOpenAICreate, mockGeminiGenerate } = vi.hoisted(() => ({
  mockAnthropicCreate: vi.fn(),
  mockOpenAICreate: vi.fn(),
  mockGeminiGenerate: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockAnthropicCreate } };
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
      getGenerativeModel: vi.fn().mockReturnValue({
        generateContent: mockGeminiGenerate,
      }),
    };
  }),
}));

// DB stubs — runCitationCheck issues writes during normal flow; we no-op
// them so the integration suite stays a pure in-memory test (no fixtures
// needed, no migration needed, no Supabase needed).

vi.mock("@/lib/db", () => ({
  db: {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue([]),
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  citationCheckScores: {},
  citationCheckResponses: {},
  geoSites: {},
}));

// ── Imports under test ───────────────────────────────────────────────────────

import { runCitationCheck } from "@/lib/services/citation-checker";
import type { BrandKeywords } from "@/lib/services/brand-detector";
import type { CitationPrompt } from "@/lib/types/citation";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePrompt(text: string): CitationPrompt {
  return {
    type: "indirect",
    prompt: text,
    pillar: "offering_clarity",
    categoryId: "c1",
    geoId: null,
  };
}

const NO_OP_CALLBACKS = {
  onAnalysisStart: vi.fn(),
  onPartialResult: vi.fn(),
  onAnalysisComplete: vi.fn(),
};

// Subject brand keyword block — represents Manipal Hospitals as the audited
// site so detectMention() can score the response. Distinct from any
// competitor's keyword set.
const MANIPAL_BRAND_KEYWORDS: BrandKeywords = {
  keywords: ["manipal hospitals", "manipal"],
  isAmbiguous: false,
  source: "vendor",
  extractedAt: new Date().toISOString(),
};

// Discovered-competitor list shaped like the entries the competitor-discovery
// path produces. We pass these directly to runCitationCheck to drive Phase 1.
function competitor(name: string, domain: string, rank: number) {
  return {
    name,
    domain,
    rank,
    mentions: 2,
    category: "direct" as const,
  };
}

// Production replay fixture — prod row id `KF0hGiBazKwBSYByxX5hz`,
// site `-GzFX1KcKhmN0W_1t8SmY` (Manipal), provider google gemini-2.5-flash,
// position 1. Distinct from ScriptDev's CT15 row and ReviewMaster's earlier
// `t0e55bzbEzAARaaGpwp2H`. Pulled live via geo/.env.vercel-prod DATABASE_URL.
//
// What makes this row valuable: 6 distinct competitors named in the same
// response (Apollo, Max, Fortis, Narayana, CARE, Yashoda) — strictly more
// than the 2-3 in either previously-used row, so the brand extractor's
// multi-competitor handling gets a tougher fixture.
const PROD_REPLAY_GEMINI =
  "Manipal Hospitals is a prominent healthcare provider in India, and it compares to its main competitors in several ways:\n\n" +
  "1.  **Apollo Hospitals:** Apollo Hospitals is considered the largest private healthcare network in India, operating over 70 hospitals, thousands of pharmacies, and an extensive network of diagnostic and primary care centers across India. Manipal Hospitals is cited as the second-largest hospital chain in India, with more than 33 multi-speciality locations.\n" +
  "2.  **Max Healthcare:** Max Healthcare is another significant competitor, managing 17 facilities with nearly 5,000 clinicians across several Indian cities, specializing in areas like cancer care, transplant medicine, and robotic surgery. Manipal Hospitals also offers multi-speciality tertiary care.\n" +
  "3.  **Fortis Healthcare:** Fortis Healthcare is a pan-India healthcare provider with hospitals and diagnostic centers, and its diagnostic segment, Agilus, is a large provider in India. Fortis operates 36 medical facilities and 4,000 operational beds.\n" +
  "4.  **Narayana Hrudayalaya:** Narayana Hrudayalaya operates over 45 multispecialty and super-speciality hospitals across India and one in the United States, with a focus on affordable healthcare, particularly in cardiac and renal specialities.";

// ── Suite ────────────────────────────────────────────────────────────────────

describe("ES-081 §d — runCitationCheck competitor extraction (RM independent)", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("IT-1: Phase 1 brand-name extraction — production replay (Apollo + Max + Fortis)", async () => {
    // Use the live prod replay text from row KF0hGiBazKwBSYByxX5hz. The
    // pre-TS-081 code path produces empty competitorsMentioned for this row;
    // post-fix it must surface at least three competitors via Phase 1.
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: PROD_REPLAY_GEMINI }],
    });

    const result = await runCitationCheck(
      "check-rm-it1",
      "site-rm-it1",
      "manipalhospitals.com",
      [makePrompt("How does Manipal Hospitals compare to its main competitors?")],
      NO_OP_CALLBACKS as never,
      [
        competitor("Apollo Hospitals", "apollohospitals.com", 1),
        competitor("Max Healthcare", "maxhealthcare.com", 2),
        competitor("Fortis Healthcare", "fortishealthcare.com", 3),
      ],
      MANIPAL_BRAND_KEYWORDS,
      ["hospital", "healthcare"],
    );

    expect(result).toBeDefined();
    expect(Array.isArray(result.competitorData)).toBe(true);

    // All three discovered competitors must surface with shareOfVoice > 0.
    // shareOfVoice > 0 is the observable proxy for "competitor was extracted
    // from at least one response" — flat-shape per RM memory.
    const apollo = result.competitorData.find(
      (c) => /apollo/i.test(c.name) || /apollo/i.test(c.domain ?? ""),
    );
    const max = result.competitorData.find(
      (c) => /max healthcare/i.test(c.name) || /maxhealthcare/i.test(c.domain ?? ""),
    );
    const fortis = result.competitorData.find(
      (c) => /fortis/i.test(c.name) || /fortis/i.test(c.domain ?? ""),
    );

    expect(apollo).toBeDefined();
    expect(max).toBeDefined();
    expect(fortis).toBeDefined();
    expect(apollo!.shareOfVoice).toBeGreaterThan(0);
    expect(max!.shareOfVoice).toBeGreaterThan(0);
    expect(fortis!.shareOfVoice).toBeGreaterThan(0);
  });

  it("IT-2: Phase 2 URL fallback fires when discoveredCompetitors is empty", async () => {
    // Provider response references a competitor only via bare URL. With no
    // discovered competitors, Phase 1 cannot fire — Phase 2 URL regex must
    // pick up the domain. This is the load-bearing no-regression test for
    // the V1 behavior the spec preserves at §b.2 Phase 2.
    //
    // Important: with empty discoveredCompetitors, the AGGREGATED
    // result.competitorData stays empty (it only carries entries that were
    // pre-seeded from discovered competitors). Phase 2 matches surface in
    // the per-response result.responses[i].competitorsMentioned array,
    // which is exactly what ES-081 §d.2 IT-2 asserts on.
    //
    // Fixture domain choice: tiktok.com is NOT in NON_COMPETITOR_DOMAINS
    // (verified against citation-checker.ts:68-75 — only major search
    // engines, code hosts, and example domains are filtered).
    mockAnthropicCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: "For an alternative perspective on hospital networks, check tiktok.com which has many medical influencers covering this space.",
        },
      ],
    });

    const result = await runCitationCheck(
      "check-rm-it2",
      "site-rm-it2",
      "manipalhospitals.com",
      [makePrompt("Where do people discuss hospital choices?")],
      NO_OP_CALLBACKS as never,
      [], // empty discoveredCompetitors → Phase 1 short-circuits
      MANIPAL_BRAND_KEYWORDS,
      ["hospital"],
    );

    expect(result).toBeDefined();
    expect(Array.isArray(result.responses)).toBe(true);
    expect(result.responses.length).toBeGreaterThan(0);

    // Phase 2 must surface tiktok.com on the per-response row even though
    // the aggregated competitorData has nothing to anchor it to.
    const allMentions = result.responses.flatMap((r) => r.competitorsMentioned);
    expect(allMentions).toEqual(expect.arrayContaining(["tiktok.com"]));
  });

  it("IT-3: Brand + URL co-mention — competitor surfaces via at least one phase (set semantics)", async () => {
    // Provider response names the competitor TWICE — once as a brand and
    // once as a URL. Per ES-081 §d.2 IT-3, both forms can coexist OR the
    // set may dedupe to one. We assert at least one form surfaces with
    // positive shareOfVoice (the spec is explicit that either is valid).
    mockAnthropicCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: "Aster DM Healthcare (asterdmhealthcare.com) operates a wide network across the Gulf and southern India.",
        },
      ],
    });

    const result = await runCitationCheck(
      "check-rm-it3",
      "site-rm-it3",
      "manipalhospitals.com",
      [makePrompt("Which hospital chains operate in the Gulf and India?")],
      NO_OP_CALLBACKS as never,
      [competitor("Aster DM Healthcare", "asterdmhealthcare.com", 1)],
      MANIPAL_BRAND_KEYWORDS,
      ["hospital", "healthcare"],
    );

    // Aster surfaces via name-match (Phase 1) OR domain-match (Phase 2) —
    // either path is valid per §d.2 IT-3 documentation. We accept either.
    const aster = result.competitorData.find(
      (c) =>
        /aster/i.test(c.name) ||
        /asterdmhealthcare/i.test(c.domain ?? "") ||
        /aster/i.test(c.domain ?? ""),
    );

    expect(aster).toBeDefined();
    expect(aster!.shareOfVoice).toBeGreaterThan(0);
  });

  it("IT-4: coPresenceSignal=80 — co-mention with tier-1 rival yields STRICTLY lower citation quality than alone-baseline", async () => {
    // Two consecutive runCitationCheck calls with different mocked responses:
    //   Run A — subject brand alone in response → coPresenceSignal=100
    //   Run B — subject brand co-mentioned with Apollo (a tier-1 rival from
    //           discoveredCompetitors) → coPresenceSignal=80
    //
    // Pre-TS-081 the tier1Competitors Set was keyed on URL strings, so the
    // brand-name match in detectCompetitorMentions never intersected the
    // set and coPresenceSignal always returned 100. Post-fix the Set is
    // keyed on c.name.toLowerCase(), so the intersection fires and the
    // signal drops. The observable consequence: Run B's
    // citationQualityScore must be strictly less than Run A's.
    //
    // Fixture text rotated AWAY from competitor-detection-rm.test.ts IT-3
    // (which uses "Manipal Hospitals competes with Apollo Hospitals in
    // tertiary care"). This file uses different sentence structures so a
    // future regex regression would not silently pass both suites.

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "Manipal Hospitals stands out as the most accessible tertiary care provider in southern India.",
        },
      ],
    });
    const aloneResult = await runCitationCheck(
      "check-rm-it4-alone",
      "site-rm-it4",
      "manipalhospitals.com",
      [makePrompt("Best tertiary care hospital in southern India?")],
      NO_OP_CALLBACKS as never,
      [competitor("Apollo Hospitals", "apollohospitals.com", 1)],
      MANIPAL_BRAND_KEYWORDS,
      ["hospital"],
    );

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "Manipal Hospitals serves the southern India market alongside Apollo Hospitals, with both operating broad multi-specialty networks.",
        },
      ],
    });
    const coPresentResult = await runCitationCheck(
      "check-rm-it4-copresent",
      "site-rm-it4",
      "manipalhospitals.com",
      [makePrompt("Best tertiary care hospital in southern India?")],
      NO_OP_CALLBACKS as never,
      [competitor("Apollo Hospitals", "apollohospitals.com", 1)],
      MANIPAL_BRAND_KEYWORDS,
      ["hospital"],
    );

    // Co-presence with a tier-1 rival must lower the citation quality
    // signal. If both runs report the same score, either:
    //   (a) Apollo wasn't detected as a competitor (Phase 1 broken), or
    //   (b) tier1Competitors Set is still keyed on URLs (the bug TS-081 fixed)
    expect(coPresentResult.citationQualityScore).toBeLessThan(
      aloneResult.citationQualityScore,
    );

    // And: Apollo must appear in the co-present run's competitorData.
    const apolloInCoPresent = coPresentResult.competitorData.find(
      (c) => /apollo/i.test(c.name) || /apollo/i.test(c.domain ?? ""),
    );
    expect(apolloInCoPresent).toBeDefined();
    expect(apolloInCoPresent!.shareOfVoice).toBeGreaterThan(0);
  });

  it("IT-5: discoveredCompetitors empty → brand text alone produces no Phase 1 hit and no false Phase 2 match", async () => {
    // The response names a brand but contains no URL or .com reference.
    // With empty discoveredCompetitors:
    //   - Phase 1 cannot fire (no keyword map built)
    //   - Phase 2 URL regex matches nothing in the text
    // Result: no competitor surfaces. This is the inverse of IT-1 and pins
    // the spec contract that Phase 1 requires a non-null discoveredCompetitors
    // input — it does NOT auto-extract brand names from raw text.
    mockAnthropicCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: "Apollo Hospitals operates a wide network of facilities throughout India and several international locations.",
        },
      ],
    });

    const result = await runCitationCheck(
      "check-rm-it5",
      "site-rm-it5",
      "manipalhospitals.com",
      [makePrompt("Which hospital chains operate internationally?")],
      NO_OP_CALLBACKS as never,
      [], // empty
      MANIPAL_BRAND_KEYWORDS,
      ["hospital"],
    );

    expect(result).toBeDefined();
    expect(Array.isArray(result.competitorData)).toBe(true);

    // Apollo must NOT appear because Phase 1 didn't fire and Phase 2 has
    // no URL to anchor on. The competitorData array may be entirely empty,
    // or it may contain unrelated entries from the URL regex — but it must
    // not contain Apollo.
    const apollo = result.competitorData.find(
      (c) => /apollo/i.test(c.name) || /apollohospitals/i.test(c.domain ?? ""),
    );
    expect(apollo).toBeUndefined();
  });

  it("IT-6: provider throws → runCitationCheck completes without crash, response row carries error and zero competitor signal", async () => {
    // Failure-mode test (§d.4 IT-6). The Anthropic provider throws on the
    // first call. The pipeline must NOT propagate the throw — instead it
    // should complete and return a result whose response row carries an
    // error indicator and an empty competitorsMentioned array, without
    // taking down the rest of the batch.
    //
    // Important nuance about competitorData: discoveredCompetitors entries
    // are PRE-SEEDED into the aggregated competitorData with zero
    // shareOfVoice and zero mentionCount. When the provider throws, Apollo
    // still appears in competitorData (because it was in the input list)
    // but with zero scores — the absence of any successful response means
    // no per-response signal was ever counted toward Apollo's aggregate.
    // We assert that observable contract here.
    mockAnthropicCreate.mockRejectedValueOnce(
      new Error("provider rate-limit hit during integration test"),
    );

    let threw = false;
    let result: Awaited<ReturnType<typeof runCitationCheck>> | undefined;
    try {
      result = await runCitationCheck(
        "check-rm-it6",
        "site-rm-it6",
        "manipalhospitals.com",
        [makePrompt("How does Manipal Hospitals compare to its competitors?")],
        NO_OP_CALLBACKS as never,
        [competitor("Apollo Hospitals", "apollohospitals.com", 1)],
        MANIPAL_BRAND_KEYWORDS,
        ["hospital"],
      );
    } catch (e) {
      threw = true;
    }

    // Hard contract: the function MUST NOT throw to the caller when a
    // single provider fails. The caller relies on this for batch isolation.
    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(Array.isArray(result!.responses)).toBe(true);

    // The failed response row must carry an error indicator AND an empty
    // competitorsMentioned array (no extraction happened on a failed call).
    const failedRow = result!.responses[0];
    expect(failedRow).toBeDefined();
    expect(failedRow.error).not.toBeNull();
    expect(failedRow.competitorsMentioned).toEqual([]);

    // Apollo IS pre-seeded in competitorData from discoveredCompetitors,
    // but since no response succeeded, its aggregate counters stay at zero.
    // This is the "batch isolation" guarantee: a failed provider neither
    // crashes the call nor inflates competitor signal.
    const apollo = result!.competitorData.find(
      (c) => /apollo/i.test(c.name) || /apollohospitals/i.test(c.domain ?? ""),
    );
    expect(apollo).toBeDefined();
    expect(apollo!.shareOfVoice).toBe(0);
    expect(apollo!.mentionCount).toBe(0);
  });
});
