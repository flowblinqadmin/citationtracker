import { test, expect } from "@playwright/test";
// CORRECTION: Competitors is an Overview-embedded card, not a standalone tab.
test.describe("FI-038 — Competitor discovery (1-click AI)", () => {
  test.fixme(true, "Requires paid tier + credits + <6 competitors");
  test("click discover on Overview Competitors card → SSE → 1-6 new rows", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("button", { name: /discover|find competitors/i }).click();
    await expect(page.getByText(/querying|extracting/i)).toBeVisible();
  });
});
