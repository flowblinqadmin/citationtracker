import { describe, it, expect, vi, beforeAll } from "vitest";

// Mock openai before importing content-generator (module-level OpenAI client)
vi.mock("openai", () => ({
  default: class MockOpenAI {
    constructor() {}
  },
}));

import { generateRobotsTxtBlock } from "@/lib/services/content-generator";

const GEO_PATHS = [
  "/llms.txt",
  "/llms-full.txt",
  "/.well-known/ucp.json",
  "/geo-schema.json",
  "/.well-known/openapi.yaml",
];

const AI_SEARCH_BOTS = [
  "GPTBot",
  "ClaudeBot",
  "PerplexityBot",
  "Google-Extended",
  "anthropic-ai",
  "ChatGPT-User",
  "cohere-ai",
  "Applebot",
  "YouBot",
  "Meta-ExternalAgent",
];

const SEARCH_ENGINE_BOTS = ["Bingbot", "Amazonbot"];

const SOCIAL_BOTS = [
  "Twitterbot",
  "facebookexternalhit",
  "LinkedInBot",
  "Slackbot",
];

describe("generateRobotsTxtBlock recommendations", () => {
  const block = generateRobotsTxtBlock("example.com");
  const directives = (block as any).instructions as string;

  describe("AI search bots are included", () => {
    for (const bot of AI_SEARCH_BOTS) {
      it(`includes User-agent: ${bot}`, () => {
        expect(directives).toContain(`User-agent: ${bot}`);
      });
    }
  });

  describe("Search engine bots are included", () => {
    for (const bot of SEARCH_ENGINE_BOTS) {
      it(`includes User-agent: ${bot}`, () => {
        expect(directives).toContain(`User-agent: ${bot}`);
      });
    }
  });

  describe("Social bots are included", () => {
    for (const bot of SOCIAL_BOTS) {
      it(`includes User-agent: ${bot}`, () => {
        expect(directives).toContain(`User-agent: ${bot}`);
      });
    }
  });

  describe("GEO asset paths are present", () => {
    for (const path of GEO_PATHS) {
      it(`includes Allow: ${path}`, () => {
        expect(directives).toContain(`Allow: ${path}`);
      });
    }
  });
});
