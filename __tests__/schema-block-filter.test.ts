/**
 * ES-068 — Per-Page Schema Block Serving: schema-block-filter unit tests
 * U1–U15 (Phase A — ReviewMaster, spec-driven, RED until DaVinci implements)
 *
 * Tests the shared helper module: geo/lib/schema-block-filter.ts
 * Exports: isSitewideBlock, isHomepageBlock, groupSchemaBlocks,
 *          filterBlocksForPage, buildScriptTag, SITEWIDE_TYPES, SITEWIDE_TARGETS
 */

import { describe, it, expect } from "vitest";
import {
  isSitewideBlock,
  isHomepageBlock,
  groupSchemaBlocks,
  filterBlocksForPage,
  buildScriptTag,
  SITEWIDE_TYPES,
  SITEWIDE_TARGETS,
  type SchemaBlock,
} from "@/lib/schema-block-filter";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBlock(overrides: Partial<SchemaBlock> = {}): SchemaBlock {
  return {
    name: "Test Block",
    type: "FAQPage",
    jsonLd: { "@type": "FAQPage", "@context": "https://schema.org" },
    instructions: "Add to page",
    pageTarget: "https://example.com/faq",
    ...overrides,
  };
}

const ORG_BLOCK = makeBlock({ name: "Org", type: "Organization", pageTarget: "/about" });
const WEBSITE_BLOCK = makeBlock({ name: "Site", type: "WebSite", pageTarget: "/about" });
const BREADCRUMB_BLOCK = makeBlock({ name: "Breadcrumb", type: "BreadcrumbList", pageTarget: "/products" });
const DEFINED_TERM_BLOCK = makeBlock({ name: "Term", type: "DefinedTerm", pageTarget: "/glossary" });
const SPEAKABLE_BLOCK = makeBlock({ name: "Speakable", type: "SpeakableSpecification", pageTarget: "/news" });

const ALL_PAGES_FAQ = makeBlock({ name: "Global FAQ", type: "FAQPage", pageTarget: "all pages" });
const HOMEPAGE_PRODUCT = makeBlock({ name: "Home Product", type: "Product", pageTarget: "homepage" });
const PAGE_SPECIFIC_FAQ = makeBlock({ name: "FAQ", type: "FAQPage", pageTarget: "https://example.com/faq" });
const PAGE_SPECIFIC_PRODUCT = makeBlock({ name: "Pricing Product", type: "Product", pageTarget: "https://example.com/pricing" });
const ROBOTS_BLOCK = makeBlock({ name: "Robots", type: "RobotsTxt", pageTarget: "all pages" });

// ---------------------------------------------------------------------------
// U1–U3: isSitewideBlock
// ---------------------------------------------------------------------------

