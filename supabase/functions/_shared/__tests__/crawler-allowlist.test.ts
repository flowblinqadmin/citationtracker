// Unit tests for _shared/crawler-allowlist.ts.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isKnownAICrawler } from "../crawler-allowlist.ts";

const CRAWLER_UAS = [
  "Mozilla GPTBot/1.0",
  "Mozilla ClaudeBot/1.0",
  "Mozilla PerplexityBot/1.0",
  "Mozilla Googlebot/2.1",
  "Mozilla GoogleExtended/1.0",
  "Mozilla Bingbot/2.0",
  "Mozilla Applebot/0.1",
  "Mozilla cohere-ai/1.0",
  "Mozilla meta-externalagent/1.0",
  "Mozilla Bytespider/1.0",
  "Mozilla CCBot/2.0",
];

for (const ua of CRAWLER_UAS) {
  Deno.test(`crawler-allowlist: matches "${ua.slice(0, 40)}..."`, () => {
    assertEquals(isKnownAICrawler(ua), true);
  });
}

Deno.test("crawler-allowlist: rejects generic browser UA", () => {
  assertEquals(
    isKnownAICrawler(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    ),
    false,
  );
});

Deno.test("crawler-allowlist: rejects sqlmap (malicious — not an AI crawler)", () => {
  // ua-block.ts handles the 403; this helper just answers "is it an AI
  // crawler?". sqlmap is NOT an AI crawler, so this returns false.
  assertEquals(isKnownAICrawler("sqlmap/1.0"), false);
});

Deno.test("crawler-allowlist: case-insensitive match", () => {
  assertEquals(isKnownAICrawler("GPTBOT"), true);
  assertEquals(isKnownAICrawler("gptbot"), true);
});
