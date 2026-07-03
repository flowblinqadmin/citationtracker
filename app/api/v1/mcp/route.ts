// GET /api/v1/mcp — MCP server manifest (no auth required)

import { NextResponse } from "next/server";
import { MCP_SPEC_VERSION } from "@/lib/mcp-formatter";

const MANIFEST = {
  protocol: "mcp",
  version: MCP_SPEC_VERSION,
  name: "Flowblinq GEO",
  description: "Generative Engine Optimization audit results for AI-visible content",
  auth: {
    type: "oauth2",
    grant_types: ["client_credentials"],
    token_endpoint: "https://geo.flowblinq.com/api/oauth/token",
    scopes: {
      "audit:read":    "Read audit status and results",
      "audit:write":   "Submit new audits and trigger optimization runs",
      "account:read":  "Read account credit balance and usage",
      "pageviews:read": "Read filtered page-view events (for external analytics pipelines)",
    },
  },
  tools: [
    {
      name: "run_audit",
      description: "Submit a URL for GEO analysis. Returns an audit_id to poll with get_audit.",
      inputSchema: {
        type: "object",
        required: ["url"],
        properties: {
          url: {
            type: "string",
            description: "The URL of the website to audit (e.g. https://example.com)",
          },
        },
      },
    },
    {
      name: "get_audit",
      description: "Retrieve the GEO audit result for a website, including score, recommendations, and llms.txt content.",
      inputSchema: {
        type: "object",
        required: ["audit_id"],
        properties: {
          audit_id: {
            type: "string",
            description: "Audit ID returned by run_audit.",
          },
          format: {
            type: "string",
            enum: ["json", "mcp"],
            description: "Response format. Use 'mcp' to get an MCP tool_result response.",
          },
        },
      },
    },
    {
      name: "verify_optimization",
      description: "Trigger a post-optimization re-audit (second free run) after applying the recommended changes.",
      inputSchema: {
        type: "object",
        required: ["audit_id"],
        properties: {
          audit_id: {
            type: "string",
            description: "The audit_id of the completed baseline run.",
          },
        },
      },
    },
    {
      name: "get_account",
      description: "Get the current team's credit balance and usage.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
};

export async function GET() {
  return NextResponse.json(MANIFEST, {
    headers: {
      "Cache-Control": "public, max-age=3600",
    },
  });
}
