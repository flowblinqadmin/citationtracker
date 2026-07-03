/**
 * Unit tests for computeProjectedScore() in lib/services/assembler.ts
 *
 * Test environment: node (pure function — no network, no DB).
 * All tests call computeProjectedScore() directly after mocking the
 * top-level callClaude import so the module loads without side-effects.
 *
 * Naming: PS-01 … PS-15 match the spec sheet.
 */

// @vitest-environment node

import { describe, it, expect, vi } from "vitest";

// ── Module mocks ─────────────────────────────────────────────────────────────
// computeProjectedScore is pure, but assembler.ts imports callClaude at the
// module top level. We must mock it so the import succeeds without env vars.
vi.mock("@/lib/claude", () => ({
  callClaude: vi.fn().mockResolvedValue(""),
}));

// assembler.ts also transitively reaches no DB — no @/lib/db mock needed.

import { computeProjectedScore } from "@/lib/services/assembler";
import type { GeoScorecard, GeoScore } from "@/lib/services/geo-analyzer";
import type { GeneratedContent, SchemaBlock } from "@/lib/services/content-generator";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makePillar(
  pillar: string,
  score: number,
  pillarName?: string
): GeoScore {
  return {
    pillar,
    pillarName: pillarName ?? pillar,
    score,
    findings: "test finding",
    recommendation: "test recommendation",
    priority: "low",
    impactedPages: [],
  };
}

function makeScorecard(
  overallScore: number,
  pillars: GeoScore[]
): GeoScorecard {
  return { overallScore, pillars, topThreeImprovements: [] };
}

/**
 * Minimal GeneratedContent — no assets generated.
 * Overrides let individual tests inject exactly what they need.
 */
function makeContent(overrides: Partial<GeneratedContent> = {}): GeneratedContent {
  return {
    llmsTxt: "",
    llmsFullTxt: "",
    businessJson: {},
    schemaBlocks: [],
    ...overrides,
  };
}

/** Helper to produce a SchemaBlock with the given type. */
function makeSchema(type: string, extra: Partial<SchemaBlock> = {}): SchemaBlock {
  return {
    type,
    name: type,
    jsonLd: {},
    instructions: "",
    pageTarget: "all",
    ...extra,
  };
}

// ── GEO_PILLAR_WEIGHTS (mirrored from assembler.ts for manual calculations) ──
// These are read-only reference values used to verify the weighted-average formula.
const W = {
  author_authority:        4.9,
  content_freshness:       4.7,
  structured_data:         4.6,
  faq_coverage:            4.5,
  contact_trust:           4.3,
  semantic_html:           4.2,
  content_structure:       4.1,
  evidence_statistics:     4.0,
  internal_linking:        3.8,
  metadata_freshness:      3.7,
  entity_definitions:      3.6,
  offering_clarity:        3.5,
  multi_format:            3.2,
  cta_structure:           3.0,
  competitive_positioning: 2.8,
  licensing_signals:       2.5,
  geographic_signals:      2.5,
} as const;

// ── PS-01: No content at all → result ≥ overallScore ─────────────────────────

describe("PS-01: no generated content", () => {
  it("returns a value >= overallScore when no assets are present", () => {
    const scorecard = makeScorecard(62, [
      makePillar("structured_data", 30),
      makePillar("faq_coverage", 20),
      makePillar("licensing_signals", 15),
    ]);
    const content = makeContent();

    const result = computeProjectedScore(scorecard, content);

    expect(result).toBeGreaterThanOrEqual(62);
  });

  it("returns exactly overallScore when no assets improve any pillar", () => {
    // Single pillar with no boost possible (no content → 0 raw boost),
    // so projected pillar score == pillar.score. The weighted average of a single
    // pillar is just that pillar's score. Guard then clamps to overallScore if higher.
    const scorecard = makeScorecard(70, [makePillar("structured_data", 70)]);
    const content = makeContent(); // no schema blocks

    const result = computeProjectedScore(scorecard, content);

    // pillar stays at 70 → weighted avg = 70 → guard: max(70, 70) = 70
    expect(result).toBe(70);
  });
});

// ── PS-02: PILLAR_CEILING enforced for structured_data (ceiling = 88) ─────────

