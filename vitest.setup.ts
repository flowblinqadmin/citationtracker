import { vi } from "vitest";
import "@testing-library/jest-dom";

// Mock window.matchMedia for useMediaQuery hook in jsdom environment
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false, // default: desktop view
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
import Module from "node:module";

// Ensure DATABASE_URL is set so lib/db/index.ts doesn't throw on require()
// (vi.mock doesn't intercept CJS require() calls through esbuild transform)
if (!process.env.SUPABASE_DATABASE_URL && !process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
}

// Beacon Edge-runtime routes (/api/t/collect, /api/t/[slug]) gate every
// request on these three env vars and 503 if any are missing (fail-closed
// for ES-090 §b.1 COMP-2). The tests mock @/lib/supabase-edge so the values
// here are never actually used — they just satisfy the presence check.
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://test.local";
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
}
if (!process.env.IP_HASH_SECRET) {
  process.env.IP_HASH_SECRET = "test-ip-hash-secret-32chars-min-length";
}
// lib/cron-auth.ts (C3) and lib/api-auth.ts assert these at module load.
// Provide test-only defaults that satisfy the length checks; routes/tests
// override per-call when they need to assert behavior.
if (!process.env.CRON_SECRET) {
  process.env.CRON_SECRET = "test-cron-secret-32-chars-minimum-aaaa";
}
if (!process.env.API_JWT_SECRET) {
  process.env.API_JWT_SECRET =
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
}
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Expose `vi` as `jest` global so @testing-library/react can detect
// vitest fake timers and advance them inside waitFor / asyncWrapper.
// Without this, RTL's jestFakeTimersAreEnabled() returns false,
// causing waitFor to hang when vi.useFakeTimers() is active.
(globalThis as Record<string, unknown>).jest = vi;

// ---------- require("@/...") support for .ts files ----------
// Vite's resolve.alias handles import() but not Node's native require().
// We patch Module._resolveFilename to resolve @/ paths and register a
// .ts extension handler so require() can load TypeScript files.

const projectRoot = dirname(fileURLToPath(import.meta.url));

// 1. Resolve @/ paths to absolute file paths
const origResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (typeof request === "string" && request.startsWith("@/")) {
    const base = join(projectRoot, request.slice(2));
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ""]) {
      if (existsSync(base + ext)) return origResolve.call(this, base + ext, ...rest);
    }
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      if (existsSync(join(base, "index" + ext))) return origResolve.call(this, join(base, "index" + ext), ...rest);
    }
  }
  return origResolve.call(this, request, ...rest);
};

// 2. Compile .ts files with esbuild when loaded via require()
// esbuild is lazy-loaded to avoid TextEncoder/Uint8Array invariant errors in jsdom.
if (!(Module as any)._extensions[".ts"]) {
  (Module as any)._extensions[".ts"] = function (mod: any, filename: string) {
    const { transformSync } = require("esbuild") as typeof import("esbuild");
    const code = readFileSync(filename, "utf8");
    const { code: compiled } = transformSync(code, {
      loader: "ts",
      format: "cjs",
      target: "node20",
      sourcefile: filename,
    });
    mod._compile(compiled, filename);
  };
}
