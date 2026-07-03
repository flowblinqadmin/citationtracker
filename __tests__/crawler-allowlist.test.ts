/**
 * Crawler Allowlist Tests — lib/crawler-allowlist.ts
 *
 * Tests AI crawler User-Agent detection per ES-004 spec (Task 1, #11).
 * 8 test cases covering:
 *   1. GPTBot recognized
 *   2. ClaudeBot recognized
 *   3. PerplexityBot recognized
 *   4. Googlebot recognized
 *   5. Regular browser NOT recognized
 *   6. Empty UA string → false
 *   7. Case insensitive matching
 *   8. Partial match in longer UA string
 *
 * These tests are written BEFORE implementation (test-first).
 * They will FAIL until lib/crawler-allowlist.ts is created.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import { isKnownAICrawler, AI_CRAWLER_UA_PATTERNS } from "@/lib/crawler-allowlist";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("isKnownAICrawler()", () => {
  // ── Test 1: GPTBot recognized ──

  it("1. recognizes GPTBot user agent", () => {
    expect(isKnownAICrawler("Mozilla/5.0 (compatible; GPTBot/1.0)")).toBe(true);
  });

  // ── Test 2: ClaudeBot recognized ──

  it("2. recognizes ClaudeBot user agent", () => {
    expect(isKnownAICrawler("ClaudeBot/1.0")).toBe(true);
  });

  // ── Test 3: PerplexityBot recognized ──

  it("3. recognizes PerplexityBot user agent", () => {
    expect(isKnownAICrawler("PerplexityBot/1.0")).toBe(true);
  });

  // ── Test 4: Googlebot recognized ──

  it("4. recognizes Googlebot user agent", () => {
    expect(isKnownAICrawler("Googlebot/2.1")).toBe(true);
  });

  // ── Test 5: Regular browser NOT recognized ──

  it("5. does NOT recognize regular browser user agent", () => {
    expect(
      isKnownAICrawler(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      )
    ).toBe(false);
  });

  // ── Test 6: Empty UA string ──

  it("6. returns false for empty user agent string", () => {
    expect(isKnownAICrawler("")).toBe(false);
  });

  // ── Test 7: Case insensitive matching ──

  it("7. matches case-insensitively (gptbot → true)", () => {
    expect(isKnownAICrawler("gptbot")).toBe(true);
    expect(isKnownAICrawler("CLAUDEBOT")).toBe(true);
    expect(isKnownAICrawler("googlebot")).toBe(true);
  });

  // ── Test 8: Partial match in longer UA ──

  it("8. matches when AI crawler name is embedded in longer UA string", () => {
    expect(
      isKnownAICrawler(
        "Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)"
      )
    ).toBe(true);
    expect(
      isKnownAICrawler(
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"
      )
    ).toBe(true);
  });
});

// ─── Pattern Coverage ───────────────────────────────────────────────────────

describe("AI_CRAWLER_UA_PATTERNS — coverage", () => {
  it("exports an array of RegExp patterns", () => {
    expect(Array.isArray(AI_CRAWLER_UA_PATTERNS)).toBe(true);
    expect(AI_CRAWLER_UA_PATTERNS.length).toBeGreaterThanOrEqual(10);
    for (const pattern of AI_CRAWLER_UA_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
    }
  });

  it("includes patterns for all major AI crawlers", () => {
    const crawlers = [
      "GPTBot", "ClaudeBot", "PerplexityBot", "Googlebot",
      "GoogleExtended", "Bingbot", "Applebot", "cohere-ai",
      "meta-externalagent", "Bytespider", "CCBot",
    ];

    for (const crawler of crawlers) {
      const matched = AI_CRAWLER_UA_PATTERNS.some((p) => p.test(crawler));
      expect(matched).toBe(true);
    }
  });
});
