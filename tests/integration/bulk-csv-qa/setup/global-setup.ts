/**
 * Global setup for bulk-csv-qa integration tests.
 *
 * Runs once before all test files.
 * Validates environment, seeds the test team with credits,
 * and exports shared test context via globalThis.__BULK_QA__.
 */

import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { seedCredits, getCredits } from "../helpers/credit-helpers";
import { getTestTeamId } from "../helpers/db-helpers";

// Load .env.test from geo/ root — vitest's env config doesn't reach global setup
const envTestPath = path.resolve(process.cwd(), ".env.test");
if (fs.existsSync(envTestPath)) {
  const lines = fs.readFileSync(envTestPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

const REQUIRED_ENV = [
  "TEST_BASE_URL",
  "TEST_SUPABASE_URL",
  "TEST_SUPABASE_SERVICE_KEY",
  "TEST_USER_EMAIL",
  "TEST_USER_PASSWORD",
];

export default async function globalSetup() {
  // 1. Validate required environment variables
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `bulk-csv-qa global-setup: missing required env vars: ${missing.join(", ")}\n` +
      "Copy tests/integration/bulk-csv-qa/.env.test.example to .env.test and fill in values."
    );
  }

  const email = process.env.TEST_USER_EMAIL!;
  const seedAmount = Number(process.env.CREDITS_SEED_AMOUNT ?? "500");

  console.info(`[bulk-csv-qa] Global setup: account=${email}, seed=${seedAmount} credits`);

  // 2. Resolve test team ID
  let teamId: string;
  try {
    teamId = await getTestTeamId(email);
  } catch (err) {
    throw new Error(
      `bulk-csv-qa: could not find team for ${email}. ` +
      "Ensure the test account exists and is a team member in Supabase.\n" +
      String(err)
    );
  }

  // 3. Seed credits — ensures all tiers start with known balance
  const before = await getCredits(teamId);
  await seedCredits(teamId, seedAmount);
  console.info(`[bulk-csv-qa] Credits: ${before} → ${seedAmount} for team ${teamId}`);

  // 4. Export to globalThis for test files
  (globalThis as Record<string, unknown>).__BULK_QA__ = {
    teamId,
    email,
    seedAmount,
    baseUrl: process.env.TEST_BASE_URL!,
  };

  console.info("[bulk-csv-qa] Global setup complete.");
}
