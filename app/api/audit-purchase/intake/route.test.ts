/**
 * Tests for POST /api/audit-purchase/intake/route.ts
 *
 * Covers:
 *  - 11.B: amountCents fallback chain (amount_total → amount_subtotal → 0)
 *  - 12.A: idempotency SELECT uses explicit column projection
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockDbSelect, mockDbInsert, mockDbUpdate, mockDbTransaction, mockCheckRateLimit } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbTransaction: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

const { mockRetrieveSession } = vi.hoisted(() => ({
  mockRetrieveSession: vi.fn(),
}));

const { mockEnqueueStage } = vi.hoisted(() => ({
  mockEnqueueStage: vi.fn().mockResolvedValue(undefined),
}));

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("stripe", () => ({
  default: vi.fn(function () {
    return {
      checkout: {
        sessions: {
          retrieve: mockRetrieveSession,
        },
      },
    };
  }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
    update: mockDbUpdate,
    transaction: mockDbTransaction,
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => ({ _eq: [_col, _val] })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  isNull: vi.fn((_col: unknown) => ({ _isNull: _col })),
}));

// Fix #31: allow all intake requests through the rate limiter in existing tests
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock("nanoid", () => ({ nanoid: vi.fn(() => "test-nano-id") }));

vi.mock("@/lib/utils", () => ({
  normalizeDomain: vi.fn((url: string) => {
    try { return new URL(url).hostname; } catch { return url; }
  }),
  slugify: vi.fn((s: string) => s.replace(/\./g, "-")),
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: mockEnqueueStage,
}));

vi.mock("@/lib/email", () => ({
  sendAuditPurchaseConfirmationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/ssrf", () => ({
  validatePublicUrl: vi.fn((url: string) => {
    if (!url || url.includes("bad")) return { ok: false, error: "invalid_url" };
    return { ok: true, url: new URL(url) };
  }),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { POST } from "./route";
import { db } from "@/lib/db";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: unknown = {}): NextRequest {
  return new NextRequest("http://localhost/api/audit-purchase/intake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Build a minimal mock Stripe checkout.session with configurable amount fields.
 */
function makeSession(overrides: {
  amount_total?: number | null;
  amount_subtotal?: number | null;
  websiteUrl?: string;
} = {}) {
  return {
    id: "cs_test_123",
    payment_status: "paid",
    payment_intent: "pi_test_123",
    metadata: {
      type: "audit_purchase",
      websiteUrl: overrides.websiteUrl ?? "https://example.com",
    },
    customer_details: { email: "buyer@example.com" },
    customer_email: null,
    amount_total: overrides.amount_total !== undefined ? overrides.amount_total : 1000,
    amount_subtotal: overrides.amount_subtotal !== undefined ? overrides.amount_subtotal : 1000,
  };
}

/**
 * Set up db.select chain for idempotency check — returns the given rows.
 * Used both outside and inside the transaction (tx.select delegates to mockDbSelect).
 */
function mockSelectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
  mockDbSelect.mockReturnValueOnce(chain);
  return chain;
}

/**
 * Set up db.insert chain.
 * Used both outside and inside the transaction (tx.insert delegates to mockDbInsert).
 */
function mockInsertChain() {
  const chain = { values: vi.fn().mockResolvedValue([]) };
  mockDbInsert.mockReturnValueOnce(chain);
  return chain;
}

/**
 * Configure mockDbTransaction to run the callback with a tx that delegates
 * to the shared select/insert/update mocks. This lets existing mockSelectChain/
 * mockInsertChain helpers work unchanged inside the transaction.
 */
function setupTransaction(opts: { throwOnInsert?: Error | null } = {}) {
  mockDbTransaction.mockImplementationOnce(async (cb: (tx: unknown) => Promise<void>) => {
    const tx = {
      select: (...args: unknown[]) => mockDbSelect(...args),
      insert: (...args: unknown[]) => {
        if (opts.throwOnInsert) throw opts.throwOnInsert;
        return mockDbInsert(...args);
      },
      update: (...args: unknown[]) => mockDbUpdate(...args),
    };
    await cb(tx);
  });
}

// ─── Tests: 11.B — amountCents fallback chain ─────────────────────────────────

describe("POST /api/audit-purchase/intake — 11.B amountCents fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 });
  });

  it("uses amount_total when present (non-null, non-zero)", async () => {
    mockRetrieveSession.mockResolvedValue(makeSession({ amount_total: 2500, amount_subtotal: 2000 }));
    setupTransaction();
    // Inside tx: idempotency select returns [], then geoSites insert, then auditPurchases insert
    mockSelectChain([]);
    mockInsertChain();
    // auditPurchases insert — capture the values
    const capturedValues: Record<string, unknown>[] = [];
    mockDbInsert.mockReturnValueOnce({
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        capturedValues.push(v);
        return Promise.resolve([]);
      }),
    });

    const res = await POST(makeRequest({ sessionId: "cs_test_123" }));
    expect(res.status).toBe(201);

    expect(capturedValues[0]?.amountCents).toBe(2500);
  });

  it("falls back to amount_subtotal when amount_total is null", async () => {
    mockRetrieveSession.mockResolvedValue(makeSession({ amount_total: null, amount_subtotal: 900 }));
    setupTransaction();
    mockSelectChain([]);
    mockInsertChain();
    const capturedValues: Record<string, unknown>[] = [];
    mockDbInsert.mockReturnValueOnce({
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        capturedValues.push(v);
        return Promise.resolve([]);
      }),
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(makeRequest({ sessionId: "cs_test_123" }));
    expect(res.status).toBe(201);

    expect(capturedValues[0]?.amountCents).toBe(900);
    // A warning must be emitted when amount_total is null
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("audit_purchase_intake_amount_null"),
    );
    warnSpy.mockRestore();
  });

  it("falls back to 0 when both amount_total and amount_subtotal are null", async () => {
    mockRetrieveSession.mockResolvedValue(makeSession({ amount_total: null, amount_subtotal: null }));
    setupTransaction();
    mockSelectChain([]);
    mockInsertChain();
    const capturedValues: Record<string, unknown>[] = [];
    mockDbInsert.mockReturnValueOnce({
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        capturedValues.push(v);
        return Promise.resolve([]);
      }),
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(makeRequest({ sessionId: "cs_test_123" }));
    expect(res.status).toBe(201);

    expect(capturedValues[0]?.amountCents).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does NOT warn when amount_total is a valid non-null number", async () => {
    mockRetrieveSession.mockResolvedValue(makeSession({ amount_total: 1000 }));
    setupTransaction();
    mockSelectChain([]);
    mockInsertChain();
    mockInsertChain(); // second insert (auditPurchases)

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await POST(makeRequest({ sessionId: "cs_test_123" }));
    // No warning for amount_null when amount_total is present
    const nullWarnings = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("audit_purchase_intake_amount_null"),
    );
    expect(nullWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });
});

