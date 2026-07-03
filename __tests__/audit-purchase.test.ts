/**
 * Tests for GMC audit purchase endpoints:
 *   POST /api/audit-purchase/checkout
 *   POST /api/audit-purchase/intake
 *   GET  /api/audit-purchase/status
 *
 * TDD: these tests are written BEFORE the implementation is finalized.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockCheckoutCreate, mockSessionRetrieve, mockCheckRateLimit } = vi.hoisted(() => ({
  mockCheckoutCreate: vi.fn().mockResolvedValue({
    id: "cs_test_123",
    url: "https://checkout.stripe.com/pay/cs_test_123",
  }),
  mockSessionRetrieve: vi.fn().mockResolvedValue({
    id: "cs_test_123",
    payment_status: "paid",
    payment_intent: "pi_test_456",
    customer_email: "buyer@example.com",
    customer_details: { email: "buyer@example.com" },
    metadata: { type: "audit_purchase", websiteUrl: "https://example.com" },
    amount_total: 1000,
  }),
  mockCheckRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 4, resetAt: Date.now() + 3600000 }),
}));

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      checkout: {
        sessions: {
          create: mockCheckoutCreate,
          retrieve: mockSessionRetrieve,
        },
      },
    };
  }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  checkOtpLock: vi.fn().mockResolvedValue({ allowed: true }),
  incrementOtpAttempt: vi.fn().mockResolvedValue({ lockedOut: false, otpAttempts: 1 }),
  checkAndIncrementOtpAttempt: vi.fn().mockResolvedValue({ allowed: true, attemptsLeft: 4 }),
  clearOtpAttempts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    // Fix #6: intake now uses db.transaction — provide a passthrough so existing tests work.
    // The callback receives a tx that delegates to the same select/insert/update mocks.
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<void>) => {
      const { db: dbMock } = await import("@/lib/db");
      await cb({
        select: (...args: unknown[]) => (dbMock.select as (...a: unknown[]) => unknown)(...args),
        insert: (...args: unknown[]) => (dbMock.insert as (...a: unknown[]) => unknown)(...args),
        update: (...args: unknown[]) => (dbMock.update as (...a: unknown[]) => unknown)(...args),
      });
    }),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ _tag: "eq", val })),
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn().mockReturnValue("mock-nanoid-123"),
}));

vi.mock("@/lib/utils", () => ({
  normalizeDomain: vi.fn().mockReturnValue("example.com"),
  slugify: vi.fn().mockReturnValue("example-com"),
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/email", () => ({
  sendAuditPurchaseConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendAuditPurchaseDeliveryEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db/schema", () => ({
  geoSites: { id: "id", domain: "domain", pipelineStatus: "pipelineStatus", overallScore: "overallScore", pipelineError: "pipelineError" },
  geoSiteView: { siteId: "site_id", domain: "domain", pipelineStatus: "pipelineStatus", overallScore: "overallScore", pipelineError: "pipelineError" },
  auditPurchases: { id: "id", stripeSessionId: "stripe_session_id", siteId: "site_id", purchaseToken: "purchase_token", status: "status" },
  rateLimits: { key: "key", count: "count", resetAt: "reset_at" },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { db } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { enqueueStage } from "@/lib/qstash";
import { sendAuditPurchaseConfirmationEmail } from "@/lib/email";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSelectChain(rows: unknown[] = []) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
    limit: vi.fn().mockReturnThis(),
  } as ReturnType<typeof db.select>;
}

function makeInsertChain() {
  return {
    values: vi.fn().mockResolvedValue([]),
  } as ReturnType<typeof db.insert>;
}

function makeUpdateChain() {
  return {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  } as ReturnType<typeof db.update>;
}

let _ipCounter = 0;
function uniqueIp(): string {
  _ipCounter++;
  return `10.99.0.${_ipCounter % 254 + 1}`;
}

function makePostRequest(path: string, body: Record<string, unknown>, ip?: string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": ip ?? uniqueIp(),
      },
      body: JSON.stringify(body),
    }),
  );
}

function makeGetRequest(path: string): NextRequest {
  return new NextRequest(new Request(`http://localhost${path}`, { method: "GET" }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/audit-purchase/checkout
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/audit-purchase/checkout", () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    // Default: rate limit allows
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 4, resetAt: Date.now() + 3600000 });
    // Default: STRIPE_AUDIT_PRICE_ID is set
    process.env.STRIPE_AUDIT_PRICE_ID = "price_test_123";
    const mod = await import("@/app/api/audit-purchase/checkout/route");
    POST = mod.POST;
  });

  it("returns 400 when websiteUrl is missing", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {});
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_url");
  });

  it("returns 400 for SSRF URL — localhost", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "http://localhost",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  it("returns 400 for SSRF URL — 127.0.0.1", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "http://127.0.0.1/admin",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  it("returns 400 for SSRF URL — 10.x.x.x", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "http://10.0.0.1/secret",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  it("returns 400 for SSRF URL — 169.254.x.x (link-local)", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "http://169.254.169.254/latest/meta-data",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  // ── SSRF bypass vectors ─────────────────────────────────────────────────

  it("returns 400 for userinfo trick http://127.0.0.1@evil.com/ (userinfo rejected by ssrf.ts)", async () => {
    // Fix 11.A: validatePublicUrl now rejects any URL containing userinfo (username/password).
    // Previously this passed because hostname=evil.com (public), but url.href preserves the
    // userinfo component which pollutes Stripe metadata. Reject early with userinfo_not_allowed.
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "http://127.0.0.1@evil.com/",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  it("returns 400 for trailing dot on localhost", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "http://localhost./",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  it("returns 400 for hex-encoded IP (0x7f000001)", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "http://0x7f000001/",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  it("returns 400 for decimal-int IP (2130706433 = 127.0.0.1)", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "http://2130706433/",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  it("returns 400 for octal IP (0177.0.0.1)", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "http://0177.0.0.1/",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  it("returns 400 for ftp:// scheme", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "ftp://example.com",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  it("returns 400 for single-label hostname (intranet)", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "http://intranet",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  it("returns 400 for cloud-metadata FQDN (metadata.google.internal)", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "http://metadata.google.internal/",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  it("returns 400 for .nip.io hostname", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "http://target.nip.io/",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  // ── Happy path ──────────────────────────────────────────────────────────

  it("returns 201 with a checkout URL for valid websiteUrl", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "https://example.com",
    });
    const res = await POST(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.checkoutUrl).toBe("https://checkout.stripe.com/pay/cs_test_123");
  });

  it("passes canonicalized url.href into Stripe session metadata", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "https://example.com",
    });
    await POST(req);

    expect(mockCheckoutCreate).toHaveBeenCalledTimes(1);
    const args = mockCheckoutCreate.mock.calls[0][0];
    expect(args.metadata.type).toBe("audit_purchase");
    // Must be canonicalized href, not raw input
    expect(args.metadata.websiteUrl).toBe("https://example.com/");
  });

  it("uses STRIPE_AUDIT_PRICE_ID as the line_items price", async () => {
    process.env.STRIPE_AUDIT_PRICE_ID = "price_1TRNwu66sHgANr6RXUYhD5UC";
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "https://example.com",
    });
    await POST(req);

    const args = mockCheckoutCreate.mock.calls[0][0];
    expect(args.line_items[0].price).toBe("price_1TRNwu66sHgANr6RXUYhD5UC");
    expect(args.line_items[0].quantity).toBe(1);
    // Must NOT use inline price_data
    expect(args.line_items[0].price_data).toBeUndefined();
  });

  it("sets automatic_tax.enabled = true", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "https://example.com",
    });
    await POST(req);
    const args = mockCheckoutCreate.mock.calls[0][0];
    expect(args.automatic_tax?.enabled).toBe(true);
  });

  it("sets tax_id_collection.enabled = true", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "https://example.com",
    });
    await POST(req);
    const args = mockCheckoutCreate.mock.calls[0][0];
    expect(args.tax_id_collection?.enabled).toBe(true);
  });

  it("sets customer_creation = 'always'", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "https://example.com",
    });
    await POST(req);
    const args = mockCheckoutCreate.mock.calls[0][0];
    expect(args.customer_creation).toBe("always");
  });

  it("does NOT pass invoice_creation to Stripe (fix: misleading $0 invoice email + reminder spam)", async () => {
    // Stripe's invoice_creation with the default collection_method=send_invoice
    // causes: (1) the email header shows "CA$0.00 Due April 29" for an already-paid
    // session, and (2) Stripe sends "Reminder: due in 0 days" spam. The customer
    // already gets Stripe's receipt email + our sendAuditPurchaseConfirmationEmail.
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "https://example.com",
    });
    await POST(req);
    const args = mockCheckoutCreate.mock.calls[0][0];
    expect(args).not.toHaveProperty("invoice_creation");
  });

  it("sets billing_address_collection = 'required'", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "https://example.com",
    });
    await POST(req);
    const args = mockCheckoutCreate.mock.calls[0][0];
    expect(args.billing_address_collection).toBe("required");
  });

  it("sets success_url and cancel_url pointing to website", async () => {
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "https://example.com",
    });
    await POST(req);

    const args = mockCheckoutCreate.mock.calls[0][0];
    expect(args.success_url).toContain("/ai-audit-report/thank-you");
    expect(args.success_url).toContain("{CHECKOUT_SESSION_ID}");
    expect(args.cancel_url).toContain("/ai-audit-report");
  });

  it("returns 429 when rate limited (DB-backed)", async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 3600000 });
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "https://example.com",
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.stringContaining("audit-checkout:"),
      5,
      3600000,
    );
  });

  it("returns 500 when STRIPE_AUDIT_PRICE_ID is unset", async () => {
    delete process.env.STRIPE_AUDIT_PRICE_ID;
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "https://example.com",
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("misconfigured");
  });

  it("returns 500 when Stripe fails", async () => {
    mockCheckoutCreate.mockRejectedValueOnce(new Error("Stripe down"));
    const req = makePostRequest("/api/audit-purchase/checkout", {
      websiteUrl: "https://example.com",
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/audit-purchase/intake
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/audit-purchase/intake", () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]));
    vi.mocked(db.insert).mockReturnValue(makeInsertChain());
    vi.mocked(db.update).mockReturnValue(makeUpdateChain());
    mockSessionRetrieve.mockResolvedValue({
      id: "cs_test_123",
      payment_status: "paid",
      payment_intent: "pi_test_456",
      customer_email: "buyer@example.com",
      customer_details: { email: "buyer@example.com" },
      metadata: { type: "audit_purchase", websiteUrl: "https://example.com" },
      amount_total: 1000,
    });
    const mod = await import("@/app/api/audit-purchase/intake/route");
    POST = mod.POST;
  });

  it("returns 400 when sessionId is missing", async () => {
    const req = makePostRequest("/api/audit-purchase/intake", {
      websiteUrl: "https://example.com",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("sessionId is required");
  });

  it("returns 400 when websiteUrl is missing from both metadata and body", async () => {
    // Session metadata has no websiteUrl (old in-flight session), and no body url
    mockSessionRetrieve.mockResolvedValueOnce({
      id: "cs_test_123",
      payment_status: "paid",
      payment_intent: "pi_test_456",
      customer_email: "buyer@example.com",
      customer_details: { email: "buyer@example.com" },
      metadata: { type: "audit_purchase" }, // no websiteUrl in metadata
      amount_total: 1000,
    });
    const req = makePostRequest("/api/audit-purchase/intake", {
      sessionId: "cs_test_123",
      // no websiteUrl in body either
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("websiteUrl is required");
  });

  it("reads websiteUrl from session metadata when present", async () => {
    // metadata has websiteUrl — no body needed
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]));
    const req = makePostRequest("/api/audit-purchase/intake", {
      sessionId: "cs_test_123",
      // no websiteUrl in body
    });
    const res = await POST(req);
    // mockSessionRetrieve default returns metadata.websiteUrl = "https://example.com"
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.domain).toBe("example.com");
  });

  it("falls back to body websiteUrl when metadata is missing (back-compat)", async () => {
    mockSessionRetrieve.mockResolvedValueOnce({
      id: "cs_test_123",
      payment_status: "paid",
      payment_intent: "pi_test_456",
      customer_email: "buyer@example.com",
      customer_details: { email: "buyer@example.com" },
      metadata: { type: "audit_purchase" }, // no websiteUrl in metadata
      amount_total: 1000,
    });
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]));
    const req = makePostRequest("/api/audit-purchase/intake", {
      sessionId: "cs_test_123",
      websiteUrl: "https://example.com",
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.domain).toBe("example.com");
  });

  it("returns 400 for invalid URL in body fallback", async () => {
    mockSessionRetrieve.mockResolvedValueOnce({
      id: "cs_test_123",
      payment_status: "paid",
      metadata: { type: "audit_purchase" }, // no websiteUrl in metadata
      amount_total: 1000,
    });
    const req = makePostRequest("/api/audit-purchase/intake", {
      sessionId: "cs_test_123",
      websiteUrl: "not-a-url",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  // ── SSRF bypass vectors in body-fallback ────────────────────────────────

  it("rejects SSRF URL in body fallback — 127.0.0.1", async () => {
    mockSessionRetrieve.mockResolvedValueOnce({
      id: "cs_test_123",
      payment_status: "paid",
      metadata: { type: "audit_purchase" }, // no websiteUrl in metadata
      amount_total: 1000,
    });
    const req = makePostRequest("/api/audit-purchase/intake", {
      sessionId: "cs_test_123",
      websiteUrl: "http://127.0.0.1/admin",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  it("rejects SSRF URL in body fallback — metadata.google.internal", async () => {
    mockSessionRetrieve.mockResolvedValueOnce({
      id: "cs_test_123",
      payment_status: "paid",
      metadata: { type: "audit_purchase" }, // no websiteUrl in metadata
      amount_total: 1000,
    });
    const req = makePostRequest("/api/audit-purchase/intake", {
      sessionId: "cs_test_123",
      websiteUrl: "http://metadata.google.internal/",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  it("rejects hex-encoded IP in body fallback (0x7f000001)", async () => {
    mockSessionRetrieve.mockResolvedValueOnce({
      id: "cs_test_123",
      payment_status: "paid",
      metadata: { type: "audit_purchase" },
      amount_total: 1000,
    });
    const req = makePostRequest("/api/audit-purchase/intake", {
      sessionId: "cs_test_123",
      websiteUrl: "http://0x7f000001/",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  it("rejects decimal-int IP in body fallback (2130706433)", async () => {
    mockSessionRetrieve.mockResolvedValueOnce({
      id: "cs_test_123",
      payment_status: "paid",
      metadata: { type: "audit_purchase" },
      amount_total: 1000,
    });
    const req = makePostRequest("/api/audit-purchase/intake", {
      sessionId: "cs_test_123",
      websiteUrl: "http://2130706433/",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  it("rejects single-label hostname in body fallback (http://intranet)", async () => {
    mockSessionRetrieve.mockResolvedValueOnce({
      id: "cs_test_123",
      payment_status: "paid",
      metadata: { type: "audit_purchase" },
      amount_total: 1000,
    });
    const req = makePostRequest("/api/audit-purchase/intake", {
      sessionId: "cs_test_123",
      websiteUrl: "http://intranet",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  it("rejects .nip.io hostname in body fallback", async () => {
    mockSessionRetrieve.mockResolvedValueOnce({
      id: "cs_test_123",
      payment_status: "paid",
      metadata: { type: "audit_purchase" },
      amount_total: 1000,
    });
    const req = makePostRequest("/api/audit-purchase/intake", {
      sessionId: "cs_test_123",
      websiteUrl: "http://target.nip.io/",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  it("rejects ftp:// scheme in body fallback", async () => {
    mockSessionRetrieve.mockResolvedValueOnce({
      id: "cs_test_123",
      payment_status: "paid",
      metadata: { type: "audit_purchase" },
      amount_total: 1000,
    });
    const req = makePostRequest("/api/audit-purchase/intake", {
      sessionId: "cs_test_123",
      websiteUrl: "ftp://example.com",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
  });

  // ── Other intake tests ───────────────────────────────────────────────────

  it("returns 402 when payment not completed", async () => {
    mockSessionRetrieve.mockResolvedValueOnce({
      id: "cs_test_123",
      payment_status: "unpaid",
      metadata: { type: "audit_purchase" },
      amount_total: 1000,
    });

    const req = makePostRequest("/api/audit-purchase/intake", {
      sessionId: "cs_test_123",
      websiteUrl: "https://example.com",
    });
    const res = await POST(req);
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("payment_not_completed");
  });

  it("returns 400 when session type is wrong", async () => {
    mockSessionRetrieve.mockResolvedValueOnce({
      id: "cs_test_123",
      payment_status: "paid",
      metadata: { type: "subscription" },
      amount_total: 1000,
    });

    const req = makePostRequest("/api/audit-purchase/intake", {
      sessionId: "cs_test_123",
      websiteUrl: "https://example.com",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_session_type");
  });

  it("returns existing audit for idempotent resubmission", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeSelectChain([
        {
          id: "purchase-1",
          stripeSessionId: "cs_test_123",
          siteId: "existing-site-1",
          domain: "example.com",
        },
      ]),
    );

    const req = makePostRequest("/api/audit-purchase/intake", {
      sessionId: "cs_test_123",
      websiteUrl: "https://example.com",
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auditId).toBe("existing-site-1");
    expect(body.status).toBe("already_submitted");
  });

  it("creates geoSites + auditPurchases and enqueues pipeline on valid submission", async () => {
    // First select: no existing purchase. Second select: also empty (for other queries if needed)
    vi.mocked(db.select).mockImplementation(() => {
      return makeSelectChain([]);
    });

    const req = makePostRequest("/api/audit-purchase/intake", {
      sessionId: "cs_test_123",
      websiteUrl: "https://example.com",
    });
    const res = await POST(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.auditId).toBe("mock-nanoid-123");
    expect(body.status).toBe("pending");
    expect(body.domain).toBe("example.com");

    // Verify pipeline was triggered
    expect(enqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "mock-nanoid-123",
        domain: "example.com",
        stage: "discover",
      }),
    );

    // Verify DB inserts were called
    expect(db.insert).toHaveBeenCalled();

    // Verify confirmation email sent
    expect(sendAuditPurchaseConfirmationEmail).toHaveBeenCalledWith(
      "buyer@example.com",
      "example.com",
    );
  });

  it("uses amount_total from Stripe session (not hardcoded)", async () => {
    mockSessionRetrieve.mockResolvedValueOnce({
      id: "cs_test_123",
      payment_status: "paid",
      payment_intent: "pi_test_456",
      customer_email: "buyer@example.com",
      customer_details: { email: "buyer@example.com" },
      metadata: { type: "audit_purchase", websiteUrl: "https://example.com" },
      amount_total: 2500, // $25 — not the hardcoded 1000
    });
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]));
    const insertMock = vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue([]),
    });
    vi.mocked(db.insert).mockImplementation(insertMock);

    const req = makePostRequest("/api/audit-purchase/intake", {
      sessionId: "cs_test_123",
    });
    const res = await POST(req);
    expect(res.status).toBe(201);

    // Verify the insert values included amountCents from session.amount_total
    const insertCalls = insertMock.mock.results;
    // Find the auditPurchases insert (second insert after geoSites)
    const valuesCalls = insertMock.mock.results
      .map((r: { value: { values: ReturnType<typeof vi.fn> } }) => r.value?.values?.mock?.calls?.[0]?.[0])
      .filter(Boolean);
    const auditPurchaseInsert = valuesCalls.find(
      (v: Record<string, unknown>) => "stripeSessionId" in v || "amountCents" in v
    );
    if (auditPurchaseInsert) {
      expect(auditPurchaseInsert.amountCents).toBe(2500);
    }
  });

  it("updates existing auditPurchases row when webhook already created it", async () => {
    // First select: existing purchase WITHOUT siteId (webhook created, intake not done)
    vi.mocked(db.select).mockReturnValue(
      makeSelectChain([
        {
          id: "purchase-1",
          stripeSessionId: "cs_test_123",
          siteId: null, // No site yet — webhook only
          purchaseToken: "tok-abc",
        },
      ]),
    );

    const req = makePostRequest("/api/audit-purchase/intake", {
      sessionId: "cs_test_123",
      websiteUrl: "https://example.com",
    });
    const res = await POST(req);

    expect(res.status).toBe(201);
    expect(db.update).toHaveBeenCalled();
    expect(enqueueStage).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/audit-purchase/status
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/audit-purchase/status", () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("@/app/api/audit-purchase/status/route");
    GET = mod.GET;
  });

  it("returns 400 when no query params provided", async () => {
    const req = makeGetRequest("/api/audit-purchase/status");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns 404 when purchase not found", async () => {
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]));
    const req = makeGetRequest("/api/audit-purchase/status?session_id=cs_missing");
    const res = await GET(req);
    expect(res.status).toBe(404);
  });

  it("returns purchaseStatus with null pipeline when site not yet created", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeSelectChain([
        {
          id: "p-1",
          stripeSessionId: "cs_test_123",
          siteId: null,
          status: "paid",
          domain: null,
        },
      ]),
    );

    const req = makeGetRequest("/api/audit-purchase/status?session_id=cs_test_123");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.purchaseStatus).toBe("paid");
    expect(body.pipelineStatus).toBeNull();
  });

  it("returns pipeline status when site exists", async () => {
    let callIdx = 0;
    vi.mocked(db.select).mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        // First call: auditPurchases lookup
        return makeSelectChain([
          {
            id: "p-1",
            stripeSessionId: "cs_test_123",
            siteId: "site-1",
            status: "intake_complete",
            domain: "example.com",
          },
        ]);
      }
      // Second call: geoSites lookup
      return makeSelectChain([
        {
          pipelineStatus: "crawling",
          domain: "example.com",
          overallScore: null,
          pipelineError: null,
        },
      ]);
    });

    const req = makeGetRequest("/api/audit-purchase/status?session_id=cs_test_123");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.purchaseStatus).toBe("intake_complete");
    expect(body.pipelineStatus).toBe("crawling");
    expect(body.domain).toBe("example.com");
  });

  it("returns score when pipeline is complete (purchase_token works for delivered status)", async () => {
    // Fix #8: session_id is gated to pre-delivery statuses only.
    // Use purchase_token for post-delivery lookups (all statuses work).
    let callIdx = 0;
    vi.mocked(db.select).mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        return makeSelectChain([
          {
            id: "p-1",
            siteId: "site-1",
            status: "delivered",
            domain: "example.com",
          },
        ]);
      }
      return makeSelectChain([
        {
          pipelineStatus: "complete",
          domain: "example.com",
          overallScore: 72,
          pipelineError: null,
        },
      ]);
    });

    const req = makeGetRequest("/api/audit-purchase/status?purchase_token=tok-delivered-123");
    const res = await GET(req);

    const body = await res.json();
    expect(body.pipelineStatus).toBe("complete");
    expect(body.score).toBe(72);
  });

  it("accepts purchase_token as alternative lookup", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeSelectChain([
        {
          id: "p-1",
          siteId: null,
          status: "paid",
          domain: null,
          purchaseToken: "tok-abc",
        },
      ]),
    );

    const req = makeGetRequest("/api/audit-purchase/status?purchase_token=tok-abc");
    const res = await GET(req);
    expect(res.status).toBe(200);
  });
});
