import { test, expect } from "@playwright/test";
test.describe("FI-030 — Site report error state (failed pipeline)", () => {
  test.fixme(true, "Requires site with pipelineStatus='failed' + pipelineError populated");
  test("failed site shows error banner + retry button", async ({ page }) => {
    await page.goto("/sites/SEEDED_FAILED_ID?token=SEEDED_TOKEN");
    await expect(page.getByText(/failed|error/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /retry/i })).toBeVisible();
  });
});
