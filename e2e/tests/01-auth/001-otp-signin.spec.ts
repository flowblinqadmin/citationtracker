import { test, expect } from "@playwright/test";
import { getOtp } from "../../helpers/otp";

// FI-001: Sign in via OTP (new user). Selector + UX patterns per
// ES-e2e-fixtures §b.15.2 (placeholders) and §b.15.4 (FI-001 native HTML5
// email validation — AC-22, HP-263).
test.describe("FI-001 — OTP signin (new user)", () => {
  const email = "adityanittoor+geotests@gmail.com";

  test("happy path: email → send code → verify → redirect to /dashboard or /consent", async ({ page }) => {
    await page.goto("/auth/login");
    const emailInput = page.getByPlaceholder(/you@yourcompany\.com/i);
    await expect(emailInput).toBeVisible();
    await emailInput.fill(email);

    const sendBtn = page.getByRole("button", { name: /send code/i });
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();

    const code = await getOtp("login", email);
    await page.getByPlaceholder(/6-digit code/i).fill(code);

    const verifyBtn = page.getByRole("button", { name: /verify/i });
    await expect(verifyBtn).toBeEnabled();
    await verifyBtn.click();

    await expect(page).toHaveURL(/\/(dashboard|consent)/);
  });

  // AC-22 (HP-263): /auth/login uses native HTML5 <input type="email" required>
  // for format validation. The Send Code button stays enabled when the input
  // is non-empty (even for "not-an-email") because `disabled={loading || !email.trim()}`
  // gates on emptiness, not validity. The browser's own constraint validation
  // blocks submit. Assert input.validity.valid=false — NOT toBeDisabled() and
  // NOT role="alert" text.
  test("invalid email format is rejected by native HTML5 validation", async ({ page }) => {
    await page.goto("/auth/login");
    const emailInput = page.getByPlaceholder(/you@yourcompany\.com/i);
    await emailInput.fill("not-an-email");
    await expect(emailInput).toHaveJSProperty("validity.valid", false);
  });
});
