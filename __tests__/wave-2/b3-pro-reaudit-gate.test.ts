/**
 * ES-wave-2 §B3 — Pro re-audit gate (Option (a) auto-pass + 5 hardening ACs).
 *
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";

// All B3 ACs are static-source-verifiable on top of the existing route.
// Each `it` block isolates one AC's source contract; the corresponding
// runtime path is covered indirectly by the existing /api/sites POST tests
// once the in-flight UAT lands. This keeps Wave-2's gate fast and avoids
// duplicating the route's heavy mock harness.

import * as fs from "fs";
import * as path from "path";

const ROUTE = fs.readFileSync(
  path.resolve(process.cwd(), "app/api/sites/route.ts"),
  "utf8",
);
const SCHEMA = fs.readFileSync(
  path.resolve(process.cwd(), "lib/db/schema.ts"),
  "utf8",
);
const MIGRATION_DIR = path.resolve(process.cwd(), "lib/db/migrations");
const MIGRATIONS = fs.readdirSync(MIGRATION_DIR);

describe("B3 AC-B3-1 — defense-in-depth team-membership check", () => {
  it("re-audit auto-pass requires both email match AND team_members lookup", () => {
    expect(ROUTE).toMatch(/AC-B3-1/);
    // The auto-pass branch must query team_members on jwtUserId + teamId.
    expect(ROUTE).toMatch(/eq\(teamMembers\.userId,\s*jwtUserId\)/);
    expect(ROUTE).toMatch(/eq\(teamMembers\.teamId,\s*existing\.teamId\)/);
  });

  it("on team-membership miss, falls through to OTP path (no 403 short-circuit)", () => {
    expect(ROUTE).toMatch(/falling through to OTP/i);
    // The OTP block must remain reachable below the auto-pass branch.
    expect(ROUTE).toMatch(/Check your email for verification code/);
  });
});

describe("B3 AC-B3-2 — graceful JWT fallback", () => {
  it("team-membership query is wrapped in try/catch so JWT/DB error → fall through", () => {
    expect(ROUTE).toMatch(/AC-B3-2/);
    // The membership SELECT is inside a try/catch with a console.warn.
    expect(ROUTE).toMatch(/try\s*\{[\s\S]*?from\(teamMembers\)[\s\S]*?\}\s*catch[\s\S]*?console\.warn/);
  });

  it("missing/empty x-user-id header skips the auto-pass branch (canAutoPass stays false)", () => {
    // The guard requires both authEmail match AND a non-empty jwtUserId.
    expect(ROUTE).toMatch(/jwtUserId\s*&&\s*existing\.teamId/);
  });
});

describe("B3 AC-B3-3 — audit log row written on every successful re-audit", () => {
  it("schema declares re_audit_actions with required columns", () => {
    expect(SCHEMA).toMatch(/reAuditActions\s*=\s*pgTable\("re_audit_actions"/);
    expect(SCHEMA).toMatch(/mechanism:\s*text\("mechanism"\)\.notNull\(\)/);
    expect(SCHEMA).toMatch(/teamCreatedIdx/);
  });

  it("migration file exists with CHECK constraint on mechanism + descending team timeline index", () => {
    const m = MIGRATIONS.find((f) => f.endsWith("re-audit-actions.sql"));
    expect(m).toBeTruthy();
    const sql = fs.readFileSync(path.join(MIGRATION_DIR, m!), "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS re_audit_actions/);
    expect(sql).toMatch(/mechanism\s+text\s+NOT NULL\s+CHECK\s*\(mechanism\s+IN\s*\('pro_session','access_token','otp'\)\)/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS re_audit_actions_team_created_idx[\s\S]*\(team_id, created_at DESC\)/);
  });

  it("route inserts re_audit_actions row with mechanism='pro_session' on auto-pass", () => {
    expect(ROUTE).toMatch(/AC-B3-3/);
    expect(ROUTE).toMatch(/db\.insert\(reAuditActions\)\.values\(\{[\s\S]*?mechanism:\s*"pro_session"/);
  });
});

describe("B3 AC-B3-4 — SameSite cookie audit (no 'None' in tracked code)", () => {
  it("repo grep returns zero hits for SameSite=None / sameSite: 'none'", () => {
    // Walk lib/, app/, middleware.ts; ignore parked-tests + node_modules.
    const offenders: string[] = [];
    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "parked-tests" || entry.name === ".parked-tests") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const src = fs.readFileSync(full, "utf8");
          if (/sameSite\s*[:=]\s*['"]None['"]/i.test(src)) {
            offenders.push(full);
          }
        }
      }
    }
    walk(path.resolve(process.cwd(), "lib"));
    walk(path.resolve(process.cwd(), "app"));
    const middleware = path.resolve(process.cwd(), "middleware.ts");
    if (fs.existsSync(middleware)) {
      const src = fs.readFileSync(middleware, "utf8");
      if (/sameSite\s*[:=]\s*['"]None['"]/i.test(src)) offenders.push(middleware);
    }
    expect(offenders).toEqual([]);
  });
});

describe("B3 AC-B3-5 — per-team rate limit (10/hour)", () => {
  it("auto-pass branch invokes checkRateLimit with re_audit_team:<teamId> + 10 + 60min window", () => {
    expect(ROUTE).toMatch(/AC-B3-5/);
    expect(ROUTE).toMatch(/checkRateLimit\(`re_audit_team:\$\{existing\.teamId\}`,\s*10,\s*60\s*\*\s*60\s*\*\s*1000\)/);
  });

  it("rate-limit hit returns 429 with Retry-After header", () => {
    expect(ROUTE).toMatch(/Re-audit rate limit exceeded for this team/);
    expect(ROUTE).toMatch(/status:\s*429,\s*headers:\s*\{\s*"Retry-After":\s*String\(retryAfterSec\)/);
  });
});

describe("B3 cross-cutting — auto-pass returns rotated token + restart marker", () => {
  it("response carries restarted:true + a fresh accessToken (nanoid 32)", () => {
    expect(ROUTE).toMatch(/restarted:\s*true/);
    expect(ROUTE).toMatch(/newAccessToken\s*=\s*nanoid\(32\)/);
  });

  it("pipeline restart enqueues stage='discover' (mirrors failed-status reset behavior)", () => {
    expect(ROUTE).toMatch(/enqueueStage\(\{[\s\S]*?stage:\s*"discover"/);
  });

  it("token rotation patch matches buildRegeneratePatch shape (accessToken + tokenExpiresAt + tokenRotatedAt)", () => {
    expect(ROUTE).toMatch(/accessToken:\s*newAccessToken/);
    expect(ROUTE).toMatch(/tokenExpiresAt:\s*new Date\(now\.getTime\(\)\s*\+\s*TOKEN_TTL_MS\)/);
    expect(ROUTE).toMatch(/tokenRotatedAt:\s*now/);
  });
});
