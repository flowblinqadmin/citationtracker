import { test, expect } from "@playwright/test";
test.describe("FI-061 — UpgradeModal entry & exit", () => {
  test.fixme(true, "Requires authenticated user");
  test("open → backdrop click → close", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /buy credits|upgrade/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
