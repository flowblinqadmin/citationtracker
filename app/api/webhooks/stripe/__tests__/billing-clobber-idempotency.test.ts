/**
 * NEW tests for three billing gaps:
 *
 *   NEW-A-01: subscription_signup MUST NOT blindly overwrite an active team when
 *             provisionUserAndTeamFromEmail returns a teamId that already carries
 *             a DIFFERENT active subscription. The guard must fire sendInternalPaymentAlert
 *             and return 200 without touching the existing team's billing state.
 *
 *   NEW-W-06: redelivered events (same Stripe event.id) must not be processed
 *             twice even when the subscriptionId-based idempotency guard misses
 *             (e.g. a race between two deliveries before the DB write commits).
 *             The route must record processed event.ids and short-circuit on replay.
 *
 *   NEW-W-05: the renewal email's nextRenewalDate MUST use the real period end
 *             (i.e. periodEnd itself, expressed as a date), NOT a hardcoded +31-day
 *             offset (+2678400 s). For quarterly/annual subscribers that offset
 *             produces an entirely wrong date.
 *
 * Each test is RED on the base code and GREEN after the corresponding fix.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ─────────────────────────────────────────────────────────────

const {
  mockConstructEvent,
  mockSubscriptionsUpdate,
  mockSubscriptionsRetrieve,
  mockDbSelect,
  mockDbUpdate,
  mockDbTransaction,
  mockProvision,
  mockVerifyBinding,
  mockValidatePublicUrl,
  mockEnqueueStage,
  mockSendSubConfirm,
  mockSendInternalAlert,
  mockSendAuditConfirm,
  mockSendRenewalEmail,
} = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockSubscriptionsUpdate: vi.fn().mockResolvedValue({}),
  mockSubscriptionsRetrieve: vi.fn(),
  mockDbSelect: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbTransaction: vi.fn(),
  mockProvision: vi.fn(),
  mockVerifyBinding: vi.fn().mockReturnValue(true),
  mockValidatePublicUrl: vi.fn().mockReturnValue({ ok: true, url: new URL("https://example.com/") }),
  mockEnqueueStage: vi.fn().mockResolvedValue(undefined),
  mockSendSubConfirm: vi.fn().mockResolvedValue(undefined),
  mockSendInternalAlert: vi.fn().mockResolvedValue(undefined),
  mockSendAuditConfirm: vi.fn().mockResolvedValue(undefined),
  mockSendRenewalEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("stripe", () => ({
  default: vi.fn(function () {
    return {
      webhooks: { constructEvent: mockConstructEvent },
      subscriptions: { update: mockSubscriptionsUpdate, retrieve: mockSubscriptionsRetrieve },
      charges: { retrieve: vi.fn().mockResolvedValue({ id: "ch_test", payment_intent: "pi_test" }) },
    };
  }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
    update: mockDbUpdate,
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    transaction: mockDbTransaction,
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
  sendSubscriptionRenewalEmail: mockSendRenewalEmail,
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

function makeRequest(): NextRequest {
  return new NextRequest(
    new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: { "content-type": "text/plain", "stripe-signature": "sig" },
      body: "{}",
    }),
  );
}

function selectReturning(rows: unknown[]) {
  return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(rows) };
}

function captureUpdate(store: Record<string, unknown>[]) {
  return {
    set: vi.fn((arg: Record<string, unknown>) => {
      store.push(arg);
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  };
}

const SIGNUP_SESSION_BASE = {
  id: "cs_clobber_test",
  mode: "subscription",
  subscription: "sub_NEW_999",
  customer: "cus_999",
  customer_email: "returning@example.com",
  customer_details: { email: "returning@example.com" },
  metadata: {
    type: "subscription_signup",
    plan: "starter",
    interval: "monthly",
    websiteUrl: "https://example.com/",
    fb_bind: "deadbeef",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// NEW-A-01: reconcile-don't-clobber
// ─────────────────────────────────────────────────────────────────────────────

describe("NEW-A-01 — subscription_signup: reconcile-don't-clobber existing active sub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://geo.flowblinq.com";
    mockVerifyBinding.mockReturnValue(true);
    mockValidatePublicUrl.mockReturnValue({ ok: true, url: new URL("https://example.com/") });
  });

  it("does NOT overwrite creditBalance/subscriptionId when the resolved team already has an active DIFFERENT subscription", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: { object: SIGNUP_SESSION_BASE },
    });

    // The resolved team already has an ACTIVE different subscription (sub_OLD_existing)
    mockProvision.mockResolvedValue({
      succeeded: true,
      teamId: "team_with_active_sub",
      supaUserId: "user_1",
      magicLink: "https://magic",
    });

    // idempotency check: sub_NEW_999 not yet on any team
    // then: session.id dedup check: no marker yet
    // then: team activation check returns a team with a DIFFERENT active sub
    const teamUpdates: Record<string, unknown>[] = [];
    mockDbSelect
      .mockReturnValueOnce(selectReturning([]))  // idempotency: sub_NEW_999 not found
      .mockReturnValueOnce(selectReturning([]))  // NEW-W-06: no session dedup marker
      .mockReturnValueOnce(selectReturning([{   // NEW-A-01 pre-activation check: team already has active different sub
        id: "team_with_active_sub",
        subscriptionStatus: "active",
        stripeSubscriptionId: "sub_OLD_existing",
        creditBalance: 9999,
      }]));

    mockDbUpdate.mockImplementation(() => captureUpdate(teamUpdates));
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
      };
      await cb(tx);
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    // CRITICAL: the team's existing creditBalance (9999) and subscriptionId (sub_OLD_existing)
    // must NOT be overwritten. The guard fires → no db.update(teams).set({subscriptionTier...}).
    const activationUpdate = teamUpdates.find(
      (u) => u.stripeSubscriptionId === "sub_NEW_999" || u.subscriptionTier === "starter",
    );
    expect(activationUpdate).toBeUndefined();

    // Ops must be alerted so they can follow up manually
    expect(mockSendInternalAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "subscription",
        note: expect.stringContaining("sub_OLD_existing"),
      }),
    );
  });

  it("activates cleanly when the resolved team has no active subscription (new team)", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: { object: SIGNUP_SESSION_BASE },
    });

    mockProvision.mockResolvedValue({
      succeeded: true,
      teamId: "team_fresh",
      supaUserId: "user_fresh",
      magicLink: "https://magic",
    });

    const teamUpdates: Record<string, unknown>[] = [];
    mockDbSelect
      .mockReturnValueOnce(selectReturning([]))     // idempotency: not found
      .mockReturnValueOnce(selectReturning([]))     // NEW-W-06: no session dedup marker
      .mockReturnValueOnce(selectReturning([{       // NEW-A-01: no active sub (safe to activate)
        id: "team_fresh",
        subscriptionStatus: "inactive",
        stripeSubscriptionId: null,
        creditBalance: 0,
      }]))
      .mockReturnValueOnce(selectReturning([{       // fresh team read for budget
        monthlyPageAllowance: 0,
        monthlyPagesUsed: 0,
        creditBalance: 1500,
        subscriptionTier: "starter",
        subscriptionStatus: "active",
      }]));

    mockDbUpdate.mockImplementation(() => captureUpdate(teamUpdates));
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
      };
      await cb(tx);
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    // Activation must have run — the team had no active sub
    const activation = teamUpdates.find((u) => u.subscriptionTier === "starter");
    expect(activation).toBeTruthy();
    expect(activation).toMatchObject({ subscriptionStatus: "active", stripeSubscriptionId: "sub_NEW_999" });
  });

  it("activates cleanly when the resolved team's existing subscription matches the new one (safe re-activation after partial failure)", async () => {
    // Scenario: previous delivery wrote stripeSubscriptionId but returned 500 before
    // committing the confirmation email. Stripe retries. Same subscriptionId → safe to re-run.
    // NOTE: the existing subscriptionId-keyed idempotency guard catches this first (returns idempotent:true).
    // This test validates the SAME_SUB path through the guard is treated as safe.
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: { object: SIGNUP_SESSION_BASE },
    });

    // idempotency: sub_NEW_999 already on a team → short-circuit (existing guard)
    mockDbSelect.mockReturnValueOnce(selectReturning([{ id: "team_same_sub" }]));

    const res = await POST(makeRequest());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.idempotent).toBe(true);
    // No DB writes past the idempotency guard
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW-W-06: session.id idempotency marker prevents double-processing on
// concurrent/racing deliveries of subscription_signup
// ─────────────────────────────────────────────────────────────────────────────

describe("NEW-W-06 — subscription_signup: session.id dedup marker prevents double-activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://geo.flowblinq.com";
    mockVerifyBinding.mockReturnValue(true);
    mockValidatePublicUrl.mockReturnValue({ ok: true, url: new URL("https://example.com/") });
  });

  it("returns idempotent:true and skips activation when a dedup marker for this session.id already exists", async () => {
    // Scenario: a concurrent delivery raced ahead and already inserted a
    // creditTransactions marker row for this session.id (type='topup', siteId=session.id).
    // The second delivery must detect it and short-circuit BEFORE provisioning
    // or activating — preventing a double subscription grant.
    const sessionObj = { ...SIGNUP_SESSION_BASE, id: "cs_signup_race" };

    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: { object: sessionObj },
    });

    // First SELECT: the subscriptionId-based guard finds nothing (sub not yet committed
    // by the racing delivery — this is the race window).
    // Second SELECT: the session.id dedup marker IS found (inserted by the concurrent delivery).
    mockDbSelect
      .mockReturnValueOnce(selectReturning([]))                          // sub-id guard: no team yet
      .mockReturnValueOnce(selectReturning([{ id: "dedup-marker-row" }])); // session-id dedup: found

    const res = await POST(makeRequest());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.idempotent).toBe(true);

    // Must NOT have provisioned or activated
    expect(mockProvision).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it("processes normally and inserts a dedup marker when no prior marker exists", async () => {
    // Normal (first-time) delivery: neither sub-id guard nor session-id dedup fires.
    // Route should provision, activate, AND insert the dedup marker.
    const sessionObj = { ...SIGNUP_SESSION_BASE, id: "cs_signup_firsttime" };

    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: { object: sessionObj },
    });

    mockProvision.mockResolvedValue({
      succeeded: true,
      teamId: "team_firsttime",
      supaUserId: "user_firsttime",
      magicLink: "https://magic",
    });

    const teamUpdates: Record<string, unknown>[] = [];
    // Select call order:
    // 1. sub-id idempotency guard (eq teams.stripeSubscriptionId=sub_NEW_999) → not found
    // 2. session-id dedup marker check (eq creditTransactions.siteId=session.id) → not found
    // 3. NEW-A-01 pre-activation check (eq teams.id=team_firsttime) → no active sub
    // 4. fresh team read for budget
    mockDbSelect
      .mockReturnValueOnce(selectReturning([]))   // 1. sub-id guard: not found
      .mockReturnValueOnce(selectReturning([]))   // 2. session-id dedup: not found → proceed
      .mockReturnValueOnce(selectReturning([{     // 3. pre-activation check: no active sub
        id: "team_firsttime",
        subscriptionStatus: "inactive",
        stripeSubscriptionId: null,
        creditBalance: 0,
      }]))
      .mockReturnValueOnce(selectReturning([{     // 4. fresh team read for budget
        monthlyPageAllowance: 0,
        monthlyPagesUsed: 0,
        creditBalance: 1500,
        subscriptionTier: "starter",
        subscriptionStatus: "active",
      }]));
    mockDbUpdate.mockImplementation(() => captureUpdate(teamUpdates));
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
      };
      await cb(tx);
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    // Activation must have run
    const activation = teamUpdates.find((u) => u.subscriptionTier === "starter");
    expect(activation).toBeTruthy();
    expect(activation).toMatchObject({ subscriptionStatus: "active" });

    // A dedup marker (insert to creditTransactions with siteId=session.id) must have been inserted
    // The db.insert mock is called for the dedup marker
    const { db } = await import("@/lib/db");
    expect(db.insert).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW-W-05: renewal email nextRenewalDate uses real periodEnd, not +31 days
// ─────────────────────────────────────────────────────────────────────────────

describe("NEW-W-05 — renewal email: nextRenewalDate uses real periodEnd, not hardcoded +31 days", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.NEXT_PUBLIC_APP_URL = "https://geo.flowblinq.com";
  });

  it("uses periodEnd directly (not periodEnd + 2678400) for nextRenewalDate in monthly billing", async () => {
    // Monthly billing: period ends 2026-07-09. The correct next-renewal display
    // is "July 9, 2026" — NOT "August 9, 2026" (periodEnd + 31 days).
    // periodEnd IS the expiry of the current period, which is when Stripe will
    // charge again — so it IS the next renewal date.
    const periodEnd = Math.floor(new Date("2026-07-09T00:00:00Z").getTime() / 1000);

    mockConstructEvent.mockReturnValue({
      type: "invoice.paid",
      data: {
        object: {
          billing_reason: "subscription_cycle",
          parent: {
            subscription_details: {
              metadata: { teamId: "team_monthly" },
              subscription: "sub_monthly",
            },
          },
          lines: { data: [{ period: { end: periodEnd } }] },
          customer_email: "subscriber@example.com",
        },
      },
    });

    mockDbSelect
      .mockReturnValueOnce(selectReturning([{ subscriptionTier: "starter" }]))
      .mockReturnValueOnce(selectReturning([{ subscriptionTier: "starter", monthlyPageAllowance: 0 }]));
    mockDbUpdate.mockImplementation(() => captureUpdate([]));

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    expect(mockSendRenewalEmail).toHaveBeenCalledTimes(1);
    const [, opts] = mockSendRenewalEmail.mock.calls[0];

    // The expected date is July 9, 2026 (the periodEnd itself, not +31 days from it).
    // periodEnd + 2678400 = 2026-08-09 — that is WRONG for a monthly subscriber.
    expect(opts.nextRenewalDate).toContain("July");
    expect(opts.nextRenewalDate).toContain("9");
    expect(opts.nextRenewalDate).toContain("2026");

    // Guard: must NOT contain "August" (which is what +31 days would produce)
    expect(opts.nextRenewalDate).not.toContain("August");
  });

  it("uses periodEnd directly for quarterly billing (NOT periodEnd + 31 days)", async () => {
    // Quarterly billing: period ends 2026-09-09.
    // periodEnd + 31 days = 2026-10-10 — grossly wrong for quarterly.
    // The correct display is "September 9, 2026".
    const periodEnd = Math.floor(new Date("2026-09-09T00:00:00Z").getTime() / 1000);

    mockConstructEvent.mockReturnValue({
      type: "invoice.paid",
      data: {
        object: {
          billing_reason: "subscription_cycle",
          parent: {
            subscription_details: {
              metadata: { teamId: "team_quarterly" },
              subscription: "sub_quarterly",
            },
          },
          lines: { data: [{ period: { end: periodEnd } }] },
          customer_email: "subscriber@example.com",
        },
      },
    });

    mockDbSelect
      .mockReturnValueOnce(selectReturning([{ subscriptionTier: "starter" }]))
      .mockReturnValueOnce(selectReturning([{ subscriptionTier: "starter", monthlyPageAllowance: 0 }]));
    mockDbUpdate.mockImplementation(() => captureUpdate([]));

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const [, opts] = mockSendRenewalEmail.mock.calls[0];
    expect(opts.nextRenewalDate).toContain("September");
    expect(opts.nextRenewalDate).toContain("9");
    // Must NOT be October (which +31 days would give)
    expect(opts.nextRenewalDate).not.toContain("October");
  });
});
