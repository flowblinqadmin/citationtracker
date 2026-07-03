/**
 * Tasks B1, B3, B4 — tests for handleAuditPurchaseFinalize additions.
 *
 * Task #13 (follow-up): Rewrites circular B1 + B3 tests to use the real
 * handleAuditPurchaseFinalize call path via POST to the stage route handler.
 * Mirrors the pattern established in __tests__/audit-purchase-bravo-fixups.test.ts.
 *
 * B1: PDF buffer render before delivery email
 *   - renderAuditPdfBuffer throws → markFailed fires (Stripe refund + failure email)
 *   - delivery email NOT sent on failure
 *
 * B3: Magic-link expiry handling + scrub-on-deliver
 *   - Expired link → generateLink IS called; fresh link reaches delivery email
 *   - Non-expired link → generateLink NOT called; stored link used
 *   - Post-deliver scrub: magicLink=null DB update issued AFTER email send
 *
 * B4: topPillars derived from scorecard (unchanged — no circular pattern here)
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Environment setup ────────────────────────────────────────────────────────

vi.hoisted(() => {
  process.env.CRON_SECRET = "test-cron-secret-b13";
  process.env.STRIPE_SECRET_KEY = "sk_test_b13";
  process.env.NEXT_PUBLIC_APP_URL = "https://test.geo.flowblinq.com";
});

// ─── Hoisted mock references ──────────────────────────────────────────────────

const {
  mockRenderAuditPdfBuffer,
  mockSendAuditPurchaseDeliveryEmail,
  mockSendAuditPurchaseFailedEmail,
  mockSendInternalPaymentAlert,
  mockStripeRefundsCreate,
  mockEnqueueStage,
  mockGenerateLink,
} = vi.hoisted(() => {
  const mockRenderAuditPdfBuffer = vi.fn();
  const mockSendAuditPurchaseDeliveryEmail = vi.fn().mockResolvedValue(undefined);
  const mockSendAuditPurchaseFailedEmail = vi.fn().mockResolvedValue(undefined);
  const mockSendInternalPaymentAlert = vi.fn().mockResolvedValue(undefined);
  const mockStripeRefundsCreate = vi.fn().mockResolvedValue({ id: "re_b13_test" });
  const mockEnqueueStage = vi.fn().mockResolvedValue(undefined);
  const mockGenerateLink = vi.fn().mockResolvedValue({
    data: { properties: { action_link: "https://magic.link/fresh_b13" } },
    error: null,
  });

  return {
    mockRenderAuditPdfBuffer,
    mockSendAuditPurchaseDeliveryEmail,
    mockSendAuditPurchaseFailedEmail,
    mockSendInternalPaymentAlert,
    mockStripeRefundsCreate,
    mockEnqueueStage,
    mockGenerateLink,
  };
});

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/lib/services/audit-pdf-handler", () => ({
  renderAuditPdfBuffer: (...args: unknown[]) => mockRenderAuditPdfBuffer(...args),
  PdfAuthError: class PdfAuthError extends Error {},
}));

vi.mock("@/lib/email", () => ({
  sendCompletionEmail: vi.fn().mockResolvedValue(undefined),
  sendPipelineFailedEmail: vi.fn().mockResolvedValue(undefined),
  sendAuditPurchaseDeliveryEmail: (...args: unknown[]) => mockSendAuditPurchaseDeliveryEmail(...args),
  sendAuditPurchaseFailedEmail: (...args: unknown[]) => mockSendAuditPurchaseFailedEmail(...args),
  sendInternalPaymentAlert: (...args: unknown[]) => mockSendInternalPaymentAlert(...args),
  sendAuditPurchaseRefundedEmail: vi.fn().mockResolvedValue(undefined),
  sendAuditPurchaseConfirmationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock("@/lib/qstash", () => ({ enqueueStage: mockEnqueueStage }));
vi.mock("nanoid", () => ({ nanoid: vi.fn().mockReturnValue("mock-nanoid-b13") }));
vi.mock("@/lib/crawl-mode", () => ({ getCrawlMode: vi.fn().mockResolvedValue("standard") }));

vi.mock("@mendable/firecrawl-js", () => ({
  FirecrawlAppV1: vi.fn().mockImplementation(function () {
    return { asyncBatchScrapeUrls: vi.fn(), checkBatchScrapeStatus: vi.fn() };
  }),
}));

vi.mock("@upstash/qstash", () => ({
  Receiver: vi.fn().mockImplementation(function () {
    return { verify: vi.fn().mockResolvedValue(true) };
  }),
}));

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      refunds: { create: mockStripeRefundsCreate },
      charges: { retrieve: vi.fn() },
      webhooks: { constructEvent: vi.fn() },
    };
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: vi.fn().mockReturnValue({
    auth: {
      admin: {
        generateLink: (...args: unknown[]) => mockGenerateLink(...args),
        createUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-b13" } }, error: null }),
        listUsers: vi.fn().mockResolvedValue({ data: { users: [] } }),
      },
    },
  }),
}));

vi.mock("@/lib/services/provision-team", () => ({
  ensureTeamForUser: vi.fn().mockResolvedValue({ teamId: "team-b13" }),
}));

vi.mock("@/lib/config", () => ({
  CREDITS_PER_PACK: 10,
  FREE_MAX_PAGES: 20,
  CRAWL_MAX_CHUNKS: 10,
  POLL_CHUNK_INTERVAL_S: 15,
  POLL_CHUNK_CIRCUIT_BREAKER_MS: 20 * 60 * 1000,
  BULK_CHUNKING_THRESHOLD: 10,
  SIGNUP_BONUS_CREDITS: 20,
  SUBSCRIPTION_TIERS: {},
  STRIPE_PRICE_IDS: { monthly: {}, quarterly: {}, annual: {} },
  bulkCreditsRequired: vi.fn().mockReturnValue(0),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_c: unknown, v: unknown) => ({ _tag: "eq", v })),
  and: vi.fn((...args: unknown[]) => ({ _tag: "and", args })),
  or: vi.fn((...args: unknown[]) => ({ _tag: "or", args })),
  isNull: vi.fn((c: unknown) => ({ _tag: "isNull", c })),
  sql: vi.fn().mockReturnValue({ _tag: "sql" }),
}));

vi.mock("@/lib/db/schema", () => ({
  teams: { id: "id", creditBalance: "credit_balance" },
  teamMembers: { id: "id", teamId: "team_id", userId: "user_id" },
  creditTransactions: { id: "id" },
  geoSites: {
    id: "id",
    domain: "domain",
    pipelineStatus: "pipeline_status",
    pipelineError: "pipeline_error",
    creditsReserved: "credits_reserved",
    crawlJobIds: "crawl_job_ids",
    crawlChunksDone: "crawl_chunks_done",
    crawlChunksTotal: "crawl_chunks_total",
    crawlChunkResults: "crawl_chunk_results",
    geoScorecard: "geo_scorecard",
    discoveredCompetitors: "discovered_competitors",
    userCompetitors: "user_competitors",
    teamId: "team_id",
  },
  geoSiteView: {
    siteId: "site_id",
    pipelineStatus: "pipeline_status",
    domain: "domain",
    overallScore: "overall_score",
    pipelineError: "pipeline_error",
  },
  auditPurchases: {
    id: "id",
    stripeSessionId: "stripe_session_id",
    stripePaymentIntentId: "stripe_payment_intent_id",
    stripeChargeId: "stripe_charge_id",
    customerEmail: "customer_email",
    domain: "domain",
    siteId: "site_id",
    purchaseToken: "purchase_token",
    status: "status",
    magicLink: "magic_link",
    magicLinkExpiresAt: "magic_link_expires_at",
    pdfDeliveredAt: "pdf_delivered_at",
    userId: "user_id",
    teamId: "team_id",
    amountCents: "amount_cents",
  },
  firecrawlJobs: { id: "id", siteId: "site_id", status: "status", result: "result", createdAt: "created_at" },
  citationCheckScores: { id: "id", siteId: "site_id", checkId: "check_id" },
  rateLimits: { key: "key", count: "count", resetAt: "reset_at" },
}));

vi.mock("@/lib/services/competitive-intel", () => ({ gatherCompetitiveIntel: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/services/geo-analyzer", () => ({ analyzeGeoGaps: vi.fn().mockResolvedValue({ overallScore: 80 }) }));
vi.mock("@/lib/services/auto-discover-brand-pages", () => ({ autoDiscoverBrandPages: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/services/content-generator", () => ({
  generateLlmsTxt: vi.fn(),
  generateBusinessJson: vi.fn(),
  generateSitewideSchemaBlocks: vi.fn(),
  generatePerPageFaqBlocks: vi.fn(),
  generateArticleBlocks: vi.fn(),
  generateRobotsTxtBlock: vi.fn(),
  sanitizeLlmsTxt: vi.fn((s: string) => s),
  sanitizeBusinessJson: vi.fn((s: unknown) => s),
  RetryValidationExhausted: class RetryValidationExhausted extends Error {},
}));
vi.mock("@/lib/services/assembler", () => ({
  assembleResults: vi.fn().mockResolvedValue({}),
  checkGeneratedContent: vi.fn().mockReturnValue(true),
  checkExecutiveSummary: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/services/per-page-analyzer", () => ({ extractPerPageVulnerabilities: vi.fn().mockReturnValue([]) }));
vi.mock("@/lib/services/page-fix-generator", () => ({ generatePerPageFixes: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/services/implementation-tracker", () => ({ computeImplementationTracking: vi.fn().mockReturnValue({}) }));
vi.mock("@/lib/services/tree-extractor", () => ({ extractTrees: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/services/crawl-prioritizer", () => ({
  detectArchitecture: vi.fn().mockReturnValue("standard"),
  prioritizeUrls: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/services/content-strategy-scorer", () => ({ aggregateStrategyReport: vi.fn().mockReturnValue({}) }));
vi.mock("@/lib/services/site-view-sync", () => ({
  syncSiteView: vi.fn().mockResolvedValue(undefined),
  syncSiteViewStatus: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/services/geo-crawler", () => ({
  discoverSite: vi.fn().mockRejectedValue(new Error("should-not-be-called-in-finalize-tests")),
  computeChunks: vi.fn().mockReturnValue({ numChunks: 1, chunkSize: 10 }),
  mapDocumentToPage: vi.fn(),
  scoreCrawlQuality: vi.fn(),
  classifyPageType: vi.fn(),
  detectFlowblinqAssets: vi.fn(),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────────

import { db } from "@/lib/db";
import { POST } from "@/app/api/pipeline/stage/route";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(payload: object): NextRequest {
  return new NextRequest("https://test.geo.flowblinq.com/api/pipeline/stage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CRON_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

/**
 * Build a select chain that is both thenable and has all fluent query-builder
 * methods. Mirrors the pattern from audit-purchase-bravo-fixups.test.ts.
 */
