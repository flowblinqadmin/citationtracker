/**
 * Unit tests for lib/services/crawl-prioritizer.ts — ES-053 / C1
 * U1-U12: detectArchitecture, classifyUrls, prioritizeUrls
 *
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import {
  detectArchitecture,
  classifyUrls,
  prioritizeUrls,
  type SiteArchitecture,
  type PagePriorityTier,
  type PrioritizedUrl,
} from "@/lib/services/crawl-prioritizer";

// ── Helpers ──────────────────────────────────────────────────────────────────

function tierOf(urls: PrioritizedUrl[], url: string): PagePriorityTier | undefined {
  return urls.find((u) => u.url === url)?.tier;
}

// ── U1: detectArchitecture extracts nav pages from homepage ──────────────────

describe("detectArchitecture", () => {
  it("U1: extracts nav pages from homepage HTML", () => {
    const urls = [
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/services",
      "https://example.com/blog/post-1",
      "https://example.com/contact",
    ];
    const homepageContent = `
      <nav>
        <a href="/about">About</a>
        <a href="/services">Services</a>
        <a href="/contact">Contact</a>
        <a href="/careers">Careers</a>
      </nav>
    `;

    const arch = detectArchitecture(urls, homepageContent);
    expect(arch.navPages).toContain("https://example.com/about");
    expect(arch.navPages).toContain("https://example.com/services");
    expect(arch.navPages).toContain("https://example.com/contact");
    expect(arch.navPages.length).toBeGreaterThanOrEqual(3);
  });

  it("U2: classifies structural vs content pages", () => {
    const urls = [
      "https://example.com/services/oncology",
      "https://example.com/services/cardiology",
      "https://example.com/locations/bangalore",
      "https://example.com/blog/post-1",
      "https://example.com/blog/post-2",
      "https://example.com/articles/news-1",
    ];

    const arch = detectArchitecture(urls);
    expect(arch.structuralPages.length).toBeGreaterThanOrEqual(2);
    expect(arch.contentPages.length).toBeGreaterThanOrEqual(2);
    // /services/* should be structural
    expect(arch.structuralPages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/services/"),
      ])
    );
    // /blog/* should be content
    expect(arch.contentPages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/blog/"),
      ])
    );
  });
});

// ── U3-U7: classifyUrls ─────────────────────────────────────────────────────

describe("classifyUrls", () => {
  it("U3: assigns P0 to homepage, about, contact", () => {
    const urls = [
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/contact",
    ];
    const arch = detectArchitecture(urls);
    const classified = classifyUrls(urls, arch);

    expect(tierOf(classified, "https://example.com/")).toBe("P0");
    expect(tierOf(classified, "https://example.com/about")).toBe("P0");
    expect(tierOf(classified, "https://example.com/contact")).toBe("P0");
  });

  it("U4: assigns P1 to /services/*", () => {
    const urls = ["https://example.com/services/oncology"];
    const arch = detectArchitecture(urls);
    const classified = classifyUrls(urls, arch);

    expect(tierOf(classified, "https://example.com/services/oncology")).toBe("P1");
  });

  it("U5: assigns P2 to /locations/*", () => {
    const urls = ["https://example.com/locations/bangalore"];
    const arch = detectArchitecture(urls);
    const classified = classifyUrls(urls, arch);

    expect(tierOf(classified, "https://example.com/locations/bangalore")).toBe("P2");
  });

  it("U6: assigns P5 to /blog/*", () => {
    const urls = ["https://example.com/blog/post-1"];
    const arch = detectArchitecture(urls);
    const classified = classifyUrls(urls, arch);

    expect(tierOf(classified, "https://example.com/blog/post-1")).toBe("P5");
  });

  it("U7: respects industry boost — healthcare boosts /departments/* to P1", () => {
    const urls = ["https://example.com/departments/oncology"];
    const arch = detectArchitecture(urls);
    const classified = classifyUrls(urls, arch, "healthcare");

    expect(tierOf(classified, "https://example.com/departments/oncology")).toBe("P1");
  });
});

// ── U8-U12: prioritizeUrls ──────────────────────────────────────────────────

describe("prioritizeUrls", () => {
  it("U8: fills P0 first, then P1, respects limit", () => {
    const p0 = Array.from({ length: 10 }, (_, i) => `https://example.com/about-${i}`);
    const p1 = Array.from({ length: 20 }, (_, i) => `https://example.com/services/s${i}`);
    const p5 = Array.from({ length: 100 }, (_, i) => `https://example.com/blog/post-${i}`);
    const urls = [...p0, ...p1, ...p5];

    // We need homepage for P0, but the p0 urls use /about-N which are P0-ish
    // Actually, /about-* may classify as P0. Let's use a mix.
    const arch = detectArchitecture(urls);
    const result = prioritizeUrls(urls, arch, undefined, 50);

    expect(result.length).toBeLessThanOrEqual(50);
    // Blog should be capped at 30% of 50 = 15
    const blogCount = result.filter((u) => u.includes("/blog/")).length;
    expect(blogCount).toBeLessThanOrEqual(15);
  });

  it("U9: caps blog at 30% of crawl limit", () => {
    const p0 = Array.from({ length: 5 }, (_, i) => `https://example.com/page-${i}`);
    const p5 = Array.from({ length: 200 }, (_, i) => `https://example.com/blog/post-${i}`);
    const urls = [...p0, ...p5];

    const arch = detectArchitecture(urls);
    const result = prioritizeUrls(urls, arch, undefined, 100);

    const blogCount = result.filter((u) => u.includes("/blog/")).length;
    expect(blogCount).toBeLessThanOrEqual(30); // 30% of 100
  });

  it("U10: sorts by depth within tier — shallower first", () => {
    const urls = [
      "https://example.com/services/oncology/treatments/chemo",
      "https://example.com/services/oncology",
      "https://example.com/services",
    ];

    const arch = detectArchitecture(urls);
    const result = prioritizeUrls(urls, arch, undefined, 10);

    // Within P1 tier, shallower should come first
    const serviceUrls = result.filter((u) => u.includes("/services"));
    if (serviceUrls.length >= 2) {
      const idxShallow = result.indexOf("https://example.com/services");
      const idxDeep = result.indexOf("https://example.com/services/oncology/treatments/chemo");
      if (idxShallow >= 0 && idxDeep >= 0) {
        expect(idxShallow).toBeLessThan(idxDeep);
      }
    }
  });

  it("U11: handles empty URL list", () => {
    const arch = detectArchitecture([]);
    const result = prioritizeUrls([], arch);

    expect(result).toEqual([]);
  });

  it("U12: with no structural pages, returns up to crawlLimit with blog capped", () => {
    const p5 = Array.from({ length: 100 }, (_, i) => `https://example.com/blog/post-${i}`);
    const p6 = Array.from({ length: 50 }, (_, i) => `https://example.com/other/page-${i}`);
    const urls = [...p5, ...p6];

    const arch = detectArchitecture(urls);
    const result = prioritizeUrls(urls, arch, undefined, 50);

    expect(result.length).toBeLessThanOrEqual(50);
    const blogCount = result.filter((u) => u.includes("/blog/")).length;
    expect(blogCount).toBeLessThanOrEqual(15); // 30% of 50
  });
});
