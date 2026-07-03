/**
 * ES-090 HP-240 — Timing-attack resistance on the locked-path 401.
 *
 * HP-240 adds a timing-equalize step on the locked path so that response
 * latency is statistically indistinguishable from the unlocked-but-wrong-OTP
 * path. Without equalization, an attacker can measure 401 response times to
 * discover whether a victim site is currently locked — a targeted enumeration
 * vector (and a leak of the state machine's internals).
 *
 * Test strategy: 20 samples per bucket, compare p50 latencies. Adversarial-
 * flaky by nature (network jitter, DB warmup, GC); start with a generous
 * 50ms delta threshold. Tighten as ScriptDev's equalize implementation
 * stabilizes.
 *
 * Reuses shared `_setup.ts` (real Supabase via SUPABASE_DATABASE_URL). Needs
 * a live dev server at NEXT_PUBLIC_APP_URL. If CI harness shows flakes,
 * downgrade to `.skip` and substitute an observability alert; flag tradeoff
 * back to CoFounder.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { db, seedSite, cleanupSite, closeDb, eq } from "./_setup";
import { geoSites } from "@/lib/db/schema";

const created: string[] = [];
const TEST_OTP_CODE = "847291";
const HASH_OF_OTP = crypto.createHash("sha256").update(TEST_OTP_CODE).digest("hex");

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

/** Sample-wise percentile (linear interp). */
function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
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

async function postVerify(siteId: string, code: string): Promise<Response> {
  return fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/sites/${siteId}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

describe("ES-090 HP-240 + HP-244 — timing-attack resistance across all 4 OTP-gate failure paths", () => {
  // HP-244 extends the HP-240 guard from 2 buckets (locked vs wrong-OTP) to
  // all 4 assertOtpGate failure modes:
  //
  //   1. LOCKED      — otpLockedUntil in future; checkOtpLock returns !allowed.
  //                    timingEqualize fires on this path (HP-240 original).
  //   2. NO-OTP      — verificationCode=NULL; assertOtpGate step 2 rejects.
  //                    timingEqualize fires on this path (HP-244 extension).
  //   3. EXPIRED-OTP — verificationCode set but codeExpiresAt in past;
  //                    step 3 rejects. timingEqualize fires (HP-244).
  //   4. WRONG-OTP   — all fields valid but verifyCode() returns false;
  //                    incrementOtpAttempt fires (which itself is a DB write,
  //                    naturally equalized — no separate timingEqualize call).
  //
  // All 4 bucket p50s must fall within a 50ms band. Generous threshold per
  // CoFounder 1-cofounder:48 flakiness disclaimer.
  it("all 4 OTP-gate 401 p50 response times fall within a narrow delta band (< 50ms)", async () => {
    // ── Bucket 1: LOCKED ───────────────────────────────────────────────
    const lockedSite = await seedSite({ withTeam: true });
    created.push(lockedSite.id);
    await db.update(geoSites)
      .set({
        verificationCode: HASH_OF_OTP,
        codeExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
        otpLockedUntil: new Date(Date.now() + 10 * 60 * 1000),
        otpAttempts: 5,
      } as Record<string, unknown>)
      .where(eq(geoSites.id, lockedSite.id));

    // ── Bucket 2: WRONG-OTP ────────────────────────────────────────────
    const unlockedSite = await seedSite({ withTeam: true });
    created.push(unlockedSite.id);
    await seedOtpOnSite(unlockedSite.id, TEST_OTP_CODE);

    // ── Bucket 3: NO-OTP (verificationCode=NULL) ───────────────────────
    const noOtpSite = await seedSite({ withTeam: true });
    created.push(noOtpSite.id);
    await db.update(geoSites)
      .set({
        verificationCode: null,
        codeExpiresAt: null,
        otpAttempts: 0,
        otpLockedUntil: null,
      } as Record<string, unknown>)
      .where(eq(geoSites.id, noOtpSite.id));

    // ── Bucket 4: EXPIRED-OTP ──────────────────────────────────────────
    const expiredOtpSite = await seedSite({ withTeam: true });
    created.push(expiredOtpSite.id);
    await db.update(geoSites)
      .set({
        verificationCode: HASH_OF_OTP,
        codeExpiresAt: new Date(Date.now() - 1000),  // 1s in past
        otpAttempts: 0,
        otpLockedUntil: null,
      } as Record<string, unknown>)
      .where(eq(geoSites.id, expiredOtpSite.id));

    const N = 20;
    const lockedTimings: number[] = [];
    const wrongTimings: number[] = [];
    const noOtpTimings: number[] = [];
    const expiredTimings: number[] = [];

    // Pre-warm: four discarded POSTs to amortize Next.js JIT / DB connection
    // across all code paths.
    await postVerify(lockedSite.id, "999999");
    await postVerify(unlockedSite.id, "999999");
    await postVerify(noOtpSite.id, "999999");
    await postVerify(expiredOtpSite.id, "999999");

    for (let i = 0; i < N; i++) {
      // Reset unlocked site's attempts so it stays on the increment path
      // for the full sample series; otherwise the 5th sample would itself
      // become locked and pollute bucket 2.
      await db.update(geoSites)
        .set({ otpAttempts: 0, otpLockedUntil: null } as Record<string, unknown>)
        .where(eq(geoSites.id, unlockedSite.id));

      const t1 = performance.now();
      await postVerify(lockedSite.id, "WRONG1");
      lockedTimings.push(performance.now() - t1);

      const t2 = performance.now();
      await postVerify(unlockedSite.id, "WRONG1");
      wrongTimings.push(performance.now() - t2);

      const t3 = performance.now();
      // Any 6-char code — route hits step 2 (verificationCode=NULL) before
      // constant-time compare.
      await postVerify(noOtpSite.id, "000000");
      noOtpTimings.push(performance.now() - t3);

      const t4 = performance.now();
      // Matching code — route hits step 3 (codeExpiresAt in past) before
      // constant-time compare.
      await postVerify(expiredOtpSite.id, TEST_OTP_CODE);
      expiredTimings.push(performance.now() - t4);
    }

    const p50Locked = percentile(lockedTimings, 50);
    const p50Wrong = percentile(wrongTimings, 50);
    const p50NoOtp = percentile(noOtpTimings, 50);
    const p50Expired = percentile(expiredTimings, 50);
    const all = [p50Locked, p50Wrong, p50NoOtp, p50Expired];
    const delta = Math.max(...all) - Math.min(...all);

    // Generous 50ms band — network + DB jitter dominates at this scale.
    // If this IT consistently stays <10ms in CI, tighten to 15ms. If it
    // flakes above 50ms, investigate whether HP-240+HP-244 timingEqualize
    // actually runs on the failing path (locked / no-OTP / expired).
    expect(
      delta,
      `HP-244 timing-equalize gap — locked p50=${p50Locked.toFixed(1)}ms wrong p50=${p50Wrong.toFixed(1)}ms ` +
      `no-OTP p50=${p50NoOtp.toFixed(1)}ms expired p50=${p50Expired.toFixed(1)}ms ` +
      `spread=${delta.toFixed(1)}ms (max−min across all 4 buckets)`,
    ).toBeLessThan(50);
  }, 180_000);
});
