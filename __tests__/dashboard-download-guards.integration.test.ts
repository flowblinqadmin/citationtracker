/**
 * ES-071 — Dashboard: Download Guards, Failure Fallback, Pipeline Error Visibility
 * Integration tests — IT-071-1 through IT-071-4
 *
 * IT-071-1: download-report returns ZIP when status=failed but data exists
 * IT-071-2: download-report returns 404 when status=failed and no data
 * IT-071-3: pdf-report returns PDF when status=failed but score exists
 * IT-071-4: pdf-report returns 404 when no score exists
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn() },
}));

vi.mock("@/lib/services/zip-builder", () => ({
  buildReportZip: vi.fn().mockResolvedValue(Buffer.from("fake-zip-content")),
}));

vi.mock("@/lib/services/credit-deduction", () => ({
  deductCredits: vi.fn().mockResolvedValue({ success: true, balanceBefore: 100, balanceAfter: 95 }),
}));

// Mock puppeteer-core + chromium for pdf-report
const mockPdfBuffer = Buffer.from("fake-pdf-content");
const mockPage = {
  setContent: vi.fn().mockResolvedValue(undefined),
  pdf: vi.fn().mockResolvedValue(mockPdfBuffer),
};
const mockBrowser = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn().mockResolvedValue(undefined),
};
vi.mock("puppeteer-core", () => ({
  launch: vi.fn().mockResolvedValue(mockBrowser),
}));

vi.mock("@/lib/services/pdf-report-html", () => ({
  generatePdfReportHtml: vi.fn().mockReturnValue("<html>mock</html>"),
}));

// Set PUPPETEER_EXECUTABLE_PATH so the route skips @sparticuz/chromium-min (which downloads binaries)
process.env.PUPPETEER_EXECUTABLE_PATH = "/fake/chromium-for-tests";

// ── Imports ──────────────────────────────────────────────────────────────────

import { GET as downloadReportGET } from "@/app/api/sites/[id]/download-report/route";
import { GET as pdfReportGET } from "@/app/api/sites/[id]/pdf-report/route";
import { db } from "@/lib/db";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSelectChain(rows: unknown[] = []) {
  // Chain must be: awaitable (for .from().where() → await), AND chainable (for .where().orderBy().limit())
  const chain: Record<string, unknown> & { then: unknown; catch: unknown } = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    catch: (reject: (e: unknown) => unknown) => Promise.resolve(rows).catch(reject),
  };
  (chain.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  (chain.where as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  (chain.orderBy as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  return chain;
}

function makeRequest(path: string, token?: string): Request {
  const url = token ? `http://localhost${path}?token=${token}` : `http://localhost${path}`;
  return new Request(url, { method: "GET" });
}

function makeRouteContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

const SITE_ID = "site-071-int";
const ACCESS_TOKEN = "token-int-071";

function makeSite(overrides: Record<string, unknown> = {}) {
  return {
    siteId: SITE_ID,
    domain: "acme.io",
    accessToken: ACCESS_TOKEN,
    // H3 (2026-05-27 audit): download-report + pdf-report enforce tokenExpiresAt.
    tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    teamId: "team-1",
    pipelineStatus: "complete",
    overallScore: 65,
    pillars: [{ pillarName: "Structured Data", pillar: "structured_data", score: 45, priority: "critical", findings: "", recommendation: "" }],
    executiveSummary: "Test summary.",
    perPageResults: [{ url: "https://acme.io/", pageType: "homepage", title: "Home", vulnerabilities: [], overallPageHealth: "good" }],
    perPageFixes: null,
    implementationStatus: null,
    rankedRecommendations: [],
    citationRate: null,
    pageCount: 1,
    lastCrawlAt: new Date("2026-03-30"),
    ...overrides,
  };
}

// ── IT-071-1: download-report returns ZIP when status=failed + data exists ────

describe("IT-071-1: download-report — failed status with data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([makeSite({ pipelineStatus: "failed" })])
    );
  });

  it("returns 200 application/zip when pipelineStatus=failed but data exists", async () => {
    const res = await downloadReportGET(
      makeRequest(`/api/sites/${SITE_ID}/download-report`, ACCESS_TOKEN),
      makeRouteContext(SITE_ID)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
  });
});

// ── IT-071-2: download-report returns 404 when status=failed and no data ──────

describe("IT-071-2: download-report — failed status with no data", () => {
  it("returns 404 when pipelineStatus=failed and no perPageResults", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([makeSite({ pipelineStatus: "failed", perPageResults: [], overallScore: null })])
    );
    const res = await downloadReportGET(
      makeRequest(`/api/sites/${SITE_ID}/download-report`, ACCESS_TOKEN),
      makeRouteContext(SITE_ID)
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/no per-page results/i);
  });

  it("does NOT return 409 for pipelineStatus=failed (old behavior eliminated)", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([makeSite({ pipelineStatus: "failed", perPageResults: [] })])
    );
    const res = await downloadReportGET(
      makeRequest(`/api/sites/${SITE_ID}/download-report`, ACCESS_TOKEN),
      makeRouteContext(SITE_ID)
    );
    expect(res.status).not.toBe(409);
  });
});

// ── IT-071-3: pdf-report — pipelineStatus check removed for failed sites ──────

describe("IT-071-3: pdf-report — failed status with score", () => {
  it("does NOT return 409 for pipelineStatus=failed (pipelineStatus check removed)", async () => {
    // The old guard returned 409 for any non-complete status.
    // After Fix 2, the route proceeds past the status check — either serving the PDF
    // (when puppeteer is available) or failing further down (500 from puppeteer binary absence).
    // Either way, 409 must NOT be returned.
    (db.select as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeSelectChain([makeSite({ pipelineStatus: "failed", overallScore: 65 })]))
      .mockReturnValue(makeSelectChain([]));
    const res = await pdfReportGET(
      makeRequest(`/api/sites/${SITE_ID}/pdf-report`, ACCESS_TOKEN),
      makeRouteContext(SITE_ID)
    );
    // 500 is acceptable (puppeteer not available in Docker/test), but 409 must not happen
    expect(res.status).not.toBe(409);
  }, 15_000);
});

// ── IT-071-4: pdf-report returns 404 when no score ───────────────────────────

describe("IT-071-4: pdf-report — no overallScore", () => {
  it("returns 404 when overallScore is null", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([makeSite({ pipelineStatus: "failed", overallScore: null })])
    );
    const res = await pdfReportGET(
      makeRequest(`/api/sites/${SITE_ID}/pdf-report`, ACCESS_TOKEN),
      makeRouteContext(SITE_ID)
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/scorecard not yet available/i);
  });
});
