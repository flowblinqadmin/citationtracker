/**
 * TS-081 — Phase A: Independent test suite for competitor brand-name detection
 *
 * Author:   ReviewMaster (Agent 9)
 * Date:     2026-04-08
 * Spec:     geo/docs/specs/technical/TS-081-competitor-brand-name-detection.md
 *
 * Independence rule (Phase A discipline):
 *   This test file was written from TS-081 ONLY. The implementation files
 *   `lib/services/brand-detector.ts`, `lib/services/citation-checker.ts`,
 *   `lib/services/competitor-discovery.ts`, and the sibling test file
 *   `__tests__/services/brand-detector.test.ts` (CoFounder's tests) were
 *   not read while these tests were authored. Any overlap with CoFounder's
 *   suite is therefore convergent, not anchored.
 *
 * Tests run RED first. CoFounder runs them against the implementation
 * after Phase 2; failures feed back to ReviewMaster for triage.
 *
 * Production replay fixture: prod row id `t0e55bzbEzAARaaGpwp2H`
 *   (site_id = '-GzFX1KcKhmN0W_1t8SmY' / Manipal, openai gpt-5.4-mini).
 *   Distinct from CoFounder's CT15 row `QH1EepHTOpK6hsh80VPJ1` per the
 *   "DIFFERENT row" requirement in the activation message.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mock handles (used by IT block) ──────────────────────────────────

const { mockCreate, mockOpenAICreate, mockGeminiGenerate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockOpenAICreate: vi.fn(),
  mockGeminiGenerate: vi.fn(),
}));

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
      getGenerativeModel: vi.fn().mockReturnValue({
        generateContent: mockGeminiGenerate,
      }),
    };
  }),
}));

const mockDbSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
const mockDbUpdate = vi.fn().mockReturnValue({ set: mockDbSet });
const mockDbInsert = vi.fn().mockReturnValue({
  values: vi.fn().mockReturnValue({
    onConflictDoNothing: vi.fn().mockResolvedValue([]),
    returning: vi.fn().mockResolvedValue([]),
  }),
});

vi.mock("@/lib/db", () => ({
  db: {
    update: mockDbUpdate,
    insert: mockDbInsert,
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

import {
  extractCompetitorBrandKeywords,
  detectCompetitorMentions,
  humanizeDomainToBrand,
  looksLikeDomainStem,
  _resetHumanizeCacheForTests,
} from "@/lib/services/brand-detector";
import type { BrandKeywords } from "@/lib/services/brand-detector";
import { runCitationCheck } from "@/lib/services/citation-checker";
import * as citationCheckerNs from "@/lib/services/citation-checker";
import type { CitationPrompt } from "@/lib/types/citation";

/**
 * `extractCompetitors` is currently a private function in citation-checker.ts.
 * TS-081 §4.2 changes its signature; CoFounder may or may not export it for
 * direct testing. We use a namespace import + optional access so the suite
 * still loads if the export is absent — the affected `describe` block uses
 * `describe.skipIf` to skip cleanly. If CoFounder exports it later, the
 * skipped tests start running automatically.
 */
const extractCompetitorsFn =
  (citationCheckerNs as unknown as {
    extractCompetitors?: (
      text: string,
      domain: string,
      competitorKeywords?: Map<string, BrandKeywords>,
      categoryKeywords?: string[],
    ) => string[];
  }).extractCompetitors;

// ── Common helpers ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

function makeCompetitor(name: string, domain?: string, id?: string) {
  return {
    id: id ?? name.toLowerCase().replace(/\s+/g, "-"),
    name,
    domain: domain ?? "",
  };
}

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

// ═══════════════════════════════════════════════════════════════════════════
// Group A — extractCompetitorBrandKeywords (TS-081 §4.1)
// ═══════════════════════════════════════════════════════════════════════════

