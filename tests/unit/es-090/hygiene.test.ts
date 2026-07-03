/**
 * ES-090 Hygiene bundle (U69-U72).
 *
 * Phase A (RED): main @ 70645cba still lists `apify-client` (line 40) and
 * `mongodb` (line 80) in `geo/package.json`. Tests are pure file-system
 * asserts — no module mocks.
 *
 * Spec ref: ES-090 §b.16.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function readPkg(): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
}

describe("ES-090 hygiene bundle", () => {
  // ── PR#2-4 scope (ES-090 §b.16 hygiene bundle) ──────────────────────────
  // U69-U72 land in a later PR — dependency cleanup + dynamic-import refactor
  // + cron registration all ride with the §b.16 hygiene bundle. Skipped under
  // PR#1 per HP-247 guidance; un-skip when the §b.16 PR lands.

  it.skip("U69: package.json excludes apify-client [→ PR#2-4, §b.16]", () => {
    const pkg = readPkg();
    expect(pkg.dependencies?.["apify-client"]).toBeUndefined();
    expect(pkg.devDependencies?.["apify-client"]).toBeUndefined();
  });

  it.skip("U70: package.json excludes mongodb [→ PR#2-4, §b.16]", () => {
    const pkg = readPkg();
    expect(pkg.dependencies?.["mongodb"]).toBeUndefined();
    expect(pkg.devDependencies?.["mongodb"]).toBeUndefined();
  });

  it.skip("U71: puppeteer-core / @sparticuz/chromium-min only via dynamic import [→ PR#2-4, §b.16]", () => {
    // The fallback file must not have a top-level static `import puppeteer from`.
    // Phase A: this file may not exist yet; if absent, we fail to indicate the
    // refactor is pending.
    const fallback = join(REPO_ROOT, "lib/services/crawl/puppeteer-fallback.ts");
    expect(existsSync(fallback), `lib/services/crawl/puppeteer-fallback.ts must exist after ES-090`).toBe(true);
    const src = readFileSync(fallback, "utf8");
    expect(src, "static `import puppeteer-core` not allowed — must be dynamic import")
      .not.toMatch(/^\s*import\s+.*puppeteer-core/m);
    expect(src).not.toMatch(/^\s*import\s+.*@sparticuz\/chromium-min/m);
  });

  it.skip("U72: vercel.json crons present for /api/cron/recrawl + /api/cron/process-queue [→ PR#2-4, §b.16]", () => {
    const vp = join(REPO_ROOT, "vercel.json");
    expect(existsSync(vp), "vercel.json must exist").toBe(true);
    const cfg = JSON.parse(readFileSync(vp, "utf8")) as { crons?: Array<{ path: string }> };
    const paths = (cfg.crons ?? []).map((c) => c.path);
    expect(paths).toContain("/api/cron/recrawl");
    expect(paths).toContain("/api/cron/process-queue");
  });

  // ── PR#1 scope (ES-090 §b.6 env hygiene) ────────────────────────────────

  it("U72b (ChangedSpec HP-204 + HP-229 path fix): pre-commit hook regex anchors at path boundary (catches geo/.env.test)", () => {
    // HP-229: previously asserted against /home/aditya/flowblinq/.husky/pre-commit
    // (monorepo root) — but the monorepo root is not a git repo. The functional
    // hook is at geo/.husky/pre-commit (installed via husky prepare in
    // geo/package.json; core.hooksPath scoped to geo/.git). Assert the real one.
    const hook = join(REPO_ROOT, ".husky", "pre-commit");
    if (!existsSync(hook)) {
      // Fail with a clear message — ChangedSpec §b.6 requires this file.
      expect.fail(`Expected pre-commit hook at ${hook} after ES-090 PR #1. Not found.`);
    }
    const src = readFileSync(hook, "utf8");
    // HP-204 anchored regex: must match `(^|/)` before `.env` so subdirectory
    // staged files are caught.
    expect(src, "HP-204 path-boundary anchor missing in pre-commit regex")
      .toMatch(/\(\^\|\/\)\\\.env/);
  });
});