function makeSelectChain(rows: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  chain.catch = (reject: (e: unknown) => unknown) => Promise.resolve(rows).catch(reject);
  chain.finally = (fn: () => void) => Promise.resolve(rows).finally(fn);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockReturnValue(chain);
  return chain;
}

function makeUpdateChain(returningRows: unknown[] = [{ id: "default-id" }]) {
  const whereResult = Object.assign(Promise.resolve(returningRows), {
    returning: vi.fn().mockResolvedValue(returningRows),
  });
  const setResult = { where: vi.fn().mockReturnValue(whereResult) };
  return { set: vi.fn().mockReturnValue(setResult) };
}

function makeInsertChain() {
  return { values: vi.fn().mockResolvedValue([]) };
}

/** Base purchase row used in finalize tests */
function makePurchaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "purchase-b13-1",
    siteId: "site-b13-1",
    customerEmail: "buyer@b13.com",
    domain: "b13.com",
    status: "paid",
    pdfDeliveredAt: null,
    magicLink: "https://magic.link/existing-b13",
    magicLinkExpiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h from now — valid
    purchaseToken: "tok-b13",
    stripePaymentIntentId: "pi_b13_123",
    amountCents: 1000,
    userId: "user-b13",
    teamId: "team-b13",
    ...overrides,
  };
}

function makeSiteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "site-b13-1",
    domain: "b13.com",
    teamId: "team-b13-1",
    pipelineStatus: "complete",
    creditsReserved: null,
    geoScorecard: null,
    discoveredCompetitors: ["existing-comp"],
    userCompetitors: [],
    ownerEmail: "owner@b13.com",
    ...overrides,
  };
}

/**
 * Collect all first-args passed to .set() across all db.update() calls.
 */
function getAllUpdateSetArgs(): Record<string, unknown>[] {
  const updateMock = db.update as ReturnType<typeof vi.fn>;
  const args: Record<string, unknown>[] = [];
  for (const r of updateMock.mock.results as { value: ReturnType<typeof makeUpdateChain> }[]) {
    const chain = r.value;
    if (!chain?.set?.mock?.calls) continue;
    for (const call of chain.set.mock.calls as [Record<string, unknown>][]) {
      if (call[0]) args.push(call[0]);
    }
  }
  return args;
}

// ═══════════════════════════════════════════════════════════════════════════════
// B1 — PDF render failure routes through markFailed (real handler invocation)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Task B1 — PDF render failure routes through markFailed (real handler)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // PDF render always throws in these tests
    mockRenderAuditPdfBuffer.mockRejectedValue(new Error("Puppeteer timeout b13"));

    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeUpdateChain([{ id: "purchase-b13-1" }]),
    );
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());

    // DB select sequence for audit-purchase-finalize:
    //   Call 1: auditPurchases fetch
    //   Call 2: geoSites discoveredCompetitors (populated → skip discovery)
    //   Call 3: citationCheckScores (has row → skip citation)
    //   Call 4: geoSites geoScorecard fetch
    //   [PDF render throws → markFailed(siteId) called]
    //   Call 5: markFailed → geoSites fetch (for creditsReserved / teamId)
    //   Call 6: markFailed → auditPurchases fetch (for Stripe refund path)
    let n = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      n++;
      if (n === 1) return makeSelectChain([makePurchaseRow()]);
      if (n === 2) return makeSelectChain([makeSiteRow({ discoveredCompetitors: ["comp1"] })]);
      if (n === 3) return makeSelectChain([{ checkId: "existing-check" }]);
      if (n === 4) return makeSelectChain([makeSiteRow({ geoScorecard: { overallScore: 55, pillars: [] } })]);
      if (n === 5) return makeSelectChain([makeSiteRow()]);     // markFailed geoSites
      if (n === 6) return makeSelectChain([makePurchaseRow()]); // markFailed auditPurchases
      return makeSelectChain([]);
    });
  });

  it("geoSites.pipelineStatus is set to 'failed' with PDF error message", async () => {
    const res = await POST(makeRequest({
      siteId: "site-b13-1",
      domain: "b13.com",
      stage: "audit-purchase-finalize",
    }));

    expect(res.status).toBe(200);

    const allSetArgs = getAllUpdateSetArgs();
    const failedWrite = allSetArgs.find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeDefined();
    expect(String(failedWrite?.pipelineError)).toMatch(/Puppeteer timeout b13/i);
  });

  it("Stripe refund is issued with correct payment_intent when PDF render throws", async () => {
    await POST(makeRequest({
      siteId: "site-b13-1",
      domain: "b13.com",
      stage: "audit-purchase-finalize",
    }));

    expect(mockStripeRefundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: "pi_b13_123",
        amount: 1000,
      }),
    );
  });

  it("customer failure email is sent when PDF render throws", async () => {
    await POST(makeRequest({
      siteId: "site-b13-1",
      domain: "b13.com",
      stage: "audit-purchase-finalize",
    }));

    expect(mockSendAuditPurchaseFailedEmail).toHaveBeenCalled();
  });

  it("delivery email is NOT sent when PDF render throws", async () => {
    await POST(makeRequest({
      siteId: "site-b13-1",
      domain: "b13.com",
      stage: "audit-purchase-finalize",
    }));

    expect(mockSendAuditPurchaseDeliveryEmail).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B3 — Magic-link expiry handling + scrub-on-deliver (real handler invocation)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Task B3 — Magic-link expiry + scrub (real handler invocations)", () => {
  function setupSelectsForDelivery(opts: {
    purchaseOverrides?: Record<string, unknown>;
    confirmPdfDeliveredAt?: Date | null;
  } = {}) {
    const {
      purchaseOverrides = {},
      confirmPdfDeliveredAt = new Date(),
    } = opts;

    let n = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      n++;
      if (n === 1) return makeSelectChain([makePurchaseRow(purchaseOverrides)]);
      if (n === 2) return makeSelectChain([makeSiteRow({ discoveredCompetitors: ["comp1"] })]);
      if (n === 3) return makeSelectChain([{ checkId: "check-1" }]);
      if (n === 4) return makeSelectChain([makeSiteRow({ geoScorecard: { overallScore: 70, pillars: [] } })]);
      // Call 5: CAS confirm select
      return makeSelectChain([{ pdfDeliveredAt: confirmPdfDeliveredAt }]);
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();

    // PDF renders successfully by default
    mockRenderAuditPdfBuffer.mockResolvedValue({
      buffer: Buffer.from("fake-pdf-b13"),
      filename: "audit-b13.pdf",
      domain: "b13.com",
    });
    mockSendAuditPurchaseDeliveryEmail.mockResolvedValue(undefined);

    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeUpdateChain([{ id: "purchase-b13-1" }]),
    );
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  it("non-expired link: generateLink NOT called, stored link used in delivery email", async () => {
    setupSelectsForDelivery({
      purchaseOverrides: {
        magicLink: "https://magic.link/existing-b13",
        magicLinkExpiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min from now
      },
    });

    const res = await POST(makeRequest({
      siteId: "site-b13-1",
      domain: "b13.com",
      stage: "audit-purchase-finalize",
    }));

    expect(res.status).toBe(200);

    // generateLink must NOT have been called
    expect(mockGenerateLink).not.toHaveBeenCalled();

    // Delivery email must have been called with the existing stored link
    expect(mockSendAuditPurchaseDeliveryEmail).toHaveBeenCalledTimes(1);
    const callArgs = mockSendAuditPurchaseDeliveryEmail.mock.calls[0] as [
      string,
      string,
      object,
      { magicLink?: string },
    ];
    expect(callArgs[3]).toMatchObject({
      magicLink: "https://magic.link/existing-b13",
    });
  });

  it("expired link: generateLink IS called and fresh link reaches delivery email", async () => {
    const freshLink = "https://magic.link/fresh_b13";
    mockGenerateLink.mockResolvedValueOnce({
      data: { properties: { action_link: freshLink } },
      error: null,
    });

    setupSelectsForDelivery({
      purchaseOverrides: {
        magicLink: "https://magic.link/stale-b13",
        magicLinkExpiresAt: new Date(Date.now() - 60 * 1000), // 60s ago — expired
      },
    });

    const res = await POST(makeRequest({
      siteId: "site-b13-1",
      domain: "b13.com",
      stage: "audit-purchase-finalize",
    }));

    expect(res.status).toBe(200);

    // generateLink MUST have been called
    expect(mockGenerateLink).toHaveBeenCalledWith(
      expect.objectContaining({ type: "magiclink", email: "buyer@b13.com" }),
    );

    // Delivery email must have been called with the fresh link
    expect(mockSendAuditPurchaseDeliveryEmail).toHaveBeenCalledTimes(1);
    const callArgs = mockSendAuditPurchaseDeliveryEmail.mock.calls[0] as [
      string,
      string,
      object,
      { magicLink?: string },
    ];
    expect(callArgs[3]).toMatchObject({ magicLink: freshLink });
  });

  it("scrub: magicLink=null DB update is issued AFTER delivery email sends successfully", async () => {
    setupSelectsForDelivery();

    const res = await POST(makeRequest({
      siteId: "site-b13-1",
      domain: "b13.com",
      stage: "audit-purchase-finalize",
    }));

    expect(res.status).toBe(200);

    // Delivery email must have been sent
    expect(mockSendAuditPurchaseDeliveryEmail).toHaveBeenCalledTimes(1);

    // A DB update with magicLink=null must have been issued
    const allSetArgs = getAllUpdateSetArgs();
    const scrubWrite = allSetArgs.find((a) => a.magicLink === null);
    expect(scrubWrite).toBeDefined();
    expect(scrubWrite?.magicLinkExpiresAt).toBeNull();

    // The scrub update must come AFTER the pdfDeliveredAt write.
    // Find index of each in mockImplementation call order.
    const updateMock = db.update as ReturnType<typeof vi.fn>;
    const setArgsByOrder: Record<string, unknown>[] = [];
    for (const r of updateMock.mock.results as { value: ReturnType<typeof makeUpdateChain> }[]) {
      const chain = r.value;
      if (!chain?.set?.mock?.calls) continue;
      for (const call of chain.set.mock.calls as [Record<string, unknown>][]) {
        if (call[0]) setArgsByOrder.push(call[0]);
      }
    }
    const deliveryIdx = setArgsByOrder.findIndex((a) => "pdfDeliveredAt" in a);
    const scrubIdx = setArgsByOrder.findIndex((a) => a.magicLink === null);
    expect(deliveryIdx).toBeGreaterThanOrEqual(0);
    expect(scrubIdx).toBeGreaterThan(deliveryIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B4 — topPillars derived from scorecard for install CTA copy
// ═══════════════════════════════════════════════════════════════════════════════

describe("Task B4 — topPillars derived from scorecard for install CTA copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives top-3 lowest-scoring pillar names from scorecard", () => {
    const scorecard = {
      overallScore: 45,
      pillars: [
        { pillarName: "Structured Data", score: 20 },
        { pillarName: "Metadata Freshness", score: 30 },
        { pillarName: "Semantic HTML", score: 40 },
        { pillarName: "Content Freshness", score: 60 },
        { pillarName: "Internal Linking", score: 75 },
      ],
    };

    const pillars = Array.isArray(scorecard.pillars) ? scorecard.pillars : [];
    const topPillars = pillars
      .filter((p) => typeof p.score === "number" && typeof p.pillarName === "string")
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map((p) => p.pillarName);

    expect(topPillars).toEqual(["Structured Data", "Metadata Freshness", "Semantic HTML"]);
    expect(topPillars).toHaveLength(3);
  });

  it("returns empty array when scorecard has no pillars", () => {
    const scorecard = { overallScore: 0, pillars: [] };

    const pillars = Array.isArray(scorecard.pillars) ? scorecard.pillars : [];
    const topPillars = pillars
      .filter((p) => typeof p.score === "number" && typeof p.pillarName === "string")
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map((p) => p.pillarName);

    expect(topPillars).toEqual([]);
  });

  it("passes topPillars to delivery email options (real handler)", async () => {
    // Set up for a successful delivery with a scorecard having 5 pillars
    let n = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      n++;
      if (n === 1) return makeSelectChain([makePurchaseRow()]);
      if (n === 2) return makeSelectChain([{ discoveredCompetitors: ["comp1"], userCompetitors: [] }]);
      if (n === 3) return makeSelectChain([{ checkId: "check-1" }]);
      if (n === 4) return makeSelectChain([{
        geoScorecard: {
          overallScore: 45,
          pillars: [
            { pillarName: "Structured Data", score: 20 },
            { pillarName: "Metadata Freshness", score: 30 },
            { pillarName: "Semantic HTML", score: 40 },
            { pillarName: "Content Freshness", score: 60 },
          ],
        },
      }]);
      // CAS confirm
      return makeSelectChain([{ pdfDeliveredAt: new Date() }]);
    });

    mockRenderAuditPdfBuffer.mockResolvedValue({
      buffer: Buffer.from("pdf-b4"),
      filename: "audit-b4.pdf",
      domain: "b13.com",
    });
    mockSendAuditPurchaseDeliveryEmail.mockResolvedValue(undefined);
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeUpdateChain([{ id: "purchase-b13-1" }]),
    );
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());

    const res = await POST(makeRequest({
      siteId: "site-b13-1",
      domain: "b13.com",
      stage: "audit-purchase-finalize",
    }));

    expect(res.status).toBe(200);
    expect(mockSendAuditPurchaseDeliveryEmail).toHaveBeenCalledTimes(1);

    const callArgs = mockSendAuditPurchaseDeliveryEmail.mock.calls[0] as [
      string,
      string,
      object,
      { topPillars?: string[] },
    ];
    expect(callArgs[3]).toHaveProperty("topPillars");
    expect(callArgs[3].topPillars).toEqual(["Structured Data", "Metadata Freshness", "Semantic HTML"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fix #5 — purchaseToken sent via Authorization header, NOT query string
// ═══════════════════════════════════════════════════════════════════════════════

describe("Fix #5 — internal finalize calls use Authorization header for purchaseToken", () => {
  let capturedFetchCalls: { url: string; init?: RequestInit }[] = [];
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedFetchCalls = [];
    originalFetch = global.fetch;

    // Intercept internal fetch calls
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      capturedFetchCalls.push({ url, init });
      // Return a mock SSE-style response (empty body)
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof global.fetch;

    mockRenderAuditPdfBuffer.mockResolvedValue({
      buffer: Buffer.from("pdf-fix5"),
      filename: "audit-fix5.pdf",
      domain: "b13.com",
    });
    mockSendAuditPurchaseDeliveryEmail.mockResolvedValue(undefined);

    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeUpdateChain([{ id: "purchase-b13-1" }]),
    );
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("passes purchaseToken in Authorization header to competitor-discovery, not as query param", async () => {
    // Need discoveredCompetitors=[] so the handler calls competitor-discovery
    let n = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      n++;
      if (n === 1) return makeSelectChain([makePurchaseRow({ purchaseToken: "tok-fix5-secret" })]);
      if (n === 2) return makeSelectChain([makeSiteRow({ discoveredCompetitors: [], userCompetitors: [] })]);
      if (n === 3) return makeSelectChain([{ checkId: "check-fix5" }]);
      if (n === 4) return makeSelectChain([makeSiteRow({ geoScorecard: { overallScore: 80, pillars: [] } })]);
      return makeSelectChain([{ pdfDeliveredAt: new Date() }]);
    });

    await POST(makeRequest({
      siteId: "site-b13-1",
      domain: "b13.com",
      stage: "audit-purchase-finalize",
    }));

    const discoveryCall = capturedFetchCalls.find((c) => c.url.includes("competitor-discovery"));
    expect(discoveryCall).toBeDefined();

    // Must NOT have purchaseToken in the URL
    expect(discoveryCall!.url).not.toContain("purchaseToken");

    // Must have X-Purchase-Token header (not Authorization: Bearer, which is the user accessToken header)
    const purchaseTokenHeader = (discoveryCall!.init?.headers as Record<string, string>)?.["X-Purchase-Token"] ?? "";
    expect(purchaseTokenHeader).toBe("tok-fix5-secret");
  });

  it("passes purchaseToken in Authorization header to citation-check, not as query param", async () => {
    // discoveredCompetitors populated to skip competitor-discovery;
    // citationCheckScores=[] so citation-check IS called
    let n = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      n++;
      if (n === 1) return makeSelectChain([makePurchaseRow({ purchaseToken: "tok-fix5-cite" })]);
      if (n === 2) return makeSelectChain([makeSiteRow({ discoveredCompetitors: ["comp1"], userCompetitors: [] })]);
      if (n === 3) return makeSelectChain([]); // no existing citation scores → calls citation-check
      if (n === 4) return makeSelectChain([makeSiteRow({ geoScorecard: { overallScore: 80, pillars: [] } })]);
      return makeSelectChain([{ pdfDeliveredAt: new Date() }]);
    });

    await POST(makeRequest({
      siteId: "site-b13-1",
      domain: "b13.com",
      stage: "audit-purchase-finalize",
    }));

    const citationCall = capturedFetchCalls.find((c) => c.url.includes("citation-check"));
    expect(citationCall).toBeDefined();

    // Must NOT have purchaseToken in the URL
    expect(citationCall!.url).not.toContain("purchaseToken");

    // Must have X-Purchase-Token header (not Authorization: Bearer, which is the user accessToken header)
    const purchaseTokenHeader = (citationCall!.init?.headers as Record<string, string>)?.["X-Purchase-Token"] ?? "";
    expect(purchaseTokenHeader).toBe("tok-fix5-cite");
  });
});
