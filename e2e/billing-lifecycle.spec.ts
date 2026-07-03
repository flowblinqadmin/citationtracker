/**
 * e2e/billing-lifecycle.spec.ts
 *
 * Billing lifecycle coverage: subscription activation → renewal → past_due → cancellation.
 *
 * APPROACH: Playwright drives the browser for /dashboard observation (UI state);
 * signed Stripe webhook events drive all billing transitions (server-to-server).
 * No real Stripe API calls are made — the dev server uses a dummy STRIPE_SECRET_KEY.
 *
 * Each transition:
 *   1. Posts a signed webhook event to /api/webhooks/stripe
 *   2. Asserts the DB end-state (primary assertion)
 *   3. Reloads /dashboard (secondary, tolerant — UI may or may not surface the exact field)
 */

import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { postSignedStripeEvent } from "./helpers/stripe-webhook";
import { TEST_TEAM_ID, TEST_USER_ID, TEST_USER_EMAIL } from "./fixtures/ids";
import { SUBSCRIPTION_TIERS } from "../lib/config";
import { E2E_STRIPE_WEBHOOK_SECRET } from "../playwright.config";

// ── Constants ────────────────────────────────────────────────────────────────

// Deterministic subscription ID for this lifecycle test.
// Must NOT collide with any seed row's stripeSubscriptionId.
const SUB_ID = "sub_lifecycle_e2e_test_001";
const CUSTOMER_ID = "cus_lifecycle_e2e_001";

// Stripe session ID for the activation event (used in dedup guard check)
const SESSION_ID = "cs_lifecycle_e2e_test_001";

const STARTER_TIER = SUBSCRIPTION_TIERS.starter;

// ── DB helper ────────────────────────────────────────────────────────────────

function getDb() {
  const url = process.env.DATABASE_URL ?? "";
  return postgres(url, { max: 1, prepare: false });
}

async function getTeamRow(sql: ReturnType<typeof postgres>, teamId: string) {
  const [row] = await sql`
    SELECT
      credit_balance,
      subscription_tier,
      subscription_status,
      stripe_subscription_id,
      stripe_customer_id,
      monthly_page_allowance,
      monthly_pages_used
    FROM teams WHERE id = ${teamId}
  `;
  return row ?? null;
}

// ── Reset: restore seeded state before each test in this file ────────────────

test.beforeEach(async () => {
  const sql = getDb();
  try {
    // Reset to the seed baseline: free/inactive, 10 credits, no subscription.
    await sql`
      UPDATE teams SET
        subscription_tier      = 'free',
        subscription_status    = 'inactive',
        credit_balance         = 10,
        stripe_subscription_id = NULL,
        stripe_customer_id     = NULL,
        monthly_page_allowance = 20,
        monthly_pages_used     = 0,
        current_period_end     = NULL,
        updated_at             = NOW()
      WHERE id = ${TEST_TEAM_ID}
    `;
    // Remove any dedup marker rows from prior runs of this spec.
    await sql`
      DELETE FROM credit_transactions
      WHERE team_id = ${TEST_TEAM_ID}
        AND site_id IN (${SESSION_ID})
    `;
  } finally {
    await sql.end();
  }
});

// ── Helper: build a minimal invoice event ────────────────────────────────────

