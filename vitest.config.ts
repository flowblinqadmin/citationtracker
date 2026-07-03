import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/.claude/worktrees/**",
      "**/tests/integration/**",
      "**/e2e/**",
      // Supabase Edge Functions are Deno (Deno.test + jsr/std asserts) — run via
      // `deno test supabase/functions/`, NOT Node Vitest. Excluded so the Docker
      // Vitest suite doesn't try to import Deno globals and crash.
      "**/supabase/functions/**",
      "**/.parked-tests/**",
      // Research/experiment scripts that invoke external APIs (OpenAI, Anthropic)
      // for live merchant pitch generation. Not unit tests — exclude from CI.
      "**/__tests__/experiments/**",
      "**/__tests__/integration/experiments/**",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
