// Unit tests for _shared/bot-parser.ts.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseBotName } from "../bot-parser.ts";

const KNOWN_BOTS: Array<[string, string]> = [
  ["Mozilla/5.0 (compatible; GPTBot/1.0)", "GPTBot"],
  ["Mozilla/5.0 ChatGPT-User/1.0", "ChatGPT"],
  ["Mozilla/5.0 ClaudeBot/1.0", "ClaudeBot"],
  ["Mozilla/5.0 Claude-Web/1.0", "ClaudeBot"],
  ["Mozilla/5.0 PerplexityBot/1.0", "PerplexityBot"],
  ["Mozilla/5.0 GoogleExtended/1.0", "GoogleExtended"],
  ["Mozilla/5.0 Googlebot/2.1", "Googlebot"],
  ["Mozilla/5.0 Bingbot/2.0", "Bingbot"],
  ["cohere-ai/1.0", "CohereBot"],
  ["meta-externalagent/1.0", "MetaBot"],
  ["Applebot/0.1", "Applebot"],
  ["YouBot/1.0", "YouBot"],
  ["anthropic-ai/1.0", "AnthropicBot"],
  ["Omgili/0.5", "Omgili"],
  ["facebookexternalhit/1.1", "FacebookBot"],
  ["Twitterbot/1.0", "TwitterBot"],
  ["LinkedInBot/1.0", "LinkedInBot"],
];

for (const [ua, expected] of KNOWN_BOTS) {
  Deno.test(`bot-parser: ${expected} matches "${ua.slice(0, 40)}..."`, () => {
    assertEquals(parseBotName(ua), expected);
  });
}

Deno.test("bot-parser: null UA returns 'unknown'", () => {
  assertEquals(parseBotName(null), "unknown");
});

Deno.test("bot-parser: empty string returns 'unknown'", () => {
  assertEquals(parseBotName(""), "unknown");
});

Deno.test("bot-parser: generic visitor browser UA returns 'unknown'", () => {
  // Per current behavior — visitor UAs that don't match a bot pattern fall
  // through to "unknown". The handler decides how to relabel as "visitor".
  const visitor =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  assertEquals(parseBotName(visitor), "unknown");
});

Deno.test("bot-parser: case-insensitive match", () => {
  assertEquals(parseBotName("GPTBOT/1.0"), "GPTBot");
  assertEquals(parseBotName("gptbot/1.0"), "GPTBot");
});

Deno.test("bot-parser: first match wins (GPTBot before generic)", () => {
  // If a UA contains both GPTBot and Googlebot strings, GPTBot wins because
  // the pattern list ordering is preserved.
  assertEquals(
    parseBotName("Mozilla GPTBot/1.0 Googlebot/2.1"),
    "GPTBot",
  );
});
