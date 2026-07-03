import { test, expect } from "@playwright/test";
test.describe("FI-045 — Post-purchase balance update", () => {
  test.fixme(true, "Requires webhook-driven balance update; use ?payment=success marker");
  test("redirect ?payment=success → balance refreshed + toast shown", async ({ page }) => {
    await page.goto("/dashboard?payment=success");
    await expect(page.getByText(/credits added|you now have/i)).toBeVisible();
  });
});
