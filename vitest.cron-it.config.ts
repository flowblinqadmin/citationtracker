/**
 * Minimal integration-test config for real-DB cron tests.
 *
 * The default vitest.config.ts excludes tests/integration/** (no Postgres in the
 * Docker unit suite). vitest.integration.config.ts carries the bulk-csv-qa
 * globalSetup/teardown, which we don't want here. This config runs a single
 * real-DB file with just the @ alias + a generous timeout.
 *
 *   DATABASE_URL=<postgres-url> \
 *     vitest run --config vitest.cron-it.config.ts tests/integration/cron
 */
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["tests/integration/cron/**/*.integration.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
