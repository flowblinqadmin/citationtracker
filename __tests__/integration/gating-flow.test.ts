/**
 * Integration Tests — Full Gating Flow
 *
 * Exercises the complete request → tier derivation → response gating pipeline
 * using actual route handlers with mocked DB. Tests multi-step flows and
 * verifies the security boundary between free and paid tiers.
 *
 * 13 scenarios from ES-002 spec:
 *   1.  Anonymous user → free-tier response
 *   2.  Paid user → full response
 *   3.  User pays → tier upgrades on next fetch
 *   4.  Credits depleted → tier downgrades
 *   5.  Public report always free-gated
 *   6.  Free crawl depth verified
 *   7.  Paid crawl depth verified
 *   8.  Config constants propagation
 *   9.  Credit transaction after paid crawl
 *   10. Security boundary: free response must NOT contain findings
 *   11. Team table unavailable → defaults to free
 *   12. Malformed scorecard JSONB
 *   13. Empty executive summary
 *
 * These tests are written BEFORE implementation (test-first).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import {
  mockTeam,
  mockSite,
  mockScorecard,
  mockRecommendations,
  assertFreeGating,
  assertPaidFull,
  createTestRequest,
  createRouteContext,
  createReportRequest,
  createReportRouteContext,
  makeSelectChain,
  makeSelectChainWithError,
} from "../helpers/test-harness";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockEnqueueStage } = vi.hoisted(() => ({
  mockEnqueueStage: vi.fn().mockResolvedValue(undefined),
}));

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: mockEnqueueStage,
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn().mockReturnValue("mock-id"),
}));


vi.mock("@/lib/email", () => ({
  sendCompletionEmail: vi.fn().mockResolvedValue(undefined),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { db } from "@/lib/db";

// ─── DB Mock Helpers ─────────────────────────────────────────────────────────

function makeUpdateChain() {
  return {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  };
}

function makeInsertChain() {
  return {
    values: vi.fn().mockResolvedValue([]),
  };
}

/**
 * Configures sequential db.select() calls.
 * Pass an array of row-arrays; each call to db.select() consumes the next entry.
 */
function setupSequentialSelects(...callResults: unknown[][]) {
  let callIndex = 0;
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    const rows = callResults[callIndex] ?? [];
    callIndex++;
    return makeSelectChain(rows);
  });
}

// ─── Integration Scenarios ──────────────────────────────────────────────────

