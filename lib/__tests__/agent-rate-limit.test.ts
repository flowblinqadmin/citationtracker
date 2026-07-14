// Unit tests for the in-memory agent rate limiter. Uses an injected store +
// clock so nothing leaks across tests and the fixed window is deterministic.
import { describe, it, expect } from "vitest";
import {
  checkAgentRateLimit,
  __resetAgentRateLimits,
  AGENT_RATE_LIMIT,
  AGENT_RATE_WINDOW_MS,
} from "@/lib/agent-rate-limit";

const KEY = "token-abc";

describe("checkAgentRateLimit", () => {
  it("allows the first request and counts down remaining", () => {
    const store = new Map();
    const r = checkAgentRateLimit(KEY, 1_000, store);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(AGENT_RATE_LIMIT - 1);
    expect(r.resetAt).toBe(1_000 + AGENT_RATE_WINDOW_MS);
  });

  it("allows exactly AGENT_RATE_LIMIT requests, then blocks the next", () => {
    const store = new Map();
    const now = 5_000;
    for (let i = 0; i < AGENT_RATE_LIMIT; i++) {
      expect(checkAgentRateLimit(KEY, now, store).allowed).toBe(true);
    }
    const blocked = checkAgentRateLimit(KEY, now, store);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    // resetAt is the window opened on the first request.
    expect(blocked.resetAt).toBe(now + AGENT_RATE_WINDOW_MS);
  });

  it("resets the counter once the window has elapsed", () => {
    const store = new Map();
    const start = 10_000;
    for (let i = 0; i < AGENT_RATE_LIMIT; i++) checkAgentRateLimit(KEY, start, store);
    expect(checkAgentRateLimit(KEY, start, store).allowed).toBe(false);

    // Cross the window boundary → fresh bucket.
    const after = start + AGENT_RATE_WINDOW_MS;
    const r = checkAgentRateLimit(KEY, after, store);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(AGENT_RATE_LIMIT - 1);
    expect(r.resetAt).toBe(after + AGENT_RATE_WINDOW_MS);
  });

  it("keys buckets independently per token", () => {
    const store = new Map();
    const now = 20_000;
    for (let i = 0; i < AGENT_RATE_LIMIT; i++) checkAgentRateLimit("a", now, store);
    expect(checkAgentRateLimit("a", now, store).allowed).toBe(false);
    // A different token is unaffected.
    expect(checkAgentRateLimit("b", now, store).allowed).toBe(true);
  });

  it("__resetAgentRateLimits clears the store", () => {
    const store = new Map();
    for (let i = 0; i < AGENT_RATE_LIMIT; i++) checkAgentRateLimit(KEY, 30_000, store);
    expect(checkAgentRateLimit(KEY, 30_000, store).allowed).toBe(false);
    __resetAgentRateLimits(store);
    expect(checkAgentRateLimit(KEY, 30_000, store).allowed).toBe(true);
  });
});
