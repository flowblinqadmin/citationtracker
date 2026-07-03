/**
 * setupFiles script — runs inside each vitest worker process.
 *
 * Reads the provisioned API client credentials written by globalSetup (setup.ts)
 * and exposes them on globalThis.__API_CLIENT_QA__ so test files can access them.
 *
 * This is necessary because vitest globalSetup runs in the main process while
 * tests run in a forked worker process; globalThis is not shared between them.
 */

import { readFileSync } from "fs";
import { QA_CREDS_TMP } from "./setup";

try {
  const raw = readFileSync(QA_CREDS_TMP, "utf-8");
  globalThis.__API_CLIENT_QA__ = JSON.parse(raw);
} catch {
  // File not present — tests will fail naturally with "API_CLIENT_QA not initialised"
}
