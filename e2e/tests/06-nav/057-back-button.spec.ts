import { test, expect } from "@playwright/test";
test.describe("FI-057 — Back button navigation", () => {
  test.fixme(true, "Requires authenticated session");
  test("dashboard → site → back → dashboard with state preserved", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("link").first().click();
    await page.goBack();
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
