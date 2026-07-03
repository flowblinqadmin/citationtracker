/**
 * Tests for governor fix-up items A–L on the audit-purchase endpoints.
 *
 * Blocker A  — status endpoint uses explicit column projection (no magicLink/userId/teamId)
 * Blocker B  — email normalized (lowercase + trim) before DB writes
 * Blocker C  — duplicate customer email suppressed for pipeline-triggered refunds
 * Blocker D  — explicit user lookup on createUser collision
 * Blocker E  — charge.dispute.created uses payment_intent fallback
 * Fix F      — DB CAS guard before Stripe refund
 * Fix G      — magicLinkExpiresAt stamped in schema + webhook
 * Fix H      — refund amount pinned to amountCents
 * Fix I      — customerEmail redacted (hashed) in structured logs
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const {
  mockDbSelect,
  mockDbUpdate,
  mockDbInsert,
  mockStripeRefundsCreate,
  mockStripeChargesRetrieve,
  mockCreateUser,
  mockListUsers,
  mockGenerateLink,
  mockEnsureTeamForUser,
  mockSendAuditPurchaseRefundedEmail,
  mockSendAuditPurchaseFailedEmail,
  mockSendInternalPaymentAlert,
  mockConstructEvent,
  mockCheckRateLimit,
} = vi.hoisted(() => {
  // Set up env vars needed by stage route auth
  // C3 (2026-05-27 audit): lib/cron-auth.ts requires ≥32 chars.
  process.env.CRON_SECRET = "test-cron-secret-fixups-padded-32-chars+";
  process.env.STRIPE_SECRET_KEY = "sk_test_fixups";

  const mockStripeRefundsCreate = vi.fn().mockResolvedValue({ id: "re_test_123" });
  const mockStripeChargesRetrieve = vi.fn().mockResolvedValue({
    id: "ch_test_123",
    payment_intent: "pi_test_456",
  });
  const mockCreateUser = vi.fn();
  const mockListUsers = vi.fn().mockResolvedValue({ data: { users: [] } });
  const mockGenerateLink = vi.fn().mockResolvedValue({
    data: { user: { id: "user-123" }, properties: { action_link: "https://app.example.com/magic" } },
    error: null,
  });
  const mockEnsureTeamForUser = vi.fn().mockResolvedValue({ teamId: "team-abc" });
  const mockSendAuditPurchaseRefundedEmail = vi.fn().mockResolvedValue(undefined);
  const mockSendAuditPurchaseFailedEmail = vi.fn().mockResolvedValue(undefined);
  const mockSendInternalPaymentAlert = vi.fn().mockResolvedValue(undefined);
  const mockDbSelect = vi.fn();
  const mockDbUpdate = vi.fn();
  const mockDbInsert = vi.fn();
  const mockConstructEvent = vi.fn();
  const mockCheckRateLimit = vi.fn().mockResolvedValue({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 });

  return {
    mockDbSelect,
    mockDbUpdate,
    mockDbInsert,
    mockStripeRefundsCreate,
    mockStripeChargesRetrieve,
    mockCreateUser,
    mockListUsers,
    mockGenerateLink,
    mockEnsureTeamForUser,
    mockSendAuditPurchaseRefundedEmail,
    mockSendAuditPurchaseFailedEmail,
    mockSendInternalPaymentAlert,
    mockConstructEvent,
    mockCheckRateLimit,
  };
});

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      webhooks: { constructEvent: mockConstructEvent },
      refunds: { create: mockStripeRefundsCreate },
      charges: { retrieve: mockStripeChargesRetrieve },
    };
  }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    update: (...args: unknown[]) => mockDbUpdate(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
    transaction: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_c: unknown, v: unknown) => ({ _tag: "eq", v })),
  and: vi.fn((...args: unknown[]) => ({ _tag: "and", args })),
  or: vi.fn((...args: unknown[]) => ({ _tag: "or", args })),
  isNull: vi.fn((c: unknown) => ({ _tag: "isNull", c })),
  sql: vi.fn().mockReturnValue({ _tag: "sql" }),
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn().mockReturnValue("mock-nanoid"),
}));

vi.mock("@/lib/db/schema", () => ({
  teams: { id: "id", creditBalance: "credit_balance" },
  teamMembers: { id: "id", teamId: "team_id", userId: "user_id" },
  creditTransactions: { id: "id" },
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
    userId: "user_id",
    teamId: "team_id",
    amountCents: "amount_cents",
  },
  geoSiteView: {
    siteId: "site_id",
    pipelineStatus: "pipeline_status",
    domain: "domain",
    overallScore: "overall_score",
    pipelineError: "pipeline_error",
  },
  geoSites: { id: "id", siteId: "site_id" },
  firecrawlJobs: { id: "id", siteId: "site_id", status: "status", result: "result", createdAt: "created_at" },
  citationCheckScores: { id: "id", siteId: "site_id", checkId: "check_id" },
  rateLimits: { key: "key", count: "count", resetAt: "reset_at" },
}));

vi.mock("@/lib/email", () => ({
  sendSubscriptionConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendCreditsPurchasedEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionRenewalEmail: vi.fn().mockResolvedValue(undefined),
  sendPaymentFailedEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionCancelledEmail: vi.fn().mockResolvedValue(undefined),
  sendCompletionEmail: vi.fn().mockResolvedValue(undefined),
  sendPipelineFailedEmail: vi.fn().mockResolvedValue(undefined),
  sendInternalPaymentAlert: (...args: unknown[]) => mockSendInternalPaymentAlert(...args),
  sendAuditPurchaseRefundedEmail: (...args: unknown[]) => mockSendAuditPurchaseRefundedEmail(...args),
  sendAuditPurchaseFailedEmail: (...args: unknown[]) => mockSendAuditPurchaseFailedEmail(...args),
  sendAuditPurchaseDeliveryEmail: vi.fn().mockResolvedValue(undefined),
  sendAuditPurchaseConfirmationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: vi.fn().mockReturnValue({
    auth: {
      admin: {
        createUser: (...args: unknown[]) => mockCreateUser(...args),
        listUsers: (...args: unknown[]) => mockListUsers(...args),
        generateLink: (...args: unknown[]) => mockGenerateLink(...args),
      },
    },
  }),
}));

vi.mock("@/lib/services/provision-team", () => ({
  ensureTeamForUser: (...args: unknown[]) => mockEnsureTeamForUser(...args),
}));

vi.mock("@/lib/config", () => ({
  CREDITS_PER_PACK: 10,
  FREE_MAX_PAGES: 20,
  SUBSCRIPTION_TIERS: {},
  STRIPE_PRICE_IDS: { monthly: {}, quarterly: {}, annual: {} },
  bulkCreditsRequired: vi.fn().mockReturnValue(0),
  POLL_CHUNK_INTERVAL_S: 15,
  POLL_CHUNK_CIRCUIT_BREAKER_MS: 20 * 60 * 1000,
}));

// ── Additional mocks required by /api/pipeline/stage/route (Fix F + H tests) ─

vi.mock("@upstash/qstash", () => ({
  Receiver: vi.fn().mockImplementation(function () {
    return { verify: vi.fn().mockResolvedValue(true) };
  }),
}));

vi.mock("@mendable/firecrawl-js", () => ({
  FirecrawlAppV1: vi.fn().mockImplementation(function () {
    return { asyncBatchScrapeUrls: vi.fn(), checkBatchScrapeStatus: vi.fn() };
  }),
}));

vi.mock("@/lib/qstash", () => ({ enqueueStage: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/crawl-mode", () => ({ getCrawlMode: vi.fn().mockResolvedValue("standard") }));
vi.mock("@/lib/services/geo-crawler", () => ({
  discoverSite: vi.fn().mockRejectedValue(new Error("discover-fail-for-markFailed-test")),
  computeChunks: vi.fn().mockReturnValue({ numChunks: 1, chunkSize: 10 }),
  mapDocumentToPage: vi.fn(),
  scoreCrawlQuality: vi.fn(),
  classifyPageType: vi.fn(),
  detectFlowblinqAssets: vi.fn(),
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
// Fix #31: allow all status/intake requests through the rate limiter in existing tests
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date() }),
  checkAndIncrementOtpAttempt: vi.fn().mockResolvedValue({ allowed: true, attemptsLeft: 4 }),
  clearOtpAttempts: vi.fn().mockResolvedValue(undefined),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSelectChain(rows: unknown[] = []) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
  };
}

function makeUpdateChain(returningRows: unknown[] = [{ id: "default-id" }]) {
  const setFn = vi.fn().mockReturnThis();
  // .where() returns a thenable that also has .returning() chained on it
  const whereResult = Object.assign(Promise.resolve(returningRows), {
    returning: vi.fn().mockResolvedValue(returningRows),
  });
  const whereFn = vi.fn().mockReturnValue(whereResult);
  return { set: setFn, where: whereFn, _setFn: setFn, _whereFn: whereFn };
}

function makeInsertChain() {
  return { values: vi.fn().mockResolvedValue([]) };
}

function makeStripeWebhookRequest(body: object): NextRequest {
  const raw = JSON.stringify(body);
  return new NextRequest(
    new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1,v1=fakesig",
      },
      body: raw,
    }),
  );
}

function makeGetRequest(path: string): NextRequest {
  return new NextRequest(new Request(`http://localhost${path}`, { method: "GET" }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Blocker A — status endpoint: explicit column projection
// ═══════════════════════════════════════════════════════════════════════════════

describe("Blocker A — /api/audit-purchase/status: explicit column projection", () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/audit-purchase/status/route");
    GET = mod.GET;
  });

  it("response body does NOT contain magicLink, userId, or teamId", async () => {
    // Return a purchase row that includes sensitive fields (as DB would)
    const sensitiveRow = {
      status: "paid",
      domain: "example.com",
      siteId: null,
      magicLink: "https://super-secret-magic-link",
      userId: "user-uuid-sensitive",
      teamId: "team-uuid-sensitive",
      purchaseToken: "tok-very-secret",
      customerEmail: "user@example.com",
      stripeSessionId: "cs_secret",
    };

    vi.mocked(mockDbSelect).mockReturnValue(makeSelectChain([sensitiveRow]));

    const req = makeGetRequest("/api/audit-purchase/status?session_id=cs_test_123");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();

    // Sensitive fields must not appear in the response
    expect(body).not.toHaveProperty("magicLink");
    expect(body).not.toHaveProperty("userId");
    expect(body).not.toHaveProperty("teamId");
    expect(body).not.toHaveProperty("purchaseToken");
    expect(body).not.toHaveProperty("customerEmail");
    expect(body).not.toHaveProperty("stripeSessionId");

    // Safe fields should be present (siteId is null so early-return path is taken;
    // domain is null on early-return as per route logic — the key check is the absence of PII)
    expect(body.purchaseStatus).toBe("paid");
  });

  it("db.select is called with explicit projection (not SELECT *)", async () => {
    // The select must be called with a projection object, not empty args
    const selectSpy = vi.fn().mockReturnValue(makeSelectChain([{
      status: "paid", domain: null, siteId: null,
    }]));
    vi.mocked(mockDbSelect).mockImplementation(selectSpy);

    const req = makeGetRequest("/api/audit-purchase/status?session_id=cs_test");
    await GET(req);

    // db.select() was called with a projection argument (not called with no args)
    expect(selectSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: expect.anything(),
        domain: expect.anything(),
        siteId: expect.anything(),
      }),
    );

    // Verify the projection does NOT include sensitive columns
    const callArg = selectSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg).not.toHaveProperty("magicLink");
    expect(callArg).not.toHaveProperty("userId");
    expect(callArg).not.toHaveProperty("teamId");
    expect(callArg).not.toHaveProperty("purchaseToken");
    expect(callArg).not.toHaveProperty("customerEmail");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Blocker B — email normalization
// ═══════════════════════════════════════════════════════════════════════════════

describe("Blocker B — email normalized (lowercase + trim) before DB writes", () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default: no existing purchase
    vi.mocked(mockDbSelect).mockReturnValue(makeSelectChain([]));
    vi.mocked(mockDbInsert).mockReturnValue(makeInsertChain());
    vi.mocked(mockDbUpdate).mockReturnValue(makeUpdateChain());

    // createUser succeeds on first call
    mockCreateUser.mockResolvedValue({
      data: { user: { id: "user-123" } },
      error: null,
    });

    const mod = await import("@/app/api/webhooks/stripe/route");
    POST = mod.POST;
  });

  it("normalizes mixed-case email from Stripe before inserting into DB", async () => {
    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_upper",
          payment_status: "paid",
          payment_intent: "pi_test_upper",
          mode: "payment",
          metadata: { type: "audit_purchase" },
          customer_details: { email: "  User@Example.COM  " },
          customer_email: null,
        },
      },
    };

    mockConstructEvent.mockReturnValue(event);

    const req = makeStripeWebhookRequest(event);
    await POST(req);

    // Find the insert call for auditPurchases
    const insertCalls = vi.mocked(mockDbInsert).mock.calls;
    expect(insertCalls.length).toBeGreaterThan(0);
    const insertValues = insertCalls[0];
    // The insert chain: mockDbInsert(table) → .values(data)
    // Check via the values mock
    const insertChain = vi.mocked(mockDbInsert).mock.results[0].value;
    const valuesCalled = insertChain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(valuesCalled.customerEmail).toBe("user@example.com");
  });

  it("createUser is called with normalized email", async () => {
    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_upper2",
          payment_status: "paid",
          payment_intent: "pi_test_upper2",
          mode: "payment",
          metadata: { type: "audit_purchase" },
          customer_details: { email: "  USER@EXAMPLE.COM  " },
          customer_email: null,
        },
      },
    };

    mockConstructEvent.mockReturnValue(event);

    const req = makeStripeWebhookRequest(event);
    await POST(req);

    expect(mockCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "user@example.com" }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Blocker C — no duplicate customer email on pipeline-triggered refund
// ═══════════════════════════════════════════════════════════════════════════════

describe("Blocker C — charge.refunded: suppress customer email on pipeline-triggered refund", () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(mockDbUpdate).mockReturnValue(makeUpdateChain());
    vi.mocked(mockDbSelect).mockReturnValue(makeSelectChain([]));
    const mod = await import("@/app/api/webhooks/stripe/route");
    POST = mod.POST;
  });

  it("does NOT send customer refund email when status was 'failed' (pipeline path)", async () => {
    const failedPurchaseRow = {
      id: "p-1",
      customerEmail: "buyer@example.com",
      domain: "example.com",
      status: "failed", // pipeline already marked it failed
    };

    vi.mocked(mockDbSelect).mockReturnValue(makeSelectChain([failedPurchaseRow]));

    const event = {
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_test_123",
          payment_intent: "pi_test_456",
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    const req = makeStripeWebhookRequest(event);
    const res = await POST(req);

    expect(res.status).toBe(200);
    // Customer refund email must NOT be sent (markFailed already sent the apology email)
    expect(mockSendAuditPurchaseRefundedEmail).not.toHaveBeenCalled();
    // Ops alert must still fire
    expect(mockSendInternalPaymentAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "audit_purchase_refunded" }),
    );
  });

  it("does NOT send customer refund email when status was 'refund_pending'", async () => {
    const refundPendingRow = {
      id: "p-2",
      customerEmail: "buyer2@example.com",
      domain: "example2.com",
      status: "refund_pending",
    };

    vi.mocked(mockDbSelect).mockReturnValue(makeSelectChain([refundPendingRow]));

    const event = {
      type: "charge.refunded",
      data: {
        object: { id: "ch_test_456", payment_intent: "pi_test_789" },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    await POST(makeStripeWebhookRequest(event));

    expect(mockSendAuditPurchaseRefundedEmail).not.toHaveBeenCalled();
  });

  it("DOES send customer refund email for manual (operator-initiated) refund (status=delivered)", async () => {
    const deliveredRow = {
      id: "p-3",
      customerEmail: "buyer3@example.com",
      domain: "example3.com",
      status: "delivered",
    };

    vi.mocked(mockDbSelect).mockReturnValue(makeSelectChain([deliveredRow]));

    const event = {
      type: "charge.refunded",
      data: {
        object: { id: "ch_manual_123", payment_intent: "pi_manual_456" },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    await POST(makeStripeWebhookRequest(event));

    expect(mockSendAuditPurchaseRefundedEmail).toHaveBeenCalledWith(
      "buyer3@example.com",
      "example3.com",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Blocker D — explicit user lookup fallback on createUser collision
// ═══════════════════════════════════════════════════════════════════════════════

describe("Blocker D — explicit user lookup on createUser email collision", () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(mockDbSelect).mockReturnValue(makeSelectChain([]));
    vi.mocked(mockDbInsert).mockReturnValue(makeInsertChain());
    vi.mocked(mockDbUpdate).mockReturnValue(makeUpdateChain());
    const mod = await import("@/app/api/webhooks/stripe/route");
    POST = mod.POST;
  });

  it("looks up existing user when createUser returns 'already been registered'", async () => {
    // createUser fails with collision
    mockCreateUser.mockResolvedValueOnce({
      data: null,
      error: { message: "User with this email already been registered" },
    });

    // listUsers returns the existing user
    mockListUsers.mockResolvedValueOnce({
      data: { users: [{ id: "existing-user-uuid", email: "buyer@example.com" }] },
      error: null,
    });

    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_collision_test",
          payment_status: "paid",
          payment_intent: "pi_collision",
          mode: "payment",
          metadata: { type: "audit_purchase" },
          customer_details: { email: "buyer@example.com" },
          customer_email: null,
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    await POST(makeStripeWebhookRequest(event));

    // listUsers was called to look up the existing user
    expect(mockListUsers).toHaveBeenCalled();

    // ensureTeamForUser was called with the existing user ID
    expect(mockEnsureTeamForUser).toHaveBeenCalledWith(
      "existing-user-uuid",
      "buyer@example.com",
      expect.anything(),
    );

    // DB update to stamp userId was called
    const updateCalls = vi.mocked(mockDbUpdate).mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
  });

  it("proceeds with team provisioning even when generateLink fails, if userId was resolved via listUsers", async () => {
    // createUser collision
    mockCreateUser.mockResolvedValueOnce({
      data: null,
      error: { message: "already registered" },
    });

    // listUsers returns the existing user
    mockListUsers.mockResolvedValueOnce({
      data: { users: [{ id: "existing-user-from-list", email: "buyer@example.com" }] },
      error: null,
    });

    // generateLink fails
    mockGenerateLink.mockResolvedValueOnce({
      data: null,
      error: { message: "generateLink failure" },
    });

    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_link_fail",
          payment_status: "paid",
          payment_intent: "pi_link_fail",
          mode: "payment",
          metadata: { type: "audit_purchase" },
          customer_details: { email: "buyer@example.com" },
          customer_email: null,
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    const res = await POST(makeStripeWebhookRequest(event));

    // Webhook returns 200 — failure is non-fatal
    expect(res.status).toBe(200);

    // ensureTeamForUser still called despite generateLink failure
    expect(mockEnsureTeamForUser).toHaveBeenCalledWith(
      "existing-user-from-list",
      "buyer@example.com",
      expect.anything(),
    );
  });

  it("matches existing user case-insensitively when Supabase stores email in original case", async () => {
    // createUser collision for a normalized (lowercase) email
    mockCreateUser.mockResolvedValueOnce({
      data: null,
      error: { message: "User with this email already been registered" },
    });

    // Supabase stores the email in original mixed case — e.g. User@Example.com
    // The webhook normalizes the incoming email to user@example.com (lowercase)
    mockListUsers.mockResolvedValueOnce({
      data: { users: [{ id: "mixed-case-user-id", email: "User@Example.com" }] },
      error: null,
    });

    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_case_insensitive",
          payment_status: "paid",
          payment_intent: "pi_case_insensitive",
          mode: "payment",
          metadata: { type: "audit_purchase" },
          // Incoming email with mixed case — normalized to lowercase by webhook
          customer_details: { email: "user@example.com" },
          customer_email: null,
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    await POST(makeStripeWebhookRequest(event));

    // Despite Supabase storing "User@Example.com", the case-insensitive find must
    // match it to the normalized "user@example.com" and use the user's ID.
    expect(mockEnsureTeamForUser).toHaveBeenCalledWith(
      "mixed-case-user-id",
      "user@example.com",
      expect.anything(),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Blocker E — charge.dispute.created: payment_intent fallback
// ═══════════════════════════════════════════════════════════════════════════════

describe("Blocker E — charge.dispute.created: payment_intent fallback lookup", () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(mockDbUpdate).mockReturnValue(makeUpdateChain());
    const mod = await import("@/app/api/webhooks/stripe/route");
    POST = mod.POST;
  });

  it("retrieves the charge from Stripe to get payment_intent for the fallback lookup", async () => {
    const disputedRow = {
      id: "p-disputed",
      customerEmail: "buyer@example.com",
      domain: "example.com",
    };

    // 12.B fix: direct chargeId lookup runs first (returns empty → misses),
    // then charges.retrieve is called, then payment_intent lookup returns the row.
    let selectCallIdx = 0;
    vi.mocked(mockDbSelect).mockImplementation(() => {
      selectCallIdx++;
      // selectCallIdx === 1: direct chargeId lookup → miss (empty)
      // selectCallIdx === 2: payment_intent fallback lookup → hit
      return makeSelectChain(selectCallIdx === 2 ? [disputedRow] : []);
    });

    mockStripeChargesRetrieve.mockResolvedValueOnce({
      id: "ch_dispute_123",
      payment_intent: "pi_dispute_456",
    });

    const event = {
      type: "charge.dispute.created",
      data: {
        object: {
          charge: "ch_dispute_123",
          reason: "fraudulent",
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    const res = await POST(makeStripeWebhookRequest(event));
    expect(res.status).toBe(200);

    // Stripe charges.retrieve must be called to get the payment_intent
    expect(mockStripeChargesRetrieve).toHaveBeenCalledWith("ch_dispute_123");

    // Ops alert should fire
    expect(mockSendInternalPaymentAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "audit_purchase_disputed",
        note: expect.stringContaining("7 DAYS"),
      }),
    );
  });

  it("stamps stripeChargeId on the row when dispute is found", async () => {
    const disputedRow = {
      id: "p-stamp-test",
      customerEmail: "buyer@example.com",
      domain: "example.com",
    };

    vi.mocked(mockDbSelect).mockReturnValue(makeSelectChain([disputedRow]));
    mockStripeChargesRetrieve.mockResolvedValueOnce({
      id: "ch_stamp_123",
      payment_intent: "pi_stamp_456",
    });

    const updateChain = makeUpdateChain();
    vi.mocked(mockDbUpdate).mockReturnValue(updateChain);

    const event = {
      type: "charge.dispute.created",
      data: {
        object: { charge: "ch_stamp_123", reason: "fraudulent" },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    await POST(makeStripeWebhookRequest(event));

    // Update must include stripeChargeId stamp
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ stripeChargeId: "ch_stamp_123" }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fix G — magicLinkExpiresAt stamped in webhook
// ═══════════════════════════════════════════════════════════════════════════════

describe("Fix G — magicLinkExpiresAt stamped when magic link generated", () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(mockDbSelect).mockReturnValue(makeSelectChain([]));
    vi.mocked(mockDbInsert).mockReturnValue(makeInsertChain());
    vi.mocked(mockDbUpdate).mockReturnValue(makeUpdateChain());
    mockCreateUser.mockResolvedValue({
      data: { user: { id: "user-g-test" } },
      error: null,
    });
    const mod = await import("@/app/api/webhooks/stripe/route");
    POST = mod.POST;
  });

  it("stamps magicLinkExpiresAt ≈ now+1hr when magic link is generated", async () => {
    mockGenerateLink.mockResolvedValueOnce({
      data: {
        user: { id: "user-g-test" },
        properties: { action_link: "https://example.com/magic" },
      },
      error: null,
    });

    const beforeCall = Date.now();
    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_g_test",
          payment_status: "paid",
          payment_intent: "pi_g_test",
          mode: "payment",
          metadata: { type: "audit_purchase" },
          customer_details: { email: "buyer@example.com" },
          customer_email: null,
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    await POST(makeStripeWebhookRequest(event));

    // Find the update call that sets magicLink
    const updateCalls = vi.mocked(mockDbUpdate).mock.results;
    const updateWithMagicLink = updateCalls.find((r) => {
      const chain = r.value as ReturnType<typeof makeUpdateChain>;
      const setCalls = chain._setFn?.mock?.calls ?? [];
      return setCalls.some((c: unknown[]) => {
        const arg = c[0] as Record<string, unknown>;
        return "magicLink" in arg;
      });
    });

    expect(updateWithMagicLink).toBeDefined();

    const setArg = (updateWithMagicLink!.value as ReturnType<typeof makeUpdateChain>)._setFn.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)["magicLink"] !== undefined,
    )?.[0] as Record<string, unknown>;

    expect(setArg).toBeDefined();
    expect(setArg!.magicLinkExpiresAt).toBeInstanceOf(Date);

    const expiresAt = (setArg!.magicLinkExpiresAt as Date).getTime();
    const oneHourMs = 60 * 60 * 1000;
    // Should be approximately now + 1 hour (within 5s tolerance)
    expect(expiresAt).toBeGreaterThanOrEqual(beforeCall + oneHourMs - 5000);
    expect(expiresAt).toBeLessThanOrEqual(beforeCall + oneHourMs + 5000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fix F + Fix H — CAS guard (.returning()) + refund amount pinned to amountCents
// ═══════════════════════════════════════════════════════════════════════════════

describe("Fix F + Fix H — markFailed: .returning()-based CAS guard + pinned amountCents", () => {
  // We trigger markFailed by posting to the stage route with a discover stage that
  // fails (discoverSite is mocked to reject), so markFailed runs with the auditPurchase
  // row we set up in db.select.

  function makeStageRequest(siteId = "site-fh") {
    return new NextRequest("https://test.flowblinq.com/api/pipeline/stage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CRON_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ siteId, domain: "example.com", stage: "discover" }),
    });
  }

  const siteRow = {
    id: "site-fh",
    domain: "example.com",
    creditsReserved: null,
    teamId: null,
    ownerEmail: "owner@example.com",
    pipelineStatus: "discovering",
    pipelineError: null,
    discoveryData: null,
    crawlData: null,
    crawlJobIds: null,
    crawlChunksTotal: null,
    crawlChunksDone: null,
    crawlChunkResults: null,
    auditMode: "standard",
    crawlLimit: 50,
    accessToken: "tok-fh",
    crawlStartedAt: null,
    bulkUrls: null,
    geoScorecard: null,
    executiveSummary: null,
    recommendations: null,
    generatedLlmsTxt: null,
    generatedLlmsFullTxt: null,
    generatedBusinessJson: null,
    generatedSchemaBlocks: null,
    researchData: null,
    shareToken: null,
    perPageFixes: null,
    siteType: null,
  };

  const purchaseRow = {
    id: "purchase-fh",
    customerEmail: "buyer@example.com",
    domain: "example.com",
    status: "intake_complete",
    stripePaymentIntentId: "pi_fh_test",
    amountCents: 1000,
    siteId: "site-fh",
  };

  it("CAS won: stripe.refunds.create is called with payment_intent and pinned amountCents", async () => {
    vi.clearAllMocks();

    // db.select: first call → site (handleDiscover), second call → site (markFailed),
    // third call → auditPurchase (markFailed audit_purchase block)
    let selectIdx = 0;
    vi.mocked(mockDbSelect).mockImplementation(() => {
      selectIdx++;
      if (selectIdx <= 2) return makeSelectChain([siteRow]);
      if (selectIdx === 3) return makeSelectChain([purchaseRow]);
      return makeSelectChain([]);
    });

    // db.update: all updates succeed and .returning() yields 1 row (CAS won)
    vi.mocked(mockDbUpdate).mockImplementation(() => makeUpdateChain([{ id: "purchase-fh" }]));

    mockStripeRefundsCreate.mockResolvedValueOnce({ id: "re_fh_win" });

    const { POST } = await import("@/app/api/pipeline/stage/route");
    const res = await POST(makeStageRequest());

    expect(res.status).toBe(200);

    // Fix F: CAS won → Stripe refund MUST be called
    expect(mockStripeRefundsCreate).toHaveBeenCalledWith({
      payment_intent: "pi_fh_test",
      amount: 1000,
    });
  });

  it("CAS lost: stripe.refunds.create is NOT called when .returning() returns empty (race partner won)", async () => {
    vi.clearAllMocks();

    let selectIdx = 0;
    vi.mocked(mockDbSelect).mockImplementation(() => {
      selectIdx++;
      if (selectIdx <= 2) return makeSelectChain([siteRow]);
      if (selectIdx === 3) return makeSelectChain([purchaseRow]);
      return makeSelectChain([]);
    });

    // db.update sequence:
    //   1. updateStatus → UPDATE geoSites "discovery" (handleDiscover before discoverSite throws)
    //   2. markFailed → UPDATE geoSites "failed"
    //   3. markFailed → UPDATE auditPurchases set "failed" (pre-CAS step)
    //   4. markFailed → UPDATE auditPurchases CAS "refund_pending" .returning() — race lost → []
    let updateIdx = 0;
    vi.mocked(mockDbUpdate).mockImplementation(() => {
      updateIdx++;
      if (updateIdx <= 3) {
        // All non-CAS updates succeed
        return makeUpdateChain([{ id: "purchase-fh" }]);
      }
      // CAS "refund_pending" update — race lost, .returning() returns empty
      return makeUpdateChain([]);
    });

    const { POST } = await import("@/app/api/pipeline/stage/route");
    const res = await POST(makeStageRequest("site-fh-race"));

    expect(res.status).toBe(200);

    // Fix F: CAS lost → Stripe refund must NOT be called
    expect(mockStripeRefundsCreate).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fix I — customerEmail redacted in structured logs
// ═══════════════════════════════════════════════════════════════════════════════

describe("Fix I — customerEmail redacted (hashed) in structured logs", () => {
  it("console.log in webhook does NOT contain raw email, only emailHash", async () => {
    vi.clearAllMocks();
    vi.mocked(mockDbSelect).mockReturnValue(makeSelectChain([]));
    vi.mocked(mockDbInsert).mockReturnValue(makeInsertChain());
    vi.mocked(mockDbUpdate).mockReturnValue(makeUpdateChain());
    mockCreateUser.mockResolvedValue({ data: { user: { id: "u-i-test" } }, error: null });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_i_test",
          payment_status: "paid",
          payment_intent: "pi_i_test",
          mode: "payment",
          metadata: { type: "audit_purchase" },
          customer_details: { email: "buyer@example.com" },
          customer_email: null,
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    const mod = await import("@/app/api/webhooks/stripe/route");
    await mod.POST(makeStripeWebhookRequest(event));

    // Check all console.log calls
    const logMessages = logSpy.mock.calls.map((c) => {
      try { return JSON.parse(c[0] as string); } catch { return {}; }
    });

    // No log should contain the raw email
    for (const msg of logMessages) {
      if (typeof msg === "object" && msg !== null) {
        expect(msg).not.toHaveProperty("customerEmail");
        // If it has emailHash, it should be a 16-char hex string
        if ("emailHash" in msg) {
          expect(typeof msg.emailHash).toBe("string");
          expect((msg.emailHash as string).length).toBe(16);
          expect((msg.emailHash as string)).toMatch(/^[0-9a-f]{16}$/);
        }
      }
    }

    logSpy.mockRestore();
  });
});
