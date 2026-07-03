import { test, expect } from "@playwright/test";
test.describe("FI-039 — Add manual competitor", () => {
  test.fixme(true, "Requires paid tier + <6 competitors");
  test("add 'Acme Corp' → appears in Competitors list", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("button", { name: /add competitor|add/i }).click();
    await page.getByLabel(/name/i).fill("Acme Corp");
    await page.getByRole("button", { name: /add|submit/i }).click();
    await expect(page.getByText(/Acme Corp/)).toBeVisible();
  });

  test("empty name is rejected", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("button", { name: /add competitor|add/i }).click();
    await page.getByRole("button", { name: /add|submit/i }).click();
    // @scope-question FI-039: confirm empty-name UX (disabled button vs inline error)
  });
});
