/**
 * ES-054 — C5/C6/Cross: Dimensional visibility aggregation + impression share + tier insights
 * Tests U1–U15
 *
 * Spec: aggregateByDimension(), computeImpressionShare(), generateTierInsight()
 * All pure/deterministic functions — no LLM mocks needed.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  aggregateByDimension,
  computeImpressionShare,
  generateTierInsight,
} from "@/lib/services/citation-checker";

import type {
  GeoVisibility,
  CategoryVisibility,
  TierVisibility,
} from "@/lib/types/citation";

// ── Helpers ──────────────────────────────────────────────────────

type TaggedPrompt = {
  type: "indirect" | "direct";
  pillar: string | null;
  prompt: string;
  geoId?: string;
  categoryId?: string;
  tier?: "buy" | "solve" | "learn";
};

/** Minimal response row matching aggregateByDimension's input contract */
function makeResponse(
  query: string,
  mentioned: boolean,
  overrides: Partial<{ position: number | null; competitorsMentioned: string[] }> = {}
) {
  return {
    id: crypto.randomUUID(),
    checkId: "chk-1",
    siteId: "site-1",
    provider: "chatgpt",
    model: "gpt-4o-mini",
    query,
    pillar: null,
    promptType: "indirect" as const,
    response: "some response text here",
    responseTimeMs: 500,
    mentioned,
    position: overrides.position ?? (mentioned ? 1 : null),
    sentiment: mentioned ? "positive" : null,
    competitorsMentioned: overrides.competitorsMentioned ?? [],
    error: null,
  };
}

function makeGeoTree(nodes: Array<{ id: string; name: string }>) {
  // Minimal tree structure sufficient for flat traversal
  return {
    root: {
      id: "root",
      name: "Root",
      children: nodes.map((n) => ({
        id: n.id,
        name: n.name,
        children: [],
      })),
    },
    leafCount: nodes.length,
  };
}

function makeCategoryTree(nodes: Array<{ id: string; name: string }>) {
  return makeGeoTree(nodes); // same structure
}

// ── U1–U8: aggregateByDimension ─────────────────────────────────

