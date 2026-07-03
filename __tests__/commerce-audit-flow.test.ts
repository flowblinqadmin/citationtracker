/**
 * Commerce audit creation + OTP verification flow tests.
 *
 * Covers: audit creation, OTP email dispatch, input validation, rate limiting,
 * OTP verify (success/wrong/expired/already-verified), brute-force lockout,
 * exchange code generation, SKIP_EMAIL_VERIFY mode.
 *
 * All external dependencies (DB, Resend, Supabase admin) are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks — hoisted before all imports ──────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn().mockReturnValue("mock-audit-id"),
}));

vi.mock("@/lib/email-commerce", () => ({
  generateVerificationCode: vi.fn().mockReturnValue("123456"),
  hashCode: vi.fn().mockReturnValue("hashed-123456"),
  sendCommerceVerificationEmail: vi.fn().mockResolvedValue(undefined),
  verifyCode: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/rate-limit-commerce", () => ({
  checkRateLimit: vi.fn().mockReturnValue(true),
  checkOtpAttempt: vi.fn().mockReturnValue({ allowed: true }),
  recordOtpFailure: vi.fn(),
  clearOtpFailures: vi.fn(),
}));

vi.mock("@/lib/sanitize", () => ({
  escapeHtml: vi.fn((s: string) => s),
}));

vi.mock("resend", () => {
  return {
    Resend: class {
      emails = {
        send: vi.fn().mockReturnValue(
          Promise.resolve({ data: { id: "resend-id" }, error: null })
        ),
      };
    },
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: vi.fn().mockReturnValue(null),
}));

vi.mock("jose", () => {
  return {
    SignJWT: class {
      setProtectedHeader() { return this; }
      setIssuedAt() { return this; }
      setExpirationTime() { return this; }
      sign() { return Promise.resolve("mock-exchange-code"); }
    },
  };
});

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { POST as postAudit } from "@/app/api/audit/route";
import { POST as postVerify } from "@/app/api/audit/[id]/verify/route";
import { db } from "@/lib/db";
import {
  generateVerificationCode,
  sendCommerceVerificationEmail,
  verifyCode,
} from "@/lib/email-commerce";
import {
  checkRateLimit,
  checkOtpAttempt,
  recordOtpFailure,
  clearOtpFailures,
} from "@/lib/rate-limit-commerce";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

// ─── DB chain helpers ────────────────────────────────────────────────────────

function makeInsertChain() {
  return { values: vi.fn().mockResolvedValue([]) };
}

function makeSelectChain(rows: unknown[] = []) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
}

function makeUpdateChain() {
  return {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  };
}

// ─── Request helpers ─────────────────────────────────────────────────────────

function makeAuditRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(
    new Request("http://localhost/api/audit", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

function makeVerifyRequest(code: string): Request {
  return new Request("http://localhost/api/audit/mock-audit-id/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

// ─── Shared report fixture ──────────────────────────────────────────────────

const PENDING_REPORT = {
  id: "mock-audit-id",
  merchant_url: "https://example.com",
  merchant_name: "example",
  contact_email: "test@example.com",
  product_category: null,
  revenue_estimate: null,
  verification_code: "hashed-123456",
  code_expires_at: new Date(Date.now() + 15 * 60 * 1000),
  email_verified: false,
  status: "pending_verification",
};

const VERIFIED_REPORT = {
  ...PENDING_REPORT,
  email_verified: true,
  status: "verified",
};

const VALID_BODY = {
  merchant_url: "https://example.com",
  contact_email: "test@example.com",
};

// ─── Setup ───────────────────────────────────────────────────────────────────

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();

  // Defaults
  (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
    makeSelectChain([PENDING_REPORT])
  );
  (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
  vi.mocked(checkRateLimit).mockReturnValue(true);
  vi.mocked(checkOtpAttempt).mockReturnValue({ allowed: true });
  vi.mocked(verifyCode).mockReturnValue(true);
  vi.mocked(getSupabaseAdmin).mockReturnValue(null);

  delete process.env.SKIP_EMAIL_VERIFY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.API_JWT_SECRET;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/audit — audit creation
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/audit", () => {
  // 1. Audit creation — valid input
  it("creates a record with status pending_verification and returns { id, status }", async () => {
    const res = await postAudit(makeAuditRequest(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ id: "mock-audit-id", status: "pending_verification" });
    expect(db.insert).toHaveBeenCalled();
    const insertChain = (db.insert as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "mock-audit-id",
        status: "pending_verification",
        merchant_url: "https://example.com",
        contact_email: "test@example.com",
      })
    );
  });

  // 2. OTP email sent
  it("calls sendCommerceVerificationEmail with correct email and merchant name", async () => {
    await postAudit(
      makeAuditRequest({
        merchant_url: "https://acme.com",
        contact_email: "admin@acme.com",
        merchant_name: "ACME Corp",
      })
    );

    expect(sendCommerceVerificationEmail).toHaveBeenCalledWith(
      "admin@acme.com",
      "ACME Corp",
      "123456"
    );
  });

  // 3a. Invalid input — missing email
  it("returns 400 when contact_email is missing", async () => {
    const res = await postAudit(
      makeAuditRequest({ merchant_url: "https://example.com" })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid input");
  });

  // 3b. Invalid input — missing URL
  it("returns 400 when merchant_url is missing", async () => {
    const res = await postAudit(
      makeAuditRequest({ contact_email: "a@b.com" })
    );
    expect(res.status).toBe(400);
  });

  // 3c. Invalid input — bad email format
  it("returns 400 for an invalid email address", async () => {
    const res = await postAudit(
      makeAuditRequest({ merchant_url: "https://example.com", contact_email: "not-an-email" })
    );
    expect(res.status).toBe(400);
  });

  // 4. Rate limiting
  it("returns 429 when rate limit is exceeded", async () => {
    vi.mocked(checkRateLimit).mockReturnValue(false);

    const res = await postAudit(makeAuditRequest(VALID_BODY));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toMatch(/too many requests/i);
  });

  // 12. SKIP_EMAIL_VERIFY mode
  it("creates an immediately-verified audit when SKIP_EMAIL_VERIFY is set", async () => {
    process.env.SKIP_EMAIL_VERIFY = "true";

    const res = await postAudit(makeAuditRequest(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ id: "mock-audit-id", status: "verified" });

    // Should NOT send verification email
    expect(sendCommerceVerificationEmail).not.toHaveBeenCalled();

    // DB insert should have email_verified: true
    const insertChain = (db.insert as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "verified",
        email_verified: true,
      })
    );
  });

  it("extracts merchant name from URL when not provided", async () => {
    await postAudit(
      makeAuditRequest({
        merchant_url: "https://www.factorymotorparts.com",
        contact_email: "test@example.com",
      })
    );

    expect(sendCommerceVerificationEmail).toHaveBeenCalledWith(
      "test@example.com",
      "factorymotorparts",
      "123456"
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/audit/[id]/verify — OTP verification
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/audit/[id]/verify", () => {
  function callVerify(code: string) {
    return postVerify(makeVerifyRequest(code), {
      params: Promise.resolve({ id: "mock-audit-id" }),
    });
  }

  // 5. OTP verify success
  it("sets email_verified=true and status=verified on correct code", async () => {
    const res = await callVerify("123456");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.verified).toBe(true);
    expect(json.id).toBe("mock-audit-id");
    expect(json.status).toBe("verified");

    // DB should be updated
    expect(db.update).toHaveBeenCalled();
    // H1 (2026-05-27 audit): keyed on audit_id, not email.
    expect(clearOtpFailures).toHaveBeenCalledWith("mock-audit-id");
  });

  // 6. OTP verify wrong code
  it("returns 401 and records failure when code is wrong", async () => {
    vi.mocked(verifyCode).mockReturnValue(false);

    const res = await callVerify("999999");
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toMatch(/invalid/i);
    // H1: failure recorded against audit_id, not email.
    expect(recordOtpFailure).toHaveBeenCalledWith("mock-audit-id");
  });

  // 7. OTP expired
  it("returns 410 when code is expired", async () => {
    const expiredReport = {
      ...PENDING_REPORT,
      code_expires_at: new Date(Date.now() - 1000), // in the past
    };
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([expiredReport])
    );

    const res = await callVerify("123456");
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.error).toMatch(/expired/i);
  });

  // 8. Already verified — returns record without regenerating exchange code
  it("returns the record directly when already verified", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([VERIFIED_REPORT])
    );

    const res = await callVerify("123456");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.verified).toBe(true);
    expect(json.id).toBe("mock-audit-id");

    // Should NOT update DB again
    expect(db.update).not.toHaveBeenCalled();
    // Should NOT attempt exchange code generation
    expect(json.exchangeCode).toBeUndefined();
  });

  // 9. Brute force lockout — 5 failures lock for 15 minutes
  it("returns 429 when brute-force lockout is active", async () => {
    const lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
    vi.mocked(checkOtpAttempt).mockReturnValue({
      allowed: false,
      lockedUntil,
    });

    const res = await callVerify("123456");
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toMatch(/too many failed attempts/i);
  });

  // 10. H2 (2026-05-27 audit): audit verify must NOT mint a Supabase
  // session for the OTP-supplied contact_email. The unsanctioned magic
  // link / exchangeCode flow has been removed entirely — sessions are
  // only created through user-initiated /auth/* paths.
  it("H2: never returns an exchangeCode regardless of env config", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
    process.env.API_JWT_SECRET = "test-jwt-secret";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

    const res = await callVerify("123456");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.verified).toBe(true);
    expect(json.exchangeCode).toBeUndefined();
  });

  // 11. No exchange code without env vars
  it("succeeds without exchangeCode when env vars are missing", async () => {
    // Env vars are already cleared in beforeEach
    const res = await callVerify("123456");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.verified).toBe(true);
    expect(json.exchangeCode).toBeUndefined();
  });

  // Edge: audit not found
  it("returns 404 when audit ID does not exist", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([])
    );

    const res = await callVerify("123456");
    expect(res.status).toBe(404);
  });

  // Edge: missing code in request body
  it("returns 400 when code is not provided", async () => {
    const req = new Request("http://localhost/api/audit/mock-audit-id/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await postVerify(req, {
      params: Promise.resolve({ id: "mock-audit-id" }),
    });
    expect(res.status).toBe(400);
  });
});
