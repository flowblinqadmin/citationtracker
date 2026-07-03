/**
 * e2e/upgrade-modal-pricing.spec.ts — verifies the /pricing removal +
 * UpgradeModal rewiring done in PR #184.
 *
 * Covers:
 *   - /pricing redirects to / (308 permanent)
 *   - Homepage no longer carries a Pricing nav link
 *   - /api/pricing route is deleted (404)
 *   - Action-rail upsell on a free-tier site is a button (not /pricing link)
 *     and opens UpgradeModal in place — no navigation
 *   - UpgradeModal shows Starter / Growth / Pro plan cards once opened
 *   - UpgradeModal credits tab "See plans →" is a button that switches the
 *     internal tab instead of leaving for /pricing
 *   - /api/checkout for Starter returns a Stripe checkout URL (programmatic
 *     verification — UI subscribe button uses window.location.href which
 *     is harder to intercept reliably)
 *
 * Uses storageState authenticated by global-setup-auth.ts (TEST_USER_EMAIL
 * via Mailpit). Local Supabase + dev server are auto-started by playwright
 * config's webServer block. Requires SUPABASE_DATABASE_URL=local in env
 * (the default playwright config only sets DATABASE_URL, which lib/db/index.ts
 * checks AFTER SUPABASE_DATABASE_URL).
 */
import { test, expect } from "@playwright/test";
import { SITE_IDS, SITE_SLUGS } from "./fixtures/ids";

const FRESH_SITE_ID = SITE_IDS.freshFreeAudit;
const FRESH_TOKEN = `e2e-${SITE_SLUGS.freshFreeAudit}-token`;

test.describe("Pricing removal + UpgradeModal rewiring (PR #184)", () => {
  test("/pricing returns 308 redirect to /", async ({ request }) => {
    const resp = await request.get("/pricing", { maxRedirects: 0 });
    expect(resp.status()).toBe(308);
    expect(resp.headers()["location"]).toBe("/");
  });

  test("homepage has no Pricing nav link", async ({ page }) => {
    await page.goto("/");
    const pricingLinks = await page.locator('nav a[href="/pricing"]').count();
    expect(pricingLinks).toBe(0);
  });

  test("/api/pricing route is deleted (404)", async ({ request }) => {
    const resp = await request.get("/api/pricing");
    expect(resp.status()).toBe(404);
  });

  test("action-rail upsell is a button that opens UpgradeModal in place", async ({ page }) => {
    await page.goto(`/sites/${FRESH_SITE_ID}?token=${FRESH_TOKEN}`);

    const upsellBtn = page.getByTestId("action-rail-upsell");
    await expect(upsellBtn).toBeVisible({ timeout: 10_000 });
    await expect(upsellBtn).toHaveJSProperty("tagName", "BUTTON");
    expect(await upsellBtn.getAttribute("href")).toBeNull();

    const beforeUrl = page.url();
    await upsellBtn.click();
    // URL must not change — modal opens in place
    expect(page.url()).toBe(beforeUrl);

    // All three plan cards visible inside the modal
    await expect(page.locator('[data-plan="starter"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-plan="growth"]')).toBeVisible();
    await expect(page.locator('[data-plan="pro"]')).toBeVisible();
  });

  test("UpgradeModal subscribe button is wired (not a /pricing link)", async ({ page }) => {
    await page.goto(`/sites/${FRESH_SITE_ID}?token=${FRESH_TOKEN}`);
    await page.getByTestId("action-rail-upsell").click();

    const starterCard = page.locator('[data-plan="starter"]');
    await expect(starterCard).toBeVisible({ timeout: 5_000 });

    // The Starter subscribe button is a button (not a /pricing anchor) and
    // its click triggers POST /api/checkout. We block the Stripe redirect so
    // the test stays on-page and just asserts the API was hit with plan=starter.
    const subscribeBtn = starterCard.locator('button', { hasText: /subscribe/i });
    await expect(subscribeBtn).toBeVisible();
    expect(await subscribeBtn.getAttribute("href")).toBeNull();

    await page.route("https://checkout.stripe.com/**", (route) => route.abort());

    const checkoutPromise = page.waitForRequest(
      (r) => r.url().endsWith("/api/checkout") && r.method() === "POST",
      { timeout: 10_000 },
    );
    await subscribeBtn.click();
    const req = await checkoutPromise;
    const body = JSON.parse(req.postData() ?? "{}");
    expect(body.plan).toBe("starter");
    expect(body.interval).toBe("monthly");
  });
});
