import { defineConfig, devices } from "@playwright/test";

// Local Supabase env vars — well-known defaults, safe in code.
// These override .env.local so E2E tests run against local Supabase.
// STRIPE_WEBHOOK_SECRET: deterministic test value so billing-lifecycle.spec.ts
// can sign webhook events with a known secret (must be ≥32 chars for Stripe SDK).
// STRIPE_SECRET_KEY: dummy test-mode key so new Stripe(key) doesn't reject.
export const E2E_STRIPE_WEBHOOK_SECRET = "whsec_e2e_test_secret_local_32chars_ok";
const LOCAL_SUPABASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  // SUPABASE_DATABASE_URL: highest priority in lib/db/index.ts — guarantees
  // the dev server connects to local Supabase (port 54322) even if Next.js
  // .env.local loading overrides DATABASE_URL at runtime.
  SUPABASE_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  NEXT_PUBLIC_SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
  SUPABASE_SERVICE_ROLE_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  // QSTASH_CALLBACK_BASE is load-bearing: live QStash publishes against this
  // URL, which must be publicly reachable (cloudflared tunnel → localhost:3000).
  // Operator sets it in .env.local or shell env (see docs/local-dev-qstash.md);
  // we pass through the existing value rather than hard-coding a stale tunnel.
  // Falls back to localhost so a non-tunneled run fails loudly in QStash-land
  // rather than silently publishing against an empty base.
  QSTASH_CALLBACK_BASE: process.env.QSTASH_CALLBACK_BASE ?? "http://127.0.0.1:3000",
  PIPELINE_CALLBACK_URL: process.env.PIPELINE_CALLBACK_URL ?? process.env.QSTASH_CALLBACK_BASE ?? "http://127.0.0.1:3000",
  // Preserved per RC3 42c1d35 — pipeline-stage auth verify accepts Bearer
  // ${CRON_SECRET} as a fallback to QStash signature verification. The local
  // dev crontab + LOCAL_PIPELINE path rely on it.
  CRON_SECRET: process.env.CRON_SECRET ?? "e2e-local-cron-secret-must-be-32chars!!",
  // Billing lifecycle E2E: known webhook secret for signed event delivery.
  // Must match E2E_STRIPE_WEBHOOK_SECRET above. Stripe SDK requires ≥32 chars.
  // NOTE: STRIPE_SECRET_KEY is intentionally NOT overridden here so the
  // auth-flow "upgrade → Stripe checkout" test can use the real key from
  // .env.local. Billing-lifecycle tests post signed webhook events only —
  // they never call the Stripe API — so no real key is needed there.
  STRIPE_WEBHOOK_SECRET: E2E_STRIPE_WEBHOOK_SECRET,
};

// Set env vars for the test process (e2e/helpers/db.ts checks process.env first)
Object.assign(process.env, LOCAL_SUPABASE_ENV);

// Shastri directive corr 1d428e6c: playwright heavy artifacts relocated to
// /home/aditya/data (88G free) to preempt root-disk pressure during Phase B.
// Portable: honor PW_ARTIFACT_ROOT, else use the Linux CI path when it exists,
// else fall back to a repo-local dir so the suite runs on any machine (macOS).
import { existsSync } from "node:fs";
const ARTIFACT_ROOT =
  process.env.PW_ARTIFACT_ROOT ??
  (existsSync("/home/aditya/data") ? "/home/aditya/data/flowblinq-artifacts" : "./.playwright-artifacts");

export default defineConfig({
  testDir: "./e2e",
  // Chains: env-load + Supabase reachability + seed (original globalSetup)
  // → OTP-bootstrap + storageState snapshot. Live external services after
  // the mock-server retirement (see docs/local-dev-qstash.md).
  globalSetup: "./e2e/helpers/global-setup-auth.ts",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: `${ARTIFACT_ROOT}/playwright-report`, open: "never" }],
  ],
  outputDir: `${ARTIFACT_ROOT}/test-results`,
  timeout: 60_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    // Shastri directive corr ffcedfcd: always-on replayability. Every spec
    // records video + screenshots + trace. Artifacts land under outputDir
    // (/home/aditya/data/flowblinq-artifacts/test-results/…).
    video: "on",
    screenshot: "on",
    trace: "on",
    // Binding constraint (e2e-comprehensive-suite dispatch): visible browser via DISPLAY=:0.
    // DO NOT change to true.
    headless: false,
    // Reuse the OTP-verified session snapshot captured at globalSetup-auth
    // for every spec. DRY-01 (login/logout) opts out via its own project
    // override below because it exercises the auth flow directly.
    storageState: "e2e/.playwright-storage-state.json",
  },
  projects: [
    {
      name: "chromium",
      // Specs that exercise auth flows from a CLEAN context run in the
      // chromium-no-auth project (defined below). Listed here as testIgnore
      // so they don't double-run in the authed project. The two patterns
      // MUST mirror chromium-no-auth.testMatch exactly — otherwise specs
      // run twice or zero times. Storage-state-pollution diagnosis: heavy
      // wave failures (corr f7ff0b9c / triage ed4499fc) traced to authed
      // storageState being inherited by /auth/login specs, which the
      // middleware then redirects to /dashboard.
      testIgnore: [
        /DRY-01-.*\.spec\.ts$/,
        /login-page\.spec\.ts$/,
        /tests\/01-auth\/(001|002|003|004|009).*\.spec\.ts$/,
      ],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Auth-from-scratch specs use an empty storageState. Explicit
      // `{ cookies: [], origins: [] }` is required — Playwright only
      // dispatches on presence of the key, so `undefined` does NOT
      // override the inherited `use.storageState`. Pattern set MUST
      // mirror the chromium project's testIgnore above.
      name: "chromium-no-auth",
      testMatch: [
        /DRY-01-.*\.spec\.ts$/,
        /login-page\.spec\.ts$/,
        /tests\/01-auth\/(001|002|003|004|009).*\.spec\.ts$/,
      ],
      use: {
        ...devices["Desktop Chrome"],
        storageState: { cookies: [], origins: [] },
      },
    },
  ],
  webServer: {
    command: "node ./node_modules/.bin/next dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
    env: LOCAL_SUPABASE_ENV,
  },
});
