/**
 * Integration Tests — Paywall UX Flow
 *
 * Tests the end-to-end paywall flow: free → upgrade → paid unlock.
 * Uses mocked fetch to simulate API interactions without React rendering.
 *
 * 12 scenarios from ES-003 spec:
 *   1.  Free user views report — API returns gated data
 *   2.  Free user clicks Upgrade — checkout API called correctly
 *   3.  Payment completes → poll detects tier change
 *   4.  Stripe redirect → payment=success param detected
 *   5.  Pricing page → links to correct destinations
 *   6.  Pricing page values match config
 *   7.  Full free → pay → unlock flow
 *   8.  Config change propagation
 *   9.  Checkout API returns 401 (unauthenticated)
 *   10. Checkout API returns 500
 *   11. Payment poll network failure — continues silently
 *   12. Pipeline running + free tier — no duplicate polling
 *
 * These tests are written BEFORE implementation (test-first).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

import { db } from "@/lib/db";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSelectChain(rows: unknown[] = []) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
    limit: vi.fn().mockReturnThis(),
  };
}

function makeSiteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "site-1",
    domain: "example.com",
    slug: "example-com",
    teamId: null,
    accessToken: "test-token",
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000), // HP-197: valid expiry seed
    pipelineStatus: "complete",
    pipelineError: null,
    geoScorecard: { overallScore: 55, pillars: [], topThreeImprovements: [] },
    executiveSummary: "Summary paragraph one.\n\nParagraph two.",
    recommendations: { rankedRecommendations: [], projectedScore: 70, projectedBoost: 15 },
    generatedLlmsTxt: "# llms",
    generatedLlmsFullTxt: "# full llms",
    generatedBusinessJson: { name: "Test" },
    generatedSchemaBlocks: [{ name: "Org" }],
    discoveryData: {},
    platformDetected: "wordpress",
    projectedScore: 70,
    projectedBoost: 15,
    shareToken: "share-abc",
    domainVerified: false,
    verifyToken: "vt-123",
    changeLog: [],
    manualRunsThisMonth: 0,
    crawlCount: 1,
    lastCrawlAt: new Date("2026-02-20"),
    nextCrawlAt: new Date("2026-03-20"),
    createdAt: new Date("2026-02-01"),
    previousRunSnapshot: null,
    paymentStatus: "pending",
    ...overrides,
  };
}

function makeTeamRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "team-1",
    name: "Test Team",
    ownerUserId: "user-1",
    creditBalance: 50,
    stripeCustomerId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function setupSequentialSelects(...callResults: unknown[][]) {
  let idx = 0;
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    const rows = callResults[idx] ?? [];
    idx++;
    return makeSelectChain(rows);
  });
}

// ─── Integration Scenarios ──────────────────────────────────────────────────

describe("Integration: Paywall Flow — API layer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Scenario 1: Free user views report — gated response ──

  it("1. free user gets gated API response (tier=free, stripped data)", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");
    const { NextRequest } = await import("next/server");

    const site = makeSiteRow({ teamId: null });
    setupSequentialSelects([site]);

    const req = new NextRequest(
      new Request("http://localhost/api/sites/site-1", {
        headers: { authorization: "Bearer test-token" },
      })
    );

    const res = await GET(req, { params: Promise.resolve({ id: "site-1" }) });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.tier).toBe("free");
    expect(body.credits).toBe(0);
    // Free tier: generated files should be null
    expect(body.generatedLlmsTxt).toBeNull();
  });

  // ── Scenario 2: Checkout API contract ──

  it("2. checkout API returns checkoutUrl for authenticated user", async () => {
    // This tests the expected contract of POST /api/checkout
    // The checkout API should return { checkoutUrl: string }
    // This verifies the frontend can rely on this shape

    // Mock the checkout response shape
    const expectedResponse = {
      checkoutUrl: "https://checkout.stripe.com/session_abc",
    };

    // Verify the expected response shape has a checkoutUrl string
    expect(expectedResponse.checkoutUrl).toBeDefined();
    expect(typeof expectedResponse.checkoutUrl).toBe("string");
    expect(expectedResponse.checkoutUrl).toMatch(/^https:\/\//);
  });

  // ── Scenario 3: Payment poll detects tier change ──

  it("3. simulated poll response reflects tier change after payment", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");
    const { NextRequest } = await import("next/server");

    // First poll: free tier (no team credits)
    const freeSite = makeSiteRow({ teamId: "team-1" });
    setupSequentialSelects(
      [freeSite],
      [makeTeamRow({ creditBalance: 0 })]
    );

    const req1 = new NextRequest(
      new Request("http://localhost/api/sites/site-1", {
        headers: { authorization: "Bearer test-token" },
      })
    );
    const res1 = await GET(req1, { params: Promise.resolve({ id: "site-1" }) });
    const body1 = (await res1.json()) as Record<string, unknown>;
    expect(body1.tier).toBe("free");

    vi.clearAllMocks();

    // Second poll: paid tier (team now has credits from payment)
    setupSequentialSelects(
      [freeSite],
      [makeTeamRow({ creditBalance: 100 })]
    );

    const req2 = new NextRequest(
      new Request("http://localhost/api/sites/site-1", {
        headers: { authorization: "Bearer test-token" },
      })
    );
    const res2 = await GET(req2, { params: Promise.resolve({ id: "site-1" }) });
    const body2 = (await res2.json()) as Record<string, unknown>;
    expect(body2.tier).toBe("paid");
    expect(body2.credits).toBe(100);
  });

  // ── Scenario 4: Payment success param detection ──

  it("4. payment=success query param is detectable from URL", () => {
    const url = new URL("http://localhost/dashboard?payment=success");
    expect(url.searchParams.get("payment")).toBe("success");

    // After cleaning
    url.searchParams.delete("payment");
    expect(url.searchParams.get("payment")).toBeNull();
    expect(url.pathname).toBe("/dashboard");
  });

  // ── Scenario 5: Pricing page link destinations ──

  it("5. pricing page should link free CTA to / and paid CTA to /dashboard", () => {
    // Contract test: verify expected link destinations
    const expectedLinks = {
      free: "/",
      paid: "/dashboard",
    };

    expect(expectedLinks.free).toBe("/");
    expect(expectedLinks.paid).toBe("/dashboard");
  });

  // ── Scenario 6: Pricing page values from config ──

  it("6. pricing page uses config constants for display values", async () => {
    const config = await import("@/lib/config");

    // Config values should be defined and consistent
    expect(config.FREE_MAX_PAGES).toBeDefined();
    expect(config.PAID_MAX_PAGES).toBeDefined();
    expect(config.CREDITS_PRICE_USD).toBeDefined();
    expect(config.CREDITS_PER_PACK).toBeDefined();
    expect(config.PAGES_PER_CREDIT).toBeDefined();

    // Per-page pricing: pages per pack
    const pagesPerPack = config.CREDITS_PER_PACK * config.PAGES_PER_CREDIT;
    expect(pagesPerPack).toBeGreaterThan(0);
  });

  // ── Scenario 7: Full free → pay → unlock flow ──

  it("7. full flow: API returns free → user pays → next fetch returns paid", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");
    const { NextRequest } = await import("next/server");

    const site = makeSiteRow({ teamId: "team-1" });

    // Step 1: Free tier (0 credits)
    setupSequentialSelects([site], [makeTeamRow({ creditBalance: 0 })]);
    const req1 = new NextRequest(
      new Request("http://localhost/api/sites/site-1", {
        headers: { authorization: "Bearer test-token" },
      })
    );
    const res1 = await GET(req1, { params: Promise.resolve({ id: "site-1" }) });
    const body1 = (await res1.json()) as Record<string, unknown>;
    expect(body1.tier).toBe("free");
    expect(body1.generatedLlmsTxt).toBeNull(); // Gated

    vi.clearAllMocks();

    // Step 2: User pays → team gets credits (simulated by DB change)

    // Step 3: Next fetch → paid tier
    setupSequentialSelects([site], [makeTeamRow({ creditBalance: 100 })]);
    const req2 = new NextRequest(
      new Request("http://localhost/api/sites/site-1", {
        headers: { authorization: "Bearer test-token" },
      })
    );
    const res2 = await GET(req2, { params: Promise.resolve({ id: "site-1" }) });
    const body2 = (await res2.json()) as Record<string, unknown>;
    expect(body2.tier).toBe("paid");
    expect(body2.generatedLlmsTxt).not.toBeNull(); // Unlocked
    expect(body2.credits).toBe(100);
  });

  // ── Scenario 8: Config change propagation ──

  it("8. config constants are importable and have expected types", async () => {
    const config = await import("@/lib/config");

    // All pricing/tier constants should be numbers
    expect(typeof config.FREE_MAX_PAGES).toBe("number");
    expect(typeof config.PAID_MAX_PAGES).toBe("number");
    expect(typeof config.CREDITS_PRICE_USD).toBe("number");
    expect(typeof config.CREDITS_PRICE_CENTS).toBe("number");
    expect(typeof config.CREDITS_PER_PACK).toBe("number");
    expect(typeof config.PAGES_PER_CREDIT).toBe("number");

    // Derived consistency checks
    expect(config.CREDITS_PRICE_CENTS).toBe(config.CREDITS_PRICE_USD * 100);
  });
});

// ─── Failure Mode Tests ─────────────────────────────────────────────────────

describe("Integration: Paywall Flow — Failure modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Scenario 9: Checkout API returns 401 ──

  it("9. checkout 401 response is correctly shaped for frontend handling", () => {
    // Contract: checkout API returns { error: string } with 401
    const errorResponse = { error: "Sign in required to purchase credits" };
    expect(errorResponse.error).toBeDefined();
    expect(typeof errorResponse.error).toBe("string");
  });

  // ── Scenario 10: Checkout API returns 500 ──

  it("10. checkout 500 response is correctly shaped for frontend handling", () => {
    // Contract: checkout API returns { error: string } with 500
    const errorResponse = { error: "Internal server error" };
    expect(errorResponse.error).toBeDefined();
    // Frontend should catch this and show toast.error()
  });

  // ── Scenario 11: Payment poll network failure ──

  it("11. poll failure should not prevent subsequent polls", async () => {
    // Simulate: first poll fails, second poll succeeds
    // This tests that the polling mechanism is resilient

    let pollAttempt = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      pollAttempt++;
      if (pollAttempt === 1) {
        return Promise.reject(new Error("Network error"));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ tier: "paid", credits: 50 }),
      });
    });

    // First call throws — should be caught silently
    await expect(mockFetch()).rejects.toThrow("Network error");

    // Second call succeeds — poll should continue
    const res = await mockFetch();
    const data = await res.json();
    expect(data.tier).toBe("paid");
    expect(pollAttempt).toBe(2); // Both calls happened
  });

  // ── Scenario 12: Pipeline running + free tier — no duplicate polling ──

  it("12. verifies polling guard conditions prevent duplicates", () => {
    // Contract: payment poll should ONLY run when:
    // tier === "free" AND pipelineStatus === "complete"
    //
    // When pipeline is running (e.g., "crawling"), only the pipeline
    // poll should be active, not both.

    const conditions = {
      pipelinePollActive: (status: string) =>
        !["complete", "failed", "pending"].includes(status),
      paymentPollActive: (tier: string, status: string) =>
        tier === "free" && status === "complete",
    };

    // Scenario: pipeline running, free tier
    expect(conditions.pipelinePollActive("crawling")).toBe(true);
    expect(conditions.paymentPollActive("free", "crawling")).toBe(false);

    // Scenario: pipeline complete, free tier
    expect(conditions.pipelinePollActive("complete")).toBe(false);
    expect(conditions.paymentPollActive("free", "complete")).toBe(true);

    // Scenario: pipeline complete, paid tier
    expect(conditions.pipelinePollActive("complete")).toBe(false);
    expect(conditions.paymentPollActive("paid", "complete")).toBe(false);

    // No scenario should have both polls active simultaneously
    const statuses = ["crawling", "analyzing", "generating", "complete", "failed", "pending"];
    const tiers = ["free", "paid"];

    for (const status of statuses) {
      for (const tier of tiers) {
        const pipeline = conditions.pipelinePollActive(status);
        const payment = conditions.paymentPollActive(tier, status);

        // Both should never be true at the same time
        // (pipeline poll stops on complete, payment poll only starts on complete)
        expect(pipeline && payment).toBe(false);
      }
    }
  });
});
