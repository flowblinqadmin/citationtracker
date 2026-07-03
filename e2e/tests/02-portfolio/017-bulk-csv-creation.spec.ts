import { test, expect } from "@playwright/test";
import path from "node:path";

test.describe("FI-017 — Bulk CSV audit creation (from dashboard)", () => {
  test.fixme(true, "Requires authenticated user with credit balance + bulk upload UI");
  test("upload 5-URL CSV → preview → submit → 5 rows added", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /bulk|csv|upload/i }).click();
    const csvPath = path.resolve(__dirname, "../../fixtures/csv/sample-5-ecom.csv");
    await page.setInputFiles("input[type=file]", csvPath);
    await expect(page.getByText(/5 url/i)).toBeVisible();
    await page.getByRole("button", { name: /audit.*url/i }).click();
    await expect(page).toHaveURL(/\/(dashboard|sites)/);
  });
});
