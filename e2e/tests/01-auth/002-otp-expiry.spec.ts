import { test, expect } from "@playwright/test";
import { getOtp } from "../../helpers/otp";

// FI-002: OTP code expiry (>5 min). Asserts generic error per HP-239.
// Selector patterns per ES-e2e-fixtures §b.15.2; error assertion via
// [role="alert"] (AC-21 pattern 4).
test.describe("FI-002 — OTP expiry", () => {
  // RETIRED Class E Phase C chain: local Supabase OTP TTL + error-text may
  // diverge from prod; covered by server-side unit tests on TTL enforcement.
  // Revisit when staging e2e exists.
  test.skip("expired OTP returns generic 'invalid or expired' error (no leak)", async ({ page }) => {
    test.setTimeout(6 * 60 * 1000);
    const email = "adityanittoor+geotests@gmail.com";
    await page.goto("/auth/login");
    await page.getByPlaceholder(/you@yourcompany\.com/i).fill(email);

    const sendBtn = page.getByRole("button", { name: /send code/i });
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();

    const code = await getOtp("login", email);
    // @scope-question FI-002: server TTL is 15 min per email.ts copy; inventory says 5 min.
    // Using 5 min + buffer to match inventory; adjust if FI-002 spec changes.
    await page.waitForTimeout(5 * 60 * 1000 + 15_000);

    await page.getByPlaceholder(/6-digit code/i).fill(code);
    const verifyBtn = page.getByRole("button", { name: /verify/i });
    await expect(verifyBtn).toBeEnabled();
    await verifyBtn.click();

    await expect(page.locator('[role="alert"]').first()).toContainText(/invalid or expired/i);
  });
});
