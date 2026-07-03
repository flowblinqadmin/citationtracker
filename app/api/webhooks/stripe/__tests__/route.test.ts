import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

const { mockConstructEvent, mockUpdate, mockInsert, mockTxUpdate, mockTxInsert, mockTxSelect, mockDbSelect } =
  vi.hoisted(() => ({
    mockConstructEvent: vi.fn(),
    mockUpdate: vi.fn(),
    mockInsert: vi.fn(),
    mockTxUpdate: vi.fn(),
    mockTxInsert: vi.fn(),
    mockTxSelect: vi.fn(),
    mockDbSelect: vi.fn(),
  }));

const { mockRetrieveSubscription, mockRetrieveCharge } = vi.hoisted(() => ({
  mockRetrieveSubscription: vi.fn(),
  mockRetrieveCharge: vi.fn(),
}));

vi.mock("stripe", () => {
  const StripeMock = function () {
    return {
      webhooks: { constructEvent: mockConstructEvent },
      subscriptions: { retrieve: mockRetrieveSubscription },
      // Blocker E: charge.dispute.created handler calls charges.retrieve as fallback
      charges: { retrieve: mockRetrieveCharge },
    };
  };
  return { default: StripeMock };
});

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
    insert: mockInsert,
    update: mockUpdate,
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        select: mockTxSelect,
        insert: mockTxInsert,
        update: mockTxUpdate,
      };
      await cb(tx);
    }),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => ({ _eq: [_col, _val] })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: { strings, values } }),
}));

vi.mock("nanoid", () => ({ nanoid: vi.fn(() => "test-nano") }));

// Mock lib/email — Resend is instantiated at module load time and requires RESEND_API_KEY.
// This mock prevents the module from crashing when the env var is absent in tests.
vi.mock("@/lib/email", () => ({
  sendSubscriptionConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendCreditsPurchasedEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionRenewalEmail: vi.fn().mockResolvedValue(undefined),
  sendPaymentFailedEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionCancelledEmail: vi.fn().mockResolvedValue(undefined),
  sendInternalPaymentAlert: vi.fn().mockResolvedValue(undefined),
}));

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

// ─── Imports ────────────────────────────────────────────────────────────────

import { POST } from "@/app/api/webhooks/stripe/route";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(body: string, sig = "valid-sig") {
  return new NextRequest("http://localhost/api/webhooks/stripe", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": sig,
    },
  });
}

function mockTxSelectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
  mockTxSelect.mockReturnValueOnce(chain);
  return chain;
}

function mockTxUpdateChain() {
  const setChain = { where: vi.fn().mockResolvedValue(undefined) };
  const chain = { set: vi.fn().mockReturnValue(setChain) };
  mockTxUpdate.mockReturnValueOnce(chain);
  return chain;
}

function mockTxInsertChain() {
  const chain = { values: vi.fn().mockResolvedValue(undefined) };
  mockTxInsert.mockReturnValueOnce(chain);
  return chain;
}

function mockDbUpdateChain() {
  const setChain = { where: vi.fn().mockResolvedValue(undefined) };
  const chain = { set: vi.fn().mockReturnValue(setChain) };
  mockUpdate.mockReturnValue(chain);
  return chain;
}

function mockDbSelectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
  mockDbSelect.mockReturnValueOnce(chain);
  return chain;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("POST /api/webhooks/stripe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  it("returns 400 for invalid signature", async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error("Invalid signature");
    });
    const res = await POST(makeRequest("{}", "bad-sig"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when stripe-signature header is missing", async () => {
    const req = new NextRequest("http://localhost/api/webhooks/stripe", {
      method: "POST",
      body: "{}",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("handles checkout.session.completed for one-time payment (existing flow)", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_123",
          mode: "payment",
          metadata: { teamId: "team-1", userId: "user-1", creditPacks: "1" },
        },
      },
    });

    // Mock db.select for MED-2 idempotency check (no existing row)
    mockDbSelectChain([]);
    // Mock tx.select for member check
    mockTxSelectChain([{ id: "member-1" }]);
    // Mock tx.select for team balance
    mockTxSelectChain([{ creditBalance: 50 }]);
    // Mock tx.update for balance
    mockTxUpdateChain();
    // Mock tx.select for reading back updated balance
    mockTxSelectChain([{ creditBalance: 150 }]);
    // Mock tx.insert for transaction log
    mockTxInsertChain();

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
  });

  it("handles checkout.session.completed (mode=subscription): sets tier + allowance", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_sub_123",
          mode: "subscription",
          customer: "cus_123",
          subscription: "sub_abc",
          metadata: { teamId: "team-1", userId: "user-1", plan: "growth" },
        },
      },
    });

    // FIX-005 idempotency guard: subscription not yet recorded on the team → proceed.
    mockDbSelectChain([{ stripeSubscriptionId: null }]);
    // Mock db.select for CRIT-1 ownership check
    mockDbSelectChain([{ id: "member-1" }]);
    mockDbUpdateChain();

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("authenticated subscription redelivery is idempotent (no re-activation)", async () => {
    // FIX-005: subscription already recorded → short-circuit, no re-zeroing of pages.
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_sub_dup",
          mode: "subscription",
          customer: "cus_123",
          subscription: "sub_already",
          metadata: { teamId: "team-1", userId: "user-1", plan: "growth" },
        },
      },
    });
    mockDbSelectChain([{ stripeSubscriptionId: "sub_already" }]); // already recorded
    mockDbUpdateChain();

    const res = await POST(makeRequest("{}"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.idempotent).toBe(true);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("handles invoice.paid (subscription_cycle): resets monthlyPagesUsed", async () => {
    // Stripe v20 shape: teamId now lives in parent.subscription_details.metadata.
    // The surviving handler reads teamId directly from there — no subscriptions.retrieve needed.
    mockConstructEvent.mockReturnValue({
      type: "invoice.paid",
      data: {
        object: {
          billing_reason: "subscription_cycle",
          parent: {
            subscription_details: {
              subscription: "sub_abc",
              metadata: { teamId: "team-1" }, // v20: teamId in invoice metadata, not subscription
            },
          },
          customer_email: "customer@example.com",
          lines: { data: [{ period: { end: Math.floor(Date.now() / 1000) + 86400 * 30 } }] },
        },
      },
    });

    // Mock db.select: first for tier lookup, second for renewal email team info
    mockDbSelectChain([{ subscriptionTier: "starter", monthlyPageAllowance: 1000 }]);
    mockDbSelectChain([{ subscriptionTier: "starter", monthlyPageAllowance: 1000 }]);
    mockDbUpdateChain();

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("handles customer.subscription.updated: syncs status", async () => {
    mockConstructEvent.mockReturnValue({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_abc",
          status: "past_due",
          metadata: { teamId: "team-1" },
          items: { data: [{ price: { id: "price_starter_test" } }] },
        },
      },
    });

    mockDbUpdateChain();

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("handles customer.subscription.deleted: resets to free tier", async () => {
    mockConstructEvent.mockReturnValue({
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_abc",
          metadata: { teamId: "team-1" },
        },
      },
    });

    // Mock db.select for pre-cancel team lookup
    mockDbSelectChain([{ subscriptionTier: "starter" }]);
    const cancelChain = mockDbUpdateChain();

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
    // FIX-004: cancellation revokes the paid credit pool (revenue-leak fix).
    expect(cancelChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionTier: "free", creditBalance: 0 }),
    );
  });

  it("reverse-lookups tier from quarterly starter price ID on subscription.updated", async () => {
    mockConstructEvent.mockReturnValue({
      type: "customer.subscription.updated",
      data: {
        object: {
          metadata: { teamId: "team-abc" },
          id: "sub_123",
          status: "active",
          items: { data: [{ price: { id: "price_starter_q" } }] },
        },
      },
    });
    // FIX-001: subscription.updated now reads the current tier and only refreshes
    // the credit pool on an ACTUAL change. Current tier "free" ≠ "starter" → change.
    mockDbSelectChain([{ subscriptionTier: "free" }]);
    const updateChain = { set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue({}) };
    mockUpdate.mockReturnValue(updateChain);

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    expect(updateChain.set).toHaveBeenCalledWith(
      // Credit-pool model: tier change also refreshes creditBalance (starter = 1500).
      expect.objectContaining({ subscriptionTier: "starter", creditBalance: 1500, monthlyPageAllowance: 0 }),
    );
  });

  it("refreshes the credit pool to current tier credits on invoice.paid renewal", async () => {
    mockConstructEvent.mockReturnValue({
      type: "invoice.paid",
      data: {
        object: {
          billing_reason: "subscription_cycle",
          // Stripe v20 shape: metadata lives on parent.subscription_details, and we
          // also need parent.subscription_details.subscription for the id lookup.
          parent: {
            subscription_details: {
              subscription: "sub_abc",
              metadata: { teamId: "team-abc" },
            },
          },
          lines: { data: [{ period: { end: 1700000000 } }] },
        },
      },
    });
    // Mock db.select to return current tier
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ subscriptionTier: "growth" }]),
    };
    mockDbSelect.mockReturnValue(selectChain);
    const updateChain = { set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue({}) };
    mockUpdate.mockReturnValue(updateChain);

    await POST(makeRequest("{}"));
    // Credit-pool model: renewal refreshes creditBalance to the tier's credits
    // (growth = 7500) and keeps the page allowance at 0 so audits draw from credits.
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ monthlyPagesUsed: 0, monthlyPageAllowance: 0, creditBalance: 7500 }),
    );
  });
});

