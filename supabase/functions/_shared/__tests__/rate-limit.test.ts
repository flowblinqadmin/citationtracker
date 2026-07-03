// Integration tests for _shared/rate-limit.ts.
//
// Requires a running Supabase local stack with the `rate_limits` table
// already migrated. Set:
//   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
//
// Skips with a warning when SUPABASE_DB_URL is unset (e.g. CI without DB).

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const hasDb = !!Deno.env.get("SUPABASE_DB_URL");

// Static-source assertions — run even without DB so the substitution-table
// contract is enforced on every CI run.
const rateLimitModulePath = new URL("../rate-limit.ts", import.meta.url).pathname;
const rlSource = await Deno.readTextFile(rateLimitModulePath);
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const rlCode = stripComments(rlSource);

Deno.test("rate-limit.ts exports ONLY checkRateLimit", () => {
  // The Next.js port keeps OTP helpers; the Deno port must drop them so
  // the function bundle doesn't drag in geo_sites mutation paths it
  // doesn't need.
  const forbidden = [
    "checkOtpLock",
    "incrementOtpAttempt",
    "checkAndIncrementOtpAttempt",
    "clearOtpAttempts",
  ];
  for (const name of forbidden) {
    assertEquals(
      rlCode.includes(`export ${name === "checkRateLimit" ? "" : "function "}${name}`)
        || rlCode.includes(`export async function ${name}`),
      false,
      `OTP helper ${name} must NOT be exported from the beacon rate-limit port`,
    );
  }
});

Deno.test("rate-limit.ts never imports geoSites", () => {
  assertEquals(
    rlCode.includes("geoSites"),
    false,
    "geoSites is OTP-only; do not import from the rate-limit beacon port",
  );
});

Deno.test("rate-limit.ts uses Deno-compatible relative imports", () => {
  assertEquals(/from\s+["']@\//.test(rlCode), false);
  assertEquals(rlCode.includes('from "next/server"'), false);
});

Deno.test("rate-limit.ts atomic upsert pattern preserved", () => {
  assertEquals(rlCode.includes("onConflictDoUpdate"), true);
  assertEquals(rlCode.includes(".returning()"), true);
});

if (!hasDb) {
  console.warn(
    "[rate-limit.test] SUPABASE_DB_URL unset — skipping integration tests. Run `supabase start` and re-export.",
  );
} else {
  // Integration tests: each uses a unique key prefix so concurrent runs
  // don't collide with each other or with leftover state from the app.
  const testRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  Deno.test({
    name: "rate-limit: first hit allowed, returns remaining=limit-1",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const { checkRateLimit } = await import("../rate-limit.ts");
      const key = `_test_${testRunId}:first-hit`;
      const res = await checkRateLimit(key, 5, 60_000);
      assertEquals(res.allowed, true);
      assertEquals(res.remaining, 4);
    },
  });

  Deno.test({
    name: "rate-limit: blocks at limit+1, allowed=false, remaining=0",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const { checkRateLimit } = await import("../rate-limit.ts");
      const key = `_test_${testRunId}:exceeded`;
      // Hit the limit exactly
      for (let i = 0; i < 3; i++) {
        const r = await checkRateLimit(key, 3, 60_000);
        assertEquals(r.allowed, true);
      }
      // 4th hit must be blocked
      const blocked = await checkRateLimit(key, 3, 60_000);
      assertEquals(blocked.allowed, false);
      assertEquals(blocked.remaining, 0);
    },
  });

  Deno.test({
    name: "rate-limit: resets after window expires",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const { checkRateLimit } = await import("../rate-limit.ts");
      const key = `_test_${testRunId}:window-reset`;
      // Window of 100ms — fast for tests, atomic CASE in SQL still applies
      await checkRateLimit(key, 1, 100);
      const blocked = await checkRateLimit(key, 1, 100);
      assertEquals(blocked.allowed, false);

      // Wait past the window
      await new Promise((r) => setTimeout(r, 150));
      const reset = await checkRateLimit(key, 1, 100);
      assertEquals(reset.allowed, true);
      assertEquals(reset.remaining, 0); // count rolled back to 1, limit=1
    },
  });

  Deno.test({
    name: "rate-limit: namespaced keys do not collide (beacon: vs slug-serve:)",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const { checkRateLimit } = await import("../rate-limit.ts");
      const ip = `1.2.3.${Math.floor(Math.random() * 254)}_${testRunId}`;
      // Use up the beacon: namespace
      for (let i = 0; i < 3; i++) {
        await checkRateLimit(`beacon:${ip}`, 3, 60_000);
      }
      const beaconBlocked = await checkRateLimit(`beacon:${ip}`, 3, 60_000);
      assertEquals(beaconBlocked.allowed, false);
      // slug-serve: namespace must be independent
      const slugFirst = await checkRateLimit(`slug-serve:${ip}`, 3, 60_000);
      assertEquals(slugFirst.allowed, true);
      assertEquals(slugFirst.remaining, 2);
    },
  });

  Deno.test({
    name: "rate-limit: cleanup",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      // Best-effort cleanup of our test rows. We do this via postgres.js
      // directly because the helper has no delete export.
      const postgres = (await import("npm:postgres@3.4.9")).default;
      const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, {
        max: 1,
        prepare: false,
      });
      try {
        await sql`DELETE FROM rate_limits WHERE key LIKE ${`_test_${testRunId}%`}`;
        await sql`DELETE FROM rate_limits WHERE key LIKE ${`beacon:%${testRunId}`}`;
        await sql`DELETE FROM rate_limits WHERE key LIKE ${`slug-serve:%${testRunId}`}`;
      } finally {
        await sql.end();
      }
    },
  });
}
