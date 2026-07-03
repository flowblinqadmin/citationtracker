// DB-backed rate limiter for Supabase Edge Functions.
//
// Ported from geo/lib/rate-limit.ts. Only the `checkRateLimit` primitive is
// included — the OTP helpers (checkOtpLock, incrementOtpAttempt,
// checkAndIncrementOtpAttempt, clearOtpAttempts) live in the OTP flow,
// not the beacon, and importing them would needlessly expand the function's
// privilege footprint to mutate geo_sites.
//
// Atomic upsert prevents race conditions across concurrent Edge invocations.
// Key namespaces are set by callers: the track-collect handler uses
// `beacon:<ip>`, the track-slug handler uses `slug-serve:<ip>`. This module
// is namespace-agnostic — it takes whatever string the caller passes.

import { sql } from "npm:drizzle-orm@0.45.2";
import { db } from "./db.ts";
import { rateLimits } from "./schema.ts";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Atomic per-key rate limit. Insert-or-bump with a windowed reset.
 *
 * The CASE expression handles window expiry inside the same UPDATE so we
 * never race a stale row: if the previous resetAt is in the past, the row
 * is reset (count=1, resetAt=now+windowMs); otherwise count is incremented.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
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
        count: sql`CASE WHEN ${rateLimits.resetAt} < ${nowStr}::timestamptz THEN 1 ELSE ${rateLimits.count} + 1 END`,
        resetAt: sql`CASE WHEN ${rateLimits.resetAt} < ${nowStr}::timestamptz THEN ${resetAtStr}::timestamptz ELSE ${rateLimits.resetAt} END`,
      },
    })
    .returning();

  // AC-B2-3 invariant ported from Next.js — every reject path must throw a
  // non-empty Error so the handler can serialize it.
  if (!row?.resetAt) {
    throw new Error(`[rate-limit] insert/upsert returned no row for key=${key}`);
  }

  const resetAtMs = row.resetAt.getTime();

  if (row.count > limit) {
    console.warn(
      `[rate-limit] key=${key} blocked count=${row.count} limit=${limit}`,
    );
    return { allowed: false, remaining: 0, resetAt: resetAtMs };
  }

  return { allowed: true, remaining: limit - row.count, resetAt: resetAtMs };
}
