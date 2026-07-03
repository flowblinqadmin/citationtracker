import { test, expect } from "@playwright/test";
import path from "node:path";
test.describe("FI-049 — CSV file upload & parsing", () => {
  test.fixme(true, "Requires bulk UI mounted");
  test("upload valid CSV → count shown", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /bulk|csv|upload/i }).click();
    const csv = path.resolve(__dirname, "../../fixtures/csv/sample-5-ecom.csv");
    await page.setInputFiles("input[type=file]", csv);
    await expect(page.getByText(/5 url|5\s+detected/i)).toBeVisible();
  });
});
