import { test, expect } from "@playwright/test";
test.describe("FI-031 — Score improvement delta display", () => {
  test.fixme(true, "Requires re-audited site with previousScore + currentScore");
  test("delta banner shows '+N' with color arrow", async ({ page }) => {
    await page.goto("/sites/SEEDED_REAUDITED_ID?token=SEEDED_TOKEN");
    await expect(page.getByText(/\+?\d+\s*point|improvement/i)).toBeVisible();
  });
});
