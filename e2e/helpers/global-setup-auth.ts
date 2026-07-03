/**
 * e2e/helpers/global-setup-auth.ts — storageState bootstrap.
 *
 * Chains with the existing DB-seed globalSetup (e2e/global-setup.ts):
 *   1. First delegates to the original globalSetup — loads ~/.mailenv,
 *      verifies Supabase + Mailpit reachable, runs db:seed:e2e (which
 *      provisions auth.users for TEST_USER_ID).
 *   2. Then performs ONE Playwright-driven OTP login using the seeded
 *      TEST_USER_EMAIL and saves the resulting cookies + storage to
 *      STORAGE_STATE_PATH. Every spec (except opt-outs like DRY-01
 *      which exercises login itself) reuses this state.
 *
 * Not wired to run on every spec — only once per `playwright test`
 * invocation. Side-effect: writes e2e/.playwright-storage-state.json
 * (gitignored).
 */

import { chromium, type FullConfig } from "@playwright/test";
import originalGlobalSetup from "../global-setup";
import { loginViaOtp } from "./login";
import { TEST_USER_EMAIL } from "../fixtures/ids";
import { STORAGE_STATE_PATH } from "./storage-state";

export default async function globalSetupAuth(config: FullConfig): Promise<void> {
  // Step 1: delegate to original globalSetup (env load + reachability + seed).
  const orig = originalGlobalSetup as unknown as (c: FullConfig) => Promise<void>;
  await orig(config);

  // Step 2: perform one OTP login; snapshot cookies + storage.
  const baseURL = config.projects[0]?.use?.baseURL ?? "http://localhost:3000";
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await loginViaOtp(page, TEST_USER_EMAIL);
    await context.storageState({ path: STORAGE_STATE_PATH });
    console.log(`[global-setup-auth] storageState saved to ${STORAGE_STATE_PATH}`);
  } finally {
    await browser.close();
  }
}
