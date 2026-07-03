/**
 * TS-033 — New Customer Onboarding Hotfix
 * Tests T1–T6 covering three route fixes:
 *   - POST /api/sites: remove !isProMember gate from single-domain path
 *   - POST /api/webhooks/stripe: fail loudly (500) when teamId/userId missing
 *   - POST /api/checkout: guard against missing teamId before Stripe session
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mock refs (must be hoisted — vi.mock factory runs before module scope) ──

const { mockConstructEvent, mockCreateSession } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockCreateSession:  vi.fn(),
}));

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("stripe", () => ({
  // Must use regular function, not arrow — arrow functions can't be `new`-ed
  default: vi.fn().mockImplementation(function() {
    return {
      webhooks: { constructEvent: mockConstructEvent },
      checkout: { sessions: { create: mockCreateSession } },
    };
  }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select:      vi.fn(),
    insert:      vi.fn(),
    update:      vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("nanoid", () => ({ nanoid: vi.fn().mockReturnValue("mock-id") }));

vi.mock("@/lib/email", () => ({
  generateVerificationCode: vi.fn().mockReturnValue("123456"),
  hashCode:                 vi.fn().mockReturnValue("hashed"),
  sendVerificationEmail:    vi.fn().mockResolvedValue(undefined),
  sendLowCreditsEmail:      vi.fn().mockResolvedValue(undefined),
  sendInternalSignupAlert:  vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 5, resetAt: Date.now() + 60000 }),
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/supabase/authenticated-client", () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock("@/lib/services/provision-team", () => ({
  ensureTeamForUser: vi.fn().mockResolvedValue({ teamId: "auto-team-1" }),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { POST as postSites }    from "@/app/api/sites/route";
import { POST as postWebhook }  from "@/app/api/webhooks/stripe/route";
import { POST as postCheckout } from "@/app/api/checkout/route";
import { db } from "@/lib/db";
import { getAuthenticatedUser } from "@/lib/supabase/authenticated-client";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSelectChain(rows: unknown[] = []) {
  return {
    from:  vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
}

function makeInsertChain() {
  return { values: vi.fn().mockResolvedValue([]) };
}

function makeSitesReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest(new Request("http://localhost/api/sites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function makeWebhookReq(): NextRequest {
  return new NextRequest(new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "sig123" },
    body: "raw-stripe-body",
  }));
}

function makeCheckoutReq(): NextRequest {
  return new NextRequest(new Request("http://localhost/api/checkout", { method: "POST" }));
}

// ─── T1-T2: POST /api/sites — !isProMember gate ──────────────────────────────

describe("TS-033: POST /api/sites — remove !isProMember gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => makeSelectChain([]));
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    });
  });

  it("T1 — email NOT in teamMembers (new customer) → 201, not 402", async () => {
    // All selects return [] — fresh email, no existing site
    const res = await postSites(makeSitesReq({ url: "https://example.com", email: "fresh@newcustomer.com" }));
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; message: string };
    expect(body.id).toBeTruthy();
  });

  it("T2 — email IN teamMembers (existing pro user) → no 402, still succeeds", async () => {
    // First select returns a member row (simulates pro user — before fix: passes gate; after fix: treated as existing site → resend → 200)
    let call = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      call++;
      if (call === 1) return makeSelectChain([{ id: "m-1", teamId: "team-1" }]);
      return makeSelectChain([]);
    });

    const res = await postSites(makeSitesReq({ url: "https://pro.com", email: "pro@test.com" }));
    // Pro user must never get a 402 — either 200 (resend) or 201 (new)
    expect(res.status).not.toBe(402);
    expect(res.status).toBeLessThan(400);
  });
});

// ─── T3-T4: POST /api/webhooks/stripe — missing metadata → 500 ───────────────

describe("TS-033: POST /api/webhooks/stripe — fail loudly on missing metadata", () => {
  beforeEach(() => vi.clearAllMocks());

  it("T3 — missing teamId in session metadata → 500, not 200", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: { object: { id: "sess_1", metadata: { teamId: "", userId: "user-1" } } },
    });

    const res = await postWebhook(makeWebhookReq());
    expect(res.status).toBe(500);
  });

  it("T4 — missing userId in session metadata → 500, not 200", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: { object: { id: "sess_1", metadata: { teamId: "team-1", userId: "" } } },
    });

    const res = await postWebhook(makeWebhookReq());
    expect(res.status).toBe(500);
  });
});

// ─── T5-T6: POST /api/checkout — teamId guard ────────────────────────────────

describe("TS-033: POST /api/checkout — guard against missing teamId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: "user-1" } as any);
  });

  it("T5 — user has no teamMembers row → auto-provisions team and proceeds to Stripe", async () => {
    // Call 1: no membership → triggers auto-provision.
    // Call 2: re-fetch membership after provision → team found.
    // Call 3: Fix #39 team tier check → subscriptionTier="starter" (allows credit pack).
    (db.select as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => makeSelectChain([]))
      .mockImplementationOnce(() => makeSelectChain([{ teamId: "auto-team-1", userId: "user-1" }]))
      .mockImplementationOnce(() => makeSelectChain([{ subscriptionTier: "starter" }]));
    mockCreateSession.mockResolvedValue({ url: "https://checkout.stripe.com/pay/cs_test_auto" });

    const res = await postCheckout(makeCheckoutReq());
    expect(res.status).toBe(200);
    const body = await res.json() as { checkoutUrl: string };
    expect(body.checkoutUrl).toContain("stripe.com");
  });

  it("T6 — user has teamMembers row → Stripe session created, no 409", async () => {
    // Call 1: membership found. Call 2: Fix #39 team tier check → subscriptionTier="starter".
    (db.select as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => makeSelectChain([{ teamId: "team-1", userId: "user-1" }]))
      .mockImplementation(() => makeSelectChain([{ subscriptionTier: "starter" }]));
    mockCreateSession.mockResolvedValue({ url: "https://checkout.stripe.com/pay/cs_test_xxx" });

    const res = await postCheckout(makeCheckoutReq());
    expect(res.status).toBe(200);
    const body = await res.json() as { checkoutUrl: string };
    expect(body.checkoutUrl).toContain("stripe.com");
  });
});
