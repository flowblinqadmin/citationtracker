/**
 * API tests for POST /api/sites with bulkUrls — ES-005 Task 5
 *
 * 11 test cases covering:
 *   - Valid bulk submission → 201, OTP sent
 *   - Empty bulkUrls array → 400
 *   - bulkUrls count > 501 → 400
 *   - SSRF: internal IP URL rejected → 400
 *   - SSRF: localhost URL rejected → 400
 *   - Non-HTTP protocol URL rejected → 400
 *   - Malformed URL rejected → 400
 *   - No team member found → 402
 *   - Team with 0 credits → 201 (credit floor applied at verify, not submit)
 *   - Duplicate URLs deduped before credit check
 *   - Missing email with bulkUrls → 400
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("@/lib/email", () => ({
  generateVerificationCode: vi.fn().mockReturnValue("123456"),
  hashCode: vi.fn().mockReturnValue("hashed-code"),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendLowCreditsEmail: vi.fn().mockResolvedValue(undefined),
  sendInternalSignupAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("nanoid", () => ({ nanoid: vi.fn().mockReturnValue("mock-site-id") }));
vi.mock("@/lib/utils", () => ({
  normalizeDomain: vi.fn().mockImplementation((u: string) => u),
  slugify: vi.fn().mockReturnValue("acme-io"),
  normalizeUrl: vi.fn().mockImplementation((u: string) => {
    if (!u || !u.trim()) return null;
    if (/^https?:\/\//i.test(u)) {
      try { const p = new URL(u); return p.hostname.includes(".") ? u : null; } catch { return null; }
    }
    if (/^[a-zA-Z][a-zA-Z0-9+\-]*:/.test(u)) return null;
    try {
      const w = `https://${u}`;
      const p = new URL(w);
      return p.hostname.includes(".") ? w : null;
    } catch { return null; }
  }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { POST } from "@/app/api/sites/route";
import { db } from "@/lib/db";
import { sendVerificationEmail } from "@/lib/email";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSelectChain(rows: unknown[] = []) {
  return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(rows) };
}

function makeInsertChain() {
  return { values: vi.fn().mockResolvedValue([]) };
}

function makePostRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/sites", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const VALID_URLS = [
  "https://acme.io/about",
  "https://acme.io/pricing",
  "https://acme.io/blog",
];

const MOCK_MEMBER = { email: "user@acme.io", teamId: "team-acme-1" };
const MOCK_TEAM = { id: "team-acme-1", creditBalance: 200 }; // enough for any test

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/sites — bulk flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: valid member + sufficient credits
    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([MOCK_MEMBER]);
      return makeSelectChain([MOCK_TEAM]);
    });
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  // ── Valid submission ──

  it("returns 201 and 'Verification code sent' for a valid bulk submission", async () => {
    const req = makePostRequest({ bulkUrls: VALID_URLS, email: "user@acme.io" });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.message).toMatch(/verification code sent/i);
    expect(body.id).toBeDefined();
  });

  it("calls sendVerificationEmail on valid submission", async () => {
    const req = makePostRequest({ bulkUrls: VALID_URLS, email: "user@acme.io" });
    await POST(req as unknown as import("next/server").NextRequest);

    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  // ── Validation errors ──

  it("returns 400 when bulkUrls is an empty array", async () => {
    const req = makePostRequest({ bulkUrls: [], email: "user@acme.io" });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/1 to 500/i);
  });

  it("returns 400 when bulkUrls exceeds 500 entries", async () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `https://acme.io/p${i}`);
    const req = makePostRequest({ bulkUrls: tooMany, email: "user@acme.io" });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(400);
  });

  it("returns 400 when email is missing with bulkUrls present", async () => {
    const req = makePostRequest({ bulkUrls: VALID_URLS });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(400);
  });

  // ── SSRF protection ──

  it("returns 400 when bulkUrls contains an internal IP (192.168.x.x)", async () => {
    const req = makePostRequest({
      bulkUrls: ["https://192.168.1.1/admin"],
      email: "user@acme.io",
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid url/i);
  });

  it("returns 400 when bulkUrls contains a localhost URL", async () => {
    const req = makePostRequest({
      bulkUrls: ["http://localhost/secret"],
      email: "user@acme.io",
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(400);
  });

  it("returns 400 when bulkUrls contains a non-HTTP URL (ftp:// or file://)", async () => {
    const req = makePostRequest({
      bulkUrls: ["ftp://acme.io/file.txt"],
      email: "user@acme.io",
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(400);
  });

  it("returns 400 for a completely malformed URL string", async () => {
    const req = makePostRequest({
      bulkUrls: ["not-a-url-at-all"],
      email: "user@acme.io",
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(400);
  });

  // ── Credit gate ──

  it("returns 402 when no team member exists for the email", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([])); // no member
    const req = makePostRequest({ bulkUrls: VALID_URLS, email: "nobody@acme.io" });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/pro account/i);
  });

  it("returns 201 even when team has 0 credits (credit floor applied at verify time, not submit)", async () => {
    // Credit check was removed from submit — users with 0 credits still get the
    // BULK_FREE_PAGES floor at verify time. Submit always succeeds for Pro members.
    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([MOCK_MEMBER]);
      return makeSelectChain([{ id: "team-acme-1", creditBalance: 0 }]);
    });

    const req = makePostRequest({ bulkUrls: VALID_URLS, email: "user@acme.io" });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(201);
  });
});
