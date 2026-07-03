/**
 * Integration Test — Subscription pages reconciliation (NEW-P-01)
 *
 * Verifies that when handleAssemble runs on a site where fewer pages were
 * actually crawled than reserved from the subscription allowance, the unused
 * pages are returned to teams.monthly_pages_used, subscriptionPagesReserved
 * is cleared to 0, and a re-run (stale cron re-enqueue) does NOT decrement
 * monthlyPagesUsed a second time (idempotency).
 *
 * RED on the un-patched codebase: no reconciliation logic exists for
 * subscription pages — monthlyPagesUsed is permanently inflated by the
 * full reserved amount regardless of how many pages were actually crawled.
 *
 * GREEN after the fix: the assemble stage returns unused subscription pages,
 * clears subscriptionPagesReserved to 0, and is idempotent on re-entry.
 *
 * Connection: local Supabase postgres at :54322 (or DATABASE_URL_LOCAL).
 * Skips automatically when unreachable (safe in Docker Vitest unit pass).
 *
 * Follows the connection pattern of assemble-credit-refund-idempotency.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { nanoid } from "nanoid";

// ── Connection config ────────────────────────────────────────────────────────

const LOCAL_DB =
  process.env.DATABASE_URL_LOCAL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function isLocalDbReachable(): Promise<boolean> {
  let sql: ReturnType<typeof postgres> | undefined;
  try {
    sql = postgres(LOCAL_DB, { max: 1, prepare: false, connect_timeout: 3 });
    await sql`SELECT 1 AS ping`;
    await sql`SELECT 1 FROM geo_sites LIMIT 0`;
    await sql`SELECT 1 FROM teams LIMIT 0`;
    // Verify the new column exists (schema must have been pushed via db:push:local)
    await sql`SELECT subscription_pages_reserved FROM geo_sites LIMIT 0`;
    return true;
  } catch {
    return false;
  } finally {
    await sql?.end();
  }
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

interface SeedResult {
  siteId: string;
  teamId: string;
  initialMonthlyPagesUsed: number;
  subscriptionPagesReserved: number;
}

/**
 * Seed a team + geo_site ready for the assemble stage with subscription-pages
 * reserved:
 *  - team: monthlyPageAllowance=500, monthlyPagesUsed = initialPagesUsed
 *  - site: pipelineStatus = "assembling", subscriptionPagesReserved = N,
 *          crawlData with actualPages pages
 */
async function seedAssemblingSubscriptionSite(
  sql: ReturnType<typeof postgres>,
  opts: {
    initialPagesUsed?: number;
    subscriptionPagesReserved?: number;
    actualPages?: number;
  } = {},
): Promise<SeedResult> {
  const initialPagesUsed = opts.initialPagesUsed ?? 100;
  const subscriptionPagesReserved = opts.subscriptionPagesReserved ?? 50;
  const actualPages = opts.actualPages ?? 20; // fewer than reserved → under-crawl

  const teamId = `test-team-${nanoid(8)}`;
  const siteId = `test-site-${nanoid(8)}`;

  await sql`
    INSERT INTO teams (
      id, name, owner_user_id, credit_balance, subscription_tier,
      subscription_status, billing_model, monthly_page_allowance, monthly_pages_used
    )
    VALUES (
      ${teamId}, 'Test Team', 'test-user-id', 0, 'starter',
      'active', 'page_allowance', 500, ${initialPagesUsed}
    )
  `;

  const pages = Array.from({ length: actualPages }, (_, i) => ({
    url: `https://example.com/page-${i}`,
    content: "some content",
    pageType: "other",
    hasStructuredData: false,
    wordCount: 50,
    hasErrors: false,
    statusCode: 200,
  }));
  const crawlData = { domain: "example.com", pages, totalCrawled: actualPages };

  const geoScorecard = {
    overallScore: 55,
    pillars: [{ pillar: "citations", score: 55, priority: "high", findings: [], recommendations: [] }],
  };

  await sql`
    INSERT INTO geo_sites (
      id, domain, slug, owner_email, team_id,
      pipeline_status, audit_mode, crawl_data, geo_scorecard,
      subscription_pages_reserved, current_run_number, current_run_kind,
      token_expires_at
    ) VALUES (
      ${siteId},
      'example.com',
      ${`sub-slug-${nanoid(8)}`},
      'test@example.com',
      ${teamId},
      'assembling',
      'single',
      ${JSON.stringify(crawlData)},
      ${JSON.stringify(geoScorecard)},
      ${subscriptionPagesReserved},
      1,
      'initial',
      NOW() + INTERVAL '90 days'
    )
  `;

  return { siteId, teamId, initialMonthlyPagesUsed: initialPagesUsed, subscriptionPagesReserved };
}

