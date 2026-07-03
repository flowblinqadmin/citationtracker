/**
 * CLI smoke tests — S-1 through S-6.
 *
 * Runs the CLI as a subprocess via spawnSync and verifies exit codes and output.
 *
 * Prerequisites:
 *   - tsx must be installed (npm install -D tsx) — tests skip if not found
 *   - TEST_BASE_URL must be set for live tests (S-1, S-2, S-3, S-4)
 *   - TEST_CLIENT_ID + TEST_CLIENT_SECRET for authenticated tests (S-1, S-3)
 *
 * S-5 and S-6 do NOT require live credentials (they test error paths that
 * are handled before any network call).
 *
 * Credential injection: passed via FLOWBLINQ_* env vars to the subprocess.
 * No config files or flags needed — env vars are the test's credential source.
 *
 * Tests are excluded from npm test (unit suite) via skipIf guards.
 * Run manually: npx vitest run __tests__/cli-smoke.test.ts
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import path from "path";
import fs from "node:fs";

// ─── Constants ────────────────────────────────────────────────────────────────

const GEO_DIR = path.join(__dirname, "..");
const TSX_BIN = path.join(GEO_DIR, "node_modules", ".bin", "tsx");
const CLI_ENTRY = path.join(GEO_DIR, "cli", "index.ts");

const TSX_AVAILABLE = fs.existsSync(TSX_BIN);
const TEST_BASE_URL = process.env.TEST_BASE_URL;
const TEST_CLIENT_ID = process.env.TEST_CLIENT_ID;
const TEST_CLIENT_SECRET = process.env.TEST_CLIENT_SECRET;

const INTEGRATION_MODE = TSX_AVAILABLE && !!TEST_BASE_URL;
const VALID_CREDS = !!TEST_CLIENT_ID && !!TEST_CLIENT_SECRET;

// ─── Subprocess runner ────────────────────────────────────────────────────────

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {}
): CliResult {
  const result = spawnSync(TSX_BIN, [CLI_ENTRY, ...args], {
    cwd: GEO_DIR,
    env: {
      ...process.env,
      // Clear any ambient credentials so tests are hermetic
      FLOWBLINQ_CLIENT_ID: undefined,
      FLOWBLINQ_CLIENT_SECRET: undefined,
      FLOWBLINQ_BASE_URL: undefined,
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 30_000,
  });

  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Build env for an authenticated call using the test credentials. */
function authedEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    FLOWBLINQ_CLIENT_ID: TEST_CLIENT_ID!,
    FLOWBLINQ_CLIENT_SECRET: TEST_CLIENT_SECRET!,
    FLOWBLINQ_BASE_URL: TEST_BASE_URL!,
    ...overrides,
  };
}

// ─── S-1 / S-2: auth test ────────────────────────────────────────────────────

describe("CLI smoke: auth test", () => {
  it.skipIf(!INTEGRATION_MODE || !VALID_CREDS)(
    "S-1: auth test with valid credentials → exit 0, stdout contains 'Connected'",
    () => {
      const result = runCli(["auth", "test"], authedEnv());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Connected");
    }
  );

  it.skipIf(!INTEGRATION_MODE)(
    "S-2: auth test with invalid credentials → exit 2, stderr contains 'Error:'",
    () => {
      const result = runCli(["auth", "test"], {
        FLOWBLINQ_CLIENT_ID: "invalid-client-id-xyz",
        FLOWBLINQ_CLIENT_SECRET: "invalid-secret-xyz",
        FLOWBLINQ_BASE_URL: TEST_BASE_URL!,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Error:");
    }
  );
});

// ─── S-3 / S-4: account and mcp ──────────────────────────────────────────────

describe("CLI smoke: account and mcp commands", () => {
  it.skipIf(!INTEGRATION_MODE || !VALID_CREDS)(
    "S-3: account --json → exit 0, stdout is valid JSON with teamId field",
    () => {
      const result = runCli(["account", "--json"], authedEnv());

      expect(result.exitCode).toBe(0);

      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(result.stdout);
      }).not.toThrow();

      const data = parsed as Record<string, unknown>;
      expect(typeof data.teamId).toBe("string");
      expect(data.teamId!.length).toBeGreaterThan(0);
    }
  );

  it.skipIf(!INTEGRATION_MODE)(
    "S-4: mcp --json → exit 0, stdout is valid JSON with tools array of 4",
    () => {
      // getMcpManifest() is unauthenticated — we pass dummy creds to satisfy credentials.ts
      const result = runCli(["mcp", "--json"], {
        FLOWBLINQ_CLIENT_ID: "dummy-id",
        FLOWBLINQ_CLIENT_SECRET: "dummy-secret",
        FLOWBLINQ_BASE_URL: TEST_BASE_URL!,
      });

      expect(result.exitCode).toBe(0);

      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(result.stdout);
      }).not.toThrow();

      const data = parsed as Record<string, unknown>;
      expect(Array.isArray(data.tools)).toBe(true);
      expect((data.tools as unknown[]).length).toBe(4);
    }
  );
});

// ─── S-5 / S-6: credential and routing errors ────────────────────────────────

describe("CLI smoke: credential and routing errors", () => {
  it.skipIf(!TSX_AVAILABLE)(
    "S-5: no credentials in any source → exit 1, stderr contains 'No credentials found'",
    () => {
      // Pass no credential env vars, and no config files in test environment
      const result = runCli(["auth", "test"], {
        HOME: "/tmp/no-such-home-dir-cli-smoke-test",
        FLOWBLINQ_CLIENT_ID: undefined,
        FLOWBLINQ_CLIENT_SECRET: undefined,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No credentials found");
    }
  );

  it.skipIf(!TSX_AVAILABLE)(
    "S-6: unknown command with valid credentials → exit 1, stderr contains 'Error:'",
    () => {
      // Credentials provided so we get past credentials.ts — routing error happens next
      const result = runCli(["unknown-command-xyz-12345"], {
        FLOWBLINQ_CLIENT_ID: "dummy-id",
        FLOWBLINQ_CLIENT_SECRET: "dummy-secret",
        FLOWBLINQ_BASE_URL: TEST_BASE_URL ?? "https://geo.flowblinq.com",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Error:");
    }
  );
});
