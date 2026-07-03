/**
 * DRY-05 — Bulk CSV (5 URLs) audit launch, post-complete (AC-33).
 * Per ES-e2e-fixtures §b.16.2 + §b.16.8 + AC-33.
 *
 * Net credit_balance delta pinned at EXACTLY -1 per bulkCreditsRequired(5)
 * = ceil(5/PAGES_PER_CREDIT=10) = 1. Bulk bundles charge once per job.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import {
  assertRowExists,
  baselineCount,
  assertRowCountDelta,
  assertRowCount,
  assertColumnDelta,
} from "../../helpers/supabase-assert";
import { TEST_TEAM_ID } from "../../fixtures/ids";

// Domains chosen per AC-live-domains criterion: minimal-page public sites;
// large sites prohibited (Aditya supplement corr 9fabb91b). CSV uses
// example.com, example.org, example.net (IANA reserved family),
// httpbin.org, httpbin.com — small predictable HTTP tooling sites.

test("DRY-05 bulk CSV 5-URL audit launch (post-complete per AC-33)", async ({ page }) => {
  // Live-services pivot: 5 real audits run concurrently. 30-min cap per
  // supplement; DO NOT abort prematurely even if a stage stalls.
  test.setTimeout(30 * 60 * 1000);

  const pre = await (async () => {
    const { createClient } = require("@supabase/supabase-js");
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data } = await sb.from("teams").select("credit_balance").eq("id", TEST_TEAM_ID).single();
    return (data as { credit_balance: number }).credit_balance;
  })();

  const sitesBefore = await baselineCount({
    table: "geo_sites",
    where: { team_id: TEST_TEAM_ID },
  });
  const jobsBefore = await baselineCount({
    table: "firecrawl_jobs",
    where: {},
  });

  // ── Act: dashboard → bulk toggle → upload CSV → Run Bulk Audit ───────
  await page.goto("/dashboard");
  const bulkToggle = page.getByRole("button", { name: /^Bulk CSV$/ });
  await expect(bulkToggle).toBeVisible({ timeout: 10_000 });
  await bulkToggle.click();

  const csvPath = path.resolve(__dirname, "../../fixtures/csv/sample-5-ecom.csv");
  await page.setInputFiles("input[type=file]", csvPath);
  const bulkRunBtn = page.getByRole("button", { name: /Run Bulk Audit/i });
  await expect(bulkRunBtn).toBeVisible({ timeout: 10_000 });
  await expect(bulkRunBtn).toBeEnabled();
  // Timestamp cutoff captured BEFORE upload-click so the polling filter only
  // counts sites created by this bulk submission (not pre-existing completed
  // bulk sites from earlier runs). Per RM rm-phaseA-4of5 diagnosis
  // (da3f2130): previous exit condition `completeDelta >= 5` broke on
  // geo_sites row CREATION, not pipeline COMPLETION, causing firecrawl_jobs
  // to be counted mid-flight.
  const uploadStartIso = new Date().toISOString();
  await bulkRunBtn.click();

  // ── Wait for 5 NEW sites (created_at > uploadStartIso) at
  // pipeline_status=complete (25 min cap, 5s poll; progressing-slowness
  // is OK per Aditya supplement). ──────────────────────────────────────
  const deadline = Date.now() + 25 * 60 * 1000;
  let newCompleteCount = 0;
  let lastSummary = "";
  while (Date.now() < deadline) {
    const { createClient } = require("@supabase/supabase-js");
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    // Count NEW completed sites only (created_at after upload-click).
    const { count: newComplete } = await sb
      .from("geo_sites")
      .select("*", { count: "exact", head: true })
      .eq("team_id", TEST_TEAM_ID)
      .eq("pipeline_status", "complete")
      .gt("created_at", uploadStartIso);
    // Observability: also track total new rows for progress visibility.
    const { count: newTotal } = await sb
      .from("geo_sites")
      .select("*", { count: "exact", head: true })
      .eq("team_id", TEST_TEAM_ID)
      .gt("created_at", uploadStartIso);
    newCompleteCount = newComplete ?? 0;
    const newTotalCount = newTotal ?? 0;
    const summary = `new_total=${newTotalCount} new_complete=${newCompleteCount}`;
    if (summary !== lastSummary) {
      // eslint-disable-next-line no-console
      console.log(`[DRY-05] ${summary} at ${new Date().toISOString()}`);
      lastSummary = summary;
    }
    // Exit only when all 5 new bulk sites have reached pipeline_status=complete.
    // firecrawl_jobs rows are written during crawl-fanout BEFORE complete, so
    // this guarantees all 5 chunk-jobs exist at assertion time.
    if (newCompleteCount >= 5) break;
    await page.waitForTimeout(5_000);
  }
  expect(newCompleteCount).toBeGreaterThanOrEqual(5);

  // ── POST-COMPLETE asserts ────────────────────────────────────────────
  // (1) geo_sites +5
  await assertRowCountDelta({
    table: "geo_sites",
    where: { team_id: TEST_TEAM_ID },
    before: sitesBefore,
    expected_delta: 5,
  });
  // (2) firecrawl_jobs +5 per computeChunks formula at lib/services/geo-crawler.ts:1110-1115.
  //     numChunks = min(CRAWL_MAX_CHUNKS=10, totalPages=5) = 5; chunkSize = ceil(5/5) = 1.
  //     Expected rows: 5 (one per chunk, one URL per chunk). CoFounder dispatch corr
  //     4af52a3d claimed "ceil(5/2)=3" — that was wrong per verified code; spec stays
  //     at +5. If a milestone run observes fewer, that's a submission-failure anomaly
  //     per AC-35 (HALT + diagnose, not silently relax the assertion).
  await assertRowCount({
    table: "firecrawl_jobs",
    expected: jobsBefore + 5,
  });
  // (3) crawl_reserve row exists for the bulk job.
  //     Live /api/sites POST path emits the bulk aggregate crawl_reserve at
  //     app/api/sites/route.ts:170 unconditionally when creditsToDeduct > 0
  //     (bulkCreditsRequired(5) = 1, so 1 row written with credits_changed=-1).
  //     createdAfter: uploadStartIso isolates this bulk run's row from any
  //     crawl_reserve DRY-02 left behind earlier in the same batch
  //     (credit_transactions is team-scoped; seed DELETE runs once per batch,
  //     not per-test).
  //
  //     REFUND rows are NOT asserted — all refund emit sites are conditional
  //     on over-reservation and the minimal-fixture run produces zero refund
  //     rows: (a) stage/route.ts:1114 crawl_refund guards `auditMode !== "bulk"`
  //     at line 1095 — bulk flows skip this path entirely; (b) stage/route.ts:1076
  //     bulk_crawl_refund guards `actualCredits < reservedCredits` at line 1062
  //     — for 4 non-primary sites reservedCredits=0 so condition never fires;
  //     for the primary site reserved=1 and actual typically=1 (minimal page
  //     surface) so equality skips the refund. The net invariant (-1) is
  //     captured by assertion (4) below per Rule 1; refund existence is
  //     informational and would make the test brittle to conditional emission.
  await assertRowExists({
    table: "credit_transactions",
    where: { team_id: TEST_TEAM_ID, type: "crawl_reserve" },
    createdAfter: uploadStartIso,
  });
  // (4) EXACT net credit_balance delta = -1
  await assertColumnDelta({
    table: "teams",
    where: { id: TEST_TEAM_ID },
    columns: { credit_balance: { from: pre, to: pre - 1 } },
  });

  // ── Observability ───────────────────────────────────────────────────
  const post = pre - 1;
  // eslint-disable-next-line no-console
  console.log(`DRY-05 pre=${pre} post=${post} delta=${post - pre}`);
});
