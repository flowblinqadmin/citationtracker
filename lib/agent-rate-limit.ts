// In-memory rate limiter for the agent one-shot surface.
//
// WHY NOT the DB-backed lib/rate-limit.ts: that limiter upserts into the shared,
// geo-owned public.rate_limits table. The agent one-shot feature is 100%
// stateless by contract — no tracker.* or public.* writes — so it cannot use it.
// The caller is a SINGLE trusted upstream (the agent-storefront x402 gateway
// authenticated with AGENT_SERVICE_TOKEN), so a per-instance in-memory bucket is
// sufficient: this is a courtesy backstop against a runaway loop, not a
// multi-tenant fairness control (real spend control is x402 upstream).
//
// Caveat (documented, accepted): Vercel runs multiple serverless instances, so
// the effective ceiling is LIMIT × instanceCount, and buckets reset on cold
// start. That is fine here — the bucket exists to stop a single client hammering
// one warm instance, not to enforce a hard global quota.
//
// Fixed-window counter keyed on the caller's token. 30 requests / hour.

export const AGENT_RATE_LIMIT = 30;
export const AGENT_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

interface Bucket {
  count: number;
  resetAt: number; // epoch ms when the window rolls over
}

// Module-level map: survives across requests on a warm instance.
const buckets = new Map<string, Bucket>();

export interface AgentRateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Consume one token for `key`. Fixed 1-hour window; when the window has elapsed
 * the counter resets. `now`/`store` are injectable for deterministic tests.
 */
export function checkAgentRateLimit(
  key: string,
  now: number = Date.now(),
  store: Map<string, Bucket> = buckets,
): AgentRateLimitResult {
  const existing = store.get(key);

  if (!existing || now >= existing.resetAt) {
    const bucket: Bucket = { count: 1, resetAt: now + AGENT_RATE_WINDOW_MS };
    store.set(key, bucket);
    return { allowed: true, remaining: AGENT_RATE_LIMIT - 1, resetAt: bucket.resetAt };
  }

  if (existing.count >= AGENT_RATE_LIMIT) {
    return { allowed: false, remaining: 0, resetAt: existing.resetAt };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: AGENT_RATE_LIMIT - existing.count,
    resetAt: existing.resetAt,
  };
}

/** Test-only: clear all buckets (module-level state persists between tests). */
export function __resetAgentRateLimits(store: Map<string, Bucket> = buckets): void {
  store.clear();
}
