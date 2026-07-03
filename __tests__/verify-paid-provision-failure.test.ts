/**
 * FIX-015 — verify route must NOT silently downgrade a PAID audit to a free
 * 20-page run when Supabase provisioning / team-linking throws.
 *
 * When the admin client is present (real flow, not the test/build "no admin"
 * fallback) and ensureTeamForUser throws so the site stays unlinked
 * (site.teamId === null), the route must:
 *   - return 500 (retryable) IF the owner email maps to a paid team, so the
 *     client retries and the audit links + bills on the idempotent retry;
 *   - swallow + continue (free audit) IF the owner is a genuinely free user.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), transaction: vi.fn() },
}));

vi.mock("@/lib/email", () => ({ verifyCode: vi.fn().mockReturnValue(true) }));

vi.mock("@/lib/rate-limit", () => ({
  checkOtpLock: vi.fn().mockResolvedValue({ allowed: true }),
  incrementOtpAttempt: vi.fn().mockResolvedValue({ lockedOut: false }),
  clearOtpAttempts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/qstash", () => ({ enqueueStage: vi.fn().mockResolvedValue(undefined) }));

// Admin client PRESENT (createUser succeeds → supaUserId set), so the route
// reaches ensureTeamForUser (mocked to throw below) — i.e. a real provisioning
// failure, NOT the "no admin client" test/build fallback.
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    auth: {
      admin: {
        createUser: vi.fn().mockResolvedValue({ data: { user: { id: "supa-user-1" } }, error: null }),
        generateLink: vi.fn().mockResolvedValue({ data: { user: { id: "supa-user-1" }, properties: { hashed_token: "ht" } }, error: null }),
      },
    },
  }),
}));

vi.mock("@/lib/services/provision-team", () => ({
  ensureTeamForUser: vi.fn().mockRejectedValue(new Error("supabase down: team linking failed")),
}));

vi.mock("@/lib/services/exchange-code", () => ({
  generateExchangeCode: vi.fn().mockResolvedValue("exchange-code"),
}));

vi.mock("nanoid", () => ({ nanoid: vi.fn().mockReturnValue("nano") }));

import { POST } from "@/app/api/sites/[id]/verify/route";
import { db } from "@/lib/db";
import { enqueueStage } from "@/lib/qstash";

const SITE_ID = "site-paid-1";

function makeSelectChain(rows: unknown[]) {
  return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(rows) };
}
function makeUpdateChain() {
  const whereResult = Object.assign(Promise.resolve([]), {
    returning: vi.fn().mockResolvedValue([{ id: "team-1" }]),
  });
  return { set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnValue(whereResult) };
}
function makeRequest(): import("next/server").NextRequest {
  return new Request(`http://localhost/api/sites/${SITE_ID}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "123456" }),
  }) as unknown as import("next/server").NextRequest;
}
function ctx() {
  return { params: Promise.resolve({ id: SITE_ID }) };
}

const UNVERIFIED_SINGLE_SITE = {
  id: SITE_ID,
  domain: "paid.io",
  ownerEmail: "buyer@example.com",
  auditMode: "single",
  teamId: null,
  userId: null,
  emailVerified: false,
  verificationCode: "hashed",
  codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
  pipelineStatus: "pending",
  geoScorecard: null,
  accessToken: null,
};

describe("FIX-015 — verify provisioning failure must not silently downgrade paid audits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL; // skip the GoTrue token-exchange fetch
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: vi.fn().mockResolvedValue([]) });
  });

  it("returns 500 (retryable) when linking throws and the owner email maps to a PAID team", async () => {
    let n = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      n++;
      if (n === 1) return makeSelectChain([UNVERIFIED_SINGLE_SITE]);          // site
      if (n === 2) return makeSelectChain([{ id: "m1", teamId: "team-1", email: "buyer@example.com" }]); // teamMembers
      return makeSelectChain([{ id: "team-1", creditBalance: 50, subscriptionTier: "free", subscriptionStatus: "inactive" }]); // paid (credits)
    });

    const res = await POST(makeRequest(), ctx());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.retryable).toBe(true);
    // Must NOT have started a free 20-page audit.
    expect(vi.mocked(enqueueStage)).not.toHaveBeenCalled();
  });

  it("continues (free audit) when linking throws but the owner is a genuinely FREE user", async () => {
    let n = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      n++;
      if (n === 1) return makeSelectChain([UNVERIFIED_SINGLE_SITE]); // site
      return makeSelectChain([]);                                    // no team membership → free
    });

    const res = await POST(makeRequest(), ctx());

    expect(res.status).toBe(200);
    // Free user still gets their audit (FREE_MAX_PAGES), not blocked by the blip.
    expect(vi.mocked(enqueueStage)).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE_ID, stage: "discover", maxPages: 20 }),
    );
  });
});
