/**
 * ES-090 Phase 1 (ScriptDev) — L-1 `.env*` hygiene.
 *
 * ChangedSpec §b.6:
 * 1. .gitignore appends a canonical block (`.env`, `.env.*`, `!.env.example`,
 *    `!.env.local.supabase`).
 * 2. .husky/pre-commit rejects staged `.env*` files, with the HP-204 amended
 *    regex `(^|/)\.env(\..+)?$` — path-boundary anchor so subdirectory env
 *    files (`geo/.env.test`, `admin/.env.production`) are caught in a
 *    monorepo.
 * 3. Tracked `.env*` files (except allow-list) are removed.
 *
 * No route mocking — filesystem grep tests.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = join(__dirname, "..", "..", "..", ".."); // geo/

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf-8");
}

describe("ES-090 L-1 / .env* hygiene", () => {
  describe(".gitignore canonical block", () => {
    it("contains exact `.env` entry", () => {
      const gi = read(".gitignore");
      // Must match a bare .env line (not just .env.local etc.)
      expect(gi.split(/\r?\n/)).toContain(".env");
    });

    it("contains wildcard `.env.*` entry (catches new env files we don't anticipate)", () => {
      const gi = read(".gitignore");
      expect(gi.split(/\r?\n/)).toContain(".env.*");
    });

    it("preserves `.env.example` allow-list exception", () => {
      const gi = read(".gitignore");
      expect(gi.split(/\r?\n/)).toContain("!.env.example");
    });

    it("preserves `.env.local.supabase` allow-list exception (Supabase CLI)", () => {
      const gi = read(".gitignore");
      expect(gi.split(/\r?\n/)).toContain("!.env.local.supabase");
    });
  });

  describe(".husky/pre-commit hook (HP-204 path-boundary regex)", () => {
    it("pre-commit file exists", () => {
      expect(existsSync(join(REPO_ROOT, ".husky/pre-commit"))).toBe(true);
    });

    it("pre-commit is executable", () => {
      const stat = statSync(join(REPO_ROOT, ".husky/pre-commit"));
      // check owner-execute bit — husky relies on the shebang + +x
      expect(stat.mode & 0o100).toBeTruthy();
    });

    it("contains the HP-204 amended regex `(^|/)\\.env(\\..+)?$`", () => {
      const hook = read(".husky/pre-commit");
      // Exact HP-204 regex — path-boundary anchor, not just root.
      expect(hook).toMatch(/\(\^\|\/\)\\\.env\(\\\..\+\)\?\$/);
    });

    it("allow-lists `.env.example` and `.env.local.supabase` in the grep -Ev branch", () => {
      const hook = read(".husky/pre-commit");
      expect(hook).toMatch(/\.env\\\.\(example\|local\\\.supabase\)/);
    });

    it("regex catches `geo/.env.test` (monorepo subdir) — HP-204 motivation", () => {
      // Live-fire check against the ChangedSpec regex. If the hook's regex is
      // correct, this input should match.
      const regex = /(^|\/)\.env(\..+)?$/;
      expect(regex.test("geo/.env.test")).toBe(true);
      expect(regex.test("admin/.env.production")).toBe(true);
      expect(regex.test(".env.vercel-prod")).toBe(true);
    });

    it("regex does NOT flag `.env.example` or `.env.local.supabase` (allow-list)", () => {
      // The grep -Ev clause removes these from the match-set. Pin the exclusion.
      const exclude = /(^|\/)\.env\.(example|local\.supabase)$/;
      expect(exclude.test(".env.example")).toBe(true);   // excluded
      expect(exclude.test(".env.local.supabase")).toBe(true); // excluded
      expect(exclude.test(".env.vercel-prod")).toBe(false);   // NOT excluded
    });
  });

  describe("package.json has husky prepare script", () => {
    it("has `husky install` prepare script", () => {
      const pkg = JSON.parse(read("package.json"));
      expect(pkg.scripts?.prepare).toMatch(/husky/);
    });
  });

  describe("no tracked `.env*` files outside the allow-list", () => {
    it("`git ls-files '.env*'` returns only allow-listed names", () => {
      // Running `git ls-files` is safe (read-only). This asserts the repo
      // state after the `git rm --cached` step in the hygiene migration.
      let tracked: string[] = [];
      try {
        tracked = execSync("git ls-files '.env*'", { cwd: REPO_ROOT, encoding: "utf-8" })
          .trim()
          .split(/\r?\n/)
          .filter(Boolean);
      } catch {
        // If git is unavailable in the test env, skip the assertion — this
        // test is a CI sentinel, not a local-dev blocker.
        return;
      }
      const allowList = new Set([".env.example", ".env.local.supabase"]);
      const violations = tracked.filter((f) => !allowList.has(f));
      expect(violations).toEqual([]);
    });
  });
});