describe("extractCompetitorBrandKeywords — TS-081 §4.1 (RM)", () => {
  it("UT-1: returns Map keyed by lowercased competitor name", () => {
    const map = extractCompetitorBrandKeywords([
      makeCompetitor("Apollo Hospitals", "apollohospitals.com"),
      makeCompetitor("Fortis Healthcare", "fortishealthcare.com"),
    ] as never);

    expect(map).toBeInstanceOf(Map);
    expect(map.has("apollo hospitals")).toBe(true);
    expect(map.has("fortis healthcare")).toBe(true);
    // The cased form must NOT be a key — keys are lowercase canonical names.
    expect(map.has("Apollo Hospitals")).toBe(false);
  });

  it("UT-2: generates aliases per competitor (full name + bare prefix), longest-first", () => {
    const map = extractCompetitorBrandKeywords([
      makeCompetitor("Apollo Hospitals", "apollohospitals.com"),
    ] as never);

    const apolloKw = map.get("apollo hospitals");
    expect(apolloKw).toBeDefined();
    expect(apolloKw!.keywords).toEqual(expect.arrayContaining(["apollo hospitals"]));
    // Bare prefix "apollo" should be a generated alias.
    expect(apolloKw!.keywords).toEqual(expect.arrayContaining(["apollo"]));

    // Sorted longest-first per the existing generateAliases() contract.
    const lens = apolloKw!.keywords.map((k) => k.length);
    expect(lens).toEqual([...lens].sort((a, b) => b - a));
  });

  it("UT-3: handles competitor with no domain (defensive — does not crash)", () => {
    const map = extractCompetitorBrandKeywords([
      makeCompetitor("Stripe"), // no domain field
    ] as never);

    const kw = map.get("stripe");
    expect(kw).toBeDefined();
    expect(kw!.keywords).toEqual(expect.arrayContaining(["stripe"]));
  });

  it("UT-4: dedupes duplicate competitor names case-insensitively", () => {
    const map = extractCompetitorBrandKeywords([
      makeCompetitor("Apollo Hospitals", "apollohospitals.com", "id1"),
      makeCompetitor("apollo hospitals", "apollohospitals.com", "id2"),
      makeCompetitor("APOLLO HOSPITALS", "apollohospitals.com", "id3"),
    ] as never);

    expect(map.size).toBe(1);
    expect(map.has("apollo hospitals")).toBe(true);
  });

  it("UT-5: flags single-word ambiguous brand names with isAmbiguous=true (post-HP-147)", () => {
    // Post-HP-147 update: "Manipal Hospitals" generates a bare-prefix
    // "manipal" alias (7 chars) which trips heuristic #2 (single-word ≤8).
    // Both brands are now flagged ambiguous; the selective proximity guard
    // in detectCompetitorMentions still allows the full multi-word match
    // for "manipal hospitals" without context.
    const map = extractCompetitorBrandKeywords([
      makeCompetitor("Apple", "apple.com"),
      makeCompetitor("Manipal Hospitals", "manipalhospitals.com"),
    ] as never);

    expect(map.get("apple")?.isAmbiguous).toBe(true);
    expect(map.get("manipal hospitals")?.isAmbiguous).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group B — detectCompetitorMentions (TS-081 §4 / inbox §5)
// ═══════════════════════════════════════════════════════════════════════════

describe("detectCompetitorMentions — TS-081 §4 (RM)", () => {
  function buildMap() {
    return extractCompetitorBrandKeywords([
      makeCompetitor("Apollo Hospitals", "apollohospitals.com"),
      makeCompetitor("Fortis Healthcare", "fortishealthcare.com"),
    ] as never);
  }

  it("UT-6: matches by full brand name and returns lowercased canonical name", () => {
    const map = buildMap();
    const text = "Apollo Hospitals is the leading hospital chain in India.";
    const result = detectCompetitorMentions(text, map);

    expect(result).toEqual(expect.arrayContaining(["apollo hospitals"]));
    for (const name of result) {
      expect(name).toBe(name.toLowerCase());
    }
  });

  it("UT-7: matches by bare prefix with category proximity (post-HP-147)", () => {
    // Post-HP-147: bare "apollo" alias is short → flagged ambiguous → bare
    // match requires category context. Pass ["hospital"] to satisfy guard.
    const map = buildMap();
    const text = "Apollo runs a national hospital chain.";
    const result = detectCompetitorMentions(text, map, ["hospital"]);

    expect(result.length).toBeGreaterThan(0);
    expect(result.some((r) => r.includes("apollo"))).toBe(true);
  });

  it("UT-8: matches multiple competitors in the same response", () => {
    const map = buildMap();
    const text = "Apollo Hospitals and Fortis Healthcare are top private hospitals.";
    const result = detectCompetitorMentions(text, map);

    expect(result).toEqual(expect.arrayContaining(["apollo hospitals", "fortis healthcare"]));
  });

  it("UT-9: word-boundary guard — 'fortified' must NOT match 'fortis' (substring false-positive)", () => {
    const map = buildMap();
    const text = "The hospital ramparts were fortified to handle the influx.";
    const result = detectCompetitorMentions(text, map);

    expect(result).not.toEqual(expect.arrayContaining(["fortis healthcare"]));
    // Defensive: also reject any partial match starting with "fortis".
    expect(result.some((r) => r.startsWith("fortis"))).toBe(false);
  });

  it("UT-10: word-boundary guard — 'apollon' must NOT match 'apollo'", () => {
    const map = buildMap();
    const text = "Apollon Beach Resort, Cyprus, hosted the medical conference.";
    const result = detectCompetitorMentions(text, map);

    expect(result).not.toEqual(expect.arrayContaining(["apollo hospitals"]));
    expect(result.some((r) => r.startsWith("apollo"))).toBe(false);
  });

  it("UT-11: case-insensitive — lowercase mention still matches", () => {
    const map = buildMap();
    const text = "fortis healthcare opened a new branch in Bangalore.";
    const result = detectCompetitorMentions(text, map);

    expect(result).toEqual(expect.arrayContaining(["fortis healthcare"]));
  });

  it("UT-12: ambiguous brand WITHOUT category context fails proximity guard", () => {
    const map = extractCompetitorBrandKeywords([
      makeCompetitor("Apple", "apple.com"),
    ] as never);
    const text = "Apple cider vinegar is a popular health drink in many households.";
    const result = detectCompetitorMentions(text, map, ["computer", "iphone", "smartphone"]);

    expect(result).not.toEqual(expect.arrayContaining(["apple"]));
  });

  it("UT-13: ambiguous brand WITH category context within 300 chars passes", () => {
    const map = extractCompetitorBrandKeywords([
      makeCompetitor("Apple", "apple.com"),
    ] as never);
    const text =
      "Apple is a major smartphone manufacturer with a strong global presence in the iphone market.";
    const result = detectCompetitorMentions(text, map, ["smartphone", "iphone", "computer"]);

    expect(result).toEqual(expect.arrayContaining(["apple"]));
  });

  it("UT-14: does NOT apply the no-knowledge guard (different from detectMention)", () => {
    // detectMention() suppresses matches inside no-knowledge phrases like
    // "I don't have information about X". detectCompetitorMentions must NOT
    // apply that guard — competitor extraction is downstream of brand
    // visibility scoring and any mention should still count.
    const map = buildMap();
    const text =
      "I don't have specific information about Manipal, but Apollo Hospitals is a major chain.";
    const result = detectCompetitorMentions(text, map);

    expect(result).toEqual(expect.arrayContaining(["apollo hospitals"]));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group C — humanizeDomainToBrand (TS-081 §4.3 — discovery rename helper)
// ═══════════════════════════════════════════════════════════════════════════

// HP-146 (post-2026-04-09): humanizeDomainToBrand was rewritten to call Haiku
// instead of running a regex compound-split. UT-15..18 below mock the
// Anthropic SDK (already mocked at file scope as `mockCreate`) and become
// async. UT-15 was the original deliberate-RED bug-pin for Fortis Healthcare;
// after HP-146 it inverts to assert the ideal canonical name. Each test resets
// the in-memory humanize cache via _resetHumanizeCacheForTests so re-used
// fixture domains don't short-circuit between cases.
describe("humanizeDomainToBrand — TS-081 §4.3 (RM, post-HP-146)", () => {
  beforeEach(() => {
    _resetHumanizeCacheForTests();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  function haikuTextResponse(text: string) {
    return { content: [{ type: "text" as const, text }] };
  }

  it("UT-15: 'apollohospitals.com' → 'Apollo Hospitals' AND 'fortishealthcare.com' → 'Fortis Healthcare'", async () => {
    mockCreate
      .mockResolvedValueOnce(haikuTextResponse("Apollo Hospitals"))
      .mockResolvedValueOnce(haikuTextResponse("Fortis Healthcare"));
    expect(await humanizeDomainToBrand("apollohospitals.com")).toBe("Apollo Hospitals");
    expect(await humanizeDomainToBrand("fortishealthcare.com")).toBe("Fortis Healthcare");
  });

  it("UT-16: 'stripe.com' → 'Stripe'", async () => {
    mockCreate.mockResolvedValueOnce(haikuTextResponse("Stripe"));
    expect(await humanizeDomainToBrand("stripe.com")).toBe("Stripe");
  });

  it("UT-17: handles two-part TLDs (.co.in, .co.uk, .com.au)", async () => {
    // Two-part TLD stripping happens BEFORE the stem reaches Haiku.
    mockCreate
      .mockResolvedValueOnce(haikuTextResponse("Apollo Hospitals"))
      .mockResolvedValueOnce(haikuTextResponse("Example"));
    expect(await humanizeDomainToBrand("apollohospitals.co.in")).toBe("Apollo Hospitals");
    expect(await humanizeDomainToBrand("example.co.uk")).toBe("Example");
  });

  it("UT-18: strips www prefix and produces canonical names for stem variants", async () => {
    mockCreate
      .mockResolvedValueOnce(haikuTextResponse("Apollo Hospitals"))
      .mockResolvedValueOnce(haikuTextResponse("Get Apollo"));
    expect(await humanizeDomainToBrand("www.apollohospitals.com")).toBe("Apollo Hospitals");
    expect(await humanizeDomainToBrand("getapollo.com")).toBe("Get Apollo");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group D — looksLikeDomainStem (TS-081 §4.3 — backfill heuristic)
// ═══════════════════════════════════════════════════════════════════════════

describe("looksLikeDomainStem — TS-081 §4.3 (RM)", () => {
  it("UT-19: lowercase single-token name → true", () => {
    expect(looksLikeDomainStem("apollohospitals")).toBe(true);
    expect(looksLikeDomainStem("fortishealthcare")).toBe(true);
    expect(looksLikeDomainStem("astemri")).toBe(true); // garbled stem from §2.2
  });

  it("UT-20: multi-word brand (with whitespace) → false; capitalized → false", () => {
    expect(looksLikeDomainStem("Apollo Hospitals")).toBe(false);
    expect(looksLikeDomainStem("Fortis Healthcare")).toBe(false);
    expect(looksLikeDomainStem("Stripe")).toBe(false); // capitalized single word
  });

  it("UT-21: empty string → true (defensive — backfill should treat empty as stem-like)", () => {
    expect(looksLikeDomainStem("")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group E — citation-checker extractCompetitors (TS-081 §4.2)
//
// Currently private. `describe.skipIf` skips cleanly when not exported, and
// auto-enables when CoFounder exports the function for testing.
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!extractCompetitorsFn)(
  "extractCompetitors (citation-checker) — TS-081 §4.2 (RM)",
  () => {
    function buildMap() {
      return extractCompetitorBrandKeywords([
        makeCompetitor("Apollo Hospitals", "apollohospitals.com"),
        makeCompetitor("Fortis Healthcare", "fortishealthcare.com"),
      ] as never);
    }

    it("UT-22: Phase 1 brand-name path produces canonical names from the map", () => {
      const text = "Apollo Hospitals is a top hospital chain in India.";
      const result = extractCompetitorsFn!(text, "manipalhospitals.com", buildMap());

      expect(result.some((r) => /apollo/i.test(r))).toBe(true);
    });

    it("UT-23: Phase 2 URL fallback still extracts competitor.com / competitor.io", () => {
      // CC-10/CC-17 backward-compat: when no map entries match, the URL
      // regex fallback must still extract bare competitor domains.
      const text = "See https://competitor.com or competitor.io for an alternative.";
      const result = extractCompetitorsFn!(text, "manipalhospitals.com", new Map());

      const joined = result.join(" ").toLowerCase();
      expect(joined).toMatch(/competitor\.com|competitor\.io/);
    });

    it("UT-24: URL fallback excludes own subject domain", () => {
      const text = "Visit https://manipalhospitals.com for more information.";
      const result = extractCompetitorsFn!(text, "manipalhospitals.com", new Map());

      expect(result.join(" ").toLowerCase()).not.toMatch(/manipalhospitals\.com/);
    });

    it("UT-25: URL fallback excludes NON_COMPETITOR_DOMAINS (reddit, justdial, quora)", () => {
      const text = "Reviews on reddit.com and justdial.com show mixed sentiment.";
      const result = extractCompetitorsFn!(text, "manipalhospitals.com", new Map());

      const joined = result.join(" ").toLowerCase();
      expect(joined).not.toMatch(/reddit\.com|justdial\.com|quora\.com/);
    });

    it("UT-26: Phase 1 + Phase 2 dedupe via Set semantics", () => {
      const text =
        "Apollo Hospitals is excellent — see https://apollohospitals.com for details. Apollo dominates the south.";
      const result = extractCompetitorsFn!(text, "manipalhospitals.com", buildMap());

      // Brand match + URL match should collapse to a single entry.
      const apolloCount = result.filter((r) => /apollo/i.test(r)).length;
      expect(apolloCount).toBeLessThanOrEqual(1);
    });

    it("UT-27: capacity capped at 8 entries (TS-081 bumped from 5)", () => {
      const competitors = Array.from({ length: 12 }, (_, i) =>
        makeCompetitor(`Competitor${i}`, `competitor${i}.com`),
      );
      const map = extractCompetitorBrandKeywords(competitors as never);
      const text = competitors.map((c) => `${c.name} is great.`).join(" ");
      const result = extractCompetitorsFn!(text, "manipalhospitals.com", map);

      expect(result.length).toBeLessThanOrEqual(8);
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Counter-tests — false-positive guards
// ═══════════════════════════════════════════════════════════════════════════

describe("Counter-tests — false-positive guards (RM)", () => {
  it("CT-1: empty competitor map → empty result (no crash)", () => {
    const result = detectCompetitorMentions("Apollo Hospitals is great.", new Map());
    expect(result).toEqual([]);
  });

  it("CT-2: empty response text → empty result (no crash)", () => {
    const map = extractCompetitorBrandKeywords([
      makeCompetitor("Apollo Hospitals", "apollohospitals.com"),
    ] as never);
    expect(detectCompetitorMentions("", map)).toEqual([]);
  });

  it("CT-3: ambiguous competitor in unrelated category context → no match", () => {
    const map = extractCompetitorBrandKeywords([
      makeCompetitor("Target", "target.com"), // ambiguous
    ] as never);
    const text = "Our target audience is millennials interested in fitness.";
    const result = detectCompetitorMentions(text, map, ["retail", "shopping"]);

    expect(result).not.toEqual(expect.arrayContaining(["target"]));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Production replay PR-1 — independent fixture
//
// Source row: prod citation_check_responses.id = 't0e55bzbEzAARaaGpwp2H'
//   site_id = '-GzFX1KcKhmN0W_1t8SmY' (Manipal)
//   provider = 'openai', model = 'gpt-5.4-mini', position = 2
//   competitors_mentioned = []  ← the bug — should have apollo + fortis
// Distinct from CoFounder's CT15 row 'QH1EepHTOpK6hsh80VPJ1' per the
// "DIFFERENT row" requirement in the activation message.
// ═══════════════════════════════════════════════════════════════════════════

describe("Production replay — TS-081 §2.1 (RM)", () => {
  const PROD_REPLAY_FIXTURE =
    "1. **Apollo Hospitals** is the closest scale-and-brand competitor to Manipal Hospitals, with Apollo generally seen as stronger in national brand recognition, pharmacy/retail integration, and digital health, while Manipal is a large multi-specialty chain focused on tertiary and quaternary care. ([manipalhospitals.com](https://www.manipalhospitals.com/about-us/?utm_source=openai))\n\n2. **Fortis Healthcare** competes most directly in the same private multi-specialty hospital segment, but Manipal has been expanding faster through acquisitions, including Columbia Asia, AMRI, and Medica, which has strengthened its regional footprint. ([manipalhospitals.com](https://www.manipalhospitals.com/uploads/press_releases/press_pdf/2024-April_29-Manipal-Medica_Synergie-Press_Release-Final.pdf?utm_source=openai))\n\n3. **Max Healthcare** is a major peer";

  it("PR-1: detects Apollo + Fortis in real Manipal LLM response (row != QH1Ee...)", () => {
    const map = extractCompetitorBrandKeywords([
      makeCompetitor("Apollo Hospitals", "apollohospitals.com"),
      makeCompetitor("Fortis Healthcare", "fortishealthcare.com"),
      makeCompetitor("Max Healthcare", "maxhealthcare.com"),
    ] as never);

    const matches = detectCompetitorMentions(PROD_REPLAY_FIXTURE, map);

    // Today this returns []. After TS-081, must contain at least Apollo
    // and Fortis. (Max is a stretch goal — included so the test fails LOUD
    // if the implementation regresses on multi-competitor extraction.)
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches).toEqual(
      expect.arrayContaining(["apollo hospitals", "fortis healthcare"]),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration tests — runCitationCheck end-to-end with mocked providers
// ═══════════════════════════════════════════════════════════════════════════

describe("runCitationCheck — TS-081 integration (RM)", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  const baseBrandKeywords: BrandKeywords = {
    keywords: ["manipal hospitals", "manipal"],
    isAmbiguous: false,
    source: "vendor",
    extractedAt: new Date().toISOString(),
  };

  it("IT-1: discoveredCompetitors with real brand names → competitorData.shareOfVoice > 0", async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: "Apollo Hospitals leads the Indian healthcare market across multiple specialties.",
        },
      ],
    });

    const result = await runCitationCheck(
      "check-rm-1",
      "site-rm-1",
      "manipalhospitals.com",
      [makePrompt("Top hospital chains in India?")],
      NO_OP_CALLBACKS as never,
      [
        {
          name: "Apollo Hospitals",
          domain: "apollohospitals.com",
          rank: 1,
          mentions: 2,
          category: "direct" as const,
        },
        {
          name: "Fortis Healthcare",
          domain: "fortishealthcare.com",
          rank: 2,
          mentions: 2,
          category: "direct" as const,
        },
      ],
      baseBrandKeywords,
      ["hospital", "healthcare"],
    );

    const apollo = result.competitorData.find(
      (c) => /apollo/i.test(c.name) || /apollo/i.test(c.domain ?? ""),
    );
    expect(apollo).toBeDefined();
    expect(apollo!.shareOfVoice).toBeGreaterThan(0);
  });

  it("IT-2: empty discoveredCompetitors → URL fallback regression preserved (no crash)", async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: "See https://competitor.com for an alternative healthcare provider.",
        },
      ],
    });

    const result = await runCitationCheck(
      "check-rm-2",
      "site-rm-2",
      "manipalhospitals.com",
      [makePrompt("Healthcare alternatives?")],
      NO_OP_CALLBACKS as never,
      [],
      baseBrandKeywords,
      ["hospital"],
    );

    expect(result).toBeDefined();
    expect(Array.isArray(result.competitorData)).toBe(true);
  });

  it("IT-3: tier-1 competitor co-mention drops citationQualityScore vs alone-baseline", async () => {
    // Run A: brand alone in response → coPresenceSignal should return 100.
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "Manipal Hospitals is the leading healthcare provider in this region.",
        },
      ],
    });

    const aloneResult = await runCitationCheck(
      "check-rm-3a",
      "site-rm-3",
      "manipalhospitals.com",
      [makePrompt("Best hospital in Bangalore?")],
      NO_OP_CALLBACKS as never,
      [
        {
          name: "Apollo Hospitals",
          domain: "apollohospitals.com",
          rank: 1,
          mentions: 2,
          category: "direct" as const,
        },
      ],
      baseBrandKeywords,
      ["hospital"],
    );

    // Run B: brand alongside Apollo → coPresenceSignal should return 80.
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "Manipal Hospitals competes with Apollo Hospitals in tertiary care.",
        },
      ],
    });

    const coPresentResult = await runCitationCheck(
      "check-rm-3b",
      "site-rm-3",
      "manipalhospitals.com",
      [makePrompt("Best hospital in Bangalore?")],
      NO_OP_CALLBACKS as never,
      [
        {
          name: "Apollo Hospitals",
          domain: "apollohospitals.com",
          rank: 1,
          mentions: 2,
          category: "direct" as const,
        },
      ],
      baseBrandKeywords,
      ["hospital"],
    );

    // TS-081 §2.3: co-presence with a tier-1 rival should yield a STRICTLY
    // LOWER citation quality than the alone case. Pre-fix this is broken
    // because tier1Competitors is keyed on domains and never matches.
    expect(coPresentResult.citationQualityScore).toBeLessThan(
      aloneResult.citationQualityScore,
    );
  });

  it("IT-4: own subject domain present in response is NOT extracted as competitor", async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: "Visit https://manipalhospitals.com for details. Apollo Hospitals also operates in this region.",
        },
      ],
    });

    const result = await runCitationCheck(
      "check-rm-4",
      "site-rm-4",
      "manipalhospitals.com",
      [makePrompt("Top hospital chains?")],
      NO_OP_CALLBACKS as never,
      [
        {
          name: "Apollo Hospitals",
          domain: "apollohospitals.com",
          rank: 1,
          mentions: 2,
          category: "direct" as const,
        },
      ],
      baseBrandKeywords,
      ["hospital"],
    );

    // Own domain must never appear as a competitor entry.
    const ownEntry = result.competitorData.find(
      (c) =>
        /manipal hospitals/i.test(c.name) ||
        /manipalhospitals\.com/i.test(c.domain ?? ""),
    );
    expect(ownEntry).toBeUndefined();

    // But Apollo (the actual competitor) should still be detected.
    const apollo = result.competitorData.find(
      (c) => /apollo/i.test(c.name) || /apollo/i.test(c.domain ?? ""),
    );
    expect(apollo).toBeDefined();
  });

  it("IT-5: production-replay text fed through runCitationCheck → Apollo + Fortis in competitorData", async () => {
    // Reuse the prod replay fixture as the LLM response. This is the
    // strongest end-to-end signal: the exact text that today produces
    // empty competitors_mentioned must produce populated entries
    // through the public runCitationCheck pipeline.
    const PROD_REPLAY_FIXTURE =
      "1. **Apollo Hospitals** is the closest scale-and-brand competitor to Manipal Hospitals, with Apollo generally seen as stronger in national brand recognition. 2. **Fortis Healthcare** competes most directly in the same private multi-specialty hospital segment.";

    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: PROD_REPLAY_FIXTURE }],
    });

    const result = await runCitationCheck(
      "check-rm-5",
      "site-rm-5",
      "manipalhospitals.com",
      [makePrompt("Top hospital chains in India?")],
      NO_OP_CALLBACKS as never,
      [
        {
          name: "Apollo Hospitals",
          domain: "apollohospitals.com",
          rank: 1,
          mentions: 2,
          category: "direct" as const,
        },
        {
          name: "Fortis Healthcare",
          domain: "fortishealthcare.com",
          rank: 2,
          mentions: 2,
          category: "direct" as const,
        },
      ],
      baseBrandKeywords,
      ["hospital", "healthcare"],
    );

    const apollo = result.competitorData.find((c) => /apollo/i.test(c.name));
    const fortis = result.competitorData.find((c) => /fortis/i.test(c.name));
    expect(apollo).toBeDefined();
    expect(fortis).toBeDefined();
    expect(apollo!.shareOfVoice).toBeGreaterThan(0);
    expect(fortis!.shareOfVoice).toBeGreaterThan(0);
  });
});
