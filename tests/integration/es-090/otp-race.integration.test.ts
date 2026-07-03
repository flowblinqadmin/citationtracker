/**
 * ES-090 IT7 — OTP concurrent verify race.
 *
 * Phase A (RED): 20 parallel wrong-OTP submits against same siteId.
 * Spec: ≤5 succeed in incrementing; lockout applied; attempts 6+ blocked.
 * Hard cap from §b.9 — UPDATE … RETURNING is the serialization point.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { db, seedSite, cleanupSite, closeDb, eq } from "./_setup";
import { runOtpRace, OTP_HARD_CAP } from "@/tests/fixtures/es-090/otp-race";

const created: string[] = [];

beforeAll(() => { if (!process.env.NEXT_PUBLIC_APP_URL) process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; });
afterEach(async () => {
  while (created.length) {
    const id = created.pop()!;
    try { await cleanupSite(id); } catch { /* ignore */ }
  }
});
afterAll(async () => { await closeDb(); });

describe("ES-090 IT7 — OTP race-safe under 20x concurrency", () => {
  it("at most 5 successful increments before lockout; final attempts == 5", async () => {
    const site = await seedSite({ withTeam: true });
    created.push(site.id);

    const { checkAndIncrementOtpAttempt } = await import("@/lib/rate-limit");
    const { geoSites } = await import("@/lib/db/schema");

    const verdict = await runOtpRace(
      () => checkAndIncrementOtpAttempt(site.id),
      20,
      async () => {
        const [row] = await db.select().from(geoSites).where(eq(geoSites.id, site.id));
        return (row?.otpAttempts as number | undefined) ?? 0;
      },
    );

    expect(verdict.allowedCount).toBeLessThanOrEqual(OTP_HARD_CAP);
    expect(verdict.finalAttempts).toBeLessThanOrEqual(OTP_HARD_CAP);
    expect(verdict.blockedCount).toBeGreaterThanOrEqual(20 - OTP_HARD_CAP);

    // After the race, lockout must be in effect — a 21st attempt must be rejected.
    const after = await checkAndIncrementOtpAttempt(site.id);
    expect(after.allowed).toBe(false);
  }, 30_000);
});
