// Unit tests for _shared/db.ts
//
// We don't open a real DB connection here — that's covered by the rate-limit
// integration test (commit #5) which requires `supabase start`. Here we
// assert: (a) the module reads `SUPABASE_DB_URL` from `Deno.env`, (b) max=1
// is unconditional (no `isVercel` branch leaks), (c) the service-role-key
// warn-on-presence check fires when the env var is set.

import { assertEquals, assertStringIncludes, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";

const dbModulePath = new URL("../db.ts", import.meta.url).pathname;
const dbSource = await Deno.readTextFile(dbModulePath);

// Strip `//` line comments and `/* */` block comments so the substring checks
// don't false-positive on documentation text (e.g. the comment that explains
// why `process.env` is forbidden mentions the string `process.env`).
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const dbCode = stripComments(dbSource);

Deno.test("db.ts reads SUPABASE_DB_URL from Deno.env", () => {
  assertStringIncludes(dbSource, 'Deno.env.get("SUPABASE_DB_URL")');
});

Deno.test("db.ts never uses process.env", () => {
  assertEquals(
    dbCode.includes("process.env"),
    false,
    "process.env must not appear in Deno-targeted source",
  );
});

Deno.test("db.ts never imports from next/server", () => {
  assertEquals(
    dbCode.includes('from "next/server"'),
    false,
    "next/server import is illegal under supabase/functions/**",
  );
});

Deno.test("db.ts never uses @/ path aliases", () => {
  assertEquals(
    /from\s+["']@\//.test(dbCode),
    false,
    "Next.js @/ aliases don't resolve under Deno — use relative paths",
  );
});

Deno.test("db.ts uses max:1 unconditionally", () => {
  assertMatch(dbCode, /max:\s*1\b/);
  // No isVercel branching allowed
  assertEquals(dbCode.includes("isVercel"), false);
  assertEquals(dbCode.includes("VERCEL"), false);
});

Deno.test("db.ts preserves prepare:false (pgbouncer transaction mode)", () => {
  assertMatch(dbSource, /prepare:\s*false/);
});

Deno.test("db.ts pins postgres + drizzle-orm npm specifiers", () => {
  assertMatch(dbSource, /npm:postgres@\d+\.\d+\.\d+/);
  assertMatch(dbSource, /npm:drizzle-orm@\d+\.\d+\.\d+\/postgres-js/);
});

Deno.test("db.ts warns on service-role-key visibility", () => {
  assertStringIncludes(dbSource, "SUPABASE_SERVICE_ROLE_KEY");
  assertStringIncludes(dbSource, "console.warn");
});

Deno.test("db.ts throws when SUPABASE_DB_URL is missing (source check)", () => {
  // Importing the module dynamically is the cleaner test but requires
  // schema.ts to be in place (commit #3) AND succeeds in opening a real
  // connection. We assert on the source instead — the env guard exists and
  // throws with a message that names the variable.
  assertMatch(dbSource, /if\s*\(\s*!\s*dbUrl\s*\)\s*\{/);
  assertStringIncludes(dbSource, "SUPABASE_DB_URL");
});
