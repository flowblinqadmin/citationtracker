import { test, expect } from "@playwright/test";

// FI-010: Session persists across page refresh via Supabase localStorage.
test.describe("FI-010 — Session persistence across refresh", () => {
  test.fixme(true, "Requires authenticated session fixture");
  test("F5 on /dashboard keeps user logged in", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText(/credits?/i)).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText(/credits?/i)).toBeVisible();
  });
});
