import { defineConfig, devices } from "@playwright/test";

/**
 * Standalone config for the beacon mobile-performance harness.
 *
 * Deliberately independent of the main playwright.config.ts: NO globalSetup,
 * NO local-Supabase requirement, NO dev server. The harness builds its own
 * mock customer page with page.setContent() and runs fully offline, so it can
 * be executed anywhere with:
 *
 *   npx playwright test -c e2e/perf/playwright-perf.config.ts
 *
 * Mobile emulation (Pixel 5) + 4x CPU throttling (applied per-test via CDP)
 * reproduce the weak-mobile-CPU conditions from the 2026-06 jank report.
 */
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    headless: true,
    // sendBeacon/fetch are stubbed in-page; no real network is used.
    baseURL: "about:blank",
  },
  projects: [
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"] },
    },
  ],
});
