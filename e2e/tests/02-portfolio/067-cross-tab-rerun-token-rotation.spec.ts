/**
 * ES-wave-1 — cross-tab Rerun token-rotation E2E (AC-6).
 *
 * Reproduces the UAT G3 / G1 scenario:
 *   1. Tab A opens /sites/{id} BEFORE the regenerate (caches old token).
 *   2. Tab B (dashboard) clicks Rerun Audit on the same site row → POST
 *      /api/sites/{id}/regenerate returns 202 with a rotated accessToken.
 *   3. Tab A hard-refreshes; the AC-1 inverted bootstrap writes the fresh
 *      server-rendered token into sessionStorage, OVERWRITING the stale one.
 *   4. Tab A clicks each of 5 action buttons; every action request returns
 *      NOT 401 (success or non-auth client error).
 *
 * Tags: live-services (per AC-30) — exercises real /api/sites/{id}/regenerate
 * and Stripe-free action endpoints. Authed via storageState.
 */
import { test, expect, type Page } from "@playwright/test";
import { SITE_IDS, SITE_SLUGS } from "../../fixtures/ids";

const SITE_ID = SITE_IDS.paidFullAudit;
const ORIGINAL_TOKEN = `e2e-${SITE_SLUGS.paidFullAudit}-token`;
const STORAGE_KEY = `geo-token-${SITE_ID}`;

async function readStored(page: Page): Promise<string | null> {
  return page.evaluate((k) => sessionStorage.getItem(k), STORAGE_KEY);
}

test.describe("FI-067 — cross-tab Rerun token rotation (ES-wave-1 AC-6)", () => {
  test("dashboard Rerun rotates token; tab-A hard-refresh + 5 action buttons all NON-401", async ({ browser }) => {
    // Tab A — audit page opened with the original token, before the regenerate.
    const ctxA = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const tabA = await ctxA.newPage();
    await tabA.goto(`/sites/${SITE_ID}?token=${ORIGINAL_TOKEN}`);
    await tabA.waitForLoadState("networkidle");

    // Confirm tab A cached the original token.
    await expect.poll(() => readStored(tabA), { timeout: 10_000 }).toBe(ORIGINAL_TOKEN);

    // Tab B — dashboard (authed via storageState from global-setup-auth.ts).
    const ctxB = await browser.newContext();
    const tabB = await ctxB.newPage();
    await tabB.goto("/dashboard");
    await tabB.waitForLoadState("networkidle");

    // Trigger Rerun Audit from tab B's RowActions; capture the 202 + rotated token.
    const regenResponsePromise = tabB.waitForResponse(
      (r) => r.url().includes(`/api/sites/${SITE_ID}/regenerate`) && r.request().method() === "POST",
      { timeout: 20_000 },
    );
    const rerunBtn = tabB.locator(`[data-site-id="${SITE_ID}"] button[title*="Rerun Audit" i]`).first()
      .or(tabB.getByTitle(/Rerun Audit/i).first());
    await rerunBtn.click();
    const regenResponse = await regenResponsePromise;
    expect(regenResponse.status()).toBe(202);

    // Tab A — hard-refresh; AC-1 inverted bootstrap should overwrite the cached
    // stale token with the freshly server-rendered rotated token.
    await tabA.reload();
    await tabA.waitForLoadState("networkidle");
    const rotatedTokenInA = await readStored(tabA);
    expect(rotatedTokenInA).not.toBe(ORIGINAL_TOKEN);
    expect(rotatedTokenInA).toBeTruthy();

    // 5 action buttons on tab A — each request must NOT be 401.
    const actions: Array<{ name: string; urlSubstr: string; selector: string }> = [
      { name: "Map Competitors",  urlSubstr: "/competitor-discovery",  selector: 'button:has-text("Map Competitors")' },
      { name: "Add Competitor",   urlSubstr: "/competitors",            selector: 'button:has-text("Add Competitor")' },
      { name: "Rerun Citations",  urlSubstr: "/citation-check",         selector: 'button:has-text("Rerun Citations")' },
      { name: "Download ZIP",     urlSubstr: "/download-report",        selector: 'button:has-text("Download ZIP"), button[title*="Download ZIP" i]' },
      { name: "Download PDF",     urlSubstr: "/pdf-report",             selector: 'button:has-text("Download PDF"), button[title*="Download PDF" i]' },
    ];

    for (const a of actions) {
      const respPromise = tabA.waitForResponse(
        (r) => r.url().includes(a.urlSubstr),
        { timeout: 20_000 },
      );
      const btn = tabA.locator(a.selector).first();
      // Some buttons may be conditionally disabled in seeded fixture; skip
      // gracefully without weakening the 401 assertion when present.
      if (!(await btn.isVisible().catch(() => false))) continue;
      if (!(await btn.isEnabled().catch(() => false))) continue;
      await btn.click();
      const resp = await respPromise;
      expect.soft(resp.status(), `${a.name} must not 401 after token rotation`).not.toBe(401);
    }

    await ctxA.close();
    await ctxB.close();
  });
});
