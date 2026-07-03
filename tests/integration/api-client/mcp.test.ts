/**
 * MCP manifest and format tests — M-1 through M-5.
 *
 * M-1/M-2: Validate the MCP server manifest returned by getMcpManifest().
 *   getMcpManifest() requires no authentication.
 *
 * M-3/M-4/M-5: Validate the MCP-formatted audit response.
 *   Requires a completed auditId. Since mcp.test.ts runs after audit-flow.test.ts
 *   alphabetically, we query Supabase to find the completed audit from that run.
 *
 * Required env vars:
 *   TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_KEY (for auditId lookup)
 *
 * Uses globalThis.__API_CLIENT_QA__ from setup.ts.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { FlowblinqClient } from "@/lib/flowblinq-client";
import type { McpManifest } from "@/lib/flowblinq-client";

// ─── Shared state ─────────────────────────────────────────────────────────────

let client: FlowblinqClient;
let manifest: McpManifest;

/** auditId of a completed audit — resolved via Supabase query in beforeAll. */
let completedAuditId: string | null = null;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const qa = globalThis.__API_CLIENT_QA__;
  if (!qa) throw new Error("API_CLIENT_QA not initialised — check setup.ts");

  client = new FlowblinqClient({
    clientId: qa.clientId,
    clientSecret: qa.clientSecret,
    baseUrl: qa.baseUrl,
  });

  // Find a completed audit from the current test run (set by audit-flow.test.ts F-3
  // and/or errors.test.ts E-2). Query Supabase directly.
  try {
    const supabase = createClient(
      process.env.TEST_SUPABASE_URL!,
      process.env.TEST_SUPABASE_SERVICE_KEY!
    );

    const { data, error } = await supabase
      .from("geo_sites")
      .select("id")
      .eq("api_client_id", qa.clientId)
      .eq("pipeline_status", "complete")
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) {
      console.warn(`[mcp setup] Supabase query failed: ${error.message}`);
    } else if (data && data.length > 0) {
      completedAuditId = data[0].id as string;
      console.log(`[mcp setup] Found completed auditId=${completedAuditId}`);
    } else {
      console.warn(
        "[mcp setup] No completed audit found for this credential. " +
          "M-3/M-4/M-5 will be skipped. Run audit-flow.test.ts first."
      );
    }
  } catch (err) {
    console.warn("[mcp setup] Could not query Supabase:", err);
  }
});

// ─── M-1 / M-2: Manifest ──────────────────────────────────────────────────────

describe("MCP: manifest", () => {
  it("M-1: getMcpManifest returns valid protocol and version", async () => {
    manifest = await client.getMcpManifest();

    expect(typeof manifest.protocol).toBe("string");
    expect(manifest.protocol.length).toBeGreaterThan(0);

    expect(typeof manifest.version).toBe("string");
    expect(manifest.version.length).toBeGreaterThan(0);
  });

  it(
    "M-2: manifest.tools has exactly 4 items with correct names and shapes",
    () => {
      expect(Array.isArray(manifest.tools)).toBe(true);
      expect(manifest.tools.length).toBe(4);

      const toolNames = manifest.tools.map((t) => t.name);
      expect(toolNames).toContain("run_audit");
      expect(toolNames).toContain("get_audit");
      expect(toolNames).toContain("verify_optimization");
      expect(toolNames).toContain("get_account");

      for (const tool of manifest.tools) {
        expect(typeof tool.name).toBe("string");
        expect(typeof tool.description).toBe("string");
        expect(tool.description.length).toBeGreaterThan(0);
        expect(typeof tool.inputSchema).toBe("object");
        expect(tool.inputSchema).not.toBeNull();
      }
    }
  );
});

// ─── M-3 / M-4 / M-5: MCP-formatted audit response ───────────────────────────

describe("MCP: audit format", () => {
  it("M-3: getAudit with format='mcp' returns tool_result with content array", async () => {
    if (!completedAuditId) {
      console.warn("[M-3] Skipping — no completed audit found. Run audit-flow.test.ts first.");
      return;
    }

    const result = await client.getAudit(completedAuditId, { format: "mcp" });

    // MCP tool_result shape (returned raw — not typed as AuditResponse)
    // Cast through unknown since MCP format differs from standard AuditResponse
    const mcpResult = result as unknown as {
      type: string;
      content: Array<{ type: string; [key: string]: unknown }>;
    };

    expect(mcpResult.type).toBe("tool_result");
    expect(Array.isArray(mcpResult.content)).toBe(true);
    expect(mcpResult.content.length).toBeGreaterThan(0);
  });

  it("M-4: MCP content includes a text item with score summary", async () => {
    if (!completedAuditId) {
      console.warn("[M-4] Skipping — no completed audit found.");
      return;
    }

    const result = await client.getAudit(completedAuditId, { format: "mcp" });
    const mcpResult = result as unknown as {
      type: string;
      content: Array<{ type: string; text?: string; [key: string]: unknown }>;
    };

    const textItems = mcpResult.content.filter((item) => item.type === "text");
    expect(textItems.length).toBeGreaterThan(0);

    // At least one text item should contain a score reference
    const hasScoreText = textItems.some(
      (item) =>
        typeof item.text === "string" &&
        (item.text.includes("score") ||
          item.text.includes("Score") ||
          /\d+/.test(item.text)) // contains a number (the score)
    );
    expect(hasScoreText).toBe(true);
  });

  it("M-5: MCP content includes a resource item with https:// URI", async () => {
    if (!completedAuditId) {
      console.warn("[M-5] Skipping — no completed audit found.");
      return;
    }

    const result = await client.getAudit(completedAuditId, { format: "mcp" });
    const mcpResult = result as unknown as {
      type: string;
      content: Array<{
        type: string;
        resource?: { uri: string; [key: string]: unknown };
        [key: string]: unknown;
      }>;
    };

    const resourceItems = mcpResult.content.filter(
      (item) => item.type === "resource" && item.resource
    );
    expect(resourceItems.length).toBeGreaterThan(0);

    const firstResource = resourceItems[0].resource!;
    expect(typeof firstResource.uri).toBe("string");
    expect(firstResource.uri.startsWith("https://")).toBe(true);
  });
});
