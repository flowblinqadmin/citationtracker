/**
 * Tests for GET /api/audit-purchase/status
 *
 * Fix #8: session_id lookup is gated to pre-delivery statuses only.
 *         purchase_token lookup works for all statuses.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockDbSelect, mockCheckRateLimit } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => ({ _eq: [_col, _val] })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
}));

// Fix #31: allow all status requests through the rate limiter in existing tests
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { GET } from "./route";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost/api/audit-purchase/status");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url.toString());
}

function mockSelectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
    limit: vi.fn().mockReturnThis(),
  };
  mockDbSelect.mockReturnValueOnce(chain);
  return chain;
}

// ─── Tests: Fix #8 — session_id gated to pre-delivery statuses ───────────────

describe("Fix #8 — status endpoint: session_id gated to pre-delivery statuses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: rate limit allows all requests
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 29, resetAt: Date.now() + 60_000 });
  });

  it("returns 400 when neither session_id nor purchase_token is provided", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
  });

  it("session_id lookup returns purchase data when status is 'paid' (pre-delivery)", async () => {
    mockSelectChain([{ status: "paid", domain: "example.com", siteId: null }]);

    const res = await GET(makeRequest({ session_id: "cs_test_123" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { purchaseStatus: string };
    expect(body.purchaseStatus).toBe("paid");
  });

  it("session_id lookup returns purchase data when status is 'intake_complete' (pre-delivery)", async () => {
    mockSelectChain([{ status: "intake_complete", domain: "example.com", siteId: null }]);

    const res = await GET(makeRequest({ session_id: "cs_test_456" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { purchaseStatus: string };
    expect(body.purchaseStatus).toBe("intake_complete");
  });

  it("session_id lookup returns 404 when status is 'delivered' (post-delivery)", async () => {
    mockSelectChain([{ status: "delivered", domain: "example.com", siteId: "site-123" }]);

    const res = await GET(makeRequest({ session_id: "cs_delivered_123" }));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("session_id lookup returns 404 when status is 'refunded' (post-delivery)", async () => {
    mockSelectChain([{ status: "refunded", domain: "example.com", siteId: "site-456" }]);

    const res = await GET(makeRequest({ session_id: "cs_refunded_123" }));
    expect(res.status).toBe(404);
  });

  it("session_id lookup returns 404 when status is 'failed' (post-delivery)", async () => {
    mockSelectChain([{ status: "failed", domain: "example.com", siteId: "site-789" }]);

    const res = await GET(makeRequest({ session_id: "cs_failed_123" }));
    expect(res.status).toBe(404);
  });

  it("purchase_token lookup returns row regardless of 'delivered' status", async () => {
    // auditPurchases row (purchase projection)
    mockSelectChain([{ status: "delivered", domain: "example.com", siteId: "site-abc" }]);
    // geoSiteView row
    mockSelectChain([{ pipelineStatus: "complete", domain: "example.com", overallScore: 85, pipelineError: null }]);

    const res = await GET(makeRequest({ purchase_token: "tok-abc-delivered" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { purchaseStatus: string; pipelineStatus: string };
    expect(body.purchaseStatus).toBe("delivered");
    expect(body.pipelineStatus).toBe("complete");
  });

  it("purchase_token lookup returns row for 'paid' status (all statuses work)", async () => {
    mockSelectChain([{ status: "paid", domain: "example.com", siteId: null }]);

    const res = await GET(makeRequest({ purchase_token: "tok-paid-123" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { purchaseStatus: string };
    expect(body.purchaseStatus).toBe("paid");
  });

  it("returns 404 when session_id row does not exist at all", async () => {
    mockSelectChain([]); // no row found

    const res = await GET(makeRequest({ session_id: "cs_nonexistent" }));
    expect(res.status).toBe(404);
  });
});