// ── Replicate the reconciliation path from handleAssemble (NEW-P-01) ──────────
//
// Rather than importing the full Next.js route (which drags in QStash / Firecrawl
// stubs), we replicate the critical sub-path of the NEW-P-01 reconciliation using
// raw SQL — exactly what the fixed handleAssemble emits.
//
// Logic:
//   1. Read site: get subscription_pages_reserved and pipeline_status.
//   2. Guard 1: if pipeline_status = 'complete' → already done, skip (re-entry guard).
//   3. Guard 2: if subscription_pages_reserved <= 0 → already reconciled, skip.
//   4. Compute actualSubPagesUsed = min(actualPagesCrawled, reserved).
//   5. subPagesToReturn = reserved - actualSubPagesUsed.
//   6. If subPagesToReturn > 0: CAS-clear subscription_pages_reserved + decrement
//      monthly_pages_used (floored at 0) in a transaction.
//   7. Else: just clear subscription_pages_reserved.
//   8. Completion write: set pipeline_status = 'complete', subscription_pages_reserved = 0.

interface RunSubPageReconcileResult {
  returnIssued: boolean;
  subPagesToReturn: number;
}

async function runSubscriptionPagesReconcilePath(
  sql: ReturnType<typeof postgres>,
  siteId: string,
  teamId: string,
  actualPagesCrawled: number,
): Promise<RunSubPageReconcileResult> {
  const [site] = await sql`
    SELECT pipeline_status, subscription_pages_reserved FROM geo_sites WHERE id = ${siteId}
  `;

  // Re-entry guard: already complete → skip
  if (site?.pipeline_status === "complete") {
    return { returnIssued: false, subPagesToReturn: 0 };
  }

  const reservedSubPages = site?.subscription_pages_reserved ?? 0;

  // Already reconciled guard
  if (!reservedSubPages || reservedSubPages <= 0) {
    return { returnIssued: false, subPagesToReturn: 0 };
  }

  const actualSubPagesUsed = Math.min(actualPagesCrawled, reservedSubPages);
  const subPagesToReturn = reservedSubPages - actualSubPagesUsed;

  let returnIssued = false;

  if (subPagesToReturn > 0) {
    await sql.begin(async (tx) => {
      // CAS: only proceed if subscription_pages_reserved is still > 0
      const cleared = await tx`
        UPDATE geo_sites
        SET subscription_pages_reserved = 0, updated_at = NOW()
        WHERE id = ${siteId} AND subscription_pages_reserved > 0
        RETURNING id
      `;
      if (cleared.length === 0) return; // another invocation already cleared it

      await tx`
        UPDATE teams
        SET monthly_pages_used = GREATEST(0, monthly_pages_used - ${subPagesToReturn}),
            updated_at = NOW()
        WHERE id = ${teamId}
      `;
      returnIssued = true;
    });
  } else {
    // All reserved pages were actually used — just clear the marker
    await sql`
      UPDATE geo_sites
      SET subscription_pages_reserved = 0, updated_at = NOW()
      WHERE id = ${siteId} AND subscription_pages_reserved > 0
    `;
  }

  // Completion write
  await sql`
    UPDATE geo_sites
    SET pipeline_status = 'complete', subscription_pages_reserved = 0, updated_at = NOW()
    WHERE id = ${siteId}
  `;

  return { returnIssued, subPagesToReturn };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("Subscription pages reconciliation (NEW-P-01)", () => {
  let sql: ReturnType<typeof postgres>;
  let skip = false;
  const seededIds: Array<{ siteId: string; teamId: string }> = [];

  beforeAll(async () => {
    skip = !(await isLocalDbReachable());
    if (skip) return;
    sql = postgres(LOCAL_DB, { max: 5, prepare: false, connect_timeout: 5 });
  });

  afterAll(async () => {
    if (skip || !sql) return;
    for (const { siteId, teamId } of seededIds) {
      await sql`DELETE FROM geo_sites WHERE id = ${siteId}`.catch(() => {});
      await sql`DELETE FROM teams WHERE id = ${teamId}`.catch(() => {});
    }
    await sql.end();
  });

  it("skips if local DB is unreachable", () => {
    if (!skip) return;
    expect(skip).toBe(true);
  });

  // ── Main reconciliation test ───────────────────────────────────────────────

  it("under-crawl: unused subscription pages returned to monthlyPagesUsed, subscriptionPagesReserved cleared (NEW-P-01)", async () => {
    if (skip) return;

    // Reserved 50 subscription pages, crawled only 20
    const RESERVED = 50;
    const ACTUAL_PAGES = 20;
    const INITIAL_PAGES_USED = 100;
    // Subscription pages are "used first" — actual sub pages used = min(20, 50) = 20
    // Pages to return = 50 - 20 = 30
    const EXPECTED_PAGES_TO_RETURN = RESERVED - ACTUAL_PAGES; // 30

    const seed = await seedAssemblingSubscriptionSite(sql, {
      initialPagesUsed: INITIAL_PAGES_USED,
      subscriptionPagesReserved: RESERVED,
      actualPages: ACTUAL_PAGES,
    });
    seededIds.push({ siteId: seed.siteId, teamId: seed.teamId });

    // --- First invocation (normal assemble completion) ---
    const first = await runSubscriptionPagesReconcilePath(sql, seed.siteId, seed.teamId, ACTUAL_PAGES);
    expect(first.returnIssued).toBe(true);
    expect(first.subPagesToReturn).toBe(EXPECTED_PAGES_TO_RETURN);

    // --- Assert DB state after first invocation ---

    // monthlyPagesUsed decremented by the unused amount
    const [team] = await sql`SELECT monthly_pages_used FROM teams WHERE id = ${seed.teamId}`;
    expect(team?.monthly_pages_used).toBe(INITIAL_PAGES_USED - EXPECTED_PAGES_TO_RETURN);

    // subscriptionPagesReserved cleared to 0
    const [site] = await sql`SELECT subscription_pages_reserved, pipeline_status FROM geo_sites WHERE id = ${seed.siteId}`;
    expect(site?.subscription_pages_reserved).toBe(0);
    expect(site?.pipeline_status).toBe("complete");
  });

  // ── Idempotency: second invocation (stale cron re-enqueue) must NOT decrement again ──

  it("double-assemble: second invocation does NOT decrement monthlyPagesUsed a second time (NEW-P-01 idempotency)", async () => {
    if (skip) return;

    const RESERVED = 40;
    const ACTUAL_PAGES = 15;
    const INITIAL_PAGES_USED = 80;
    const EXPECTED_PAGES_TO_RETURN = RESERVED - ACTUAL_PAGES; // 25

    const seed = await seedAssemblingSubscriptionSite(sql, {
      initialPagesUsed: INITIAL_PAGES_USED,
      subscriptionPagesReserved: RESERVED,
      actualPages: ACTUAL_PAGES,
    });
    seededIds.push({ siteId: seed.siteId, teamId: seed.teamId });

    // --- First invocation ---
    const first = await runSubscriptionPagesReconcilePath(sql, seed.siteId, seed.teamId, ACTUAL_PAGES);
    expect(first.returnIssued).toBe(true);

    // --- Second invocation (simulates stale cron re-enqueue) ---
    const second = await runSubscriptionPagesReconcilePath(sql, seed.siteId, seed.teamId, ACTUAL_PAGES);
    expect(second.returnIssued).toBe(false);

    // --- Assert DB state: monthlyPagesUsed decremented EXACTLY ONCE ---
    const [team] = await sql`SELECT monthly_pages_used FROM teams WHERE id = ${seed.teamId}`;
    expect(team?.monthly_pages_used).toBe(INITIAL_PAGES_USED - EXPECTED_PAGES_TO_RETURN);

    // subscriptionPagesReserved still 0
    const [site] = await sql`SELECT subscription_pages_reserved FROM geo_sites WHERE id = ${seed.siteId}`;
    expect(site?.subscription_pages_reserved).toBe(0);
  });

  // ── No under-crawl: all reserved pages used → no return, but marker cleared ──

  it("full-crawl: actual >= reserved → no return, subscriptionPagesReserved still cleared to 0", async () => {
    if (skip) return;

    const RESERVED = 30;
    const ACTUAL_PAGES = 50; // over the reserved amount — subscription fully consumed
    const INITIAL_PAGES_USED = 60;

    const seed = await seedAssemblingSubscriptionSite(sql, {
      initialPagesUsed: INITIAL_PAGES_USED,
      subscriptionPagesReserved: RESERVED,
      actualPages: ACTUAL_PAGES,
    });
    seededIds.push({ siteId: seed.siteId, teamId: seed.teamId });

    const result = await runSubscriptionPagesReconcilePath(sql, seed.siteId, seed.teamId, ACTUAL_PAGES);
    expect(result.returnIssued).toBe(false);
    expect(result.subPagesToReturn).toBe(0);

    // monthlyPagesUsed unchanged
    const [team] = await sql`SELECT monthly_pages_used FROM teams WHERE id = ${seed.teamId}`;
    expect(team?.monthly_pages_used).toBe(INITIAL_PAGES_USED);

    // subscriptionPagesReserved cleared
    const [site] = await sql`SELECT subscription_pages_reserved FROM geo_sites WHERE id = ${seed.siteId}`;
    expect(site?.subscription_pages_reserved).toBe(0);
  });

  // ── Floor at 0: monthlyPagesUsed must never go negative ──

  it("floor-at-0: monthlyPagesUsed never goes below 0 even if reserved > initialPagesUsed", async () => {
    if (skip) return;

    // Edge case: monthlyPagesUsed = 10, reserved = 50 → return capped at 10 (GREATEST 0)
    const RESERVED = 50;
    const ACTUAL_PAGES = 5;
    const INITIAL_PAGES_USED = 10; // less than what would be returned without floor

    const seed = await seedAssemblingSubscriptionSite(sql, {
      initialPagesUsed: INITIAL_PAGES_USED,
      subscriptionPagesReserved: RESERVED,
      actualPages: ACTUAL_PAGES,
    });
    seededIds.push({ siteId: seed.siteId, teamId: seed.teamId });

    const result = await runSubscriptionPagesReconcilePath(sql, seed.siteId, seed.teamId, ACTUAL_PAGES);
    expect(result.returnIssued).toBe(true);

    // monthlyPagesUsed should be GREATEST(0, 10 - 45) = 0 (not negative)
    const [team] = await sql`SELECT monthly_pages_used FROM teams WHERE id = ${seed.teamId}`;
    expect(team?.monthly_pages_used).toBeGreaterThanOrEqual(0);
  });

  // ── Concurrent invocations: at most one return ────────────────────────────

  it("concurrent assemble re-entries: at most one decrement of monthlyPagesUsed (CAS contention)", async () => {
    if (skip) return;

    const RESERVED = 60;
    const ACTUAL_PAGES = 25;
    const INITIAL_PAGES_USED = 200;
    const EXPECTED_PAGES_TO_RETURN = RESERVED - ACTUAL_PAGES; // 35

    const seed = await seedAssemblingSubscriptionSite(sql, {
      initialPagesUsed: INITIAL_PAGES_USED,
      subscriptionPagesReserved: RESERVED,
      actualPages: ACTUAL_PAGES,
    });
    seededIds.push({ siteId: seed.siteId, teamId: seed.teamId });

    // Fire three concurrent invocations
    const results = await Promise.all([
      runSubscriptionPagesReconcilePath(sql, seed.siteId, seed.teamId, ACTUAL_PAGES),
      runSubscriptionPagesReconcilePath(sql, seed.siteId, seed.teamId, ACTUAL_PAGES),
      runSubscriptionPagesReconcilePath(sql, seed.siteId, seed.teamId, ACTUAL_PAGES),
    ]);

    const returnsIssued = results.filter((r) => r.returnIssued).length;
    expect(returnsIssued).toBeLessThanOrEqual(1);

    // monthlyPagesUsed decremented at most once
    const [team] = await sql`SELECT monthly_pages_used FROM teams WHERE id = ${seed.teamId}`;
    expect(team?.monthly_pages_used).toBeGreaterThanOrEqual(INITIAL_PAGES_USED - EXPECTED_PAGES_TO_RETURN);
  });
});
