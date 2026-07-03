/**
 * REAL-DB integration test for the payment-first subscription flow.
 *
 * Runs the actual Stripe webhook handler against a real Postgres (Docker) using
 * real Drizzle + real provisioning/credit logic. Only the external boundaries are
 * stubbed: Stripe API (constructEvent / subscriptions.update), Supabase admin
 * (createUser / generateLink), QStash (enqueueStage), email. NO live charges.
 *
 * This is the closest achievable "account provisioning + credits" end-to-end
 * without Stripe test-mode credentials. It validates against the REAL schema:
 *   - signup → team provisioned, tier activated, creditBalance granted (1500),
 *     first audit deducted (geoSites + creditTransactions, balance → 1490)
 *   - renewal (invoice.paid) → creditBalance refreshed to tier credits
 *
 * Guarded by PGVECTOR_E2E=1 so it is skipped in normal CI (no Docker DB).
 * Run with:
 *   docker run pgvector + drizzle-kit push, then
 *   SUPABASE_DATABASE_URL=postgresql://e2e:e2e@127.0.0.1:5499/geo_e2e \
 *   PGVECTOR_E2E=1 npx vitest run app/api/webhooks/stripe/__tests__/signup-db-integration.test.ts
 */

import { describe, it, expect, vi, beforeAll } from "vitest";

const RUN = process.env.PGVECTOR_E2E === "1";
const d = RUN ? describe : describe.skip;

const { mockConstructEvent, mockSubUpdate, mockGetSupabaseAdmin } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockSubUpdate: vi.fn().mockResolvedValue({}),
  mockGetSupabaseAdmin: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: vi.fn(function () {
    return {
      webhooks: { constructEvent: mockConstructEvent },
      subscriptions: { update: mockSubUpdate, retrieve: vi.fn() },
    };
  }),
}));

// Stub Supabase admin so provisionUserAndTeamFromEmail returns a user id without
// touching a real Supabase project. ensureTeamForUser still runs against REAL db.
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: mockGetSupabaseAdmin }));

vi.mock("@/lib/qstash", () => ({ enqueueStage: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/checkout-binding", () => ({
  verifyCheckoutBinding: vi.fn().mockReturnValue(true),
  CHECKOUT_BINDING_METADATA_KEY: "fb_bind",
}));

vi.mock("@/lib/ssrf", () => ({
  validatePublicUrl: vi.fn().mockReturnValue({ ok: true, url: new URL("https://acme-shop.example/") }),
}));

vi.mock("@/lib/email", () => ({
  sendSubscriptionConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendCreditsPurchasedEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionRenewalEmail: vi.fn().mockResolvedValue(undefined),
  sendPaymentFailedEmail: vi.fn().mockResolvedValue(undefined),
  sendSubscriptionCancelledEmail: vi.fn().mockResolvedValue(undefined),
  sendInternalPaymentAlert: vi.fn().mockResolvedValue(undefined),
  sendAuditPurchaseRefundedEmail: vi.fn().mockResolvedValue(undefined),
  sendAuditPurchaseConfirmationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    STRIPE_PRICE_IDS: {
      monthly: { starter: "price_starter_m", growth: "price_growth_m", pro: "" },
      quarterly: { starter: "price_starter_q", growth: "price_growth_q", pro: "" },
      annual: { starter: "", growth: "", pro: "price_pro_a" },
    },
  };
});

const SUFFIX = String(Date.now());

function makeRequest() {
  const { NextRequest } = require("next/server");
  return new NextRequest(
    new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: { "content-type": "text/plain", "stripe-signature": "sig" },
      body: "{}",
    }),
  );
}

d("payment-first subscription — REAL Postgres integration", () => {
  let POST: (req: unknown) => Promise<Response>;
  let db: any;
  let teams: any, creditTransactions: any, geoSites: any, teamMembers: any;
  let eq: any;

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_dummy";
    process.env.NEXT_PUBLIC_APP_URL = "https://geo.flowblinq.com";
    // Stub Supabase admin
    mockGetSupabaseAdmin.mockReturnValue({
      auth: {
        admin: {
          createUser: vi.fn().mockResolvedValue({ data: { user: { id: `user_${SUFFIX}` } }, error: null }),
          listUsers: vi.fn().mockResolvedValue({ data: { users: [] } }),
          generateLink: vi.fn().mockResolvedValue({
            data: { properties: { action_link: "https://geo.flowblinq.com/magic?t=abc" }, user: { id: `user_${SUFFIX}` } },
            error: null,
          }),
        },
      },
    });
    ({ POST } = await import("../route"));
    ({ db } = await import("@/lib/db"));
    const schema = await import("@/lib/db/schema");
    teams = schema.teams; creditTransactions = schema.creditTransactions; geoSites = schema.geoSites; teamMembers = schema.teamMembers;
    ({ eq } = await import("drizzle-orm"));
  });

  it("signup: provisions team, grants 1500 credits, deducts first audit to 1490", async () => {
    const subId = `sub_${SUFFIX}`;
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_${SUFFIX}`,
          mode: "subscription",
          subscription: subId,
          customer: `cus_${SUFFIX}`,
          customer_email: `buyer_${SUFFIX}@example.com`,
          customer_details: { email: `buyer_${SUFFIX}@example.com` },
          metadata: {
            type: "subscription_signup",
            plan: "starter",
            interval: "monthly",
            websiteUrl: "https://acme-shop.example/",
            fb_bind: "deadbeef",
          },
        },
      },
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const [team] = await db.select().from(teams).where(eq(teams.stripeSubscriptionId, subId));
    expect(team).toBeTruthy();
    expect(team.subscriptionTier).toBe("starter");
    expect(team.subscriptionStatus).toBe("active");
    expect(team.monthlyPageAllowance).toBe(0);
    // 1500 granted − 10 for the first 100-page audit
    expect(team.creditBalance).toBe(1490);

    // ledger row written
    const ledger = await db.select().from(creditTransactions).where(eq(creditTransactions.teamId, team.id));
    expect(ledger.some((l: any) => l.creditsChanged === -10 && l.type === "crawl_reserve")).toBe(true);

    // first audit site created, page-capped (not the $10 path's 250)
    const sites = await db.select().from(geoSites).where(eq(geoSites.teamId, team.id));
    expect(sites.length).toBe(1);
    expect(sites[0].crawlLimit).toBe(100);

    // teamId back-filled onto the subscription
    expect(mockSubUpdate).toHaveBeenCalledWith(subId, expect.objectContaining({ metadata: expect.objectContaining({ teamId: team.id }) }));
  });

  it("renewal (invoice.paid) refreshes the credit pool to the tier credits", async () => {
    // The team from the signup test now has 1490 credits; simulate a paid renewal cycle.
    const [team] = await db.select().from(teams).where(eq(teams.stripeSubscriptionId, `sub_${SUFFIX}`));
    expect(team.creditBalance).toBe(1490);

    mockConstructEvent.mockReturnValue({
      type: "invoice.paid",
      data: {
        object: {
          billing_reason: "subscription_cycle",
          parent: { subscription_details: { metadata: { teamId: team.id }, subscription: `sub_${SUFFIX}` } },
          lines: { data: [{ period: { end: 1893456000 } }] },
          customer_email: `buyer_${SUFFIX}@example.com`,
        },
      },
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const [refreshed] = await db.select().from(teams).where(eq(teams.id, team.id));
    // credits restored to the starter tier amount (1500), not stacked
    expect(refreshed.creditBalance).toBe(1500);
    expect(refreshed.monthlyPagesUsed).toBe(0);
  });
});
