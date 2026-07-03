import { describe, it, expect } from "vitest";
import {
  SUBSCRIPTION_TIERS,
  UPFRONT_PRICES,
  STRIPE_PRICE_IDS,
  CRAWL_FREQUENCIES,
  ANNUAL_DISCOUNT,
  annualPrice,
  annualMonthlyPrice,
  TIER_SELLABLE,
  isSellable,
  nonSellablePriceIdSlots,
  CRAWL_FREQUENCY_RANK,
  isFrequencyAllowedForTier,
  clampFrequencyToTier,
  effectiveCrawlLimit,
  activeSubscriptionRemaining,
} from "@/lib/config";

describe("SUBSCRIPTION_TIERS — prices match website", () => {
  it("has correct monthly prices", () => {
    expect(SUBSCRIPTION_TIERS.starter.price).toBe(99);
    expect(SUBSCRIPTION_TIERS.growth.price).toBe(249);
    expect(SUBSCRIPTION_TIERS.pro.price).toBe(499);
  });
  it("has correct page limits", () => {
    expect(SUBSCRIPTION_TIERS.starter.pages).toBe(1000);
    expect(SUBSCRIPTION_TIERS.growth.pages).toBe(5000);
    expect(SUBSCRIPTION_TIERS.pro.pages).toBe(10000);
  });
  it("has maxAuditPages per tier", () => {
    expect(SUBSCRIPTION_TIERS.free.maxAuditPages).toBe(20);
    expect(SUBSCRIPTION_TIERS.starter.maxAuditPages).toBe(100);
    expect(SUBSCRIPTION_TIERS.growth.maxAuditPages).toBe(500);
    expect(SUBSCRIPTION_TIERS.pro.maxAuditPages).toBeNull();
  });
  it("has maxCompetitors per tier", () => {
    expect(SUBSCRIPTION_TIERS.free.maxCompetitors).toBe(3);
    expect(SUBSCRIPTION_TIERS.starter.maxCompetitors).toBe(5);
    expect(SUBSCRIPTION_TIERS.growth.maxCompetitors).toBe(10);
    expect(SUBSCRIPTION_TIERS.pro.maxCompetitors).toBe(20);
  });
  it("has correct crawl frequencies", () => {
    expect(SUBSCRIPTION_TIERS.starter.maxFrequency).toBe("weekly");
    expect(SUBSCRIPTION_TIERS.growth.maxFrequency).toBe("daily");
    expect(SUBSCRIPTION_TIERS.pro.maxFrequency).toBe("daily");
  });
  it("has exactly 4 tiers: free, starter, growth, pro", () => {
    const keys = Object.keys(SUBSCRIPTION_TIERS);
    expect(keys).toEqual(["free", "starter", "growth", "pro"]);
    expect(keys).toHaveLength(4);
  });
  it("free tier has price 0, 20 pages, maxFrequency manual", () => {
    expect(SUBSCRIPTION_TIERS.free.price).toBe(0);
    expect(SUBSCRIPTION_TIERS.free.pages).toBe(20);
    expect(SUBSCRIPTION_TIERS.free.maxFrequency).toBe("manual");
  });
});

describe("UPFRONT_PRICES — match website exactly", () => {
  it("starter has quarterly 267, no annual", () => {
    expect(UPFRONT_PRICES.starter.quarterly).toBe(267);
    expect(UPFRONT_PRICES.starter.annual).toBeNull();
  });
  it("growth has quarterly 672, no annual", () => {
    expect(UPFRONT_PRICES.growth.quarterly).toBe(672);
    expect(UPFRONT_PRICES.growth.annual).toBeNull();
  });
  it("pro has annual 4790, no quarterly", () => {
    expect(UPFRONT_PRICES.pro.annual).toBe(4790);
    expect(UPFRONT_PRICES.pro.quarterly).toBeNull();
  });
});

describe("STRIPE_PRICE_IDS — has quarterly key", () => {
  it("has quarterly interval", () => {
    expect(STRIPE_PRICE_IDS).toHaveProperty("quarterly");
  });
  it("quarterly has starter and growth keys", () => {
    expect(STRIPE_PRICE_IDS.quarterly).toHaveProperty("starter");
    expect(STRIPE_PRICE_IDS.quarterly).toHaveProperty("growth");
    expect(STRIPE_PRICE_IDS.quarterly).toHaveProperty("pro");
  });
  it("each interval maps starter, growth, pro (not free)", () => {
    for (const interval of ["monthly", "quarterly", "annual"] as const) {
      const keys = Object.keys(STRIPE_PRICE_IDS[interval]);
      expect(keys).toEqual(["starter", "growth", "pro"]);
      expect(keys).not.toContain("free");
    }
  });
});

