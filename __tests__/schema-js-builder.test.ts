/**
 * Unit tests for buildSchemaInjectionJs
 *
 * SJB-1  Sitewide blocks (Organization, BreadcrumbList) → injected unconditionally
 * SJB-2  Page-specific blocks (Article with pageTarget URL) → pathname conditionals
 * SJB-3  RobotsTxt type blocks → excluded from output
 * SJB-4  Blocks with pageTarget "all pages" → injected on every page (sitewide)
 * SJB-5  Invalid/missing pageTarget on non-sitewide block → treated as sitewide
 * SJB-6  U+2028/U+2029 in JSON-LD values → escaped in output
 * SJB-7  Empty blocks array → returns minimal JS wrapper
 *
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import { buildSchemaInjectionJs } from "@/lib/schema-js-builder";

describe("buildSchemaInjectionJs", () => {
  it("SJB-1: sitewide blocks are injected unconditionally", () => {
    const js = buildSchemaInjectionJs([
      { type: "Organization", jsonLd: { "@type": "Organization", name: "Acme" } },
      { type: "BreadcrumbList", jsonLd: { "@type": "BreadcrumbList" } },
    ]);

    expect(js).toContain("_fbInject");
    expect(js).toContain("Organization");
    expect(js).toContain("BreadcrumbList");
    // Should NOT have pathname conditionals for sitewide blocks
    expect(js).not.toContain("if (p ===");
  });

  it("SJB-2: page-specific blocks have pathname conditionals", () => {
    const js = buildSchemaInjectionJs([
      {
        type: "Article",
        pageTarget: "https://example.com/blog/post-1",
        jsonLd: { "@type": "Article", headline: "Test Post" },
      },
    ]);

    expect(js).toContain('if (p ===');
    expect(js).toContain("/blog/post-1");
    expect(js).toContain("Article");
  });

  it("SJB-3: RobotsTxt blocks are excluded from output", () => {
    const js = buildSchemaInjectionJs([
      { type: "RobotsTxt", jsonLd: { content: "User-agent: *" } },
      { type: "Organization", jsonLd: { "@type": "Organization", name: "Acme" } },
    ]);

    expect(js).toContain("Organization");
    expect(js).not.toContain("User-agent");
  });

  it("SJB-4: blocks with pageTarget 'all pages' are sitewide", () => {
    const js = buildSchemaInjectionJs([
      {
        type: "FAQPage",
        pageTarget: "all pages",
        jsonLd: { "@type": "FAQPage", name: "FAQ" },
      },
    ]);

    expect(js).toContain("FAQPage");
    // Should be injected unconditionally (no pathname check)
    expect(js).not.toContain("if (p ===");
  });

  it("SJB-5: missing pageTarget on non-sitewide block → treated as sitewide", () => {
    const js = buildSchemaInjectionJs([
      {
        type: "Article",
        // no pageTarget
        jsonLd: { "@type": "Article", headline: "Orphan" },
      },
    ]);

    expect(js).toContain("Orphan");
    // No pathname conditional — treated as sitewide
    expect(js).not.toContain("if (p ===");
  });

  it("SJB-5b: invalid pageTarget URL → treated as sitewide", () => {
    const js = buildSchemaInjectionJs([
      {
        type: "Article",
        pageTarget: "not-a-url",
        jsonLd: { "@type": "Article", headline: "Invalid Target" },
      },
    ]);

    expect(js).toContain("Invalid Target");
    expect(js).not.toContain("if (p ===");
  });

  it("SJB-6: U+2028/U+2029 in JSON-LD values are escaped", () => {
    const js = buildSchemaInjectionJs([
      {
        type: "Organization",
        jsonLd: { "@type": "Organization", name: "Line\u2028Break\u2029Here" },
      },
    ]);

    // Raw U+2028/U+2029 must NOT appear (would break JS execution)
    expect(js).not.toContain("\u2028");
    expect(js).not.toContain("\u2029");
    // Escaped versions should appear
    expect(js).toContain("\\u2028");
    expect(js).toContain("\\u2029");
  });

  it("SJB-7: empty blocks array → returns minimal JS wrapper", () => {
    const js = buildSchemaInjectionJs([]);

    expect(js).toContain("_fbInject");
    expect(js).toContain("(function()");
    expect(js).toContain("})();");
    // No injections — just the wrapper
    expect(js).not.toContain("if (p ===");
  });

  it("SJB-8: mixed sitewide and page blocks", () => {
    const js = buildSchemaInjectionJs([
      { type: "Organization", jsonLd: { "@type": "Organization", name: "Acme" } },
      {
        type: "FAQPage",
        pageTarget: "https://example.com/faq",
        jsonLd: { "@type": "FAQPage", name: "FAQ" },
      },
      {
        type: "Article",
        pageTarget: "https://example.com/blog/post",
        jsonLd: { "@type": "Article", headline: "Post" },
      },
    ]);

    // Organization is sitewide (no conditional)
    expect(js).toContain("Organization");
    // FAQPage and Article are page-specific
    expect(js).toContain("if (p ===");
    expect(js).toContain("/faq");
    expect(js).toContain("/blog/post");
  });
});
