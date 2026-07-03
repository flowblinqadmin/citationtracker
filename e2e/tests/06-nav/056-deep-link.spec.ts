import { test, expect } from "@playwright/test";

// FI-056: Deep-link routing. Invalid-token path resolves via Next.js 404
// surface (app returns 404 for unknown site id; there is no dedicated 401
// UI state per §b.15.6 secondary finding #4). Pattern per §b.15.2 #5.
test.describe("FI-056 — Deep-link routing", () => {
  test("valid token → page renders without redirect", async ({ page }) => {
    test.fixme(true, "Requires valid site + accessToken fixture");
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await expect(page).toHaveURL(/\/sites\//);
  });

  test("invalid token → 404 surfaced via Next.js default error page", async ({ page }) => {
    await page.goto("/sites/fake-id?token=garbage");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/404/);
    await expect(
      page.locator('h1.next-error-h1, h1:has-text("404")'),
    ).toBeVisible({ timeout: 15_000 });
  });
});
