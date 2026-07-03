import { test, expect } from "@playwright/test";

// FI-006: Session logout clears Supabase session + sessionStorage + localStorage.
test.describe("FI-006 — Sign out", () => {
  test.fixme(true, "Requires authenticated session fixture");
  test("clears session and redirects to /auth/login", async ({ page, context }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /sign out|log ?out/i }).click();
    await expect(page).toHaveURL(/\/auth\/login/);
    const keys = await page.evaluate(() => Object.keys(window.sessionStorage));
    expect(keys.filter((k) => k.startsWith("geo-"))).toHaveLength(0);
  });
});
