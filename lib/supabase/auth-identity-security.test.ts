/**
 * Security fitness functions — enforce that server-side code never derives
 * identity from a spoofable source.
 *
 * Background: supabase.auth.getSession() reads the session from cookies, which
 * the client can spoof; its .user is NOT authenticated. Trusting it server-side
 * is the "Using the user object as returned from getSession()... could be
 * insecure" warning. Identity used for authorization must come from
 * getUser() (validated against the Auth server) or getClaims() (JWT signature
 * verified). These tests fail the build if that pattern regresses anywhere in
 * server code, not just where we happened to fix it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const MIDDLEWARE = join(REPO_ROOT, "lib", "supabase", "middleware.ts");

// Directories that hold server-side source we want to police.
const SCAN_DIRS = ["app", "lib"].map((d) => join(REPO_ROOT, d));
const SKIP_DIRS = new Set(["node_modules", ".next", ".claude", "__tests__", ".git"]);

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}

const SERVER_FILES = SCAN_DIRS.flatMap((d) => collectSourceFiles(d));

function isClientFile(src: string): boolean {
  // Client components run in the browser, where getSession() is the supported
  // way to read the session — the server-spoofing risk does not apply.
  return /^\s*["']use client["']/m.test(src);
}

// Strip comments so that documentation *describing* the anti-pattern (e.g.
// "never trust session.user") does not trip the scanner — only real code counts.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")        // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1");      // line comments (skip URLs' "://")
}

describe("auth identity — security fitness functions", () => {
  it("there is server source to scan (sanity)", () => {
    expect(SERVER_FILES.length).toBeGreaterThan(50);
  });

  it("no server file trusts getSession().user for identity", () => {
    const offenders: string[] = [];
    for (const file of SERVER_FILES) {
      const raw = readFileSync(file, "utf8");
      if (isClientFile(raw)) continue;
      const src = stripComments(raw);
      const usesGetSession = /\.auth\s*\.\s*getSession\s*\(/.test(src);
      const readsSessionUser = /\bsession\s*\.\s*user\b/.test(src) || /getSession\([^)]*\)\s*\)?\s*\.\s*user\b/.test(src);
      if (usesGetSession && readsSessionUser) {
        offenders.push(relative(REPO_ROOT, file));
      }
    }
    expect(
      offenders,
      `Server files derive identity from getSession().user (spoofable). Use getUser()/getClaims() instead:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("middleware forwards identity from getUser(), never session.user", () => {
    const src = stripComments(readFileSync(MIDDLEWARE, "utf8"));
    // Positive: the verified auth call must be present.
    expect(src).toMatch(/\.auth\s*\.\s*getUser\s*\(/);
    // Negative: the spoofable identity source must be absent.
    expect(src).not.toMatch(/\bsession\s*\.\s*user\b/);
    // Negative: no hand-rolled, signature-UNVERIFIED JWT decode to mint identity.
    expect(src).not.toMatch(/base64url/);
  });
});
