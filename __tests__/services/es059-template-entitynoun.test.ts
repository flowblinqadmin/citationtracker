/**
 * TDD tests for ES-059 Part C: Template entityNoun + extractCategories preference
 * UT36–UT42
 *
 * Written before implementation (Phase 1).
 * Tests cover: buildSeeds entityNoun, getEntityNoun sources, extractCategories preference.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock SDKs (required by citation-prompt-generator imports) ─────────────────

const { mockAnthropicCreate } = vi.hoisted(() => ({
  mockAnthropicCreate: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockAnthropicCreate } };
  }),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: vi.fn() } } };
  }),
}));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(function () {
    return {
      getGenerativeModel: vi.fn().mockReturnValue({ generateContent: vi.fn() }),
    };
  }),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  buildSeeds,
  extractCategories,
  getEntityNoun,
} from "@/lib/services/citation-prompt-generator";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTriple(category: string) {
  return {
    category,
    geoLevel: { geoId: "g1", level: "country", name: "India" },
    angle: "discovery" as const,
  };
}

// ── UT36: buildSeeds uses entityNoun "hospitals" ──────────────────────────────

describe("UT36 — buildSeeds: uses entityNoun in discovery template", () => {
  it("should produce 'What are the best Oncology hospitals in India?'", () => {
    const seeds = buildSeeds([makeTriple("Oncology")], "hospital.com", "hospitals");
    // Single triple → seeds[0] is the discovery seed
    const discoveryText = seeds[0]?.text ?? "";
    expect(discoveryText).toContain("Oncology");
    expect(discoveryText).toContain("hospitals");
    expect(discoveryText).not.toContain("companies");
  });
});

// ── UT37: buildSeeds defaults to "companies" ─────────────────────────────────

describe("UT37 — buildSeeds: defaults to 'companies' when entityNoun not provided", () => {
  it("should use 'companies' when entityNoun is omitted", () => {
    const seeds = buildSeeds([makeTriple("Oncology")], "hospital.com");
    const discoveryText = seeds[0]?.text ?? "";
    expect(discoveryText).toContain("companies");
  });
});

// ── UT38: getEntityNoun from extractedCategories ──────────────────────────────

describe("UT38 — getEntityNoun: from extractedCategories.entityNoun", () => {
  it("should return 'hospitals' from extractedCategories", () => {
    const site = {
      domain: "hospital.com",
      siteType: "healthcare",
      extractedCategories: {
        categories: ["Oncology", "Cardiology", "Orthopedics"],
        entityNoun: "hospitals",
        extractedAt: new Date().toISOString(),
        source: "haiku" as const,
      },
    };
    expect(getEntityNoun(site as any)).toBe("hospitals");
  });
});

// ── UT39: getEntityNoun from INDUSTRY_NOUN_MAP ────────────────────────────────

describe("UT39 — getEntityNoun: from INDUSTRY_NOUN_MAP", () => {
  it("should return 'hospitals' from INDUSTRY_NOUN_MAP when siteType=healthcare", () => {
    const site = {
      domain: "hospital.com",
      siteType: "healthcare",
      extractedCategories: null,
    };
    expect(getEntityNoun(site as any)).toBe("hospitals");
  });
});

// ── UT40: getEntityNoun default "companies" ───────────────────────────────────

describe("UT40 — getEntityNoun: default 'companies'", () => {
  it("should return 'companies' when no extractedCategories and unknown siteType", () => {
    const site = {
      domain: "unknown.com",
      siteType: null,
      extractedCategories: null,
    };
    expect(getEntityNoun(site as any)).toBe("companies");
  });
});

// ── UT41: Trust template uses entityNoun ─────────────────────────────────────

describe("UT41 — buildSeeds: trust template uses entityNoun correctly", () => {
  it("should produce 'Who are the most trusted hospitals for Cardiology in India?'", () => {
    const triple = {
      category: "Cardiology",
      geoLevel: { geoId: "g1", level: "country", name: "India" },
      angle: "trust" as const,
    };
    const seeds = buildSeeds([triple], "hospital.com", "hospitals");
    // Single triple → seeds[0] is the trust seed
    const trustText = seeds[0]?.text ?? "";
    expect(trustText).toContain("hospitals");
    expect(trustText).toContain("Cardiology");
    expect(trustText).not.toContain("companies");
  });
});

// ── UT42: extractCategories prefers extractedCategories ──────────────────────

describe("UT42 — extractCategories: prefers extractedCategories over topics", () => {
  it("should return extractedCategories when available with ≥3 entries", () => {
    const site = {
      domain: "hospital.com",
      siteType: "healthcare",
      extractedCategories: {
        categories: ["Oncology", "Cardiology", "Orthopedics"],
        entityNoun: "hospitals",
        extractedAt: new Date().toISOString(),
        source: "haiku" as const,
      },
      generatedBusinessJson: {
        geo_profile: {
          topics: ["Topic1", "Topic2", "Topic3"],
        },
      },
      categoryTree: null,
    };
    const cats = extractCategories(site as any);
    expect(cats).toContain("Oncology");
    expect(cats).toContain("Cardiology");
    expect(cats).not.toContain("Topic1");
  });
});
