import { test, expect } from "@playwright/test";
test.describe("FI-062 — Delete confirmation modal", () => {
  test.fixme(true, "Requires ≥1 deletable site");
  test("delete → modal 'Are you sure?' → cancel keeps site", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /delete|trash/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: /cancel/i }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  });
});
