import { test, expect } from "@playwright/test";
test.describe("FI-032 — Domain switcher dropdown", () => {
  test.fixme(true, "Requires team with ≥2 domains");
  test("click domain name → dropdown of team domains → switch without re-login", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("button", { name: /domain|switch/i }).first().click();
    await expect(page.getByRole("menu")).toBeVisible();
  });
});