describe("Integration: Gating Flow", () => {
  const TOKEN = "test-token";
  const SITE_ID = "site-test-1";

  beforeEach(() => {
    vi.clearAllMocks();
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  // ── Scenario 1: Anonymous user creates site → gets free-tier response ──

  it("anonymous user gets free-tier gated response", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");

    const site = mockSite({
      teamId: null,
      accessToken: TOKEN,
      pipelineStatus: "complete",
    });

    // Only one select (site lookup) — no team lookup for anonymous
    setupSequentialSelects([site]);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    assertFreeGating(body);
    expect(body.id).toBe(SITE_ID);
    expect(body.domain).toBe("example.com");
  });

  // ── Scenario 2: Paid user creates site → gets full response ──

  it("paid user gets full response with all fields", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");

    const site = mockSite({
      teamId: "team-1",
      accessToken: TOKEN,
      pipelineStatus: "complete",
    });
    const team = mockTeam({ id: "team-1", creditBalance: 100 });

    setupSequentialSelects([site], [team]);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    assertPaidFull(body);
    expect(body.credits).toBe(100);
  });

  // ── Scenario 3: User pays → tier upgrades on next fetch ──

  it("user tier upgrades from free to paid after payment", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");

    const site = mockSite({
      teamId: "team-1",
      accessToken: TOKEN,
    });

    // First fetch: team has 0 credits (free)
    setupSequentialSelects(
      [site],
      [mockTeam({ id: "team-1", creditBalance: 0 })]
    );

    const freeRes = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const freeBody = (await freeRes.json()) as Record<string, unknown>;
    expect(freeBody.tier).toBe("free");

    vi.clearAllMocks();
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());

    // Second fetch: team now has credits (paid) — simulates post-payment
    setupSequentialSelects(
      [site],
      [mockTeam({ id: "team-1", creditBalance: 50 })]
    );

    const paidRes = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const paidBody = (await paidRes.json()) as Record<string, unknown>;
    expect(paidBody.tier).toBe("paid");
  });

  // ── Scenario 4: Credits depleted → tier downgrades ──

  it("user tier downgrades from paid to free when credits are depleted", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");

    const site = mockSite({
      teamId: "team-1",
      accessToken: TOKEN,
    });

    // First fetch: team has credits (paid)
    setupSequentialSelects(
      [site],
      [mockTeam({ id: "team-1", creditBalance: 50 })]
    );

    const paidRes = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const paidBody = (await paidRes.json()) as Record<string, unknown>;
    expect(paidBody.tier).toBe("paid");

    vi.clearAllMocks();
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());

    // Second fetch: credits depleted
    setupSequentialSelects(
      [site],
      [mockTeam({ id: "team-1", creditBalance: 0 })]
    );

    const freeRes = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const freeBody = (await freeRes.json()) as Record<string, unknown>;
    expect(freeBody.tier).toBe("free");
    assertFreeGating(freeBody);
  });

  // ── Scenario 5: Public report always free-gated ──

  it("public report applies free-tier gating regardless of payment status", async () => {
    const { GET } = await import("@/app/api/report/[shareToken]/route");

    const site = mockSite({
      teamId: "team-1", // Site belongs to a paying team
      shareToken: "share-abc123",
      pipelineStatus: "complete",
    });

    // Report route queries by shareToken, not id — site lookup only
    setupSequentialSelects([site]);

    const res = await GET(
      createReportRequest("share-abc123"),
      createReportRouteContext("share-abc123")
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);

    // Public report MUST be free-gated even though the site is paid
    if (body.geoScorecard != null) {
      const scorecard = body.geoScorecard as {
        pillars?: Array<Record<string, unknown>>;
      };
      if (scorecard.pillars) {
        for (const pillar of scorecard.pillars) {
          expect(pillar).not.toHaveProperty("findings");
          expect(pillar).not.toHaveProperty("recommendation");
          expect(pillar).not.toHaveProperty("impactedPages");
        }
      }
    }

    // Generated files must never be in public report
    expect(body).not.toHaveProperty("generatedLlmsTxt");
    expect(body).not.toHaveProperty("generatedLlmsFullTxt");
    expect(body).not.toHaveProperty("generatedBusinessJson");
    expect(body).not.toHaveProperty("generatedSchemaBlocks");
  });

  // ── Scenario 6: Free crawl depth verified ──

  it("anonymous free crawl uses FREE_MAX_PAGES", async () => {
    const { POST } = await import("@/app/api/sites/[id]/regenerate/route");

    const site = {
      id: SITE_ID,
      domain: "example.com",
      teamId: null,
      accessToken: TOKEN,
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000), // HP-197
      pipelineStatus: "pending",
    };

    setupSequentialSelects([site]);

    const req = new NextRequest(
      new Request(
        `http://localhost/api/sites/${SITE_ID}/regenerate?token=${TOKEN}`,
        { method: "POST" }
      )
    );

    const res = await POST(req, { params: Promise.resolve({ id: SITE_ID }) });
    expect(res.status).toBe(202);

    // enqueueStage must be called with FREE_MAX_PAGES (20)
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE_ID, domain: "example.com", stage: "discover" })
    );
    const maxPagesArg = (mockEnqueueStage.mock.calls[0][0] as { maxPages: number }).maxPages;
    expect(maxPagesArg).toBeLessThan(100); // Free should be less than paid
    expect(maxPagesArg).toBe(20); // FREE_MAX_PAGES default
  });

  // ── Scenario 7: Paid crawl depth verified ──

  it("paid user crawl computes maxPages from credit balance", async () => {
    const { POST } = await import("@/app/api/sites/[id]/regenerate/route");

    const site = {
      id: SITE_ID,
      domain: "example.com",
      teamId: "team-1",
      accessToken: TOKEN,
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000), // HP-197
      pipelineStatus: "complete",
    };
    const team = { id: "team-1", creditBalance: 100 };

    setupSequentialSelects([site], [team]);

    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: unknown) => Promise<void>) => {
        const teamData = [{ creditBalance: 100 }];
        const whereResult = Object.assign(Promise.resolve(teamData), {
          for: vi.fn().mockResolvedValue(teamData),
        });
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnValue(whereResult),
          }),
          update: vi.fn().mockReturnValue(makeUpdateChain()),
          insert: vi.fn().mockReturnValue(makeInsertChain()),
        };
        await fn(tx);
      }
    );

    const req = new NextRequest(
      new Request(
        `http://localhost/api/sites/${SITE_ID}/regenerate?token=${TOKEN}`,
        { method: "POST" }
      )
    );

    const res = await POST(req, { params: Promise.resolve({ id: SITE_ID }) });
    expect(res.status).toBe(202);

    // enqueueStage called with maxPages = min(creditBalance * PAGES_PER_CREDIT, PAID_MAX_PAGES)
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE_ID, domain: "example.com", stage: "discover", maxPages: 100 })
    );
  });

  // ── Scenario 8: Config constants propagation ──

  it("config constants flow through to route handler behavior", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");
    const {
      FREE_MAX_PAGES,
      PAID_MAX_PAGES,
    } = await import("@/lib/config");

    // Verify config values are accessible and correct
    expect(FREE_MAX_PAGES).toBeDefined();
    expect(PAID_MAX_PAGES).toBeDefined();
    expect(FREE_MAX_PAGES).toBeLessThan(PAID_MAX_PAGES);

    // Verify the handler produces different behavior based on tier
    const site = mockSite({ teamId: null, accessToken: TOKEN });
    setupSequentialSelects([site]);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;

    // Free tier should be applied
    expect(body.tier).toBe("free");
  });

  // ── Scenario 9: Credit transaction after paid crawl ──

  it("paid crawl creates credit transaction with correct cost from config", async () => {
    const { POST } = await import("@/app/api/sites/[id]/regenerate/route");

    const site = {
      id: SITE_ID,
      domain: "example.com",
      teamId: "team-1",
      accessToken: TOKEN,
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000), // HP-197
      pipelineStatus: "complete",
    };
    const team = { id: "team-1", creditBalance: 100 };

    setupSequentialSelects([site], [team]);

    let capturedTxInsertData: Record<string, unknown> | undefined;
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: unknown) => Promise<void>) => {
        const teamData = [{ creditBalance: 100 }];
        const whereResult = Object.assign(Promise.resolve(teamData), {
          for: vi.fn().mockResolvedValue(teamData),
        });
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnValue(whereResult),
          }),
          update: vi.fn().mockReturnValue(makeUpdateChain()),
          insert: vi.fn().mockImplementation(() => ({
            values: vi.fn().mockImplementation((data: Record<string, unknown>) => {
              if (data.type === "crawl_reserve") {
                capturedTxInsertData = data;
              }
              return Promise.resolve([]);
            }),
          })),
        };
        await fn(tx);
      }
    );

    const req = new NextRequest(
      new Request(
        `http://localhost/api/sites/${SITE_ID}/regenerate?token=${TOKEN}`,
        { method: "POST" }
      )
    );

    await POST(req, { params: Promise.resolve({ id: SITE_ID }) });

    // Credit transaction should use per-page pricing from config
    expect(capturedTxInsertData).toBeDefined();
    expect(capturedTxInsertData!.type).toBe("crawl_reserve");
    expect(capturedTxInsertData!.creditsChanged).toBeLessThan(0); // Debit
  });

  // ── Scenario 10: Security boundary — no findings in free response ──

  it("free-tier response body must NOT contain any findings strings from pillars", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");

    const scorecard = mockScorecard(5); // 5 pillars with unique findings
    const site = mockSite({
      teamId: null,
      accessToken: TOKEN,
      overallScore: scorecard.overallScore,
      pillars: scorecard.pillars,
    });

    setupSequentialSelects([site]);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;
    const responseJson = JSON.stringify(body);

    // Verify NO findings text appears anywhere in the response
    for (const pillar of scorecard.pillars) {
      expect(responseJson).not.toContain(pillar.findings);
    }

    // Verify NO recommendation text appears in the response
    // (recommendations field uses different text than pillar recommendations)
    const responseScorecard = body.geoScorecard as {
      pillars?: Array<Record<string, unknown>>;
    } | null;
    if (responseScorecard?.pillars) {
      for (const p of responseScorecard.pillars) {
        expect(p).not.toHaveProperty("findings");
        expect(p).not.toHaveProperty("recommendation");
      }
    }
  });

  // ── Scenario 11: Team table unavailable → defaults to free ──

  it("defaults to free tier when team table is unavailable (DB error)", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");

    const site = mockSite({
      teamId: "team-1",
      accessToken: TOKEN,
      generatedLlmsTxt: "# secret paid content",
    });

    // First select (site) succeeds, second select (team) fails
    let callCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return makeSelectChain([site]);
      return makeSelectChainWithError(new Error("teams table unavailable"));
    });

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;

    // Must NOT crash — default to free tier
    expect(res.status).toBe(200);
    expect(body.tier).toBe("free");
    expect(body.credits).toBe(0);

    // Paid content must NOT leak
    expect(body.generatedLlmsTxt).toBeNull();
    assertFreeGating(body);
  });

  // ── Scenario 12: Malformed scorecard JSONB ──

  it("handles malformed scorecard JSONB gracefully", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");

    // Scorecard with null pillars but non-null overallScore (partial data)
    const site = mockSite({
      teamId: null,
      accessToken: TOKEN,
      overallScore: 42,
      pillars: null,
    });

    setupSequentialSelects([site]);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;

    // Should NOT crash
    expect(res.status).toBe(200);

    // Should return overallScore if present, empty pillars array
    const scorecard = body.geoScorecard as Record<string, unknown> | null;
    if (scorecard) {
      expect(scorecard.overallScore).toBe(42);
      expect(scorecard.pillars).toEqual([]);
    }
  });

  // ── Scenario 13: Empty executive summary ──

  it("handles empty string executive summary without crashing", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");

    const site = mockSite({
      teamId: null,
      accessToken: TOKEN,
      executiveSummary: "",
    });

    setupSequentialSelects([site]);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    // Empty string should remain empty, not crash
    expect(body.executiveSummary).toBe("");
  });
});
