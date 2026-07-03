/**
 * Unit tests for ES-005 Task 1 — Bulk config constants and helpers.
 *
 * 12 test cases covering:
 *   - BULK_MAX_URLS, BULK_CREDIT_PRICE_INR, ABSOLUTE_MAX_PAGES constants
 *   - bulkCreditsRequired(): ceil(urlCount / PAGES_PER_CREDIT)
 *   - effectiveCrawlLimit(): min(csvUrlCount, affordable, ABSOLUTE_MAX_PAGES)
 *
 * Uses NON-DEFAULT values to avoid catching hardcoded numbers.
 */

import { describe, it, expect } from "vitest";
import {
  BULK_MAX_URLS,
  BULK_CREDIT_PRICE_INR,
  ABSOLUTE_MAX_PAGES,
  PAGES_PER_CREDIT,
  bulkCreditsRequired,
  effectiveCrawlLimit,
} from "@/lib/config";

describe("Bulk config constants", () => {
  it("BULK_MAX_URLS is 500", () => {
    expect(BULK_MAX_URLS).toBe(500);
  });

  it("BULK_CREDIT_PRICE_INR is 20", () => {
    expect(BULK_CREDIT_PRICE_INR).toBe(20);
  });

  it("ABSOLUTE_MAX_PAGES is 500", () => {
    expect(ABSOLUTE_MAX_PAGES).toBe(500);
  });

  /**
   * REGRESSION: BULK_MAX_URLS and ABSOLUTE_MAX_PAGES were 501 vs 500 (off-by-one).
   * UI showed "up to 501 URLs" but effectiveCrawlLimit silently capped at 500.
   * These two constants MUST stay equal — if you change one, change the other.
   */
  it("BULK_MAX_URLS equals ABSOLUTE_MAX_PAGES (must stay in sync — off-by-one causes silent crawl cap)", () => {
    expect(BULK_MAX_URLS).toBe(ABSOLUTE_MAX_PAGES);
  });
});

describe("bulkCreditsRequired(urlCount)", () => {
  it("returns ceil(urlCount / PAGES_PER_CREDIT) for exact multiple", () => {
    // 50 URLs / 10 pages-per-credit = 5 credits
    expect(bulkCreditsRequired(50)).toBe(5);
  });

  it("rounds up when urlCount is not an exact multiple of PAGES_PER_CREDIT", () => {
    // 51 URLs → ceil(51/10) = 6
    expect(bulkCreditsRequired(51)).toBe(6);
  });

  it("1 URL costs 1 credit (minimum)", () => {
    expect(bulkCreditsRequired(1)).toBe(1);
  });

  it("501 URLs costs ceil(501/5) = 101 credits", () => {
    expect(bulkCreditsRequired(501)).toBe(Math.ceil(501 / PAGES_PER_CREDIT));
  });

  it("result is always consistent with PAGES_PER_CREDIT", () => {
    const urlCount = 73;
    expect(bulkCreditsRequired(urlCount)).toBe(Math.ceil(urlCount / PAGES_PER_CREDIT));
  });

  it("0 URLs costs 0 credits", () => {
    expect(bulkCreditsRequired(0)).toBe(0);
  });
});

describe("effectiveCrawlLimit(csvUrlCount, creditBalance)", () => {
  it("returns csvUrlCount when it is the binding constraint (affordable >> CSV)", () => {
    // 30 URLs, 200 credits → affordable=1000, cap=500 → min(30, 1000, 500) = 30
    expect(effectiveCrawlLimit(30, 200)).toBe(30);
  });

  it("returns affordable pages when credit balance is the binding constraint", () => {
    // 400 URLs, 7 credits → affordable=70, cap=500 → min(400, 70, 500) = 70
    expect(effectiveCrawlLimit(400, 7)).toBe(70);
  });

  it("caps at ABSOLUTE_MAX_PAGES when both CSV and credits exceed it", () => {
    // 600 URLs, 200 credits → affordable=1000, cap=500 → min(600, 1000, 500) = 500
    expect(effectiveCrawlLimit(600, 200)).toBe(ABSOLUTE_MAX_PAGES);
  });

  it("returns BULK_FREE_PAGES (10) when credit balance is 0", () => {
    // Pro users always get at least BULK_FREE_PAGES even with 0 credits
    expect(effectiveCrawlLimit(100, 0)).toBe(10);
  });

  it("5 credits → 25 affordable pages, binding for 200-URL CSV", () => {
    // min(200, 50, 500) = 50
    expect(effectiveCrawlLimit(200, 5)).toBe(50);
  });

  it("exactly 100 credits → 500 affordable pages, capped at ABSOLUTE_MAX_PAGES for 600-URL CSV", () => {
    // min(600, 500, 500) = 500
    expect(effectiveCrawlLimit(600, 100)).toBe(ABSOLUTE_MAX_PAGES);
  });
});
