import { test, expect } from "@playwright/test";
import path from "node:path";
test.describe("FI-050 — Bulk credit/pricing preview", () => {
  test.fixme(true, "Requires paid-tier user + bulk UI");
  test("preview shows 'N URLs · M credits' and disables submit if insufficient", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /bulk|csv/i }).click();
    await page.setInputFiles("input[type=file]", path.resolve(__dirname, "../../fixtures/csv/sample-5-ecom.csv"));
    await expect(page.getByText(/credits? required|credits? needed/i)).toBeVisible();
    // @scope-question FI-050: free-tier copy per CORRECTIONS — OTP email sent regardless
  });
});
