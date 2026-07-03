import { test, expect } from "@playwright/test";

test.describe("FI-018 — Delete domain from portfolio", () => {
  test.fixme(true, "Requires fixture with ≥1 deletable domain");
  test("delete → confirm modal → row removed", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /delete|trash/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: /confirm|delete/i }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  });
});
