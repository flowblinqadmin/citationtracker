import { test, expect } from "@playwright/test";

test.describe("FI-022 — Row actions menu", () => {
  test.fixme(true, "Requires completed site in table");
  test("menu opens and shows Audit/Citation/Download/Share", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /actions|more|⋯/i }).first().click();
    await expect(page.getByRole("menu")).toBeVisible();
    // @scope-question FI-022: confirm exact menu item labels
  });
});
