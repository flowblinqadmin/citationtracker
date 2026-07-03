import { defineConfig, devices } from "@playwright/test";

// E2E runs against local Supabase (well-known default keys, safe in code) and
// local Postgres. The dev server is started by Playwright with these env vars.
const LOCAL_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
  SUPABASE_SERVICE_ROLE_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  CRON_SECRET: process.env.CRON_SECRET ?? "e2e-local-cron-secret-must-be-32chars!!",
  GEO_ORIGIN: "http://127.0.0.1:3050", // stubbed by tests via route interception
};

Object.assign(process.env, LOCAL_ENV);

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/helpers/global-setup.ts",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3050",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx next dev -p 3050",
    url: "http://127.0.0.1:3050/citations/icon.svg", // public path — pages 307 to login unauthenticated
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: LOCAL_ENV,
  },
});
