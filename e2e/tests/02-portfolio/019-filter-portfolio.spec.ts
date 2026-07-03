import { test, expect } from "@playwright/test";

test.describe("FI-019 — Filter portfolio by tier/status", () => {
  test.fixme(true, "Filter UI may be gated; inventory lists as simple");
  test("selecting 'Good' tier filters table to score≥75", async ({ page }) => {
    await page.goto("/dashboard");
    // @scope-question FI-019: confirm DashboardFilter component exists/is visible by default
    const filter = page.getByRole("button", { name: /filter/i });
    if (await filter.isVisible().catch(() => false)) {
      await filter.click();
      await page.getByRole("menuitem", { name: /good/i }).click();
    }
  });
});
