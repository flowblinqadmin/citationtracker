// Source-level tests for _shared/serve-lookup.ts.
// Behavior is exercised by the integration harness in _verify/ once
// `supabase functions serve` is running.

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("../serve-lookup.ts", import.meta.url));
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

Deno.test("serve-lookup.ts uses relative imports only", () => {
  assertEquals(/from\s+["']@\//.test(code), false);
  assertEquals(code.includes('from "next/server"'), false);
});

Deno.test("serve-lookup.ts pins drizzle-orm via npm: specifier", () => {
  assertStringIncludes(code, "npm:drizzle-orm@");
});

Deno.test("serve-lookup.ts exports resolveSiteForServing", () => {
  assertStringIncludes(code, "export async function resolveSiteForServing");
});

Deno.test("serve-lookup.ts preserves escapeLike helper (LIKE injection defense)", () => {
  assertStringIncludes(code, "escapeLike");
  // Must escape both % and _ wildcards
  assertStringIncludes(code, '"\\\\%"');
  assertStringIncludes(code, '"\\\\_"');
});

Deno.test("serve-lookup.ts preserves 4-step fallback (exact → domain-latest → prefix → exact)", () => {
  // Spot-check the markers — every fallback step exists in the ported source
  assertStringIncludes(code, ".limit(1)");
  assertStringIncludes(code, 'pipelineStatus, "complete"');
  assertStringIncludes(code, "like(geoSites.slug");
});
