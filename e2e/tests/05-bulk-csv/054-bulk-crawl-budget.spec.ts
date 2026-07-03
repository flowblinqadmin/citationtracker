import { test, expect } from "@playwright/test";
import path from "node:path";
test.describe("FI-054 — Bulk crawl limit / budget enforcement", () => {
  test.fixme(true, "Requires user with low credit balance + >100-URL CSV");
  test("preview warns when budget < total; only allocated pages crawled", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /bulk|csv/i }).click();
    await page.setInputFiles("input[type=file]", path.resolve(__dirname, "../../fixtures/csv/sample-large.csv"));
    await expect(page.getByText(/will be processed|allocated/i)).toBeVisible();
  });
});
