import { test, expect } from "@playwright/test";
test.describe("FI-047 — Free tier audit counter", () => {
  test.fixme(true, "Requires free-tier user with 0<count<5");
  test("dashboard shows '{N} of 5 free audits remaining'", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText(/\d+\s*of\s*5\s*free/i)).toBeVisible();
  });
});
