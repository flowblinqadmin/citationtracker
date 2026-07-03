import { describe, it, expect } from "vitest";
import { resolveCrawlBudget } from "@/lib/services/page-accounting";

describe("resolveCrawlBudget", () => {
  it("uses subscription allowance first when budget is available", () => {
    const team = { monthlyPageAllowance: 500, monthlyPagesUsed: 0, creditBalance: 100 };
    const result = resolveCrawlBudget(team, 100);
    expect(result).toEqual({
      subscriptionPages: 100,
      creditPages: 0,
      creditsRequired: 0,
      creditsToDeduct: 0,
      denied: false,
    });
  });

  it("uses subscription first, then credits for overflow", () => {
    // Free tier with 20 pages remaining, 30 requested
    const team = { monthlyPageAllowance: 20, monthlyPagesUsed: 0, creditBalance: 10 };
    const result = resolveCrawlBudget(team, 30);
    expect(result).toEqual({
      subscriptionPages: 20,
      creditPages: 10,
      creditsRequired: 1, // 10 overflow pages / 10 pages per credit = 1 credit
      creditsToDeduct: 1,
      denied: false,
    });
  });

  it("starter with 500 remaining + 100 requested uses all from subscription", () => {
    const team = { monthlyPageAllowance: 500, monthlyPagesUsed: 0, creditBalance: 0 };
    const result = resolveCrawlBudget(team, 100);
    expect(result).toEqual({
      subscriptionPages: 100,
      creditPages: 0,
      creditsRequired: 0,
      creditsToDeduct: 0,
      denied: false,
    });
  });

  it("uses only credits when no subscription pages remain", () => {
    const team = { monthlyPageAllowance: 20, monthlyPagesUsed: 20, creditBalance: 10 };
    const result = resolveCrawlBudget(team, 25);
    expect(result).toEqual({
      subscriptionPages: 0,
      creditPages: 25,
      creditsRequired: 3, // ceil(25 / 10) = 3
      creditsToDeduct: 3,
      denied: false,
    });
  });

  it("denies when neither subscription nor credits available", () => {
    const team = { monthlyPageAllowance: 20, monthlyPagesUsed: 20, creditBalance: 0 };
    const result = resolveCrawlBudget(team, 10);
    expect(result).toEqual({
      subscriptionPages: 0,
      creditPages: 0,
      creditsRequired: 1, // ceil(10 / 10) = 1, but only 0 available
      creditsToDeduct: 0,
      denied: true,
    });
  });

  it("handles requestedPages = 0", () => {
    const team = { monthlyPageAllowance: 20, monthlyPagesUsed: 0, creditBalance: 100 };
    const result = resolveCrawlBudget(team, 0);
    expect(result).toEqual({
      subscriptionPages: 0,
      creditPages: 0,
      creditsRequired: 0,
      creditsToDeduct: 0,
      denied: false,
    });
  });

  it("rounds up credits for partial page overflow (1 credit = 10 pages)", () => {
    // 3 overflow pages should require 1 credit (ceil(3/10) = 1)
    const team = { monthlyPageAllowance: 20, monthlyPagesUsed: 17, creditBalance: 5 };
    const result = resolveCrawlBudget(team, 6);
    expect(result).toEqual({
      subscriptionPages: 3,
      creditPages: 3,
      creditsRequired: 1, // ceil(3/5) = 1
      creditsToDeduct: 1,
      denied: false,
    });
  });

  it("denies when credits are insufficient for overflow", () => {
    const team = { monthlyPageAllowance: 20, monthlyPagesUsed: 20, creditBalance: 1 };
    const result = resolveCrawlBudget(team, 25);
    // Need 3 credits (ceil(25/10)) but only have 1
    expect(result.denied).toBe(true);
    expect(result.creditsRequired).toBe(3);
    expect(result.creditsToDeduct).toBe(1);
  });
});

// ── ES-B7 — resolveFirstAuditMaxPages ───────────────────────────────────────
import { resolveFirstAuditMaxPages } from "@/lib/services/page-accounting";