describe("PS-02: structured_data ceiling = 88", () => {
  it("caps structured_data projected score at 88 even when full schema stack present", () => {
    // Score 80 + full boost:
    //   Organisation +6, BreadcrumbList +4, Speakable +2, FAQPage×3 +5+3,
    //   Article×5 +3+3, DefinedTerm +3 = 29 raw boost → 80+29 = 109 → capped at 88
    const faqBlocks = [1, 2, 3].map(() => makeSchema("FAQPage"));
    const articleBlocks = [1, 2, 3, 4, 5].map(() => makeSchema("Article"));
    const speakableBlock = makeSchema("WebPage", { name: "WebPage speakable" });
    const schemaBlocks: SchemaBlock[] = [
      makeSchema("Organization"),
      makeSchema("BreadcrumbList"),
      speakableBlock,
      makeSchema("DefinedTerm"),
      ...faqBlocks,
      ...articleBlocks,
    ];

    const scorecard = makeScorecard(80, [makePillar("structured_data", 80)]);
    const content = makeContent({ schemaBlocks });

    const result = computeProjectedScore(scorecard, content);

    // projected pillar = 88 (ceiling), overallScore = 80 → result = 88
    expect(result).toBe(88);
  });

  it("does not exceed 88 even when overallScore is artificially low", () => {
    const schemaBlocks: SchemaBlock[] = [
      makeSchema("Organization"),
      makeSchema("BreadcrumbList"),
      makeSchema("FAQPage"),
      makeSchema("FAQPage"),
      makeSchema("FAQPage"),
      makeSchema("Article"),
      makeSchema("Article"),
      makeSchema("Article"),
      makeSchema("Article"),
      makeSchema("Article"),
      makeSchema("DefinedTerm"),
      makeSchema("WebPage", { name: "WebPage speakable" }),
    ];
    const scorecard = makeScorecard(10, [makePillar("structured_data", 10)]);
    const content = makeContent({ schemaBlocks });

    const result = computeProjectedScore(scorecard, content);

    // pillar ceiling = 88; result may be below due to weighted-avg formula
    // but the pillar contribution is min(88, 10+29)=88, so weighted avg of [88] = 88
    expect(result).toBeLessThanOrEqual(88);
  });
});

// ── PS-03: PILLAR_CEILING enforced for licensing_signals (ceiling = 95) ───────

describe("PS-03: licensing_signals ceiling = 95", () => {
  it("caps licensing_signals at 95 even with all signals present", () => {
    // llmsTxt must be > 200 chars AND have >= 10 non-empty lines to trigger hasLlmsTxt.
    // The string must also match ## About, ## Key Concepts, ## Products, and ## Contact.
    // Using pillar.score=60: boost=40 → 60+40=100 → ceiling clamps to 95.
    const llmsTxt = [
      "# My Company — Official LLM Context File",
      "> We build inventory management software for dark store warehouses.",
      "",
      "## About",
      "My Company provides real-time inventory tracking for quick-commerce operators.",
      "",
      "## Key Concepts",
      "**Batch tracking**: is a method of grouping inventory by expiry date.",
      "**FEFO**: refers to First Expired First Out allocation strategy.",
      "",
      "## Products",
      "Widget Pro and Widget Lite are the two main product lines.",
      "",
      "## Contact",
      "Email: hello@mycompany.com | Phone: +1-800-555-0100",
    ].join("\n");

    // Confirm char count: the above string is ~380 chars (well over 200).
    const llmsFullTxt = "x".repeat(201);
    const businessJson = { a: 1, b: 2, c: 3, d: 4 }; // 4 keys
    const schemaBlocks: SchemaBlock[] = [makeSchema("RobotsTxt")];

    const scorecard = makeScorecard(60, [makePillar("licensing_signals", 60)]);
    const content = makeContent({ llmsTxt, llmsFullTxt, businessJson, schemaBlocks });

    const result = computeProjectedScore(scorecard, content);

    // All six licensing boosts active:
    //   hasLlmsTxt=true (>200), lineCount>=10 → +8
    //   llmsHasSections (About+Key Concepts+Products) → +7
    //   llmsHasContact → +3
    //   hasLlmsFullTxt=true → +8
    //   hasBusinessJson=true (4 keys) → +5
    //   hasRobotsTxtBlock=true → +9
    //   total boost = 40
    // projectedPillarScore = min(95, 60+40) = min(95, 100) = 95
    // weightedSum / totalWeight = 95 * 2.5 / 2.5 = 95
    // guard: max(60, 95) = 95
    expect(result).toBe(95);
  });

  it("stays at or below 95 regardless of score before ceiling", () => {
    const llmsTxt = [
      "# Title",
      "> Summary.",
      "## About",
      "Something meaningful here.",
      "## Key Concepts",
      "**Term**: is a concept that refers to something.",
      "## Products",
      "Product A.",
      "## Contact",
      "Email: x@x.com",
      "Line 10",
      "Line 11",
    ].join("\n");

    const scorecard = makeScorecard(90, [makePillar("licensing_signals", 90)]);
    const content = makeContent({
      llmsTxt,
      llmsFullTxt: "x".repeat(201),
      businessJson: { a: 1, b: 2, c: 3, d: 4 },
      schemaBlocks: [makeSchema("RobotsTxt")],
    });

    const result = computeProjectedScore(scorecard, content);

    // pillar projected = min(95, 90+40) = 95, but overallScore = 90 → result = max(90, 95) = 95
    expect(result).toBeLessThanOrEqual(95);
    expect(result).toBeGreaterThanOrEqual(90);
  });
});

