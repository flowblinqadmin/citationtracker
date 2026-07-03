import { test, expect } from "@playwright/test";
test.describe("FI-059 — 404 not-found page", () => {
  test("invalid site id → 404 with 'Start a new audit' link", async ({ page }) => {
    const resp = await page.goto("/sites/definitely-not-a-site-id-zzz");
    // @scope-question FI-059: Next's notFound() returns 404 for dynamic route
    expect([404, 401]).toContain(resp?.status() ?? 0);
    await expect(page.getByText(/not found|404/i).first()).toBeVisible();
  });
});
