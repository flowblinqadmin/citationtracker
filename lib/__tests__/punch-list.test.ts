// Pure "what to fix next" builder over a run's responses. Written FIRST (TDD).
import { describe, it, expect } from "vitest";
import { buildPunchList, type PunchResponse, type PunchList, type GapItem } from "@/lib/punch-list";

const BRAND = "Meridian Coffee";
const DOMAIN = "meridiancoffee.com";

// Convenience: a well-formed response row with sensible defaults.
function resp(over: Partial<PunchResponse> = {}): PunchResponse {
  return {
    platform: "openai",
    responseText: "Some answer.",
    brandMentioned: false,
    sentiment: null,
    citedUrls: [],
    ...over,
  };
}

const build = (responses: PunchResponse[]): PunchList =>
  buildPunchList(responses, { brandName: BRAND, brandDomain: DOMAIN });

describe("buildPunchList", () => {
  it("returns an empty list for no responses", () => {
    const list = build([]);
    expect(list.items).toEqual([]);
    expect(list.anyMention).toBe(false);
  });

  it("first item is always the per-platform coverage grid", () => {
    const list = build([
      resp({ platform: "openai", brandMentioned: true }),
      resp({ platform: "perplexity", brandMentioned: false }),
    ]);
    expect(list.items[0].kind).toBe("coverage");
    const cov = list.items[0];
    if (cov.kind !== "coverage") throw new Error("expected coverage");
    // All four canonical platforms represented, in order.
    expect(cov.platforms.map((p) => p.platform)).toEqual([
      "openai",
      "perplexity",
      "google",
      "anthropic",
    ]);
    expect(cov.platforms.find((p) => p.platform === "openai")!.mentioned).toBe(true);
    expect(cov.platforms.find((p) => p.platform === "perplexity")!.mentioned).toBe(false);
    // Platforms with no response at all read as not-mentioned.
    expect(cov.platforms.find((p) => p.platform === "google")!.mentioned).toBe(false);
    expect(cov.platforms.find((p) => p.platform === "anthropic")!.mentioned).toBe(false);
  });

  it("anyMention is true when at least one response mentions the brand", () => {
    expect(build([resp({ brandMentioned: true })]).anyMention).toBe(true);
    expect(build([resp({ brandMentioned: false })]).anyMention).toBe(false);
  });

  it("excludes errored responses (error field set) from coverage and mentions", () => {
    const list = build([
      // An errored response that CLAIMS a mention must not count.
      resp({ platform: "openai", brandMentioned: true, error: "provider 500", responseText: null }),
      resp({ platform: "perplexity", brandMentioned: false }),
    ]);
    expect(list.anyMention).toBe(false);
    const cov = list.items[0];
    if (cov.kind !== "coverage") throw new Error("expected coverage");
    expect(cov.platforms.find((p) => p.platform === "openai")!.mentioned).toBe(false);
  });

  it("emits up to 2 verbatim quote cards where the brand is mentioned", () => {
    const list = build([
      resp({
        platform: "openai",
        brandMentioned: true,
        sentiment: "positive",
        responseText:
          "Coffee is great. Meridian Coffee is one of the top roasters in the region. Buy local.",
      }),
      resp({
        platform: "perplexity",
        brandMentioned: true,
        sentiment: "neutral",
        responseText: "There are many options. Meridian Coffee sells beans online. That's all.",
      }),
      resp({
        platform: "google",
        brandMentioned: true,
        sentiment: "negative",
        responseText: "Meridian Coffee has had complaints about shipping.",
      }),
    ]);
    const quotes = list.items.filter((i) => i.kind === "quote");
    expect(quotes).toHaveLength(2); // capped at 2
    const q0 = quotes[0];
    if (q0.kind !== "quote") throw new Error("expected quote");
    // Sentence extraction: pulls only the sentence(s) naming the brand.
    expect(q0.quote).toContain("Meridian Coffee");
    expect(q0.quote).not.toContain("Coffee is great.");
    expect(q0.platform).toBe("openai");
    expect(q0.platformLabel).toBe("ChatGPT");
    expect(q0.sentiment).toBe("positive");
  });

  it("trims a quote to 200 chars", () => {
    const long = `Meridian Coffee ${"x".repeat(400)} is a brand.`;
    const list = build([resp({ brandMentioned: true, responseText: long })]);
    const quote = list.items.find((i) => i.kind === "quote");
    if (!quote || quote.kind !== "quote") throw new Error("expected a quote");
    expect(quote.quote.length).toBeLessThanOrEqual(200);
  });

  it("skips quote cards for responses with no brand sentence found (defensive)", () => {
    // brandMentioned true but text never contains the brand string → no quote.
    const list = build([
      resp({ platform: "openai", brandMentioned: true, responseText: "Generic answer with no name." }),
    ]);
    expect(list.items.some((i) => i.kind === "quote")).toBe(false);
  });

  it("emits a per-platform gap item with the top-3 non-brand cited domains", () => {
    const list = build([
      // ChatGPT never mentions the brand across 3 prompts, cites others.
      resp({ platform: "openai", brandMentioned: false, citedUrls: ["https://a.com/x", "https://b.com/y"] }),
      resp({ platform: "openai", brandMentioned: false, citedUrls: ["https://a.com/z", "https://c.com/1"] }),
      resp({ platform: "openai", brandMentioned: false, citedUrls: ["https://a.com/w", "https://www.b.com/q"] }),
      // A brand mention elsewhere so we don't fall into the zero-mention branch.
      resp({ platform: "perplexity", brandMentioned: true, responseText: "Meridian Coffee is good." }),
    ]);
    const gap = list.items.find((i) => i.kind === "gap" && i.platform === "openai");
    if (!gap || gap.kind !== "gap") throw new Error("expected an openai gap item");
    expect(gap.platformLabel).toBe("ChatGPT");
    expect(gap.missedPrompts).toBe(3);
    // a.com (3) > b.com (2, www deduped) > c.com (1); top 3, ranked, deduped.
    expect(gap.topDomains).toEqual(["a.com", "b.com", "c.com"]);
  });

  it("excludes the brand's own domain from gap cited domains", () => {
    const list = build([
      resp({ platform: "openai", brandMentioned: false, citedUrls: [`https://${DOMAIN}/blog`, "https://rival.com/x"] }),
      resp({ platform: "perplexity", brandMentioned: true, responseText: "Meridian Coffee rocks." }),
    ]);
    const gap = list.items.find((i) => i.kind === "gap" && i.platform === "openai");
    if (!gap || gap.kind !== "gap") throw new Error("expected an openai gap item");
    expect(gap.topDomains).toEqual(["rival.com"]);
  });

  it("zero mentions anywhere → an honest 'nobody cites you' item with top cited domains", () => {
    const list = build([
      resp({ platform: "openai", brandMentioned: false, citedUrls: ["https://a.com/x", "https://b.com/y"] }),
      resp({ platform: "perplexity", brandMentioned: false, citedUrls: ["https://a.com/z"] }),
    ]);
    expect(list.anyMention).toBe(false);
    const none = list.items.find((i) => i.kind === "none");
    if (!none || none.kind !== "none") throw new Error("expected a none item");
    expect(none.topDomains[0]).toBe("a.com");
    // The zero-mention branch replaces per-platform gap items.
    expect(list.items.some((i) => i.kind === "gap")).toBe(false);
  });

  it("all-mentioned → coverage + quotes, no gap/none items", () => {
    const list = build([
      resp({ platform: "openai", brandMentioned: true, responseText: "Meridian Coffee is excellent." }),
      resp({ platform: "perplexity", brandMentioned: true, responseText: "Meridian Coffee ships fast." }),
      resp({ platform: "google", brandMentioned: true, responseText: "Meridian Coffee has good beans." }),
      resp({ platform: "anthropic", brandMentioned: true, responseText: "Meridian Coffee is a roaster." }),
    ]);
    expect(list.items.some((i) => i.kind === "gap")).toBe(false);
    expect(list.items.some((i) => i.kind === "none")).toBe(false);
    expect(list.items[0].kind).toBe("coverage");
  });

  it("caps the total punch list at 5 items, cutting the lowest-priority gaps", () => {
    // Every one of the 4 platforms both mentions the brand (once) AND misses it
    // (once). That yields 7 items PRE-cap: coverage(1) + 2 quotes (capped from 4
    // mentions) + 4 gaps (one per platform, in PLATFORM_ORDER). slice(0, 5) must
    // therefore actually drop the last two gaps — exercising the cap, not just
    // asserting "≤ 5" on a list that never exceeded it.
    const list = build([
      // A mention on every platform → 4 mention rows, only the first 2 (openai,
      // perplexity) survive the MAX_QUOTES=2 cap, in array order.
      resp({ platform: "openai", brandMentioned: true, sentiment: "positive", responseText: "Meridian Coffee is great." }),
      resp({ platform: "perplexity", brandMentioned: true, sentiment: "neutral", responseText: "Meridian Coffee sells beans." }),
      resp({ platform: "google", brandMentioned: true, responseText: "Meridian Coffee has good beans." }),
      resp({ platform: "anthropic", brandMentioned: true, responseText: "Meridian Coffee is a roaster." }),
      // A miss on every platform → a gap per platform, emitted in PLATFORM_ORDER.
      resp({ platform: "openai", brandMentioned: false, citedUrls: ["https://o1.com/a"] }),
      resp({ platform: "perplexity", brandMentioned: false, citedUrls: ["https://p1.com/a"] }),
      resp({ platform: "google", brandMentioned: false, citedUrls: ["https://g1.com/a"] }),
      resp({ platform: "anthropic", brandMentioned: false, citedUrls: ["https://c1.com/a"] }),
    ]);

    // Exactly 5 survive (7 pre-cap), and the kept slice is deterministic:
    // coverage, 2 quotes, then the FIRST two gaps by PLATFORM_ORDER.
    expect(list.items).toHaveLength(5);
    expect(list.items.map((i) => i.kind)).toEqual(["coverage", "quote", "quote", "gap", "gap"]);

    // The two surviving gaps are openai + perplexity; google + anthropic gaps
    // (items 6 and 7 pre-cap) are exactly what slice(0, 5) drops.
    const gapPlatforms = list.items
      .filter((i): i is GapItem => i.kind === "gap")
      .map((g) => g.platform);
    expect(gapPlatforms).toEqual(["openai", "perplexity"]);
    expect(list.items.some((i) => i.kind === "gap" && (i.platform === "google" || i.platform === "anthropic"))).toBe(false);
  });

  it("case-insensitive brand matching for mentions in text (sentence extraction)", () => {
    const list = build([
      resp({ platform: "openai", brandMentioned: true, responseText: "I recommend MERIDIAN COFFEE for quality." }),
    ]);
    const quote = list.items.find((i) => i.kind === "quote");
    if (!quote || quote.kind !== "quote") throw new Error("expected a quote");
    expect(quote.quote.toLowerCase()).toContain("meridian coffee");
  });

  it("ignores malformed URLs when ranking cited domains", () => {
    const list = build([
      resp({ platform: "openai", brandMentioned: false, citedUrls: ["not a url", "https://good.com/x", ""] }),
      resp({ platform: "perplexity", brandMentioned: true, responseText: "Meridian Coffee is fine." }),
    ]);
    const gap = list.items.find((i) => i.kind === "gap" && i.platform === "openai");
    if (!gap || gap.kind !== "gap") throw new Error("expected gap");
    expect(gap.topDomains).toEqual(["good.com"]);
  });
});
