import { test, expect } from "@playwright/test";
test.describe("FI-044 — Subscription plan checkout", () => {
  test.fixme(true, "Requires Stripe test price IDs for growth/annual");
  test("select Growth annual → Stripe subscription session", async ({ page, context }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /buy credits|upgrade/i }).click();
    await page.getByRole("tab", { name: /plans/i }).click();
    await page.getByRole("button", { name: /annual/i }).click();
    await page.getByRole("button", { name: /growth/i }).click();
    const popupPromise = context.waitForEvent("page");
    await page.getByRole("button", { name: /subscribe/i }).click();
    const stripe = await popupPromise;
    await stripe.waitForURL(/checkout\.stripe\.com/);
  });
});
