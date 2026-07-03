/**
 * ES-054 — TDD Phase 1: ScriptDev's own tests for Tier 2 Measurement Depth
 *
 * Covers:
 *   - aggregateByDimension (C5/C6)
 *   - computeImpressionShare (Cross)
 *   - generateTierInsight (C6)
 *   - scoreGeographicSignals (C7)
 *   - validateCrawlCoverage (Cross)
 *   - generateVisibilityGapAnalysis (Cross)
 *   - EVIDENCE_DATABASE in assembler prompt (Cross)
 *   - RankedRecommendation.evidence field (Cross)
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (before imports) ───────────────────────────────
// Mock DB to prevent connection errors when importing citation-check route
vi.mock("@/lib/db", () => ({
  db: {
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue([]) }) }),
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  citationCheckScores: {},
  citationCheckResponses: {},
  geoSites: {},
}));

// ═══════════════════════════════════════════════════════════════════
// SECTION 1: aggregateByDimension — C5 (per-city/category) + C6 (tier)
// ═══════════════════════════════════════════════════════════════════

import {
  aggregateByDimension,
  computeImpressionShare,
  generateTierInsight,
} from "@/lib/services/citation-checker";

import type {
  GeoVisibility,
  CategoryVisibility,
  TierVisibility,
  VisibilityGapEntry,
  CrawlCoverageReport,
} from "@/lib/types/citation";

// ── Response Row helper ─────────────────────────────────────────

type TaggedPrompt = {
  type: "indirect" | "direct";
  pillar: string | null;
  prompt: string;
  geoId?: string | null;
  categoryId?: string | null;
  tier?: "buy" | "solve" | "learn" | null;
};

function makeResponse(query: string, mentioned: boolean) {
  return {
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    checkId: "chk-test",
    siteId: "site-test",
    provider: "chatgpt",
    model: "gpt-4o-mini",
    query,
    pillar: null,
    promptType: "indirect" as const,
    response: "some text with enough content here to fill the minimum word requirement for testing purposes.",
    responseTimeMs: 300,
    mentioned,
    position: mentioned ? 2 : null,
    sentiment: mentioned ? "positive" : null,
    competitorsMentioned: [] as string[],
    error: null,
  };
}

function makeGeoTree(nodes: Array<{ id: string; name: string }>) {
  return {
    root: {
      id: "global",
      name: "Global",
      level: "global" as const,
      children: nodes.map((n) => ({
        id: n.id,
        name: n.name,
        level: "city" as const,
        children: [],
        pageCount: 0,
        evidence: [],
      })),
      pageCount: 0,
      evidence: [],
    },
    leafCount: nodes.length,
    extractedAt: new Date().toISOString(),
  };
}

function makeCategoryTree(nodes: Array<{ id: string; name: string }>) {
  return {
    root: {
      id: "root",
      name: "Root",
      level: 0,
      children: nodes.map((n) => ({
        id: n.id,
        name: n.name,
        level: 1,
        children: [],
        pageCount: 0,
        evidence: [],
      })),
      pageCount: 0,
      evidence: [],
    },
    leafCount: nodes.length,
    extractedAt: new Date().toISOString(),
  };
}

// ── aggregateByDimension tests ──────────────────────────────────

describe("aggregateByDimension — C5/C6 visibility", () => {
  const geoTree = makeGeoTree([
    { id: "in-ka-blr", name: "Bangalore" },
    { id: "in-dl-del", name: "Delhi" },
  ]);

  const catTree = makeCategoryTree([
    { id: "ortho", name: "Orthopedics" },
    { id: "cardio", name: "Cardiology" },
  ]);

  it("T1: groups by geoId — 2 unique geos → 2 geoVisibility entries", () => {
    const prompts: TaggedPrompt[] = [
      { type: "indirect", pillar: null, prompt: "q1", geoId: "in-ka-blr", tier: "buy" },
      { type: "indirect", pillar: null, prompt: "q2", geoId: "in-ka-blr", tier: "buy" },
      { type: "indirect", pillar: null, prompt: "q3", geoId: "in-dl-del", tier: "solve" },
    ];
    const responses = prompts.map((p) => makeResponse(p.prompt, true));
    const result = aggregateByDimension(responses, prompts, geoTree, catTree);

    expect(result.geoVisibility).toHaveLength(2);
    const blr = result.geoVisibility.find((g) => g.geoId === "in-ka-blr");
    expect(blr).toBeDefined();
    expect(blr!.promptCount).toBe(2);
    expect(blr!.mentionCount).toBe(2);
  });

  it("T2: groups by categoryId — produces categoryVisibility entries", () => {
    const prompts: TaggedPrompt[] = [
      { type: "indirect", pillar: null, prompt: "q1", categoryId: "ortho", tier: "buy" },
      { type: "indirect", pillar: null, prompt: "q2", categoryId: "ortho", tier: "buy" },
      { type: "indirect", pillar: null, prompt: "q3", categoryId: "cardio", tier: "solve" },
    ];
    const responses = prompts.map((p) => makeResponse(p.prompt, true));
    const result = aggregateByDimension(responses, prompts, null, catTree);

    expect(result.categoryVisibility).toHaveLength(2);
    expect(result.categoryVisibility.find((c) => c.categoryId === "ortho")).toBeDefined();
    expect(result.categoryVisibility.find((c) => c.categoryId === "cardio")).toBeDefined();
  });

  it("T3: groups by tier — produces exactly 3 tierVisibility entries", () => {
    const prompts: TaggedPrompt[] = [
      { type: "indirect", pillar: null, prompt: "q1", tier: "buy" },
      { type: "indirect", pillar: null, prompt: "q2", tier: "solve" },
      { type: "indirect", pillar: null, prompt: "q3", tier: "learn" },
    ];
    const responses = prompts.map((p) => makeResponse(p.prompt, true));
    const result = aggregateByDimension(responses, prompts, null, null);

    expect(result.tierVisibility).toHaveLength(3);
    const tiers = result.tierVisibility.map((t) => t.tier).sort();
    expect(tiers).toEqual(["buy", "learn", "solve"]);
  });

  it("T4: untagged prompts → empty arrays for all dimensions", () => {
    const prompts: TaggedPrompt[] = [
      { type: "indirect", pillar: null, prompt: "legacy-1" },
      { type: "direct", pillar: null, prompt: "legacy-2" },
    ];
    const responses = prompts.map((p) => makeResponse(p.prompt, false));
    const result = aggregateByDimension(responses, prompts, null, null);

    expect(result.geoVisibility).toEqual([]);
    expect(result.categoryVisibility).toEqual([]);
    expect(result.tierVisibility).toEqual([]);
  });

  it("T5: visibility % computed correctly — 3/5 mentioned → visibility = 60", () => {
    const prompts: TaggedPrompt[] = Array.from({ length: 5 }, (_, i) => ({
      type: "indirect" as const,
      pillar: null,
      prompt: `blr-${i}`,
      geoId: "in-ka-blr",
      tier: "buy" as const,
    }));
    // 3 of 5 mentioned
    const responses = prompts.map((p, i) => makeResponse(p.prompt, i < 3));
    const result = aggregateByDimension(responses, prompts, geoTree, null);

    const blr = result.geoVisibility.find((g) => g.geoId === "in-ka-blr");
    expect(blr!.visibility).toBe(60);
    expect(blr!.mentionCount).toBe(3);
    expect(blr!.promptCount).toBe(5);
  });

  it("T6: resolves geoId → geoName from tree", () => {
    const prompts: TaggedPrompt[] = [
      { type: "indirect", pillar: null, prompt: "q1", geoId: "in-ka-blr", tier: "buy" },
    ];
    const responses = [makeResponse("q1", true)];
    const result = aggregateByDimension(responses, prompts, geoTree, null);

    expect(result.geoVisibility[0].geoName).toBe("Bangalore");
  });

  it("T7: falls back to geoId as name when no tree provided", () => {
    const prompts: TaggedPrompt[] = [
      { type: "indirect", pillar: null, prompt: "q1", geoId: "in-ka-blr", tier: "buy" },
    ];
    const responses = [makeResponse("q1", true)];
    const result = aggregateByDimension(responses, prompts, null, null);

    expect(result.geoVisibility[0].geoName).toBe("in-ka-blr");
  });

  it("T8: resolves categoryId → categoryName from tree", () => {
    const prompts: TaggedPrompt[] = [
      { type: "indirect", pillar: null, prompt: "q1", categoryId: "ortho", tier: "buy" },
    ];
    const responses = [makeResponse("q1", true)];
    const result = aggregateByDimension(responses, prompts, null, catTree);

    expect(result.categoryVisibility[0].categoryName).toBe("Orthopedics");
  });
});

// ═══════════════════════════════════════════════════════════════════
// SECTION 2: computeImpressionShare — Cross
// ═══════════════════════════════════════════════════════════════════

describe("computeImpressionShare — impression share metric", () => {
  it("T9: single mention among 7 items → share between 5–25%", () => {
    const response = [
      "Here are the top hospitals in Bangalore for comprehensive healthcare.",
      "1. Apollo Hospitals is a leading multi-specialty chain with advanced surgical facilities and a strong network across India.",
      "2. Manipal Hospitals is known for comprehensive care and experienced doctors across multiple specialties.",
      "3. Fortis Healthcare is a major network offering quality treatment options in cardiology and orthopedics.",
      "4. Narayana Health provides affordable cardiac care and multi-specialty services for patients across India.",
      "5. Columbia Asia brings international standard healthcare with modern technology systems and trained staff.",
      "6. Sakra World Hospital offers premium healthcare with cutting edge technology and international doctors.",
      "7. Aster CMI Hospital is a growing network with specialized departments and experienced medical experts.",
    ].join(" ");

    const share = computeImpressionShare(response, "manipalhospitals.com");
    expect(share).not.toBeNull();
    expect(share!).toBeGreaterThanOrEqual(5);
    expect(share!).toBeLessThanOrEqual(25);
  });

  it("T10: dominant mention → share > 50%", () => {
    const response =
      "Manipal Hospitals is the leading healthcare provider in India with world class facilities. " +
      "Manipal Hospitals operates across 28 cities with 10000 beds and serves millions of patients. " +
      "Manipal Hospitals is known for advanced cardiac and neuro surgery with top rated specialists. " +
      "Manipal Hospitals pioneered organ transplant programs in South India with excellent outcomes. " +
      "Manipal Hospitals trains top medical professionals across all specialties in modern training centers. " +
      "Manipal Hospitals has earned numerous national and international awards for clinical excellence.";

    const share = computeImpressionShare(response, "manipalhospitals.com");
    expect(share).not.toBeNull();
    expect(share!).toBeGreaterThan(50);
  });

  it("T11: very short response → null", () => {
    const share = computeImpressionShare("Manipal is a hospital.", "manipalhospitals.com");
    expect(share).toBeNull();
  });

  it("T12: no mention → 0", () => {
    const response = [
      "Here are the top hospitals in Bangalore for cardiac care:",
      "1. Apollo Hospitals provides advanced cardiac surgery with top surgeons.",
      "2. Fortis Healthcare offers comprehensive cardiac treatment across major cities.",
      "3. Narayana Health pioneered affordable cardiac surgery for all patients.",
      "4. Columbia Asia brings international healthcare standards to India today.",
      "5. Max Healthcare is growing rapidly with modern surgical facilities available.",
    ].join(" ");

    const share = computeImpressionShare(response, "manipalhospitals.com");
    expect(share).not.toBeNull();
    expect(share!).toBe(0);
  });

  it("T13: handles subdomain extraction (www.manipalhospitals.com)", () => {
    const response =
      "Top hospitals in India include Manipal Hospitals for comprehensive multi-specialty care and treatment. " +
      "Apollo Hospitals provides excellent cardiac surgery and oncology services across major Indian cities. " +
      "Fortis Healthcare offers advanced orthopedic treatment and joint replacement surgery with good outcomes. " +
      "Narayana Health is known for affordable cardiac surgery that serves patients from all economic backgrounds. " +
      "Columbia Asia brings international healthcare standards with modern technology and qualified medical staff.";

    const share = computeImpressionShare(response, "www.manipalhospitals.com");
    expect(share).not.toBeNull();
    expect(share!).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// SECTION 3: generateTierInsight — C6
// ═══════════════════════════════════════════════════════════════════

describe("generateTierInsight — tier scoring insights", () => {
  it("T14: Buy >> Learn (diff > 15) → expertise message", () => {
    const tiers: TierVisibility[] = [
      { tier: "buy", promptCount: 10, mentionCount: 7, visibility: 70 },
      { tier: "solve", promptCount: 10, mentionCount: 5, visibility: 50 },
      { tier: "learn", promptCount: 10, mentionCount: 3, visibility: 30 },
    ];
    const insight = generateTierInsight(tiers);
    expect(insight).not.toBeNull();
    expect(insight!.toLowerCase()).toContain("expertise");
  });

  it("T15: Learn >> Buy (diff > 15) → product positioning message", () => {
    const tiers: TierVisibility[] = [
      { tier: "buy", promptCount: 10, mentionCount: 2, visibility: 20 },
      { tier: "solve", promptCount: 10, mentionCount: 4, visibility: 40 },
      { tier: "learn", promptCount: 10, mentionCount: 7, visibility: 70 },
    ];
    const insight = generateTierInsight(tiers);
    expect(insight).not.toBeNull();
    expect(insight!.toLowerCase()).toContain("product positioning");
  });

  it("T16: Solve lowest (>15 below avg) → problem-solving message", () => {
    const tiers: TierVisibility[] = [
      { tier: "buy", promptCount: 10, mentionCount: 6, visibility: 60 },
      { tier: "solve", promptCount: 10, mentionCount: 1, visibility: 10 },
      { tier: "learn", promptCount: 10, mentionCount: 5, visibility: 50 },
    ];
    const insight = generateTierInsight(tiers);
    expect(insight).not.toBeNull();
    expect(insight!.toLowerCase()).toContain("problem-solving");
  });

  it("T17: all tiers within 5 points → null", () => {
    const tiers: TierVisibility[] = [
      { tier: "buy", promptCount: 10, mentionCount: 5, visibility: 50 },
      { tier: "solve", promptCount: 10, mentionCount: 5, visibility: 48 },
      { tier: "learn", promptCount: 10, mentionCount: 5, visibility: 53 },
    ];
    expect(generateTierInsight(tiers)).toBeNull();
  });

  it("T18: empty array → null", () => {
    expect(generateTierInsight([])).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// SECTION 4: scoreGeographicSignals — C7 (17th pillar)
// ═══════════════════════════════════════════════════════════════════

import { scoreGeographicSignals } from "@/lib/services/geo-analyzer";
import type { GeoScore } from "@/lib/services/geo-analyzer";

function makeCrawlPage(overrides: {
  url?: string;
  existingSchema?: string;
  contactInfo?: string;
  content?: string;
  pageType?: string;
}) {
  return {
    url: overrides.url ?? "https://example.com/page",
    title: "Test Page",
    h1: "Test",
    headings: [{ level: 2, text: "Section" }],
    content: overrides.content ?? "Generic content.",
    pageType: overrides.pageType ?? "services",
    existingSchema: overrides.existingSchema ?? "",
    hasStructuredData: false,
    contactInfo: overrides.contactInfo ?? "",
    faqContent: [],
    testimonials: [],
    certifications: [],
  };
}

function makeCrawlDataForGeo(pages: ReturnType<typeof makeCrawlPage>[]) {
  return { pages, domain: "example.com", totalCrawled: pages.length };
}

describe("scoreGeographicSignals — C7 deterministic geo pillar", () => {
  it("T19: full geo signals → score >= 80", () => {
    const pages = [
      makeCrawlPage({
        url: "https://example.com",
        existingSchema: '{"@type":"LocalBusiness","geo":{"@type":"GeoCoordinates"},"address":{"@type":"PostalAddress"},"areaServed":"Bangalore"}',
        contactInfo: "123 MG Road, Bangalore, Karnataka 560001",
        content: 'Office at 123 MG Road. geo.region content="IN-KA"',
      }),
      makeCrawlPage({
        url: "https://example.com/locations/bangalore",
        contactInfo: "456 Brigade Road, Bangalore 560025",
      }),
      makeCrawlPage({
        url: "https://example.com/locations/delhi",
        contactInfo: "789 Connaught Place, New Delhi 110001",
      }),
      makeCrawlPage({
        url: "https://example.com/contact",
        contactInfo: "101 Park Street, Kolkata 700016",
      }),
    ];

    const result = scoreGeographicSignals(makeCrawlDataForGeo(pages), null);
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.pillar).toBe("geographic_signals");
    expect(result.pillarName).toBe("Geographic Signals");
  });

  it("T20: SaaS with no geo signals → score <= 10", () => {
    const pages = [
      makeCrawlPage({ url: "https://saas.io", content: "Cloud platform for teams." }),
      makeCrawlPage({ url: "https://saas.io/pricing", content: "Plans and pricing." }),
    ];

    const result = scoreGeographicSignals(makeCrawlDataForGeo(pages), null);
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it("T21: LocalBusiness schema only → score = 20", () => {
    const pages = [
      makeCrawlPage({ existingSchema: '{"@type":"LocalBusiness","name":"Clinic"}' }),
      makeCrawlPage({ content: "About us." }),
    ];

    const result = scoreGeographicSignals(makeCrawlDataForGeo(pages), null);
    expect(result.score).toBe(20);
  });

  it("T22: addresses on only 2 pages (below 3 threshold) → no address points", () => {
    const pages = [
      makeCrawlPage({ contactInfo: "123 Main St, City 12345" }),
      makeCrawlPage({ contactInfo: "456 Oak Ave, Town 67890" }),
    ];

    const result = scoreGeographicSignals(makeCrawlDataForGeo(pages), null);
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it("T23: location pages (/locations/*) → +15 points", () => {
    const pages = [
      makeCrawlPage({ url: "https://example.com/locations/bangalore" }),
      makeCrawlPage({ url: "https://example.com/locations/delhi" }),
    ];

    const result = scoreGeographicSignals(makeCrawlDataForGeo(pages), null);
    expect(result.score).toBe(15);
  });

  it("T24: score capped at 100", () => {
    // Everything maxed: LocalBusiness + GeoCoordinates + PostalAddress + areaServed + 3 addresses + locations + geo meta
    const pages = [
      makeCrawlPage({
        url: "https://example.com/locations/a",
        existingSchema: '{"@type":"LocalBusiness","geo":{"@type":"GeoCoordinates"},"address":{"@type":"PostalAddress"},"areaServed":"City"}',
        contactInfo: "addr 1",
        content: 'geo.region content="IN-KA" geo.placename="Bangalore"',
      }),
      makeCrawlPage({ url: "https://example.com/locations/b", contactInfo: "addr 2" }),
      makeCrawlPage({ url: "https://example.com/locations/c", contactInfo: "addr 3" }),
    ];

    const result = scoreGeographicSignals(makeCrawlDataForGeo(pages), null);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("T25: returns GeoScore with correct pillar metadata", () => {
    const result = scoreGeographicSignals(makeCrawlDataForGeo([makeCrawlPage({})]), null);
    expect(result).toHaveProperty("pillar", "geographic_signals");
    expect(result).toHaveProperty("pillarName", "Geographic Signals");
    expect(result).toHaveProperty("findings");
    expect(result).toHaveProperty("recommendation");
    expect(result).toHaveProperty("priority");
    expect(result).toHaveProperty("impactedPages");
  });
});

// ═══════════════════════════════════════════════════════════════════
// SECTION 5: validateCrawlCoverage — Cross
// ═══════════════════════════════════════════════════════════════════

import { validateCrawlCoverage } from "@/lib/services/crawl-coverage-validator";

function makeCrawlPageSimple(pageType: string, url?: string) {
  return {
    url: url ?? `https://example.com/${pageType}`,
    title: `${pageType} page`,
    content: "Content.",
    pageType,
  };
}

describe("validateCrawlCoverage — crawl coverage report", () => {
  it("T26: full coverage → 100%, no warnings, no missing types", () => {
    const pages = [
      makeCrawlPageSimple("homepage"),
      makeCrawlPageSimple("about"),
      makeCrawlPageSimple("services"),
      makeCrawlPageSimple("pricing"),
      makeCrawlPageSimple("contact"),
      makeCrawlPageSimple("team"),
      makeCrawlPageSimple("faq"),
    ];
    const report = validateCrawlCoverage({ totalPages: 7 }, { pages, domain: "example.com" } as any);

    expect(report.coveragePercent).toBe(100);
    expect(report.missingPageTypes).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("T27: low coverage (10%) → warning about low crawl percentage", () => {
    const pages = Array.from({ length: 50 }, (_, i) =>
      makeCrawlPageSimple("blog", `https://example.com/blog/${i}`)
    );
    const report = validateCrawlCoverage({ totalPages: 500 }, { pages, domain: "example.com" } as any);

    expect(report.coveragePercent).toBe(10);
    expect(report.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("T28: missing structural types detected", () => {
    const pages = [makeCrawlPageSimple("homepage"), makeCrawlPageSimple("about")];
    const report = validateCrawlCoverage({ totalPages: 2 }, { pages, domain: "example.com" } as any);

    expect(report.missingPageTypes).toContain("services");
    expect(report.missingPageTypes).toContain("pricing");
    expect(report.missingPageTypes).toContain("contact");
    expect(report.missingPageTypes).toContain("faq");
  });

  it("T29: blog-heavy (>60%) → warning", () => {
    const pages = [
      makeCrawlPageSimple("homepage"),
      ...Array.from({ length: 9 }, (_, i) =>
        makeCrawlPageSimple("blog", `https://example.com/blog/${i}`)
      ),
    ];
    const report = validateCrawlCoverage({ totalPages: 10 }, { pages, domain: "example.com" } as any);

    expect(report.blogPercent).toBe(90);
    expect(report.warnings.some((w) => w.toLowerCase().includes("blog"))).toBe(true);
  });

  it("T30: empty crawl → 0% coverage, warnings present", () => {
    const report = validateCrawlCoverage({ totalPages: 100 }, { pages: [], domain: "example.com" } as any);

    expect(report.totalCrawled).toBe(0);
    expect(report.coveragePercent).toBe(0);
    expect(report.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("T31: structural percentage computed correctly", () => {
    const pages = [
      makeCrawlPageSimple("homepage"),
      makeCrawlPageSimple("about"),
      makeCrawlPageSimple("services"),
      makeCrawlPageSimple("blog", "https://example.com/blog/1"),
      makeCrawlPageSimple("blog", "https://example.com/blog/2"),
    ];
    const report = validateCrawlCoverage({ totalPages: 5 }, { pages, domain: "example.com" } as any);

    // 3 structural out of 5 → 60%
    expect(report.structuralPercent).toBe(60);
  });
});

// ═══════════════════════════════════════════════════════════════════
// SECTION 6: generateVisibilityGapAnalysis — Cross
// ═══════════════════════════════════════════════════════════════════

import { generateVisibilityGapAnalysis } from "@/app/api/sites/[id]/citation-check/route";

describe("generateVisibilityGapAnalysis — gap analysis", () => {
  it("T32: prioritizes worst gaps first (lowest visibility)", () => {
    const geo: GeoVisibility[] = [
      { geoId: "blr", geoName: "Bangalore", promptCount: 10, mentionCount: 4, visibility: 40 },
      { geoId: "del", geoName: "Delhi", promptCount: 10, mentionCount: 0, visibility: 0 },
      { geoId: "kol", geoName: "Kolkata", promptCount: 10, mentionCount: 0, visibility: 5 },
    ];

    const gaps = generateVisibilityGapAnalysis(geo, [], []);

    // Only del (0%) and kol (5%) below 10% threshold
    expect(gaps.length).toBe(2);
    expect(gaps[0].id).toBe("del"); // worst first
    expect(gaps[1].id).toBe("kol");
  });

  it("T33: caps at 10 entries", () => {
    const geo: GeoVisibility[] = Array.from({ length: 15 }, (_, i) => ({
      geoId: `city-${i}`,
      geoName: `City ${i}`,
      promptCount: 10,
      mentionCount: 0,
      visibility: 0,
    }));

    const gaps = generateVisibilityGapAnalysis(geo, [], []);
    expect(gaps.length).toBeLessThanOrEqual(10);
  });

  it("T34: ignores entries with visibility >= 10%", () => {
    const geo: GeoVisibility[] = [
      { geoId: "blr", geoName: "Bangalore", promptCount: 10, mentionCount: 5, visibility: 50 },
    ];
    const cat: CategoryVisibility[] = [
      { categoryId: "ortho", categoryName: "Orthopedics", promptCount: 10, mentionCount: 3, visibility: 30 },
    ];

    const gaps = generateVisibilityGapAnalysis(geo, cat, []);
    expect(gaps).toEqual([]);
  });

  it("T35: includes category gaps below 10%", () => {
    const cat: CategoryVisibility[] = [
      { categoryId: "ortho", categoryName: "Orthopedics", promptCount: 10, mentionCount: 0, visibility: 3 },
    ];

    const gaps = generateVisibilityGapAnalysis([], cat, []);

    expect(gaps.length).toBe(1);
    expect(gaps[0].dimension).toBe("category");
    expect(gaps[0].id).toBe("ortho");
  });

  it("T36: each gap has required fields", () => {
    const geo: GeoVisibility[] = [
      { geoId: "del", geoName: "Delhi", promptCount: 10, mentionCount: 0, visibility: 0 },
    ];

    const gaps = generateVisibilityGapAnalysis(geo, [], []);

    expect(gaps[0]).toHaveProperty("dimension", "geo");
    expect(gaps[0]).toHaveProperty("id", "del");
    expect(gaps[0]).toHaveProperty("name", "Delhi");
    expect(gaps[0]).toHaveProperty("visibility", 0);
    expect(gaps[0]).toHaveProperty("gap");
    expect(gaps[0]).toHaveProperty("recommendation");
  });
});

// ═══════════════════════════════════════════════════════════════════
// SECTION 7: Schema + type existence checks
// ═══════════════════════════════════════════════════════════════════

describe("ES-054 type contracts", () => {
  it("T37: GeoVisibility type has required fields", () => {
    const gv: GeoVisibility = {
      geoId: "blr",
      geoName: "Bangalore",
      promptCount: 10,
      mentionCount: 5,
      visibility: 50,
    };
    expect(gv.geoId).toBe("blr");
    expect(gv.visibility).toBe(50);
  });

  it("T38: CategoryVisibility type has required fields", () => {
    const cv: CategoryVisibility = {
      categoryId: "ortho",
      categoryName: "Orthopedics",
      promptCount: 10,
      mentionCount: 5,
      visibility: 50,
    };
    expect(cv.categoryId).toBe("ortho");
  });

  it("T39: TierVisibility type has required fields", () => {
    const tv: TierVisibility = {
      tier: "buy",
      promptCount: 10,
      mentionCount: 5,
      visibility: 50,
    };
    expect(tv.tier).toBe("buy");
  });

  it("T40: CrawlCoverageReport type has required fields", () => {
    const r: CrawlCoverageReport = {
      totalDiscovered: 100,
      totalCrawled: 50,
      coveragePercent: 50,
      missingPageTypes: ["faq"],
      blogPercent: 30,
      structuralPercent: 40,
      warnings: [],
    };
    expect(r.coveragePercent).toBe(50);
  });
});
