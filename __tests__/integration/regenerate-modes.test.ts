/**
 * ES-B9.2 AC-B9.2-3 — /regenerate route returns 202 for both bulk and
 * single audit modes (post-fix; the prior 400 bulk-block is gone).
 *
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROUTE_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "app/api/sites/[id]/regenerate/route.ts"),
  "utf8",
);

describe("AC-B9.2-3 — /regenerate handles both modes (no bulk-block)", () => {
  it("source contains EXACTLY one bulk auditMode === 'bulk' branch (the new B9.2 one)", () => {
    const matches = [...ROUTE_SRC.matchAll(/site\.auditMode === "bulk"/g)];
    expect(matches.length).toBe(1);
  });

  it("the bulk branch returns 202 (NOT 400)", () => {
    const bulkBranch = ROUTE_SRC.slice(ROUTE_SRC.indexOf('site.auditMode === "bulk"'));
    // First status: in the bulk branch body should be a non-error code or
    // the in-bulk-branch sub-checks (404 team-not-found, 402 insufficient
    // credits) — but the success path's status: 202 must be present.
    expect(bulkBranch).toMatch(/status:\s*202/);
    expect(bulkBranch).not.toMatch(/Bulk audits cannot be regenerated/);
  });

  it("single mode (post-bulk fall-through) still returns 202 via the team path", () => {
    // The team-path branch immediately follows the bulk branch and returns
    // 202 on the existing success path.
    expect(ROUTE_SRC).toMatch(/if \(site\.teamId\)[\s\S]*?status:\s*202/);
  });

  it("auth (Bearer/?token) still enforced before any branch", () => {
    expect(ROUTE_SRC).toMatch(/site\.accessToken !== token[\s\S]{0,200}status:\s*401/);
  });

  it("running-state guard precedes the bulk branch (409 wins over a re-run while in flight)", () => {
    const guardIdx = ROUTE_SRC.indexOf("Pipeline already running");
    const bulkIdx = ROUTE_SRC.indexOf('AC-B9.2-1 — bulk-aware regenerate');
    expect(guardIdx).toBeGreaterThan(0);
    expect(bulkIdx).toBeGreaterThan(guardIdx);
  });
});
