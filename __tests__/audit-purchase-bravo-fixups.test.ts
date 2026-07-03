/**
 * Tests for Bravo fix-up items verified by the governor.
 *
 * Blocker B1 — PDF-render failure must route through markFailed (issue Stripe refund)
 * Blocker B2 — scrub magicLink AFTER pdfDeliveredAt + email delivery (not before)
 * Follow-up #3 — sendAuditPurchaseDeliveryEmail uses distinct siteUrl for secondary link
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Environment setup ────────────────────────────────────────────────────────

vi.hoisted(() => {
  process.env.CRON_SECRET = "test-cron-secret-bravo";
  process.env.STRIPE_SECRET_KEY = "sk_test_bravo";
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
  const mockStripeRefundsCreate = vi.fn().mockResolvedValue({ id: "re_bravo_test" });
  const mockEnqueueStage = vi.fn().mockResolvedValue(undefined);
  const mockGenerateLink = vi.fn().mockResolvedValue({
    data: { properties: { action_link: "https://magic.link/test" } },
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
vi.mock("nanoid", () => ({ nanoid: vi.fn().mockReturnValue("mock-nanoid-bravo") }));
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
        createUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } }, error: null }),
        listUsers: vi.fn().mockResolvedValue({ data: { users: [] } }),
      },
    },
  }),
}));

vi.mock("@/lib/services/provision-team", () => ({
  ensureTeamForUser: vi.fn().mockResolvedValue({ teamId: "team-bravo" }),
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
vi.mock("@/lib/services/tree-extractor", () => ({ extractTrees: vi.fn().mockResolvedValue({ ok: true, trees: { geoTree: { root: { children: [] }, leafCount: 0 }, categoryTree: { root: { children: [] }, leafCount: 0 }, mapping: { entries: [], totalEntries: 0 } } }) }));
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
 * Build a select chain that is both a thenable (resolves to rows) AND has all
 * the fluent query-builder methods (from, where, limit, orderBy) returning `this`.
 *
 * This correctly models Drizzle's pattern where every builder method is chainable
 * and the whole chain can be awaited at any point — even after `.where().limit()`.
 */
function makeSelectChain(rows: unknown[] = []) {
  const chain: Record<string, unknown> = {};

  // Make it thenable: `await chain` resolves to rows
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  chain.catch = (reject: (e: unknown) => unknown) => Promise.resolve(rows).catch(reject);
  chain.finally = (fn: () => void) => Promise.resolve(rows).finally(fn);

  // All builder methods return the chain (this), so they can be chained in any order
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockReturnValue(chain);

  return chain;
}

/**
 * Build an update chain matching Drizzle's pattern:
 *   db.update(table).set({}).where(cond) → Promise (with .returning())
 *
 * This is the same pattern as pipeline-stage-errors.test.ts.
 */
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
    id: "purchase-bravo-1",
    siteId: "site-bravo-1",
    customerEmail: "buyer@bravo.com",
    domain: "bravo.com",
    status: "paid",
    pdfDeliveredAt: null,
    magicLink: "https://magic.link/existing",
    magicLinkExpiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h from now — valid
    purchaseToken: "tok-bravo",
    stripePaymentIntentId: "pi_bravo_123",
    amountCents: 1000,
    ...overrides,
  };
}

/** Site row used in selects */
function makeSiteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "site-bravo-1",
    domain: "bravo.com",
    teamId: "team-bravo-1",
    pipelineStatus: "complete",
    creditsReserved: null,
    geoScorecard: null,
    discoveredCompetitors: [],
    userCompetitors: [],
    ownerEmail: "owner@bravo.com",
    ...overrides,
  };
}

