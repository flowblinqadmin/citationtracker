// Unit tests for _shared/cors.ts — CORS allowlist behavior.
//
// Behavior contract (matches geo/lib/cors.ts):
//   - Allowed origin (geo.flowblinq.com etc.) → echo origin + Allow-Credentials
//     true + Vary: Origin. Required for `fetch({ credentials: 'include' })`
//     from the marketing site.
//   - Any other origin → `*` with NO Allow-Credentials. Browser will reject
//     credentialed fetches, which is the desired CSRF defense.
//   - OPTIONS preflight uses the same header set.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { corsHeaders } from "../cors.ts";

function makeReq(origin: string | null): Request {
  const headers = new Headers();
  if (origin !== null) headers.set("origin", origin);
  return new Request("https://example.test", { headers });
}

Deno.test("cors: allowlist origin gets echoed + credentials + Vary", () => {
  const h = corsHeaders(makeReq("https://geo.flowblinq.com"));
  assertEquals(h["Access-Control-Allow-Origin"], "https://geo.flowblinq.com");
  assertEquals(h["Access-Control-Allow-Credentials"], "true");
  assertEquals(h["Vary"], "Origin");
});

Deno.test("cors: www.flowblinq.com is allowlisted", () => {
  const h = corsHeaders(makeReq("https://www.flowblinq.com"));
  assertEquals(h["Access-Control-Allow-Origin"], "https://www.flowblinq.com");
  assertEquals(h["Access-Control-Allow-Credentials"], "true");
});

Deno.test("cors: flowblinq.com (apex) is allowlisted", () => {
  const h = corsHeaders(makeReq("https://flowblinq.com"));
  assertEquals(h["Access-Control-Allow-Origin"], "https://flowblinq.com");
  assertEquals(h["Access-Control-Allow-Credentials"], "true");
});

Deno.test("cors: non-allowlist origin gets * and no credentials", () => {
  const h = corsHeaders(makeReq("https://evil.example.com"));
  assertEquals(h["Access-Control-Allow-Origin"], "*");
  assertEquals(h["Access-Control-Allow-Credentials"], undefined);
  assertEquals(h["Vary"], undefined);
});

Deno.test("cors: missing origin header gets * and no credentials", () => {
  const h = corsHeaders(makeReq(null));
  assertEquals(h["Access-Control-Allow-Origin"], "*");
  assertEquals(h["Access-Control-Allow-Credentials"], undefined);
});

Deno.test("cors: methods header reflects passed-in arg", () => {
  const h = corsHeaders(makeReq("https://geo.flowblinq.com"), "POST, OPTIONS");
  assertEquals(h["Access-Control-Allow-Methods"], "POST, OPTIONS");
});

Deno.test("cors: methods header defaults match Next.js port", () => {
  const h = corsHeaders(makeReq("https://geo.flowblinq.com"));
  assertEquals(h["Access-Control-Allow-Methods"], "GET, POST, OPTIONS");
});

Deno.test("cors: Allow-Headers always Content-Type, Max-Age 86400", () => {
  const h = corsHeaders(makeReq("https://geo.flowblinq.com"));
  assertEquals(h["Access-Control-Allow-Headers"], "Content-Type");
  assertEquals(h["Access-Control-Max-Age"], "86400");
});

Deno.test("cors: OPTIONS preflight uses same headers as actual request", () => {
  // The preflight is just a CORS check — same allowlist semantics apply.
  const req = new Request("https://example.test", {
    method: "OPTIONS",
    headers: { origin: "https://geo.flowblinq.com" },
  });
  const h = corsHeaders(req);
  assertEquals(h["Access-Control-Allow-Origin"], "https://geo.flowblinq.com");
  assertEquals(h["Access-Control-Allow-Credentials"], "true");
});

Deno.test("cors: source does not import NextRequest", async () => {
  const src = await Deno.readTextFile(new URL("../cors.ts", import.meta.url));
  // Strip comments — the documentation block legitimately mentions the type.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assertEquals(code.includes("NextRequest"), false);
  assertEquals(code.includes('from "next/server"'), false);
});
