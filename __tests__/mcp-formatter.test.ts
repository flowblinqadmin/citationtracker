/**
 * Unit tests for lib/mcp-formatter.ts — MCP tool_result formatter
 *
 * ES-019 Unit Test Plan (M-1 through M-3)
 *
 *   M-1  Complete audit (site with geoScorecard + generatedLlmsTxt)
 *        → McpToolResult with type=tool_result, tool=get_audit,
 *          content=[text item, resource item]
 *   M-2  Incomplete audit (pipelineStatus=pending)
 *        → single text content item with status message
 *   M-3  Complete audit without generatedLlmsTxt
 *        → resource item omitted from content array
 *
 * No mocks — formatAsMcp is a pure transformation function.
 */

import { describe, it, expect } from "vitest";

// ─── Import ───────────────────────────────────────────────────────────────────

import { formatAsMcp } from "@/lib/mcp-formatter";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const BASE_SITE = {
  id: "site-id-001",
  domain: "example.com",
  slug: "example-com",
  teamId: "team-abc",
  pipelineStatus: "complete" as const,
  freeRunNumber: 1,
  freeOptimizationUsed: false,
  geoScorecard: {
    overallScore: 82,
    categories: { citations: 75, schema: 90, llmsTxt: 80 },
    topIssues: ["Add structured data", "Improve llms.txt"],
  },
  recommendations: [{ title: "Add llms.txt", priority: "high" }],
  executiveSummary: "Your site scores 82/100 for AI visibility.",
  generatedLlmsTxt: "# Example Company\n> AI-friendly overview\n\nWe build GEO tools.",
  createdAt: new Date("2026-03-01T00:00:00Z"),
  updatedAt: new Date("2026-03-01T01:00:00Z"),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("formatAsMcp", () => {
  it("M-1: complete audit → tool_result with text item + resource item", () => {
    const result = formatAsMcp(BASE_SITE);

    // Top-level shape
    expect(result.type).toBe("tool_result");
    expect(result.tool).toBe("get_audit");
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBe(2);

    // First item: text summary
    const textItem = result.content[0];
    expect(textItem.type).toBe("text");
    expect(typeof textItem.text).toBe("string");
    // Summary should mention domain and/or score
    expect(textItem.text).toMatch(/example\.com|82/i);

    // Second item: llms.txt resource
    const resourceItem = result.content[1];
    expect(resourceItem.type).toBe("resource");
    expect(resourceItem.resource).toBeDefined();
    expect(resourceItem.resource.mimeType).toBe("text/plain");
    expect(typeof resourceItem.resource.uri).toBe("string");
    expect(resourceItem.resource.uri).toContain("example-com");
    // The llms.txt content should be embedded
    expect(resourceItem.resource.text).toContain("Example Company");
  });

  it("M-1b: result includes MCP_SPEC_VERSION constant in module", async () => {
    // The module should export MCP_SPEC_VERSION
    const mod = await import("@/lib/mcp-formatter");
    expect(mod.MCP_SPEC_VERSION).toBeDefined();
    expect(typeof mod.MCP_SPEC_VERSION).toBe("string");
  });

  it("M-2: incomplete audit (pipelineStatus=pending) → single text content item with status message", () => {
    const incompleteSite = {
      ...BASE_SITE,
      pipelineStatus: "pending" as const,
      geoScorecard: null,
      recommendations: null,
      executiveSummary: null,
      generatedLlmsTxt: null,
    };

    const result = formatAsMcp(incompleteSite);

    expect(result.type).toBe("tool_result");
    expect(result.tool).toBe("get_audit");
    expect(Array.isArray(result.content)).toBe(true);
    // Only one text item (no resource since no llmsTxt)
    expect(result.content.length).toBe(1);

    const textItem = result.content[0];
    expect(textItem.type).toBe("text");
    // Should mention pending or in-progress status
    expect(textItem.text).toMatch(/pending|progress|running|not (yet )?complete/i);
  });

  it("M-2b: running status also returns single text content item", () => {
    const runningSite = {
      ...BASE_SITE,
      pipelineStatus: "running" as const,
      geoScorecard: null,
      generatedLlmsTxt: null,
    };

    const result = formatAsMcp(runningSite);

    expect(result.content.length).toBe(1);
    expect(result.content[0].type).toBe("text");
  });

  it("M-3: complete audit without generatedLlmsTxt → resource item omitted", () => {
    const siteWithoutLlmsTxt = {
      ...BASE_SITE,
      generatedLlmsTxt: null,
    };

    const result = formatAsMcp(siteWithoutLlmsTxt);

    expect(result.type).toBe("tool_result");
    // Only the text item, no resource item
    expect(result.content.length).toBe(1);
    expect(result.content[0].type).toBe("text");
    // No resource items present
    const resourceItems = result.content.filter((c) => c.type === "resource");
    expect(resourceItems.length).toBe(0);
  });

  it("M-3b: complete audit with empty string generatedLlmsTxt → resource item omitted", () => {
    const siteEmptyLlmsTxt = {
      ...BASE_SITE,
      generatedLlmsTxt: "",
    };

    const result = formatAsMcp(siteEmptyLlmsTxt);

    const resourceItems = result.content.filter((c) => c.type === "resource");
    expect(resourceItems.length).toBe(0);
  });
});
