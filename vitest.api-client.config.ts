/**
 * Vitest config for API client integration tests.
 *
 * Usage:
 *   npm run test:integration:api
 *   # or directly:
 *   vitest run --config vitest.api-client.config.ts tests/integration/api-client
 *
 * Requires .env.test in geo/ root.
 * See tests/integration/api-client/.env.test.example
 *
 * Tests run SEQUENTIALLY (singleFork) against the live Vercel production URL.
 * testTimeout is 10 min to cover full audit pipeline runs (F-3 can take ~3–5 min).
 *
 * NOT run in CI — execute manually before WordPress plugin distribution.
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    testTimeout: 600_000,   // 10 min — audit pipeline can take 3–5 min
    hookTimeout: 60_000,
    // Run files sequentially — tests share a provisioned credential from setup.ts
    pool: "forks",
    singleFork: true,
    globalSetup: ["./tests/integration/api-client/setup.ts"],
    // Runs inside each worker — reads temp creds file and hydrates globalThis.__API_CLIENT_QA__
    setupFiles: ["./tests/integration/api-client/inject-qa.ts"],
    // Load .env.test (same pattern as vitest.integration.config.ts)
    env: {
      ...(() => {
        try {
          const fs = require("fs");
          const lines = fs.readFileSync(".env.test", "utf-8").split("\n");
          return Object.fromEntries(
            lines
              .filter((l: string) => l.trim() && !l.startsWith("#"))
              .map((l: string) => {
                const idx = l.indexOf("=");
                return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
              })
          );
        } catch {
          return {};
        }
      })(),
    },
    exclude: ["**/node_modules/**", "**/.claude/worktrees/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
