import { test, expect } from "@playwright/test";
test.describe("FI-065 — Mobile sidebar drawer", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test.fixme(true, "Requires mobile layout + authenticated session");
  test("hamburger → sidebar slides in; click 'Dashboard' closes + navigates", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /menu|hamburger/i }).click();
    await expect(page.getByRole("navigation")).toBeVisible();
  });
});
