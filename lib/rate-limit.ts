import { db } from "@/lib/db";
import { rateLimits } from "@/lib/db/schema";
import { sql } from "drizzle-orm";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * DB-backed rate limiter (shared rate_limits table). Atomic upsert prevents
 * race conditions across Vercel instances.
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

  // Every reject path must be a thrown Error with a non-empty message so
  // route catches can serialize it.
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
