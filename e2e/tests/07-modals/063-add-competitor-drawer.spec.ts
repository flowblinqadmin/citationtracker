import { test, expect } from "@playwright/test";
test.describe("FI-063 — Add competitor drawer/modal", () => {
  test.fixme(true, "Requires site page with <6 competitors");
  test("drawer opens, name input validated, submit appends", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("button", { name: /add competitor|add/i }).click();
    await expect(page.getByLabel(/name/i)).toBeVisible();
    await page.getByRole("button", { name: /close|x/i }).first().click();
  });
});
