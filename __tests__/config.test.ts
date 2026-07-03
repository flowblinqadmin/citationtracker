import { describe, it, expect } from "vitest";
import {
  FREE_MAX_PAGES,
  PAID_MAX_PAGES,
  SIGNUP_BONUS_CREDITS,
  CREDITS_PER_PACK,
  CREDITS_PRICE_CENTS,
  CREDITS_PRICE_USD,
  PAGES_PER_CREDIT,
  FREE_REGENERATIONS,
  bulkCreditsRequired,
} from "@/lib/config";

describe("lib/config.ts", () => {
  it("exports all constants with expected values", () => {
    expect(FREE_MAX_PAGES).toBe(20);
    expect(PAID_MAX_PAGES).toBe(100);
    expect(SIGNUP_BONUS_CREDITS).toBe(20);
    expect(CREDITS_PER_PACK).toBe(100);
    expect(CREDITS_PRICE_CENTS).toBe(1000);
    expect(CREDITS_PRICE_USD).toBe(10);
    expect(PAGES_PER_CREDIT).toBe(10);
    expect(FREE_REGENERATIONS).toBe(0);
  });

  it("bulkCreditsRequired rounds up to nearest credit (1 credit = 10 pages)", () => {
    expect(bulkCreditsRequired(10)).toBe(1);
    expect(bulkCreditsRequired(11)).toBe(2);
    expect(bulkCreditsRequired(20)).toBe(2);
    expect(bulkCreditsRequired(100)).toBe(10);
    expect(bulkCreditsRequired(1)).toBe(1);
    expect(bulkCreditsRequired(0)).toBe(0);
  });

  it("CREDITS_PRICE_CENTS equals CREDITS_PRICE_USD * 100", () => {
    expect(CREDITS_PRICE_CENTS).toBe(CREDITS_PRICE_USD * 100);
  });
});
