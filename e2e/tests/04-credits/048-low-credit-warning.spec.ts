import { test, expect } from "@playwright/test";
test.describe("FI-048 — Low-credit warning", () => {
  test.fixme(true, "Requires user with 1-9 credits");
  test("<10 credits → warning banner + 'Buy more' CTA", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("button", { name: /buy more|low credit/i })).toBeVisible();
  });
});
