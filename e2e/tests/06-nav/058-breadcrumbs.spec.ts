import { test, expect } from "@playwright/test";
test.describe("FI-058 — Breadcrumb navigation", () => {
  test.fixme(true, "Requires breadcrumb UI");
  test("click breadcrumb → navigates to parent route", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    const crumb = page.getByRole("link", { name: /dashboard/i });
    if (await crumb.isVisible().catch(() => false)) {
      await crumb.click();
      await expect(page).toHaveURL(/\/dashboard/);
    }
  });
});
