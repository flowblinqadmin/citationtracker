/**
 * ES-090 Phase 1 (ScriptDev) — CRIT-1 write-path contract (U1 + U2).
 *
 * U1 — verify-route writes tokenExpiresAt on new accessToken (§b.2 step 2).
 * U2 — regenerate rotates accessToken + resets tokenExpiresAt + sets
 *      tokenRotatedAt (§b.2 step 4).
 *
 * These are **source-contract** tests: they grep the implementation to check
 * the required mutations exist in the code. Runtime happy-path write-path
 * tests would require mocking the full verify + regenerate dep-graphs
 * (10+ services each). That's Phase 2/3 integration surface; for Phase 1 a
 * grep test pins the spec contract with acceptable fidelity — it fails RED
 * today, greens as soon as the implementation adds the lines.
 *
 * Complementary: ReviewMaster's `token-expiry.test.ts` covers U1/U2 at the
 * runtime layer. This is my independent Phase 1 reading.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf-8");
}

describe("ES-090 CRIT-1 / write-path contract", () => {
  describe("U1 — app/api/sites/[id]/verify/route.ts writes tokenExpiresAt on accessToken write", () => {
    const src = read("app/api/sites/[id]/verify/route.ts");

    it("mentions tokenExpiresAt somewhere in the source (spec §b.2 step 2)", () => {
      expect(src).toMatch(/tokenExpiresAt/);
    });

    it("sets tokenExpiresAt to ~90 days ahead of now (ChangedSpec literal)", () => {
      // Spec-literal form: `new Date(Date.now() + 90 * 86_400_000)` or
      // equivalent ms-arithmetic. Pin the 90-day window. HP-235: the
      // literal can also be satisfied by importing the shared TOKEN_TTL_MS
      // const from @/lib/constants/token-ttl (preferred, drift-proof).
      const has90dMs = /90\s*\*\s*86_?400_?000/.test(src) ||
        /90\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(src) ||
        /TOKEN_TTL_MS/.test(src);
      expect(has90dMs).toBe(true);
    });

    it("writes tokenRotatedAt alongside tokenExpiresAt (spec §b.2 step 2)", () => {
      expect(src).toMatch(/tokenRotatedAt/);
    });
  });

  describe("U2 — app/api/sites/[id]/regenerate/route.ts rotates the token", () => {
    const src = read("app/api/sites/[id]/regenerate/route.ts");

    it("invokes nanoid(32) for the new accessToken (ChangedSpec §b.2 step 4)", () => {
      // Spec specifies 32-char nanoid for the rotated token.
      expect(src).toMatch(/nanoid\s*\(\s*32\s*\)/);
    });

    it("writes the new accessToken back via the geoSites update", () => {
      // The rotation update must include accessToken as a key; today the
      // route updates only pipelineStatus / creditsReserved / updatedAt.
      expect(src).toMatch(/accessToken\s*:/);
    });

    it("resets tokenExpiresAt (~now+90d) on rotation", () => {
      expect(src).toMatch(/tokenExpiresAt/);
      // HP-235: accept shared TOKEN_TTL_MS const in place of inline literal.
      const has90dMs = /90\s*\*\s*86_?400_?000/.test(src) ||
        /90\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(src) ||
        /TOKEN_TTL_MS/.test(src);
      expect(has90dMs).toBe(true);
    });

    it("records tokenRotatedAt on rotation (audit trail)", () => {
      expect(src).toMatch(/tokenRotatedAt/);
    });
  });

  describe("lib/db/schema.ts — §b.1 schema columns", () => {
    const src = read("lib/db/schema.ts");

    it("declares tokenExpiresAt column on geoSites (NOT NULL with NOW()+90d default)", () => {
      expect(src).toMatch(/tokenExpiresAt/);
      // NOT NULL default — HP-196/HP-197: column-level fail-closed.
      expect(src).toMatch(/token_expires_at/);
    });

    it("declares tokenRotatedAt column on geoSites", () => {
      expect(src).toMatch(/tokenRotatedAt/);
      expect(src).toMatch(/token_rotated_at/);
    });
  });
});
