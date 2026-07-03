/**
 * e2e/dashboard-token-expiry.spec.ts
 *
 * Regression for the May-2026 Vercel anomaly: a dashboard row's 3-second
 * poll hammered /api/sites/[id] indefinitely after the per-site
 * accessToken expired (route returns 401 + code: "TOKEN_EXPIRED"). The
 * fix in app/dashboard/DomainTableRow.tsx makes the row clear the
 * interval, toast once, and refuse to re-poll the same dead token.
 *
 * This spec proves the storm is fixed: with /api/sites/[fixture-id]
 * mocked to 401, the dashboard fires that endpoint at most once over a
 * 10-second window, and a "session expired" toast surfaces.
 */
import { test, expect, type Request } from "@playwright/test";
import { SITE_IDS } from "./fixtures/ids";

const TARGET_SITE_ID = SITE_IDS.midPipelineAudit; // seeded with pipeline_status="crawling"

test("dashboard polling: 401 from /api/sites/[id] stops the interval (no runaway storm)", async ({ page }) => {
  const callsToTarget: Request[] = [];

  await page.route(`**/api/sites/${TARGET_SITE_ID}**`, async (route, request) => {
    callsToTarget.push(request);
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "Unauthorized", code: "TOKEN_EXPIRED" }),
    });
  });

  await page.goto("/dashboard");
  await page.waitForLoadState("networkidle");

  // The mid-pipeline fixture renders as an active "scanning" row in the
  // dashboard table. Its DomainTableRow mounts and the polling effect
  // kicks off — without the fix this would fire every 3s forever.
  await page.waitForTimeout(10_000);

  // With the fix, the interval clears after the first 401. Allow up to 2
  // to absorb a one-off React strict-mode double-mount (dev only); the
  // pre-fix baseline would be 3+.
  expect(callsToTarget.length).toBeLessThanOrEqual(2);
  expect(callsToTarget.length).toBeGreaterThanOrEqual(1);

  // Toast surfaces the session-expired copy. Sonner renders into an
  // [aria-live] region; substring-match the user-facing text rather
  // than pinning structural selectors.
  await expect(page.getByText(/expired/i).first()).toBeVisible({ timeout: 5_000 });
});