describe("resolveFirstAuditMaxPages (ES-B7)", () => {
  it("U-B7-1: free tier, no credits → denied (maxPages=0)", () => {
    const r = resolveFirstAuditMaxPages({
      subscriptionTier: "free",
      subscriptionStatus: "inactive",
      monthlyPageAllowance: 0,
      monthlyPagesUsed: 0,
      creditBalance: 0,
    });
    expect(r).toEqual({
      maxPages: 0,
      subscriptionPages: 0,
      creditsToReserve: 0,
      source: "denied",
      denied: true,
    });
  });

  it("U-B7-2: credit-only 'Pro' (free tier with 15 credits) → 100 (regression case)", () => {
    const r = resolveFirstAuditMaxPages({
      subscriptionTier: "free",
      subscriptionStatus: "inactive",
      monthlyPageAllowance: 0,
      monthlyPagesUsed: 0,
      creditBalance: 15,
    });
    expect(r.maxPages).toBe(100);
    expect(r.source).toBe("credits");
    expect(r.creditsToReserve).toBe(10); // ceil(100/10)
  });

  it("U-B7-3: credit-only edge (balance=3) → maxPages=30", () => {
    const r = resolveFirstAuditMaxPages({
      subscriptionTier: "free",
      subscriptionStatus: "inactive",
      monthlyPageAllowance: 0,
      monthlyPagesUsed: 0,
      creditBalance: 3,
    });
    expect(r.maxPages).toBe(30);
    expect(r.creditsToReserve).toBe(3);
    expect(r.source).toBe("credits");
  });

  it("U-B7-4: Pro subscriber w/ headroom → full remaining (pro tier is uncapped per-audit)", () => {
    const r = resolveFirstAuditMaxPages({
      subscriptionTier: "pro",
      subscriptionStatus: "active",
      monthlyPageAllowance: 10000,
      monthlyPagesUsed: 500,
      creditBalance: 20,
    });
    // pro.maxAuditPages = null → bounded only by remaining allowance (9500).
    expect(r.maxPages).toBe(9500);
    expect(r.source).toBe("subscription");
    expect(r.subscriptionPages).toBe(9500);
    expect(r.creditsToReserve).toBe(0);
  });

  it("U-B7-4b: Growth subscriber w/ ample headroom → 500 (growth tier cap)", () => {
    const r = resolveFirstAuditMaxPages({
      subscriptionTier: "growth",
      subscriptionStatus: "active",
      monthlyPageAllowance: 5000,
      monthlyPagesUsed: 0,
      creditBalance: 0,
    });
    // growth.maxAuditPages = 500 → min(5000, 500).
    expect(r.maxPages).toBe(500);
    expect(r.source).toBe("subscription");
    expect(r.subscriptionPages).toBe(500);
  });

  it("U-B7-5: Pro subscriber, allowance exhausted, has credits → tier-capped credits (NOT PAID_MAX_PAGES=100)", () => {
    const r = resolveFirstAuditMaxPages({
      subscriptionTier: "pro",
      subscriptionStatus: "active",
      monthlyPageAllowance: 10000,
      monthlyPagesUsed: 10000,
      creditBalance: 20,
    });
    // BUG-001/003 fix: an active Pro funded from credits is bounded by the Pro
    // per-audit ceiling (maxAuditPages=null -> ABSOLUTE_MAX_PAGES=500), not 100.
    // 20 credits x 10 = 200 pages < 500, so maxPages = 200.
    expect(r.maxPages).toBe(200);
    expect(r.maxPages).toBeGreaterThan(100);
    expect(r.source).toBe("credits");
    expect(r.creditsToReserve).toBe(20); // ceil(200/10)
  });

  it("U-B7-6: Pro subscriber, allowance exhausted, no credits → denied", () => {
    const r = resolveFirstAuditMaxPages({
      subscriptionTier: "pro",
      subscriptionStatus: "active",
      monthlyPageAllowance: 10000,
      monthlyPagesUsed: 10000,
      creditBalance: 0,
    });
    expect(r.denied).toBe(true);
    expect(r.maxPages).toBe(0);
  });

  it("U-B7-7: Starter subscriber w/ headroom → 100 (PAID_MAX_PAGES cap, NOT 1000)", () => {
    const r = resolveFirstAuditMaxPages({
      subscriptionTier: "starter",
      subscriptionStatus: "active",
      monthlyPageAllowance: 1000,
      monthlyPagesUsed: 0,
      creditBalance: 0,
    });
    expect(r.maxPages).toBe(100);
    expect(r.source).toBe("subscription");
    expect(r.subscriptionPages).toBe(100);
  });

  it("U-B7-8: Growth subscriber, allowance=5000, used=4900 → maxPages=100 (min(remaining, cap))", () => {
    const r = resolveFirstAuditMaxPages({
      subscriptionTier: "growth",
      subscriptionStatus: "active",
      monthlyPageAllowance: 5000,
      monthlyPagesUsed: 4900,
      creditBalance: 0,
    });
    expect(r.maxPages).toBe(100);
    expect(r.source).toBe("subscription");
  });

  it("Growth with only 30 pages remaining → maxPages=30 (subscription bound by remaining)", () => {
    const r = resolveFirstAuditMaxPages({
      subscriptionTier: "growth",
      subscriptionStatus: "active",
      monthlyPageAllowance: 5000,
      monthlyPagesUsed: 4970,
      creditBalance: 0,
    });
    expect(r.maxPages).toBe(30);
    expect(r.subscriptionPages).toBe(30);
  });

  it("credit-pool signup: active Starter with allowance=0 draws from credits (100 pages = 10 credits)", () => {
    // Payment-first subscription signup grants creditBalance=tier.credits and
    // monthlyPageAllowance=0 so audits deduct from the credit pool.
    const r = resolveFirstAuditMaxPages({
      subscriptionTier: "starter",
      subscriptionStatus: "active",
      monthlyPageAllowance: 0,
      monthlyPagesUsed: 0,
      creditBalance: 1500,
    });
    expect(r.maxPages).toBe(100);
    expect(r.source).toBe("credits");
    expect(r.subscriptionPages).toBe(0);
    expect(r.creditsToReserve).toBe(10);
    expect(r.denied).toBe(false);
  });

  it("FIX-008 fitness: credit-pool active Pro (allowance=0, full credit pool) -> 500 (ABSOLUTE_MAX_PAGES), NOT 100", () => {
    // Production signup model: creditBalance=tier.credits (Pro=30000),
    // monthlyPageAllowance=0. Pre-fix this resolved to PAID_MAX_PAGES=100 — the
    // literal Pro under-delivery. Pro maxAuditPages=null -> ABSOLUTE_MAX_PAGES=500.
    const r = resolveFirstAuditMaxPages({
      subscriptionTier: "pro",
      subscriptionStatus: "active",
      monthlyPageAllowance: 0,
      monthlyPagesUsed: 0,
      creditBalance: 30000,
    });
    expect(r.maxPages).toBe(500);
    expect(r.maxPages).toBeGreaterThan(100);
    expect(r.source).toBe("credits");
    expect(r.denied).toBe(false);
  });

  it("FIX-008: credit-pool active Growth (allowance=0) -> 500 (growth maxAuditPages cap)", () => {
    const r = resolveFirstAuditMaxPages({
      subscriptionTier: "growth",
      subscriptionStatus: "active",
      monthlyPageAllowance: 0,
      monthlyPagesUsed: 0,
      creditBalance: 7500,
    });
    expect(r.maxPages).toBe(500);
    expect(r.maxPages).toBeGreaterThan(100);
    expect(r.source).toBe("credits");
  });

  it("FIX-008: free tier carrying active status -> provisioning contradiction -> denied", () => {
    const r = resolveFirstAuditMaxPages({
      subscriptionTier: "free",
      subscriptionStatus: "active",
      monthlyPageAllowance: 0,
      monthlyPagesUsed: 0,
      creditBalance: 30000,
    });
    expect(r.denied).toBe(true);
    expect(r.maxPages).toBe(0);
    expect(r.source).toBe("denied");
  });

  it("FIX-008: unknown tier string + active status -> denied (no PAID_MAX_PAGES masking of a real tier)", () => {
    const r = resolveFirstAuditMaxPages({
      subscriptionTier: "platinum",
      subscriptionStatus: "active",
      monthlyPageAllowance: 0,
      monthlyPagesUsed: 0,
      creditBalance: 30000,
    });
    expect(r.denied).toBe(true);
    expect(r.maxPages).toBe(0);
  });

  it("AC-B7-1 grep: helper symbol referenced in both /api/sites/route.ts and /regenerate/route.ts", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const sitesRoute = fs.readFileSync(path.resolve(process.cwd(), "app/api/sites/route.ts"), "utf8");
    const regen = fs.readFileSync(path.resolve(process.cwd(), "app/api/sites/[id]/regenerate/route.ts"), "utf8");
    expect(sitesRoute).toMatch(/resolveFirstAuditMaxPages/);
    expect(regen).toMatch(/resolveFirstAuditMaxPages/);
  });
});
