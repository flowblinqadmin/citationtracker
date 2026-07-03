import { test, expect } from "@playwright/test";
test.describe("FI-041 — View credit balance", () => {
  test.fixme(true, "Requires authenticated team with known creditBalance");
  test("balance visible in header + dashboard KPI", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText(/\d+\s*credits?/i).first()).toBeVisible();
  });
});
