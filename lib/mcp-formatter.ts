import type { GeoSite } from "@/lib/db/schema";

export const MCP_SPEC_VERSION = "1.0";

// ── MCP Types ─────────────────────────────────────────────────────────────────

interface McpTextContent {
  type: "text";
  text: string;
}

interface McpResourceContent {
  type: "resource";
  resource: {
    uri: string;
    mimeType: string;
    text: string | null;
  };
}

export interface McpToolResult {
  type: "tool_result";
  tool: "get_audit";
  content: Array<McpTextContent | McpResourceContent>;
}

// ── formatAsMcp ───────────────────────────────────────────────────────────────

export function formatAsMcp(site: GeoSite): McpToolResult {
  // If audit is not complete, return a single status text item
  if (site.pipelineStatus !== "complete") {
    return {
      type: "tool_result",
      tool: "get_audit",
      content: [
        {
          type: "text",
          text: `Audit for ${site.domain} is ${site.pipelineStatus}. Check back shortly.`,
        },
      ],
    };
  }

  const scorecard = site.geoScorecard as { overallScore?: number; topIssues?: string[] } | null;
  const overallScore = scorecard?.overallScore ?? null;
  const topIssues = scorecard?.topIssues ?? [];

  const summaryParts = [`GEO audit for ${site.domain}.`];
  if (overallScore !== null) summaryParts.push(`Overall score: ${overallScore}/100.`);
  if (topIssues.length > 0) summaryParts.push(`Top issues: ${topIssues.slice(0, 3).join(", ")}.`);
  const summaryText = summaryParts.join(" ");

  const content: Array<McpTextContent | McpResourceContent> = [
    { type: "text", text: summaryText },
  ];

  // Include llms.txt resource only if available
  if (site.slug && site.generatedLlmsTxt) {
    const llmsTxtUrl = `https://geo.flowblinq.com/api/serve/${site.slug}/llms.txt`;
    content.push({
      type: "resource",
      resource: {
        uri: llmsTxtUrl,
        mimeType: "text/plain",
        text: site.generatedLlmsTxt,
      },
    });
  }

  return {
    type: "tool_result",
    tool: "get_audit",
    content,
  };
}
