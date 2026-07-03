/**
 * Tests for POST /api/subscription-signup/checkout/route.ts
 *
 * Unauthenticated, payment-first RECURRING subscription checkout. Key behaviour:
 *   - Valid {email, websiteUrl, plan, interval} → 201 + checkoutUrl, mode:"subscription"
 *   - metadata.type === "subscription_signup" stamped on session AND subscription_data
 *   - Invalid plan (pro / bogus) → 400; invalid interval/email/url → 400
 *   - plan/interval with no configured price id → 400
 *   - Rate-limit → 429; Stripe throws → 500
 *   - Never requires authentication
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockSessionsCreate,
  mockCheckRateLimit,
  mockValidatePublicUrl,
  mockSignBinding,
  mockPriceIds,
} = vi.hoisted(() => ({
  mockSessionsCreate: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockValidatePublicUrl: vi.fn(),
  mockSignBinding: vi.fn(),
  // Mutable so a test can blank out a price id. config.ts reads process.env at
  // module-load, so env-based price ids can't be set in beforeEach — mock instead.
  mockPriceIds: {
    monthly: { starter: "price_starter_monthly", growth: "price_growth_monthly", pro: "" },
    quarterly: { starter: "price_starter_quarterly", growth: "price_growth_quarterly", pro: "" },
    annual: { starter: "", growth: "", pro: "price_pro_annual" },
  } as Record<string, Record<string, string>>,
}));

vi.mock("stripe", () => ({
  default: vi.fn(function () {
    return { checkout: { sessions: { create: mockSessionsCreate } } };
  }),
}));

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock("@/lib/ssrf", () => ({ validatePublicUrl: mockValidatePublicUrl }));
vi.mock("@/lib/checkout-binding", () => ({
  signCheckoutBinding: mockSignBinding,
  CHECKOUT_BINDING_METADATA_KEY: "fb_bind",
}));
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, STRIPE_PRICE_IDS: mockPriceIds };
});

import { POST } from "@/app/api/subscription-signup/checkout/route";

function makeRequest(body: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/subscription-signup/checkout", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.4" },
  });
}

const VALID_URL = "https://example.com/";
const VALID_BODY = {
  email: "buyer@example.com",
  websiteUrl: "https://example.com",
  plan: "starter",
  interval: "monthly",
};

describe("POST /api/subscription-signup/checkout", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.WEBSITE_URL = "https://www.example.com";
    // Reset mutable price-id map each test
    mockPriceIds.monthly = { starter: "price_starter_monthly", growth: "price_growth_monthly", pro: "" };
    mockPriceIds.quarterly = { starter: "price_starter_quarterly", growth: "price_growth_quarterly", pro: "" };
    mockPriceIds.annual = { starter: "", growth: "", pro: "price_pro_annual" };

    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockValidatePublicUrl.mockReturnValue({ ok: true, url: new URL(VALID_URL) });
    mockSignBinding.mockReturnValue("deadbeef");
    mockSessionsCreate.mockResolvedValue({
      id: "cs_test_123",
      url: "https://checkout.stripe.com/pay/cs_test_123",
    });
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("returns 201 with checkoutUrl on valid request", async () => {
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.checkoutUrl).toBe("https://checkout.stripe.com/pay/cs_test_123");
  });

  it("creates a recurring subscription session with signup metadata on both objects", async () => {
    await POST(makeRequest(VALID_BODY));
    expect(mockSessionsCreate).toHaveBeenCalledOnce();
    const [params] = mockSessionsCreate.mock.calls[0];
    expect(params.mode).toBe("subscription");
    expect(params.allow_promotion_codes).toBe(true);
    expect(params.customer_email).toBe("buyer@example.com");
    expect(params.line_items).toEqual([{ price: "price_starter_monthly", quantity: 1 }]);
    expect(params.metadata).toMatchObject({
      type: "subscription_signup",
      plan: "starter",
      interval: "monthly",
      websiteUrl: VALID_URL,
      fb_bind: "deadbeef",
    });
    expect(params.subscription_data.metadata).toMatchObject({
      type: "subscription_signup",
      plan: "starter",
      interval: "monthly",
    });
    expect(params.success_url).toContain("/ai-audit-report/thank-you");
    expect(params.success_url).toContain("plan=starter");
    expect(params.cancel_url).toContain("/pricing");
  });

  it("maps quarterly interval to the quarterly price id", async () => {
    await POST(makeRequest({ ...VALID_BODY, plan: "growth", interval: "quarterly" }));
    const [params] = mockSessionsCreate.mock.calls[0];
    expect(params.line_items).toEqual([{ price: "price_growth_quarterly", quantity: 1 }]);
  });

  it("rejects pro plan (sales-assisted, not direct-to-pay)", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, plan: "pro" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_plan");
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("rejects unknown plan", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, plan: "bogus" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_plan");
  });

  it("rejects annual interval for starter/growth (not sellable; no silent downgrade to monthly)", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, plan: "starter", interval: "annual" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_interval");
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("rejects a bogus interval string", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, interval: "biennial" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_interval");
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("rejects invalid email", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_email");
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when no price id is configured for the plan/interval", async () => {
    mockPriceIds.monthly.starter = "";
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("plan_unavailable_for_interval");
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when websiteUrl fails SSRF validation", async () => {
    mockValidatePublicUrl.mockReturnValue({ ok: false, error: "Private IP" });
    const res = await POST(makeRequest({ ...VALID_BODY, websiteUrl: "http://192.168.1.1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_url");
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("returns 429 when per-IP rate limit is exceeded", async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfter: 3600 });
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(429);
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("returns 429 when per-email rate limit is exceeded (IP check passes, email check fails)", async () => {
    // First call = per-IP check → allowed; second call = per-email check → blocked.
    mockCheckRateLimit
      .mockResolvedValueOnce({ allowed: true, remaining: 10, resetAt: Date.now() + 60000 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 3600000 });
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(429);
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("enforces per-email limit independently of IP — same email from different IPs is blocked after limit", async () => {
    // Simulate 3 requests from different IPs that all pass the IP check, but the
    // email bucket is exhausted on the 4th. We drive this through the mock: the
    // first three pairs (IP ok, email ok) succeed; the fourth pair (IP ok, email
    // blocked) should 429.
    const makeRequestFromIp = (ip: string) =>
      new NextRequest("http://localhost/api/subscription-signup/checkout", {
        method: "POST",
        body: JSON.stringify(VALID_BODY),
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      });

    // Requests 1-3: both checks pass (email bucket not yet exhausted)
    for (let i = 0; i < 3; i++) {
      mockCheckRateLimit
        .mockResolvedValueOnce({ allowed: true, remaining: 14 - i, resetAt: Date.now() + 60000 })
        .mockResolvedValueOnce({ allowed: true, remaining: 2 - i, resetAt: Date.now() + 3600000 });
      const res = await POST(makeRequestFromIp(`10.0.0.${i + 1}`));
      expect(res.status).toBe(201);
    }

    // Request 4: fresh IP (passes IP check), but email bucket is now exhausted
    mockCheckRateLimit
      .mockResolvedValueOnce({ allowed: true, remaining: 14, resetAt: Date.now() + 60000 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 3600000 });
    const res = await POST(makeRequestFromIp("10.0.0.99"));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("Too many requests");
  });

  it("calls checkRateLimit with the per-email key using lowercased canonical email", async () => {
    // Ensure the email key uses the lowercased form, not the raw input
    const reqWithMixedCase = new NextRequest("http://localhost/api/subscription-signup/checkout", {
      method: "POST",
      body: JSON.stringify({ ...VALID_BODY, email: "  BUYER@Example.COM  " }),
      headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.4" },
    });
    await POST(reqWithMixedCase);
    const calls = mockCheckRateLimit.mock.calls;
    // Second call should be the per-email check with the normalized key
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1][0]).toBe("sub-signup-email:buyer@example.com");
  });

  it("returns 500 when Stripe session create throws", async () => {
    mockSessionsCreate.mockRejectedValue(new Error("Stripe network error"));
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Internal server error");
  });

  it("uses the canonicalized URL (not raw input) in metadata", async () => {
    const canonical = "https://canonical.example.com/";
    mockValidatePublicUrl.mockReturnValue({ ok: true, url: new URL(canonical) });
    await POST(makeRequest({ ...VALID_BODY, websiteUrl: "https://CANONICAL.example.com" }));
    const [params] = mockSessionsCreate.mock.calls[0];
    expect(params.metadata.websiteUrl).toBe(canonical);
  });
});
