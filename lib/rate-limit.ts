import { db } from "@/lib/db";
import { geoSites, rateLimits } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * DB-backed IP/email rate limiter. Replaces in-memory Map.
 * Atomic upsert prevents race conditions across Vercel instances.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const now = new Date();
  const resetAt = new Date(Date.now() + windowMs);
  const nowStr = now.toISOString();
  const resetAtStr = resetAt.toISOString();

  const [row] = await db
    .insert(rateLimits)
    .values({ key, count: 1, resetAt })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count:   sql`CASE WHEN ${rateLimits.resetAt} < ${nowStr}::timestamptz THEN 1 ELSE ${rateLimits.count} + 1 END`,
        resetAt: sql`CASE WHEN ${rateLimits.resetAt} < ${nowStr}::timestamptz THEN ${resetAtStr}::timestamptz ELSE ${rateLimits.resetAt} END`,
      },
    })
    .returning();

  // AC-B2-3: ensure every reject path is a thrown Error with a non-empty
  // message so downstream route catches can serialize it. Without this, an
  // empty `returning()` (DB-side anomaly) would TypeError on `row.resetAt`
  // with a context-free message.
  if (!row?.resetAt) {
    throw new Error(`[rate-limit] insert/upsert returned no row for key=${key}`);
  }

  const resetAtMs = row.resetAt.getTime();

  if (row.count > limit) {
    console.warn(`[rate-limit] key=${key} blocked count=${row.count} limit=${limit}`);
    return { allowed: false, remaining: 0, resetAt: resetAtMs };
  }

  return { allowed: true, remaining: limit - row.count, resetAt: resetAtMs };
}

/**
 * ES-090 HP-239 — READ-ONLY lock check.
 *
 * Returns whether the siteId is currently locked out. Does NOT mutate.
 * Safe to call before any condition (OTP presence, OTP expiry) in the
 * auth gate without polluting the attempts counter on no-OTP or
 * expired-OTP paths — HP-239's pre-split bug was incrementing here.
 */
export async function checkOtpLock(
  siteId: string
): Promise<{ allowed: boolean; lockedUntil?: Date }> {
  const [row] = await db
    .select({ otpLockedUntil: geoSites.otpLockedUntil })
    .from(geoSites)
    .where(eq(geoSites.id, siteId));

  if (!row) return { allowed: false };
  if (row.otpLockedUntil && row.otpLockedUntil > new Date()) {
    console.warn(`[rate-limit] OTP attempt blocked (lock active) siteId=${siteId}`);
    return { allowed: false, lockedUntil: row.otpLockedUntil };
  }
  return { allowed: true };
}

/**
 * ES-090 HP-239 — PURE WRITE increment. Caller invokes only when a
 * `verifyCode()` attempt actually failed — NOT on every call. Mirrors the
 * threshold-trip semantics of the legacy helper: attempts + 1, and if that
 * hits 5 also sets otpLockedUntil = now + 15min.
 */
export async function incrementOtpAttempt(
  siteId: string
): Promise<{ lockedOut: boolean; otpAttempts: number }> {
  const now = new Date();
  // The postgres driver rejects raw Date instances passed through Drizzle's
  // `sql\`${x}\`` template (TypeError ERR_INVALID_ARG_TYPE: "Received an
  // instance of Date"). Drizzle's typed `set({ col: date })` helper would
  // serialise against the column's type, but the sql-template path passes
  // the value through raw. Send the ISO string with an explicit ::timestamp
  // cast so the driver's bind step succeeds and Postgres parses it into the
  // `timestamp without time zone` column type.
  const lockUntilIso = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

  // Atomic: increment + conditionally apply lock in one UPDATE. The CASE
  // ensures we only write the lock timestamp when the new attempt count
  // hits the 5-threshold, and leaves the prior lock value intact otherwise.
  const [updated] = await db
    .update(geoSites)
    .set({
      otpAttempts: sql`${geoSites.otpAttempts} + 1`,
      otpLockedUntil: sql`CASE WHEN ${geoSites.otpAttempts} + 1 >= 5 THEN ${lockUntilIso}::timestamp ELSE ${geoSites.otpLockedUntil} END`,
    })
    .where(eq(geoSites.id, siteId))
    .returning({ otpAttempts: geoSites.otpAttempts, otpLockedUntil: geoSites.otpLockedUntil });

  const lockedOut = !!updated?.otpLockedUntil && updated.otpLockedUntil > now;
  const otpAttempts = updated?.otpAttempts ?? 0;
  if (lockedOut) {
    console.warn(`[rate-limit] OTP lock applied siteId=${siteId} attempts=${otpAttempts}`);
  }
  return { lockedOut, otpAttempts };
}

/**
 * DB-backed OTP brute-force limiter (legacy — thin wrapper post-HP-239).
 *
 * Kept for backwards-compat with any caller that preserves the
 * "lock-then-increment-on-every-call" semantics. NEW call sites should
 * use the split primitives `checkOtpLock` + `incrementOtpAttempt` so
 * the increment fires only when the caller actually observed an OTP
 * failure.
 */
export async function checkAndIncrementOtpAttempt(
  siteId: string
): Promise<{ allowed: boolean; attemptsLeft: number }> {
  const lock = await checkOtpLock(siteId);
  if (!lock.allowed) return { allowed: false, attemptsLeft: 0 };
  const { lockedOut, otpAttempts } = await incrementOtpAttempt(siteId);
  if (lockedOut) return { allowed: false, attemptsLeft: 0 };
  // attemptsLeft = 5 - newAttempts per legacy contract.
  return { allowed: true, attemptsLeft: Math.max(0, 5 - otpAttempts) };
}

/**
 * Resets OTP counter and lock on successful verification.
 */
export async function clearOtpAttempts(siteId: string): Promise<void> {
  await db
    .update(geoSites)
    .set({ otpAttempts: 0, otpLockedUntil: null })
    .where(eq(geoSites.id, siteId));
}
