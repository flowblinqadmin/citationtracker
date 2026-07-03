/**
 * ES-B8 — SitePageClient estAfterFixes source contract.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SITE_CLIENT = fs.readFileSync(
  path.resolve(process.cwd(), "app/sites/[id]/SitePageClient.tsx"),
  "utf8",
);

describe("B8 — estAfterFixes reads DB projected_score (no regex fallback)", () => {
  it("AC-B8-1: estAfterFixes binds to site.projectedScore", () => {
    expect(SITE_CLIENT).toMatch(/const estAfterFixes\s*=\s*\(site as[\s\S]{0,120}\.projectedScore\s*\?\?\s*null/);
  });

  it("AC-B8-2: no top3Boost reduce + parseInt regex over rec.estimatedBoost remains", () => {
    expect(SITE_CLIENT).not.toMatch(/top3Boost/);
    expect(SITE_CLIENT).not.toMatch(/parseInt\(String\(r\.estimatedBoost\)/);
  });

  it("AC-B8-3: render path stays gated on null check (does not fall back to liveScore)", () => {
    // The pre-fix code evaluated `liveScore !== null ? Math.min(liveScore + top3Boost, 100) : null`
    // which mixed the regex result with currentScore. After the fix, the JSX
    // gate is `{estAfterFixes !== null && <div ...>Est. after fixes: ...}`.
    expect(SITE_CLIENT).toMatch(/estAfterFixes\s*!==\s*null\s*&&\s*<div/);
    // No expression that combines liveScore + top3Boost into estAfterFixes.
    expect(SITE_CLIENT).not.toMatch(/liveScore\s*\+\s*top3Boost/);
  });

  it("AC-B8 documentation: inline comment explains the drift the regex caused", () => {
    expect(SITE_CLIENT).toMatch(/ES-B8/);
    expect(SITE_CLIENT).toMatch(/projectedScore/);
  });
});
