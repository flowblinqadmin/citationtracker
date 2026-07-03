/**
 * ES-075 — OTP Send + Verify TDD Tests (ScriptDev Phase 1)
 *
 * Tests written BEFORE implementation.
 * Covers OTP send route and OTP verify route with consent logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must be at top-level, before imports) ────────────────────────────

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/services/exchange-code", () => ({
  generateExchangeCode: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn() },
}));

vi.mock("@/lib/db/schema", () => ({
  consentRecords: {
    id: "id",
    userId: "user_id",
    tosVersion: "tos_version",
    eulaVersion: "eula_version",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
}));

vi.mock("@/lib/config", () => ({
  CURRENT_TOS_VERSION: "1.0",
  CURRENT_EULA_VERSION: "1.0",
}));

vi.mock("nanoid", () => ({ nanoid: () => "test-id" }));

// ── Imports ─────────────────────────────────────────────────────────────────

import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@supabase/supabase-js";
import { generateExchangeCode } from "@/lib/services/exchange-code";
import { checkRateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";

// ── Shared state ────────────────────────────────────────────────────────────

const mockSignInWithOtp = vi.fn();
const mockVerifyOtp = vi.fn();

// Chain mocks for db.select().from().where()
const mockSelectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockResolvedValue([]),
};

// Chain mocks for db.insert().values()
const mockInsertChain = {
  values: vi.fn().mockResolvedValue([]),
};

const MOCK_SESSION = {
  access_token: "mock-access-token",
  refresh_token: "mock-refresh-token",
  user: { id: "user-123", email: "test@example.com" },
};

// ── Dynamic route imports (re-imported each test via beforeEach) ────────────

let sendOtp: (req: Request) => Promise<Response>;
let verifyOtp: (req: Request) => Promise<Response>;

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(
  url: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function makeSendReq(body: Record<string, unknown> = { email: "test@example.com" }): Request {
  return makeRequest("http://localhost/api/auth/otp/send", body);
}

function makeVerifyReq(
  body: Record<string, unknown> = { email: "test@example.com", code: "123456" },
  headers: Record<string, string> = {}
): Request {
  return makeRequest("http://localhost/api/auth/otp/verify", body, {
    "x-forwarded-for": "1.2.3.4",
    "user-agent": "TestBrowser/1.0",
    ...headers,
  });
}

// ── Setup ───────────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.clearAllMocks();

  // Supabase admin mock (send route)
  vi.mocked(getSupabaseAdmin).mockReturnValue({
    auth: { signInWithOtp: mockSignInWithOtp },
  } as any);
  mockSignInWithOtp.mockResolvedValue({ data: {}, error: null });

  // Supabase anon client mock (verify route)
  vi.mocked(createClient).mockReturnValue({
    auth: { verifyOtp: mockVerifyOtp },
  } as any);
  mockVerifyOtp.mockResolvedValue({
    data: { session: MOCK_SESSION },
    error: null,
  });

  // Rate limiter — allowed by default
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 4,
    resetAt: Date.now() + 900_000,
  });

  // Exchange code
  vi.mocked(generateExchangeCode).mockResolvedValue("mock-exchange-jwt-token");

  // DB mocks
  vi.mocked(db.select).mockReturnValue(mockSelectChain as any);
  vi.mocked(db.insert).mockReturnValue(mockInsertChain as any);
  mockSelectChain.from.mockReturnThis();
  mockSelectChain.where.mockResolvedValue([]); // no consent by default
  mockInsertChain.values.mockResolvedValue([]);

  // Dynamic imports — ensure fresh module per test
  const sendMod = await import("@/app/api/auth/otp/send/route");
  sendOtp = sendMod.POST;
  const verifyMod = await import("@/app/api/auth/otp/verify/route");
  verifyOtp = verifyMod.POST;
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OTP SEND
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("POST /api/auth/otp/send", () => {
  it("valid email → 200 { success: true }, signInWithOtp called", async () => {
    const res = await sendOtp(makeSendReq({ email: "user@example.com" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockSignInWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "user@example.com",
        options: expect.objectContaining({ shouldCreateUser: true }),
      })
    );
  });

  it("missing email → 400", async () => {
    const res = await sendOtp(makeSendReq({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("invalid email format → 400", async () => {
    const res = await sendOtp(makeSendReq({ email: "notanemail" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("rate limited → 429 with resetAt", async () => {
    const resetAt = Date.now() + 900_000;
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt,
    });

    const res = await sendOtp(makeSendReq());
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.resetAt).toBeDefined();
  });

  it("Supabase admin unavailable → 500", async () => {
    vi.mocked(getSupabaseAdmin).mockReturnValueOnce(null as any);

    const res = await sendOtp(makeSendReq());
    expect(res.status).toBe(500);
  });

  it("Supabase signInWithOtp fails → 500, error NOT leaked", async () => {
    mockSignInWithOtp.mockResolvedValue({
      data: null,
      error: { message: "Internal Supabase error: rate_limit_exceeded", status: 429 },
    });

    const res = await sendOtp(makeSendReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toContain("Supabase");
    expect(body.error).not.toContain("rate_limit_exceeded");
  });

  it("email normalized — trimmed and lowercased", async () => {
    await sendOtp(makeSendReq({ email: "  USER@EXAMPLE.COM  " }));

    expect(mockSignInWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({ email: "user@example.com" })
    );
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OTP VERIFY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("POST /api/auth/otp/verify", () => {
  it("valid code → 200 { success: true, exchangeCode, requiresConsent: false } when consent exists", async () => {
    mockSelectChain.where.mockResolvedValue([{ id: "consent-1" }]);

    const res = await verifyOtp(makeVerifyReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.exchangeCode).toBe("mock-exchange-jwt-token");
    expect(body.requiresConsent).toBe(false);
  });

  it("consent needed (no record) → requiresConsent: true", async () => {
    mockSelectChain.where.mockResolvedValue([]);

    const res = await verifyOtp(makeVerifyReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.requiresConsent).toBe(true);
  });

  it("tosAccepted=true records consent → requiresConsent: false, consent inserted", async () => {
    mockSelectChain.where.mockResolvedValue([]); // no prior consent

    const res = await verifyOtp(
      makeVerifyReq({
        email: "test@example.com",
        code: "123456",
        tosAccepted: true,
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.requiresConsent).toBe(false);
    expect(db.insert).toHaveBeenCalled();
    expect(mockInsertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-123",
        email: "test@example.com",
        tosVersion: "1.0",
        eulaVersion: "1.0",
      })
    );
  });

  it("invalid/expired code → 401", async () => {
    mockVerifyOtp.mockResolvedValue({
      data: { session: null },
      error: { message: "Token has expired or is invalid" },
    });

    const res = await verifyOtp(
      makeVerifyReq({ email: "test@example.com", code: "000000" })
    );
    expect(res.status).toBe(401);
  });

  it("missing code → 400", async () => {
    const res = await verifyOtp(
      makeVerifyReq({ email: "test@example.com" })
    );
    expect(res.status).toBe(400);
  });

  it("non-6-digit code → 400", async () => {
    const res = await verifyOtp(
      makeVerifyReq({ email: "test@example.com", code: "12345" })
    );
    expect(res.status).toBe(400);
  });

  it("non-numeric code → 400", async () => {
    const res = await verifyOtp(
      makeVerifyReq({ email: "test@example.com", code: "abcdef" })
    );
    expect(res.status).toBe(400);
  });

  it("missing email → 400", async () => {
    const res = await verifyOtp(makeVerifyReq({ code: "123456" }));
    expect(res.status).toBe(400);
  });

  it("rate limited → 429", async () => {
    const resetAt = Date.now() + 900_000;
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt,
    });

    const res = await verifyOtp(makeVerifyReq());
    expect(res.status).toBe(429);
  });

  it("no session from verifyOtp → 401", async () => {
    mockVerifyOtp.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    const res = await verifyOtp(makeVerifyReq());
    expect(res.status).toBe(401);
  });

  it("exchange code gets redirect=/dashboard, empty siteToken and siteId", async () => {
    mockSelectChain.where.mockResolvedValue([{ id: "consent-1" }]);
    await verifyOtp(makeVerifyReq());

    expect(generateExchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({
        redirect: "/dashboard",
        siteToken: "",
        siteId: "",
      })
    );
  });

  it("consent recorded with correct IP and user-agent", async () => {
    mockSelectChain.where.mockResolvedValue([]); // no prior consent

    await verifyOtp(
      makeVerifyReq(
        { email: "test@example.com", code: "123456", tosAccepted: true },
        {
          "x-forwarded-for": "203.0.113.42, 10.0.0.1",
          "user-agent": "Mozilla/5.0 Test",
        }
      )
    );

    expect(mockInsertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        ipAddress: "203.0.113.42",
        userAgent: "Mozilla/5.0 Test",
      })
    );
  });
});