describe("isSitewideBlock", () => {
  it("U1 — Organization type → true (sitewide type)", () => {
    expect(isSitewideBlock(ORG_BLOCK)).toBe(true);
  });

  it("U1b — all SITEWIDE_TYPES recognized", () => {
    for (const type of ["Organization", "WebSite", "BreadcrumbList", "DefinedTerm", "SpeakableSpecification"]) {
      expect(isSitewideBlock(makeBlock({ type }))).toBe(true);
    }
  });

  it("U2 — 'all pages' target → true (sitewide target)", () => {
    expect(isSitewideBlock(ALL_PAGES_FAQ)).toBe(true);
  });

  it("U2b — 'All Pages' (case variation) → true", () => {
    expect(isSitewideBlock(makeBlock({ type: "FAQPage", pageTarget: "  All Pages  " }))).toBe(true);
  });

  it("U3 — page-specific FAQPage → false", () => {
    expect(isSitewideBlock(PAGE_SPECIFIC_FAQ)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// U4–U6: isHomepageBlock
// ---------------------------------------------------------------------------

describe("isHomepageBlock", () => {
  it("U4 — 'homepage' → true", () => {
    expect(isHomepageBlock(HOMEPAGE_PRODUCT)).toBe(true);
  });

  it("U5 — 'Homepage' (case-insensitive) → true", () => {
    expect(isHomepageBlock(makeBlock({ pageTarget: "Homepage" }))).toBe(true);
  });

  it("U5b — '  HOMEPAGE  ' (whitespace + case) → true", () => {
    expect(isHomepageBlock(makeBlock({ pageTarget: "  HOMEPAGE  " }))).toBe(true);
  });

  it("U6 — '/about' → false", () => {
    expect(isHomepageBlock(makeBlock({ pageTarget: "/about" }))).toBe(false);
  });

  it("U6b — 'all pages' → false (sitewide, not homepage)", () => {
    expect(isHomepageBlock(makeBlock({ pageTarget: "all pages" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// U7–U9: groupSchemaBlocks
// ---------------------------------------------------------------------------

describe("groupSchemaBlocks", () => {
  it("U7 — mixed blocks: 2 sitewide, 1 homepage, 2 page-specific, 1 RobotsTxt", () => {
    const blocks: SchemaBlock[] = [
      ORG_BLOCK,                 // sitewide (type)
      ALL_PAGES_FAQ,             // sitewide (target)
      HOMEPAGE_PRODUCT,          // homepage
      PAGE_SPECIFIC_FAQ,         // page: /faq
      PAGE_SPECIFIC_PRODUCT,     // page: /pricing
      ROBOTS_BLOCK,              // RobotsTxt → skipped
    ];

    const result = groupSchemaBlocks(blocks);

    expect(result.sitewide).toHaveLength(2);
    expect(result.homepage).toHaveLength(1);
    expect(Object.keys(result.pages)).toHaveLength(2);
    // Verify RobotsTxt is not in any group
    const allGrouped = [...result.sitewide, ...result.homepage, ...Object.values(result.pages).flat()];
    expect(allGrouped.find(b => b.type === "RobotsTxt")).toBeUndefined();
  });

  it("U8 — empty array → empty groups", () => {
    const result = groupSchemaBlocks([]);
    expect(result).toEqual({ sitewide: [], homepage: [], pages: {} });
  });

  it("U9 — all sitewide → only sitewide populated", () => {
    const blocks = [ORG_BLOCK, WEBSITE_BLOCK, BREADCRUMB_BLOCK];
    const result = groupSchemaBlocks(blocks);

    expect(result.sitewide).toHaveLength(3);
    expect(result.homepage).toHaveLength(0);
    expect(Object.keys(result.pages)).toHaveLength(0);
  });

  it("U7b — page-specific blocks grouped by pageTarget key", () => {
    const blocks = [
      PAGE_SPECIFIC_FAQ,
      makeBlock({ name: "FAQ2", type: "FAQPage", pageTarget: "https://example.com/faq" }),
      PAGE_SPECIFIC_PRODUCT,
    ];
    const result = groupSchemaBlocks(blocks);

    expect(result.pages["https://example.com/faq"]).toHaveLength(2);
    expect(result.pages["https://example.com/pricing"]).toHaveLength(1);
  });

  it("U7c — block without pageTarget → keyed under 'unknown'", () => {
    const noTarget = makeBlock({ pageTarget: undefined as unknown as string });
    const result = groupSchemaBlocks([noTarget]);
    // pageTarget ?? "unknown" per spec
    expect(result.pages["unknown"]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// U10–U12: filterBlocksForPage
// ---------------------------------------------------------------------------

describe("filterBlocksForPage", () => {
  const ALL_BLOCKS: SchemaBlock[] = [
    ORG_BLOCK,                    // sitewide (Organization type)
    ALL_PAGES_FAQ,                // sitewide ("all pages" target)
    HOMEPAGE_PRODUCT,             // homepage-only
    PAGE_SPECIFIC_FAQ,            // /faq
    PAGE_SPECIFIC_PRODUCT,        // /pricing
    ROBOTS_BLOCK,                 // RobotsTxt → skipped
  ];

  it("U10 — specific page '/pricing' → page blocks + sitewide", () => {
    const { pageBlocks, sitewideBlocks } = filterBlocksForPage(ALL_BLOCKS, "/pricing");

    // /pricing matches PAGE_SPECIFIC_PRODUCT (matchesPageTarget extracts path)
    expect(pageBlocks.some(b => b.name === "Pricing Product")).toBe(true);
    // sitewide includes ORG_BLOCK and ALL_PAGES_FAQ
    expect(sitewideBlocks).toHaveLength(2);
    // RobotsTxt excluded from everything
    expect([...pageBlocks, ...sitewideBlocks].find(b => b.type === "RobotsTxt")).toBeUndefined();
  });

  it("U11 — homepage '/' → sitewide blocks returned (matchesPageTarget handles 'all pages')", () => {
    const { pageBlocks, sitewideBlocks } = filterBlocksForPage(ALL_BLOCKS, "/");

    // Sitewide includes ORG_BLOCK and ALL_PAGES_FAQ
    expect(sitewideBlocks).toHaveLength(2);
    // HOMEPAGE_PRODUCT has pageTarget "homepage" → matchesPageTarget("homepage", "/") = true → page block
    expect(pageBlocks.some(b => b.name === "Home Product")).toBe(true);
  });

  it("U12 — no matches '/nonexistent' → only sitewide blocks", () => {
    const { pageBlocks, sitewideBlocks } = filterBlocksForPage(ALL_BLOCKS, "/nonexistent");

    expect(pageBlocks).toHaveLength(0);
    expect(sitewideBlocks).toHaveLength(2); // ORG_BLOCK + ALL_PAGES_FAQ
  });
});

// ---------------------------------------------------------------------------
// U13–U15: buildScriptTag
// ---------------------------------------------------------------------------

describe("buildScriptTag", () => {
  it("U13 — single block → unwrapped JSON", () => {
    const block = makeBlock({ jsonLd: { "@type": "Organization", name: "Acme" } });
    const tag = buildScriptTag([block]);

    expect(tag).toBe(
      `<script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>`
    );
  });

  it("U14 — multiple blocks → array JSON", () => {
    const blocks = [
      makeBlock({ jsonLd: { "@type": "Organization" } }),
      makeBlock({ jsonLd: { "@type": "WebSite" } }),
      makeBlock({ jsonLd: { "@type": "FAQPage" } }),
    ];
    const tag = buildScriptTag(blocks);

    expect(tag).toContain("<script type=\"application/ld+json\">");
    expect(tag).toContain("</script>");
    // Should be an array
    const jsonContent = tag.replace(/<script[^>]*>/, "").replace(/<\/script>/, "");
    const parsed = JSON.parse(jsonContent);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
  });

  it("U15 — empty → empty string", () => {
    expect(buildScriptTag([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Exports verification (AC8)
// ---------------------------------------------------------------------------

describe("module exports (AC8)", () => {
  it("exports SITEWIDE_TYPES as a Set", () => {
    expect(SITEWIDE_TYPES).toBeInstanceOf(Set);
    expect(SITEWIDE_TYPES.has("Organization")).toBe(true);
    expect(SITEWIDE_TYPES.has("WebSite")).toBe(true);
    expect(SITEWIDE_TYPES.has("BreadcrumbList")).toBe(true);
    expect(SITEWIDE_TYPES.has("DefinedTerm")).toBe(true);
    expect(SITEWIDE_TYPES.has("SpeakableSpecification")).toBe(true);
  });

  it("exports SITEWIDE_TARGETS as a Set", () => {
    expect(SITEWIDE_TARGETS).toBeInstanceOf(Set);
    expect(SITEWIDE_TARGETS.has("all pages")).toBe(true);
  });
});