function makeInvoiceEvent(
  type: "invoice.paid" | "invoice.payment_failed",
  opts: {
    teamId: string;
    subscriptionId: string;
    billingReason?: string;
    periodStart?: number;
    periodEnd?: number;
    customerEmail?: string;
  },
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `evt_e2e_${type.replace(".", "_")}_${Date.now()}`,
    object: "event",
    type,
    livemode: false,
    created: now,
    data: {
      object: {
        id: `in_e2e_${Date.now()}`,
        object: "invoice",
        billing_reason: opts.billingReason ?? "subscription_cycle",
        customer_email: opts.customerEmail ?? TEST_USER_EMAIL,
        parent: {
          subscription_details: {
            subscription: opts.subscriptionId,
            metadata: {
              teamId: opts.teamId,
              plan: "starter",
              type: "subscription_signup",
            },
          },
        },
        lines: {
          data: [
            {
              period: {
                start: opts.periodStart ?? now,
                end: opts.periodEnd ?? now + 30 * 24 * 3600,
              },
            },
          ],
        },
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVATION: checkout.session.completed (authenticated upgrade path)
// Uses metadata.teamId + metadata.userId to skip Supabase user-provisioning.
// ─────────────────────────────────────────────────────────────────────────────

test("billing:activation — checkout.session.completed grants starter credits", async ({ page, baseURL }) => {
  const base = baseURL ?? "http://localhost:3000";
  const sql = getDb();

  try {
    const initialRow = await getTeamRow(sql, TEST_TEAM_ID);
    expect(initialRow).not.toBeNull();
    expect(initialRow!.subscription_tier).toBe("free");

    // Build the checkout.session.completed event (authenticated upgrade path).
    // metadata.teamId + metadata.userId → handler skips provisioning, writes directly.
    const event: Record<string, unknown> = {
      id: `evt_e2e_checkout_${Date.now()}`,
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: SESSION_ID,
          object: "checkout.session",
          mode: "subscription",
          customer: CUSTOMER_ID,
          customer_email: TEST_USER_EMAIL,
          subscription: SUB_ID,
          metadata: {
            // Authenticated upgrade path (not subscription_signup):
            // teamId + plan, no "type" key → routes to the subscription-checkout
            // branch at line 746. userId omitted: member check is only applied
            // when userId is present (the handler skips it when absent).
            teamId: TEST_TEAM_ID,
            plan: "starter",
          },
        },
      },
    };

    const { status, json } = await postSignedStripeEvent(base, event, E2E_STRIPE_WEBHOOK_SECRET);

    // Webhook must succeed.
    expect(status).toBe(200);
    expect((json as Record<string, unknown>).ok).toBe(true);

    // DB assertion: team must now be starter/active with the correct credit pool.
    const afterRow = await getTeamRow(sql, TEST_TEAM_ID);
    expect(afterRow).not.toBeNull();
    expect(afterRow!.subscription_tier).toBe("starter");
    expect(afterRow!.subscription_status).toBe("active");
    expect(afterRow!.stripe_subscription_id).toBe(SUB_ID);
    expect(afterRow!.stripe_customer_id).toBe(CUSTOMER_ID);
    // tierEntitlementColumns(starter, 1) = starter.credits × 1 = 1500
    expect(afterRow!.credit_balance).toBe(STARTER_TIER.credits);
    // Credit pool model: monthlyPageAllowance zeroed
    expect(afterRow!.monthly_page_allowance).toBe(0);

    // UI check: load /dashboard, assert no redirect to /auth/login (authenticated).
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    expect(page.url()).not.toContain("/auth/login");
    // Tolerant: just confirm the page loaded without 403/500.
    // The specific credit/tier UI element may not be present in all builds.
    const pageTitle = await page.title();
    expect(pageTitle).toBeTruthy();
  } finally {
    await sql.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RENEWAL: invoice.paid (billing_reason=subscription_cycle)
// Verifies that the credit pool is refreshed each billing cycle.
// ─────────────────────────────────────────────────────────────────────────────

test("billing:renewal — invoice.paid refreshes credit pool", async ({ page, baseURL }) => {
  const base = baseURL ?? "http://localhost:3000";
  const sql = getDb();

  try {
    // Pre-condition: activate the subscription first so the renewal has a team to update.
    await sql`
      UPDATE teams SET
        subscription_tier      = 'starter',
        subscription_status    = 'active',
        credit_balance         = 0,          -- simulate spent credits pre-renewal
        stripe_subscription_id = ${SUB_ID},
        stripe_customer_id     = ${CUSTOMER_ID},
        monthly_page_allowance = 0,
        monthly_pages_used     = 500,
        updated_at             = NOW()
      WHERE id = ${TEST_TEAM_ID}
    `;

    const now = Math.floor(Date.now() / 1000);
    const periodStart = now;
    const periodEnd = now + 30 * 24 * 3600; // ~1 month

    const event = makeInvoiceEvent("invoice.paid", {
      teamId: TEST_TEAM_ID,
      subscriptionId: SUB_ID,
      billingReason: "subscription_cycle",
      periodStart,
      periodEnd,
      customerEmail: TEST_USER_EMAIL,
    });

    const { status, json } = await postSignedStripeEvent(base, event, E2E_STRIPE_WEBHOOK_SECRET);

    expect(status).toBe(200);

    // DB assertion: monthly credit pool refreshed.
    const afterRow = await getTeamRow(sql, TEST_TEAM_ID);
    expect(afterRow).not.toBeNull();
    // monthlyPagesUsed should be reset to 0.
    expect(afterRow!.monthly_pages_used).toBe(0);
    // Credit pool refreshed: tierEntitlementColumns(starter, 1) = 1500 for a ~1-month period.
    expect(afterRow!.credit_balance).toBe(STARTER_TIER.credits);

    // UI check: dashboard loads successfully.
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    expect(page.url()).not.toContain("/auth/login");
  } finally {
    await sql.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PAST_DUE: invoice.payment_failed
// Verifies that a failed payment marks the subscription as past_due.
// ─────────────────────────────────────────────────────────────────────────────

test("billing:past_due — invoice.payment_failed sets subscriptionStatus to past_due", async ({ page, baseURL }) => {
  const base = baseURL ?? "http://localhost:3000";
  const sql = getDb();

  try {
    // Pre-condition: active subscription.
    await sql`
      UPDATE teams SET
        subscription_tier      = 'starter',
        subscription_status    = 'active',
        credit_balance         = ${STARTER_TIER.credits},
        stripe_subscription_id = ${SUB_ID},
        stripe_customer_id     = ${CUSTOMER_ID},
        monthly_page_allowance = 0,
        monthly_pages_used     = 0,
        updated_at             = NOW()
      WHERE id = ${TEST_TEAM_ID}
    `;

    // The payment_failed handler reads metadata.teamId from invoice.parent.subscription_details.metadata.
    // When teamId is present there, it does NOT call stripe.subscriptions.retrieve (no real API call needed).
    // It then sets subscriptionStatus = subscription?.status ?? "past_due".
    // Since subscription is null (we have teamId), newStatus = "past_due".
    const event = makeInvoiceEvent("invoice.payment_failed", {
      teamId: TEST_TEAM_ID,
      subscriptionId: SUB_ID,
      customerEmail: TEST_USER_EMAIL,
    });

    const { status } = await postSignedStripeEvent(base, event, E2E_STRIPE_WEBHOOK_SECRET);
    expect(status).toBe(200);

    // DB assertion: subscriptionStatus must be "past_due".
    const afterRow = await getTeamRow(sql, TEST_TEAM_ID);
    expect(afterRow).not.toBeNull();
    expect(afterRow!.subscription_status).toBe("past_due");
    // Credit balance and tier remain unchanged (dunning, not cancellation).
    expect(afterRow!.subscription_tier).toBe("starter");
    expect(afterRow!.credit_balance).toBe(STARTER_TIER.credits);

    // UI check.
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    expect(page.url()).not.toContain("/auth/login");
  } finally {
    await sql.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CANCELLATION: customer.subscription.deleted
// Verifies that credits are revoked, tier → free, status → inactive.
// ─────────────────────────────────────────────────────────────────────────────

test("billing:cancellation — customer.subscription.deleted zeroes credits and downgrades tier", async ({ page, baseURL }) => {
  const base = baseURL ?? "http://localhost:3000";
  const sql = getDb();

  try {
    // Pre-condition: active subscription with credits.
    await sql`
      UPDATE teams SET
        subscription_tier      = 'starter',
        subscription_status    = 'active',
        credit_balance         = ${STARTER_TIER.credits},
        stripe_subscription_id = ${SUB_ID},
        stripe_customer_id     = ${CUSTOMER_ID},
        monthly_page_allowance = 0,
        monthly_pages_used     = 0,
        updated_at             = NOW()
      WHERE id = ${TEST_TEAM_ID}
    `;

    const now = Math.floor(Date.now() / 1000);
    const event: Record<string, unknown> = {
      id: `evt_e2e_sub_deleted_${Date.now()}`,
      object: "event",
      type: "customer.subscription.deleted",
      livemode: false,
      created: now,
      data: {
        object: {
          id: SUB_ID,
          object: "subscription",
          status: "canceled",
          customer: CUSTOMER_ID,
          metadata: {
            teamId: TEST_TEAM_ID,
            plan: "starter",
          },
        },
      },
    };

    const { status } = await postSignedStripeEvent(base, event, E2E_STRIPE_WEBHOOK_SECRET);
    expect(status).toBe(200);

    // DB assertions: full credit revocation and tier downgrade.
    const afterRow = await getTeamRow(sql, TEST_TEAM_ID);
    expect(afterRow).not.toBeNull();
    // FIX-004: creditBalance must be 0 on cancellation (paid credit pool revoked).
    expect(afterRow!.credit_balance).toBe(0);
    // Tier back to free.
    expect(afterRow!.subscription_tier).toBe("free");
    // Status inactive.
    expect(afterRow!.subscription_status).toBe("inactive");
    // stripeSubscriptionId cleared.
    expect(afterRow!.stripe_subscription_id).toBeNull();

    // UI check.
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    expect(page.url()).not.toContain("/auth/login");
  } finally {
    await sql.end();
  }
});
