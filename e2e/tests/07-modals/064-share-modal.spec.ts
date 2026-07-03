import { test, expect } from "@playwright/test";
test.describe("FI-064 — Share report modal", () => {
  test.fixme(true, "Requires completed site + shareToken path");
  test("share button → modal with copyable link", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("button", { name: /share/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText(/\/report\//i)).toBeVisible();
  });
});
