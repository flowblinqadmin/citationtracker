/**
 * UT-17 — selector-hardening grep + regex correctness (Phase 0 Track B).
 *
 * Enforces ES-e2e-fixtures AC-21:
 *   (a) zero getByLabel(/email/i) hits under e2e/tests/01-auth/
 *   (b) the canonical regex literals escape the dot and match the product
 *       JSX placeholders as documented in §b.15.2.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../");
const AUTH_SPECS_DIR = path.join(REPO_ROOT, "e2e/tests/01-auth");

function collectSpecFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSpecFiles(full));
    } else if (entry.endsWith(".spec.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("UT-17a: no getByLabel(/email/i) hits under e2e/tests/01-auth/ (AC-21)", () => {
  const specs = collectSpecFiles(AUTH_SPECS_DIR);

  it("finds at least one spec file under 01-auth/ (sanity — grep ran against real content)", () => {
    expect(specs.length).toBeGreaterThan(0);
  });

  for (const spec of specs) {
    const rel = path.relative(REPO_ROOT, spec);
    it(`${rel} contains no getByLabel(/email/i) call`, () => {
      const src = readFileSync(spec, "utf8");
      expect(src).not.toMatch(/getByLabel\s*\(\s*\/email\/i\s*\)/);
    });
  }

  for (const spec of specs) {
    const rel = path.relative(REPO_ROOT, spec);
    it(`${rel} contains no getByLabel(/otp|verification code|verify/i) call (same placeholder-anchor rule)`, () => {
      const src = readFileSync(spec, "utf8");
      expect(src).not.toMatch(/getByLabel\s*\(\s*\/[^)]*?(?:otp|verification code|verify)[^)]*?\/i\s*\)/);
    });
  }
});

describe("UT-17b: canonical regex literals are correct (AC-21)", () => {
  const EMAIL_RE = /you@yourcompany\.com/i;
  const OTP_RE = /6-digit code/i;

  it("/you@yourcompany\\.com/i matches the product placeholder literal (escaped dot required)", () => {
    expect(EMAIL_RE.test("you@yourcompany.com")).toBe(true);
  });

  it("/you@yourcompany\\.com/i does NOT match a string with a non-dot at that position (escaped dot is not a wildcard)", () => {
    expect(EMAIL_RE.test("you@yourcompanyXcom")).toBe(false);
    expect(EMAIL_RE.test("you@yourcompany-com")).toBe(false);
  });

  it("/6-digit code/i matches case-variant '6-DIGIT CODE' (i flag)", () => {
    expect(OTP_RE.test("6-DIGIT CODE")).toBe(true);
    expect(OTP_RE.test("6-digit code")).toBe(true);
  });

  it("/6-digit code/i does NOT match '7-digit code'", () => {
    expect(OTP_RE.test("7-digit code")).toBe(false);
  });
});

describe("UT-17c: hardened specs reference the new selector patterns (spot check)", () => {
  const specs = collectSpecFiles(AUTH_SPECS_DIR).filter((f) =>
    /00[1-4]|009/.test(path.basename(f)),
  );

  for (const spec of specs) {
    const rel = path.relative(REPO_ROOT, spec);
    const src = readFileSync(spec, "utf8");
    it(`${rel} uses getByPlaceholder(/you@yourcompany\\.com/i)`, () => {
      expect(src).toMatch(/getByPlaceholder\(\s*\/you@yourcompany\\\.com\/i\s*\)/);
    });
  }
});
