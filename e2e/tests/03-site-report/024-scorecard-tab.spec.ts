import { test, expect } from "@playwright/test";
test.describe("FI-024 — Scorecard tab (16 pillars)", () => {
  test.fixme(true, "Requires completed site; pillar fixture");
  test("click Scorecard → 16 pillars (15 for free tier) + expand works", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /scorecard/i }).click();
    const pillars = page.getByRole("article");
    await expect(pillars.first()).toBeVisible();
    // @scope-question FI-024: confirm paid=16 vs free=15 pillar count
  });
});
