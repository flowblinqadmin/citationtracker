// Unit tests for ai-surface-audit experiment pipeline
// Authored from ES-pr-1-group-b §f (ratified 2026-04-20).
// TDD: some tests will be RED until ScriptDev exports additional internals.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = path.resolve(__dirname, "../../../scripts/experiments/ai-surface-audit");

import {
  SURFACES,
  detectMerchantMention,
  extractCitedDomains,
} from "../../../scripts/experiments/ai-surface-audit/surface-probes.mjs";

import {
  SIGNAL_CATEGORIES,
  extractSignalsFromPage,
} from "../../../scripts/experiments/ai-surface-audit/signal-extractor.mjs";

import {
  computeCorrelations,
  buildInstrumentabilityMatrix,
  buildCrossSurfaceSummary,
} from "../../../scripts/experiments/ai-surface-audit/correlator.mjs";

// These may not be exported yet — TDD-RED until ScriptDev re-exports.
import * as correlatorMod from "../../../scripts/experiments/ai-surface-audit/correlator.mjs";
import * as pitchBridgeMod from "../../../scripts/experiments/ai-surface-audit/pitch-bridge.mjs";
import * as outreachMod from "../../../scripts/experiments/ai-surface-audit/outreach-generator.mjs";

describe("surface-probes — SURFACES registry (AC-3)", () => {
  it("has exactly 5 surfaces in the documented order", () => {
    expect(SURFACES).toHaveLength(5);
    expect(SURFACES.map((s) => s.name)).toEqual([
      "chatgpt_shopping",
      "perplexity_shopping",
      "google_ai_overview",
      "meta_ai",
      "amazon_rufus",
    ]);
  });

  it("every entry exposes {name, label, fn}", () => {
    for (const s of SURFACES) {
      expect(typeof s.name).toBe("string");
      expect(typeof s.label).toBe("string");
      expect(typeof s.fn).toBe("function");
    }
  });
});

describe("detectMerchantMention (AC-4, AC-5)", () => {
  // U1
  it("U1: domain mention returns matchType='domain'", () => {
    const r = detectMerchantMention(
      "We recommend manipalhospitals.com for cardiac care.",
      "manipalhospitals.com",
    );
    expect(r.mentioned).toBe(true);
    expect(r.matchType).toBe("domain");
  });

  // U2
  it("U2: brand-only (split-suffix) match returns matchType='brand'", () => {
    const r = detectMerchantMention(
      "Manipal Hospitals is a leading multi-specialty provider.",
      "manipalhospitals.com",
    );
    expect(r.mentioned).toBe(true);
    expect(r.matchType).toBe("brand");
  });

  // U3
  it("U3: unrelated text returns mentioned=false, matchType=null, position=null", () => {
    const r = detectMerchantMention(
      "Fortis and Apollo are the preferred choices.",
      "manipalhospitals.com",
    );
    expect(r.mentioned).toBe(false);
    expect(r.matchType).toBeNull();
    expect(r.position).toBeNull();
  });

  // U4
  it("U4: parses position from numbered list", () => {
    const r = detectMerchantMention(
      "1. Apollo\n2. Manipal Hospitals\n3. Fortis",
      "manipalhospitals.com",
    );
    expect(r.position).toBe(2);
  });

  // U5
  it("U5: positive sentiment keywords drive sentiment='positive'", () => {
    const r = detectMerchantMention(
      "Manipal Hospitals is the best, top-rated and leading option.",
      "manipalhospitals.com",
    );
    expect(r.sentiment).toBe("positive");
  });
});

describe("extractCitedDomains", () => {
  // U6
  it("U6: filters infra domains (google.com, wikipedia.org, etc.)", () => {
    const input =
      "See https://google.com and https://wikipedia.org — also revzilla.com is great.";
    const out = extractCitedDomains(input);
    expect(out).not.toContain("google.com");
    expect(out).not.toContain("wikipedia.org");
    expect(out).toContain("revzilla.com");
  });

  // U7
  it("U7: bare-domain regex captures domains in plain prose", () => {
    const out = extractCitedDomains("Check revzilla.com and cyclegear.com for gear.");
    expect(out).toEqual(expect.arrayContaining(["revzilla.com", "cyclegear.com"]));
  });
});

describe("extractSignalsFromPage (AC-2 signal keys)", () => {
  // U8
  it("U8: JSON-LD Product schema sets hasProductSchema=true, schemaCount>=1", () => {
    const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget"}</script>`;
    const s = extractSignalsFromPage("https://example.com", html, "Widget");
    expect(s.hasProductSchema).toBe(true);
    expect(s.schemaCount).toBeGreaterThanOrEqual(1);
  });

  // U9
  it("U9: robots noindex meta → noindexPresent=true", () => {
    const html = `<meta name="robots" content="noindex, nofollow">`;
    const s = extractSignalsFromPage("https://example.com", html, "");
    expect(s.noindexPresent).toBe(true);
  });

  // U10
  it("U10: wordCount splits whitespace and filters empty tokens", () => {
    const md = "  hello   world  foo\tbar\n\nbaz ";
    const s = extractSignalsFromPage("https://example.com", "<html></html>", md);
    expect(s.wordCount).toBe(5);
  });

  it("exposes 7 SIGNAL_CATEGORIES keys (AC-2 extra)", () => {
    expect(Object.keys(SIGNAL_CATEGORIES).sort()).toEqual(
      ["content", "crawlability", "freshness", "reviews", "schema", "social", "technical"].sort(),
    );
  });
});

