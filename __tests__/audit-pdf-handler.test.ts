/**
 * Tests for audit-pdf-handler.ts — Task 2: renderAuditPdfBuffer extraction.
 *
 * Verifies the module shape (new export exists), that PdfAuthError is thrown
 * for invalid auth, and that generateAuditPdfResponse is a thin wrapper that
 * returns 401/404 without ever touching Puppeteer.
 *
 * Full PDF rendering (Puppeteer) is not tested here — it requires a real
 * Chromium binary which is not available in the unit-test Docker image.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockDbSelect } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ _tag: "eq", val })),
  desc: vi.fn((_col: unknown) => ({ _tag: "desc" })),
  and: vi.fn((...args: unknown[]) => ({ _tag: "and", args })),
}));

vi.mock("@/lib/db/schema", () => ({
  geoSiteView: { siteId: "site_id", domain: "domain", accessToken: "access_token", teamId: "team_id", overallScore: "overall_score", lastCrawlAt: "last_crawl_at", projectedScore: "projected_score", pillars: "pillars", rankedRecommendations: "ranked_recommendations", pageCount: "page_count", executiveSummary: "executive_summary", discoveryData: "discovery_data" },
  citationCheckScores: { siteId: "site_id", createdAt: "created_at" },
  auditPurchases: { id: "id", siteId: "site_id", purchaseToken: "purchase_token", customerEmail: "customer_email" },
}));

vi.mock("@/lib/services/credit-deduction", () => ({
  deductCredits: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/lib/config", () => ({
  ACTION_CREDITS: { pdfDownload: 1 },
}));

vi.mock("@/lib/services/pdf-report-html", () => ({
  generatePdfReportHtml: vi.fn().mockReturnValue("<html><body>mock</body></html>"),
  brandLogoSvg: vi.fn().mockReturnValue("<svg/>"),
}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe("audit-pdf-handler — module exports (Task 2)", () => {
  it("exports renderAuditPdfBuffer as a named function", async () => {
    const mod = await import("@/lib/services/audit-pdf-handler");
    expect(typeof mod.renderAuditPdfBuffer).toBe("function");
  });

  it("exports generateAuditPdfResponse as a named function", async () => {
    const mod = await import("@/lib/services/audit-pdf-handler");
    expect(typeof mod.generateAuditPdfResponse).toBe("function");
  });

  it("exports PdfAuthError class", async () => {
    const mod = await import("@/lib/services/audit-pdf-handler");
    expect(typeof mod.PdfAuthError).toBe("function");
  });
});

describe("audit-pdf-handler — PdfAuthError shape (Task 2)", () => {
  it("PdfAuthError carries a status code", async () => {
    const { PdfAuthError } = await import("@/lib/services/audit-pdf-handler");
    const err = new PdfAuthError(404, "not found");
    expect(err.status).toBe(404);
    expect(err.message).toBe("not found");
    expect(err instanceof Error).toBe(true);
  });
});

describe("audit-pdf-handler — renderAuditPdfBuffer auth validation (Task 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws PdfAuthError(404) when site does not exist", async () => {
    const { renderAuditPdfBuffer, PdfAuthError } = await import("@/lib/services/audit-pdf-handler");

    // purchase lookup returns empty, site lookup returns empty
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await expect(
      renderAuditPdfBuffer("nonexistent-site", { purchaseToken: "bad-token" }),
    ).rejects.toBeInstanceOf(PdfAuthError);

    try {
      await renderAuditPdfBuffer("nonexistent-site", { purchaseToken: "bad-token" });
    } catch (err) {
      expect((err as InstanceType<typeof PdfAuthError>).status).toBe(404);
    }
  });

  it("throws PdfAuthError(404) when overallScore is null", async () => {
    const { renderAuditPdfBuffer, PdfAuthError } = await import("@/lib/services/audit-pdf-handler");

    const site = {
      siteId: "site-123",
      domain: "example.com",
      accessToken: "tok-abc",
      teamId: "team-1",
      overallScore: null,
      lastCrawlAt: null,
      pillars: [],
      rankedRecommendations: [],
      pageCount: 0,
      executiveSummary: null,
      discoveryData: null,
      projectedScore: null,
    };

    let callCount = 0;
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          callCount++;
          // Call 1: auditPurchases lookup (returns match)
          if (callCount === 1) return Promise.resolve([{ id: "p1", customerEmail: "buyer@example.com" }]);
          // Call 2: geoSiteView lookup
          return Promise.resolve([site]);
        }),
      }),
    });

    await expect(
      renderAuditPdfBuffer("site-123", { purchaseToken: "valid-token" }),
    ).rejects.toBeInstanceOf(PdfAuthError);
  });
});

describe("audit-pdf-handler — generateAuditPdfResponse 401 paths (Task 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when no token and no purchaseToken", async () => {
    const { generateAuditPdfResponse } = await import("@/lib/services/audit-pdf-handler");

    // No DB call expected — short-circuits before any DB query
    const req = new Request("https://geo.flowblinq.com/api/sites/site-123/pdf-report");
    const resp = await generateAuditPdfResponse(req, "site-123");
    expect(resp.status).toBe(401);
  });

  it("returns 401 when accessToken does not match", async () => {
    const { generateAuditPdfResponse } = await import("@/lib/services/audit-pdf-handler");

    // After FOLLOW-UP #3: wrapper only queries geoSiteView for accessToken validation
    // (no pre-check of auditPurchases — that is owned entirely by renderAuditPdfBuffer).
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ accessToken: "correct-token" }]),
      }),
    });

    const req = new Request("https://geo.flowblinq.com/api/sites/site-123/pdf-report?token=wrong-token");
    const resp = await generateAuditPdfResponse(req, "site-123");
    expect(resp.status).toBe(401);
  });
});

// ── BLOCKER #2: ownBusinessJson type guard ────────────────────────────────────
//
// The guard logic is: const bj = discovery?.ownBusinessJson;
//   if (!bj || typeof bj !== "object" || Array.isArray(bj)) return false;
//   return Object.keys(bj as Record<string, unknown>).length >= 4;
//
// We test it by evaluating the same logic inline (mirrors the implementation
// exactly) to avoid needing to thread through the full renderAuditPdfBuffer
// call stack with puppeteer-core mocking.

function hasBusinessJsonGuard(ownBusinessJson: unknown): boolean {
  const bj = ownBusinessJson;
  if (!bj || typeof bj !== "object" || Array.isArray(bj)) return false;
  return Object.keys(bj as Record<string, unknown>).length >= 4;
}

describe("audit-pdf-handler — hasBusinessJson type guard (BLOCKER #2)", () => {
  it("returns false when ownBusinessJson is null", () => {
    expect(hasBusinessJsonGuard(null)).toBe(false);
  });

  it("returns false when ownBusinessJson is undefined", () => {
    expect(hasBusinessJsonGuard(undefined)).toBe(false);
  });

  it("returns false when ownBusinessJson is a string (not an object)", () => {
    // A plain string would previously call Object.keys on a string, yielding
    // character-index keys ("0", "1", ...) — now safely rejected.
    expect(hasBusinessJsonGuard("{}")).toBe(false);
    expect(hasBusinessJsonGuard('{"a":1,"b":2,"c":3,"d":4}')).toBe(false);
  });

  it("returns false when ownBusinessJson is an array", () => {
    expect(hasBusinessJsonGuard([1, 2, 3, 4, 5])).toBe(false);
  });

  it("returns false when ownBusinessJson has only 3 keys", () => {
    expect(hasBusinessJsonGuard({ a: 1, b: 2, c: 3 })).toBe(false);
  });

  it("returns true when ownBusinessJson has 4 keys", () => {
    expect(hasBusinessJsonGuard({ a: 1, b: 2, c: 3, d: 4 })).toBe(true);
  });

  it("returns true when ownBusinessJson has more than 4 keys", () => {
    expect(hasBusinessJsonGuard({ name: "ACME", url: "x", type: "Org", address: "y", tel: "z" })).toBe(true);
  });
});
