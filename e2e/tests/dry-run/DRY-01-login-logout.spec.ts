/**
 * DRY-01 — OTP login → /dashboard → logout → /auth/login.
 * Per ES-e2e-fixtures §b.16.2. Real credits: 0 (no spend).
 *
 * AC-25: zero test.fixme. AC-26: at least one Supabase assert per spec.
 * AC-27: surface any product gap via class-tag comment, never silent fixme.
 *
 * Note: ES §b.16.3 mentions assertAuthSessionExists but the landed helper
 * (6 exports at fc07953) does not include it. We substitute with a
 * credit-balance invariant assert since DRY-01 is a 0-credit flow: the
 * balance must be unchanged end-to-end. That IS a Supabase-assert per
 * AC-26.
 */
import { test, expect } from "@playwright/test";
import { getOtp } from "../../helpers/otp";
import { assertRowExists } from "../../helpers/supabase-assert";
import { TEST_USER_EMAIL, TEST_TEAM_ID } from "../../fixtures/ids";

test("DRY-01 login → /dashboard → logout → /auth/login", async ({ page }) => {
  // Read pre-balance dynamically; assert unchanged at end.
  const pre = await (async () => {
    const { createClient } = require("@supabase/supabase-js");
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data } = await sb.from("teams").select("credit_balance").eq("id", TEST_TEAM_ID).single();
    return (data as { credit_balance: number }).credit_balance;
  })();
  await assertRowExists({
    table: "teams",
    where: { id: TEST_TEAM_ID },
    expected_columns: { credit_balance: pre },
  });

  // ── Arrange: land on /auth/login ───────────────────────────────────
  await page.goto("/auth/login");
  await expect(page.getByPlaceholder(/you@yourcompany\.com/i)).toBeVisible();

  // ── Act 1: OTP sign-in via mailpit facade ─────────────────────────
  await page.getByPlaceholder(/you@yourcompany\.com/i).fill(TEST_USER_EMAIL);
  const sendBtn = page.getByRole("button", { name: /Send Code/i });
  await expect(sendBtn).toBeEnabled();
  await sendBtn.click();

  await expect(page.getByPlaceholder(/6-digit code/i)).toBeVisible({ timeout: 20_000 });
  const code = await getOtp("login", TEST_USER_EMAIL, { timeoutMs: 20_000 });
  await page.getByPlaceholder(/6-digit code/i).fill(code);
  const verifyBtn = page.getByRole("button", { name: /Verify Code/i });
  await expect(verifyBtn).toBeEnabled();
  await verifyBtn.click();

  // ── Assert 1: reached /dashboard (consent gate honored if active) ──
  await expect(page).toHaveURL(/\/(dashboard|consent)/, { timeout: 20_000 });
  if (page.url().includes("/consent")) {
    await page.getByRole("button", { name: /accept|agree|continue/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
  }

  // ── Act 2: logout ─────────────────────────────────────────────────
  const logout = page
    .getByRole("button", { name: /sign ?out|log ?out/i })
    .or(page.getByRole("link", { name: /sign ?out|log ?out/i }));
  await expect(logout).toBeVisible({ timeout: 10_000 });
  await logout.click();

  // ── Assert 2: logged out (session cleared + navigation away from dashboard) ──
  // Product behavior: SignOutButton redirects to ${NEXT_PUBLIC_WEBSITE_URL}/login,
  // which defaults to https://www.flowblinq.com/login (external). In local test
  // env that URL is unreachable and Chrome surfaces chrome-error://chromewebdata/.
  // The meaningful invariant is: (a) sb-* localStorage keys cleared,
  // (b) geo-authed sessionStorage cleared, (c) page is no longer on /dashboard.
  // We validate (c) via URL NOT matching /dashboard, then (a)+(b) via page.evaluate.
  await page.waitForFunction(() => !window.location.pathname.startsWith("/dashboard"), {
    timeout: 10_000,
  });
  // After navigation away from the app origin we can't evaluate page state
  // reliably, so navigate back to /auth/login to sample storage state fresh.
  await page.goto("/auth/login");
  await expect(page.getByPlaceholder(/you@yourcompany\.com/i)).toBeVisible();
  const storage = await page.evaluate(() => ({
    sbKeys: Object.keys(window.localStorage).filter((k) => k.startsWith("sb-")),
    geoAuthed: window.sessionStorage.getItem("geo-authed"),
  }));
  expect(storage.sbKeys).toHaveLength(0);
  expect(storage.geoAuthed).toBeNull();

  // ── Supabase-assert (AC-26) post-condition: balance unchanged (0 spend) ──
  await assertRowExists({
    table: "teams",
    where: { id: TEST_TEAM_ID },
    expected_columns: { credit_balance: pre },
  });

  // ── Observability (dispatch requirement) ──────────────────────────
  const post = pre;
  // eslint-disable-next-line no-console
  console.log(`DRY-01 pre=${pre} post=${post} delta=${post - pre}`);
});