describe("correlator math (AC-8) — exposed pearson/pointBiserial", () => {
  // U11 — requires pearson re-export (TDD: RED until ScriptDev exports)
  it("U11: pearson([1..5],[2..10]) ≈ 1.0", () => {
    expect(typeof correlatorMod.pearson).toBe("function");
    const r = correlatorMod.pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
    expect(r).toBeCloseTo(1.0, 5);
  });

  // U12
  it("U12: pearson with zero variance returns null", () => {
    expect(typeof correlatorMod.pearson).toBe("function");
    expect(correlatorMod.pearson([1, 1, 1], [1, 2, 3])).toBeNull();
  });

  // U13
  it("U13: pointBiserial([T,F,T,F],[10,0,10,0]) ≈ 1.0", () => {
    expect(typeof correlatorMod.pointBiserial).toBe("function");
    const r = correlatorMod.pointBiserial([true, false, true, false], [10, 0, 10, 0]);
    expect(r).toBeCloseTo(1.0, 5);
  });
});

describe("computeCorrelations + buildInstrumentabilityMatrix + buildCrossSurfaceSummary", () => {
  function makeMerchants() {
    // 5 merchants; varying hasProductSchema, constant hasOrgSchema (→ should skip);
    // schemaCount correlates with visibility on chatgpt_shopping.
    const rows = [
      { schema: false, count: 0, vis: 10 },
      { schema: true, count: 2, vis: 40 },
      { schema: true, count: 4, vis: 60 },
      { schema: false, count: 1, vis: 20 },
      { schema: true, count: 5, vis: 80 },
    ];
    return rows.map((r, i) => ({
      domain: `m${i}.com`,
      signals: {
        hasProductSchema: r.schema,
        hasOrgSchema: true, // constant: should be skipped
        hasOfferSchema: false, // constant: should be skipped
        hasReviewSchema: false,
        hasFAQSchema: false,
        hasBreadcrumbs: false,
        hasSearchAction: false,
        hasMerchantReturn: false,
        hasShippingDetails: false,
        hasLlmsTxt: false,
        hasSitemap: false,
        hasRobotsTxt: false,
        allowsAIBots: true,
        blocksGPTBot: false,
        blocksCCBot: false,
        blocksPerplexityBot: false,
        hasAnyReviews: false,
        hasFAQContent: false,
        hasComparisonContent: false,
        hasPricingContent: false,
        hasShippingInfo: false,
        hasReturnPolicy: false,
        hasCanonicalTag: true,
        hasMetaDescription: true,
        hasOpenGraph: true,
        mentionsCurrentYear: true,
        schemaCount: r.count,
        schemaScore: r.count * 8,
        reviewPlatformCount: 0,
        estimatedReviewCount: 0,
        freshnessScore: 100,
        contentScore: 50,
        maxWordCount: 500,
        socialChannelCount: 0,
      },
      visibility: [
        { surface: "chatgpt_shopping", visibilityScore: r.vis },
        { surface: "perplexity_shopping", visibilityScore: r.vis / 2 },
      ],
    }));
  }

  // U14
  it("U14: skips boolean signals where all merchants share same value", () => {
    const merchants = makeMerchants();
    const out = computeCorrelations(merchants);
    const chatgpt = out.chatgpt_shopping;
    const sigKeys = chatgpt.signals.map((s) => s.signal);
    expect(sigKeys).not.toContain("hasOrgSchema");
    expect(sigKeys).not.toContain("hasOfferSchema");
    // hasProductSchema varies — should be present
    expect(sigKeys).toContain("hasProductSchema");
  });

  // U15
  it("U15: buildInstrumentabilityMatrix drops signals with |r|<0.15", () => {
    const fakeCorr = {
      s1: {
        signals: [
          { signal: "a", label: "A", absCorrelation: 0.1, correlation: 0.1, instrumentable: true, effort: "low", category: "schema" },
          { signal: "b", label: "B", absCorrelation: 0.5, correlation: 0.5, instrumentable: true, effort: "low", category: "schema" },
        ],
      },
    };
    const m = buildInstrumentabilityMatrix(fakeCorr);
    expect(m.find((x) => x.signal === "A")).toBeUndefined();
    expect(m.find((x) => x.signal === "B")).toBeDefined();
  });

  // U16
  it("U16: ranks by |r|×effort_multiplier (low=100, medium=70, high=40)", () => {
    const fakeCorr = {
      s1: {
        signals: [
          { signal: "low_r", label: "L", absCorrelation: 0.3, correlation: 0.3, instrumentable: true, effort: "low", category: "x" },
          { signal: "med_r", label: "M", absCorrelation: 0.5, correlation: 0.5, instrumentable: true, effort: "medium", category: "x" },
          { signal: "high_r", label: "H", absCorrelation: 0.5, correlation: 0.5, instrumentable: true, effort: "high", category: "x" },
        ],
      },
    };
    const m = buildInstrumentabilityMatrix(fakeCorr);
    // expected impactScores: L=30, M=35, H=20 → order M, L, H (ranking by |r|×effort)
    expect(m.map((x) => x.impactScore)).toEqual([35, 30, 20]);
    expect(m[0].effort).toBe("medium");
    expect(m[1].effort).toBe("low");
    expect(m[2].effort).toBe("high");
  });

  // U17
  it("U17: buildCrossSurfaceSummary averages correlation across surfaces and computes consistency", () => {
    const correlations = {
      s1: {
        signals: [
          { signal: "foo", label: "Foo", category: "x", instrumentable: true, effort: "low", correlation: 0.4 },
        ],
      },
      s2: {
        signals: [
          { signal: "foo", label: "Foo", category: "x", instrumentable: true, effort: "low", correlation: 0.6 },
        ],
      },
    };
    const summary = buildCrossSurfaceSummary(correlations);
    expect(summary).toHaveLength(1);
    expect(summary[0].avgCorrelation).toBeCloseTo(0.5, 3);
    expect(summary[0].consistency).toBe(100);
  });
});

