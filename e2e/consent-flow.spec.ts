/**
 * e2e/consent-flow.spec.ts — Inline TOS/EULA consent on /auth/login.
 *
 * Live consent gate lives at app/auth/login/page.tsx — after Supabase OTP
 * verify, LoginForm calls GET /api/consent. When hasConsent=false the page
 * swaps into the consent UI (checkbox + "Accept and continue"). On accept,
 * the page POSTs /api/consent and navigates to /dashboard (or redirectTo).
 *
 * Coverage:
 *   CF-1  New user: OTP verify shows consent UI, accept proceeds to /dashboard
 *   CF-2  Returning user (consent_records row present): OTP verify skips
 *         consent UI and goes straight to /dashboard
 *   CF-3  Consent UI: Accept button is disabled until the checkbox is checked
 */
import { test, expect } from "@playwright/test";
import { getOtpForEmail, clearMailpit } from "./helpers/mailpit";
import { deleteUserByEmail, getAdminClient } from "./helpers/supabase-admin";

// Must match CURRENT_TOS_VERSION / CURRENT_EULA_VERSION in lib/config.ts —
// the /api/consent GET handler joins on (user_id, tos_version, eula_version)
// so a mismatched version here would always look like "needs consent".
const TOS_VERSION = "1.0-2026-04-02";
const EULA_VERSION = "1.0-2026-04-02";

function consentEmail(label: string) {
  return `consent-${label}-${Date.now()}@test.local`;
}

async function seedConsent(email: string): Promise<void> {
  const admin = getAdminClient();
  const { data: list } = await admin.auth.admin.listUsers();
  const u = list?.users.find((x) => x.email === email);
  if (!u) throw new Error(`[seedConsent] user not found for ${email}`);

  const { error } = await admin.from("consent_records").insert({
    id: `seed-${u.id}`,
    user_id: u.id,
    email: email,
    tos_version: TOS_VERSION,
    eula_version: EULA_VERSION,
    ip_address: "127.0.0.1",
    user_agent: "playwright-seed",
  } as never);
  if (error) throw new Error(`[seedConsent] insert failed: ${error.message}`);
}

test.describe("TOS/EULA Consent Flow", () => {
  test.beforeEach(async () => {
    await clearMailpit();
  });

  test("CF-1: new user — OTP verify shows consent UI, accept proceeds to /dashboard", async ({
    page,
  }) => {
    const email = consentEmail("new");
    await deleteUserByEmail(email);

    await page.goto("/auth/login");
    await page.fill('input[type="email"]', email);
    await page.click('button:has-text("Send Code")');
    await expect(page.locator("text=Check your email")).toBeVisible({ timeout: 10_000 });

    const otp = await getOtpForEmail(email);
    await page.fill('input[placeholder="6-digit code"]', otp);
    await page.click('button:has-text("Verify Code")');

    await expect(page.locator("text=One last step")).toBeVisible({ timeout: 15_000 });
    await page.getByLabel(/accept terms of service and eula/i).check();
    await page.locator('button:has-text("Accept and continue")').click();

    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

    await deleteUserByEmail(email);
  });

  test("CF-2: returning user (consent row seeded) — OTP verify skips consent, lands on /dashboard", async ({
    page,
  }) => {
    const email = consentEmail("returning");
    await deleteUserByEmail(email);

    // Materialize the auth.users row via signInWithOtp + shouldCreateUser
    await page.goto("/auth/login");
    await page.fill('input[type="email"]', email);
    await page.click('button:has-text("Send Code")');
    await expect(page.locator("text=Check your email")).toBeVisible({ timeout: 10_000 });

    // Seed consent now that auth.users row exists
    await seedConsent(email);

    const otp = await getOtpForEmail(email);
    await page.fill('input[placeholder="6-digit code"]', otp);
    await page.click('button:has-text("Verify Code")');

    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
    await expect(page.locator("text=One last step")).not.toBeVisible();

    await deleteUserByEmail(email);
  });

  test("CF-3: consent UI Accept button is disabled until the checkbox is checked", async ({
    page,
  }) => {
    const email = consentEmail("disabled");
    await deleteUserByEmail(email);

    await page.goto("/auth/login");
    await page.fill('input[type="email"]', email);
    await page.click('button:has-text("Send Code")');
    await expect(page.locator("text=Check your email")).toBeVisible({ timeout: 10_000 });

    const otp = await getOtpForEmail(email);
    await page.fill('input[placeholder="6-digit code"]', otp);
    await page.click('button:has-text("Verify Code")');

    await expect(page.locator("text=One last step")).toBeVisible({ timeout: 15_000 });

    const acceptBtn = page.locator('button:has-text("Accept and continue")');
    await expect(acceptBtn).toBeDisabled();
    await page.getByLabel(/accept terms of service and eula/i).check();
    await expect(acceptBtn).toBeEnabled();
    await page.getByLabel(/accept terms of service and eula/i).uncheck();
    await expect(acceptBtn).toBeDisabled();

    await deleteUserByEmail(email);
  });
});
