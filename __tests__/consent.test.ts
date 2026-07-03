/**
 * Unit tests for TOS/EULA click-wrap consent flow.
 *
 * Tests the consent check in the verify route and the consent recording endpoint.
 *
 * C-1  New user OTP verify → requiresConsent: true (no consent record)
 * C-2  Returning user OTP verify → no requiresConsent (consent exists)
 * C-3  Already-verified site, no consent → requiresConsent: true
 * C-4  Already-verified site, with consent → exchange code returned
 * C-5  POST /consent → records consent, returns success
 * C-6  POST /consent without tosAccepted → 400
 * C-7  POST /consent on unverified site → 400
 * C-8  POST /consent on site without userId → 400
 * C-9  POST /consent idempotent (double-submit safe)
 * C-10 POST /consent starts pipeline if status=pending
 *
 * Mocks: @/lib/db, @/lib/rate-limit, @/lib/email, @/lib/qstash,
 *        @/lib/supabase/admin, @/lib/services/provision-team,
 *        @/lib/services/exchange-code
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  // HP-239 split: route uses checkOtpLock (read-only) + incrementOtpAttempt.
  checkOtpLock: vi.fn().mockResolvedValue({ allowed: true }),
  incrementOtpAttempt: vi.fn().mockResolvedValue({ lockedOut: false }),
  checkAndIncrementOtpAttempt: vi.fn().mockResolvedValue({ allowed: true }),
  clearOtpAttempts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/email", () => ({
  verifyCode: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/services/provision-team", () => ({
  ensureTeamForUser: vi.fn().mockResolvedValue({ teamId: "team-1", isNewTeam: true }),
}));

vi.mock("@/lib/services/exchange-code", () => ({
  generateExchangeCode: vi.fn().mockResolvedValue("mock-exchange-code"),
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn().mockReturnValue("test-nanoid-id"),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST as verifyPOST } from "@/app/api/sites/[id]/verify/route";
import { POST as consentPOST } from "@/app/api/sites/[id]/consent/route";
import { db } from "@/lib/db";
import { enqueueStage } from "@/lib/qstash";
import { NextRequest } from "next/server";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeVerifyRequest(siteId: string, code = "123456"): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new NextRequest(
    new Request(`http://localhost/api/sites/${siteId}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    })
  );
  const ctx = { params: Promise.resolve({ id: siteId }) };
  return [req, ctx];
}

function makeConsentRequest(siteId: string, body: Record<string, unknown> = { tosAccepted: true }): [NextRequest, { params: Promise<{ id: string }> }] {
  const req = new NextRequest(
    new Request(`http://localhost/api/sites/${siteId}/consent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "1.2.3.4",
        "user-agent": "TestAgent/1.0",
        "authorization": "Bearer existing-token",
      },
      body: JSON.stringify(body),
    })
  );
  const ctx = { params: Promise.resolve({ id: siteId }) };
  return [req, ctx];
}

// A site that has NOT been verified yet (OTP pending)
const UNVERIFIED_SITE = {
  id: "site-1",
  domain: "example.com",
  slug: "example-com",
  ownerEmail: "test@example.com",
  teamId: null,
  userId: null,
  emailVerified: false,
  verificationCode: "hashed-code",
  codeExpiresAt: new Date(Date.now() + 900000), // 15 min from now
  accessToken: null,
  pipelineStatus: "pending",
  geoScorecard: null,
  auditMode: "single",
  bulkUrls: null,
  batchId: null,
};

// A site already verified with a user linked
// ES-090 HP-237: re-login branch now also requires a valid pending OTP —
// fixture keeps verificationCode + codeExpiresAt populated so the shared
// assertOtpGate helper passes and the consent flow exercises as intended.
const VERIFIED_SITE = {
  ...UNVERIFIED_SITE,
  emailVerified: true,
  verificationCode: "hashed-code",
  codeExpiresAt: new Date(Date.now() + 900000),
  accessToken: "existing-token",
  tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
  userId: "supabase-user-123",
  teamId: "team-1",
};

/** Mock select chain that returns different rows based on call order */
let selectCallIndex = 0;
let selectResponses: unknown[][] = [];

function makeSelectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
    limit: vi.fn().mockReturnThis(),
  };
}

function makeUpdateChain() {
  // .where() is awaitable ([] for callers that don't read rows-affected) AND
  // exposes .returning() (FIX-014 rows-affected guard) resolving to one row so
  // the guarded credit reserve treats the deduction as applied.
  const whereResult = Object.assign(Promise.resolve([]), {
    returning: vi.fn().mockResolvedValue([{ id: "team-1" }]),
  });
  return {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnValue(whereResult),
  };
}

function makeInsertChain() {
  return {
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockResolvedValue([]),
  };
}

/**
 * Set up db.select to return different results for sequential calls.
 * First call: site lookup, second call: consent check, etc.
 */
function setupSequentialSelects(...responses: unknown[][]) {
  selectCallIndex = 0;
  selectResponses = responses;
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    const idx = selectCallIndex++;
    const rows = idx < selectResponses.length ? selectResponses[idx] : [];
    return makeSelectChain(rows);
  });
}

// ─── Tests: Verify Route Consent Check ───────────────────────────────────────

