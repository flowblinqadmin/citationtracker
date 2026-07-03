/**
 * Commerce-audit rate limiting + OTP brute-force lockout.
 *
 * H1 audit fix (2026-05-27):
 *   - Previous implementation used in-memory Maps that reset on every Vercel
 *     cold start. An attacker hammering across instances easily exceeded the
 *     5-attempt cap.
 *   - OTP attempts were keyed on the attacker-controllable `contact_email`,
 *     so an attacker could poison the lockout for a victim by spamming
 *     wrong OTPs under the victim's email.
 *
 * Both bugs are closed by:
 *   - Persisting state in the `rate_limits` table (already DB-backed for
 *     /api/sites OTP — see lib/rate-limit.ts).
 *   - Keying OTP lockout on `auditReports.id` (the canonical audit
 *     identifier), not the email.
 *
 * The plain checkRateLimit() helper preserves its old signature
 * (key/maxRequests/windowMs → boolean) so existing call sites in
 * /api/audit and /api/audit/[id]/verify keep compiling.
 */

import { db } from "@/lib/db";
import { rateLimits } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

const OTP_MAX_FAILURES = 5;
const OTP_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * DB-persisted sliding-window rate limiter.
 * Boolean return preserves the existing call-site contract.
 */
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): Promise<boolean> {
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
        count: sql`CASE WHEN ${rateLimits.resetAt} < ${nowStr}::timestamptz THEN 1 ELSE ${rateLimits.count} + 1 END`,
        resetAt: sql`CASE WHEN ${rateLimits.resetAt} < ${nowStr}::timestamptz THEN ${resetAtStr}::timestamptz ELSE ${rateLimits.resetAt} END`,
      },
    })
    .returning();

  if (!row) return false; // DB-side anomaly — fail closed.
  return row.count <= maxRequests;
}

// ── OTP brute-force lockout (keyed on auditReports.id) ────────────────────

function otpKey(reportId: string): string {
  return `audit_otp:${reportId}`;
}

/**
 * Returns whether the audit (by ID) is currently locked out. Does NOT
 * mutate the counter.
 *
 * Renamed parameter from `email` (the attacker-controllable identifier) to
 * `reportId` so a victim's lockout cannot be poisoned by an attacker
 * submitting wrong OTPs under the victim's email.
 */
export async function checkOtpAttempt(
  reportId: string,
): Promise<{ allowed: boolean; lockedUntil?: Date }> {
  const [row] = await db
    .select({ count: rateLimits.count, resetAt: rateLimits.resetAt })
    .from(rateLimits)
    .where(eq(rateLimits.key, otpKey(reportId)));

  if (!row) return { allowed: true };
  if (row.count >= OTP_MAX_FAILURES && row.resetAt > new Date()) {
    return { allowed: false, lockedUntil: row.resetAt };
  }
  return { allowed: true };
}

/**
 * Atomically increments the per-audit failure counter and (re-)applies the
 * lockout window. Call ONLY on actual OTP failure.
 *
 * Window policy (adversarial-review fix 2026-05-27):
 *   - When the prior window has EXPIRED → start fresh: count=1, resetAt=now+15min.
 *   - When still inside an active window → count+=1, resetAt UNCHANGED.
 *
 * The previous implementation reset `resetAt` on every failure (true
 * sliding window). That let an attacker who knew a victim's audit_id keep
 * the legitimate owner locked out indefinitely by submitting one wrong
 * code every 14 minutes. With a fixed window, the lockout naturally
 * expires after 15 minutes from the FIRST failure of the burst — bounded
 * worst case for the victim is 15 minutes per attack burst.
 */
export async function recordOtpFailure(reportId: string): Promise<void> {
  const key = otpKey(reportId);
  const now = new Date();
  const resetAt = new Date(now.getTime() + OTP_LOCKOUT_MS);
  const nowStr = now.toISOString();
  const resetAtStr = resetAt.toISOString();

  await db
    .insert(rateLimits)
    .values({ key, count: 1, resetAt })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        // Reset count when prior window expired; otherwise +1.
        count: sql`CASE WHEN ${rateLimits.resetAt} < ${nowStr}::timestamptz THEN 1 ELSE ${rateLimits.count} + 1 END`,
        // Fixed window: only set resetAt when starting a fresh window;
        // leave it alone if we're inside an active lockout. Caps the
        // attacker-controlled DoS to one 15min burst.
        resetAt: sql`CASE WHEN ${rateLimits.resetAt} < ${nowStr}::timestamptz THEN ${resetAtStr}::timestamptz ELSE ${rateLimits.resetAt} END`,
      },
    });
}

/**
 * Clears the failure counter on a successful verify.
 */
export async function clearOtpFailures(reportId: string): Promise<void> {
  await db.delete(rateLimits).where(eq(rateLimits.key, otpKey(reportId)));
}
