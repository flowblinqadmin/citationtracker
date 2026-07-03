import { test, expect } from "@playwright/test";
// Phase 3 correction Q3: perPageResults IS rendered in Pages tab UI (gated by tier).
test.describe("FI-026 — Pages tab (per-page breakdown)", () => {
  test.fixme(true, "Requires paid tier + perPageResults populated");
  test("paid: Pages tab shows per-page table + download button", async ({ page }) => {
    await page.goto("/sites/SEEDED_PAID_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /pages/i }).click();
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByRole("button", { name: /download/i })).toBeVisible();
  });

  test("free: Pages tab shows upgrade gate instead of table", async ({ page }) => {
    await page.goto("/sites/SEEDED_FREE_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /pages/i }).click();
    await expect(page.getByText(/upgrade to see per-page/i)).toBeVisible();
  });
});
