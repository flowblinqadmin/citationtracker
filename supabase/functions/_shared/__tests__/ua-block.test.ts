// Unit tests for _shared/ua-block.ts.
//
// Middleware does not run for Supabase Edge Functions, so the malicious-UA
// regex list lives here and the handlers call it explicitly at entry.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isBlockedUA } from "../ua-block.ts";

const MUST_BLOCK = [
  "Mozilla/5.0 nikto/2.1.5",
  "sqlmap/1.6.5#stable",
  "Mozilla/5.0 nmap-scripts/7.93",
  "Mozilla acunetix-wvs/24",
  "wpscan/3.8.22",
  "Nessus Scanner",
  "Mozilla/5.0 (compatible; Nikto/2.1)",
  "SQLMAP (UPPER)",
  "x-acunetix-fake",
  "openvas-libraries/0.9",
  "burpsuite-collaborator/1.0",
  "metasploit-framework",
  "w3af.org",
  "havij-1.17",
  "joomscan/0.0.7",
  "AhrefsBot/7.0",
  "SemrushBot",
  "MJ12bot",
  "DotBot/1.1",
  "BLEXBot",
  "DataForSeoBot",
  "faviconhash-tool",
  "shodan.io",
];

for (const ua of MUST_BLOCK) {
  Deno.test(`ua-block: blocks "${ua.slice(0, 35)}..."`, () => {
    assertEquals(isBlockedUA(ua), true);
  });
}

Deno.test("ua-block: allows legit browser UA", () => {
  const chrome =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  assertEquals(isBlockedUA(chrome), false);
});

Deno.test("ua-block: allows legit AI crawler", () => {
  assertEquals(isBlockedUA("Mozilla/5.0 (compatible; GPTBot/1.0)"), false);
  assertEquals(isBlockedUA("ClaudeBot/1.0"), false);
});

Deno.test("ua-block: null or empty returns false (handler decides)", () => {
  assertEquals(isBlockedUA(null), false);
  assertEquals(isBlockedUA(""), false);
});

Deno.test("ua-block: case-insensitive match", () => {
  assertEquals(isBlockedUA("NIKTO"), true);
  assertEquals(isBlockedUA("Nikto"), true);
  assertEquals(isBlockedUA("nIkTo"), true);
});
