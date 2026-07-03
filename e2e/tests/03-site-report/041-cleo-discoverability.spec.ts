import { test, expect } from "@playwright/test";

test.describe("FI-041 — Cleo discoverability (Phase 7)", () => {
  test.fixme(true, "Requires seeded paid site with verified domain, low pillar, platformDetected='vercel'");

  test("labelled pill 'Ask Cleo' is visible on the site report", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    const pill = page.getByTestId("cleo-pill");
    await expect(pill).toBeVisible();
    await expect(pill).toContainText(/Ask Cleo/);
  });

  test("inline 'Ask Cleo about <platform>' CTA appears in the Setup tab", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /setup/i }).click();
    const cta = page.getByTestId("ask-cleo-about-platform");
    await expect(cta).toBeVisible();
    await expect(cta).toContainText(/Ask Cleo about vercel/i);
  });

  test("clicking the platform CTA opens the chat panel and seeds the install question", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /setup/i }).click();
    await page.getByTestId("ask-cleo-about-platform").click();
    // Seed text appears in either the input or as a freshly sent user bubble (autoSend=true).
    await expect(
      page.getByText(/How do I install FlowBlinq on vercel/i).first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test("contextual nudge fires when user opens the Setup tab (peek bubble)", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /setup/i }).click();
    const peek = page.getByTestId("cleo-peek");
    await expect(peek).toBeVisible({ timeout: 3000 });
    await expect(peek).toContainText(/vercel/i);
  });

  test("Test Connection failure exposes 'Ask Cleo to debug' inline CTA", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /setup/i }).click();
    await page.getByRole("button", { name: /Test Connection/i }).click();
    // Wait for negative result (test fixture must NOT have llms.txt verified).
    await expect(page.getByText(/Not connected yet/i)).toBeVisible({ timeout: 10_000 });
    const debug = page.getByTestId("ask-cleo-debug-connection");
    await expect(debug).toBeVisible();
  });
});