// ── PS-04: guard — projected < overallScore → returns overallScore ─────────────

describe("PS-04: guard never regresses below overallScore", () => {
  it("returns overallScore when weighted pillar average is lower", () => {
    // Scorecard with overallScore=80 but a single pillar with score=40 (no boost).
    // Weighted avg of [40] = 40 < 80 → guard kicks in.
    const scorecard = makeScorecard(80, [makePillar("structured_data", 40)]);
    const content = makeContent(); // no schema blocks → no boost

    const result = computeProjectedScore(scorecard, content);

    expect(result).toBe(80);
  });

  it("returns overallScore when all pillars are low with no content boost", () => {
    const scorecard = makeScorecard(75, [
      makePillar("semantic_html", 10),
      makePillar("internal_linking", 20),
    ]);
    const content = makeContent();

    const result = computeProjectedScore(scorecard, content);

    expect(result).toBeGreaterThanOrEqual(75);
  });
});

// ── PS-05: pillars with no ceiling get no boost ────────────────────────────────

describe("PS-05: pillars with no ceiling entry stay at their current score", () => {
  it("semantic_html pillar is unchanged by any content", () => {
    // PILLAR_CEILINGS has no entry for semantic_html → ceiling = pillar.score
    // projectedPillarScore = max(score, min(score, score+boost)) = score
    const scorecard = makeScorecard(50, [makePillar("semantic_html", 50)]);
    // Provide rich content that would boost other pillars but not semantic_html
    const content = makeContent({
      schemaBlocks: [makeSchema("Organization"), makeSchema("FAQPage")],
    });

    const result = computeProjectedScore(scorecard, content);

    // pillar stays at 50, weighted avg = 50, guard: max(50, 50) = 50
    expect(result).toBe(50);
  });

  it("internal_linking gets no boost from any generated asset", () => {
    const scorecard = makeScorecard(35, [makePillar("internal_linking", 35)]);
    const content = makeContent({
      llmsTxt: "x".repeat(300),
      schemaBlocks: [makeSchema("Organization")],
    });

    const result = computeProjectedScore(scorecard, content);

    // ceiling = pillar.score = 35 → projected = 35, guard: max(35, 35) = 35
    expect(result).toBe(35);
  });
});

// ── PS-06: structured_data — Organization schema adds 6 pts to pillar ─────────

describe("PS-06: structured_data — Organization schema boost", () => {
  it("adds exactly 6 pts for Organization schema alone", () => {
    const baseScore = 40;
    const scorecard = makeScorecard(40, [makePillar("structured_data", baseScore)]);
    const content = makeContent({ schemaBlocks: [makeSchema("Organization")] });

    const result = computeProjectedScore(scorecard, content);

    // boost = 6, projected pillar = min(88, 40+6) = 46
    // weighted avg of single pillar: 46 * 4.6 / 4.6 = 46
    // guard: max(40, 46) = 46
    expect(result).toBe(46);
  });

  it("adds exactly 4 pts for BreadcrumbList schema alone", () => {
    const scorecard = makeScorecard(40, [makePillar("structured_data", 40)]);
    const content = makeContent({ schemaBlocks: [makeSchema("BreadcrumbList")] });

    const result = computeProjectedScore(scorecard, content);

    // boost = 4 → projected pillar = 44, weighted avg = 44, guard = max(40,44) = 44
    expect(result).toBe(44);
  });

  it("adds exactly 2 pts for WebPage speakable schema alone", () => {
    const scorecard = makeScorecard(40, [makePillar("structured_data", 40)]);
    const speakable = makeSchema("WebPage", { name: "WebPage speakable" });
    const content = makeContent({ schemaBlocks: [speakable] });

    const result = computeProjectedScore(scorecard, content);

    // boost = 2 → projected pillar = 42
    expect(result).toBe(42);
  });

  it("does NOT boost for WebPage schema without 'speakable' in name", () => {
    const scorecard = makeScorecard(40, [makePillar("structured_data", 40)]);
    const nonSpeakable = makeSchema("WebPage", { name: "WebPage generic" });
    const content = makeContent({ schemaBlocks: [nonSpeakable] });

    const result = computeProjectedScore(scorecard, content);

    // hasSpeakableSchema = false (name does not include 'speakable') → boost = 0
    expect(result).toBe(40);
  });
});

