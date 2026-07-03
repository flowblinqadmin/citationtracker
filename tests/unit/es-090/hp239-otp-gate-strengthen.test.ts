/**
 * ES-090 HP-239 strengthened OTP-gate unit tests (RM-side adversarial layer).
 *
 * HP-239 splits `checkAndIncrementOtpAttempt` into two primitives in
 * `lib/rate-limit.ts`:
 *   - `checkOtpLock(siteId)` — READ-ONLY lock check. Returns { allowed,
 *     lockedUntil? }. Never writes.
 *   - `incrementOtpAttempt(siteId)` — WRITE-ONLY increment. Called ONLY on
 *     the wrong-OTP path (site.verificationCode matches structurally but
 *     verifyCode() returns false). Lands otpLockedUntil when cap reached.
 *
 * Pre-HP-239 the verify route called `checkAndIncrementOtpAttempt` on every
 * unlocked OTP gate entry — a DoS primitive (any unauthenticated caller could
 * exhaust a victim's attempts with code="000000" POSTs). HP-239 closes that
 * by moving the increment to AFTER the verifyCode() check.
 *
 * Tests in this file assert the STRUCTURAL call pattern — not just the absence
 * of rotation (which the IT1b/IT1c file already covers). Pre-HP-239 these
 * RED because the route calls the legacy helper. Post-HP-239 GREEN.
 *
 * SpecMaster amending §c.1 with U2e-bf/U2f-bf/U2g-bf/U2h-bf/U2j. SD's own
 * unit tests live in `tests/unit/es-090/scriptdev/hp237-otp-gate.spec.ts`
 * — this file is kept separate to preserve RM vs SD independence per the
 * NewDev DevForks-isolation rule.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import crypto from "node:crypto";

const VALID_OTP = "847291";
const WRONG_OTP = "111111";
const HASH_OF_VALID_OTP = crypto.createHash("sha256").update(VALID_OTP).digest("hex");

interface FakeSite {
  id: string;
  accessToken: string;
  tokenExpiresAt: Date | null;
  tokenRotatedAt: Date | null;
  teamId: string | null;
  emailVerified: boolean;
  userId: string | null;
  ownerEmail: string;
  verificationCode: string | null;
  codeExpiresAt: Date | null;
  otpAttempts?: number;
  otpLockedUntil?: Date | null;
  auditMode?: string | null;
  pipelineStatus?: string | null;
  domain?: string;
}

const { state, dbMock, rateLimitMock, emailMock } = vi.hoisted(() => {
  const state: { site: FakeSite | null } = { site: null };

  const dbMock = {
    select: vi.fn((_proj?: unknown) => ({
      from: vi.fn((tbl: { __name?: string }) => ({
        where: vi.fn(async () => {
          if (tbl?.__name === "teams") return [{ id: "t1", creditBalance: 100 }];
          if (tbl?.__name === "consent_records") return [];
          if (tbl?.__name === "team_members") return [];
          if (tbl?.__name === "team_domains") return [];
          return state.site ? [state.site] : [];
        }),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(async () => undefined),
        then: (resolve: (v: undefined) => void) => { resolve(undefined); return Promise.resolve(undefined); },
      })),
    })),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMock)),
  };

  const rateLimitMock = {
    // HP-239 new split primitives — assertions hinge on these.
    checkOtpLock: vi.fn(async (_siteId: string) => ({ allowed: true as boolean, lockedUntil: null as Date | null })),
    incrementOtpAttempt: vi.fn(async (_siteId: string) => ({ lockedOut: false as boolean })),
    clearOtpAttempts: vi.fn(async (_siteId: string) => undefined),
    // Legacy helper — kept so pre-HP-239 route call paths also mock cleanly
    // (test stays green against transient states during HP-239 rollout).
    checkAndIncrementOtpAttempt: vi.fn(async (_siteId: string) => ({ allowed: true as boolean, attemptsLeft: 5 })),
    checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 100, reset: Date.now() + 60_000 })),
  };

  const emailMock = {
    verifyCode: vi.fn((input: string, stored: string) => {
      const h = crypto.createHash("sha256").update(input).digest("hex");
      return h === stored;
    }),
    sendVerificationEmail: vi.fn(async () => undefined),
  };

  return { state, dbMock, rateLimitMock, emailMock };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/db/schema", () => ({
  geoSites:    { __name: "geo_sites", id: "id", accessToken: "access_token", tokenExpiresAt: "token_expires_at", emailVerified: "email_verified" },
  geoSiteView: { __name: "geo_site_view", siteId: "site_id", accessToken: "access_token", tokenExpiresAt: "token_expires_at" },
  teams:       { __name: "teams", id: "id", creditBalance: "credit_balance" },
  teamMembers: { __name: "team_members" },
  teamDomains: { __name: "team_domains" },
  creditTransactions: { __name: "credit_transactions" },
  consentRecords: { __name: "consent_records", id: "id", userId: "user_id", tosVersion: "tos_version", eulaVersion: "eula_version" },
  citationCheckResponses: {},
  citationCheckScores: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  sql: (s: TemplateStringsArray) => s.join(""),
  gte: vi.fn(), and: vi.fn(), isNull: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => rateLimitMock);
vi.mock("@/lib/email", () => emailMock);
vi.mock("@/lib/qstash", () => ({ enqueueStage: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: vi.fn(() => null) }));
vi.mock("@/lib/services/provision-team", () => ({ ensureTeamForUser: vi.fn(async () => ({ teamId: "t1", userId: "u1" })) }));
vi.mock("@/lib/services/exchange-code", () => ({ generateExchangeCode: vi.fn(async () => "exchange-code-stub") }));

const BASE_SITE: FakeSite = {
  id: "site-hp239",
  accessToken: "tok-initial",
  tokenExpiresAt: new Date(Date.now() - 1000),
  tokenRotatedAt: null,
  teamId: null,
  emailVerified: true,
  userId: null,
  ownerEmail: "owner@example.test",
  verificationCode: null,
  codeExpiresAt: null,
};

function clearAllCallHistory(): void {
  dbMock.select.mockClear();
  dbMock.update.mockClear();
  dbMock.insert.mockClear();
  dbMock.transaction.mockClear();
  rateLimitMock.checkOtpLock.mockClear();
  rateLimitMock.incrementOtpAttempt.mockClear();
  rateLimitMock.clearOtpAttempts.mockClear();
  rateLimitMock.checkAndIncrementOtpAttempt.mockClear();
  emailMock.verifyCode.mockClear();
  capturedUpdatePatches.length = 0;
}

// HP-244 landed after this file was authored: assertOtpGate now calls
// `timingEqualize` on ALL 4 failure paths (locked / no-OTP / expired / wrong).
// That DOES hit db.update, but with a no-op patch (only `id`). The test
// intent — "no STATE mutation on failed gate" — becomes: any captured update
// patch must have no keys other than `id`.
const capturedUpdatePatches: Array<Record<string, unknown>> = [];

beforeEach(() => {
  state.site = null;
  clearAllCallHistory();
  // Reset per-test overrides so default allow-mode applies.
  rateLimitMock.checkOtpLock.mockImplementation(async () => ({ allowed: true, lockedUntil: null }));
  rateLimitMock.incrementOtpAttempt.mockImplementation(async () => ({ lockedOut: false }));
  // Install a capture spy on dbMock.update.set() so HP-244 timing-equalize
  // no-op writes are observable (and assertable as no-op via zero non-id keys)
  // without rejecting the call outright.
  dbMock.update.mockReset();
  dbMock.update.mockImplementation(() => ({
    set: vi.fn((patch: Record<string, unknown>) => {
      capturedUpdatePatches.push(patch);
      return { where: vi.fn(async () => undefined) };
    }),
  }));
});

function assertAllUpdatesNoOp(): void {
  for (const patch of capturedUpdatePatches) {
    const nonIdKeys = Object.keys(patch).filter((k) => k !== "id");
    expect(
      nonIdKeys,
      `failed-gate db.update patch must be no-op (HP-244 timingEqualize); got keys: ${nonIdKeys.join(",")}`,
    ).toEqual([]);
  }
}

function makeVerifyPost(siteId: string, body: unknown): NextRequest {
  return new NextRequest(`https://geo.flowblinq.com/api/sites/${siteId}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("ES-090 HP-239 — strengthened U2 OTP-gate family", () => {
  it("U2e-bf: re-login with verificationCode=NULL → 401 + checkOtpLock CALLED + incrementOtpAttempt NOT called + NO rotation", async () => {
    state.site = { ...BASE_SITE, verificationCode: null, codeExpiresAt: null };

    const { POST } = await import("@/app/api/sites/[id]/verify/route?u2e-bf");
    const res = await POST(makeVerifyPost(BASE_SITE.id, { code: "000000" }), { params: Promise.resolve({ id: BASE_SITE.id }) });

    expect(res.status, "no-pending-OTP path must 401").toBe(401);
    expect(rateLimitMock.checkOtpLock, "HP-239: checkOtpLock must run first on the re-login gate").toHaveBeenCalled();
    expect(rateLimitMock.incrementOtpAttempt, "HP-239 core: incrementOtpAttempt MUST NOT run on (a) no-pending-OTP — this is the DoS primitive").not.toHaveBeenCalled();
    // HP-244: timingEqualize now fires on the no-OTP path too, but with a
    // no-op patch (only `id`). Allow the write, reject any STATE mutation.
    assertAllUpdatesNoOp();
    const body = await res.json();
    expect(body, "failure body must be generic per spec line 193").toEqual({ error: "Invalid or expired code" });
  });

  it("U2f-bf: re-login with EXPIRED verificationCode → 401 + incrementOtpAttempt NOT called + NO rotation", async () => {
    state.site = {
      ...BASE_SITE,
      verificationCode: HASH_OF_VALID_OTP,
      codeExpiresAt: new Date(Date.now() - 1000),
    };

    const { POST } = await import("@/app/api/sites/[id]/verify/route?u2f-bf");
    const res = await POST(makeVerifyPost(BASE_SITE.id, { code: VALID_OTP }), { params: Promise.resolve({ id: BASE_SITE.id }) });

    expect(res.status).toBe(401);
    expect(rateLimitMock.incrementOtpAttempt, "HP-239 core: incrementOtpAttempt MUST NOT run on (b) expired-code path").not.toHaveBeenCalled();
    // HP-244: timingEqualize now fires on the expired-code path too, but no-op.
    assertAllUpdatesNoOp();
  });

  it("U2g-bf: re-login with WRONG OTP → 401 + incrementOtpAttempt CALLED ONCE + NO rotation", async () => {
    state.site = {
      ...BASE_SITE,
      verificationCode: HASH_OF_VALID_OTP,
      codeExpiresAt: new Date(Date.now() + 5 * 60_000),
    };

    const { POST } = await import("@/app/api/sites/[id]/verify/route?u2g-bf");
    const res = await POST(makeVerifyPost(BASE_SITE.id, { code: WRONG_OTP }), { params: Promise.resolve({ id: BASE_SITE.id }) });

    expect(res.status).toBe(401);
    expect(rateLimitMock.incrementOtpAttempt, "wrong-OTP IS the one path where increment fires exactly once").toHaveBeenCalledTimes(1);
    expect(rateLimitMock.incrementOtpAttempt).toHaveBeenCalledWith(BASE_SITE.id);
    // incrementOtpAttempt itself is the write (production writes attempts +1 +
    // optional lock). Mocked here, so `dbMock.update` sees nothing further.
    // But if a future extension adds a timingEqualize no-op on the wrong path
    // too, the assertAllUpdatesNoOp guard still holds.
    assertAllUpdatesNoOp();
  });

  it("U2h-bf: re-login with otpLockedUntil in future (correct code supplied) → 401 + incrementOtpAttempt NOT called + verifyCode NOT called", async () => {
    rateLimitMock.checkOtpLock.mockResolvedValueOnce({ allowed: false, lockedUntil: new Date(Date.now() + 10 * 60_000) });
    state.site = {
      ...BASE_SITE,
      verificationCode: HASH_OF_VALID_OTP,
      codeExpiresAt: new Date(Date.now() + 5 * 60_000),
    };

    const { POST } = await import("@/app/api/sites/[id]/verify/route?u2h-bf");
    const res = await POST(makeVerifyPost(BASE_SITE.id, { code: VALID_OTP }), { params: Promise.resolve({ id: BASE_SITE.id }) });

    expect(res.status).toBe(401);
    expect(rateLimitMock.checkOtpLock).toHaveBeenCalled();
    expect(rateLimitMock.incrementOtpAttempt, "HP-239 core: locked path MUST NOT increment (cap already reached)").not.toHaveBeenCalled();
    expect(emailMock.verifyCode, "locked path short-circuits BEFORE constant-time compare").not.toHaveBeenCalled();
  });

  it("HP-240 zero-write invariant: locked path performs zero DB writes beyond the timing-equalize no-op", async () => {
    // Renamed from "U2j" per CoFounder 1-cofounder:52 — the spec-canonical
    // U2j is now the split-primitives regression guard in
    // `u2j-split-primitives-regression.test.ts`. This test enforces the
    // HP-240 zero-write invariant (distinct concern).
    // HP-240 will add a no-op write on the locked path so locked-vs-unlocked
    // 401 latencies are indistinguishable. The invariant asserted here: any
    // db.update.set() call on the locked path must carry NO field other than
    // `id` (i.e. it's either never called, or called with a no-op patch).
    const capturedPatches: Array<Record<string, unknown>> = [];
    dbMock.update.mockImplementation(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        capturedPatches.push(patch);
        return { where: vi.fn(async () => undefined) };
      }),
    }));

    rateLimitMock.checkOtpLock.mockResolvedValueOnce({ allowed: false, lockedUntil: new Date(Date.now() + 10 * 60_000) });
    state.site = {
      ...BASE_SITE,
      verificationCode: HASH_OF_VALID_OTP,
      codeExpiresAt: new Date(Date.now() + 5 * 60_000),
    };

    const { POST } = await import("@/app/api/sites/[id]/verify/route?u2j");
    await POST(makeVerifyPost(BASE_SITE.id, { code: VALID_OTP }), { params: Promise.resolve({ id: BASE_SITE.id }) });

    expect(rateLimitMock.incrementOtpAttempt, "locked path must not increment").not.toHaveBeenCalled();

    // Per CoFounder skeleton: either (a) not called OR (b) called with no-op
    // patch. A no-op patch carries no keys or only `id`.
    for (const patch of capturedPatches) {
      const nonIdKeys = Object.keys(patch).filter((k) => k !== "id");
      expect(nonIdKeys, `locked-path db.update patch must be no-op; got keys: ${nonIdKeys.join(",")}`).toEqual([]);
    }
  });
});
