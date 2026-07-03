/**
 * DRY-03 — Citation check on the seeded paidFullAudit site.
 * Per ES-e2e-fixtures §b.16.2. Real credits: -5 (ACTION_CREDITS.shareOfVoice).
 *
 * Runs against paidFullAudit (id=00000000-e2e-site-0000-0000000000f2,
 * pipeline_status=complete, 12 pages) so no audit-launch flow is required —
 * sidesteps the product-gap-qstash-local-callback block on DRY-02/DRY-05.
 *
 * AC-25 no fixme. AC-26 Supabase-assert. AC-27 product-gap surface if blocked.
 */
import { test, expect } from "@playwright/test";
import {
  assertRowExists,
  baselineCount,
  assertRowCountDelta,
} from "../../helpers/supabase-assert";
import { TEST_TEAM_ID, SITE_IDS } from "../../fixtures/ids";

test("DRY-03 citation check on paidFullAudit", async ({ page }) => {
  test.setTimeout(180_000);

  const siteId = SITE_IDS.paidFullAudit;
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

  // ── Arrange: confirm baseline balance + capture citation count ─────────
  await assertRowExists({
    table: "teams",
    where: { id: TEST_TEAM_ID },
    expected_columns: { credit_balance: pre },
  });
  const checksBefore = await baselineCount({
    table: "citation_check_scores",
    where: { site_id: siteId },
  });

  // ── Act 1: navigate (storageState provides auth session) ───────────────
  // /dashboard/domains/<id> is the team-scoped entry; it resolves access
  // internally and redirects to /sites/<id>?token=... (seeded access_token).
  await page.goto(`/dashboard/domains/${siteId}`);
  await expect(page).toHaveURL(/\/sites\//, { timeout: 15_000 });

  // ── Act 2: trigger citation check ──────────────────────────────────────
  // SitePageClient renders a "Citation Check" action rail (see lines ~1229-1244).
  // Selector candidates: role=button with name /citation/i, or the per-row
  // "Rerun Citations" button on dashboard. On the site page itself the action
  // rail button typically carries the text visible via accessible name.
  // Live DOM has: <button>Scan Citations 5cr</button> in the action rail.
  const citationBtn = page
    .getByRole("button", { name: /scan citations/i })
    .first();
  await expect(citationBtn).toBeVisible({ timeout: 15_000 });

  // Capture the POST response so a 402/403/500 surfaces as a failed spec
  // with diagnostic context (rather than a silent UI timeout).
  const citationResp = page.waitForResponse(
    (r) => r.url().includes("/citation-check") && r.request().method() === "POST",
    { timeout: 30_000 },
  );
  await citationBtn.click();
  const resp = await citationResp;
  if (![200, 201, 202].includes(resp.status())) {
    const body = await resp.text().catch(() => "<no body>");
    throw new Error(
      `POST citation-check returned ${resp.status()}: ${body}. ` +
      `If this is a product-gap (e.g. missing LLM API keys in local env), ` +
      `surface as product-gap-api-not-built-locally per AC-27.`,
    );
  }

  // ── Act 3: wait for completion signal — new citation_check_scores row ──
  // Poll the DB for a row-count delta instead of relying on UI progress
  // indicators, which may differ across tiers or pipeline states.
  const deadline = Date.now() + 120_000;
  let landed = false;
  while (Date.now() < deadline) {
    try {
      await assertRowCountDelta({
        table: "citation_check_scores",
        where: { site_id: siteId },
        before: checksBefore,
        expected_delta: 1,
      });
      landed = true;
      break;
    } catch {
      await page.waitForTimeout(2000);
    }
  }
  expect(landed, "citation_check_scores +1 did not land within 120s").toBe(true);

  // ── Supabase-assert (AC-26): credit balance deducted by 5 ──────────────
  const post = pre - 5;
  await assertRowExists({
    table: "teams",
    where: { id: TEST_TEAM_ID },
    expected_columns: { credit_balance: post },
  });

  // ── Observability line ──────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log(`DRY-03 pre=${pre} post=${post} delta=${post - pre}`);
});
