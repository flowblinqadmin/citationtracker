/**
 * Vitest config for bulk-csv-qa integration tests.
 *
 * Usage:
 *   # Run all tiers:
 *   vitest run --config vitest.integration.config.ts tests/integration/bulk-csv-qa
 *
 *   # Run individual tiers in isolation:
 *   vitest run --config vitest.integration.config.ts tests/integration/bulk-csv-qa/smoke
 *   vitest run --config vitest.integration.config.ts tests/integration/bulk-csv-qa/load
 *   vitest run --config vitest.integration.config.ts tests/integration/bulk-csv-qa/zip
 *   vitest run --config vitest.integration.config.ts tests/integration/bulk-csv-qa/edge
 *
 * Requires .env.test in geo/ root. See tests/integration/bulk-csv-qa/.env.test.example.
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // 700s total budget: load tier is 600s, plus overhead
    testTimeout: 700_000,
    hookTimeout: 60_000,
    // Tiers must run sequentially — load depends on credits, zip depends on completed jobs
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    globalSetup: [
      "./tests/integration/bulk-csv-qa/setup/global-setup.ts",
    ],
    globalTeardown: [
      "./tests/integration/bulk-csv-qa/setup/global-teardown.ts",
    ],
    // Load .env.test for credentials
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
    exclude: [
      "**/node_modules/**",
      "**/.claude/worktrees/**",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
