import { test, expect } from "@playwright/test";
test.describe("FI-060 — Cross-section transitions", () => {
  test.fixme(true, "Requires authenticated user with ≥1 site");
  test("home → dashboard → site → back preserves auth state", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /dashboard/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await page.getByRole("row").nth(1).getByRole("link").click();
    await expect(page).toHaveURL(/\/sites\//);
  });
});
