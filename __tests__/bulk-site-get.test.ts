/**
 * GET /api/sites/[id] — Bulk audit fields coverage
 *
 * Tests the new fields added to the GET /api/sites/[id] response for bulk
 * audit support (merged in dev-an-m2-extended):
 *
 *   - auditMode field always present (defaults to "single")
 *   - bulkUrlCount field always present when set
 *   - perPageResults/perPageFixes/implementationStatus included for ALL paid audits
 *   - reportZipUrl included for paid bulk audits only
 *   - perPageResults NOT included for free-tier sites (even if set in DB)
 *
 * These complement the existing tier-gating tests in api-gating.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mockSite,
  mockTeam,
  mockScorecard,
  createTestRequest,
  createRouteContext,
  makeSelectChain,
} from "./helpers/test-harness";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { GET } from "@/app/api/sites/[id]/route";
import { db } from "@/lib/db";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TOKEN = "bulk-test-token";
const SITE_ID = "bulk-site-get-1";

const MOCK_PER_PAGE_RESULTS = [
  {
    url: "https://acme.io/about",
    pageType: "about",
    title: "About",
    vulnerabilities: [],
    overallPageHealth: "good",
  },
  {
    url: "https://acme.io/pricing",
    pageType: "pricing",
    title: "Pricing",
    vulnerabilities: [
      {
        pillar: "structured_data",
        pillarName: "Structured Data",
        severity: "high",
        finding: "No JSON-LD found.",
        recommendation: "Add schema.",
      },
    ],
    overallPageHealth: "needs-work",
  },
];

function makeBulkSiteRecord(overrides: Record<string, unknown> = {}) {
  return {
    ...mockSite({ teamId: "team-1", accessToken: TOKEN }),
    auditMode: "bulk",
    bulkUrlCount: 12,
    perPageResults: MOCK_PER_PAGE_RESULTS,
    reportZipUrl: null,
    ...overrides,
  };
}

function setupDbMocks(
  site: Record<string, unknown>,
  team: ReturnType<typeof mockTeam> | null = null
) {
  let callCount = 0;
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    callCount++;
    if (callCount === 1) return makeSelectChain(site ? [site] : []);
    return makeSelectChain(team ? [team] : []);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/sites/[id] — bulk audit fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── auditMode always included ──

  it("returns 200 for a bulk site (auditMode no longer in view response)", async () => {
    const site = makeBulkSiteRecord();
    const team = mockTeam({ id: "team-1", creditBalance: 50 });
    setupDbMocks(site, team);

    const res = await GET(createTestRequest(SITE_ID, TOKEN), createRouteContext(SITE_ID));
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    // auditMode/bulkUrlCount are no longer in geoSiteView — not returned
    expect(body.auditMode).toBeUndefined();
  });

  it("returns 200 for a regular site", async () => {
    const site = mockSite({ teamId: "team-1", accessToken: TOKEN });
    const team = mockTeam({ id: "team-1", creditBalance: 50 });
    setupDbMocks(site as unknown as Record<string, unknown>, team);

    const res = await GET(createTestRequest(SITE_ID, TOKEN), createRouteContext(SITE_ID));
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    // auditMode no longer in geoSiteView response
    expect(body.auditMode).toBeUndefined();
  });

  // ── bulkUrlCount no longer in view ──

  it("bulkUrlCount not in response (field removed from view)", async () => {
    const site = makeBulkSiteRecord();
    const team = mockTeam({ id: "team-1", creditBalance: 50 });
    setupDbMocks(site, team);

    const res = await GET(createTestRequest(SITE_ID, TOKEN), createRouteContext(SITE_ID));
    const body = await res.json() as Record<string, unknown>;

    expect(body.bulkUrlCount).toBeUndefined();
  });

  it("bulkUrlCount not in response for a single-mode site", async () => {
    const site = mockSite({ teamId: "team-1", accessToken: TOKEN });
    const team = mockTeam({ id: "team-1", creditBalance: 50 });
    setupDbMocks(site as unknown as Record<string, unknown>, team);

    const res = await GET(createTestRequest(SITE_ID, TOKEN), createRouteContext(SITE_ID));
    const body = await res.json() as Record<string, unknown>;

    expect(body.bulkUrlCount).toBeUndefined();
  });

  // ── perPageResults gating: all paid audits (TS-047) ──

  it("includes perPageResults for paid bulk audit", async () => {
    const site = makeBulkSiteRecord();
    const team = mockTeam({ id: "team-1", creditBalance: 50 }); // paid tier
    setupDbMocks(site, team);

    const res = await GET(createTestRequest(SITE_ID, TOKEN), createRouteContext(SITE_ID));
    const body = await res.json() as Record<string, unknown>;

    expect(body.tier).toBe("paid");
    expect(body.perPageResults).toBeDefined();
    expect(Array.isArray(body.perPageResults)).toBe(true);
    expect((body.perPageResults as unknown[]).length).toBe(2);
  });

  it("does NOT include perPageResults for free-tier bulk site (no team)", async () => {
    const site = makeBulkSiteRecord({ teamId: null });
    setupDbMocks(site); // no team → free tier

    const res = await GET(createTestRequest(SITE_ID, TOKEN), createRouteContext(SITE_ID));
    const body = await res.json() as Record<string, unknown>;

    expect(body.tier).toBe("free");
    // perPageResults is a paid-only bulk field — must not appear for free tier
    expect(body.perPageResults).toBeUndefined();
  });

  it("includes perPageResults for paid single-mode audit (TS-047: not bulk-only)", async () => {
    const site = {
      ...mockSite({ teamId: "team-1", accessToken: TOKEN }),
      auditMode: "single",
      bulkUrlCount: null,
      perPageResults: MOCK_PER_PAGE_RESULTS,
    };
    const team = mockTeam({ id: "team-1", creditBalance: 50 });
    setupDbMocks(site as unknown as Record<string, unknown>, team);

    const res = await GET(createTestRequest(SITE_ID, TOKEN), createRouteContext(SITE_ID));
    const body = await res.json() as Record<string, unknown>;

    expect(body.tier).toBe("paid");
    // perPageResults now available for all paid audits (single + bulk)
    expect(body.perPageResults).toBeDefined();
    expect(Array.isArray(body.perPageResults)).toBe(true);
    expect((body.perPageResults as unknown[]).length).toBe(2);
  });

  // ── reportZipUrl no longer in view ──

  it("reportZipUrl not in response (field removed from view)", async () => {
    const site = makeBulkSiteRecord();
    const team = mockTeam({ id: "team-1", creditBalance: 50 });
    setupDbMocks(site, team);

    const res = await GET(createTestRequest(SITE_ID, TOKEN), createRouteContext(SITE_ID));
    const body = await res.json() as Record<string, unknown>;

    expect(body.tier).toBe("paid");
    expect(body.reportZipUrl).toBeUndefined();
  });

  it("reportZipUrl not in response for free-tier sites", async () => {
    const site = makeBulkSiteRecord({ teamId: null });
    setupDbMocks(site);

    const res = await GET(createTestRequest(SITE_ID, TOKEN), createRouteContext(SITE_ID));
    const body = await res.json() as Record<string, unknown>;

    expect(body.tier).toBe("free");
    expect(body.reportZipUrl).toBeUndefined();
  });

  // ── scorecard included for paid bulk to enable download button ──

  it("returns full geoScorecard for paid bulk site (required for download button)", async () => {
    const scorecard = mockScorecard(3);
    const site = makeBulkSiteRecord({ overallScore: scorecard.overallScore, pillars: scorecard.pillars });
    const team = mockTeam({ id: "team-1", creditBalance: 50 });
    setupDbMocks(site, team);

    const res = await GET(createTestRequest(SITE_ID, TOKEN), createRouteContext(SITE_ID));
    const body = await res.json() as Record<string, unknown>;

    expect(body.geoScorecard).toBeDefined();
    const sc = body.geoScorecard as { overallScore?: number };
    expect(sc.overallScore).toBe(65);
  });
});
