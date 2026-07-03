/**
 * ES-090 Phase 2 Loop-2 v2 amendment (ScriptDev) — HP-237 SECURITY BLOCKER.
 *
 * ChangedSpec §b.2 step 2 re-login path (HP-237 section, 2026-04-15):
 *
 *   Before any expiry-check + rotation in the emailVerified=true branch,
 *   the handler MUST verify all four:
 *   1. site.verificationCode is set
 *   2. site.codeExpiresAt > now
 *   3. verifyCode(code, site.verificationCode) returns true
 *   4. Brute-force guards (checkAndIncrementOtpAttempt / otpLockedUntil)
 *
 *   Any failure → 401 { error: "Invalid or expired code" } — GENERIC
 *   message, no info leak distinguishing the failure reason.
 *
 * Tests mapped to spec §c.1 U2e-bf / U2f-bf / U2g-bf / U2h-bf / U2i:
 * - U2e-bf: no pending OTP → 401 + no rotation
 * - U2f-bf: expired OTP → 401 + no rotation
 * - U2g-bf: wrong OTP → 401 + otp_attempts increments + no rotation
 * - U2h-bf: otp_attempts threshold reached → 401 + no rotation
 * - U2i: happy-path with OTP gate satisfied → rotation (U2a already covers)
 *
 * Security rationale: re-login branch is reachable via POST /api/sites/[id]/verify
 * with just a siteId (in middleware ALWAYS_ALLOWED — no session). Pre-HP-237
 * an attacker with a leaked siteId could POST any 6-char code and receive
 * the site's accessToken. Post-HP-224 the same bypass becomes active DoS
 * + token theft because rotation fires on the attacker's call.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ accessToken: "ROTATED_TOKEN_32" }]),
        }),
      }),
    }),
  },
}));

const verifyCode = vi.fn();
// HP-239 split: route now calls checkOtpLock (read-only) + incrementOtpAttempt
// (write, only on wrong-code path). Mock both; assert increment semantics per
// HP-237/239 spec.
const checkOtpLock = vi.fn();
const incrementOtpAttempt = vi.fn().mockResolvedValue({ lockedOut: false });
const clearOtpAttempts = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/email", () => ({
  verifyCode: (...args: unknown[]) => verifyCode(...args),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  generateVerificationCode: vi.fn().mockReturnValue("123456"),
  hashCode: vi.fn((c: string) => `hashed-${c}`),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkOtpLock: (...args: unknown[]) => checkOtpLock(...args),
  incrementOtpAttempt: (...args: unknown[]) => incrementOtpAttempt(...args),
  clearOtpAttempts: (...args: unknown[]) => clearOtpAttempts(...args),
  // Legacy wrapper still exported — some pre-existing tests mock it
  checkAndIncrementOtpAttempt: vi.fn().mockResolvedValue({ allowed: true, attemptsLeft: 4 }),
}));
vi.mock("@/lib/qstash", () => ({ enqueueStage: vi.fn().mockResolvedValue({ messageId: "mock" }) }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: vi.fn().mockReturnValue(null) }));
vi.mock("@/lib/services/provision-team", () => ({ ensureTeamForUser: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/services/exchange-code", () => ({ generateExchangeCode: vi.fn().mockResolvedValue("mock-exchange") }));
vi.mock("nanoid", () => ({ nanoid: vi.fn().mockReturnValue("ROTATED_TOKEN_32") }));

import { POST } from "@/app/api/sites/[id]/verify/route";
import { db } from "@/lib/db";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const SITE_ID = "site-hp237";
const EXISTING_TOKEN = "existing_token_value_aaaaaaaaaaa";

function reLoginSite(overrides: Record<string, unknown> = {}) {
  return {
    id: SITE_ID,
    domain: "hp237.example.test",
    slug: "hp237",
    ownerEmail: "user@hp237.test",
    teamId: null,
    userId: null,
    emailVerified: true,
    accessToken: EXISTING_TOKEN,
    tokenExpiresAt: new Date(Date.now() - 1_000), // expired → rotation would fire if OTP passes
    codeExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    verificationCode: "hashed-123456",
    pipelineStatus: "complete",
    geoScorecard: null,
    auditMode: null,
    batchId: null,
    bulkUrls: null,
    ...overrides,
  };
}

function stubSiteLookup(site: ReturnType<typeof reLoginSite>) {
  const where = vi.fn().mockResolvedValue([site]);
  const from = vi.fn().mockReturnValue({ where });
  (db.select as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ from });
}

function buildReq(): NextRequest {
  return new NextRequest(new URL(`https://app.test/api/sites/${SITE_ID}/verify`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "123456" }),
  });
}

const ctx = { params: Promise.resolve({ id: SITE_ID }) };

// ─── Cases ────────────────────────────────────────────────────────────────

describe("ES-090 HP-237 / verify re-login OTP gate (SECURITY)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Defaults: OTP gate passes. Each test overrides to fail a specific step.
    verifyCode.mockReturnValue(true);
    checkOtpLock.mockResolvedValue({ allowed: true });
    incrementOtpAttempt.mockResolvedValue({ lockedOut: false });
  });

  it("U2e-bf: no pending OTP (verificationCode=null) → 401 + NO increment + timingEqualize fires (HP-239 + HP-244)", async () => {
    stubSiteLookup(reLoginSite({ verificationCode: null }));
    const res = await POST(buildReq(), ctx);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Invalid or expired code");
    // HP-239 STRENGTHENED: increment MUST NOT have been called.
    expect(incrementOtpAttempt).not.toHaveBeenCalled();
    expect(clearOtpAttempts).not.toHaveBeenCalled();
    // HP-244: timingEqualize MUST fire — exactly 1 db.update call (no-op UPDATE
    // mirroring wrong-OTP latency). Distinguishes "no DB write at all" (leaks
    // no-OTP state) from "no-op UPDATE" (indistinguishable from wrong-OTP).
    expect((db.update as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("U2f-bf: expired OTP (codeExpiresAt < now) → 401 + NO increment + timingEqualize fires (HP-239 + HP-244)", async () => {
    stubSiteLookup(reLoginSite({ codeExpiresAt: new Date(Date.now() - 1_000) }));
    const res = await POST(buildReq(), ctx);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Invalid or expired code");
    // HP-239 STRENGTHENED: expired-OTP path must not burn counter.
    expect(incrementOtpAttempt).not.toHaveBeenCalled();
    // HP-244: timingEqualize fires on expired-OTP path too.
    expect((db.update as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("U2g-bf: wrong OTP → 401 + incrementOtpAttempt CALLED + NO rotation", async () => {
    verifyCode.mockReturnValue(false);
    stubSiteLookup(reLoginSite());
    const res = await POST(buildReq(), ctx);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Invalid or expired code");
    // HP-239: increment fires ONLY when verifyCode fails (real wrong-code attempt).
    expect(incrementOtpAttempt).toHaveBeenCalledWith(SITE_ID);
    expect(clearOtpAttempts).not.toHaveBeenCalled();
  });

  it("U2h-bf: lock active (checkOtpLock returns !allowed) → 401 + NO increment (HP-239)", async () => {
    checkOtpLock.mockResolvedValue({ allowed: false, lockedUntil: new Date(Date.now() + 60_000) });
    stubSiteLookup(reLoginSite());
    const res = await POST(buildReq(), ctx);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Invalid or expired code");
    // HP-239 STRENGTHENED: locked path must not increment (no further
    // counter activity once already locked).
    expect(incrementOtpAttempt).not.toHaveBeenCalled();
  });

  it("U2j (HP-240): locked path does ZERO writes beyond the timing-equalize no-op", async () => {
    // Assert: one db.update call (the no-op timingEqualize), incrementOtpAttempt
    // NOT called. The single update distinguishes timing-equalize (no-op) from
    // the unlocked+wrong-OTP path which would call incrementOtpAttempt AND
    // potentially write elsewhere.
    checkOtpLock.mockResolvedValue({ allowed: false });
    stubSiteLookup(reLoginSite());
    const res = await POST(buildReq(), ctx);

    expect(res.status).toBe(401);
    expect(incrementOtpAttempt).not.toHaveBeenCalled();
    expect(clearOtpAttempts).not.toHaveBeenCalled();
    // Exactly one db.update call — the timing-equalize no-op. If rotation
    // had somehow fired it would show as a second update.
    expect((db.update as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("U2i: happy-path — OTP gate satisfied + expired token → rotation fires", async () => {
    // All gate checks pass; tokenExpiresAt is in the past → rotation.
    stubSiteLookup(reLoginSite());
    const res = await POST(buildReq(), ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.accessToken).toBe("ROTATED_TOKEN_32");
    expect(clearOtpAttempts).toHaveBeenCalledWith(SITE_ID);
    // HP-239: happy-path does NOT call incrementOtpAttempt (reserved for wrong-code).
    expect(incrementOtpAttempt).not.toHaveBeenCalled();
    // Rotation fired (db.update called at least once — could be rotation + any other).
    expect(db.update).toHaveBeenCalled();
  });

  it("fresh-verify path also uses the shared gate (symmetric — HP-237 §b.2 line 197)", async () => {
    // emailVerified=false → fresh-verify path. assertOtpGate helper should
    // fire here too. Give invalid OTP and assert same 401 generic response
    // + increment semantics match HP-239.
    verifyCode.mockReturnValue(false);
    stubSiteLookup(reLoginSite({ emailVerified: false, userId: null }));
    const res = await POST(buildReq(), ctx);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Invalid or expired code");
    // Fresh-verify wrong-OTP also goes through the same increment path.
    expect(incrementOtpAttempt).toHaveBeenCalledWith(SITE_ID);
  });
});
