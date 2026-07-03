/**
 * NEW-AI-07 regression test
 *
 * The legacy `googleFn` path in `generatePromptsLegacy` used
 * `gemini-2.5-flash-lite` for brand/prompt detection.  The codebase
 * abandoned flash-lite because it hallucinates on unknown brands.
 *
 * Strategy: read the three detection-path source files directly and assert
 * that NONE of them contains a "flash-lite" model (any generation), while
 * citation-prompt-generator.ts DOES contain "gemini-3.5-flash" (2026-06-10
 * model modernization; was gemini-2.5-flash). The guard is on the *-lite
 * suffix, not a specific generation, so future model bumps don't regress it.
 *
 * This is robust because:
 *   - It guards ALL detection sites at once (no provider-routing mock that
 *     can fail to reach the spy).
 *   - It was RED on the pre-fix base (flash-lite was present) and GREEN after
 *     the NEW-AI-07 fix.
 *   - It cannot be silenced by a mock that intercepts the wrong import path.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Paths to the three detection files ───────────────────────────────────────

const REPO_ROOT = resolve(__dirname, "../../../");

const DETECTION_FILES = [
  resolve(REPO_ROOT, "lib/services/citation-prompt-generator.ts"),
  resolve(REPO_ROOT, "lib/services/competitor-discovery.ts"),
  resolve(REPO_ROOT, "lib/services/commerce/sov-checker.ts"),
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("NEW-AI-07: gemini model string guard across all detection files", () => {
  it("citation-prompt-generator.ts uses gemini-3.5-flash (not flash-lite)", () => {
    const src = readFileSync(DETECTION_FILES[0], "utf8");

    // Must contain the current frontier flash model (the correct model)
    expect(src).toMatch("gemini-3.5-flash");

    // Must NOT contain any flash-lite (the hallucinating tier — was RED before fix)
    expect(src).not.toMatch(/gemini-[0-9.]+-flash-lite/);
  });

  it("competitor-discovery.ts does not reference any flash-lite model", () => {
    const src = readFileSync(DETECTION_FILES[1], "utf8");
    expect(src).not.toMatch(/gemini-[0-9.]+-flash-lite/);
  });

  it("commerce/sov-checker.ts does not reference any flash-lite model", () => {
    const src = readFileSync(DETECTION_FILES[2], "utf8");
    expect(src).not.toMatch(/gemini-[0-9.]+-flash-lite/);
  });

  it("none of the three detection files reference a flash-lite model", () => {
    // Consolidated guard: any file containing flash-lite causes the regression
    const violations: string[] = [];
    for (const filePath of DETECTION_FILES) {
      const src = readFileSync(filePath, "utf8");
      if (/gemini-[0-9.]+-flash-lite/.test(src)) {
        violations.push(filePath);
      }
    }
    expect(violations).toEqual([]);
  });
});
