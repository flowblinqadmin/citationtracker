/**
 * DRY-02 — Single-URL audit launch, post-complete assertions (AC-33).
 * Per ES-e2e-fixtures §b.16.2 + §b.16.8 + AC-33.
 *
 * AC-33: spec asserts ONLY the post-pipeline-complete state. No mid-flight
 * reserve-only observations. The app writes a `crawl_reserve` row at launch
 * (negative `credits_changed`, depends on Firecrawl page_estimate) and
 * reconciles with a `crawl_refund` row at pipeline complete (positive or
 * zero `credits_changed`, reflecting the over-estimate). Both rows are
 * asserted to EXIST; individual row `credits_changed` values are NOT
 * asserted (vendor-content dependent per AC-34). The net credit_balance
 * delta is pinned at EXACTLY -1 per Rule 1 (AC-31) — live Firecrawl
 * against a minimal-page fixture per §b.16.9.5 yields actual_pages ≤ 10
 * → net = -ceil(actual/PAGES_PER_CREDIT=10) = -1.
 *
 * AC-25 zero fixme. AC-26 Supabase-assert. AC-31 exact integer literal on net.
 */
import { test, expect } from "@playwright/test";
import {
  assertRowExists,
  baselineCount,
  assertRowCountDelta,
  assertColumnDelta,
} from "../../helpers/supabase-assert";
import { TEST_TEAM_ID } from "../../fixtures/ids";

test("DRY-02 single-URL audit launch (post-complete per AC-33)", async ({ page }) => {
  // Live-services pivot (Aditya supplement corr 9fabb91b): local-dev audits
  // against real Firecrawl + LLM chain routinely run 15-20 min. 25-min cap
  // gives 5-10 min headroom; DO NOT abort prematurely.
  test.setTimeout(25 * 60 * 1000);

  // Read pre dynamically (cumulative batch trajectory safe).
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

  // ── Act: navigate (storageState authed) + submit single-URL audit ────
  await page.goto("/dashboard");
  const domain = "example.com";
  const domainInput = page.getByPlaceholder(/example\.com/i).first();
  await expect(domainInput).toBeVisible({ timeout: 10_000 });
  await domainInput.fill(domain);
  const runBtn = page.getByRole("button", { name: /^Run Audit$/ });
  await expect(runBtn).toBeEnabled();
  await runBtn.click();

  // ── Wait for pipeline_status=complete (AC-33). Live services: 20-min
  // poll cap (Aditya supplement — per-stage stalls expected, allow to
  // finish rather than aborting). 5s poll interval keeps log tractable. ──
  const deadline = Date.now() + 20 * 60 * 1000;
  let siteId: string | null = null;
  let lastStatus: string | null = null;
  while (Date.now() < deadline) {
    const { createClient } = require("@supabase/supabase-js");
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data } = await sb
      .from("geo_sites")
      .select("id, pipeline_status")
      .eq("team_id", TEST_TEAM_ID)
      .eq("domain", domain)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const status = (data?.pipeline_status as string | undefined) ?? null;
    if (status && status !== lastStatus) {
      // eslint-disable-next-line no-console
      console.log(`[DRY-02] pipeline_status=${status} at ${new Date().toISOString()}`);
      lastStatus = status;
    }
    if (data && status === "complete") {
      siteId = data.id as string;
      break;
    }
    await page.waitForTimeout(5_000);
  }
  expect(
    siteId,
    `pipeline_status did not reach 'complete' within 20min (live-services budget). Last observed: ${lastStatus ?? 'unseen'}. AC-33 surface trigger.`,
  ).not.toBeNull();

  // ── POST-COMPLETE Supabase asserts (AC-33) ──────────────────────────
  // (1) geo_sites rowcount delta +1
  await assertRowCountDelta({
    table: "geo_sites",
    where: { team_id: TEST_TEAM_ID },
    before: sitesBefore,
    expected_delta: 1,
  });
  // (2) pipeline reached 'complete' for this exact site
  await assertRowExists({
    table: "geo_sites",
    where: { id: siteId!, pipeline_status: "complete" },
  });
  // (3) credit_transactions crawl_reserve row exists (pre-pipeline)
  await assertRowExists({
    table: "credit_transactions",
    where: { team_id: TEST_TEAM_ID, type: "crawl_reserve", site_id: siteId! },
  });
  // (4) credit_transactions crawl_refund row exists (post-reconciliation at pipeline complete).
  // Product writes crawl_refund at app/api/pipeline/stage/route.ts:133 to reconcile the
  // over-estimate from the launch-time crawl_reserve. crawl_debit type is reserved for
  // admin/reconciliation paths (Stripe dispute etc.), NOT audit launches. See ES AC-33.
  await assertRowExists({
    table: "credit_transactions",
    where: { team_id: TEST_TEAM_ID, type: "crawl_refund", site_id: siteId! },
  });
  // (5) EXACT net credit_balance delta = -1 per AC-31 (live Firecrawl; actual_pages ≤ 10
  //     for a minimal-page fixture per §b.16.9.5 → net = -ceil(actual/10) = -1).
  await assertColumnDelta({
    table: "teams",
    where: { id: TEST_TEAM_ID },
    columns: { credit_balance: { from: pre, to: pre - 1 } },
  });

  // ── Observability ───────────────────────────────────────────────────
  const post = pre - 1;
  // eslint-disable-next-line no-console
  console.log(`DRY-02 pre=${pre} post=${post} delta=${post - pre}`);
});
