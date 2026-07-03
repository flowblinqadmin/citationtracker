import { test, expect } from "@playwright/test";
import { getOtpForEmail, clearMailpit } from "./helpers/mailpit";
import { deleteUserByEmail } from "./helpers/supabase-admin";

// ---------------------------------------------------------------------------
// /auth/login page tests — real auth against local Supabase
//
// Prerequisites: local Supabase running (supabase start + npm run db:push:local)
// OTP emails are captured by Mailpit at http://127.0.0.1:54324
// ---------------------------------------------------------------------------

/** Unique email per test to avoid Supabase per-email rate limits */
function testEmail(label: string) {
  return `login-${label}-${Date.now()}@test.local`;
}

test.describe("/auth/login page", () => {
  test.beforeEach(async () => {
    await clearMailpit();
  });

  test("renders sign-in form with email input and Send Code button", async ({
    page,
  }) => {
    await page.goto("/auth/login");

    await expect(page.locator("text=Sign in")).toBeVisible();
    await expect(page.locator("text=Enter your email")).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(
      page.locator('button:has-text("Send Code")'),
    ).toBeVisible();
  });

  test("Send Code delivers OTP email via local Supabase", async ({
    page,
  }) => {
    const email = testEmail("send");
    await deleteUserByEmail(email);

    await page.goto("/auth/login");
    await page.fill('input[type="email"]', email);
    await page.click('button:has-text("Send Code")');

    await expect(
      page.locator("text=Check your email"),
    ).toBeVisible({ timeout: 10_000 });

    // Verify OTP email was captured by Mailpit
    const otp = await getOtpForEmail(email);
    expect(otp).toMatch(/^\d{6}$/);

    await deleteUserByEmail(email);
  });

  test("after sending code, shows OTP input and Verify Code button", async ({
    page,
  }) => {
    const email = testEmail("otp-ui");
    await deleteUserByEmail(email);

    await page.goto("/auth/login");
    await page.fill('input[type="email"]', email);
    await page.click('button:has-text("Send Code")');

    await expect(
      page.locator("text=Check your email"),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`text=${email}`)).toBeVisible();
    await expect(
      page.locator('input[placeholder="6-digit code"]'),
    ).toBeVisible();
    await expect(
      page.locator('button:has-text("Verify Code")'),
    ).toBeVisible();

    // Verify Code disabled until 6 digits
    await expect(
      page.locator('button:has-text("Verify Code")'),
    ).toBeDisabled();
    await page.fill('input[placeholder="6-digit code"]', "123456");
    await expect(
      page.locator('button:has-text("Verify Code")'),
    ).toBeEnabled();

    await deleteUserByEmail(email);
  });

  test("wrong OTP shows error from Supabase", async ({ page }) => {
    const email = testEmail("wrong-otp");
    await deleteUserByEmail(email);

    await page.goto("/auth/login");
    await page.fill('input[type="email"]', email);
    await page.click('button:has-text("Send Code")');
    await expect(
      page.locator("text=Check your email"),
    ).toBeVisible({ timeout: 10_000 });

    await page.fill('input[placeholder="6-digit code"]', "000000");
    await page.click('button:has-text("Verify Code")');

    await expect(
      page.locator("text=Token has expired or is invalid"),
    ).toBeVisible({ timeout: 5_000 });
    expect(page.url()).toContain("/auth/login");

    await deleteUserByEmail(email);
  });

  // HP-272 consent-UI shipped — fresh user now sees inline TOS/EULA on
  // /auth/login after verifyOtp succeeds (the `requiresConsent` branch).
  // Accepting it POSTs /api/consent then navigates to the dashboard.
  test("correct OTP verifies, shows consent UI, accept proceeds to dashboard", async ({
    page,
  }) => {
    const email = testEmail("verify");
    await deleteUserByEmail(email);

    await page.goto("/auth/login");
    await page.fill('input[type="email"]', email);
    await page.click('button:has-text("Send Code")');
    await expect(
      page.locator("text=Check your email"),
    ).toBeVisible({ timeout: 10_000 });

    const otp = await getOtpForEmail(email);
    await page.fill('input[placeholder="6-digit code"]', otp);
    await page.click('button:has-text("Verify Code")');

    // Fresh user → consent screen
    await expect(page.locator("text=One last step")).toBeVisible({ timeout: 15_000 });
    const acceptBtn = page.locator('button:has-text("Accept and continue")');
    await expect(acceptBtn).toBeDisabled();
    await page.getByLabel(/accept terms of service and eula/i).check();
    await expect(acceptBtn).toBeEnabled();
    await acceptBtn.click();

    // Consent recorded → dashboard
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

    await deleteUserByEmail(email);
  });

  // HP-272 consent-UI shipped — redirectTo now survives the full chain:
  // email → OTP → inline consent → redirectTo destination.
  test("redirectTo param is preserved through verify + consent", async ({
    page,
  }) => {
    const email = testEmail("redirect");
    await deleteUserByEmail(email);

    await page.goto(
      "/auth/login?redirectTo=%2Fsites%2Fabc123%3Ftoken%3Dxyz",
    );
    await page.fill('input[type="email"]', email);
    await page.click('button:has-text("Send Code")');
    await expect(
      page.locator("text=Check your email"),
    ).toBeVisible({ timeout: 10_000 });

    const otp = await getOtpForEmail(email);
    await page.fill('input[placeholder="6-digit code"]', otp);
    await page.click('button:has-text("Verify Code")');

    // Inline consent gate then redirectTo destination
    await expect(page.locator("text=One last step")).toBeVisible({ timeout: 15_000 });
    await page.getByLabel(/accept terms of service and eula/i).check();
    await page.locator('button:has-text("Accept and continue")').click();

    await page.waitForURL(/\/sites\/abc123/, { timeout: 15_000 });

    await deleteUserByEmail(email);
  });

  test("'Use a different email' button resets to email form", async ({
    page,
  }) => {
    const email = testEmail("reset");
    await deleteUserByEmail(email);

    await page.goto("/auth/login");
    await page.fill('input[type="email"]', email);
    await page.click('button:has-text("Send Code")');
    await expect(
      page.locator("text=Check your email"),
    ).toBeVisible({ timeout: 10_000 });

    await page.click('button:has-text("Use a different email")');

    await expect(page.locator("text=Sign in")).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(
      page.locator('button:has-text("Send Code")'),
    ).toBeVisible();

    await deleteUserByEmail(email);
  });

  test("Supabase signInWithOtp rate-limit error is displayed (mocked)", async ({
    page,
  }) => {
    // Rate-limit test stays mocked — real Supabase 60s cooldown is too slow for tests
    const isProxyOtp = (url: URL) =>
      url.pathname === "/api/auth/proxy/otp";

    await page.route(isProxyOtp, async (route) => {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({
          msg: "For security purposes, you can only request this once every 60 seconds",
        }),
      });
    });

    await page.goto("/auth/login");
    // Intentionally non-canonical: test@example.com keeps the rate-limit
    // counter isolated from adjacent auth tests that use the canonical
    // adityanittoor+geotests@gmail.com. Canonicalizing here would collide.
    await page.fill('input[type="email"]', "test@example.com");
    await page.click('button:has-text("Send Code")');

    // Should show rate limit error, not switch to OTP view
    await expect(page.locator("text=60 seconds")).toBeVisible({
      timeout: 5_000,
    });
    expect(page.url()).toContain("/auth/login");
  });
});