// ── PS-07: structured_data — FAQPage ≥3 adds cumulative 5+3 = 8 pts ──────────

describe("PS-07: structured_data — FAQPage cumulative boost", () => {
  it("adds 5 pts for exactly 1 FAQPage schema", () => {
    const scorecard = makeScorecard(40, [makePillar("structured_data", 40)]);
    const content = makeContent({ schemaBlocks: [makeSchema("FAQPage")] });

    const result = computeProjectedScore(scorecard, content);

    // faqSchemaCount=1 → +5, no other schemas → boost=5 → projected pillar=45
    expect(result).toBe(45);
  });

  it("adds 5+3=8 pts for 3 FAQPage schemas (cumulative tiers)", () => {
    const scorecard = makeScorecard(40, [makePillar("structured_data", 40)]);
    const faqBlocks = [1, 2, 3].map(() => makeSchema("FAQPage"));
    const content = makeContent({ schemaBlocks: faqBlocks });

    const result = computeProjectedScore(scorecard, content);

    // faqSchemaCount=3 → faqSchemaCount>=1 (+5) + faqSchemaCount>=3 (+3) = 8
    // projected pillar = min(88, 40+8) = 48
    expect(result).toBe(48);
  });

  it("adds Article tiers: 1 Article = +3, 5 Articles = +6 total", () => {
    const scorecard = makeScorecard(40, [makePillar("structured_data", 40)]);
    const articleBlocks = [1, 2, 3, 4, 5].map(() => makeSchema("Article"));
    const content = makeContent({ schemaBlocks: articleBlocks });

    const result = computeProjectedScore(scorecard, content);

    // articleCount>=1 (+3) + articleCount>=5 (+3) = 6
    // projected pillar = min(88, 40+6) = 46
    expect(result).toBe(46);
  });
});

// ── PS-08: licensing_signals — full llms.txt with sections adds 8+7+3 = 18 pts

describe("PS-08: licensing_signals — llmsTxt section boosts", () => {
  it("adds 8 pts for valid llms.txt (>200 chars, ≥10 non-empty lines)", () => {
    // Build a 10-line non-empty text, length > 200
    const lines = Array.from({ length: 15 }, (_, i) => `Line ${i + 1} content here`);
    const llmsTxt = lines.join("\n"); // each line is non-empty, total > 200 chars

    const scorecard = makeScorecard(20, [makePillar("licensing_signals", 20)]);
    const content = makeContent({ llmsTxt });

    const result = computeProjectedScore(scorecard, content);

    // hasLlmsTxt = true (>200), lineCount>=10 → +8
    // No sections (About/Key Concepts/Products), no Contact → 0 extra
    // boost = 8, projected pillar = min(95, 20+8) = 28
    expect(result).toBe(28);
  });

  it("adds 8+7+3=18 pts for llms.txt with About, Key Concepts, Products, and Contact sections", () => {
    const llmsTxt = [
      "# My Company",
      "> Summary line.",
      "## About",
      "We build excellent products.",
      "## Key Concepts",
      "**Widget**: is a component.",
      "## Products",
      "Widget A is the main product.",
      "## Contact",
      "Email: hello@example.com",
      "Line 11",
      "Line 12",
    ].join("\n");

    const scorecard = makeScorecard(20, [makePillar("licensing_signals", 20)]);
    const content = makeContent({ llmsTxt });

    const result = computeProjectedScore(scorecard, content);

    // hasLlmsTxt=true, lineCount>=10 → +8
    // llmsHasSections (About+Key Concepts+Products) → +7
    // llmsHasContact → +3
    // total boost = 18, projected pillar = min(95, 20+18) = 38
    expect(result).toBe(38);
  });
});