describe("Annual pricing", () => {
  it("ANNUAL_DISCOUNT is 20%", () => {
    expect(ANNUAL_DISCOUNT).toBe(0.20);
  });

  it("annualPrice for pro uses UPFRONT_PRICES (4790)", () => {
    expect(annualPrice("pro")).toBe(4790);
  });

  it("annualPrice for starter/growth falls back to formula", () => {
    // starter: $99 * 12 * 0.8 = $950.40 → 950
    expect(annualPrice("starter")).toBe(950);
    // growth: $249 * 12 * 0.8 = $2390.40 → 2390
    expect(annualPrice("growth")).toBe(2390);
  });

  it("annualMonthlyPrice returns per-month equivalent", () => {
    // starter: round(950 / 12) = 79
    expect(annualMonthlyPrice("starter")).toBe(79);
    // growth: round(2390 / 12) = 199
    expect(annualMonthlyPrice("growth")).toBe(199);
    // pro: round(4790 / 12) = 399
    expect(annualMonthlyPrice("pro")).toBe(399);
  });
});

describe("CRAWL_FREQUENCIES", () => {
  it("is an ordered array of 4 frequencies", () => {
    expect(CRAWL_FREQUENCIES).toEqual(["manual", "daily", "weekly", "monthly"]);
    expect(CRAWL_FREQUENCIES).toHaveLength(4);
  });
});

describe("TIER_SELLABLE — single source of truth for purchasable intervals", () => {
  it("starter/growth sell monthly+quarterly; pro sells monthly+annual", () => {
    expect(TIER_SELLABLE.starter).toEqual(["monthly", "quarterly"]);
    expect(TIER_SELLABLE.growth).toEqual(["monthly", "quarterly"]);
    expect(TIER_SELLABLE.pro).toEqual(["monthly", "annual"]);
  });

  it("isSellable reflects TIER_SELLABLE membership", () => {
    expect(isSellable("starter", "annual")).toBe(false);
    expect(isSellable("starter", "quarterly")).toBe(true);
    expect(isSellable("pro", "quarterly")).toBe(false);
    expect(isSellable("pro", "annual")).toBe(true);
  });

  it("UPFRONT_PRICES availability is DERIVED from TIER_SELLABLE", () => {
    for (const tier of ["starter", "growth", "pro"] as const) {
      expect(UPFRONT_PRICES[tier].quarterly === null).toBe(!isSellable(tier, "quarterly"));
      expect(UPFRONT_PRICES[tier].annual === null).toBe(!isSellable(tier, "annual"));
    }
  });

  it("no configured Stripe price id points at a non-sellable interval (dead config)", () => {
    expect(nonSellablePriceIdSlots()).toEqual([]);
  });
});

describe("Per-tier sites cap (FIX-011)", () => {
  it("declares a sites cap of 1/5/10/20 for free/starter/growth/pro", () => {
    expect(SUBSCRIPTION_TIERS.free.sites).toBe(1);
    expect(SUBSCRIPTION_TIERS.starter.sites).toBe(5);
    expect(SUBSCRIPTION_TIERS.growth.sites).toBe(10);
    expect(SUBSCRIPTION_TIERS.pro.sites).toBe(20);
  });

  it("no longer carries the dead freeAllowances field", () => {
    expect("freeAllowances" in SUBSCRIPTION_TIERS.free).toBe(false);
    expect("freeAllowances" in SUBSCRIPTION_TIERS.pro).toBe(false);
  });
});

describe("Crawl-frequency tier ceiling (FIX-011, BUG-004 enforcement helpers)", () => {
  it("ranks frequencies by how often they run (manual < monthly < weekly < daily)", () => {
    expect(CRAWL_FREQUENCY_RANK.manual).toBeLessThan(CRAWL_FREQUENCY_RANK.monthly);
    expect(CRAWL_FREQUENCY_RANK.monthly).toBeLessThan(CRAWL_FREQUENCY_RANK.weekly);
    expect(CRAWL_FREQUENCY_RANK.weekly).toBeLessThan(CRAWL_FREQUENCY_RANK.daily);
  });

  it("isFrequencyAllowedForTier respects each tier's maxFrequency ceiling", () => {
    // starter ceiling = weekly: weekly allowed, daily denied
    expect(isFrequencyAllowedForTier("starter", "weekly")).toBe(true);
    expect(isFrequencyAllowedForTier("starter", "daily")).toBe(false);
    expect(isFrequencyAllowedForTier("starter", "monthly")).toBe(true);
    // pro ceiling = daily: daily allowed
    expect(isFrequencyAllowedForTier("pro", "daily")).toBe(true);
    // free ceiling = manual: anything above manual denied
    expect(isFrequencyAllowedForTier("free", "weekly")).toBe(false);
    expect(isFrequencyAllowedForTier("free", "manual")).toBe(true);
  });

  it("clampFrequencyToTier lowers an over-ceiling frequency to the tier max", () => {
    expect(clampFrequencyToTier("starter", "daily")).toBe("weekly");
    expect(clampFrequencyToTier("starter", "weekly")).toBe("weekly");
    expect(clampFrequencyToTier("pro", "daily")).toBe("daily");
    expect(clampFrequencyToTier("free", "daily")).toBe("manual");
  });
});