// ─── Tests: 12.A — idempotency SELECT explicit projection ─────────────────────

describe("POST /api/audit-purchase/intake — 12.A idempotency projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 });
  });

  it("db.select is called with an explicit projection object (not wildcard)", async () => {
    mockRetrieveSession.mockResolvedValue(makeSession({ amount_total: 1000 }));
    setupTransaction();
    // Idempotency: no existing purchase
    mockSelectChain([]);
    mockInsertChain(); // geoSites
    mockInsertChain(); // auditPurchases

    await POST(makeRequest({ sessionId: "cs_test_123" }));

    // The first db.select call inside the tx should receive a projection object
    const firstSelectCall = (mockDbSelect as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstSelectCall).toBeDefined();
    const projectionArg = firstSelectCall[0] as Record<string, unknown> | undefined;
    expect(projectionArg).toBeDefined();
    expect(typeof projectionArg).toBe("object");
    // Verify that sensitive columns (purchaseToken, magicLink) are NOT projected
    expect(projectionArg).not.toHaveProperty("purchaseToken");
    expect(projectionArg).not.toHaveProperty("magicLink");
    // Verify the fields actually needed by the idempotency branch ARE projected
    expect(projectionArg).toHaveProperty("id");
    expect(projectionArg).toHaveProperty("siteId");
    expect(projectionArg).toHaveProperty("domain");
    expect(projectionArg).toHaveProperty("teamId");
  });

  it("idempotency: returns already_submitted when siteId already exists (found inside tx)", async () => {
    mockRetrieveSession.mockResolvedValue(makeSession({ amount_total: 1000 }));
    // Inside tx: existing purchase with siteId — transaction returns early
    setupTransaction();
    mockSelectChain([{ id: "purch-1", siteId: "site-existing", domain: "example.com", teamId: null }]);

    const res = await POST(makeRequest({ sessionId: "cs_test_123" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; auditId: string };
    expect(body.status).toBe("already_submitted");
    expect(body.auditId).toBe("site-existing");
    // No insert should happen
    expect(mockDbInsert).not.toHaveBeenCalled();
  });
});

// ─── Tests: Fix #6 — transaction race / unique constraint ─────────────────────

describe("Fix #6 — /intake wraps inserts in transaction (no orphan geoSites on race)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 });
  });

  it("returns already_submitted (not 500) when unique-constraint violation on stripeSessionId", async () => {
    mockRetrieveSession.mockResolvedValue(makeSession({ amount_total: 1000 }));

    // Transaction throws unique-constraint violation (concurrent duplicate intake)
    const uniqueErr = Object.assign(new Error("duplicate key value violates unique constraint"), {
      message: "duplicate key value violates unique constraint",
    });
    mockDbTransaction.mockRejectedValueOnce(uniqueErr);

    // Post-error: re-check for the existing row (the winning concurrent request created it)
    mockSelectChain([{ siteId: "site-from-winner", domain: "example.com" }]);

    const res = await POST(makeRequest({ sessionId: "cs_test_123" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; auditId: string | null };
    expect(body.status).toBe("already_submitted");
    expect(body.auditId).toBe("site-from-winner");

    // No orphan geoSites row — the transaction rolled back
    // (mockDbTransaction threw without inserting anything)
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it("db.transaction is called for the geoSites + auditPurchases inserts", async () => {
    mockRetrieveSession.mockResolvedValue(makeSession({ amount_total: 1000 }));
    setupTransaction();
    mockSelectChain([]); // no existing purchase inside tx
    mockInsertChain();   // geoSites
    mockInsertChain();   // auditPurchases

    const res = await POST(makeRequest({ sessionId: "cs_test_123" }));
    expect(res.status).toBe(201);

    // The transaction must have been called (not bare db.insert)
    expect(mockDbTransaction).toHaveBeenCalledTimes(1);
  });

  it("re-throws non-unique errors (other DB failures bubble up as 500)", async () => {
    mockRetrieveSession.mockResolvedValue(makeSession({ amount_total: 1000 }));

    // Non-unique error
    mockDbTransaction.mockRejectedValueOnce(new Error("connection timeout"));

    const res = await POST(makeRequest({ sessionId: "cs_test_123" }));
    expect(res.status).toBe(500);
  });
});
