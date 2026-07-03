/**
 * Tests for POST /api/audit-purchase/checkout/route.ts
 *
 * Key behaviour under test:
 *   - Valid request → 201 + checkoutUrl
 *   - invoice_creation MUST NOT be passed to stripe.checkout.sessions.create
 *     (fix for misleading "$0.00 due" invoice email + reminder spam)
 *   - Invalid / private websiteUrl → 400
 *   - Missing STRIPE_AUDIT_PRICE_ID env var → 500
 *   - Rate-limit exceeded → 429
 *   - Stripe session create throws → 500
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  mockSessionsCreate,
  mockCheckRateLimit,
  mockValidatePublicUrl,
} = vi.hoisted(() => ({
  mockSessionsCreate: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockValidatePublicUrl: vi.fn(),
}));

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("stripe", () => ({
  default: vi.fn(function () {
    return {
      checkout: {
        sessions: {
          create: mockSessionsCreate,
        },
      },
    };
  }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock("@/lib/ssrf", () => ({
  validatePublicUrl: mockValidatePublicUrl,
}));

// ─── Import route AFTER mocks ─────────────────────────────────────────────────

import { POST } from "@/app/api/audit-purchase/checkout/route";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/audit-purchase/checkout", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.4" },
  });
}

const VALID_URL = "https://example.com/";

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("POST /api/audit-purchase/checkout", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_AUDIT_PRICE_ID = "price_test_audit";
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.WEBSITE_URL = "https://www.example.com";

    // Default: rate limit allows, URL valid
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockValidatePublicUrl.mockReturnValue({ ok: true, url: new URL(VALID_URL) });
    mockSessionsCreate.mockResolvedValue({ id: "cs_test_123", url: "https://checkout.stripe.com/pay/cs_test_123" });
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  it("returns 201 with checkoutUrl on valid request", async () => {
    const res = await POST(makeRequest({ websiteUrl: "https://example.com" }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.checkoutUrl).toBe("https://checkout.stripe.com/pay/cs_test_123");
  });

  it("passes correct static params to stripe.checkout.sessions.create", async () => {
    await POST(makeRequest({ websiteUrl: "https://example.com" }));
    expect(mockSessionsCreate).toHaveBeenCalledOnce();
    const [params] = mockSessionsCreate.mock.calls[0];
    expect(params.mode).toBe("payment");
    expect(params.payment_method_types).toBeUndefined();
    expect(params.allow_promotion_codes).toBe(true);
    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.tax_id_collection).toEqual({ enabled: true });
    expect(params.customer_creation).toBe("always");
    expect(params.billing_address_collection).toBe("required");
    expect(params.line_items).toEqual([{ price: "price_test_audit", quantity: 1 }]);
    expect(params.metadata).toMatchObject({ type: "audit_purchase", websiteUrl: VALID_URL });
  });

  // ── Invoice UX fix ───────────────────────────────────────────────────────────

  it("does NOT pass invoice_creation to Stripe (fix: misleading $0 invoice email)", async () => {
    await POST(makeRequest({ websiteUrl: "https://example.com" }));
    expect(mockSessionsCreate).toHaveBeenCalledOnce();
    const [params] = mockSessionsCreate.mock.calls[0];
    // invoice_creation must be absent — if present Stripe sends a "CA$0.00 Due"
    // email + "Reminder: due in 0 days" spam for an already-paid session.
    expect(params).not.toHaveProperty("invoice_creation");
  });

  // ── Error paths ───────────────────────────────────────────────────────────────

  it("returns 500 when STRIPE_AUDIT_PRICE_ID is not set", async () => {
    delete process.env.STRIPE_AUDIT_PRICE_ID;
    const res = await POST(makeRequest({ websiteUrl: "https://example.com" }));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("misconfigured");
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limit is exceeded", async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfter: 3600 });
    const res = await POST(makeRequest({ websiteUrl: "https://example.com" }));
    expect(res.status).toBe(429);
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when websiteUrl fails SSRF validation", async () => {
    mockValidatePublicUrl.mockReturnValue({ ok: false, error: "Private IP address" });
    const res = await POST(makeRequest({ websiteUrl: "http://192.168.1.1" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_url");
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("returns 400 on missing websiteUrl", async () => {
    mockValidatePublicUrl.mockReturnValue({ ok: false, error: "Empty URL" });
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("returns 500 when Stripe session create throws", async () => {
    mockSessionsCreate.mockRejectedValue(new Error("Stripe network error"));
    const res = await POST(makeRequest({ websiteUrl: "https://example.com" }));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Internal server error");
  });

  // ── URL canonicalization ──────────────────────────────────────────────────────

  it("uses canonicalized URL from validatePublicUrl (not raw input)", async () => {
    const canonicalized = "https://canonical.example.com/";
    mockValidatePublicUrl.mockReturnValue({ ok: true, url: new URL(canonicalized) });
    await POST(makeRequest({ websiteUrl: "https://CANONICAL.example.com" }));
    expect(mockSessionsCreate).toHaveBeenCalledOnce();
    const [params] = mockSessionsCreate.mock.calls[0];
    expect(params.metadata.websiteUrl).toBe(canonicalized);
  });

  it("uses WEBSITE_URL env var for success_url and cancel_url", async () => {
    process.env.WEBSITE_URL = "https://custom.website.com";
    await POST(makeRequest({ websiteUrl: "https://example.com" }));
    const [params] = mockSessionsCreate.mock.calls[0];
    expect(params.success_url).toContain("https://custom.website.com");
    expect(params.cancel_url).toContain("https://custom.website.com");
  });
});
