import { describe, test, expect } from "vitest";
import { PRODUCT_KNOWLEDGE } from "../product-knowledge";

/**
 * Tests for the static PRODUCT_KNOWLEDGE string.
 * These act as a regression guard — if pricing, credit costs, or contact info
 * changes in code, these tests will catch stale content before it ships.
 */

describe("PRODUCT_KNOWLEDGE content", () => {
  // ── Basic sanity ────────────────────────────────────────────────────────────

  test("is a non-empty string", () => {
    expect(typeof PRODUCT_KNOWLEDGE).toBe("string");
    expect(PRODUCT_KNOWLEDGE.trim().length).toBeGreaterThan(0);
  });

  test("starts with the FlowBlinq GEO product heading", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("FlowBlinq GEO Product Knowledge");
  });

  // ── Pricing table ───────────────────────────────────────────────────────────

  test("mentions the Free plan at $0", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("$0");
  });

  test("mentions the Starter plan at $10/month", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("$10/month");
  });

  test("mentions the Growth plan at $20/month", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("$20/month");
  });

  test("mentions the Pro plan at $30/month", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("$30/month");
  });

  test("mentions the annual billing discount", () => {
    // 20% discount on annual billing
    expect(PRODUCT_KNOWLEDGE).toMatch(/20%.*discount|discount.*20%/i);
  });

  // ── Free tier limits ────────────────────────────────────────────────────────

  test("states free tier has a max of 2 free audits per email", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("2 free audits");
  });

  test("states free tier is limited to 20 pages", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("20 pages");
  });

  // ── Credit system ───────────────────────────────────────────────────────────

  test("states 1 credit = 5 pages", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("1 credit");
    expect(PRODUCT_KNOWLEDGE).toContain("5 pages");
  });

  test("states credit packs are 100 credits for $10", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("100 credits");
    expect(PRODUCT_KNOWLEDGE).toContain("$10");
  });

  test("states credits never expire", () => {
    expect(PRODUCT_KNOWLEDGE).toMatch(/credits never expire/i);
  });

  // ── Action costs ────────────────────────────────────────────────────────────

  test("states crawl/audit costs 1 credit per 5 pages", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("1 credit per 5 pages");
  });

  test("states citation check costs 5 credits", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("5 credits");
  });

  test("states competitor discovery costs 5 credits", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("Competitor discovery");
    expect(PRODUCT_KNOWLEDGE).toContain("5 credits");
  });

  test("states report download costs credits (paid feature)", () => {
    // Downloads are a paid feature (5 credits), not free
    expect(PRODUCT_KNOWLEDGE).toContain("Download ZIP report");
    expect(PRODUCT_KNOWLEDGE).toContain("Download PDF report");
  });

  test("states viewing results is free", () => {
    expect(PRODUCT_KNOWLEDGE).toMatch(/view.*free|free.*view/i);
  });

  // ── Contact email ───────────────────────────────────────────────────────────

  test("contains the support email hello@flowblinq.ai", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("hello@flowblinq.ai");
  });

  // ── Portal navigation ───────────────────────────────────────────────────────

  test("describes the 6 results page tabs", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("Overview");
    expect(PRODUCT_KNOWLEDGE).toContain("Scorecard");
    expect(PRODUCT_KNOWLEDGE).toContain("Recommendations");
    expect(PRODUCT_KNOWLEDGE).toContain("Pages");
    expect(PRODUCT_KNOWLEDGE).toContain("History");
    expect(PRODUCT_KNOWLEDGE).toContain("Setup");
  });

  test("mentions the dashboard path", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("/dashboard");
  });

  test("mentions the results page path", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("/sites/");
  });

  // ── Key features ────────────────────────────────────────────────────────────

  test("mentions llms.txt generated file", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("llms.txt");
  });

  test("mentions bulk CSV audit", () => {
    expect(PRODUCT_KNOWLEDGE).toMatch(/bulk.*csv|csv.*upload/i);
  });

  test("mentions Stripe for payments", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("Stripe");
  });

  test("describes how to buy credits via the dashboard", () => {
    expect(PRODUCT_KNOWLEDGE).toMatch(/buy credits|credit.*dashboard|dashboard.*credit/i);
  });

  // ── AI agents mentioned ─────────────────────────────────────────────────────

  test("mentions ChatGPT as a target AI agent", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("ChatGPT");
  });

  test("mentions Perplexity as a target AI agent", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("Perplexity");
  });

  test("mentions Gemini as a target AI agent", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("Gemini");
  });

  test("mentions Claude as a target AI agent", () => {
    expect(PRODUCT_KNOWLEDGE).toContain("Claude");
  });

  // ── Does not contain sensitive/internal info ────────────────────────────────

  test("does not contain any API keys or secrets", () => {
    // Paranoid check — product knowledge should never have keys
    expect(PRODUCT_KNOWLEDGE).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
    expect(PRODUCT_KNOWLEDGE).not.toMatch(/re_[a-zA-Z0-9]{20,}/);
  });
});
