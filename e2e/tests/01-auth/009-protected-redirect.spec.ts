import { test, expect } from "@playwright/test";

// FI-009: Unauthenticated /dashboard → redirect to /auth/login?redirectTo=/dashboard.
// Selector patterns per ES-e2e-fixtures §b.15.2 (placeholder anchor).
test.describe("FI-009 — Protected route redirect", () => {
  test("unauth user visiting /dashboard → login with redirectTo", async ({ page, context }) => {
    await context.clearCookies();
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/auth\/login\?.*redirectTo=%2Fdashboard/);
  });

  test("redirectTo cannot be open-redirect external URL", async ({ page }) => {
    await page.goto("/auth/login?redirectTo=https://evil.com");
    await expect(page.getByPlaceholder(/you@yourcompany\.com/i)).toBeVisible();
    // The query-param value may legitimately contain "evil.com" (that's the
    // input the app is DEFENDING against, not leaking to). The anti-open-redirect
    // invariant is "we stayed on our own origin", so compare URL.origin —
    // a pathname/query substring check is too literal.
    const currentOrigin = new URL(page.url()).origin;
    expect(currentOrigin).not.toBe("https://evil.com");
    expect(currentOrigin).not.toBe("http://evil.com");
    expect(new URL(page.url()).pathname).toBe("/auth/login");
  });
});
