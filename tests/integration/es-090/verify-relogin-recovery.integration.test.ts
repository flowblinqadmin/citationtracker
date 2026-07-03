/**
 * ES-090 IT1a — Self-lockout recovery via re-login (HP-224, AC-2).
 *
 * PR#1 merge gate. Full end-to-end lockout → fresh-OTP re-verify → new-token
 * propagation across the 4 enforcement sites.
 *
 * Narrative (ES-090 §d line 1548, AC-2):
 *   1. Create site + initial verify → capture accessToken #1 + tokenExpiresAt.
 *   2. Fast-forward DB: tokenExpiresAt = now − 1s (simulate natural expiry).
 *   3. Regenerate with old token → 401 TOKEN_EXPIRED (lockout proven).
 *   4. Seed fresh OTP on site (emailVerified → false, verificationCode = hash(TEST_OTP)).
 *   5. Re-verify with TEST_OTP → verify route's OTP path rotates:
 *        emailVerified=true + accessToken #2 + tokenExpiresAt ≈ now+90d.
 *   6. EACH of the 4 gated routes accepts the NEW token (no 401 TOKEN_EXPIRED).
 *
 * Per HP Loop 2 observation: the spec narrative says "ANY of 4 gated routes"
 * but EACH is cleaner regression coverage. Parameterized assertions cover
 * every enforcement site.
 *
 * Fixture: reuses shared `_setup.ts` (real Supabase Postgres via
 * SUPABASE_DATABASE_URL). Matches IT1/IT2 pattern in
 * `tests/integration/es-090/token-expiry.integration.test.ts`.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { db, seedSite, cleanupSite, closeDb, eq } from "./_setup";
import { geoSites } from "@/lib/db/schema";

const created: string[] = [];

// Matches `TEST_OTP_CODE` / `hashTestCode()` in
// tests/integration/bulk-csv-qa/helpers/db-helpers.ts — same sha256 scheme
// used by lib/email.ts `hashCode()` so the route's verifyCode() accepts it.
const TEST_OTP_CODE = "847291";
function hashTestCode(): string {
  return crypto.createHash("sha256").update(TEST_OTP_CODE).digest("hex");
}

/**
 * Seed a fresh test OTP on an existing site: resets emailVerified=false,
 * writes verificationCode=sha256(code), extends code_expires_at by 15 minutes,
 * and clears any prior brute-force lock (otpAttempts/otpLockedUntil). Matches
 * the bulk-csv-qa helper pattern; optional `code` param defaults to
 * TEST_OTP_CODE for forward-compat with new amendments that may use
 * different test codes.
 */
async function seedOtpOnSite(siteId: string, code: string = TEST_OTP_CODE): Promise<void> {
  const hash = crypto.createHash("sha256").update(code).digest("hex");
  await db.update(geoSites)
    .set({
      verificationCode: hash,
      codeExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      emailVerified: false,
      otpAttempts: 0,
      otpLockedUntil: null,
    } as Record<string, unknown>)
    .where(eq(geoSites.id, siteId));
}

beforeAll(() => {
  if (!process.env.NEXT_PUBLIC_APP_URL) {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  }
});

afterEach(async () => {
  while (created.length) {
    const id = created.pop()!;
    try { await cleanupSite(id); } catch { /* ignore */ }
  }
});

afterAll(async () => { await closeDb(); });

interface CallResult { status: number; body: unknown; }

