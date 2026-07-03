/**
 * Tests for the payment-first subscription_signup paths in
 * app/api/webhooks/stripe/route.ts
 *
 *   - checkout.session.completed (subscription, type:subscription_signup, no teamId):
 *       provisions team, activates tier with the credit pool (creditBalance=tier.credits,
 *       monthlyPageAllowance=0), back-fills teamId onto the Stripe subscription, and
 *       deducts the first auto-run audit from credits.
 *   - idempotent when a team already carries the subscription.
 *   - provisioning failure → skipped + internal alert, no activation.
 *   - invoice.paid renewal → refreshes creditBalance to the tier's credits.
 *
 * resolveFirstAuditMaxPages and SUBSCRIPTION_TIERS run REAL (pure) so the
 * deduction math is asserted against production values.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockConstructEvent,
  mockSubscriptionsUpdate,
  mockSubscriptionsRetrieve,
  mockDbSelect,
  mockDbUpdate,
  mockTransaction,
  mockProvision,
  mockVerifyBinding,
  mockValidatePublicUrl,
  mockEnqueueStage,
  mockSendSubConfirm,
  mockSendInternalAlert,
  mockSendAuditConfirm,
} = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockSubscriptionsUpdate: vi.fn().mockResolvedValue({}),
  mockSubscriptionsRetrieve: vi.fn(),
  mockDbSelect: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockTransaction: vi.fn(),
  mockProvision: vi.fn(),
  mockVerifyBinding: vi.fn().mockReturnValue(true),
  mockValidatePublicUrl: vi.fn().mockReturnValue({ ok: true, url: new URL("https://example.com/") }),
  mockEnqueueStage: vi.fn().mockResolvedValue(undefined),
  mockSendSubConfirm: vi.fn().mockResolvedValue(undefined),
  mockSendInternalAlert: vi.fn().mockResolvedValue(undefined),
  mockSendAuditConfirm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("stripe", () => ({
  default: vi.fn(function () {
    return {
      webhooks: { constructEvent: mockConstructEvent },
      subscriptions: { update: mockSubscriptionsUpdate, retrieve: mockSubscriptionsRetrieve },
    };
  }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
    update: mockDbUpdate,
    insert: vi.fn(),
    transaction: mockTransaction,
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_c: unknown, _v: unknown) => ({ _eq: [_c, _v] })),
  and: vi.fn((...a: unknown[]) => ({ _and: a })),
  or: vi.fn((...a: unknown[]) => ({ _or: a })),
  isNull: vi.fn((c: unknown) => ({ _isNull: c })),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: { strings, values } }),
}));

vi.mock("nanoid", () => ({ nanoid: vi.fn(() => "test-id") }));

vi.mock("@/lib/services/provision-from-checkout", () => ({
  provisionUserAndTeamFromEmail: mockProvision,
}));

vi.mock("@/lib/checkout-binding", () => ({
  verifyCheckoutBinding: mockVerifyBinding,
  CHECKOUT_BINDING_METADATA_KEY: "fb_bind",
}));

vi.mock("@/lib/ssrf", () => ({ validatePublicUrl: mockValidatePublicUrl }));
vi.mock("@/lib/qstash", () => ({ enqueueStage: mockEnqueueStage }));
vi.mock("@/lib/utils", () => ({
  normalizeDomain: vi.fn(() => "example.com"),
  slugify: vi.fn(() => "example"),
}));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: vi.fn(() => null) }));
vi.mock("@/lib/services/provision-team", () => ({ ensureTeamForUser: vi.fn() }));

vi.mock("@/lib/email", () => ({
  sendSubscriptionConfirmationEmail: mockSendSubConfirm,
  sendCreditsPurchasedEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionRenewalEmail: vi.fn().mockResolvedValue(undefined),
  sendPaymentFailedEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionCancelledEmail: vi.fn().mockResolvedValue(undefined),
  sendInternalPaymentAlert: mockSendInternalAlert,
  sendAuditPurchaseRefundedEmail: vi.fn().mockResolvedValue(undefined),
  sendAuditPurchaseConfirmationEmail: mockSendAuditConfirm,
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    STRIPE_PRICE_IDS: {
      monthly: { starter: "price_starter_m", growth: "price_growth_m", pro: "price_pro_m" },
      quarterly: { starter: "price_starter_q", growth: "price_growth_q", pro: "price_pro_q" },
      annual: { starter: "price_starter_a", growth: "price_growth_a", pro: "price_pro_a" },
    },
  };
});

import { POST } from "../route";
import { sendSubscriptionRenewalEmail } from "@/lib/email";

function makeRequest(): NextRequest {
  return new NextRequest(
    new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: { "content-type": "text/plain", "stripe-signature": "sig" },
      body: "{}",
    }),
  );
}

// db.select chain returning the given rows
function selectReturning(rows: unknown[]) {
  return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(rows) };
}

// db.update chain that captures .set() args
function captureUpdate(store: Record<string, unknown>[]) {
  return {
    set: vi.fn((arg: Record<string, unknown>) => {
      store.push(arg);
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  };
}

const SIGNUP_SESSION = {
  id: "cs_signup_1",
  mode: "subscription",
  subscription: "sub_123",
  customer: "cus_123",
  customer_email: "buyer@example.com",
  customer_details: { email: "buyer@example.com" },
  metadata: {
    type: "subscription_signup",
    plan: "starter",
    interval: "monthly",
    websiteUrl: "https://example.com/",
    fb_bind: "deadbeef",
  },
};

describe("stripe webhook — subscription_signup (payment-first)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://geo.flowblinq.com";
    mockVerifyBinding.mockReturnValue(true);
    mockValidatePublicUrl.mockReturnValue({ ok: true, url: new URL("https://example.com/") });
  });

  it("provisions, activates the credit pool, back-fills teamId, and deducts the first audit", async () => {
    mockConstructEvent.mockReturnValue({ type: "checkout.session.completed", data: { object: SIGNUP_SESSION } });
    mockProvision.mockResolvedValue({ succeeded: true, teamId: "team_new", supaUserId: "user_1", magicLink: "https://magic" });

    const teamUpdates: Record<string, unknown>[] = [];
    // 1) sub-id idempotency lookup → none
    // 2) NEW-W-06: session.id dedup marker check → none
    // 3) NEW-A-01: pre-activation conflict check → no active sub (safe)
    // 4) fresh team read for budget
    mockDbSelect
      .mockReturnValueOnce(selectReturning([])) // idempotency: no existing team for sub
      .mockReturnValueOnce(selectReturning([])) // NEW-W-06: no session dedup marker
      .mockReturnValueOnce(selectReturning([    // NEW-A-01: no active sub conflict
        { subscriptionStatus: "inactive", stripeSubscriptionId: null },
      ]))
      .mockReturnValueOnce(selectReturning([
        { monthlyPageAllowance: 0, monthlyPagesUsed: 0, creditBalance: 1500, subscriptionTier: "starter", subscriptionStatus: "active" },
      ]));
    mockDbUpdate.mockImplementation(() => captureUpdate(teamUpdates));

    const txInserts: Record<string, unknown>[] = [];
    const txCreditUpdates: Record<string, unknown>[] = [];
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: vi.fn(() => ({ values: vi.fn((v: Record<string, unknown>) => { txInserts.push(v); return Promise.resolve(); }) })),
        update: vi.fn(() => ({ set: vi.fn((v: Record<string, unknown>) => { txCreditUpdates.push(v); return { where: vi.fn().mockResolvedValue(undefined) }; }) })),
      };
      await cb(tx);
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    // provisioned with the paying email
    expect(mockProvision).toHaveBeenCalledWith("buyer@example.com", expect.objectContaining({ redirectTo: expect.stringContaining("/dashboard") }));

    // activation: credit-pool model
    const activation = teamUpdates.find((u) => u.subscriptionTier === "starter");
    expect(activation).toBeTruthy();
    expect(activation).toMatchObject({
      subscriptionTier: "starter",
      subscriptionStatus: "active",
      creditBalance: 1500,
      monthlyPageAllowance: 0,
      stripeSubscriptionId: "sub_123",
    });

    // teamId back-filled onto the subscription (renewals depend on this)
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith(
      "sub_123",
      expect.objectContaining({ metadata: expect.objectContaining({ teamId: "team_new", plan: "starter" }) }),
    );

    // first audit: capped at 100 pages, 10 credits deducted + ledger row
    const siteInsert = txInserts.find((i) => "crawlLimit" in i);
    expect(siteInsert).toMatchObject({ crawlLimit: 100, creditsReserved: 10, teamId: "team_new" });
    const ledger = txInserts.find((i) => i.type === "crawl_reserve");
    expect(ledger).toMatchObject({ creditsChanged: -10, pagesConsumed: 100, balanceBefore: 1500, balanceAfter: 1490 });
    expect(mockEnqueueStage).toHaveBeenCalledWith(expect.objectContaining({ stage: "discover" }));

    // magic-link confirmation email uses the link as the CTA
    expect(mockSendSubConfirm).toHaveBeenCalledWith("buyer@example.com", expect.objectContaining({ dashboardUrl: "https://magic" }));
  });

  // ── FIX-006: reject plans the signup checkout never offers ────────────────
  it("rejects a tampered non-signup plan ('pro') before indexing the price map", async () => {
    const proSession = { ...SIGNUP_SESSION, metadata: { ...SIGNUP_SESSION.metadata, plan: "pro" } };
    mockConstructEvent.mockReturnValue({ type: "checkout.session.completed", data: { object: proSession } });

    const res = await POST(makeRequest());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.skipped).toBe("invalid_metadata");
    // Guard runs before any DB/provisioning work.
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("is idempotent when a team already carries the subscription", async () => {
    mockConstructEvent.mockReturnValue({ type: "checkout.session.completed", data: { object: SIGNUP_SESSION } });
    mockDbSelect.mockReturnValueOnce(selectReturning([{ id: "team_existing" }]));

    const res = await POST(makeRequest());
    const json = await res.json();
    expect(json.idempotent).toBe(true);
    expect(mockProvision).not.toHaveBeenCalled();
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("returns 500 (so Stripe retries) + alerts ops when provisioning fails", async () => {
    mockConstructEvent.mockReturnValue({ type: "checkout.session.completed", data: { object: SIGNUP_SESSION } });
    mockDbSelect
      .mockReturnValueOnce(selectReturning([]))  // sub-id idempotency: no existing team
      .mockReturnValueOnce(selectReturning([])); // NEW-W-06: no session dedup marker
    mockProvision.mockResolvedValue({ succeeded: false });

    const res = await POST(makeRequest());
    const json = await res.json();
    // FIX-005: 500 so Stripe redelivers the event (idempotency guard makes retry safe);
    // a transient Supabase/DB blip no longer permanently drops a paid subscription.
    expect(res.status).toBe(500);
    expect(json.error).toBe("provision_failed");
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
    expect(mockSendInternalAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "subscription", note: expect.stringContaining("subscription_signup_provision_failed") }),
    );
  });

  // ── Monthly renewal MUST add credits (founder requirement) ────────────────
  function renewalEvent(teamId = "team_renew") {
    return {
      type: "invoice.paid",
      data: {
        object: {
          billing_reason: "subscription_cycle",
          parent: { subscription_details: { metadata: { teamId }, subscription: "sub_123" } },
          lines: { data: [{ period: { end: 1893456000 } }] },
          customer_email: "buyer@example.com",
        },
      },
    };
  }

  it.each([
    ["starter", 1500],
    ["growth", 7500],
    ["pro", 30000],
  ])("renewal (invoice.paid) for %s refreshes creditBalance to %i credits", async (tier, expectedCredits) => {
    mockConstructEvent.mockReturnValue(renewalEvent());
    const teamUpdates: Record<string, unknown>[] = [];
    mockDbSelect
      .mockReturnValueOnce(selectReturning([{ subscriptionTier: tier }])) // tier lookup
      .mockReturnValueOnce(selectReturning([{ subscriptionTier: tier, monthlyPageAllowance: 0 }])); // renewal email read
    mockDbUpdate.mockImplementation(() => captureUpdate(teamUpdates));

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const refresh = teamUpdates.find((u) => "creditBalance" in u);
    // Credits are SET to the tier amount (absolute, not incremented — no stacking)
    expect(refresh).toMatchObject({ creditBalance: expectedCredits, monthlyPageAllowance: 0, monthlyPagesUsed: 0 });
  });

  it("renewal does NOT fire (no credit grant) when subscription metadata lacks teamId", async () => {
    mockConstructEvent.mockReturnValue({
      type: "invoice.paid",
      data: {
        object: {
          billing_reason: "subscription_cycle",
          parent: { subscription_details: { metadata: {}, subscription: "sub_123" } },
          lines: { data: [{ period: { end: 1893456000 } }] },
          customer_email: "buyer@example.com",
        },
      },
    });
    const teamUpdates: Record<string, unknown>[] = [];
    mockDbUpdate.mockImplementation(() => captureUpdate(teamUpdates));

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    // No teamId → renewal branch is skipped → no credit grant. This is exactly why
    // G2 back-fills teamId onto the subscription at signup.
    expect(teamUpdates.find((u) => "creditBalance" in u)).toBeUndefined();
  });

  // ── FIX-003: multiply credits by billing-interval months ──────────────────
  it("quarterly signup grants 3× the monthly credit pool", async () => {
    const quarterlySession = { ...SIGNUP_SESSION, metadata: { ...SIGNUP_SESSION.metadata, interval: "quarterly" } };
    mockConstructEvent.mockReturnValue({ type: "checkout.session.completed", data: { object: quarterlySession } });
    mockProvision.mockResolvedValue({ succeeded: true, teamId: "team_q", supaUserId: "user_q", magicLink: "https://magic" });

    const teamUpdates: Record<string, unknown>[] = [];
    mockDbSelect
      .mockReturnValueOnce(selectReturning([]))  // idempotency: no existing team
      .mockReturnValueOnce(selectReturning([]))  // NEW-W-06: no session dedup marker
      .mockReturnValueOnce(selectReturning([     // NEW-A-01: no active sub conflict
        { subscriptionStatus: "inactive", stripeSubscriptionId: null },
      ]))
      .mockReturnValueOnce(selectReturning([
        { monthlyPageAllowance: 0, monthlyPagesUsed: 0, creditBalance: 4500, subscriptionTier: "starter", subscriptionStatus: "active" },
      ]));
    mockDbUpdate.mockImplementation(() => captureUpdate(teamUpdates));
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
      };
      await cb(tx);
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const activation = teamUpdates.find((u) => u.subscriptionTier === "starter");
    // starter credits (1500) × 3 months = 4500 — NOT a one-month grant.
    expect(activation).toMatchObject({ creditBalance: 4500, monthlyPageAllowance: 0 });
  });

  // ── FIX-004: invoice.payment_failed teamId DB fallback ────────────────────
  it("payment_failed resolves the team by stripeSubscriptionId when metadata lacks teamId", async () => {
    mockConstructEvent.mockReturnValue({
      type: "invoice.payment_failed",
      data: {
        object: {
          parent: { subscription_details: { subscription: "sub_nometa", metadata: {} } },
          customer_email: "buyer@example.com",
        },
      },
    });
    // No teamId in invoice or subscription metadata → must fall back to DB lookup.
    mockSubscriptionsRetrieve.mockResolvedValue({ id: "sub_nometa", status: "past_due", metadata: {} });
    const teamUpdates: Record<string, unknown>[] = [];
    mockDbSelect
      .mockReturnValueOnce(selectReturning([{ id: "team_db" }]))               // fallback lookup by sub id
      .mockReturnValueOnce(selectReturning([{ subscriptionTier: "starter" }])); // failed-email tier read
    mockDbUpdate.mockImplementation(() => captureUpdate(teamUpdates));

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(teamUpdates.find((u) => u.subscriptionStatus === "past_due")).toBeTruthy();
  });

  it("payment_failed alerts ops when the team cannot be resolved", async () => {
    mockConstructEvent.mockReturnValue({
      type: "invoice.payment_failed",
      data: {
        object: {
          parent: { subscription_details: { subscription: "sub_unknown", metadata: {} } },
          customer_email: "buyer@example.com",
        },
      },
    });
    mockSubscriptionsRetrieve.mockResolvedValue({ id: "sub_unknown", status: "past_due", metadata: {} });
    mockDbSelect.mockReturnValueOnce(selectReturning([])); // fallback lookup misses
    const teamUpdates: Record<string, unknown>[] = [];
    mockDbUpdate.mockImplementation(() => captureUpdate(teamUpdates));

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    // No status change possible, but ops MUST be alerted (not a silent no-op).
    expect(teamUpdates.find((u) => "subscriptionStatus" in u)).toBeUndefined();
    expect(mockSendInternalAlert).toHaveBeenCalledWith(
      expect.objectContaining({ note: expect.stringContaining("no teamId resolvable") }),
    );
  });

  it("renewal multiplies credits by the billing-period months (quarterly = 3×)", async () => {
    const start = 1700000000;
    const end = start + 91 * 24 * 3600; // ~3 months span
    mockConstructEvent.mockReturnValue({
      type: "invoice.paid",
      data: {
        object: {
          billing_reason: "subscription_cycle",
          parent: { subscription_details: { metadata: { teamId: "team_q" }, subscription: "sub_123" } },
          lines: { data: [{ period: { start, end } }] },
          customer_email: "buyer@example.com",
        },
      },
    });
    const teamUpdates: Record<string, unknown>[] = [];
    mockDbSelect
      .mockReturnValueOnce(selectReturning([{ subscriptionTier: "starter" }]))
      .mockReturnValueOnce(selectReturning([{ subscriptionTier: "starter", monthlyPageAllowance: 0 }]));
    mockDbUpdate.mockImplementation(() => captureUpdate(teamUpdates));

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const refresh = teamUpdates.find((u) => "creditBalance" in u);
    expect(refresh).toMatchObject({ creditBalance: 4500, monthlyPageAllowance: 0, monthlyPagesUsed: 0 });
  });

  // ── FIX-005: renewal email reports the TIER allowance, not the zeroed column ──
  it("renewal email reports tier.pages, not the credit-pool monthlyPageAllowance (0)", async () => {
    mockConstructEvent.mockReturnValue(renewalEvent());
    mockDbSelect
      .mockReturnValueOnce(selectReturning([{ subscriptionTier: "starter" }]))               // tier lookup
      .mockReturnValueOnce(selectReturning([{ subscriptionTier: "starter", monthlyPageAllowance: 0 }])); // email read
    mockDbUpdate.mockImplementation(() => captureUpdate([]));

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    // starter.pages = 1000 — must NOT be the zeroed monthlyPageAllowance column.
    expect(vi.mocked(sendSubscriptionRenewalEmail)).toHaveBeenCalledWith(
      "buyer@example.com",
      expect.objectContaining({ pageAllowance: 1000 }),
    );
  });

  // ── FIX-004: cancellation revokes credits even for metadata-less (legacy) subs ──
  it("subscription.deleted resolves team by stripeSubscriptionId and zeroes credits", async () => {
    mockConstructEvent.mockReturnValue({
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_legacy", metadata: {} } }, // no teamId in metadata
    });
    const teamUpdates: Record<string, unknown>[] = [];
    mockDbSelect
      .mockReturnValueOnce(selectReturning([{ id: "team_legacy" }]))      // FIX-004 fallback lookup by sub id
      .mockReturnValueOnce(selectReturning([{ subscriptionTier: "growth" }])); // pre-cancel tier read
    mockDbUpdate.mockImplementation(() => captureUpdate(teamUpdates));

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const downgrade = teamUpdates.find((u) => u.subscriptionTier === "free");
    expect(downgrade).toMatchObject({ subscriptionTier: "free", creditBalance: 0 });
  });
});
