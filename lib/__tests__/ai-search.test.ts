// AI Overview extraction from a scraped Google SERP — fixture condensed from
// a real Firecrawl capture (2026-07-03).
import { describe, it, expect, vi } from "vitest";
import { parseAiOverview, checkAiSearch } from "@/lib/ai-search";

const SERP_WITH_OVERVIEW = `Skip to main content [Accessibility help](https://support.google.com/websearch/answer/181196)
AI Overview is not available for this searchCan't generate an AI overview right now. Try again later.

AI Overview

India's leading hospital chains for quaternary care offer cutting-edge treatments. The top networks are [Apollo Hospitals](https://www.apollohospitals.com/), [Medanta - The Medicity](https://www.medanta.org/) and [Fortis Healthcare](https://www.fortishealthcare.com/).[Grand View Research (+4) - View related links](https://www.grandviewresearch.com/market-trends/india-healthcare)
![](<Base64-Image-Removed>)Grand View Research +4

1. Apollo Hospitals — multi-organ transplants.[YouTube (+2) - View related links](https://www.youtube.com/watch?v=abc)

People also ask
What is the best hospital in India?
[Some organic result](https://example.org/organic)`;

const SERP_WITHOUT_OVERVIEW = `Skip to main content
AI Overview is not available for this searchCan't generate an AI overview right now. Try again later.
[Some organic result](https://example.org/organic)
People also ask`;

describe("parseAiOverview", () => {
  it("extracts the overview text and cited sources, skipping google plumbing links", () => {
    const r = parseAiOverview(SERP_WITH_OVERVIEW);
    expect(r.present).toBe(true);
    expect(r.text).toContain("leading hospital chains");
    expect(r.citations.map((c) => c.url)).toEqual([
      "https://www.apollohospitals.com/",
      "https://www.medanta.org/",
      "https://www.fortishealthcare.com/",
      "https://www.grandviewresearch.com/market-trends/india-healthcare",
      "https://www.youtube.com/watch?v=abc",
    ]);
    expect(r.citations[3].label).toBe("Grand View Research"); // "(+4) - View related links" stripped
  });

  it("stops at the next SERP section — organic results are not overview citations", () => {
    const r = parseAiOverview(SERP_WITH_OVERVIEW);
    expect(r.citations.some((c) => c.url.includes("example.org"))).toBe(false);
    expect(r.text).not.toContain("People also ask");
  });

  it("treats the 'not available' banner as absent", () => {
    const r = parseAiOverview(SERP_WITHOUT_OVERVIEW);
    expect(r).toEqual({ present: false, text: null, citations: [] });
  });
});

describe("checkAiSearch", () => {
  it("flags whether the overview mentions the brand", async () => {
    const scraper = vi.fn().mockResolvedValue(SERP_WITH_OVERVIEW);
    const apollo = await checkAiSearch("q", ["Apollo Hospitals"], scraper);
    expect(apollo).toMatchObject({ present: true, brandMentioned: true });
    const manipal = await checkAiSearch("q", ["Manipal Hospitals"], scraper);
    expect(manipal).toMatchObject({ present: true, brandMentioned: false });
  });

  it("null when the scrape fails (no verdict recorded)", async () => {
    expect(await checkAiSearch("q", ["X"], vi.fn().mockResolvedValue(null))).toBeNull();
  });
});