async function fetchJson(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<CallResult> {
  const url = opts.token
    ? `${process.env.NEXT_PUBLIC_APP_URL}${path}?token=${opts.token}`
    : `${process.env.NEXT_PUBLIC_APP_URL}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  };
  const res = await fetch(url, init);
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

describe("ES-090 IT1a — self-lockout recovery via re-login (HP-224, AC-2, PR#1 merge gate)", () => {
  it("expired token blocks regenerate; fresh OTP re-verify issues new token that unlocks EACH of the 4 gated routes", async () => {
    // Step 1: seed with team so team-path gates (citation-check, competitor,
    // regenerate team-path) are reachable without a 402 credits-gap.
    const site = await seedSite({ withTeam: true });
    created.push(site.id);
    const oldToken = site.accessToken;

    // Step 2: fast-forward expiry to the past.
    await db.update(geoSites)
      .set({ tokenExpiresAt: new Date(Date.now() - 1000) } as Record<string, unknown>)
      .where(eq(geoSites.id, site.id));

    // Step 3: regenerate with expired bearer → 401 TOKEN_EXPIRED (lockout proven).
    const lockoutRes = await fetchJson("POST", `/api/sites/${site.id}/regenerate`, { token: oldToken });
    expect(lockoutRes.status, "regenerate with expired bearer must 401 (lockout)").toBe(401);
    expect((lockoutRes.body as { code?: string }).code, "lockout must surface TOKEN_EXPIRED code").toBe("TOKEN_EXPIRED");

    // Step 4: seed fresh OTP — this flips emailVerified=false so verify POST
    // takes the OTP-verification branch (not the already-verified exchange-code
    // / rotateIfExpired branch).
    await seedOtpOnSite(site.id);

    // Step 5: re-verify with the TEST_OTP. The OTP-verify branch must rotate
    // the accessToken and refresh tokenExpiresAt to ≈ now+90d.
    const verifyRes = await fetchJson("POST", `/api/sites/${site.id}/verify`, {
      body: { code: TEST_OTP_CODE, tosAccepted: true },
    });
    expect(verifyRes.status, "re-verify with fresh OTP must 200").toBe(200);
    const verifyBody = verifyRes.body as { accessToken?: string; success?: boolean };
    expect(verifyBody.accessToken, "verify body must include new accessToken").toBeTruthy();
    expect(verifyBody.accessToken, "new accessToken must differ from pre-lockout token").not.toBe(oldToken);

    // DB assertion: tokenExpiresAt now ≈ now + 90d and tokenRotatedAt set.
    const [postVerifyRow] = await db.select().from(geoSites).where(eq(geoSites.id, site.id));
    const row = postVerifyRow as unknown as { tokenExpiresAt: Date | null; tokenRotatedAt: Date | null; emailVerified: boolean };
    expect(row.emailVerified, "site must be re-verified").toBe(true);
    expect(row.tokenExpiresAt, "tokenExpiresAt must be refreshed").toBeInstanceOf(Date);
    expect(row.tokenExpiresAt!.getTime(), "tokenExpiresAt must be ≈ now+90d (allow slight drift)")
      .toBeGreaterThan(Date.now() + 89 * 86_400_000);
    expect(row.tokenRotatedAt, "tokenRotatedAt must be set on rotation").toBeInstanceOf(Date);

    // Step 6 (HP observation tightened from ANY → EACH): each of the 4 gated
    // routes must accept the NEW token. We assert the absence of 401
    // TOKEN_EXPIRED on each — downstream gates (402 credits / 400 validation /
    // 409 pipeline state) are allowed because those are orthogonal to the
    // lockout-recovery contract under test.
    const newToken = verifyBody.accessToken!;
    const gated: Array<{ label: string; method: string; path: string }> = [
      { label: "GET /api/sites/[id]",                            method: "GET",  path: `/api/sites/${site.id}` },
      { label: "POST /api/sites/[id]/citation-check",            method: "POST", path: `/api/sites/${site.id}/citation-check` },
      { label: "POST /api/sites/[id]/competitor-discovery",      method: "POST", path: `/api/sites/${site.id}/competitor-discovery` },
      { label: "POST /api/sites/[id]/regenerate",                method: "POST", path: `/api/sites/${site.id}/regenerate` },
    ];

    for (const { label, method, path } of gated) {
      const res = await fetchJson(method, path, { token: newToken });
      expect(res.status, `${label} must not 401 with TOKEN_EXPIRED after re-login`).not.toBe(401);
      const code = (res.body as { code?: string } | null)?.code;
      expect(code, `${label} body.code must not be TOKEN_EXPIRED`).not.toBe("TOKEN_EXPIRED");
    }
  }, 60_000);

  // ── IT1b (HP-237, PR#1 merge gate) ──────────────────────────────────────────
  // SECURITY-CRITICAL: the OTP gate on the re-login rotation path. If a
  // client calls POST /verify with no pending OTP on record (cleared
  // verificationCode / codeExpiresAt), the handler MUST reject without
  // rotating. A rotation on this path would mean an attacker who ever got
  // the accessToken once can re-mint indefinitely without email control.
  it("IT1b (HP-237, PR#1 merge gate): re-login with no pending OTP returns 401; DB token NOT rotated", async () => {
    const site = await seedSite({ withTeam: true });
    created.push(site.id);

    // emailVerified=true + no pending OTP + expired token (simulates the
    // "attacker has old token, no active OTP" attack surface).
    await db.update(geoSites)
      .set({
        emailVerified: true,
        verificationCode: null,
        codeExpiresAt: null,
        tokenExpiresAt: new Date(Date.now() - 1000),
        tokenRotatedAt: null,
      } as Record<string, unknown>)
      .where(eq(geoSites.id, site.id));

    const initialToken = site.accessToken;

    const res = await fetchJson("POST", `/api/sites/${site.id}/verify`, {
      body: { code: "000000" },
    });
    expect(res.status, "bypass attempt must 401 (no pending OTP)").toBe(401);

    // DB invariant: accessToken unchanged, tokenRotatedAt still null, expiry
    // still in the past — no rotation side-effect from the failed verify.
    const [dbRow] = await db.select().from(geoSites).where(eq(geoSites.id, site.id));
    const row = dbRow as unknown as { accessToken: string; tokenRotatedAt: Date | null; tokenExpiresAt: Date | null };
    expect(row.accessToken, "DB accessToken MUST NOT rotate on failed bypass").toBe(initialToken);
    expect(row.tokenRotatedAt, "tokenRotatedAt MUST remain null on failed bypass").toBeNull();
    expect(row.tokenExpiresAt!.getTime(), "tokenExpiresAt MUST remain expired on failed bypass")
      .toBeLessThan(Date.now());
  }, 60_000);

  // ── IT1c (HP-237 brute-force hardening) ─────────────────────────────────────
  // Re-verify with wrong OTPs exhausts the attempt counter. Even once the
  // CORRECT OTP is presented, a live lock (otp_locked_until > now) must
  // reject. Threshold comes from lib/rate-limit.ts: limit is 5 attempts,
  // lock for 15 minutes. The skeleton's 6-iteration loop overshoots — after
  // attempt 5 the row is locked at otpAttempts=5, subsequent POSTs return
  // allowed=false without incrementing further, so we assert >= 5, not >= 6.
  it("IT1c (HP-237): brute-force exhaustion triggers otpLockedUntil; correct OTP is rejected while lock is active", async () => {
    const site = await seedSite({ withTeam: true });
    created.push(site.id);

    await seedOtpOnSite(site.id, TEST_OTP_CODE);
    await db.update(geoSites)
      .set({ tokenExpiresAt: new Date(Date.now() - 1000) } as Record<string, unknown>)
      .where(eq(geoSites.id, site.id));

    // Exhaust the wrong-OTP attempts (6 iterations > 5-attempt threshold).
    for (let i = 0; i < 6; i++) {
      await fetchJson("POST", `/api/sites/${site.id}/verify`, { body: { code: "111111" } });
    }

    // Even the CORRECT OTP must be rejected while lock is active.
    const lockedRes = await fetchJson("POST", `/api/sites/${site.id}/verify`, {
      body: { code: TEST_OTP_CODE, tosAccepted: true },
    });
    expect(lockedRes.status, "correct OTP must be rejected while lock is active").toBe(401);

    const [dbRow] = await db.select().from(geoSites).where(eq(geoSites.id, site.id));
    const row = dbRow as unknown as { otpAttempts: number; otpLockedUntil: Date | null };
    expect(row.otpAttempts, "otpAttempts must reach/exceed threshold (5)").toBeGreaterThanOrEqual(5);
    expect(row.otpLockedUntil, "otpLockedUntil must be a Date").toBeInstanceOf(Date);
    expect(row.otpLockedUntil!.getTime(), "otpLockedUntil must be in the future (15min lock per lib/rate-limit)")
      .toBeGreaterThan(Date.now());
  }, 60_000);
});

// ── HP-236 race IT (optional per 1-cofounder:43) ───────────────────────────────
// Undici's fetch supports true concurrency; including this guard per CoFounder's
// "your call" clause. If CI shows flakes from real-time clock drift, this IT
// can be skipped without affecting merge-gate coverage (SD owns unit-level
// HP-236 coverage).
describe("ES-090 HP-236 — conditional-UPDATE race resolution on concurrent re-logins", () => {
  it("HP-236: two concurrent verify POSTs converge on a single winning accessToken", async () => {
    const site = await seedSite({ withTeam: true });
    created.push(site.id);

    await seedOtpOnSite(site.id, TEST_OTP_CODE);
    await db.update(geoSites)
      .set({ tokenExpiresAt: new Date(Date.now() - 1000) } as Record<string, unknown>)
      .where(eq(geoSites.id, site.id));

    const verifyBody = { code: TEST_OTP_CODE, tosAccepted: true };
    const [resA, resB] = await Promise.all([
      fetchJson("POST", `/api/sites/${site.id}/verify`, { body: verifyBody }),
      fetchJson("POST", `/api/sites/${site.id}/verify`, { body: verifyBody }),
    ]);

    // Both POSTs should land 200 because verifyCode() + OTP clear are
    // idempotent under the conditional-UPDATE fix. If one races the other on
    // the OTP counter and fails, the test flags a real race bug.
    expect(resA.status, "concurrent verify A must 200").toBe(200);
    expect(resB.status, "concurrent verify B must 200").toBe(200);

    const tokenA = (resA.body as { accessToken?: string }).accessToken;
    const tokenB = (resB.body as { accessToken?: string }).accessToken;
    expect(tokenA, "A body must include accessToken").toBeTruthy();
    expect(tokenB, "B body must include accessToken").toBeTruthy();

    // HP-236 invariant: both responses must carry the SAME winning token.
    // Pre-fix behavior would race and issue two separate rotations, landing
    // one response with a stale token that then 401s.
    expect(tokenA, "HP-236: concurrent re-logins must converge on a single winning token").toBe(tokenB);

    // And the winning token must validate against a gated route.
    const getRes = await fetchJson("GET", `/api/sites/${site.id}`, { token: tokenA });
    expect(getRes.status, "winning token must be valid against GET /sites/[id]").toBe(200);
  }, 60_000);
});
