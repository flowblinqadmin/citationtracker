/**
 * Regression test for the prod cron 500: `GET /api/cron/process-queue` threw
 * Postgres error 42P10 on EVERY tick (every ~5 min) since PR #192.
 *
 *   ERROR:  for SELECT DISTINCT, ORDER BY expressions must appear in select list
 *   code:   42P10
 *
 * Root cause: the pending-restart query did
 *   SELECT DISTINCT id, domain, team_id, crawl_limit
 *   FROM geo_sites INNER JOIN consent_records ...
 *   ORDER BY updated_at
 * but Postgres rejects SELECT DISTINCT when an ORDER BY column is not in the
 * projection. Fix (app/api/cron/process-queue/route.ts): add updated_at to the
 * selectDistinct projection.
 *
 * WHY THIS IS AN INTEGRATION TEST (not a unit test):
 * 42P10 is a server-side SQL *parse* error. It only surfaces when the query is
 * executed by a real Postgres. The existing unit suite
 * (__tests__/cron-process-queue.test.ts) MOCKS db.selectDistinct and returns
 * canned rows — it never builds or runs SQL, so it structurally cannot catch
 * this class of bug. That mock is exactly why the regression shipped. This test
 * runs the real query against a real Postgres.
 *
 * SAFETY: read-only. It only SELECTs — it never writes, so it is safe to point
 * at any environment (local Supabase :54322 or the prod pooler).
 *
 * Run (real DB required):
 *   DATABASE_URL=<postgres-url> \
 *     vitest run --config vitest.cron-it.config.ts tests/integration/cron
 */
import { describe, it, expect, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, asc, eq, isNotNull, lt } from "drizzle-orm";
import { geoSites, consentRecords } from "@/lib/db/schema";

const DB_URL =
  process.env.SUPABASE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL;

const sql = DB_URL ? postgres(DB_URL, { prepare: false }) : null;
const db = sql ? drizzle(sql) : null;

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

// Self-skip when no DB is wired (e.g. the default Docker Vitest suite, which has
// no Postgres). This keeps the file inert there while remaining a real guard in
// the integration tier.
const d = describe.skipIf(!db);

d("cron/process-queue — pending-restart query must not trip 42P10", () => {
  // Mirror of route.ts: same 15-min stale window, same WHERE predicate.
  const staleThreshold = new Date(Date.now() - 15 * 60 * 1000);

  it("RED reproduction: SELECT DISTINCT without updated_at in the projection throws 42P10", async () => {
    // This is the exact shape that shipped in PR #192 — projection omits
    // updatedAt while ORDER BY references it. Proves the failure mode is real.
    const broken = db!
      .selectDistinct({
        id: geoSites.id,
        domain: geoSites.domain,
        teamId: geoSites.teamId,
        crawlLimit: geoSites.crawlLimit,
        // updatedAt deliberately absent → 42P10
      })
      .from(geoSites)
      .innerJoin(consentRecords, eq(consentRecords.email, geoSites.ownerEmail))
      .where(
        and(
          eq(geoSites.pipelineStatus, "pending"),
          eq(geoSites.emailVerified, true),
          isNotNull(geoSites.teamId),
          lt(geoSites.updatedAt, staleThreshold),
        ),
      )
      .orderBy(asc(geoSites.updatedAt))
      .limit(100);

    // Drizzle wraps the driver error: the top-level message is "Failed query: …"
    // and the Postgres error (code 42P10 + the human text) is on `.cause`.
    await expect(broken).rejects.toMatchObject({
      cause: {
        code: "42P10",
        message: expect.stringContaining("ORDER BY expressions must appear in select list"),
      },
    });
  });

  it("GREEN guard: route's fixed projection (updated_at included) executes cleanly", async () => {
    // Byte-for-byte the query the route now builds (route.ts pendingSites).
    const fixed = await db!
      .selectDistinct({
        id: geoSites.id,
        domain: geoSites.domain,
        teamId: geoSites.teamId,
        crawlLimit: geoSites.crawlLimit,
        updatedAt: geoSites.updatedAt, // <-- the fix
      })
      .from(geoSites)
      .innerJoin(consentRecords, eq(consentRecords.email, geoSites.ownerEmail))
      .where(
        and(
          eq(geoSites.pipelineStatus, "pending"),
          eq(geoSites.emailVerified, true),
          isNotNull(geoSites.teamId),
          lt(geoSites.updatedAt, staleThreshold),
        ),
      )
      .orderBy(asc(geoSites.updatedAt))
      .limit(100);

    // No throw = fixed. Rows may be empty; that's fine — we're asserting the
    // query is *accepted* by Postgres, not that data exists.
    expect(Array.isArray(fixed)).toBe(true);
  });
});
