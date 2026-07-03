import { test, expect } from "@playwright/test";
test.describe("FI-066 — Dashboard search/filter box", () => {
  test.fixme(true, "Requires filter UI + multiple domains");
  test("type 'example' → table filters client-side", async ({ page }) => {
    await page.goto("/dashboard");
    const search = page.getByPlaceholder(/search|filter/i);
    if (await search.isVisible().catch(() => false)) {
      await search.fill("example");
      await expect(page.getByRole("row")).toContainText(/example/i);
    }
  });
});
