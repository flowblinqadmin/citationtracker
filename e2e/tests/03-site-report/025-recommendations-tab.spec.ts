import { test, expect } from "@playwright/test";
test.describe("FI-025 — Recommendations tab", () => {
  test.fixme(true, "Requires rankedRecommendations populated");
  test("click Recommendations → ranked list with impact/effort badges", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /recommendations/i }).click();
    await expect(page.getByRole("list")).toBeVisible();
  });
});
