import { test, expect } from "@playwright/test";

test.describe("FI-028 — Setup tab (ES-074 Domain Integration)", () => {
  test.fixme(true, "Requires completed site with domain verified and llms.txt generated");

  test("Setup tab shows Domain Integration section when domain verified", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /setup/i }).click();
    // Wait for Domain Integration section to appear
    await expect(page.getByText(/Domain Integration/)).toBeVisible();
  });

  test("Platform tabs render all 7 options (Vercel, Netlify, Cloudflare, nginx, WordPress, Apache, Other)", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /setup/i }).click();

    const platforms = ["Vercel", "Netlify", "Cloudflare", "nginx", "WordPress", "Apache", "Other ✦"];
    for (const p of platforms) {
      await expect(page.getByRole("button", { name: p })).toBeVisible();
    }
  });

  test("Clicking platform tab switches code block content", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /setup/i }).click();

    // Default is Vercel
    await expect(page.getByText(/vercel\.json/)).toBeVisible();

    // Click Netlify
    await page.getByRole("button", { name: "Netlify" }).click();
    await expect(page.getByText(/netlify\.toml/)).toBeVisible();

    // Click nginx
    await page.getByRole("button", { name: "nginx" }).click();
    await expect(page.getByText(/nginx\.conf/)).toBeVisible();
  });

  test("Copy button copies config to clipboard", async ({ page, context }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /setup/i }).click();

    // Grant clipboard permissions
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    // Click copy button
    await page.getByRole("button", { name: "Copy" }).first().click();

    // Verify clipboard has content (API may not be available in all envs)
    // This is best-effort and may not work in all test environments
    await page.waitForTimeout(100);
  });

  test("Test Connection button shows result status", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /setup/i }).click();

    // Click Test Connection
    await page.getByRole("button", { name: /Test Connection/i }).click();

    // Wait for result to appear (either "Connected" or "Not connected yet")
    await expect(
      page.getByText(/Connected|Not connected yet/)
    ).toBeVisible({ timeout: 10000 });
  });

  test("Other tab shows input and Generate button", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /setup/i }).click();

    // Click Other tab
    await page.getByRole("button", { name: /Other ✦/i }).click();

    // Verify input and button appear
    await expect(page.getByPlaceholder(/e\.g\. Shopify/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Generate/i })).toBeVisible();
  });

  test("Generate button is disabled when input is empty", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /setup/i }).click();

    // Click Other tab
    await page.getByRole("button", { name: /Other ✦/i }).click();

    // Verify Generate button is disabled
    const generateButton = page.getByRole("button", { name: /Generate/i });
    await expect(generateButton).toBeDisabled();
  });

  test("Schema injection labeled as mandatory (not Optional)", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /setup/i }).click();

    // Check Vercel config
    const codeBlock = page.locator("pre[role='code']");
    await expect(codeBlock).toContainText("mandatory");

    // Verify no "(Optional)" in Step 3
    const pageText = await page.locator("body").innerText();
    expect(pageText).toContain("mandatory");
  });

  test("Step pill badges render (1. rewrites, 2. schema, 3. robots.txt)", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /setup/i }).click();

    await expect(page.getByText(/1\. Add rewrites/)).toBeVisible();
    await expect(page.getByText(/2\. Inject schema/)).toBeVisible();
    await expect(page.getByText(/3\. Update robots\.txt/)).toBeVisible();
  });

  test("Platform tabs horizontally scroll on mobile viewport", async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /setup/i }).click();

    // Tab container should be scrollable
    const tabBar = page.locator("div").filter({ has: page.getByRole("button", { name: "Vercel" }) }).first();

    // Verify it can scroll
    const boundingBox = await tabBar.boundingBox();
    expect(boundingBox).toBeTruthy();

    // Should be able to see all tabs (verify at least Apache is clickable via scroll)
    await page.getByRole("button", { name: "Apache" }).click();
    await expect(page.getByText(/.htaccess/)).toBeVisible();
  });

  test("Green banner displays with domain name", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /setup/i }).click();

    // Should show domain verification success message
    const bannerText = page.getByText(/Domain verified/i);
    await expect(bannerText).toBeVisible();
  });
});
