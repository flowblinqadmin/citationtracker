import { test, expect } from "@playwright/test";

// FI-005: Token expiry & auto-rotate on next API call.
test.describe("FI-005 — Token auto-refresh on /sites/[id]", () => {
  test.fixme(true, "Requires DB seed of expired accessToken on a completed site — backend fixture needed");
  test("expired token → 401 TOKEN_EXPIRED → rotate → new token in response", async ({ page }) => {
    // @scope-question FI-005: needs test-only endpoint or DB fixture to preset tokenExpiresAt<now
    await page.goto("/sites/SEEDED_SITE_ID?token=EXPIRED_TOKEN");
    await page.getByRole("button", { name: /re-run|regenerate/i }).click();
    await expect(page).not.toHaveURL(/401|error/);
  });
});
