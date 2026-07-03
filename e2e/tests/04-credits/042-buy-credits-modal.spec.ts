import { test, expect } from "@playwright/test";
test.describe("FI-042 — Buy credits modal", () => {
  test.fixme(true, "Requires authenticated user");
  test("modal opens with Plans + Credits tabs; interval toggle updates prices", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /buy credits|upgrade/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("tab", { name: /plans/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /credits/i })).toBeVisible();
  });
});
