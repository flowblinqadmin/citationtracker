import { describe, it, expect } from "vitest";
import { resolveCrawlBudget } from "@/lib/services/page-accounting";

/**
 * Tests for subscription-aware page budget resolution.
 * The sites route uses resolveCrawlBudget to determine how many pages
 * can be crawled based on subscription allowance + credit balance.
 */
describe("resolveCrawlBudget — subscription integration", () => {
  it("allows full crawl within subscription allowance", () => {
    const budget = resolveCrawlBudget(
      { monthlyPageAllowance: 500, monthlyPagesUsed: 100, creditBalance: 0 },
      100,
    );
    expect(budget.denied).toBe(false);
    expect(budget.subscriptionPages).toBe(100);
    expect(budget.creditPages).toBe(0);
    expect(budget.creditsRequired).toBe(0);
  });

  it("uses credits for overflow when subscription exhausted", () => {
    const budget = resolveCrawlBudget(
      { monthlyPageAllowance: 500, monthlyPagesUsed: 480, creditBalance: 20 },
      100,
    );
    expect(budget.denied).toBe(false);
    expect(budget.subscriptionPages).toBe(20); // only 20 remaining
    expect(budget.creditPages).toBe(80); // overflow
    expect(budget.creditsRequired).toBe(8); // ceil(80 / 10) = 8 credits
  });

  it("denies when both subscription and credits exhausted", () => {
    const budget = resolveCrawlBudget(
      { monthlyPageAllowance: 500, monthlyPagesUsed: 500, creditBalance: 0 },
      100,
    );
    expect(budget.denied).toBe(true);
    expect(budget.subscriptionPages).toBe(0);
  });

  it("denies when credits insufficient for overflow", () => {
    const budget = resolveCrawlBudget(
      { monthlyPageAllowance: 500, monthlyPagesUsed: 500, creditBalance: 5 },
      100,
    );
    // 5 credits = 50 pages, but 100 requested overflow = 10 credits needed
    expect(budget.denied).toBe(true);
  });

  it("handles free tier (20 page allowance)", () => {
    const budget = resolveCrawlBudget(
      { monthlyPageAllowance: 20, monthlyPagesUsed: 0, creditBalance: 0 },
      20,
    );
    expect(budget.denied).toBe(false);
    expect(budget.subscriptionPages).toBe(20);
    expect(budget.creditPages).toBe(0);
  });

  it("free tier denied when allowance used up and no credits", () => {
    const budget = resolveCrawlBudget(
      { monthlyPageAllowance: 20, monthlyPagesUsed: 20, creditBalance: 0 },
      20,
    );
    expect(budget.denied).toBe(true);
  });

  it("zero requested pages always succeeds", () => {
    const budget = resolveCrawlBudget(
      { monthlyPageAllowance: 0, monthlyPagesUsed: 0, creditBalance: 0 },
      0,
    );
    expect(budget.denied).toBe(false);
    expect(budget.subscriptionPages).toBe(0);
    expect(budget.creditPages).toBe(0);
  });

  it("large request partially covered by subscription, rest by credits", () => {
    // Pro tier: 3000 pages, 1000 used, 100 credits
    const budget = resolveCrawlBudget(
      { monthlyPageAllowance: 3000, monthlyPagesUsed: 2900, creditBalance: 100 },
      200,
    );
    expect(budget.denied).toBe(false);
    expect(budget.subscriptionPages).toBe(100); // 3000 - 2900
    expect(budget.creditPages).toBe(100); // overflow
    expect(budget.creditsRequired).toBe(10); // ceil(100 / 10)
  });

  it("exactly at limit succeeds", () => {
    const budget = resolveCrawlBudget(
      { monthlyPageAllowance: 500, monthlyPagesUsed: 400, creditBalance: 0 },
      100,
    );
    expect(budget.denied).toBe(false);
    expect(budget.subscriptionPages).toBe(100);
    expect(budget.creditPages).toBe(0);
  });
});
