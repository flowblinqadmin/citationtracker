import { describe, it, expect } from "vitest";
import { detectMention } from "@/lib/engine/brand-detector";
import type { BrandKeywords } from "@/lib/types/tracker";

const acme: BrandKeywords = {
  keywords: ["Acme Corp", "Acme"],
  isAmbiguous: false,
  source: "manual",
};

describe("detectMention — no-knowledge guard scoping", () => {
  // (a) REGRESSION for the by-platform 0% incident: a web-search reply hedges
  // about SOME sources in one sentence but affirmatively names the brand in
  // another. The old global guard returned mentioned:false for the whole reply.
  it("counts an affirmative mention even when an unrelated hedge phrase appears elsewhere", () => {
    const text =
      "Acme Corp is a leading provider of widgets and is widely recommended. " +
      "For pricing on their enterprise tier, no information available on the public site.";
    const r = detectMention(text, "acmecorp.com", acme);
    expect(r.mentioned).toBe(true);
  });

  it("counts the mention when the hedge sits in a separate sentence before the brand", () => {
    const text =
      "I could not find independent benchmarks for that category. " +
      "That said, Acme is frequently cited as a top option in this space.";
    const r = detectMention(text, "acmecorp.com", acme);
    expect(r.mentioned).toBe(true);
  });

  // (b) Guard PURPOSE preserved: brand named ONLY inside the hedge sentence.
  it("suppresses a mention when the brand is named only inside the hedge sentence", () => {
    const text = "I could not find any information about Acme Corp.";
    const r = detectMention(text, "acmecorp.com", acme);
    expect(r.mentioned).toBe(false);
  });

  it("suppresses when every brand occurrence is inside a hedge sentence", () => {
    const text =
      "I'm not familiar with Acme Corp. I don't have details about Acme either.";
    const r = detectMention(text, "acmecorp.com", acme);
    expect(r.mentioned).toBe(false);
  });

  // (c) Pure hedge, no brand at all.
  it("returns false for a pure hedge reply that never names the brand", () => {
    const text = "I couldn't find reliable information. No information available.";
    const r = detectMention(text, "acmecorp.com", acme);
    expect(r.mentioned).toBe(false);
  });

  it("returns false when the brand is absent and there is no hedge", () => {
    const text = "Widgets are useful in many industrial applications.";
    const r = detectMention(text, "acmecorp.com", acme);
    expect(r.mentioned).toBe(false);
  });
});

describe("detectMention — categoryKeywords pass-through for ambiguous brands", () => {
  const apple: BrandKeywords = {
    keywords: ["Apple"],
    isAmbiguous: true,
    source: "manual",
  };

  it("does NOT match an ambiguous brand without a category keyword nearby", () => {
    const text = "I ate an apple for breakfast and it was delicious.";
    const r = detectMention(text, "apple.com", apple, ["iphone", "macbook", "computer"]);
    expect(r.mentioned).toBe(false);
  });

  it("matches an ambiguous brand when a category keyword is within the window", () => {
    const text = "Apple released a new MacBook computer with a faster chip.";
    const r = detectMention(text, "apple.com", apple, ["iphone", "macbook", "computer"]);
    expect(r.mentioned).toBe(true);
  });

  it("with no categoryKeywords supplied, an ambiguous brand never matches", () => {
    const text = "Apple released a new computer this year.";
    const r = detectMention(text, "apple.com", apple);
    expect(r.mentioned).toBe(false);
  });
});

describe("detectMention — domain fallback + basics", () => {
  it("matches via the domain URL when no keyword hits", () => {
    const text = "See more details at acmecorp.com for their catalog.";
    const noKw: BrandKeywords = { keywords: ["Zzzzz"], isAmbiguous: false, source: "manual" };
    const r = detectMention(text, "acmecorp.com", noKw);
    expect(r.mentioned).toBe(true);
  });

  it("suppresses a domain-only mention inside a hedge sentence", () => {
    const text = "I could not find information at acmecorp.com about that.";
    const noKw: BrandKeywords = { keywords: ["Zzzzz"], isAmbiguous: false, source: "manual" };
    const r = detectMention(text, "acmecorp.com", noKw);
    expect(r.mentioned).toBe(false);
  });

  it("reports a numbered-list position for the matched brand", () => {
    const text = "1. Globex is fast.\n2. Acme Corp is reliable and recommended.";
    const r = detectMention(text, "acmecorp.com", acme);
    expect(r.mentioned).toBe(true);
    expect(r.position).toBe(2);
  });
});
