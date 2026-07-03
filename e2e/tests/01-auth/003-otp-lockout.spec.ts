import { test, expect } from "@playwright/test";

// FI-003: OTP lockout after 5 wrong attempts (HP-240 timing equalization).
// Selector patterns per ES-e2e-fixtures §b.15.2 (placeholders + enabled
// gate + role=alert error surface).
test.describe("FI-003 — OTP lockout (5 wrong attempts)", () => {
  // RETIRED Class E Phase C chain: local Supabase lockout policy may
  // diverge from prod. Revisit when staging e2e exists.
  test.skip("6th wrong attempt returns generic rate-limit error", async ({ page }) => {
    const email = "adityanittoor+geotests@gmail.com";
    await page.goto("/auth/login");
    await page.getByPlaceholder(/you@yourcompany\.com/i).fill(email);

    const sendBtn = page.getByRole("button", { name: /send code/i });
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();

    for (let i = 0; i < 5; i++) {
      await page.getByPlaceholder(/6-digit code/i).fill("000000");
      const vbtn = page.getByRole("button", { name: /verify/i });
      await expect(vbtn).toBeEnabled();
      await vbtn.click();
      await page.waitForTimeout(500);
    }

    await page.getByPlaceholder(/6-digit code/i).fill("111111");
    const finalVerify = page.getByRole("button", { name: /verify/i });
    await expect(finalVerify).toBeEnabled();
    await finalVerify.click();

    await expect(page.locator('[role="alert"]').first()).toContainText(
      /invalid or expired|too many|try again later/i,
    );
  });
});