// ── 12.B — charge.dispute.created: gate charges.retrieve on lookup miss ──────

describe("charge.dispute.created — 12.B stripe.charges.retrieve gating", () => {
  /**
   * Helper: makes a charge.dispute.created event.
   */
  function makeDisputeEvent(chargeId = "ch_dispute_123") {
    return {
      type: "charge.dispute.created",
      data: {
        object: {
          id: "dp_123",
          charge: chargeId,
        },
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    // Default: charges.retrieve resolves (shouldn't be called when direct lookup hits)
    mockRetrieveCharge.mockResolvedValue({
      id: "ch_dispute_123",
      payment_intent: "pi_dispute_123",
    });
  });

  it("does NOT call stripe.charges.retrieve when direct lookup by stripeChargeId hits", async () => {
    mockConstructEvent.mockReturnValue(makeDisputeEvent("ch_dispute_hit"));

    // Direct lookup returns a match — charges.retrieve should NOT be called
    mockDbSelectChain([{
      id: "purch-1",
      customerEmail: "buyer@example.com",
      domain: "example.com",
    }]);
    const updateChain = { set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue({}) };
    mockUpdate.mockReturnValue(updateChain);

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    expect(mockRetrieveCharge).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("calls stripe.charges.retrieve when direct lookup misses, then looks up by payment_intent", async () => {
    mockConstructEvent.mockReturnValue(makeDisputeEvent("ch_dispute_miss"));

    // Direct lookup: no match
    mockDbSelectChain([]);
    // charges.retrieve returns a charge with payment_intent
    mockRetrieveCharge.mockResolvedValue({
      id: "ch_dispute_miss",
      payment_intent: "pi_dispute_fallback",
    });
    // PI lookup returns a match
    mockDbSelectChain([{
      id: "purch-2",
      customerEmail: "buyer2@example.com",
      domain: "example2.com",
    }]);
    const updateChain = { set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue({}) };
    mockUpdate.mockReturnValue(updateChain);

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    expect(mockRetrieveCharge).toHaveBeenCalledWith("ch_dispute_miss");
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("no-ops (no update) when both direct and fallback lookups miss", async () => {
    mockConstructEvent.mockReturnValue(makeDisputeEvent("ch_other_product"));

    // Direct lookup: no match (this dispute is for a subscription/credits product)
    mockDbSelectChain([]);
    // charges.retrieve returns a charge with payment_intent
    mockRetrieveCharge.mockResolvedValue({
      id: "ch_other_product",
      payment_intent: "pi_subscription_789",
    });
    // PI lookup: also no match
    mockDbSelectChain([]);

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    // No update should happen — this dispute doesn't belong to an audit_purchase
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("does not throw and returns 200 when charges.retrieve fails (Stripe API error)", async () => {
    mockConstructEvent.mockReturnValue(makeDisputeEvent("ch_api_error"));

    // Direct lookup: miss
    mockDbSelectChain([]);
    // charges.retrieve throws
    mockRetrieveCharge.mockRejectedValue(new Error("Stripe API timeout"));

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
