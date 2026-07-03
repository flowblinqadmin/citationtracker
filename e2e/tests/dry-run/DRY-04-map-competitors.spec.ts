/**
 * DRY-04 — Add a user-defined competitor on the seeded paidFullAudit.
 * Per ES-e2e-fixtures §b.16.2. Real credits: 0 (manual add is free —
 * only AI "Map Competitors" discovery costs 5 credits; per dispatch's
 * credit_impact column).
 *
 * Uses paidFullAudit (pipeline_status=complete, 0 pre-seeded competitors
 * so 6 slots remaining) — sidesteps product-gap-qstash-local-callback.
 */
import { test, expect } from "@playwright/test";
import { assertRowExists } from "../../helpers/supabase-assert";
import { TEST_TEAM_ID, SITE_IDS } from "../../fixtures/ids";

test("DRY-04 add user-defined competitor on paidFullAudit", async ({ page }) => {
  test.setTimeout(120_000);

  const siteId = SITE_IDS.paidFullAudit;
  const competitorName = "Acme E2E Corp";
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

  // ── Arrange: navigate to paidFullAudit (storageState provides auth) ────
  await page.goto(`/dashboard/domains/${siteId}`);
  await expect(page).toHaveURL(/\/sites\//, { timeout: 15_000 });

  // ── Act: fill the "Add competitor" input and click Add ────────────────
  // SitePageClient renders an inline add row: text input + "Add" button.
  // Live DOM (from test-results error-context snapshot): button "+" is the
  // open-add toggle on mobile; on desktop the name input is already visible.
  // We try both: click the '+' toggle if present, then fill the input by
  // placeholder OR role, then click the Add button.
  const toggleBtn = page.getByRole("button", { name: /^\+$/ }).first();
  if (await toggleBtn.isVisible().catch(() => false)) {
    await toggleBtn.click().catch(() => {});
  }

  const nameInput = page
    .getByPlaceholder(/competitor|name/i)
    .or(page.getByRole("textbox", { name: /competitor|name/i }))
    .first();
  await expect(nameInput).toBeVisible({ timeout: 10_000 });
  await nameInput.fill(competitorName);

  const addBtn = page.getByRole("button", { name: /^Add$/ }).first();
  await expect(addBtn).toBeEnabled();

  const addResp = page.waitForResponse(
    (r) => r.url().includes("/competitors") && r.request().method() === "POST",
    { timeout: 20_000 },
  );
  await addBtn.click();
  const resp = await addResp;
  if (![200, 201].includes(resp.status())) {
    const body = await resp.text().catch(() => "<no body>");
    throw new Error(`POST competitors returned ${resp.status()}: ${body}`);
  }

  // ── Assert UI: pill with competitor name appears ──────────────────────
  await expect(page.getByText(competitorName)).toBeVisible({ timeout: 10_000 });

  // ── Supabase-assert (AC-26): geo_sites.user_competitors JSONB has 1 entry ──
  // The helper does strict value equality via .eq() which doesn't support
  // JSONB containment; we retrieve the row and inspect.
  const row = await (async () => {
    const { createClient } = require("@supabase/supabase-js");
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data } = await sb.from("geo_sites").select("user_competitors").eq("id", siteId).single();
    return data as { user_competitors: Array<{ name?: string }> | null };
  })();
  expect(row?.user_competitors?.length ?? 0).toBeGreaterThanOrEqual(1);
  const names = (row?.user_competitors ?? []).map((c) => c.name).filter(Boolean);
  expect(names).toContain(competitorName);

  // ── Assert credit balance unchanged (manual add is free per ES) ───────
  const post = pre;
  await assertRowExists({
    table: "teams",
    where: { id: TEST_TEAM_ID },
    expected_columns: { credit_balance: post },
  });

  // eslint-disable-next-line no-console
  console.log(`DRY-04 pre=${pre} post=${post} delta=${post - pre}`);
});
