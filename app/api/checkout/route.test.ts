import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// vi.hoisted() runs before vi.mock() factories, making the variable available
// inside the mock factory even though vi.mock() calls are hoisted to the top.
const { mockSessionCreate } = vi.hoisted(() => ({
  mockSessionCreate: vi.fn(),
}));

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
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  isNull: vi.fn((_col: unknown) => ({ _isNull: _col })),
  sql: vi.fn(),
}));

// Mock Stripe — must be done before the route module is imported because
// the route instantiates `new Stripe(...)` at module scope.
// Must use `function` (not arrow) so `new Stripe()` works as a constructor.
vi.mock("stripe", () => ({
  default: vi.fn(function () {
    return {
      checkout: {
        sessions: {
          create: mockSessionCreate,
        },
      },
    };
  }),
}));

import { POST } from "./route";
import { getAuthenticatedUser } from "@/lib/supabase/authenticated-client";
import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_USER = { id: "user-1", email: "alice@example.com", token: "tok", tokenExpiry: null };
const MEMBERSHIP = {
  id: "mem-1",
  teamId: "team-1",
  userId: "user-1",
  email: "alice@example.com",
  role: "owner",
  inviteToken: null,
  inviteAcceptedAt: null,
  createdAt: new Date(),
};

function makeRequest(): NextRequest {
  return new NextRequest(
    new Request("http://localhost/api/checkout", { method: "POST" })
  );
}

function mockSelectResolving(rows: unknown[]) {
  const chain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(rows) };
  vi.mocked(db.select).mockReturnValue(chain as unknown as ReturnType<typeof db.select>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/checkout — authenticated user with team", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.NEXT_PUBLIC_APP_URL = "https://geo.example.com";
  });

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it("returns checkoutUrl from Stripe session", async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(MOCK_USER);
    mockSelectResolving([MEMBERSHIP]);
    mockSessionCreate.mockResolvedValue({ url: "https://checkout.stripe.com/test-session" });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as { checkoutUrl: string };
    expect(body.checkoutUrl).toBe("https://checkout.stripe.com/test-session");
  });

  it("passes teamId and userId in Stripe session metadata", async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(MOCK_USER);
    mockSelectResolving([MEMBERSHIP]);
    mockSessionCreate.mockResolvedValue({ url: "https://checkout.stripe.com/session" });

    await POST(makeRequest());

    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
    const sessionArgs = mockSessionCreate.mock.calls[0][0] as {
      metadata: { teamId: string; userId: string };
    };
    expect(sessionArgs.metadata.teamId).toBe("team-1");
    expect(sessionArgs.metadata.userId).toBe("user-1");
  });

  it("creates a payment-mode session for 100 credits at $10.00", async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(MOCK_USER);
    mockSelectResolving([MEMBERSHIP]);
    mockSessionCreate.mockResolvedValue({ url: "https://checkout.stripe.com/session" });

    await POST(makeRequest());

    const sessionArgs = mockSessionCreate.mock.calls[0][0] as {
      mode: string;
      line_items: Array<{ price_data: { unit_amount: number }; quantity: number }>;
    };
    expect(sessionArgs.mode).toBe("payment");
    expect(sessionArgs.line_items[0].price_data.unit_amount).toBe(1000); // $10.00 in cents
    expect(sessionArgs.line_items[0].quantity).toBe(1);
  });
});

describe("POST /api/checkout — unauthenticated user", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.NEXT_PUBLIC_APP_URL = "https://geo.example.com";
  });

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it("returns 401 for unauthenticated requests", async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(null);

    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/sign in/i);
  });

  it("does NOT call Stripe for unauthenticated requests", async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(null);

    await POST(makeRequest());
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("does NOT call db.select for unauthenticated requests", async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(null);

    await POST(makeRequest());
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe("POST /api/checkout — Stripe error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.NEXT_PUBLIC_APP_URL = "https://geo.example.com";
  });

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it("returns 500 when Stripe throws", async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(MOCK_USER);
    mockSelectResolving([MEMBERSHIP]);
    mockSessionCreate.mockRejectedValue(new Error("Stripe API unreachable"));

    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/internal server error/i);
  });

  it("uses NEXT_PUBLIC_APP_URL as base for success_url and cancel_url", async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(MOCK_USER);
    mockSelectResolving([MEMBERSHIP]);
    mockSessionCreate.mockResolvedValue({ url: "https://checkout.stripe.com/session" });

    await POST(makeRequest());

    const sessionArgs = mockSessionCreate.mock.calls[0][0] as {
      success_url: string;
      cancel_url: string;
    };
    expect(sessionArgs.success_url).toContain("https://geo.example.com");
    expect(sessionArgs.cancel_url).toContain("https://geo.example.com");
  });

  it("success_url returns to returnTo path with payment=success param", async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(MOCK_USER);
    mockSelectResolving([MEMBERSHIP]);
    mockSessionCreate.mockResolvedValue({ url: "https://checkout.stripe.com/session" });

    const req = new NextRequest(
      new Request("http://localhost/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ returnTo: "/sites/abc?token=xyz" }),
      })
    );

    await POST(req);

    const sessionArgs = mockSessionCreate.mock.calls[0][0] as {
      success_url: string;
      cancel_url: string;
    };
    expect(sessionArgs.success_url).toBe("https://geo.example.com/sites/abc?token=xyz&payment=success");
    expect(sessionArgs.cancel_url).toBe("https://geo.example.com/sites/abc?token=xyz");
  });
});