/**
 * Collect all first-args passed to .set() across all db.update() calls.
 * Works with the makeUpdateChain pattern above where:
 *   db.update(table) → { set: fn }
 *   .set(args) → { where: fn }
 *   .where(cond) → Promise
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
// Blocker B1 — PDF-render failure routes through markFailed (Stripe refund issued)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Blocker B1 — PDF render failure routes through markFailed", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // PDF render always throws in these tests
    mockRenderAuditPdfBuffer.mockRejectedValue(new Error("PDF render exploded"));

    // db.update: fresh chain per call so each .set() call is tracked independently
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => makeUpdateChain([{ id: "purchase-bravo-1" }]));
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());

    // db.select sequence:
    //   Call 1: auditPurchases fetch in handleAuditPurchaseFinalize
    //   Call 2: geoSites discoveredCompetitors check (populated → skip discovery)
    //   Call 3: citationCheckScores check (row exists → skip citation)
    //   Call 4: geoSites geoScorecard fetch
    //   [PDF render throws here → markFailed(siteId, pdfErr) called]
    //   Call 5: markFailed → geoSites fetch (no reserved credits)
    //   Call 6: markFailed → auditPurchases fetch (for Stripe refund path)
    let n = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      n++;
      if (n === 1) return makeSelectChain([makePurchaseRow()]);
      if (n === 2) return makeSelectChain([makeSiteRow({ discoveredCompetitors: ["comp1"] })]);
      if (n === 3) return makeSelectChain([{ checkId: "existing-check" }]);
      if (n === 4) return makeSelectChain([makeSiteRow({ geoScorecard: { overallScore: 55, pillars: [] } })]);
      if (n === 5) return makeSelectChain([makeSiteRow()]);            // markFailed geoSites
      if (n === 6) return makeSelectChain([makePurchaseRow()]);        // markFailed auditPurchases
      return makeSelectChain([]);
    });
  });

  it("geoSites.pipelineStatus is set to 'failed' with the PDF error message", async () => {
    const res = await POST(makeRequest({
      siteId: "site-bravo-1",
      domain: "bravo.com",
      stage: "audit-purchase-finalize",
    }));

    expect(res.status).toBe(200);

    const allSetArgs = getAllUpdateSetArgs();
    const failedWrite = allSetArgs.find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeDefined();
    expect(String(failedWrite?.pipelineError)).toMatch(/PDF render exploded/i);
  });

  it("Stripe refund is issued via markFailed with correct payment_intent + amountCents", async () => {
    await POST(makeRequest({
      siteId: "site-bravo-1",
      domain: "bravo.com",
      stage: "audit-purchase-finalize",
    }));

    expect(mockStripeRefundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: "pi_bravo_123",
        amount: 1000,
      }),
    );
  });

  it("customer failure email is sent when PDF render throws", async () => {
    await POST(makeRequest({
      siteId: "site-bravo-1",
      domain: "bravo.com",
      stage: "audit-purchase-finalize",
    }));

    expect(mockSendAuditPurchaseFailedEmail).toHaveBeenCalled();
  });

  it("delivery email is NOT sent when PDF render throws", async () => {
    await POST(makeRequest({
      siteId: "site-bravo-1",
      domain: "bravo.com",
      stage: "audit-purchase-finalize",
    }));

    expect(mockSendAuditPurchaseDeliveryEmail).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Blocker B2 — scrub magicLink AFTER pdfDeliveredAt + email delivery
// ═══════════════════════════════════════════════════════════════════════════════

describe("Blocker B2 — magicLink scrub ordering", () => {
  /**
   * Set up select sequence for a successful delivery path (PDF renders OK).
   * Optionally override the confirm select (call 5) via `confirmPdfDeliveredAt`.
   */
  function setupSelectsForDelivery(opts: {
    confirmPdfDeliveredAt?: Date | null;
    purchaseOverrides?: Record<string, unknown>;
  } = {}) {
    const {
      confirmPdfDeliveredAt = new Date(),
      purchaseOverrides = {},
    } = opts;

    let n = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      n++;
      if (n === 1) return makeSelectChain([makePurchaseRow(purchaseOverrides)]);
      if (n === 2) return makeSelectChain([makeSiteRow({ discoveredCompetitors: ["comp1"] })]);
      if (n === 3) return makeSelectChain([{ checkId: "check-1" }]);
      if (n === 4) return makeSelectChain([makeSiteRow({ geoScorecard: { overallScore: 70, pillars: [] } })]);
      // Call 5: confirm select — returns pdfDeliveredAt to check CAS result
      return makeSelectChain([{ pdfDeliveredAt: confirmPdfDeliveredAt }]);
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();

    // PDF renders successfully
    mockRenderAuditPdfBuffer.mockResolvedValue({
      buffer: Buffer.from("fake-pdf"),
      filename: "audit-bravo.pdf",
    });

    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => makeUpdateChain([{ id: "purchase-bravo-1" }]));
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  it("happy path: pdfDeliveredAt is written AND magicLink is scrubbed after delivery", async () => {
    setupSelectsForDelivery();
    mockSendAuditPurchaseDeliveryEmail.mockResolvedValue(undefined);

    const res = await POST(makeRequest({
      siteId: "site-bravo-1",
      domain: "bravo.com",
      stage: "audit-purchase-finalize",
    }));

    expect(res.status).toBe(200);

    const allSetArgs = getAllUpdateSetArgs();

    // pdfDeliveredAt must have been written (CAS update)
    const deliveryWrite = allSetArgs.find((a) => "pdfDeliveredAt" in a);
    expect(deliveryWrite).toBeDefined();
    expect(deliveryWrite?.status).toBe("delivered");

    // Scrub must have happened (magicLink=null update)
    const scrubWrite = allSetArgs.find((a) => a.magicLink === null);
    expect(scrubWrite).toBeDefined();

    // Delivery email was sent
    expect(mockSendAuditPurchaseDeliveryEmail).toHaveBeenCalledTimes(1);
  });

  it("when email send throws: pdfDeliveredAt IS committed but magicLink is NOT scrubbed", async () => {
    setupSelectsForDelivery();
    mockSendAuditPurchaseDeliveryEmail.mockRejectedValue(new Error("SMTP timeout"));

    const res = await POST(makeRequest({
      siteId: "site-bravo-1",
      domain: "bravo.com",
      stage: "audit-purchase-finalize",
    }));

    expect(res.status).toBe(200);

    const allSetArgs = getAllUpdateSetArgs();

    // pdfDeliveredAt must have been committed before the email send attempt
    const deliveryWrite = allSetArgs.find((a) => "pdfDeliveredAt" in a);
    expect(deliveryWrite).toBeDefined();
    expect(deliveryWrite?.status).toBe("delivered");

    // magicLink must NOT be scrubbed — preserved for operator manual resend
    const scrubWrite = allSetArgs.find((a) => a.magicLink === null);
    expect(scrubWrite).toBeUndefined();
  });

  it("when email send throws: ops alert is fired with type=audit_purchase_failed", async () => {
    setupSelectsForDelivery();
    mockSendAuditPurchaseDeliveryEmail.mockRejectedValue(new Error("SMTP timeout"));

    await POST(makeRequest({
      siteId: "site-bravo-1",
      domain: "bravo.com",
      stage: "audit-purchase-finalize",
    }));

    expect(mockSendInternalPaymentAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "audit_purchase_failed" }),
    );
  });

  it("CAS write fails (confirm returns null pdfDeliveredAt): email is NOT sent", async () => {
    // Confirm select returns null — another retry already won the CAS
    setupSelectsForDelivery({ confirmPdfDeliveredAt: null });

    const res = await POST(makeRequest({
      siteId: "site-bravo-1",
      domain: "bravo.com",
      stage: "audit-purchase-finalize",
    }));

    expect(res.status).toBe(200);
    expect(mockSendAuditPurchaseDeliveryEmail).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Follow-up #3 — stage route passes distinct siteUrl to delivery email options
// ═══════════════════════════════════════════════════════════════════════════════

describe("Follow-up #3 — delivery email receives distinct siteUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRenderAuditPdfBuffer.mockResolvedValue({
      buffer: Buffer.from("pdf"),
      filename: "audit.pdf",
    });
    mockSendAuditPurchaseDeliveryEmail.mockResolvedValue(undefined);

    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => makeUpdateChain([{ id: "purchase-bravo-1" }]));
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());

    let n = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      n++;
      if (n === 1) return makeSelectChain([makePurchaseRow()]);
      if (n === 2) return makeSelectChain([makeSiteRow({ discoveredCompetitors: ["comp1"] })]);
      if (n === 3) return makeSelectChain([{ checkId: "check-1" }]);
      if (n === 4) return makeSelectChain([makeSiteRow({ geoScorecard: { overallScore: 60, pillars: [] } })]);
      return makeSelectChain([{ pdfDeliveredAt: new Date() }]);
    });
  });

  it("delivery email is called with siteUrl option containing siteId and purchaseToken", async () => {
    await POST(makeRequest({
      siteId: "site-bravo-1",
      domain: "bravo.com",
      stage: "audit-purchase-finalize",
    }));

    expect(mockSendAuditPurchaseDeliveryEmail).toHaveBeenCalledTimes(1);

    const callArgs = mockSendAuditPurchaseDeliveryEmail.mock.calls[0] as [
      string,
      string,
      { buffer: Buffer; filename: string },
      { magicLink?: string; siteUrl?: string; overallScore?: number; topPillars?: string[] },
    ];
    const options = callArgs[3];

    expect(options).toHaveProperty("siteUrl");
    expect(options.siteUrl).toContain("/sites/site-bravo-1");
    expect(options.siteUrl).toContain("token=tok-bravo");
  });

  it("siteUrl differs from magicLink (distinct destinations)", async () => {
    await POST(makeRequest({
      siteId: "site-bravo-1",
      domain: "bravo.com",
      stage: "audit-purchase-finalize",
    }));

    const callArgs = mockSendAuditPurchaseDeliveryEmail.mock.calls[0] as [
      string,
      string,
      { buffer: Buffer; filename: string },
      { magicLink?: string; siteUrl?: string },
    ];
    const options = callArgs[3];

    // Both should be present
    expect(options.siteUrl).toBeDefined();
    expect(options.magicLink).toBeDefined();

    // They should point to different destinations
    expect(options.siteUrl).not.toBe(options.magicLink);
  });

});
