/**
 * ES-090 Phase 2 amendment (ScriptDev) — HP-224 verify-as-rotation for re-login.
 *
 * ChangedSpec §b.2 step 2 re-login path (landed 2026-04-15 per
 * `1-cofounder:28`, msg file
 * `20260415T154233Z-hp-224-spec-amendment-landed-finalize-hp.yaml`):
 *
 *   On POST /api/sites/[id]/verify with `emailVerified === true`, the two
 *   re-login return sites (requiresConsent fast-return + early exchange
 *   return) must check `site.tokenExpiresAt`:
 *     - If expired or NULL → rotate (new accessToken + now+90d expiry +
 *       tokenRotatedAt=now). Return the NEW token.
 *     - Else → return the existing `site.accessToken` unchanged.
 *
 * Spec-mandated test cases:
 * - U2a: emailVerified=true, tokenExpiresAt=Date.now()-1s → rotate, return new
 * - U2b: emailVerified=true, tokenExpiresAt=Date.now()+60d → no-op, return existing
 * - U2c: emailVerified=true, tokenExpiresAt=NULL → rotate, return new
 *
 * No module-level __test_ export is read — we assert the DB write via the
 * `db.update` mock spy (Track B discipline).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { TOKEN_TTL_MS } from "@/lib/constants/token-ttl";

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }) }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
  },
}));

vi.mock("@/lib/email", () => ({
  verifyCode: vi.fn().mockReturnValue(true),
  // Other functions potentially imported during route module load:
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  generateVerificationCode: vi.fn().mockReturnValue("123456"),
  hashCode: vi.fn((c: string) => `hashed-${c}`),
}));
// HP-239 split: verify/route.ts calls checkOtpLock + incrementOtpAttempt
// (not the legacy checkAndIncrementOtpAttempt). Mock both.
vi.mock("@/lib/rate-limit", () => ({
  checkOtpLock: vi.fn().mockResolvedValue({ allowed: true }),
  incrementOtpAttempt: vi.fn().mockResolvedValue({ lockedOut: false }),
  clearOtpAttempts: vi.fn().mockResolvedValue(undefined),
  // Legacy wrapper still exported — kept for backwards-compat with any
  // tests that mock the old name; unused by current route.
  checkAndIncrementOtpAttempt: vi.fn().mockResolvedValue({ allowed: true, attemptsLeft: 10 }),
}));
vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn().mockResolvedValue({ messageId: "mock-msg" }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/services/provision-team", () => ({
  ensureTeamForUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/services/exchange-code", () => ({
  generateExchangeCode: vi.fn().mockResolvedValue("mock-exchange"),
}));
vi.mock("nanoid", () => ({
  nanoid: vi.fn().mockReturnValue("ROTATED_TOKEN_32CHAR_MOCK_VALUE_X"),
}));

import { POST } from "@/app/api/sites/[id]/verify/route";
import { db } from "@/lib/db";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const SITE_ID = "site-es090-hp224";
const EXISTING_TOKEN = "existing_token_32_chars_aaaaa";

function reLoginSite(overrides: Record<string, unknown> = {}) {
  return {
    id: SITE_ID,
    domain: "hp224.example.test",
    slug: "hp224",
    ownerEmail: "user@hp224.test",
    teamId: null,
    userId: null,
    emailVerified: true,
    accessToken: EXISTING_TOKEN,
    tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000),
    // HP-237: re-login branch requires a valid pending OTP. Fixtures
    // provide one by default; assertOtpGate-failure paths override.
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

describe("ES-090 HP-224 / verify re-login rotation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.insert as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }),
    });
    // HP-236: rotateIfExpired now uses conditional UPDATE ... WHERE expired ... RETURNING.
    // The mock must chain set → where → returning (returning([] = race-lost; [{...}] = winner).
    // Default: rotation wins (first caller). U2b overrides where to return the fast-path site.
    (db.update as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ accessToken: "ROTATED_TOKEN_32CHAR_MOCK_VALUE_X" }]),
        }),
      }),
    });
  });

  it("U2a: expired tokenExpiresAt → rotates, returns NEW accessToken, writes rotation patch", async () => {
    stubSiteLookup(reLoginSite({ tokenExpiresAt: new Date(Date.now() - 1_000) }));
    const res = await POST(buildReq(), ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.accessToken).toBe("ROTATED_TOKEN_32CHAR_MOCK_VALUE_X");
    expect(body.accessToken).not.toBe(EXISTING_TOKEN);

    expect(db.update).toHaveBeenCalled();
    const updateCall = (db.update as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(updateCall.set).toHaveBeenCalled();
    const patch = updateCall.set.mock.calls[0][0];
    expect(patch.accessToken).toBe("ROTATED_TOKEN_32CHAR_MOCK_VALUE_X");
    expect(patch.tokenExpiresAt).toBeInstanceOf(Date);
    const expiresDelta = (patch.tokenExpiresAt as Date).getTime() - Date.now();
    expect(Math.abs(expiresDelta - TOKEN_TTL_MS)).toBeLessThan(5_000);
    expect(patch.tokenRotatedAt).toBeInstanceOf(Date);
  });

  it("U2b: still-valid tokenExpiresAt → returns existing token, NO rotation write", async () => {
    stubSiteLookup(reLoginSite({ tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000) }));
    const res = await POST(buildReq(), ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.accessToken).toBe(EXISTING_TOKEN);

    // db.update not called on the no-rotation fast path.
    expect(db.update).not.toHaveBeenCalled();
  });

  it("HP-236: race-lost — UPDATE affects 0 rows → re-SELECT returns winner's token", async () => {
    // Simulate: both our read saw expired, but a concurrent caller's UPDATE
    // committed first. Our WHERE no longer matches; returning() yields [].
    stubSiteLookup(reLoginSite({ tokenExpiresAt: new Date(Date.now() - 1_000) }));
    // Override the default winner mock to yield [] (race-lost).
    (db.update as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    // Re-SELECT will be the second db.select call. First was the site lookup
    // (which returned the stale expired site). Second is the winner re-SELECT.
    const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([reLoginSite({ tokenExpiresAt: new Date(Date.now() - 1_000) })]) }),
    }); // site lookup call
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ accessToken: "WINNER_TOKEN_FROM_RACE" }]) }),
    }); // post-race re-SELECT

    const res = await POST(buildReq(), ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    // Should return the winner's token, NOT our rotated-but-zero-rows-updated mock.
    expect(body.accessToken).toBe("WINNER_TOKEN_FROM_RACE");
    expect(db.update).toHaveBeenCalled(); // UPDATE was attempted
  });

  it("U2c: NULL tokenExpiresAt → rotation fires, new token returned (HP-197 transition rows)", async () => {
    stubSiteLookup(reLoginSite({ tokenExpiresAt: null }));
    const res = await POST(buildReq(), ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.accessToken).toBe("ROTATED_TOKEN_32CHAR_MOCK_VALUE_X");
    expect(body.accessToken).not.toBe(EXISTING_TOKEN);

    expect(db.update).toHaveBeenCalled();
    const updateCall = (db.update as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    const patch = updateCall.set.mock.calls[0][0];
    expect(patch.tokenExpiresAt).toBeInstanceOf(Date);
    // tokenExpiresAt is now non-NULL (the rotation populated it).
    expect(patch.tokenExpiresAt).not.toBeNull();
  });
});
