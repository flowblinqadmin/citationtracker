/**
 * Unit tests for app/api/v1/audit/[id]/route.ts — GET /api/v1/audit/{id}
 *
 * ES-019 Unit Test Plan (G-1 through G-6)
 *
 *   G-1  Audit found, complete → 200 with full JSON shape
 *   G-2  Audit not found → 404
 *   G-3  Wrong team (ownership mismatch) → 403
 *   G-4  MCP format via ?format=mcp → MCP tool_result JSON
 *   G-5  MCP format via Accept: application/mcp+json → MCP tool_result JSON
 *   G-6  Incomplete audit (pipelineStatus=pending) → 200 with status=pending, scorecard=null
 *
 * Mocks: @/lib/api-auth, @/lib/db, @/lib/mcp-formatter
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-auth", () => ({
  verifyApiToken: vi.fn(),
  requireScope: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock("@/lib/mcp-formatter", () => ({
  formatAsMcp: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET } from "@/app/api/v1/audit/[id]/route";
import { verifyApiToken, requireScope } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { formatAsMcp } from "@/lib/mcp-formatter";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(
  auditId: string,
  options: {
    authHeader?: string;
    searchParams?: Record<string, string>;
    acceptHeader?: string;
  } = {}
): [Request, { params: Promise<{ id: string }> }] {
  const url = new URL(`http://localhost/api/v1/audit/${auditId}`);
  if (options.searchParams) {
    for (const [key, val] of Object.entries(options.searchParams)) {
      url.searchParams.set(key, val);
    }
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.authHeader !== undefined) {
    headers["authorization"] = options.authHeader;
  }
  if (options.acceptHeader !== undefined) {
    headers["accept"] = options.acceptHeader;
  }

  const req = new Request(url.toString(), { headers });
  const ctx = { params: Promise.resolve({ id: auditId }) };
  return [req, ctx];
}

const VALID_TOKEN_PAYLOAD = {
  sub: "client-id-xyz",
  team_id: "team-abc",
  scopes: ["audit:read"],
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
};

const COMPLETE_SITE = {
  id: "audit-site-id-001",
  domain: "example.com",
  slug: "example-com",
  teamId: "team-abc",
  pipelineStatus: "complete",
  freeRunNumber: 1,
  freeOptimizationUsed: false,
  geoScorecard: { overallScore: 82, categories: {} },
  recommendations: [{ title: "Add llms.txt", priority: "high" }],
  executiveSummary: "Your site scores 82/100 for AI visibility.",
  generatedLlmsTxt: "# Example Company\n...",
  createdAt: new Date("2026-03-01T00:00:00Z"),
  updatedAt: new Date("2026-03-01T01:00:00Z"),
};

const PENDING_SITE = {
  ...COMPLETE_SITE,
  id: "audit-site-id-002",
  pipelineStatus: "pending",
  geoScorecard: null,
  recommendations: null,
  executiveSummary: null,
};

function makeSelectChain(rows: unknown[] = []) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
}

const MCP_RESULT = {
  type: "tool_result",
  tool: "get_audit",
  content: [
    { type: "text", text: "example.com — Score 82 — Top issue: Add llms.txt" },
    {
      type: "resource",
      resource: {
        uri: "https://geo.flowblinq.com/api/serve/example-com/llms.txt",
        mimeType: "text/plain",
        text: "# Example Company\n...",
      },
    },
  ],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/v1/audit/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(verifyApiToken).mockResolvedValue(VALID_TOKEN_PAYLOAD);
    vi.mocked(requireScope).mockReturnValue(undefined);
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([COMPLETE_SITE])
    );
    vi.mocked(formatAsMcp).mockReturnValue(MCP_RESULT);
  });

  it("G-1: audit found, complete → 200 with full JSON shape", async () => {
    const [req, ctx] = makeRequest("audit-site-id-001", {
      authHeader: "Bearer valid-token",
    });
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.audit_id).toBe("audit-site-id-001");
    expect(body.domain).toBe("example.com");
    expect(body.status).toBe("complete");
    expect(body.overall_score).toBe(82);
    expect(body.free_run_number).toBe(1);
    expect(body.scorecard).toBeDefined();
    expect(body.recommendations).toBeDefined();
    expect(body.executive_summary).toBeDefined();
    // files object with llms_txt_url
    expect(body.files).toBeDefined();
    expect(typeof body.files.llms_txt_url).toBe("string");
    expect(body.files.llms_txt_url).toContain("example-com");
    expect(body.created_at).toBeDefined();
    expect(body.completed_at).toBeDefined();
  });

  it("G-2: audit not found → 404", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([])
    );

    const [req, ctx] = makeRequest("nonexistent-id", {
      authHeader: "Bearer valid-token",
    });
    const res = await GET(req, ctx);

    expect(res.status).toBe(404);
  });

  it("G-3: wrong team (site.teamId !== token.team_id) → 403", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([{ ...COMPLETE_SITE, teamId: "team-other" }])
    );

    const [req, ctx] = makeRequest("audit-site-id-001", {
      authHeader: "Bearer valid-token",
    });
    const res = await GET(req, ctx);

    expect(res.status).toBe(403);
  });

  it("G-4: ?format=mcp → returns MCP tool_result JSON", async () => {
    const [req, ctx] = makeRequest("audit-site-id-001", {
      authHeader: "Bearer valid-token",
      searchParams: { format: "mcp" },
    });
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.type).toBe("tool_result");
    expect(body.tool).toBe("get_audit");
    expect(Array.isArray(body.content)).toBe(true);
    expect(vi.mocked(formatAsMcp)).toHaveBeenCalledWith(COMPLETE_SITE);
  });

  it("G-5: Accept: application/mcp+json header → returns MCP tool_result JSON", async () => {
    const [req, ctx] = makeRequest("audit-site-id-001", {
      authHeader: "Bearer valid-token",
      acceptHeader: "application/mcp+json",
    });
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.type).toBe("tool_result");
    expect(vi.mocked(formatAsMcp)).toHaveBeenCalledWith(COMPLETE_SITE);
  });

  it("G-6: incomplete audit (pipelineStatus=pending) → 200, status=pending, overall_score=null", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([PENDING_SITE])
    );

    const [req, ctx] = makeRequest("audit-site-id-002", {
      authHeader: "Bearer valid-token",
    });
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("pending");
    expect(body.overall_score).toBeNull();
    expect(body.scorecard).toBeNull();
  });
});
