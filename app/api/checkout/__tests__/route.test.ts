import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCheckoutSessionCreate = vi.fn();

vi.mock("stripe", () => {
  const StripeMock = function () {
    return {
      checkout: {
        sessions: { create: mockCheckoutSessionCreate },
      },
    };
  };
  return { default: StripeMock };
});

vi.mock("@/lib/supabase/authenticated-client", () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => ({ _eq: [_col, _val] })),
}));

vi.mock("@/lib/services/provision-team", () => ({
  ensureTeamForUser: vi.fn().mockResolvedValue({ teamId: "team-1" }),
}));

vi.mock("nanoid", () => ({ nanoid: vi.fn(() => "mock-id") }));

// Mock config to provide stable STRIPE_PRICE_IDS (env vars aren't set at import time)
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    STRIPE_PRICE_IDS: {
      monthly:   { starter: "price_starter_m", growth: "price_growth_m", pro: "price_pro_m" },
      quarterly: { starter: "price_starter_q", growth: "price_growth_q", pro: "price_pro_q" },
      annual:    { starter: "price_starter_a", growth: "price_growth_a", pro: "price_pro_a" },
    },
  };
});

// ─── Imports after mocks ────────────────────────────────────────────────────

import { POST } from "@/app/api/checkout/route";
import { getAuthenticatedUser } from "@/lib/supabase/authenticated-client";
import { db } from "@/lib/db";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/checkout", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function mockAuthUser() {
  vi.mocked(getAuthenticatedUser).mockResolvedValue({
    id: "user-1",
    email: "test@example.com",
    token: "tok",
    tokenExpiry: null,
  });
}

function makeSelectChain(resolvedValue: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(resolvedValue),
  };
}

