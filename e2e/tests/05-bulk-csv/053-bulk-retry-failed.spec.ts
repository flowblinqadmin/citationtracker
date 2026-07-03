import { test, expect } from "@playwright/test";
test.describe("FI-053 — Retry failed URLs", () => {
  test.fixme(true, "Requires bulk site with crawlData.failedUrls populated");
  test("'Retry failed' → new bulk site for failed URLs only", async ({ page }) => {
    await page.goto("/sites/SEEDED_BULK_ID?token=SEEDED_TOKEN");
    await page.getByText(/\d+ failed url/i).click();
    await page.getByRole("button", { name: /retry failed/i }).click();
    await expect(page.getByText(/retrying|new audit/i)).toBeVisible();
  });
});
