import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    // DB-backed suites share one Postgres and reset tracker tables in
    // beforeEach — files must not run concurrently.
    fileParallelism: false,
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    exclude: ["**/node_modules/**", "**/e2e/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
