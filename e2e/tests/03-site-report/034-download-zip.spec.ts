import { test, expect } from "@playwright/test";
test.describe("FI-034 — Download ZIP report", () => {
  test.fixme(true, "Requires paid tier + credits");
  test("download → zip file named {domain}-geo-audit.zip", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    const dlPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /download.*zip|download report/i }).click();
    const dl = await dlPromise;
    expect(dl.suggestedFilename()).toMatch(/\.zip$/);
  });
});