describe("Verify route — consent gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectCallIndex = 0;
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  it("C-1: new user verify → requiresConsent: true when no consent record", async () => {
    // Site already has userId (set during a prior partial verify or by admin)
    // This simulates: OTP verified, user created, but consent not yet given.
    // The verify route checks effectiveUserId (site.userId) after auth setup.
    // With admin mocked to null, the legacy path runs but site.userId stays as-is.
    const siteWithUser = { ...UNVERIFIED_SITE, userId: "supabase-user-123" };

    // Call 1: site lookup → unverified site with userId
    // Call 2: legacy team member lookup → no match (empty)
    // Call 3: consent check → empty (no consent)
    setupSequentialSelects([siteWithUser], [], []);

    const [req, ctx] = makeVerifyRequest("site-1");
    const res = await verifyPOST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.requiresConsent).toBe(true);
    expect(body.siteId).toBe("site-1");
  });

  it("C-2: returning user verify → no requiresConsent when consent exists", async () => {
    const siteWithUser = { ...UNVERIFIED_SITE, userId: "supabase-user-123" };

    // Call 1: site lookup → unverified site with user
    // Call 2: legacy team member lookup → no match
    // Call 3: consent check → has consent record
    setupSequentialSelects(
      [siteWithUser],
      [],
      [{ id: "consent-1" }], // consent exists
    );

    const [req, ctx] = makeVerifyRequest("site-1");
    const res = await verifyPOST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.requiresConsent).toBeUndefined();
    // Should proceed to normal flow with accessToken
    expect(body.accessToken).toBeDefined();
  });

  it("C-3: already-verified site, no consent → requiresConsent: true", async () => {
    // Call 1: site lookup → verified site with userId
    // Call 2: consent check → empty
    setupSequentialSelects([VERIFIED_SITE], []);

    const [req, ctx] = makeVerifyRequest("site-1");
    const res = await verifyPOST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.requiresConsent).toBe(true);
    expect(body.siteId).toBe("site-1");
  });

  it("C-4: already-verified site, with consent → normal response (no consent gate)", async () => {
    // Call 1: site lookup → verified site with userId
    // Call 2: consent check → has consent
    setupSequentialSelects(
      [VERIFIED_SITE],
      [{ id: "consent-1" }],
    );

    const [req, ctx] = makeVerifyRequest("site-1");
    const res = await verifyPOST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.requiresConsent).toBeUndefined();
    expect(body.accessToken).toBeDefined();
  });
});

// ─── Tests: Consent Endpoint ────────────────────────────────────────────────

describe("POST /api/sites/[id]/consent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectCallIndex = 0;
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  it("C-5: valid consent → records consent and returns success", async () => {
    setupSequentialSelects([VERIFIED_SITE]);

    const [req, ctx] = makeConsentRequest("site-1");
    const res = await consentPOST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.siteId).toBe("site-1");
    expect(body.accessToken).toBe("existing-token");

    // Verify db.insert was called (consent record)
    expect(db.insert).toHaveBeenCalled();
  });

  it("C-6: missing tosAccepted → 400", async () => {
    const [req, ctx] = makeConsentRequest("site-1", {});
    const res = await consentPOST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("TOS acceptance required");
  });

  it("C-7: unverified site → 400", async () => {
    setupSequentialSelects([{ ...VERIFIED_SITE, emailVerified: false }]);

    const [req, ctx] = makeConsentRequest("site-1");
    const res = await consentPOST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Email not verified");
  });

  it("C-8: site without userId → 400", async () => {
    setupSequentialSelects([{ ...VERIFIED_SITE, userId: null }]);

    const [req, ctx] = makeConsentRequest("site-1");
    const res = await consentPOST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("User identity not established");
  });

  it("C-9: double-submit is safe (onConflictDoNothing)", async () => {
    setupSequentialSelects([VERIFIED_SITE]);

    const insertChain = makeInsertChain();
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(insertChain);

    const [req, ctx] = makeConsentRequest("site-1");
    const res = await consentPOST(req, ctx);

    expect(res.status).toBe(200);
    expect(insertChain.values).toHaveBeenCalledTimes(1);
    expect(insertChain.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it("C-10: consent triggers pipeline when status=pending", async () => {
    const pendingSite = { ...VERIFIED_SITE, pipelineStatus: "pending" };
    // Call 1: site lookup
    // Call 2: team lookup for credit balance (inside consent route)
    setupSequentialSelects(
      [pendingSite],
      [{ id: "team-1", creditBalance: 10 }],
    );

    const [req, ctx] = makeConsentRequest("site-1");
    const res = await consentPOST(req, ctx);

    expect(res.status).toBe(200);

    // Pipeline should be started
    expect(enqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "site-1",
        domain: "example.com",
        stage: "discover",
      })
    );

    // pipelineStatus should be updated to "discovery"
    expect(db.update).toHaveBeenCalled();
  });

  it("C-10b: consent does NOT re-trigger pipeline when status=complete", async () => {
    const completeSite = { ...VERIFIED_SITE, pipelineStatus: "complete", geoScorecard: { score: 65 } };
    setupSequentialSelects([completeSite]);

    const [req, ctx] = makeConsentRequest("site-1");
    const res = await consentPOST(req, ctx);

    expect(res.status).toBe(200);
    expect(enqueueStage).not.toHaveBeenCalled();
  });

  it("C-11: site not found → 404", async () => {
    setupSequentialSelects([]);

    const [req, ctx] = makeConsentRequest("nonexistent");
    const res = await consentPOST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Site not found");
  });
});