describe("aggregateByDimension — ES-054 C5/C6", () => {
  const geoTree = makeGeoTree([
    { id: "in-ka-blr", name: "Bangalore" },
    { id: "in-dl-del", name: "Delhi" },
    { id: "in-mh-mum", name: "Mumbai" },
  ]);

  const categoryTree = makeCategoryTree([
    { id: "cat-ortho", name: "Orthopedics" },
    { id: "cat-cardio", name: "Cardiology" },
  ]);

  it("U1 — groups responses by geoId", () => {
    const prompts: TaggedPrompt[] = [
      { type: "indirect", pillar: null, prompt: "best hospital bangalore", geoId: "in-ka-blr", tier: "buy" },
      { type: "indirect", pillar: null, prompt: "best hospital delhi", geoId: "in-dl-del", tier: "buy" },
      { type: "indirect", pillar: null, prompt: "clinic bangalore", geoId: "in-ka-blr", tier: "solve" },
      { type: "indirect", pillar: null, prompt: "clinic mumbai", geoId: "in-mh-mum", tier: "solve" },
      { type: "indirect", pillar: null, prompt: "doctor bangalore", geoId: "in-ka-blr", tier: "learn" },
    ];
    const responses = prompts.map((p) => makeResponse(p.prompt, true));

    const result = aggregateByDimension(responses, prompts, geoTree, categoryTree);

    // 3 unique geoIds → 3 geoVisibility entries
    expect(result.geoVisibility).toHaveLength(3);
    const blr = result.geoVisibility.find((g) => g.geoId === "in-ka-blr");
    expect(blr).toBeDefined();
    expect(blr!.promptCount).toBe(3);
  });

  it("U2 — groups responses by categoryId", () => {
    const prompts: TaggedPrompt[] = Array.from({ length: 10 }, (_, i) => ({
      type: "indirect" as const,
      pillar: null,
      prompt: `prompt-${i}`,
      categoryId: i < 8 ? (i % 2 === 0 ? "cat-ortho" : "cat-cardio") : undefined,
      tier: "buy" as const,
    }));
    const responses = prompts.map((p) => makeResponse(p.prompt, true));

    const result = aggregateByDimension(responses, prompts, geoTree, categoryTree);

    // 2 unique categoryIds (8 tagged, 2 untagged)
    expect(result.categoryVisibility.length).toBe(2);
  });

  it("U3 — groups responses by tier (exactly 3 entries)", () => {
    const prompts: TaggedPrompt[] = [
      { type: "indirect", pillar: null, prompt: "buy-1", tier: "buy" },
      { type: "indirect", pillar: null, prompt: "buy-2", tier: "buy" },
      { type: "indirect", pillar: null, prompt: "solve-1", tier: "solve" },
      { type: "indirect", pillar: null, prompt: "learn-1", tier: "learn" },
      { type: "indirect", pillar: null, prompt: "learn-2", tier: "learn" },
    ];
    const responses = prompts.map((p) => makeResponse(p.prompt, true));

    const result = aggregateByDimension(responses, prompts, geoTree, categoryTree);

    expect(result.tierVisibility).toHaveLength(3);
    const tiers = result.tierVisibility.map((t) => t.tier).sort();
    expect(tiers).toEqual(["buy", "learn", "solve"]);
  });

  it("U4 — handles null tags gracefully (empty arrays)", () => {
    const prompts: TaggedPrompt[] = [
      { type: "indirect", pillar: null, prompt: "untagged-1" },
      { type: "indirect", pillar: null, prompt: "untagged-2" },
      { type: "direct", pillar: null, prompt: "untagged-3" },
    ];
    const responses = prompts.map((p) => makeResponse(p.prompt, false));

    const result = aggregateByDimension(responses, prompts, null, null);

    expect(result.geoVisibility).toEqual([]);
    expect(result.categoryVisibility).toEqual([]);
    expect(result.tierVisibility).toEqual([]);
  });

  it("U5 — computes correct geoVisibility percentage", () => {
    // 10 prompts for "in-ka-blr", 4 mentioned
    const prompts: TaggedPrompt[] = Array.from({ length: 10 }, (_, i) => ({
      type: "indirect" as const,
      pillar: null,
      prompt: `blr-prompt-${i}`,
      geoId: "in-ka-blr",
      tier: "buy" as const,
    }));
    const responses = prompts.map((p, i) => makeResponse(p.prompt, i < 4));

    const result = aggregateByDimension(responses, prompts, geoTree, null);

    const blr = result.geoVisibility.find((g) => g.geoId === "in-ka-blr");
    expect(blr).toBeDefined();
    expect(blr!.promptCount).toBe(10);
    expect(blr!.mentionCount).toBe(4);
    expect(blr!.visibility).toBe(40); // 4/10 * 100
  });

  it("U6 — single category produces 1 entry with correct visibility", () => {
    const prompts: TaggedPrompt[] = Array.from({ length: 6 }, (_, i) => ({
      type: "indirect" as const,
      pillar: null,
      prompt: `ortho-${i}`,
      categoryId: "cat-ortho",
      tier: "solve" as const,
    }));
    // 3 of 6 mentioned
    const responses = prompts.map((p, i) => makeResponse(p.prompt, i < 3));

    const result = aggregateByDimension(responses, prompts, null, categoryTree);

    expect(result.categoryVisibility).toHaveLength(1);
    expect(result.categoryVisibility[0].categoryId).toBe("cat-ortho");
    expect(result.categoryVisibility[0].visibility).toBe(50);
  });

  it("U7 — resolves geoId to geoName from tree", () => {
    const prompts: TaggedPrompt[] = [
      { type: "indirect", pillar: null, prompt: "blr-q", geoId: "in-ka-blr", tier: "buy" },
    ];
    const responses = [makeResponse("blr-q", true)];

    const result = aggregateByDimension(responses, prompts, geoTree, null);

    expect(result.geoVisibility[0].geoName).toBe("Bangalore");
  });

  it("U8 — falls back to geoId as name when tree is missing", () => {
    const prompts: TaggedPrompt[] = [
      { type: "indirect", pillar: null, prompt: "blr-q", geoId: "in-ka-blr", tier: "buy" },
    ];
    const responses = [makeResponse("blr-q", true)];

    const result = aggregateByDimension(responses, prompts, null, null);

    expect(result.geoVisibility[0].geoName).toBe("in-ka-blr");
  });
});

// ── U9–U12: computeImpressionShare ──────────────────────────────

