import { test, expect } from "@playwright/test";
test.describe("FI-033 — Share report link", () => {
  test.fixme(true, "Requires completed site + paid/pro tier");
  test("share → /report/{shareToken} publicly readable", async ({ page, context }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("button", { name: /share/i }).click();
    const link = await page.getByRole("link", { name: /\/report\// }).getAttribute("href");
    expect(link).toMatch(/\/report\/[A-Za-z0-9_-]+/);
    await context.clearCookies();
    const fresh = await context.newPage();
    const resp = await fresh.goto(link!);
    expect(resp?.status()).toBe(200);
  });
});