describe("activeSubscriptionRemaining (FIX-012)", () => {
  it("returns remaining allowance for an active paid subscriber", () => {
    expect(activeSubscriptionRemaining({
      monthlyPageAllowance: 10000, monthlyPagesUsed: 250,
      subscriptionTier: "pro", subscriptionStatus: "active",
    })).toBe(9750);
  });
  it("clamps to 0 when allowance is exhausted (no negative)", () => {
    expect(activeSubscriptionRemaining({
      monthlyPageAllowance: 1000, monthlyPagesUsed: 1200,
      subscriptionTier: "starter", subscriptionStatus: "active",
    })).toBe(0);
  });
  it("returns 0 for free tier or inactive subscription", () => {
    expect(activeSubscriptionRemaining({
      monthlyPageAllowance: 20, monthlyPagesUsed: 0,
      subscriptionTier: "free", subscriptionStatus: "inactive",
    })).toBe(0);
    expect(activeSubscriptionRemaining({
      monthlyPageAllowance: 10000, monthlyPagesUsed: 0,
      subscriptionTier: "pro", subscriptionStatus: "past_due",
    })).toBe(0);
  });
});

describe("effectiveCrawlLimit — subscription-aware bulk budget (FIX-012, BUG-001)", () => {
  it("BACKWARD-COMPATIBLE: no subscription arg keeps the legacy credit-only floor", () => {
    // 0 credits, no subscription => BULK_FREE_PAGES floor (10), capped by url count
    expect(effectiveCrawlLimit(255, 0)).toBe(10);
    // credits fund pages beyond the floor
    expect(effectiveCrawlLimit(255, 5)).toBe(50);
  });

  it("active subscriber with allowance and 0 credits funds the FULL re-audit (no 10-page floor)", () => {
    // The BUG-001 case: Pro subscriber, 255 URLs, 0 credits, ample allowance.
    expect(effectiveCrawlLimit(255, 0, {
      monthlyPageAllowance: 10000, monthlyPagesUsed: 0,
      subscriptionTier: "pro", subscriptionStatus: "active",
    })).toBe(255);
  });

  it("active subscriber: credits top up beyond the remaining allowance", () => {
    // remaining allowance = 30, 5 credits = 50 pages => 80 affordable, url count 100
    expect(effectiveCrawlLimit(100, 5, {
      monthlyPageAllowance: 100, monthlyPagesUsed: 70,
      subscriptionTier: "growth", subscriptionStatus: "active",
    })).toBe(80);
  });

  it("active subscriber with exhausted allowance and 0 credits resolves to 0 (denied — NO floor)", () => {
    expect(effectiveCrawlLimit(255, 0, {
      monthlyPageAllowance: 1000, monthlyPagesUsed: 1000,
      subscriptionTier: "starter", subscriptionStatus: "active",
    })).toBe(0);
  });

  it("inactive/free subscription falls back to the legacy credit-only floor", () => {
    expect(effectiveCrawlLimit(255, 0, {
      monthlyPageAllowance: 10000, monthlyPagesUsed: 0,
      subscriptionTier: "pro", subscriptionStatus: "canceled",
    })).toBe(10);
    expect(effectiveCrawlLimit(255, 0, {
      monthlyPageAllowance: 20, monthlyPagesUsed: 0,
      subscriptionTier: "free", subscriptionStatus: "inactive",
    })).toBe(10);
  });

  it("never exceeds ABSOLUTE_MAX_PAGES even with huge allowance", () => {
    expect(effectiveCrawlLimit(100000, 0, {
      monthlyPageAllowance: 1000000, monthlyPagesUsed: 0,
      subscriptionTier: "pro", subscriptionStatus: "active",
    })).toBe(500);
  });
});