describe("computeImpressionShare — ES-054 Cross", () => {
  const domain = "manipalhospitals.com";

  it("U9 — single mention in 7-item list yields ~14%", () => {
    const response = [
      "Here are the top hospitals in Bangalore:",
      "1. Apollo Hospitals - Leading multi-specialty chain with advanced facilities.",
      "2. Manipal Hospitals - Known for comprehensive care and experienced doctors.",
      "3. Fortis Healthcare - Major network offering quality treatment options.",
      "4. Narayana Health - Affordable cardiac care and multi-specialty services.",
      "5. Columbia Asia - International standard healthcare with modern technology.",
      "6. Sakra World - Premium hospital with world-class infrastructure today.",
      "7. Aster CMI - Growing network with specialized departments and experts.",
    ].join(" ");

    const share = computeImpressionShare(response, domain);
    expect(share).not.toBeNull();
    // Words about Manipal / total words — should be roughly 10-20%
    expect(share!).toBeGreaterThanOrEqual(5);
    expect(share!).toBeLessThanOrEqual(25);
  });

  it("U10 — dominant mention yields >50%", () => {
    const response =
      "Manipal Hospitals is the leading healthcare provider in Bangalore. " +
      "Manipal Hospitals offers world-class treatment across all specialties. " +
      "Manipal Hospitals has been ranked number one in patient satisfaction. " +
      "Manipal Hospitals invests heavily in research and advanced medical technology. " +
      "Manipal Hospitals trains the best doctors in the country for excellence. " +
      "Manipal Hospitals continues to expand its network across India.";

    const share = computeImpressionShare(response, domain);
    expect(share).not.toBeNull();
    expect(share!).toBeGreaterThan(50);
  });

  it("U11 — returns null for response under 50 words", () => {
    const response = "Manipal Hospitals is a good hospital in Bangalore.";
    const share = computeImpressionShare(response, domain);
    expect(share).toBeNull();
  });

  it("U12 — returns 0 when brand is not mentioned", () => {
    const response = [
      "Here are the top hospitals in Bangalore for cardiac care:",
      "1. Apollo Hospitals - Leading cardiac care with advanced surgical facilities.",
      "2. Fortis Healthcare - Major network offering quality cardiac treatment.",
      "3. Narayana Health - Pioneering affordable cardiac care for all patients.",
      "4. Columbia Asia - International standard cardiac care with modern equipment.",
      "5. Aster CMI - Growing cardiac department with specialized doctors today.",
    ].join(" ");

    const share = computeImpressionShare(response, domain);
    expect(share).not.toBeNull();
    expect(share!).toBe(0);
  });
});

// ── U13–U15: generateTierInsight ────────────────────────────────

describe("generateTierInsight — ES-054 C6", () => {
  it("U13 — Buy >> Learn generates 'doesn't cite expertise' message", () => {
    const tiers: TierVisibility[] = [
      { tier: "buy", promptCount: 10, mentionCount: 6, visibility: 60 },
      { tier: "solve", promptCount: 10, mentionCount: 4, visibility: 40 },
      { tier: "learn", promptCount: 10, mentionCount: 2, visibility: 20 },
    ];

    const insight = generateTierInsight(tiers);
    expect(insight).not.toBeNull();
    // Spec: "AI recommends you but doesn't cite your expertise — add educational content"
    expect(insight!.toLowerCase()).toContain("expertise");
  });

  it("U14 — all tiers within 5 points returns null", () => {
    const tiers: TierVisibility[] = [
      { tier: "buy", promptCount: 10, mentionCount: 5, visibility: 50 },
      { tier: "solve", promptCount: 10, mentionCount: 5, visibility: 48 },
      { tier: "learn", promptCount: 10, mentionCount: 5, visibility: 52 },
    ];

    const insight = generateTierInsight(tiers);
    expect(insight).toBeNull();
  });

  it("U15 — Solve lowest (>15 below avg) generates problem-solving message", () => {
    const tiers: TierVisibility[] = [
      { tier: "buy", promptCount: 10, mentionCount: 5, visibility: 50 },
      { tier: "solve", promptCount: 10, mentionCount: 1, visibility: 15 },
      { tier: "learn", promptCount: 10, mentionCount: 4, visibility: 45 },
    ];

    const insight = generateTierInsight(tiers);
    expect(insight).not.toBeNull();
    // Spec: "doesn't connect your brand to problem-solving"
    expect(insight!.toLowerCase()).toContain("problem-solving");
  });
});
