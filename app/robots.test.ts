import { describe, it, expect } from "vitest";
import robots from "./robots";

type RobotsRule = {
  userAgent?: string | string[];
  allow?: string | string[];
  disallow?: string | string[];
  crawlDelay?: number;
};

describe("robots() — structure", () => {
  it("returns an object", () => {
    const result = robots();
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
  });

  it("has a rules array with exactly 2 entries", () => {
    const { rules } = robots();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules).toHaveLength(2);
  });

  it("has the correct host", () => {
    const { host } = robots();
    expect(host).toBe("https://geo.flowblinq.com");
  });
});

describe("robots() — first rule (block all crawlers)", () => {
  it("applies to wildcard user-agent", () => {
    const rules = robots().rules as RobotsRule[];
    const first = rules[0];
    expect(first.userAgent).toBe("*");
  });

  it("disallows all paths with '/'", () => {
    const rules = robots().rules as RobotsRule[];
    const first = rules[0];
    expect(first.disallow).toBe("/");
  });

  it("does not have an allow directive", () => {
    const rules = robots().rules as RobotsRule[];
    const first = rules[0];
    expect(first.allow).toBeUndefined();
  });
});

describe("robots() — second rule (AI crawlers allowed on /api/serve/)", () => {
  it("userAgent is an array", () => {
    const rules = robots().rules as RobotsRule[];
    const second = rules[1];
    expect(Array.isArray(second.userAgent)).toBe(true);
  });

  it("includes GPTBot", () => {
    const rules = robots().rules as RobotsRule[];
    const second = rules[1];
    expect(second.userAgent).toContain("GPTBot");
  });

  it("includes ChatGPT-User", () => {
    const rules = robots().rules as RobotsRule[];
    const second = rules[1];
    expect(second.userAgent).toContain("ChatGPT-User");
  });

  it("includes ClaudeBot", () => {
    const rules = robots().rules as RobotsRule[];
    const second = rules[1];
    expect(second.userAgent).toContain("ClaudeBot");
  });

  it("includes PerplexityBot", () => {
    const rules = robots().rules as RobotsRule[];
    const second = rules[1];
    expect(second.userAgent).toContain("PerplexityBot");
  });

  it("includes OAI-SearchBot", () => {
    const rules = robots().rules as RobotsRule[];
    const second = rules[1];
    expect(second.userAgent).toContain("OAI-SearchBot");
  });

  it("includes Googlebot", () => {
    const rules = robots().rules as RobotsRule[];
    const second = rules[1];
    expect(second.userAgent).toContain("Googlebot");
  });

  it("includes Bingbot", () => {
    const rules = robots().rules as RobotsRule[];
    const second = rules[1];
    expect(second.userAgent).toContain("Bingbot");
  });

  it("includes DuckDuckBot", () => {
    const rules = robots().rules as RobotsRule[];
    const second = rules[1];
    expect(second.userAgent).toContain("DuckDuckBot");
  });

  it("allows /api/serve/ (the LLM content endpoint)", () => {
    const rules = robots().rules as RobotsRule[];
    const second = rules[1];
    expect(second.allow).toBe("/api/serve/");
  });

  it("disallows everything else with '/'", () => {
    const rules = robots().rules as RobotsRule[];
    const second = rules[1];
    expect(second.disallow).toBe("/");
  });
});

describe("robots() — determinism", () => {
  it("returns the same structure on each call", () => {
    const first = robots();
    const second = robots();
    expect(first).toEqual(second);
  });
});
