/**
 * Tests for Task 7.2 (auto user+team at checkout.session.completed audit_purchase)
 * and Task 7.4 (failure-path webhook branches: expired, payment_failed, refunded, disputed)
 *
 * Harness discipline: tests written before implementation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  mockConstructEvent,
  mockDbSelect,
  mockDbInsert,
  mockDbUpdate,
  mockSendInternalPaymentAlert,
  mockSendAuditPurchaseRefundedEmail,
  mockSendAuditPurchaseFailedEmail,
  mockSendAuditPurchaseConfirmationEmail,
  mockCreateUser,
  mockGenerateLink,
  mockListUsers,
  mockEnsureTeamForUser,
  mockEnqueueStage,
  mockValidatePublicUrl,
} = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockSendInternalPaymentAlert: vi.fn().mockResolvedValue(undefined),
  mockSendAuditPurchaseRefundedEmail: vi.fn().mockResolvedValue(undefined),
  mockSendAuditPurchaseFailedEmail: vi.fn().mockResolvedValue(undefined),
  mockSendAuditPurchaseConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  mockCreateUser: vi.fn(),
  mockGenerateLink: vi.fn(),
  mockListUsers: vi.fn(),
  mockEnsureTeamForUser: vi.fn().mockResolvedValue({ teamId: "provisioned-team-id", isNewTeam: true }),
  mockEnqueueStage: vi.fn().mockResolvedValue(undefined),
  mockValidatePublicUrl: vi.fn(),
}));

vi.mock("stripe", () => {
  const StripeMock = function () {
    return {
      webhooks: { constructEvent: mockConstructEvent },
      subscriptions: { retrieve: vi.fn() },
      // Blocker E fix: charge.dispute.created handler now calls stripe.charges.retrieve
      // to get the payment_intent for fallback lookup.
      charges: { retrieve: vi.fn().mockResolvedValue({ id: "ch_test", payment_intent: "pi_test" }) },
    };
  };
  return { default: StripeMock };
});

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
    update: mockDbUpdate,
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({ select: vi.fn(), insert: vi.fn(), update: vi.fn() });
    }),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => ({ _eq: [_col, _val] })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  or: vi.fn((...args: unknown[]) => ({ _or: args })),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: { strings, values } }),
  isNull: vi.fn((col: unknown) => ({ _isNull: col })),
}));

vi.mock("nanoid", () => ({ nanoid: vi.fn(() => "mock-nano-id") }));

vi.mock("@/lib/email", () => ({
  sendSubscriptionConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendCreditsPurchasedEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionRenewalEmail: vi.fn().mockResolvedValue(undefined),
  sendPaymentFailedEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionCancelledEmail: vi.fn().mockResolvedValue(undefined),
  sendInternalPaymentAlert: mockSendInternalPaymentAlert,
  sendAuditPurchaseRefundedEmail: mockSendAuditPurchaseRefundedEmail,
  sendAuditPurchaseFailedEmail: mockSendAuditPurchaseFailedEmail,
  sendAuditPurchaseConfirmationEmail: mockSendAuditPurchaseConfirmationEmail,
}));

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

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: vi.fn(() => ({
    auth: {
      admin: {
        createUser: mockCreateUser,
        generateLink: mockGenerateLink,
        listUsers: mockListUsers,
      },
    },
  })),
}));

vi.mock("@/lib/services/provision-team", () => ({
  ensureTeamForUser: mockEnsureTeamForUser,
}));

vi.mock("@/lib/ssrf", () => ({
  validatePublicUrl: mockValidatePublicUrl,
}));

vi.mock("@/lib/utils", () => ({
  normalizeDomain: vi.fn((url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "")),
  slugify: vi.fn((domain: string) => domain.replace(/\./g, "-")),
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: mockEnqueueStage,
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { POST } from "@/app/api/webhooks/stripe/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(body = "{}") {
  return new NextRequest("http://localhost/api/webhooks/stripe", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", "stripe-signature": "valid-sig" },
  });
}

function makeSelectChain(rows: unknown[]) {
  const chain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(rows), limit: vi.fn().mockReturnThis() };
  mockDbSelect.mockReturnValueOnce(chain);
  return chain;
}

function makeUpdateChain() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  mockDbUpdate.mockReturnValueOnce({ set });
  return { set, where };
}

function makeInsertChain() {
  const values = vi.fn().mockResolvedValue(undefined);
  mockDbInsert.mockReturnValueOnce({ values });
  return { values };
}

// ─── amountCents resolution from session.amount_total ────────────────────────

describe("audit_purchase webhook — amountCents resolved from session (not hardcoded)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.NEXT_PUBLIC_APP_URL = "https://test.flowblinq.com";

    mockCreateUser.mockResolvedValue({ data: { user: { id: "supa-user-id" } }, error: null });
    mockGenerateLink.mockResolvedValue({
      data: { user: { id: "supa-user-id" }, properties: { action_link: "https://supabase.co/magic" } },
      error: null,
    });
  });

  it("uses amount_total (1130) for amountCents when HST is included", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_hst_1130",
          metadata: { type: "audit_purchase" },
          customer_details: { email: "buyer@example.com" },
          payment_intent: "pi_hst_123",
          amount_total: 1130,
          amount_subtotal: 1000,
        },
      },
    });

    makeSelectChain([]); // no existing purchase
    const insertChain = makeInsertChain();
    makeUpdateChain(); // userId/teamId/magicLink update

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);

    // The insert must have been called with amountCents: 1130 (not 1000)
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 1130 }),
    );
  });

  it("falls back to amount_subtotal (1000) when amount_total is null", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_no_total",
          metadata: { type: "audit_purchase" },
          customer_details: { email: "buyer@example.com" },
          payment_intent: "pi_nototal_123",
          amount_total: null,
          amount_subtotal: 1000,
        },
      },
    });

    makeSelectChain([]); // no existing purchase
    const insertChain = makeInsertChain();
    makeUpdateChain(); // userId/teamId/magicLink update

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);

    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 1000 }),
    );

    // Warning log must fire when amount_total is null
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("audit_purchase_webhook_amount_null"),
    );
    warnSpy.mockRestore();
  });

  it("falls back to 0 when both amount_total and amount_subtotal are null/undefined", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_no_amounts",
          metadata: { type: "audit_purchase" },
          customer_details: { email: "buyer@example.com" },
          payment_intent: "pi_noamounts_123",
          amount_total: null,
          amount_subtotal: null,
        },
      },
    });

    makeSelectChain([]); // no existing purchase
    const insertChain = makeInsertChain();
    makeUpdateChain(); // userId/teamId/magicLink update

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);

    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 0 }),
    );

    // Warning log must fire
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("audit_purchase_webhook_amount_null"),
    );
    warnSpy.mockRestore();
  });
});

// ─── Task 7.2: auto user+team at checkout.session.completed audit_purchase ───

describe("Task 7.2 — checkout.session.completed audit_purchase auto-provisions user+team", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.NEXT_PUBLIC_APP_URL = "https://test.flowblinq.com";
  });

  it("creates Supabase user and provisions team on new audit_purchase", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_audit_new",
          metadata: { type: "audit_purchase" },
          customer_details: { email: "buyer@example.com" },
          payment_intent: "pi_test_123",
        },
      },
    });

    // No existing purchase (idempotency check)
    makeSelectChain([]);

    // Insert purchase row
    makeInsertChain();

    // Supabase: createUser succeeds
    mockCreateUser.mockResolvedValueOnce({ data: { user: { id: "supabase-user-id" } }, error: null });
    // Supabase: generateLink succeeds
    mockGenerateLink.mockResolvedValueOnce({
      data: { user: { id: "supabase-user-id" }, properties: { action_link: "https://supabase.co/magic" } },
      error: null,
    });

    // Update purchase with userId/teamId/magicLink
    makeUpdateChain();

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);

    // ensureTeamForUser called with skipBonus: true so the team starts at 0 credits.
    // Product decision: the $10 purchase entitles the customer to ONE audit (already
    // running); any further action (rerun/regen/retry) prompts the standard recharge.
    expect(mockEnsureTeamForUser).toHaveBeenCalledWith(
      "supabase-user-id",
      "buyer@example.com",
      { skipBonus: true },
    );

    // The update with userId/teamId/magicLink should have been called
    expect(mockDbUpdate).toHaveBeenCalled();
  });

  it("handles user already existing (collision) gracefully — returns 200 without throwing", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_audit_existing_user_2",
          metadata: { type: "audit_purchase" },
          customer_details: { email: "existing2@example.com" },
          payment_intent: "pi_existing_456",
        },
      },
    });

    makeSelectChain([]); // no existing purchase row
    makeInsertChain();   // insert purchase

    // createUser returns "already been registered" error — non-fatal collision
    mockCreateUser.mockResolvedValueOnce({
      data: null,
      error: { message: "User already has been registered" },
    });
    // listUsers resolves the colliding user (Fix #4 pagination path) so provisioning
    // genuinely succeeds — previously this was unmocked and the destructure threw,
    // which the old catch silently swallowed into a 200 (masked under FIX-005's 500).
    mockListUsers.mockResolvedValueOnce({
      data: { users: [{ id: "existing-supabase-id-2", email: "existing2@example.com" }] },
    });
    // generateLink returns existing user's link
    mockGenerateLink.mockResolvedValueOnce({
      data: { user: { id: "existing-supabase-id-2" }, properties: { action_link: "https://supabase.co/magic3" } },
      error: null,
    });

    makeUpdateChain(); // update with userId/teamId

    const res = await POST(makeRequest("{}"));
    // Must return 200 — collision is non-fatal, Stripe must not retry
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("returns 500 (so Stripe retries) when Supabase is unavailable at user creation", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_audit_supabase_down",
          metadata: { type: "audit_purchase" },
          customer_details: { email: "buyer2@example.com" },
          payment_intent: "pi_down_123",
        },
      },
    });

    makeSelectChain([]); // no existing purchase
    makeInsertChain();   // insert purchase

    // createUser throws (simulates Supabase being down)
    mockCreateUser.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await POST(makeRequest("{}"));
    // FIX-005: return 500 so Stripe redelivers the EVENT (not the charge). The paid
    // row is persisted and the provisioning-aware idempotency guard lets the retry
    // re-attempt provisioning once Supabase recovers.
    expect(res.status).toBe(500);

    // Should alert ops about the failure (Fix #7: type changed to provision_failure)
    expect(mockSendInternalPaymentAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "audit_purchase_pipeline_skipped_due_to_provision_failure" }),
    );
  });

  it("idempotency: skips all work when purchase row already exists", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_audit_idempotent",
          metadata: { type: "audit_purchase" },
          customer_details: { email: "buyer3@example.com" },
        },
      },
    });

    // Existing FULLY-PROVISIONED purchase (teamId set) → idempotent return.
    // FIX-005: a row missing teamId would instead re-attempt provisioning.
    makeSelectChain([{ id: "existing-purchase-row", teamId: "team-existing" }]);

    const res = await POST(makeRequest("{}"));
    const body = await res.json() as { ok: boolean; idempotent: boolean };
    expect(res.status).toBe(200);
    expect(body.idempotent).toBe(true);

    // No user provisioning should happen
    expect(mockEnsureTeamForUser).not.toHaveBeenCalled();
  });
});

// ── Fix #7: skip pipeline kickoff when user provisioning fails ────────────────

describe("Fix #7 — pipeline kickoff skipped when user provisioning throws", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.NEXT_PUBLIC_APP_URL = "https://test.flowblinq.com";

    mockValidatePublicUrl.mockReturnValue({ ok: true, url: new URL("https://example.com/") });
  });

  it("skips pipeline kickoff and fires provision_failure alert when createUser throws", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_provision_fail",
          metadata: { type: "audit_purchase", websiteUrl: "https://example.com" },
          customer_details: { email: "buyer@example.com" },
          payment_intent: "pi_provision_fail_123",
        },
      },
    });

    makeSelectChain([]); // no existing purchase
    makeInsertChain();   // insert auditPurchases

    // createUser throws — triggers the provision failure catch block
    mockCreateUser.mockRejectedValueOnce(new Error("Supabase ECONNREFUSED"));

    const res = await POST(makeRequest("{}"));
    // FIX-005: 500 so Stripe redelivers the event; idempotency makes the retry safe.
    expect(res.status).toBe(500);

    // Pipeline should NOT have been kicked off (no geoSites insert, no enqueueStage)
    expect(mockEnqueueStage).not.toHaveBeenCalled();

    // Only the auditPurchases insert (1), no geoSites insert
    // (geoSites insert is inside the pipeline kickoff block, which is skipped)
    expect(mockDbInsert).toHaveBeenCalledTimes(1);

    // Ops alert must fire with the provision failure type
    expect(mockSendInternalPaymentAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "audit_purchase_pipeline_skipped_due_to_provision_failure",
      }),
    );
  });
});

// ─── Task 7.4: checkout.session.expired ──────────────────────────────────────

describe("Task 7.4 — checkout.session.expired", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  it("updates status to expired when a purchase row exists", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.expired",
      data: {
        object: {
          id: "cs_expired_123",
          metadata: { type: "audit_purchase" },
          customer_details: { email: "buyer@example.com" },
        },
      },
    });

    // Existing purchase found
    makeSelectChain([{ id: "purchase-id-expired" }]);
    // Update chain for status update
    makeUpdateChain();

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);

    // Must update status to "expired"
    expect(mockDbUpdate).toHaveBeenCalled();

    // Must fire internal alert (info-only)
    expect(mockSendInternalPaymentAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "audit_purchase_expired" }),
    );
  });

  it("does nothing when no purchase row exists (no row to update)", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.expired",
      data: {
        object: {
          id: "cs_expired_no_row",
          metadata: { type: "audit_purchase" },
          customer_details: { email: "ghost@example.com" },
        },
      },
    });

    // No existing purchase
    makeSelectChain([]);

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);

    // Should not call update (no row to update)
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it("ignores expired sessions without audit_purchase metadata", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.expired",
      data: {
        object: {
          id: "cs_expired_credits",
          metadata: { type: "credits", teamId: "team-1" },
        },
      },
    });

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });
});

// ─── Task 7.4: payment_intent.payment_failed ─────────────────────────────────

describe("Task 7.4 — payment_intent.payment_failed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  it("updates status to failed_payment and fires internal alert when purchase found", async () => {
    mockConstructEvent.mockReturnValue({
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: "pi_declined_123",
          last_payment_error: { message: "Card declined" },
        },
      },
    });

    // Purchase found by payment intent id
    makeSelectChain([{
      id: "purchase-id-declined",
      customerEmail: "buyer@example.com",
      domain: "example.com",
    }]);
    makeUpdateChain();

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);

    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockSendInternalPaymentAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "audit_purchase_failed" }),
    );

    // No customer email — Stripe sends the decline notice
    expect(mockSendAuditPurchaseFailedEmail).not.toHaveBeenCalled();
  });

  it("does nothing when no purchase is linked to the payment intent", async () => {
    mockConstructEvent.mockReturnValue({
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: "pi_unrelated_456",
        },
      },
    });

    makeSelectChain([]); // no purchase found

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });
});

// ─── Task 7.4: charge.refunded ───────────────────────────────────────────────

describe("Task 7.4 — charge.refunded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  it("updates status to refunded, fires internal alert, and sends customer refund email", async () => {
    mockConstructEvent.mockReturnValue({
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_refunded_123",
          payment_intent: "pi_refunded_123",
          amount_refunded: 1000,
        },
      },
    });

    makeSelectChain([{
      id: "purchase-id-refunded",
      customerEmail: "buyer@example.com",
      domain: "example.com",
    }]);
    makeUpdateChain();

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);

    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockSendInternalPaymentAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "audit_purchase_refunded" }),
    );
    // Customer refund email should be sent
    expect(mockSendAuditPurchaseRefundedEmail).toHaveBeenCalledWith(
      "buyer@example.com",
      "example.com",
    );
  });

  it("does not send customer email when domain is missing on the purchase row", async () => {
    mockConstructEvent.mockReturnValue({
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_no_domain_123",
          payment_intent: "pi_no_domain_123",
        },
      },
    });

    makeSelectChain([{
      id: "purchase-no-domain",
      customerEmail: "buyer@example.com",
      domain: null,
    }]);
    makeUpdateChain();

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    // Internal alert still fires
    expect(mockSendInternalPaymentAlert).toHaveBeenCalled();
    // But no customer email (no domain to include)
    expect(mockSendAuditPurchaseRefundedEmail).not.toHaveBeenCalled();
  });

  it("does nothing when no purchase is linked to the charge", async () => {
    mockConstructEvent.mockReturnValue({
      type: "charge.refunded",
      data: {
        object: { id: "ch_unrelated_789", payment_intent: null },
      },
    });

    makeSelectChain([]); // no purchase found

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockSendAuditPurchaseRefundedEmail).not.toHaveBeenCalled();
  });
});

// ─── Task 7.4: charge.dispute.created ────────────────────────────────────────

describe("Task 7.4 — charge.dispute.created", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  it("updates status to disputed and fires HIGH-priority internal alert (no customer email)", async () => {
    mockConstructEvent.mockReturnValue({
      type: "charge.dispute.created",
      data: {
        object: {
          id: "dp_dispute_123",
          charge: "ch_disputed_abc",
          reason: "fraudulent",
        },
      },
    });

    makeSelectChain([{
      id: "purchase-id-disputed",
      customerEmail: "disputer@example.com",
      domain: "disputed.com",
    }]);
    makeUpdateChain();

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);

    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockSendInternalPaymentAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "audit_purchase_disputed",
        customerEmail: "disputer@example.com",
      }),
    );

    // Must NOT send a customer email for disputes
    expect(mockSendAuditPurchaseRefundedEmail).not.toHaveBeenCalled();
    expect(mockSendAuditPurchaseFailedEmail).not.toHaveBeenCalled();
  });

  it("does nothing when no purchase is linked to the disputed charge", async () => {
    mockConstructEvent.mockReturnValue({
      type: "charge.dispute.created",
      data: {
        object: {
          id: "dp_unrelated_999",
          charge: "ch_unrelated_xyz",
          reason: "general",
        },
      },
    });

    makeSelectChain([]); // no purchase found

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });
});

// ─── Task 18: webhook-triggered pipeline kickoff ──────────────────────────────

describe("Task 18 — checkout.session.completed audit_purchase kicks off pipeline from webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.NEXT_PUBLIC_APP_URL = "https://test.flowblinq.com";

    // Default: SSRF validation passes
    mockValidatePublicUrl.mockReturnValue({
      ok: true,
      url: new URL("https://example.com/"),
    });

    // Default: createUser and generateLink succeed
    mockCreateUser.mockResolvedValue({
      data: { user: { id: "supa-user-id" } },
      error: null,
    });
    mockGenerateLink.mockResolvedValue({
      data: { user: { id: "supa-user-id" }, properties: { action_link: "https://supabase.co/magic" } },
      error: null,
    });
  });

  it("creates geoSites row, stamps siteId on auditPurchases, and enqueues pipeline when websiteUrl is present", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_pipeline_kickoff",
          metadata: { type: "audit_purchase", websiteUrl: "https://example.com" },
          customer_details: { email: "buyer@example.com" },
          payment_intent: "pi_kickoff_123",
        },
      },
    });

    makeSelectChain([]);      // idempotency: no existing purchase
    makeInsertChain();         // insert auditPurchases row

    // user provisioning select (listUsers fallback — not hit here)
    // update for userId/teamId/magicLink
    makeUpdateChain();

    // Pipeline kickoff: select teamId from auditPurchases
    makeSelectChain([{ teamId: "provisioned-team-id" }]);
    // Insert geoSites
    makeInsertChain();
    // Update auditPurchases with siteId
    makeUpdateChain();

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);

    // validatePublicUrl must be called with the websiteUrl from metadata
    expect(mockValidatePublicUrl).toHaveBeenCalledWith("https://example.com");

    // geoSites insert must have been called
    expect(mockDbInsert).toHaveBeenCalledTimes(2); // auditPurchases + geoSites

    // auditPurchases update for siteId/domain/status must have been called
    // (total updates: userId/teamId/magicLink + siteId/domain/status)
    expect(mockDbUpdate).toHaveBeenCalledTimes(2);

    // Pipeline must have been enqueued
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "discover" }),
    );

    // Confirmation email sent
    expect(mockSendAuditPurchaseConfirmationEmail).toHaveBeenCalledWith(
      "buyer@example.com",
      expect.any(String),
    );
  });

  it("logs warning and skips pipeline when websiteUrl is absent from metadata", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_no_url",
          metadata: { type: "audit_purchase" }, // no websiteUrl
          customer_details: { email: "buyer@example.com" },
          payment_intent: "pi_no_url_123",
        },
      },
    });

    makeSelectChain([]);   // no existing purchase
    makeInsertChain();      // insert auditPurchases
    makeUpdateChain();      // userId/teamId/magicLink update

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);

    // No pipeline enqueue — websiteUrl was missing
    expect(mockEnqueueStage).not.toHaveBeenCalled();
    // No geoSites insert
    expect(mockDbInsert).toHaveBeenCalledTimes(1); // only auditPurchases
  });

  it("logs error and skips pipeline when websiteUrl fails SSRF validation", async () => {
    mockValidatePublicUrl.mockReturnValue({ ok: false, error: "private_ip" });

    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_ssrf_blocked",
          metadata: { type: "audit_purchase", websiteUrl: "http://localhost" },
          customer_details: { email: "attacker@example.com" },
          payment_intent: "pi_ssrf_123",
        },
      },
    });

    makeSelectChain([]);   // no existing purchase
    makeInsertChain();      // insert auditPurchases
    makeUpdateChain();      // userId/teamId/magicLink update

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);

    // SSRF blocked — no pipeline, no geoSites
    expect(mockEnqueueStage).not.toHaveBeenCalled();
    expect(mockDbInsert).toHaveBeenCalledTimes(1); // only auditPurchases
  });

  it("returns 200 (non-fatal) when pipeline kickoff throws unexpectedly", async () => {
    mockEnqueueStage.mockRejectedValueOnce(new Error("QStash timeout"));

    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_pipeline_error",
          metadata: { type: "audit_purchase", websiteUrl: "https://example.com" },
          customer_details: { email: "buyer@example.com" },
          payment_intent: "pi_err_123",
        },
      },
    });

    makeSelectChain([]);      // no existing purchase
    makeInsertChain();         // insert auditPurchases
    makeUpdateChain();         // userId/teamId/magicLink update

    // Pipeline kickoff: select teamId
    makeSelectChain([{ teamId: "provisioned-team-id" }]);
    // Insert geoSites
    makeInsertChain();
    // Update auditPurchases with siteId
    makeUpdateChain();

    const res = await POST(makeRequest("{}"));
    // Must return 200 — pipeline kickoff failure is non-fatal
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ── Fix #4: listUsers pagination — user on page 2 must be found ───────────────

describe("Fix #4 — listUsers pagination finds user beyond first 1000", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.NEXT_PUBLIC_APP_URL = "https://test.flowblinq.com";

    mockValidatePublicUrl.mockReturnValue({ ok: true, url: new URL("https://example.com/") });
    mockGenerateLink.mockResolvedValue({
      data: { user: { id: "user-on-page-2" }, properties: { action_link: "https://supabase.co/magic" } },
      error: null,
    });
  });

  it("finds existing user on page 2 of listUsers and sets supaUserId correctly", async () => {
    // createUser returns collision error
    mockCreateUser.mockResolvedValue({
      data: null,
      error: { message: "User already has been registered" },
    });

    // Page 1: 1000 users, none matching; page 2: 1 user matching
    const page1Users = Array.from({ length: 1000 }, (_, i) => ({
      id: `other-user-${i}`,
      email: `other${i}@example.com`,
    }));
    const page2Users = [{ id: "user-on-page-2", email: "Buyer@Example.com" }]; // mixed-case to test case-insensitive match

    mockListUsers
      .mockResolvedValueOnce({ data: { users: page1Users, nextPage: 2 }, error: null })
      .mockResolvedValueOnce({ data: { users: page2Users, nextPage: null }, error: null });

    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_page2_test",
          metadata: { type: "audit_purchase" },
          customer_details: { email: "buyer@example.com" },
          payment_intent: "pi_page2_123",
        },
      },
    });

    makeSelectChain([]); // no existing purchase row
    makeInsertChain();   // insert auditPurchases
    makeUpdateChain();   // userId/teamId/magicLink update

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);

    // listUsers must have been called twice (page 1 and page 2)
    expect(mockListUsers).toHaveBeenCalledTimes(2);
    expect(mockListUsers).toHaveBeenNthCalledWith(1, { page: 1, perPage: 1000 });
    expect(mockListUsers).toHaveBeenNthCalledWith(2, { page: 2, perPage: 1000 });

    // ensureTeamForUser should be called with the user found on page 2
    expect(mockEnsureTeamForUser).toHaveBeenCalledWith(
      "user-on-page-2",
      "buyer@example.com",
      { skipBonus: true },
    );
  });

  it("stops paginating after finding the user on the first page", async () => {
    mockCreateUser.mockResolvedValue({
      data: null,
      error: { message: "User already has been registered" },
    });

    // User found on page 1
    mockListUsers.mockResolvedValue({
      data: { users: [{ id: "user-page-1", email: "buyer@example.com" }], nextPage: null },
      error: null,
    });

    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_page1_found",
          metadata: { type: "audit_purchase" },
          customer_details: { email: "buyer@example.com" },
          payment_intent: "pi_page1_123",
        },
      },
    });

    makeSelectChain([]);
    makeInsertChain();
    makeUpdateChain();

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);

    // Only one listUsers call needed (found on page 1)
    expect(mockListUsers).toHaveBeenCalledTimes(1);
  });
});
