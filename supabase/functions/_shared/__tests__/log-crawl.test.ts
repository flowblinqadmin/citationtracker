// Source-level tests for _shared/log-crawl.ts.
// Behavior is exercised by the track-slug handler tests + the _verify
// integration harness.

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("../log-crawl.ts", import.meta.url));
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

Deno.test("log-crawl.ts does not import next/server", () => {
  assertEquals(code.includes('from "next/server"'), false);
});

Deno.test("log-crawl.ts does not use @/ aliases", () => {
  assertEquals(/from\s+["']@\//.test(code), false);
});

Deno.test("log-crawl.ts does not read cf-ipcountry / x-vercel-ip-* headers", () => {
  // Those headers don't exist on Supabase Edge. Caller (handler) must use
  // geo-enrich and pass the country through `LogCrawlInput.country`.
  assertEquals(code.includes("cf-ipcountry"), false);
  assertEquals(code.includes("x-vercel-ip-country"), false);
  assertEquals(code.includes("x-vercel-ip-city"), false);
  assertEquals(code.includes("x-vercel-ip-region-code"), false);
});

Deno.test("log-crawl.ts pins nanoid via npm: specifier", () => {
  assertStringIncludes(code, "npm:nanoid@");
});

Deno.test("log-crawl.ts preserves retry-once on cold pgbouncer connection", () => {
  // The original retry pattern: catch, regenerate id, insert once more.
  // Spot-check that retry path is still present.
  const insertCount = (code.match(/db\.insert\(geoCrawlLogs\)/g) ?? []).length;
  assertEquals(insertCount, 2, "expected two insert call sites (primary + retry)");
});

Deno.test("log-crawl.ts writes ipHash field on the log row", () => {
  assertStringIncludes(code, "ipHash:");
});

Deno.test("log-crawl.ts logs only via console.error on retry failure (no info-level PII)", () => {
  assertStringIncludes(code, "console.error");
  // No console.log or console.info with raw inputs
  assertEquals(code.includes("console.log"), false);
  assertEquals(code.includes("console.info"), false);
});

Deno.test("log-crawl.ts takes pathname via input arg, not req.nextUrl", () => {
  // The Next.js port reads `req.nextUrl.pathname`. nextUrl does NOT exist
  // on Web Request. The Deno port accepts pathname directly.
  assertEquals(code.includes("nextUrl"), false);
  assertStringIncludes(code, "input.pathname");
});
