import { test, expect } from "@playwright/test";

// Permanent regression floor. DO NOT DELETE.
// If this fails, the app is not serving HTTP at all — every other test is noise.
test("smoke: GET / returns 200 with a <title>", async ({ page }) => {
  const resp = await page.goto("/");
  expect(resp?.status()).toBe(200);
  const title = await page.title();
  expect(title.length).toBeGreaterThan(0);
});
