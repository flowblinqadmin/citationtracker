/**
 * Tests for GET /api/sites/[id]/download-report — ES-005 Task 5
 *
 * 8 test cases covering:
 *   - Valid request → 200, Content-Type: application/zip, Content-Disposition header
 *   - Missing token → 401
 *   - Wrong token → 401
 *   - Non-bulk audit → 200 (ES-045: ZIP ungated for all modes)
 *   - No teamId (free user) → 402
 *   - Pipeline not complete → 409
 *   - Empty perPageResults → 404
 *   - ZIP filename derived from domain (special chars replaced with underscore)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn() },
}));

vi.mock("@/lib/services/zip-builder", () => ({
  buildReportZip: vi.fn().mockResolvedValue(Buffer.from("fake-zip-content")),
}));

vi.mock("@/lib/services/credit-deduction", () => ({
  deductCredits: vi.fn().mockResolvedValue({ success: true, balanceBefore: 100, balanceAfter: 95 }),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { GET } from "@/app/api/sites/[id]/download-report/route";
import { db } from "@/lib/db";
import { buildReportZip } from "@/lib/services/zip-builder";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSelectChain(rows: unknown[] = []) {
  return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(rows) };
}

function makeRequest(siteId: string, token?: string): import("next/server").NextRequest {
  const url = token
    ? `http://localhost/api/sites/${siteId}/download-report?token=${token}`
    : `http://localhost/api/sites/${siteId}/download-report`;
  return new Request(url, { method: "GET" }) as unknown as import("next/server").NextRequest;
}

function makeRouteContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

const SITE_ID = "site-dl-123";
const ACCESS_TOKEN = "valid-token-abc";

const MOCK_PER_PAGE_RESULTS = [
  {
    url: "https://acme.io/about",
    pageType: "about",
    title: "About",
    vulnerabilities: [],
    overallPageHealth: "good",
  },
];

function makeBulkSite(overrides: Record<string, unknown> = {}) {
  return {
    siteId: SITE_ID,
    domain: "acme.io",
    accessToken: ACCESS_TOKEN,
    // H3 (2026-05-27 audit): download-report now enforces tokenExpiresAt
    // for accessToken auth path. Tests must supply a future expiry to mimic
    // a freshly-minted site.
    tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    teamId: "team-1",
    pipelineStatus: "complete",
    overallScore: 72,
    pillars: [{ pillarName: "Structured Data", score: 45, priority: "critical" }],
    executiveSummary: "Good site.",
    perPageResults: MOCK_PER_PAGE_RESULTS,
    perPageFixes: null,
    implementationStatus: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/sites/[id]/download-report", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([makeBulkSite()])
    );
  });

  it("returns 200 with Content-Type application/zip for valid request", async () => {
    const res = await GET(
      makeRequest(SITE_ID, ACCESS_TOKEN),
      makeRouteContext(SITE_ID)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
  });

  it("returns Content-Disposition header with attachment filename", async () => {
    const res = await GET(
      makeRequest(SITE_ID, ACCESS_TOKEN),
      makeRouteContext(SITE_ID)
    );
    const disposition = res.headers.get("Content-Disposition");
    expect(disposition).toContain("attachment");
    expect(disposition).toContain(".zip");
  });

  it("derives filename from domain (replaces special chars with underscore)", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([makeBulkSite({ domain: "my-acme.io" })])
    );
    const res = await GET(
      makeRequest(SITE_ID, ACCESS_TOKEN),
      makeRouteContext(SITE_ID)
    );
    const disposition = res.headers.get("Content-Disposition");
    expect(disposition).toContain("my-acme.io-geo-audit.zip");
  });

  it("returns 401 when token query param is missing", async () => {
    const res = await GET(makeRequest(SITE_ID), makeRouteContext(SITE_ID));
    expect(res.status).toBe(401);
  });

  it("returns 401 when token does not match site accessToken", async () => {
    const res = await GET(
      makeRequest(SITE_ID, "wrong-token"),
      makeRouteContext(SITE_ID)
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 for single-mode audit (ES-045: ZIP ungated for all modes)", async () => {
    // ES-045 removed the bulk-only restriction — single audits can now download ZIP
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([makeBulkSite()])
    );
    const res = await GET(
      makeRequest(SITE_ID, ACCESS_TOKEN),
      makeRouteContext(SITE_ID)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
  });

  it("returns 200 when pipeline is not complete but data from previous run exists (ES-071: 409 guard removed)", async () => {
    // ES-071: pipelineStatus check removed — if data exists, serve it regardless of status
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([makeBulkSite({ pipelineStatus: "crawling" })])
    );
    const res = await GET(
      makeRequest(SITE_ID, ACCESS_TOKEN),
      makeRouteContext(SITE_ID)
    );
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(409);
  });

  it("returns 404 when perPageResults is empty", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([makeBulkSite({ perPageResults: [] })])
    );
    const res = await GET(
      makeRequest(SITE_ID, ACCESS_TOKEN),
      makeRouteContext(SITE_ID)
    );
    expect(res.status).toBe(404);
  });

  it("returns 402 when site has no teamId (free user attempting download)", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([makeBulkSite({ teamId: null })])
    );
    const res = await GET(
      makeRequest(SITE_ID, ACCESS_TOKEN),
      makeRouteContext(SITE_ID)
    );
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/pro account required|credits required/i);
  });

  it("calls buildReportZip with site scorecard data and per-page results", async () => {
    const res = await GET(
      makeRequest(SITE_ID, ACCESS_TOKEN),
      makeRouteContext(SITE_ID)
    );
    expect(res.status).toBe(200);
    expect(buildReportZip).toHaveBeenCalledTimes(1);
    const [siteArg, pagesArg] = (buildReportZip as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(siteArg.domain).toBe("acme.io");
    expect(siteArg.geoScorecard.overallScore).toBe(72);
    expect(pagesArg).toEqual(MOCK_PER_PAGE_RESULTS);
  });

  it("returns Content-Length header matching zip buffer size", async () => {
    const res = await GET(
      makeRequest(SITE_ID, ACCESS_TOKEN),
      makeRouteContext(SITE_ID)
    );
    const contentLength = res.headers.get("Content-Length");
    expect(contentLength).toBe(String(Buffer.from("fake-zip-content").length));
  });

  it("returns 500 on unexpected internal error (buildReportZip throws)", async () => {
    (buildReportZip as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("zip generation failed")
    );
    const res = await GET(
      makeRequest(SITE_ID, ACCESS_TOKEN),
      makeRouteContext(SITE_ID)
    );
    expect(res.status).toBe(500);
  });

  /**
   * REGRESSION: geoScorecard null check was missing — buildReportZip would receive
   * null.overallScore and throw an unhandled TypeError when a bulk audit completed
   * without a scorecard (rare but possible mid-pipeline or on pipeline failure).
   */
  it("returns 404 when geoScorecard is null (scorecard not yet available)", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([makeBulkSite({ overallScore: null })])
    );
    const res = await GET(
      makeRequest(SITE_ID, ACCESS_TOKEN),
      makeRouteContext(SITE_ID)
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/scorecard/i);
  });

  it("does NOT call buildReportZip when geoScorecard is null", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([makeBulkSite({ overallScore: null })])
    );
    await GET(makeRequest(SITE_ID, ACCESS_TOKEN), makeRouteContext(SITE_ID));
    expect(buildReportZip).not.toHaveBeenCalled();
  });
});
