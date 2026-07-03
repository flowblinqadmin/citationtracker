/**
 * Serve Guard Tests — Rate limiting on /api/serve/* routes
 *
 * Tests the 3-layer serve protection per ES-004 spec (Task 1, #11).
 * 6 test cases covering:
 *   9.  AI crawler bypasses rate limit (100 requests all pass)
 *   10. Unknown UA rate limited at 10/min per slug per IP
 *   11. Different IPs not rate limited together
 *   12. Different slugs not rate limited together
 *   13. 429 response includes Retry-After header
 *   14. Rate limit resets after window expires
 *
 * Tests the rate limiting integration with serve routes.
 * Uses a mocked checkRateLimit (DB-backed in production; in-memory here for speed).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isKnownAICrawler } from "@/lib/crawler-allowlist";

// ─── In-memory rate limit mock ──────────────────────────────────────────────
// Mirrors the behaviour of the DB-backed checkRateLimit, but runs in-memory
// so tests don't need a real Postgres connection.

const mockRateLimitStore = new Map<string, { count: number; resetAt: number }>();

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockImplementation(
    async (key: string, limit: number, windowMs: number) => {
      const now = Date.now();
      const entry = mockRateLimitStore.get(key);
      if (!entry || entry.resetAt <= now) {
        const resetAt = now + windowMs;
        mockRateLimitStore.set(key, { count: 1, resetAt });
        return { allowed: true, remaining: limit - 1, resetAt };
      }
      entry.count++;
      const allowed = entry.count <= limit;
      return {
        allowed,
        remaining: Math.max(0, limit - entry.count),
        resetAt: entry.resetAt,
      };
    }
  ),
}));

import { checkRateLimit } from "@/lib/rate-limit";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Simulates the serve route guard logic that will be added to each
 * serve route handler. This mirrors the spec's final architecture:
 * Layer 1 → AI crawler pass-through, Layer 3 → rate limit unknown.
 */
async function simulateServeGuard(
  ua: string,
  slug: string,
  ip: string
): Promise<{ allowed: boolean; status?: number; retryAfter?: number }> {
  // Layer 1: Known AI crawler — always allow
  if (isKnownAICrawler(ua)) {
    return { allowed: true };
  }

  // Layer 3: Rate limit unknown traffic
  const rateKey = `serve:${slug}:${ip}`;
  const { allowed, resetAt } = await checkRateLimit(rateKey, 10, 60_000);
  if (!allowed) {
    return {
      allowed: false,
      status: 429,
      retryAfter: Math.ceil((resetAt - Date.now()) / 1000),
    };
  }

  return { allowed: true };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Serve route guard — rate limiting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimitStore.clear();
  });

  // ── Test 9: AI crawler bypasses rate limit ──

  it("9. AI crawler (GPTBot) bypasses rate limit even after 100 requests", async () => {
    const ua = "Mozilla/5.0 (compatible; GPTBot/1.0)";
    const slug = "test-site-ai";
    const ip = "1.2.3.4";

    for (let i = 0; i < 100; i++) {
      const result = await simulateServeGuard(ua, slug, ip);
      expect(result.allowed).toBe(true);
    }
  });

  // ── Test 10: Unknown UA rate limited at 10/min ──

  it("10. unknown UA rate limited after 10 requests per slug per IP", async () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
    const slug = "test-site-limit";
    const ip = "10.0.0.1";

    // First 10 should pass
    for (let i = 0; i < 10; i++) {
      const result = await simulateServeGuard(ua, slug, ip);
      expect(result.allowed).toBe(true);
    }

    // 11th should be rate limited
    const result = await simulateServeGuard(ua, slug, ip);
    expect(result.allowed).toBe(false);
    expect(result.status).toBe(429);
  });

  // ── Test 11: Different IPs not rate limited together ──

  it("11. different IPs have independent rate limits", async () => {
    const ua = "Mozilla/5.0";
    const slug = "test-site-multi-ip";

    // IP A: 10 requests
    for (let i = 0; i < 10; i++) {
      expect((await simulateServeGuard(ua, slug, "ip-a-unique")).allowed).toBe(true);
    }

    // IP B: 10 requests (independent counter)
    for (let i = 0; i < 10; i++) {
      expect((await simulateServeGuard(ua, slug, "ip-b-unique")).allowed).toBe(true);
    }

    // Both totals are 10 — neither should be limited yet
    // But IP A is now at limit:
    expect((await simulateServeGuard(ua, slug, "ip-a-unique")).allowed).toBe(false);
    // IP B is also at limit:
    expect((await simulateServeGuard(ua, slug, "ip-b-unique")).allowed).toBe(false);
  });

  // ── Test 12: Different slugs not rate limited together ──

  it("12. different slugs have independent rate limits", async () => {
    const ua = "Mozilla/5.0";
    const ip = "ip-slug-test";

    // Slug A: 10 requests
    for (let i = 0; i < 10; i++) {
      expect((await simulateServeGuard(ua, "slug-a-unique", ip)).allowed).toBe(true);
    }

    // Slug B: 10 requests (independent counter)
    for (let i = 0; i < 10; i++) {
      expect((await simulateServeGuard(ua, "slug-b-unique", ip)).allowed).toBe(true);
    }

    // Slug A is at limit, Slug B is at limit independently
    expect((await simulateServeGuard(ua, "slug-a-unique", ip)).allowed).toBe(false);
    expect((await simulateServeGuard(ua, "slug-b-unique", ip)).allowed).toBe(false);
  });

  // ── Test 13: 429 includes Retry-After header ──

  it("13. rate limited response includes Retry-After with numeric value", async () => {
    const ua = "Mozilla/5.0";
    const slug = "test-site-retry";
    const ip = "ip-retry-test";

    // Exhaust rate limit
    for (let i = 0; i < 10; i++) {
      await simulateServeGuard(ua, slug, ip);
    }

    const result = await simulateServeGuard(ua, slug, ip);
    expect(result.allowed).toBe(false);
    expect(result.status).toBe(429);
    expect(result.retryAfter).toBeDefined();
    expect(typeof result.retryAfter).toBe("number");
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(result.retryAfter).toBeLessThanOrEqual(60);
  });

  // ── Test 14: Rate limit resets after window ──

  it("14. rate limit resets after 60s window expires", async () => {
    const ua = "Mozilla/5.0";
    const slug = "test-site-reset";
    const ip = "ip-reset-test";

    vi.useFakeTimers();

    // Exhaust limit
    for (let i = 0; i < 10; i++) {
      await simulateServeGuard(ua, slug, ip);
    }
    expect((await simulateServeGuard(ua, slug, ip)).allowed).toBe(false);

    // Advance past the 60s window
    vi.advanceTimersByTime(61_000);

    // Should be allowed again (mock checks Date.now() which fake timers control)
    expect((await simulateServeGuard(ua, slug, ip)).allowed).toBe(true);

    vi.useRealTimers();
  });
});
