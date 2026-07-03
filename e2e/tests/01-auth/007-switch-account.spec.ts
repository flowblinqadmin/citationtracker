import { test, expect } from "@playwright/test";

// FI-007: /auth/login?switch=1 clears existing session before new login.
test.describe("FI-007 — Switch account", () => {
  test.fixme(true, "Requires prior authenticated session");
  test("old session cleared on ?switch=1 visit", async ({ page }) => {
    await page.goto("/auth/login?switch=1");
    await expect(page.getByPlaceholder(/you@yourcompany\.com/i)).toBeVisible();
    // @scope-question FI-007: confirm old-session signal (e.g., geo-authed=false)
    const authed = await page.evaluate(() => window.sessionStorage.getItem("geo-authed"));
    expect(authed).not.toBe("true");
  });
});
