import { test, expect } from "@playwright/test";
test.describe("FI-052 — Bulk audit per-domain status tracking", () => {
  test.fixme(true, "Requires in-progress bulk audit");
  test("each row shows pipelineStatus that updates during run", async ({ page }) => {
    await page.goto("/dashboard");
    const row = page.getByRole("row").nth(1);
    await expect(row.getByText(/discover|crawl|extract|complete/i)).toBeVisible();
  });
});