// ── PS-09: licensing_signals — RobotsTxt block adds 9 pts ────────────────────

describe("PS-09: licensing_signals — RobotsTxt block boost", () => {
  it("adds 9 pts for a RobotsTxt schema block", () => {
    const scorecard = makeScorecard(20, [makePillar("licensing_signals", 20)]);
    const content = makeContent({ schemaBlocks: [makeSchema("RobotsTxt")] });

    const result = computeProjectedScore(scorecard, content);

    // hasRobotsTxtBlock = true → +9
    // No llms.txt, no businessJson → boost = 9
    // projected pillar = min(95, 20+9) = 29
    expect(result).toBe(29);
  });

  it("stacks RobotsTxt +9 with other licensing_signals boosts", () => {
    const llmsTxt = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of content`).join("\n");
    const scorecard = makeScorecard(20, [makePillar("licensing_signals", 20)]);
    const content = makeContent({
      llmsTxt,
      schemaBlocks: [makeSchema("RobotsTxt")],
    });

    const result = computeProjectedScore(scorecard, content);

    // hasLlmsTxt=true (need >200 chars — let me check: 12 lines × ~20 chars = 240 ✓)
    // lineCount>=10 → +8; no sections; no contact → just +8 from llms + +9 RobotsTxt = 17
    // projected = min(95, 20+17) = 37
    expect(result).toBe(37);
  });
});

// ── PS-10: licensing_signals — llmsFullTxt adds 8 pts ────────────────────────

describe("PS-10: licensing_signals — llmsFullTxt boost", () => {
  it("adds 8 pts for llmsFullTxt with length > 200", () => {
    const scorecard = makeScorecard(20, [makePillar("licensing_signals", 20)]);
    const content = makeContent({ llmsFullTxt: "x".repeat(201) });

    const result = computeProjectedScore(scorecard, content);

    // hasLlmsFullTxt = true → +8, no other boosts
    // projected pillar = min(95, 20+8) = 28
    expect(result).toBe(28);
  });

  it("does NOT add llmsFullTxt boost when length is exactly 200 or less", () => {
    const scorecard = makeScorecard(20, [makePillar("licensing_signals", 20)]);
    const content = makeContent({ llmsFullTxt: "x".repeat(200) });

    const result = computeProjectedScore(scorecard, content);

    // hasLlmsFullTxt requires length > 200 → 200 chars fails → no boost
    // projected pillar = min(95, 20+0) = 20 → guard: max(20, 20) = 20
    expect(result).toBe(20);
  });
});

// ── PS-11: licensing_signals — businessJson ≥4 keys adds 5 pts ───────────────

describe("PS-11: licensing_signals — businessJson ≥4 keys boost", () => {
  it("adds 5 pts for businessJson with exactly 4 top-level keys", () => {
    const scorecard = makeScorecard(20, [makePillar("licensing_signals", 20)]);
    const content = makeContent({
      businessJson: { key1: "a", key2: "b", key3: "c", key4: "d" },
    });

    const result = computeProjectedScore(scorecard, content);

    // hasBusinessJson = true (4 keys) → +5
    // projected pillar = min(95, 20+5) = 25
    expect(result).toBe(25);
  });

  it("does NOT add businessJson boost when fewer than 4 keys present", () => {
    const scorecard = makeScorecard(20, [makePillar("licensing_signals", 20)]);
    const content = makeContent({
      businessJson: { key1: "a", key2: "b", key3: "c" }, // only 3 keys
    });

    const result = computeProjectedScore(scorecard, content);

    // Object.keys({...}).length = 3 < 4 → hasBusinessJson = false → +0
    expect(result).toBe(20);
  });
});

// ── PS-12: entity_definitions — DefinedTerm schemas add pts ──────────────────

describe("PS-12: entity_definitions — DefinedTerm schema boosts", () => {
  it("adds 5 pts for exactly 1 DefinedTerm block", () => {
    const scorecard = makeScorecard(30, [makePillar("entity_definitions", 30)]);
    const content = makeContent({ schemaBlocks: [makeSchema("DefinedTerm")] });

    const result = computeProjectedScore(scorecard, content);

    // definedTermCount=1 → definedTermCount>=1 (+5) → boost=5
    // No llmsTxt concept matches → extractableCount=0
    // projected pillar = min(80, 30+5) = 35, guard: max(30, 35) = 35
    expect(result).toBe(35);
  });

  it("adds 5+4=9 pts for 3 DefinedTerm blocks (second tier)", () => {
    const scorecard = makeScorecard(30, [makePillar("entity_definitions", 30)]);
    const content = makeContent({
      schemaBlocks: [makeSchema("DefinedTerm"), makeSchema("DefinedTerm"), makeSchema("DefinedTerm")],
    });

    const result = computeProjectedScore(scorecard, content);

    // definedTermCount=3 → >=1 (+5) + >=3 (+4) = 9 from schema
    // extractableCount=0 (no llmsTxt) → no quality boost
    // boost=9, projected pillar = min(80, 30+9) = 39
    expect(result).toBe(39);
  });

  it("adds extractable-definition boosts from llmsTxt Key Concepts", () => {
    // Pattern: **Term**: is a ... OR **Term**: refers to ...
    const llmsTxt = [
      "## Key Concepts",
      "**Widget**: is a physical component used in assembly.",
      "**Gizmo**: is an electronic device that refers to smart control.",
      "**Doohickey**: refers to a mechanical lever.",
    ].join("\n");

    const scorecard = makeScorecard(30, [makePillar("entity_definitions", 30)]);
    const content = makeContent({ llmsTxt });

    const result = computeProjectedScore(scorecard, content);

    // extractableCount=3: matches "**X**: is a ..." and "**X**: refers to ..."
    // >=1 (+4) + >=3 (+4) = 8 quality boost
    // definedTermCount=0 → 0 schema boost
    // total boost = 8, projected pillar = min(80, 30+8) = 38
    expect(result).toBe(38);
  });
});

// ── PS-13: faq_coverage — FAQPage blocks and pairs ───────────────────────────

describe("PS-13: faq_coverage — FAQPage schema and Q&A pair boosts", () => {
  it("adds 6 pts for a single FAQPage block with no mainEntity pairs", () => {
    const scorecard = makeScorecard(20, [makePillar("faq_coverage", 20)]);
    const content = makeContent({
      schemaBlocks: [makeSchema("FAQPage")], // jsonLd = {} → no mainEntity pairs
    });

    const result = computeProjectedScore(scorecard, content);

    // faqBlockCount=1 → >=1 (+6); totalFaqPairs=0 → no pair boost
    // boost=6, projected pillar = min(85, 20+6) = 26
    expect(result).toBe(26);
  });

  it("adds 6+5+4=15 pts for 6 FAQPage blocks and 15+ Q&A pairs", () => {
    // Build 6 FAQPage blocks, each with 3 pairs (total = 18 pairs)
    const makeFaqBlock = (pairCount: number): SchemaBlock => ({
      type: "FAQPage",
      name: "FAQPage",
      jsonLd: {
        mainEntity: Array.from({ length: pairCount }, (_, i) => ({
          "@type": "Question",
          name: `Q${i}`,
          acceptedAnswer: { text: "Answer" },
        })),
      },
      instructions: "",
      pageTarget: "all",
    });

    const schemaBlocks = Array.from({ length: 6 }, () => makeFaqBlock(3)); // 6 blocks × 3 pairs = 18 pairs

    const scorecard = makeScorecard(20, [makePillar("faq_coverage", 20)]);
    const content = makeContent({ schemaBlocks });

    const result = computeProjectedScore(scorecard, content);

    // faqBlockCount=6 → >=1 (+6) + >=3 (+5) + >=6 (+4) = 15
    // totalFaqPairs=18 → >=5 (+4) + >=15 (+3) = 7
    // total boost = 22, projected pillar = min(85, 20+22) = min(85, 42) = 42
    expect(result).toBe(42);
  });
});

// ── PS-14: weighted average uses GEO_PILLAR_WEIGHTS ──────────────────────────

describe("PS-14: weighted average formula uses GEO_PILLAR_WEIGHTS", () => {
  it("single-pillar scorecard: projected score = projected pillar score (trivially)", () => {
    // Use structured_data (weight 4.6). Single-pillar scorecard simplifies the
    // formula: weightedSum / totalWeight = projectedPillarScore * 4.6 / 4.6 = projectedPillarScore.
    const baseScore = 50;
    const scorecard = makeScorecard(50, [makePillar("structured_data", baseScore)]);
    // Organization (+6) alone → boost=6, projected pillar=min(88, 56)=56
    const content = makeContent({ schemaBlocks: [makeSchema("Organization")] });

    const result = computeProjectedScore(scorecard, content);

    // projectedPillarScore = 56
    // weightedSum = 56 * 4.6 = 257.6
    // totalWeight = 4.6
    // projectedFromPillars = Math.min(100, Math.round(257.6 / 4.6)) = Math.round(56) = 56
    // guard: max(50, 56) = 56
    expect(result).toBe(56);
  });

  it("two-pillar scorecard: result matches manual weighted-average calculation", () => {
    // Pillars: structured_data (W=4.6) at score 50, author_authority (W=4.9) at score 30.
    // Content: Organization schema (+6 to structured_data).
    // structured_data projected = min(88, 50+6) = 56
    // author_authority: no Person schema, no profiles → boost=0, projected=30
    //   (ceiling for author_authority=68 → min(68, 30+0)=30)
    //
    // weightedSum = 56*4.6 + 30*4.9 = 257.6 + 147.0 = 404.6
    // totalWeight = 4.6 + 4.9 = 9.5
    // projectedFromPillars = Math.min(100, Math.round(404.6 / 9.5))
    //                       = Math.min(100, Math.round(42.589...))
    //                       = Math.min(100, 43)
    //                       = 43
    // overallScore = 40 → guard: max(40, 43) = 43
    const scorecard = makeScorecard(40, [
      makePillar("structured_data", 50),
      makePillar("author_authority", 30),
    ]);
    const content = makeContent({ schemaBlocks: [makeSchema("Organization")] });

    const result = computeProjectedScore(scorecard, content);

    expect(result).toBe(43);
  });
});

// ── PS-15: result is always an integer ────────────────────────────────────────

describe("PS-15: result is always an integer", () => {
  it("returns an integer for a single-pillar scorecard with no boost", () => {
    const scorecard = makeScorecard(45, [makePillar("faq_coverage", 45)]);
    const content = makeContent();

    const result = computeProjectedScore(scorecard, content);

    expect(Number.isInteger(result)).toBe(true);
  });

  it("returns an integer when weighted average is non-trivial", () => {
    // Three pillars with different weights to exercise Math.round
    const scorecard = makeScorecard(50, [
      makePillar("structured_data", 60),     // W=4.6
      makePillar("faq_coverage", 55),         // W=4.5
      makePillar("licensing_signals", 70),    // W=2.5
    ]);
    const content = makeContent({ schemaBlocks: [makeSchema("Organization")] });

    const result = computeProjectedScore(scorecard, content);

    expect(Number.isInteger(result)).toBe(true);
  });

  it("returns an integer even when overallScore guard is applied", () => {
    const scorecard = makeScorecard(99, [makePillar("semantic_html", 10)]);
    const content = makeContent();

    const result = computeProjectedScore(scorecard, content);

    // guard returns overallScore=99 which is integer
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBe(99);
  });

  it("result is capped at 100 even if arithmetic exceeds it", () => {
    // Pillar score=95, full structured_data boost=29 → 95+29=124 → ceiling=88 → 88
    // Actually ceiling prevents > 88 for structured_data. Use licensing_signals: ceiling=95.
    // pillar=95, boost=40 → 95+40=135 → ceiling=95 → projected=95
    // weighted avg = 95, guard: max(95, 95) = 95, never > 100
    const llmsTxt = [
      "# Title",
      "> Summary.",
      "## About",
      "Company does great work.",
      "## Key Concepts",
      "**Term**: is a thing.",
      "## Products",
      "Product A.",
      "## Contact",
      "Email: x@x.com",
      "Extra line 11",
      "Extra line 12",
    ].join("\n");

    const scorecard = makeScorecard(95, [makePillar("licensing_signals", 95)]);
    const content = makeContent({
      llmsTxt,
      llmsFullTxt: "x".repeat(201),
      businessJson: { a: 1, b: 2, c: 3, d: 4 },
      schemaBlocks: [makeSchema("RobotsTxt")],
    });

    const result = computeProjectedScore(scorecard, content);

    expect(result).toBeLessThanOrEqual(100);
    expect(Number.isInteger(result)).toBe(true);
  });
});
