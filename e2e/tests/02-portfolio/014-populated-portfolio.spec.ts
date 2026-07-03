import { test, expect } from "@playwright/test";

test.describe("FI-014 — Populated portfolio view", () => {
  test.fixme(true, "Requires team fixture with ≥2 domains across pipeline statuses");
  test("table renders row per domain with score/tier/citation/last-scan", async ({ page }) => {
    await page.goto("/dashboard");
    const rows = page.getByRole("row");
    await expect(rows.nth(1)).toBeVisible();
    // @scope-question FI-014: confirm canonical column headers (Domain/GEO Score/Tier/Citations%/Critical/Delta/Last Scan)
    await expect(page.getByRole("columnheader", { name: /domain/i })).toBeVisible();
  });
});
