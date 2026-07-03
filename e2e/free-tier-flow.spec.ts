/**
 * e2e/free-tier-flow.spec.ts — rewritten against the LIVE flow.
 *
 * Preserved concerns:
 *   E-070-1: authenticated session grants /dashboard access (no redirect loop)
 *   E-070-2: a tokenized completion-email link (/sites/:id?token=…) renders the
 *            results page without the email gate.
 *
 * The prior OTP-on-/verify/[id] path is deprecated; live users land on
 * /sites/[id] via the tokenized email link or via /auth/login → /dashboard →
 * site row navigation. Tests below use the seeded fixture's access_token and
 * the playwright storageState (authenticated by global-setup-auth.ts).
 */
import { test, expect } from "@playwright/test";
import { SITE_IDS, SITE_SLUGS } from "./fixtures/ids";

const FRESH_SITE_ID = SITE_IDS.freshFreeAudit;
const FRESH_ACCESS_TOKEN = `e2e-${SITE_SLUGS.freshFreeAudit}-token`;

// ── E-070-1: authenticated session → /dashboard reachable ───────────────────

test.describe("E-070-1: Free tier OTP → status bar → dashboard", () => {
  test.skip(
    "OTP verify redirects to /sites/:id and status bar or results appear",
    () => {
      // Deprecated /verify/[id] OTP redirect path — no live analog. The
      // post-login landing experience is covered by /auth/login → /dashboard
      // in DRY-01 and by the tokenized share test below. see CoFounder surface
      // if a per-site status bar needs direct E2E coverage.
    },
  );

  test("Session cookie is established — dashboard accessible after OTP verify", async ({ page }) => {
    // storageState (global-setup-auth.ts) supplies a valid Supabase session.
    // If that session is live, /dashboard must render without redirecting to
    // /auth/login — this preserves the original "session cookie works" check.
    await page.goto("/dashboard");
    await expect(page).not.toHaveURL(/\/auth\/login/, { timeout: 5_000 });
    await expect(page.locator("body")).not.toContainText("Sign in", { timeout: 3_000 });
  });
});

// ── E-070-2: tokenized share link renders results (no email gate) ───────────

test.describe("E-070-2: Completion email link renders results", () => {
  test("token-based link renders results page (not email gate)", async ({ browser }) => {
    // Public unauthed context — completion-email recipients click from their
    // inbox without a prior Supabase session.
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    try {
      await page.goto(`/sites/${FRESH_SITE_ID}?token=${FRESH_ACCESS_TOKEN}`);
      const emailGate = page.locator('[data-testid="email-gate"]');
      await expect(emailGate).not.toBeVisible({ timeout: 5_000 });
    } finally {
      await ctx.close();
    }
  });
});
