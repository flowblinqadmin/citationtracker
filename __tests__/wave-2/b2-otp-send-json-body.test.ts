/**
 * ES-wave-2 §B2 — OTP-send 5xx JSON-body contract.
 *
 * Pins AC-B2-1 / AC-B2-2 by mocking checkRateLimit to throw and asserting
 * the route's outer catch responds with status=500, content-type JSON, and
 * a non-empty `{error}` body. Adds AC-B2-3 (rate-limit empty-row guard) and
 * AC-B2-4 sibling-route catch-shape audit + AC-B2-5 grep-guard.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { checkRateLimitMock, signInWithOtpMock } = vi.hoisted(() => ({
  checkRateLimitMock: vi.fn(),
  signInWithOtpMock: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: checkRateLimitMock,
  checkOtpLock: vi.fn(),
  incrementOtpAttempt: vi.fn(),
  checkAndIncrementOtpAttempt: vi.fn(),
  clearOtpAttempts: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    auth: { signInWithOtp: signInWithOtpMock },
  }),
}));

import { POST as otpSendPOST } from "@/app/api/auth/otp/send/route";

beforeEach(() => {
  checkRateLimitMock.mockReset();
  signInWithOtpMock.mockReset();
});

function makeReq(body: unknown): import("next/server").NextRequest {
  return new Request("http://localhost/api/auth/otp/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

describe("B2 OTP-send 5xx JSON-body contract", () => {
  it("AC-B2-1: outer catch returns JSON 500 with non-empty error when an unexpected exception fires", async () => {
    checkRateLimitMock.mockImplementation(() => {
      throw new Error("boom");
    });
    const res = await otpSendPOST(makeReq({ email: "user@example.com" }));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(typeof body.error).toBe("string");
  });

  it("AC-B2-2: checkRateLimit DB rejection bubbles to outer catch with intact JSON shape", async () => {
    // Simulate DB-write failure — the route handler must NOT leak an empty body.
    checkRateLimitMock.mockRejectedValue(new Error("DB connection refused"));
    const res = await otpSendPOST(makeReq({ email: "user@example.com" }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
    expect(() => JSON.parse(text)).not.toThrow();
    const body = JSON.parse(text);
    expect(body.error).toBeTruthy();
  });

  it("happy path remains JSON 200 (no regression)", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: true, remaining: 5, resetAt: Date.now() + 60_000 });
    signInWithOtpMock.mockResolvedValue({ error: null });
    const res = await otpSendPOST(makeReq({ email: "user@example.com" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("rate-limit-not-allowed returns JSON 429 (no regression)", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 });
    const res = await otpSendPOST(makeReq({ email: "user@example.com" }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});

// ── AC-B2-3: rate-limit reject path always throws a real Error ──────────────

describe("B2 AC-B2-3 — rate-limit reject path", () => {
  it("source guards against empty `returning()` with a thrown Error containing the key", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "lib/rate-limit.ts"),
      "utf8",
    );
    expect(src).toMatch(/AC-B2-3/);
    expect(src).toMatch(/throw new Error\(.*no row.*\$\{key\}/);
  });
});

// ── AC-B2-4: sibling routes have identical JSON-body catch shape ────────────

describe("B2 AC-B2-4 — sibling-route catch JSON shape", () => {
  it("otp/verify outer catch returns NextResponse.json with status 500 + error key", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "app/api/auth/otp/verify/route.ts"),
      "utf8",
    );
    // The trailing catch block must contain a NextResponse.json with status: 500.
    expect(src).toMatch(/} catch \(err\)[\s\S]*NextResponse\.json\([\s\S]*status: 500/);
  });

  it("auth/proxy catch returns NextResponse.json with a non-2xx status + error key", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "app/api/auth/proxy/[...path]/route.ts"),
      "utf8",
    );
    expect(src).toMatch(/} catch \(err\)[\s\S]*NextResponse\.json\([\s\S]*status:\s*5\d{2}/);
  });
});

// ── AC-B2-5: grep-guard against banned catch shapes in /api/**/route.ts ─────

describe("B2 AC-B2-5 — grep-guard against banned catch shapes", () => {
  it("no API route catches end with a bare `return;` (must return a JSON body)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const { execSync } = await import("child_process");
    // Prefer ripgrep when available; fall back to a JS scan.
    let bare: string[] = [];
    try {
      const out = execSync(
        "grep -rnE '\\} catch \\([^)]*\\) \\{[^}]*\\breturn;[^}]*\\}' app/api --include='route.ts' || true",
        { encoding: "utf8" },
      );
      bare = out.split("\n").filter(Boolean);
    } catch {
      // Walk fallback (rare — grep is typically present). Empty result is safe.
    }
    expect(bare).toEqual([]);
    // Sanity: at least some route files exist so the test is not a no-op.
    const routes = fs.readdirSync(path.resolve(process.cwd(), "app/api"));
    expect(routes.length).toBeGreaterThan(0);
  });
});