describe("pitch-bridge.buildAuditJson (AC-12) — TDD RED until export added", () => {
  // U18
  it("U18: signals missing both Product+Org schema → high-severity identity issue", () => {
    expect(typeof pitchBridgeMod.buildAuditJson).toBe("function");
    const merchant = { domain: "example.com", vertical: "healthcare" };
    const signals = { hasProductSchema: false, hasOrgSchema: false };
    const json = pitchBridgeMod.buildAuditJson(merchant, signals, []);
    const hit = json.issues.find((i) => /machine-readable business identity/i.test(i.name));
    expect(hit).toBeDefined();
    expect(hit.severity).toBe("high");
  });

  // U19
  it("U19: allowsAIBots === false → high-severity 'AI bots blocked' issue", () => {
    expect(typeof pitchBridgeMod.buildAuditJson).toBe("function");
    const json = pitchBridgeMod.buildAuditJson(
      { domain: "example.com", vertical: "healthcare" },
      { allowsAIBots: false },
      [],
    );
    const hit = json.issues.find((i) => /AI bots blocked/i.test(i.name));
    expect(hit).toBeDefined();
    expect(hit.severity).toBe("high");
  });

  // U20
  it("U20: score clamps into [0,100]", () => {
    expect(typeof pitchBridgeMod.buildAuditJson).toBe("function");
    const json = pitchBridgeMod.buildAuditJson(
      { domain: "example.com", vertical: "healthcare", geoScore: 999 },
      { overallScore: 999 },
      [],
    );
    expect(json.score).toBeGreaterThanOrEqual(0);
    expect(json.score).toBeLessThanOrEqual(100);
    expect(json.max_score).toBe(100);
  });
});

describe("outreach-generator.generateEmail (draft-only guard)", () => {
  // U21
  it("U21: output never contains 'approved' and starts with 'Hey — I ran an AI visibility audit'", () => {
    expect(typeof outreachMod.generateEmail).toBe("function");
    const merchant = { domain: "example.com", vertical: "healthcare", visibility: [{ surface: "chatgpt_shopping", visibilityScore: 25 }] };
    const caseStudy = { client: "FooCo", before: 10, after: 70, detail: "details here" };
    const gaps = ["no schema", "no reviews"];
    const out = outreachMod.generateEmail(merchant, caseStudy, gaps);
    expect(out.body.toLowerCase()).not.toContain("approved");
    expect(out.body.startsWith("Hey — I ran an AI visibility audit")).toBe(true);
  });
});

describe("cohort + queries integrity (AC-6, AC-7)", () => {
  const cohort = JSON.parse(readFileSync(path.join(SCRIPT_DIR, "merchant-cohort.json"), "utf8"));
  const queries = JSON.parse(readFileSync(path.join(SCRIPT_DIR, "shopping-queries.json"), "utf8"));

  // U22
  it("U22: cohort has exactly 98 entries and every entry has domain/vertical/tier", () => {
    expect(cohort.cohort).toHaveLength(98);
    for (const m of cohort.cohort) {
      expect(typeof m.domain).toBe("string");
      expect(typeof m.vertical).toBe("string");
      expect(["live_client", "competitor", "lookalike"]).toContain(m.tier);
    }
  });

  // U23
  it("U23: every cohort vertical is a key in shopping-queries.json and every queries key has ≥1 cohort entry", () => {
    const qKeys = Object.keys(queries.queries);
    const cVerticals = [...new Set(cohort.cohort.map((m) => m.vertical))];
    for (const v of cVerticals) expect(qKeys).toContain(v);
    for (const k of qKeys) expect(cVerticals).toContain(k);
  });
});
