/**
 * ES-056 — Tier 4: Competitive Intelligence — ScriptDev TDD Tests (T1–T12)
 *
 * Phase 1 tests written BEFORE implementation.
 * Spec: geo/docs/specs/engineering/ES-056-geo-improvement-tier4.md
 *
 * Covers edge cases not already in RM tests (U1–U24).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Setup (for C12 real-prompt-discoverer) ───────────────────

const { mockOpenAICreate: mockPerplexityCreate } = vi.hoisted(() => ({
  mockOpenAICreate: vi.fn(),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockPerplexityCreate } } };
  }),
}));

import {
  aggregateCompetitorsByDimension,
  generateDominanceInsights,
} from "@/lib/services/citation-checker";

import { discoverRealPrompts, clearRealPromptCache } from "@/lib/services/real-prompt-discoverer";

import type { DominanceMap } from "@/lib/types/citation";

// ── Helpers ───────────────────────────────────────────────────────

function makeResponse(
  query: string,
  mentioned: boolean,
  position: number | null,
  competitors: string[]
) {
  return {
    id: crypto.randomUUID(),
    checkId: "chk-1",
    siteId: "site-1",
    provider: "chatgpt",
    model: "gpt-4o",
    query,
    pillar: null,
    promptType: "indirect" as const,
    response: "Response text.",
    responseTimeMs: 500,
    mentioned,
    position,
    sentiment: mentioned ? "positive" : null,
    competitorsMentioned: competitors,
    error: null,
  };
}

type TaggedPrompt = {
  type: "indirect" | "direct";
  pillar: string | null;
  prompt: string;
  geoId?: string;
  categoryId?: string;
  tier?: "buy" | "solve" | "learn";
};

function makeGeoTree(nodes: Array<{ id: string; name: string }>) {
  return {
    root: { id: "root", name: "Root", children: nodes.map(n => ({ id: n.id, name: n.name, children: [] })) },
    leafCount: nodes.length,
  };
}

function makeCategoryTree(leaves: Array<{ id: string; name: string; pageCount?: number }>) {
  return {
    root: {
      id: "root",
      name: "Root",
      children: leaves.map(l => ({ id: l.id, name: l.name, pageCount: l.pageCount ?? 10, children: [] })),
    },
    leafCount: leaves.length,
  };
}

function makePerplexityOk(questions: object[]) {
  return { choices: [{ message: { content: JSON.stringify(questions) } }] };
}

const domain = "example.com";
const geoTree = makeGeoTree([
  { id: "in-ka-blr", name: "Bangalore" },
  { id: "in-dl-del", name: "Delhi" },
]);
const categoryTree = makeCategoryTree([
  { id: "cat-ortho", name: "Orthopedics", pageCount: 15 },
  { id: "cat-cardio", name: "Cardiology", pageCount: 10 },
]);

// ── T1–T5: aggregateCompetitorsByDimension edge cases ─────────────

describe("aggregateCompetitorsByDimension — ES-056 C11 (TDD)", () => {
  it("T1: brand domain excluded from competitor list", () => {
    // If competitor name matches the brand domain, it should NOT appear in results
    const prompts: TaggedPrompt[] = Array.from({ length: 4 }, (_, i) => ({
      type: "indirect" as const, pillar: null,
      prompt: `blr-${i}`, geoId: "in-ka-blr", tier: "buy" as const,
    }));
    // Include brand domain in competitorsMentioned — it should be filtered out
    const responses = prompts.map(p =>
      makeResponse(p.prompt, true, 2, [domain, "apollo"])
    );

    const result = aggregateCompetitorsByDimension(responses, prompts, domain, geoTree, null);

    const blr = result.locationCompetitors.find(l => l.geoId === "in-ka-blr");
    const brandAsCompetitor = blr?.competitors.find(
      c => c.domain === domain || c.name === domain
    );
    expect(brandAsCompetitor).toBeUndefined();
  });

  it("T2: same competitor mentioned in multiple responses aggregated once per group", () => {
    const prompts: TaggedPrompt[] = Array.from({ length: 5 }, (_, i) => ({
      type: "indirect" as const, pillar: null,
      prompt: `blr-${i}`, geoId: "in-ka-blr", tier: "buy" as const,
    }));
    const responses = prompts.map(p =>
      makeResponse(p.prompt, true, 2, ["apollo", "apollo"]) // same competitor twice in one response
    );

    const result = aggregateCompetitorsByDimension(responses, prompts, domain, geoTree, null);

    const blr = result.locationCompetitors.find(l => l.geoId === "in-ka-blr");
    const apolloEntries = blr?.competitors.filter(c => c.domain === "apollo" || c.name === "apollo");
    // Should appear exactly once (deduplicated within group)
    expect(apolloEntries?.length).toBe(1);
  });

  it("T3: dominanceMap.computedAt is a valid ISO-8601 timestamp", () => {
    const prompts: TaggedPrompt[] = Array.from({ length: 4 }, (_, i) => ({
      type: "indirect" as const, pillar: null,
      prompt: `q-${i}`, geoId: "in-ka-blr", tier: "buy" as const,
    }));
    const responses = prompts.map(p => makeResponse(p.prompt, true, 2, ["apollo"]));

    const result = aggregateCompetitorsByDimension(responses, prompts, domain, geoTree, null);

    expect(result.dominanceMap.computedAt).toBeTruthy();
    expect(new Date(result.dominanceMap.computedAt).toISOString()).toBe(result.dominanceMap.computedAt);
  });

  it("T4: dominanceMap sorted by gap descending (worst gap first)", () => {
    // Two geos: Bangalore has huge gap, Delhi has small gap
    const prompts: TaggedPrompt[] = [
      ...Array.from({ length: 5 }, (_, i) => ({
        type: "indirect" as const, pillar: null,
        prompt: `blr-${i}`, geoId: "in-ka-blr", tier: "buy" as const,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        type: "indirect" as const, pillar: null,
        prompt: `del-${i}`, geoId: "in-dl-del", tier: "buy" as const,
      })),
    ];

    // Bangalore: apollo in 4/5 (SOV 80%), brand in 0/5 → gap ~80
    // Delhi: apollo in 1/4 (SOV 25%), brand in 2/4 (SOV 50%) → brand leads
    const responses = [
      makeResponse("blr-0", false, null, ["apollo"]),
      makeResponse("blr-1", false, null, ["apollo"]),
      makeResponse("blr-2", false, null, ["apollo"]),
      makeResponse("blr-3", false, null, ["apollo"]),
      makeResponse("blr-4", true, 2, []),
      makeResponse("del-0", true, 1, ["apollo"]),
      makeResponse("del-1", true, 1, []),
      makeResponse("del-2", true, 2, []),
      makeResponse("del-3", true, 2, []),
    ];

    const result = aggregateCompetitorsByDimension(responses, prompts, domain, geoTree, null);

    // Among the non-global entries, the Bangalore entry (higher gap) should come before Delhi
    const nonGlobal = result.dominanceMap.entries.filter(e => e.geoId !== null);
    if (nonGlobal.length >= 2) {
      expect(nonGlobal[0].gap).toBeGreaterThanOrEqual(nonGlobal[1].gap);
    }
  });

  it("T5: responses with no competitorsMentioned produce no competitor entries", () => {
    const prompts: TaggedPrompt[] = Array.from({ length: 4 }, (_, i) => ({
      type: "indirect" as const, pillar: null,
      prompt: `blr-${i}`, geoId: "in-ka-blr", tier: "buy" as const,
    }));
    const responses = prompts.map(p => makeResponse(p.prompt, true, 2, []));

    const result = aggregateCompetitorsByDimension(responses, prompts, domain, geoTree, null);

    const blr = result.locationCompetitors.find(l => l.geoId === "in-ka-blr");
    // Entry exists (4 prompts ≥ 3) but with no competitors
    if (blr) {
      expect(blr.competitors).toHaveLength(0);
    }
    // Global entry exists but also no competitors
    const global = result.dominanceMap.entries.find(e => e.geoId === null && e.categoryId === null);
    expect(global).toBeDefined();
  });
});

// ── T6–T8: generateDominanceInsights edge cases ───────────────────

describe("generateDominanceInsights — ES-056 C11 (TDD)", () => {
  it("T6: capped at 5 insights even with many entries", () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({
      geoId: `geo-${i}`,
      categoryId: null,
      topBrand: "apollo",
      topBrandSOV: 60,
      brandSOV: 10,
      gap: 50 - i, // varying gaps, all > 30
    }));
    const dominanceMap: DominanceMap = { entries, computedAt: new Date().toISOString() };

    const insights = generateDominanceInsights(dominanceMap, null, null);

    expect(insights.length).toBeLessThanOrEqual(5);
  });

  it("T7: global entry (geoId=null) generates insight without crashing", () => {
    const dominanceMap: DominanceMap = {
      entries: [{
        geoId: null,
        categoryId: null,
        topBrand: "apollo",
        topBrandSOV: 50,
        brandSOV: 15,
        gap: 35,
      }],
      computedAt: new Date().toISOString(),
    };

    expect(() => generateDominanceInsights(dominanceMap, null, null)).not.toThrow();
    const insights = generateDominanceInsights(dominanceMap, null, null);
    expect(insights.length).toBeGreaterThanOrEqual(1);
  });

  it("T8: zero-gap entry (no competitor found) does not generate 'dominates' or 'lead'", () => {
    const dominanceMap: DominanceMap = {
      entries: [{
        geoId: "in-ka-blr",
        categoryId: null,
        topBrand: "",
        topBrandSOV: 0,
        brandSOV: 0,
        gap: 0,
      }],
      computedAt: new Date().toISOString(),
    };

    const insights = generateDominanceInsights(dominanceMap, geoTree, null);

    // No "dominates" or "lead" insight when gap=0 and brandSOV=0
    const hasDominates = insights.some(i => i.toLowerCase().includes("dominat"));
    const hasLead = insights.some(i => i.toLowerCase().includes("lead"));
    expect(hasDominates).toBe(false);
    expect(hasLead).toBe(false);
  });
});

// ── T9–T12: discoverRealPrompts edge cases ────────────────────────

describe("discoverRealPrompts — ES-056 C12 (TDD)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRealPromptCache();
    process.env.PERPLEXITY_API_KEY = "test-key";
  });

  it("T9: Jaccard similarity below 80% threshold does NOT deduplicate", async () => {
    // Two questions with ~60% word overlap should NOT be deduplicated
    const questions = [
      { source: "paa", query: "Best orthopedic hospital for knee replacement in India?", context: "ctx", url: "url1" },
      { source: "reddit", query: "Which hospital is best for cardiac surgery in Delhi?", context: "ctx", url: "url2" },
    ];
    mockPerplexityCreate.mockResolvedValue(makePerplexityOk(questions));

    const result = await discoverRealPrompts(categoryTree as any, undefined, "example.com");

    // Both should survive (low overlap)
    expect(result.length).toBe(2);
  });

  it("T10: domain filter is case-insensitive", async () => {
    const questions = [
      { source: "paa", query: "Is EXAMPLE.COM the best hospital?", context: "ctx", url: "url1" },
      { source: "reddit", query: "Best hospital for orthopedics?", context: "ctx", url: "url2" },
    ];
    mockPerplexityCreate.mockResolvedValue(makePerplexityOk(questions));

    const result = await discoverRealPrompts(categoryTree as any, undefined, "example.com");

    // EXAMPLE.COM question should be filtered (case-insensitive domain match)
    const brandQ = result.find(q => q.query.toLowerCase().includes("example.com"));
    expect(brandQ).toBeUndefined();
    expect(result.length).toBe(1);
  });

  it("T11: missing PERPLEXITY_API_KEY returns empty array without throw", async () => {
    delete process.env.PERPLEXITY_API_KEY;

    const result = await discoverRealPrompts(categoryTree as any, undefined, "example.com");

    expect(result).toEqual([]);
    expect(mockPerplexityCreate).not.toHaveBeenCalled();
  });

  it("T12: categoryTree with zero leaves returns empty array", async () => {
    const emptyTree = makeCategoryTree([]);

    const result = await discoverRealPrompts(emptyTree as any, undefined, "example.com");

    expect(result).toEqual([]);
    expect(mockPerplexityCreate).not.toHaveBeenCalled();
  });
});

// ── T13: FIX-10 zero-competitor edge case ────────────────────────

describe("aggregateCompetitorsByDimension — zero competitors (FIX-10)", () => {
  it("T13: all responses have empty competitorsMentioned — no NaN in SOV/gap, dominanceMap has global entry", () => {
    const prompts: TaggedPrompt[] = Array.from({ length: 5 }, (_, i) => ({
      type: "indirect" as const,
      pillar: null,
      prompt: `q-${i}`,
      geoId: "in-ka-blr",
      tier: "buy" as const,
    }));
    // All responses mention no competitors at all
    const responses = prompts.map(p => makeResponse(p.prompt, true, 1, []));

    const result = aggregateCompetitorsByDimension(responses, prompts, domain, geoTree, null);

    // locationCompetitors entry exists (≥3 prompts) but competitors array is empty
    const blr = result.locationCompetitors.find(l => l.geoId === "in-ka-blr");
    expect(blr).toBeDefined();
    expect(blr!.competitors).toHaveLength(0);

    // dominanceMap has a global entry (geoId=null)
    const globalEntry = result.dominanceMap.entries.find(
      e => e.geoId === null && e.categoryId === null
    );
    expect(globalEntry).toBeDefined();

    // No NaN anywhere
    for (const entry of result.dominanceMap.entries) {
      expect(Number.isNaN(entry.brandSOV)).toBe(false);
      expect(Number.isNaN(entry.topBrandSOV)).toBe(false);
      expect(Number.isNaN(entry.gap)).toBe(false);
    }
    for (const comp of result.locationCompetitors.flatMap(l => l.competitors)) {
      expect(Number.isNaN(comp.shareOfVoice)).toBe(false);
    }
  });
});
