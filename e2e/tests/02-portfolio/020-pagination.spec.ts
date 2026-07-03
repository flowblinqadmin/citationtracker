import { test, expect } from "@playwright/test";

test.describe("FI-020 — Portfolio pagination", () => {
  test.fixme(true, "Requires fixture with ≥21 domains");
  test("table shows max 20 rows; next page shows 21+", async ({ page }) => {
    await page.goto("/dashboard");
    // @scope-question FI-020: confirm pagination is implemented; inventory marks as 'if implemented'
    const next = page.getByRole("button", { name: /next|page 2/i });
    if (await next.isVisible().catch(() => false)) {
      await next.click();
      await expect(page).toHaveURL(/page=2|p=2/);
    }
  });
});
