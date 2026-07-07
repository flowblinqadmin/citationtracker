import { describe, it, expect } from "vitest";
import { buildWorklist, systemPromptForOrg, platformsForOrg, GROUNDED_CITATION_SYSTEM_PROMPT } from "@/lib/engine/runner";
import { parseSentiment } from "@/lib/engine/sentiment";
import type { ActivePromptVersion } from "@/lib/engine/run-create";

const pv = (id: string): ActivePromptVersion => ({
  promptId: `p_${id}`,
  promptVersionId: `pv_${id}`,
  version: 1,
  text: `prompt ${id}`,
  category: "brand",
});

const PVS = [pv("b"), pv("a"), pv("c")];

describe("buildWorklist scope", () => {
  it("no scope → full cross-product in stable version order", () => {
    const wl = buildWorklist(PVS);
    expect(wl).toHaveLength(9);
    expect(wl[0].pv.promptVersionId).toBe("pv_a");
    expect(new Set(wl.map((w) => w.platform)).size).toBe(3);
  });

  it("null scope behaves like no scope", () => {
    expect(buildWorklist(PVS, null)).toHaveLength(9);
  });

  it("single prompt version → 3 items (one per platform)", () => {
    const wl = buildWorklist(PVS, { promptVersionIds: ["pv_b"] });
    expect(wl).toHaveLength(3);
    expect(wl.every((w) => w.pv.promptVersionId === "pv_b")).toBe(true);
  });

  it("single platform → one item per prompt version", () => {
    const wl = buildWorklist(PVS, { platforms: ["google"] });
    expect(wl).toHaveLength(3);
    expect(wl.every((w) => w.platform === "google")).toBe(true);
  });

  it("single prompt × single platform → exactly one item", () => {
    const wl = buildWorklist(PVS, { promptVersionIds: ["pv_a"], platforms: ["openai"] });
    expect(wl).toEqual([expect.objectContaining({ platform: "openai" })]);
    expect(wl[0].pv.promptVersionId).toBe("pv_a");
  });

  it("empty scope arrays are ignored (never empties a run)", () => {
    expect(buildWorklist(PVS, { promptVersionIds: [], platforms: [] })).toHaveLength(9);
  });

  it("unknown platforms in scope fall back to all platforms", () => {
    const wl = buildWorklist(PVS, { platforms: ["bing" as never] });
    expect(wl).toHaveLength(9);
  });

  it("unknown prompt version ids yield no items for them", () => {
    const wl = buildWorklist(PVS, { promptVersionIds: ["pv_missing"] });
    expect(wl).toHaveLength(0);
  });
});

describe("platformsForOrg", () => {
  it("team orgs add Claude; PCG keeps the three launch platforms", () => {
    expect(platformsForOrg("team_abc")).toEqual(["perplexity", "openai", "google", "anthropic"]);
    expect(platformsForOrg("org_pcg")).toEqual(["perplexity", "openai", "google"]);
    expect(platformsForOrg(undefined)).toEqual(["perplexity", "openai", "google"]);
  });

  it("worklist honors the 4-platform base and scope still narrows it", () => {
    const base = platformsForOrg("team_abc");
    expect(buildWorklist(PVS, null, base)).toHaveLength(12);
    const scoped = buildWorklist(PVS, { platforms: ["anthropic"] }, base);
    expect(scoped).toHaveLength(3);
    expect(scoped.every((w) => w.platform === "anthropic")).toBe(true);
    // an anthropic scope against a PCG base yields nothing anthropic
    expect(buildWorklist(PVS, { platforms: ["anthropic"] }).every((w) => w.platform !== "anthropic")).toBe(true);
  });
});

describe("systemPromptForOrg", () => {
  it("grounds team-org runs against URL hallucination", () => {
    expect(systemPromptForOrg("team_abc")).toBe(GROUNDED_CITATION_SYSTEM_PROMPT);
    expect(GROUNDED_CITATION_SYSTEM_PROMPT).toMatch(/never construct/i);
  });
  it("PCG (non-team) orgs keep the NULL system prompt — they measure natural behavior", () => {
    expect(systemPromptForOrg("org_pcg")).toBeNull();
    expect(systemPromptForOrg(undefined)).toBeNull();
  });
});

describe("parseSentiment", () => {
  it("accepts the three labels case-insensitively", () => {
    expect(parseSentiment("Positive")).toBe("positive");
    expect(parseSentiment("  NEGATIVE ")).toBe("negative");
    expect(parseSentiment("neutral")).toBe("neutral");
  });

  it("extracts the label from a wordy reply", () => {
    expect(parseSentiment("The sentiment is positive.")).toBe("positive");
  });

  it("returns null for anything else", () => {
    expect(parseSentiment("")).toBeNull();
    expect(parseSentiment("mixed")).toBeNull();
    expect(parseSentiment("positively glowing")).toBeNull();
  });
});
