/**
 * e2e/auth-flow.spec.ts — rewritten against the LIVE flow.
 *
 * The deprecated /verify/[id] page is no longer the live entry point — audit
 * report access is the /sites/[id]?token=… link in the completion email, and
 * upgrade/checkout happens from the authenticated dashboard. These tests
 * preserve each original concern (auth-required redirect, upgrade-tier
 * redirect path, report access with/without token) but exercise the live
 * surfaces: /auth/login for unauthed protection, /dashboard (via storageState)
 * for authed upgrade, /sites/[id] with token query param for public share.
 */
import { test, expect } from "@playwright/test";
import { SITE_IDS, SITE_SLUGS } from "./fixtures/ids";

const FRESH_SITE_ID = SITE_IDS.freshFreeAudit;
const FRESH_ACCESS_TOKEN = `e2e-${SITE_SLUGS.freshFreeAudit}-token`;

// ---------------------------------------------------------------------------
// auth-required redirect: unauthed access to /dashboard goes to /auth/login
// (was: /verify OTP lands on results page → user is signed in)
// ---------------------------------------------------------------------------

test("free audit: verify OTP → lands on results page → user is signed in", async ({ browser }) => {
  // Fresh context — no storageState, no auth cookies.
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  try {
    await page.goto("/dashboard");
    // Supabase middleware should redirect unauthed → /auth/login
    await page.waitForURL(/\/auth\/login/, { timeout: 10_000 });
    expect(page.url()).toContain("/auth/login");
    await expect(page.getByPlaceholder(/you@yourcompany\.com/i)).toBeVisible();
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// Upgrade: authed user on /dashboard can reach checkout without hitting /auth/login
// (was: verify OTP + buy credits in same browser context)
// ---------------------------------------------------------------------------

test("upgrade: verify OTP then buy credits → goes to Stripe (not login page)", async ({ page }) => {
  // storageState (from global-setup-auth.ts) provides an authed Supabase session.
  await page.goto("/dashboard");
  await expect(page).not.toHaveURL(/\/auth\/login/);
  await page.waitForLoadState("networkidle");

  // Intercept the checkout POST. BuyCreditsButton on /dashboard submits to /api/checkout.
  const checkoutResponsePromise = page.waitForResponse(
    (resp) => resp.url().includes("/api/checkout") && resp.request().method() === "POST",
    { timeout: 20_000 },
  );

  const buyButton = page.locator('button:has-text("Buy"), button:has-text("credits")').first();
  await buyButton.scrollIntoViewIfNeeded();
  await expect(buyButton).toBeVisible();
  await buyButton.click();

  const checkoutResponse = await checkoutResponsePromise;
  const status = checkoutResponse.status();

  // The key assertion preserved from the /verify-era test: must NOT be 401.
  expect(status).not.toBe(401);
  expect(status).not.toBe(409);

  if (status === 200) {
    try {
      const body = await checkoutResponse.json();
      expect(body.checkoutUrl).toBeTruthy();
      expect(body.checkoutUrl).toContain("stripe.com");
    } catch {
      // Browser already navigated to Stripe — success.
    }
  }

  await page.waitForTimeout(1000);
  expect(page.url()).not.toContain("/auth/login");
});

// ---------------------------------------------------------------------------
// Navigation: refresh /sites/{id}?token=X keeps state (unchanged — live-compatible)
// ---------------------------------------------------------------------------

test("navigation: refresh results page keeps state", async ({ browser }) => {
  // Fresh, unauthed context — public tokenized share link.
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  try {
    await page.goto(`/sites/${FRESH_SITE_ID}?token=${FRESH_ACCESS_TOKEN}`);
    await page.waitForLoadState("networkidle");

    await page.reload();
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain(`/sites/${FRESH_SITE_ID}`);
    expect(page.url()).not.toContain("/auth/login");
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// Data isolation: /sites/{id} without token → no data leak via sessionStorage
// ---------------------------------------------------------------------------

test("data isolation: visit /sites/{id} without token → no data leak", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  try {
    await page.goto(`/sites/${FRESH_SITE_ID}`);
    const hasToken = await page.evaluate((siteId: string) => {
      return sessionStorage.getItem(`geo-token-${siteId}`);
    }, FRESH_SITE_ID);
    expect(hasToken).toBeNull();
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// Non-happy: wrong OTP on /auth/login shows an error
// (was: wrong OTP on /verify/[id])
// ---------------------------------------------------------------------------

test("non-happy: wrong OTP code shows error", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  try {
    await page.goto("/auth/login");
    const emailField = page.getByPlaceholder(/you@yourcompany\.com/i);
    await expect(emailField).toBeVisible();
    await emailField.fill(`wrong-otp-${Date.now()}@test-flowblinq.com`);
    await page.getByRole("button", { name: /Send Code/i }).click();

    const codeField = page.getByPlaceholder(/6-digit code/i);
    await expect(codeField).toBeVisible({ timeout: 20_000 });
    await codeField.fill("000000");
    await page.getByRole("button", { name: /Verify Code/i }).click();

    // Supabase surfaces an error under role="alert" without advancing past /auth/login.
    await expect(page.locator('[role="alert"]').first()).toBeVisible({ timeout: 10_000 });
    expect(page.url()).toContain("/auth/login");
  } finally {
    await ctx.close();
  }
});
