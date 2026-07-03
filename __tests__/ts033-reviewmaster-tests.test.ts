/**
 * TS-033 — Independent ReviewMaster tests (Phase 3 gate)
 * AC-1 through AC-9
 *
 * Written spec-first before ScriptDev implementation. Expected RED on AC-1..AC-4
 * (sites gate not yet removed), AC-5..AC-6 (webhook still returns 200), AC-7 (checkout
 * still returns 200 instead of 409). GREEN after TS-033 is applied.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks — hoisted before imports ──────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("nanoid", () => ({ nanoid: vi.fn().mockReturnValue("mock-id") }));

vi.mock("@/lib/email", () => ({
  generateVerificationCode: vi.fn().mockReturnValue("123456"),
  hashCode: vi.fn().mockReturnValue("hashed-code"),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendLowCreditsEmail: vi.fn().mockResolvedValue(undefined),
  sendInternalSignupAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 5, resetAt: Date.now() + 60000 }),
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/pipeline/runner", () => ({
  runPipeline: vi.fn().mockResolvedValue(undefined),
}));

const { mockConstructEvent, mockStripeSessionCreate } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockStripeSessionCreate: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      webhooks: { constructEvent: mockConstructEvent },
      checkout: { sessions: { create: mockStripeSessionCreate } },
    };
  }),
}));

vi.mock("@/lib/supabase/authenticated-client", () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock("@/lib/services/provision-team", () => ({
  ensureTeamForUser: vi.fn().mockResolvedValue({ teamId: "auto-team-1" }),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { POST as postSites } from "@/app/api/sites/route";
import { POST as postWebhook } from "@/app/api/webhooks/stripe/route";
import { POST as postCheckout } from "@/app/api/checkout/route";
import { db } from "@/lib/db";
import { getAuthenticatedUser } from "@/lib/supabase/authenticated-client";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSelectChain(rows: unknown[] = []) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
}

function makeInsertChain() {
  return { values: vi.fn().mockResolvedValue([]) };
}

function makeUpdateChain() {
  return { set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
}

function makeSitesRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/sites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeWebhookRequest(): NextRequest {
  return new NextRequest("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "sig_test", "content-type": "text/plain" },
    body: "stripe-payload",
  });
}

function makeCheckoutRequest(): NextRequest {
  return new NextRequest("http://localhost/api/checkout", { method: "POST" });
}

function makeStripeEvent(metadata: Record<string, string>) {
  return {
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_123", metadata } },
  };
}

// ─── AC-1 & AC-2 — Sites: new email not in teamMembers ───────────────────────

describe("AC-1 — POST /api/sites: new email (not in teamMembers) → 201", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No existing site rows, no cached domain rows
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as unknown as ReturnType<typeof db.select>);
    vi.mocked(db.insert).mockReturnValue(makeInsertChain() as unknown as ReturnType<typeof db.insert>);
    vi.mocked(db.update).mockReturnValue(makeUpdateChain() as unknown as ReturnType<typeof db.update>);
  });

  it("AC-1 — new email not in teamMembers → 201 (not 402)", async () => {
    const res = await postSites(makeSitesRequest({ url: "https://newcustomer.com", email: "fresh@newcustomer.com" }));
    expect(res.status).toBe(201);
    const body = await res.json() as { error?: string; id?: string };
    expect(body.error).toBeUndefined();
    expect(body.id).toBe("mock-id");
  });

  it("AC-2 — new email → site inserted with teamId absent (null/undefined)", async () => {
    await postSites(makeSitesRequest({ url: "https://newcustomer.com", email: "fresh@newcustomer.com" }));

    // Capture the values passed to db.insert().values()
    const insertMock = vi.mocked(db.insert);
    expect(insertMock).toHaveBeenCalled();
    const valuesMock = insertMock.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> };
    const insertedRow = valuesMock.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertedRow).toBeDefined();
    // teamId must not be set (undefined or absent) — not a Pro-linked site
    expect(insertedRow.teamId).toBeFalsy();
  });
});

// ─── AC-3 — Sites: Pro email (in teamMembers) still gets 201 ─────────────────

describe("AC-3 — POST /api/sites: Pro email → 201 (existing path unchanged)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // After fix: no teamMembers lookup in single-domain path.
    // Both domain-check selects return [].
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as unknown as ReturnType<typeof db.select>);
    vi.mocked(db.insert).mockReturnValue(makeInsertChain() as unknown as ReturnType<typeof db.insert>);
    vi.mocked(db.update).mockReturnValue(makeUpdateChain() as unknown as ReturnType<typeof db.update>);
  });

  it("AC-3 — Pro email → 201 (not blocked after gate removal)", async () => {
    const res = await postSites(makeSitesRequest({ url: "https://prouser.com", email: "pro@somecompany.com" }));
    expect(res.status).toBe(201);
    const body = await res.json() as { error?: string };
    expect(body.error).toBeUndefined();
  });
});

// ─── AC-4 — Sites: bulk upload + new email → 402 (bulk gate intact) ──────────

describe("AC-4 — POST /api/sites: CSV bulk + new email → 402", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Bulk path: teamMembers lookup returns [] (new customer not in teamMembers)
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as unknown as ReturnType<typeof db.select>);
  });

  it("AC-4 — bulk upload with email not in teamMembers → 402 (bulk gate preserved)", async () => {
    const res = await postSites(makeSitesRequest({
      email: "fresh@newcustomer.com",
      bulkUrls: ["https://site1.com", "https://site2.com"],
    }));
    expect(res.status).toBe(402);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/Pro account/i);
  });
});

// ─── AC-5 & AC-6 — Stripe webhook: missing metadata → 500 ───────────────────

describe("AC-5/AC-6 — POST /api/webhooks/stripe: missing teamId or userId → 500", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AC-5 — teamId missing in metadata → 500 (not 200)", async () => {
    mockConstructEvent.mockReturnValue(makeStripeEvent({ teamId: "", userId: "user-1" }));
    const res = await postWebhook(makeWebhookRequest());
    expect(res.status).toBe(500);
    const body = await res.json() as { error?: string };
    expect(body.error).toBeTruthy();
  });

  it("AC-6 — userId missing in metadata → 500 (not 200)", async () => {
    mockConstructEvent.mockReturnValue(makeStripeEvent({ teamId: "team-1", userId: "" }));
    const res = await postWebhook(makeWebhookRequest());
    expect(res.status).toBe(500);
    const body = await res.json() as { error?: string };
    expect(body.error).toBeTruthy();
  });
});

// ─── AC-7 & AC-8 — Checkout: missing teamMembers row ────────────────────────

describe("AC-7/AC-8 — POST /api/checkout: teamMembers guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: "user-1" } as Awaited<ReturnType<typeof getAuthenticatedUser>>);
  });

  it("AC-7 — authenticated user has no teamMembers row → auto-provisions team and proceeds to Stripe", async () => {
    // Call 1: no membership row (triggers auto-provision).
    // Call 2: re-fetch membership after provision → team exists.
    // Call 3: Fix #39 team tier check → subscriptionTier="starter" (allows credit pack).
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([]) as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ teamId: "auto-team-1", userId: "user-1" }]) as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ subscriptionTier: "starter" }]) as unknown as ReturnType<typeof db.select>);
    mockStripeSessionCreate.mockResolvedValue({ url: "https://checkout.stripe.com/pay/auto" });

    const res = await postCheckout(makeCheckoutRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as { checkoutUrl: string };
    expect(body.checkoutUrl).toContain("stripe.com");
  });

  it("AC-8 — authenticated user HAS teamMembers row → Stripe session URL returned", async () => {
    // Call 1: membership found. Call 2: Fix #39 team tier check → subscriptionTier="starter".
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ teamId: "team-1", userId: "user-1" }]) as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce(makeSelectChain([{ subscriptionTier: "starter" }]) as unknown as ReturnType<typeof db.select>);
    mockStripeSessionCreate.mockResolvedValue({ url: "https://checkout.stripe.com/pay/test" });

    const res = await postCheckout(makeCheckoutRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as { checkoutUrl: string };
    expect(body.checkoutUrl).toBe("https://checkout.stripe.com/pay/test");
  });
});

// ─── AC-9 — Webhook happy path: both IDs present → 200 ──────────────────────

describe("AC-9 — Stripe webhook happy path: valid teamId+userId → 200 (regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConstructEvent.mockReturnValue(makeStripeEvent({ teamId: "team-1", userId: "user-1" }));

    // Mock db.select for MED-2 idempotency check (outside transaction)
    vi.mocked(db.select).mockReturnValue(
      makeSelectChain([]) as unknown as ReturnType<typeof db.select> // no existing = not yet processed
    );

    // Mock db.transaction: calls callback with a tx that resolves member + team checks
    vi.mocked(db.transaction).mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      let txSelectCount = 0;
      const tx = {
        select: vi.fn().mockImplementation(() => {
          txSelectCount++;
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue(
              txSelectCount === 1
                ? [{ id: "m-1" }]               // member check
                : [{ creditBalance: 100 }]        // team credit balance / read-back
            ),
          };
        }),
        update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
      };
      return fn(tx);
    });
  });

  it("AC-9 — valid teamId+userId → 200 { ok: true }, credits applied (regression guard)", async () => {
    const res = await postWebhook(makeWebhookRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    // Transaction was called → credits applied
    expect(vi.mocked(db.transaction)).toHaveBeenCalledTimes(1);
  });
});
