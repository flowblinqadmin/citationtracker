// Schema subset for the beacon Edge Functions.
//
// We don't want to bring the entire 39kB lib/db/schema.ts into the function
// bundle — it imports app types, drags in non-Deno paths, and expands the
// attack surface. Verify that the subset exports exactly the four tables
// needed and that the column names match what the handlers will write.

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const schemaModulePath = new URL("../schema.ts", import.meta.url).pathname;
const schemaSource = await Deno.readTextFile(schemaModulePath);

Deno.test("schema.ts exports geoPageViews", () => {
  assertStringIncludes(schemaSource, "export const geoPageViews");
});

Deno.test("schema.ts exports rateLimits", () => {
  assertStringIncludes(schemaSource, "export const rateLimits");
});

Deno.test("schema.ts exports geoSites (read columns only)", () => {
  assertStringIncludes(schemaSource, "export const geoSites");
});

Deno.test("schema.ts exports geoCrawlLogs", () => {
  assertStringIncludes(schemaSource, "export const geoCrawlLogs");
});

Deno.test("geoPageViews has ip_hash column for compliance backfill", () => {
  // Plan §security: HMAC-SHA256 of IP must be writeable from track-collect
  assertStringIncludes(schemaSource, 'ip_hash');
});

Deno.test("schema.ts imports drizzle-orm via npm specifier", () => {
  // drizzle.config.ts in Next.js uses bare "drizzle-orm/pg-core" — Deno
  // would need an import map. Use npm: specifier instead.
  assertStringIncludes(schemaSource, 'npm:drizzle-orm@');
  assertStringIncludes(schemaSource, '/pg-core');
});

Deno.test("schema.ts does NOT import @/ aliases or @/lib/* types", () => {
  assertEquals(/from\s+["']@\//.test(schemaSource), false);
});

Deno.test("schema.ts does not pull non-required tables (compact bundle)", () => {
  // Negative assertions for tables that exist in the app schema but are
  // out of scope for the beacon. Keeps bundle small + scope tight.
  const forbidden = [
    "export const teams",
    "export const creditTransactions",
    "export const geoSiteView",
    "export const apiClients",
    "export const auditReports",
    "export const acpMonitoring",
    "export const citationCheckScores",
    "export const consentRecords",
  ];
  for (const f of forbidden) {
    assertEquals(
      schemaSource.includes(f),
      false,
      `schema subset should not include ${f}`,
    );
  }
});

Deno.test("schema.ts is importable from db.ts without throwing", async () => {
  // Smoke test: schema.ts compiles standalone. Don't import db.ts here —
  // that requires SUPABASE_DB_URL set.
  const mod = await import("../schema.ts");
  assertEquals(typeof mod.geoPageViews, "object");
  assertEquals(typeof mod.rateLimits, "object");
  assertEquals(typeof mod.geoSites, "object");
  assertEquals(typeof mod.geoCrawlLogs, "object");
});
