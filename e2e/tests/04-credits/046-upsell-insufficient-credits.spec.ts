import { test, expect } from "@playwright/test";
test.describe("FI-046 — Upsell on insufficient credits", () => {
  test.fixme(true, "Requires user with 0 credits + action that requires credits");
  test("audit action with 0 credits auto-opens UpgradeModal with recommended pack", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByLabel(/domain|url/i).fill("example.com");
    await page.getByRole("button", { name: /audit|run/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText(/need.*credits?|insufficient/i)).toBeVisible();
  });
});
