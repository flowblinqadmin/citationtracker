/**
 * Playwright global setup — runs once before all tests.
 *
 * Order:
 *   1. Load ~/.mailenv → process.env (GMAIL_APP_PASSWORD, MAIL_FROM). The
 *      OTP helper (e2e/fixtures/otp-helper.ts) reads process.env.GMAIL_APP_PASSWORD;
 *      the source-of-truth env file uses MAIL_APP_PASSWORD, so we map names here.
 *      Fail-fast if the file or the key is missing — auth specs will otherwise
 *      stall at IMAP polling with cryptic timeouts.
 *      SUPABASE_SERVICE_ROLE_KEY is NOT loaded here — playwright.config.ts
 *      LOCAL_SUPABASE_ENV pre-populates it into process.env (Aditya directive
 *      corr 0747e99e). The seed validates presence itself.
 *   2. Verify local Supabase is reachable (API + Mailpit).
 *   3. Run the deterministic E2E seed per ES-e2e-fixtures §b.11.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function loadMailEnv(): void {
  const mailenvPath = path.join(homedir(), ".mailenv");
  if (!existsSync(mailenvPath)) {
    throw new Error(
      "Missing ~/.mailenv - required for OTP helper. Seed via your usual provisioning path.",
    );
  }
  const src = readFileSync(mailenvPath, "utf8");
  const parsed: Record<string, string> = {};
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }

  const appPassword = parsed["MAIL_APP_PASSWORD"];
  if (!appPassword || appPassword.length === 0) {
    throw new Error(
      "MAIL_APP_PASSWORD missing from ~/.mailenv - OTP helper cannot authenticate to Gmail IMAP.",
    );
  }
  process.env.GMAIL_APP_PASSWORD = appPassword;

  const mailFrom = parsed["MAIL_FROM"];
  if (mailFrom) process.env.MAIL_FROM = mailFrom;

  // Log presence only; never log the password value. SUPABASE_SERVICE_ROLE_KEY
  // is sourced from process.env (playwright.config.ts LOCAL_SUPABASE_ENV
  // pre-populates it), NOT from ~/.mailenv — see Aditya directive corr
  // 0747e99e. This loader owns Gmail creds only.
  console.log(
    `[global-setup] MAIL env loaded: MAIL_FROM=${mailFrom ?? "<unset>"}, MAIL_APP_PASSWORD=present`,
  );
}

export default async function globalSetup() {
  loadMailEnv();

  const checks: { name: string; url: string; headers: Record<string, string> }[] = [
    {
      name: "Supabase API",
      url: "http://127.0.0.1:54321/auth/v1/settings",
      headers: {
        apikey:
          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
      },
    },
    {
      name: "Mailpit",
      url: "http://127.0.0.1:54324/api/v1/info",
      headers: {},
    },
  ];

  for (const check of checks) {
    try {
      const res = await fetch(check.url, { headers: check.headers });
      if (!res.ok) {
        throw new Error(`${check.name} returned ${res.status}`);
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : String(err);
      throw new Error(
        `Local Supabase is not running (${check.name} failed: ${msg}).\n` +
          "Run: supabase start && npm run db:push:local",
      );
    }
  }

  // ES-e2e-fixtures §b.11: seed a deterministic world-state AFTER the
  // reachability checks, BEFORE any spec runs. `stdio: "inherit"` surfaces
  // seed output into the Playwright run log (AC-8). Non-zero exit from the
  // seed throws, which Playwright treats as a global-setup failure and
  // aborts the entire suite before a single spec runs.
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("npm", ["run", "db:seed:e2e"], {
      stdio: "inherit",
      timeout: 60_000,
    });
  } catch (err) {
    throw new Error(
      `E2E seed failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
