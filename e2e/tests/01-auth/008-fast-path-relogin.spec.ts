import { test, expect } from "@playwright/test";

// FI-008: Fast-path re-login via cached token for a completed site.
test.describe("FI-008 — Fast-path re-login", () => {
  test.fixme(true, "Requires teamDomains fixture with completed site + cached token");
  test("entering known domain skips OTP and lands on /sites/[id]", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel(/domain|url/i).fill("example.com");
    await page.getByRole("button", { name: /audit|run/i }).click();
    // @scope-question FI-008: expected: direct navigation, no OTP modal
    await expect(page).toHaveURL(/\/sites\//);
  });
});