function mockMembership(subscriptionTier = "starter") {
  // First call: teamMembers lookup
  const membershipChain = makeSelectChain([{ teamId: "team-1", userId: "user-1" }]);
  // Second call: teams subscriptionTier lookup (credit pack path only)
  const teamChain = makeSelectChain([{ subscriptionTier }]);
  vi.mocked(db.select)
    .mockReturnValueOnce(membershipChain as unknown as ReturnType<typeof db.select>)
    .mockReturnValue(teamChain as unknown as ReturnType<typeof db.select>);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("POST /api/checkout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthUser();
    mockMembership();
    mockCheckoutSessionCreate.mockResolvedValue({ url: "https://checkout.stripe.com/session_123" });

    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.NEXT_PUBLIC_APP_URL = "https://geo.flowblinq.com";
  });

  it("creates subscription checkout for plan=starter", async () => {
    const res = await POST(makeRequest({ plan: "starter" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.checkoutUrl).toBe("https://checkout.stripe.com/session_123");
    expect(mockCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        line_items: [{ price: "price_starter_m", quantity: 1 }],
      }),
    );
  });

  it("creates subscription checkout for plan=growth", async () => {
    await POST(makeRequest({ plan: "growth" }));
    expect(mockCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        line_items: [{ price: "price_growth_m", quantity: 1 }],
      }),
    );
  });

  it("creates subscription checkout for plan=pro", async () => {
    await POST(makeRequest({ plan: "pro" }));
    expect(mockCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        line_items: [{ price: "price_pro_m", quantity: 1 }],
      }),
    );
  });

  it("creates quarterly subscription checkout for plan=starter", async () => {
    const res = await POST(makeRequest({ plan: "starter", interval: "quarterly" }));
    expect(res.status).toBe(200);
    expect(mockCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        line_items: [{ price: "price_starter_q", quantity: 1 }],
      }),
    );
  });

  it("creates quarterly subscription checkout for plan=growth", async () => {
    await POST(makeRequest({ plan: "growth", interval: "quarterly" }));
    expect(mockCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_growth_q", quantity: 1 }],
      }),
    );
  });

  it("uses monthly price when interval is omitted", async () => {
    await POST(makeRequest({ plan: "starter" }));
    expect(mockCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_starter_m", quantity: 1 }],
      }),
    );
  });

  it("uses annual price when interval=annual", async () => {
    await POST(makeRequest({ plan: "starter", interval: "annual" }));
    expect(mockCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: "price_starter_a", quantity: 1 }],
      }),
    );
  });

  // Promo codes are allowed on every subscription interval. Coupons live as
  // amount_off (e.g. SITFREE1 = $99 USD / ₹8,499 INR off, duration: once),
  // so the original "100% off applied to a 3-month invoice = 3 months free"
  // exploit is closed at the coupon level. Quarterly customers get $99/₹8,499
  // off ≈ 1 month-equivalent worth of discount, intentional.
  it.each([
    { plan: "growth",  interval: "monthly"   },
    { plan: "growth",  interval: "quarterly" },
    { plan: "pro",     interval: "annual"    },
    { plan: "starter", interval: undefined   },
  ])(
    "allow_promotion_codes=true for plan=$plan interval=$interval",
    async ({ plan, interval }) => {
      mockMembership();
      const body: Record<string, unknown> = { plan };
      if (interval) body.interval = interval;
      await POST(makeRequest(body));
      expect(mockCheckoutSessionCreate).toHaveBeenLastCalledWith(
        expect.objectContaining({ allow_promotion_codes: true }),
      );
    },
  );

  it("falls back to one-time credit checkout when plan is absent", async () => {
    await POST(makeRequest({}));
    expect(mockCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "payment" }),
    );
  });

  it("falls back to one-time credit checkout for plan=credits", async () => {
    await POST(makeRequest({ plan: "credits" }));
    expect(mockCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "payment" }),
    );
  });

  it("returns 400 for plan=free", async () => {
    const res = await POST(makeRequest({ plan: "free" }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/free/i);
  });

  it("returns 400 for invalid plan name", async () => {
    const res = await POST(makeRequest({ plan: "enterprise" }));
    expect(res.status).toBe(400);
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(null);
    const res = await POST(makeRequest({ plan: "starter" }));
    expect(res.status).toBe(401);
  });

  // ── Fix #39: Credit-pack purchase requires active subscription ────────────

  it("returns 403 subscription_required when free-tier team tries to buy credit pack", async () => {
    vi.resetAllMocks();  // must reset (not just clear) to wipe mockReturnValue implementations
    mockAuthUser();
    mockMembership("free");
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.NEXT_PUBLIC_APP_URL = "https://geo.flowblinq.com";
    const res = await POST(makeRequest({ quantity: 5 }));
    expect(res.status).toBe(403);
    const data = await res.json() as { error: string };
    expect(data.error).toBe("subscription_required");
  });

  it("returns 403 subscription_required for plan=credits when free tier", async () => {
    vi.resetAllMocks();
    mockAuthUser();
    mockMembership("free");
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.NEXT_PUBLIC_APP_URL = "https://geo.flowblinq.com";
    const res = await POST(makeRequest({ plan: "credits", quantity: 3 }));
    expect(res.status).toBe(403);
    const data = await res.json() as { error: string };
    expect(data.error).toBe("subscription_required");
  });

  it("allows credit pack purchase for starter-tier team", async () => {
    vi.resetAllMocks();
    mockAuthUser();
    mockMembership("starter");
    mockCheckoutSessionCreate.mockResolvedValue({ url: "https://checkout.stripe.com/session_paid" });
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.NEXT_PUBLIC_APP_URL = "https://geo.flowblinq.com";
    const res = await POST(makeRequest({ quantity: 2 }));
    expect(res.status).toBe(200);
    const data = await res.json() as { checkoutUrl?: string };
    expect(data.checkoutUrl).toBe("https://checkout.stripe.com/session_paid");
  });

  it("allows credit pack purchase for pro-tier team", async () => {
    vi.resetAllMocks();
    mockAuthUser();
    mockMembership("pro");
    mockCheckoutSessionCreate.mockResolvedValue({ url: "https://checkout.stripe.com/session_pro" });
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.NEXT_PUBLIC_APP_URL = "https://geo.flowblinq.com";
    const res = await POST(makeRequest({ quantity: 1 }));
    expect(res.status).toBe(200);
    const data = await res.json() as { checkoutUrl?: string };
    expect(data.checkoutUrl).toBe("https://checkout.stripe.com/session_pro");
  });
});
