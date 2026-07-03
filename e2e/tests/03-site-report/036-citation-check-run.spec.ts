import { test, expect } from "@playwright/test";
test.describe("FI-036 — Run citation check (SSE progress)", () => {
  test.fixme(true, "Requires completed scorecard + paid tier + credits");
  test("citation check streams progress then persists results", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("button", { name: /citation check|run citation/i }).click();
    await expect(page.getByText(/generating prompts|querying platforms/i)).toBeVisible();
    await expect(page.getByText(/visibility|citation rate/i)).toBeVisible({ timeout: 60_000 });
  });
});
