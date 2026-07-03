import { test, expect } from "@playwright/test";
// CORRECTION Q7: Stripe one-time checkout hardcoded USD; no region geo-detection.
test.describe("FI-043 — One-time credit purchase (Stripe USD)", () => {
  test.fixme(true, "Requires Stripe test keys + authenticated user");
  test("select pack → checkout → Stripe session in USD", async ({ page, context }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /buy credits|upgrade/i }).click();
    await page.getByRole("tab", { name: /credits/i }).click();
    const popupPromise = context.waitForEvent("page");
    await page.getByRole("button", { name: /checkout/i }).click();
    const stripe = await popupPromise;
    await stripe.waitForURL(/checkout\.stripe\.com/);
    // @scope-question FI-043: assert USD currency in Stripe page copy
  });
});
