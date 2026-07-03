/**
 * Integration Test — DB CHECK Constraints (NEW-S-02, NEW-S-03)
 *
 * Verifies that after applying 20260609-rls-revoke-and-checks.sql:
 *
 *   NEW-S-02: teams.subscription_tier IN ('free','starter','growth','pro')
 *             teams.subscription_status IN ('active','past_due','canceled',
 *               'inactive','trialing','unpaid','paused')
 *
 *   NEW-S-03: teams.credit_balance >= 0
 *             teams.monthly_pages_used >= 0
 *
 * Each test inserts a valid team row, attempts an illegal UPDATE, and asserts
 * the update is rejected with pg error code 23514 (check_violation).
 *
 * Requires a running local Postgres (local Supabase at :54322, or any Postgres
 * reachable at DATABASE_URL_LOCAL). Auto-skips if unreachable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import * as fs from "node:fs";
import * as path from "node:path";
import { nanoid } from "nanoid";

// ── Connection config ────────────────────────────────────────────────────────

const LOCAL_DB =
  process.env.DATABASE_URL_LOCAL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../lib/db/migrations");
const MIGRATION_REVOKE = "20260609-rls-revoke-and-checks.sql";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function connectSuperuser(): Promise<ReturnType<typeof postgres>> {
  return postgres(LOCAL_DB, {
    max: 1,
    prepare: false,
    connect_timeout: 3,
  });
}

async function isLocalDbReachable(): Promise<boolean> {
  let sql: ReturnType<typeof postgres> | undefined;
  try {
    sql = await connectSuperuser();
    await sql`SELECT 1 AS ping`;
    return true;
  } catch {
    return false;
  } finally {
    await sql?.end();
  }
}

async function applyMigration(sql: ReturnType<typeof postgres>, filename: string) {
  const filePath = path.join(MIGRATIONS_DIR, filename);
  const content = fs.readFileSync(filePath, "utf8");
  await sql.unsafe(content);
}

/** Insert a minimal valid team row; returns the id. Cleans up after the test block. */
async function insertTestTeam(sql: ReturnType<typeof postgres>): Promise<string> {
  const id = `test-${nanoid(8)}`;
  await sql`
    INSERT INTO public.teams
      (id, name, owner_user_id, credit_balance, subscription_tier, subscription_status,
       billing_model, monthly_page_allowance, monthly_pages_used)
    VALUES
      (${id}, ${"Test Team"}, ${"test-user-" + id},
       10, 'free', 'inactive', 'free', 20, 0)
  `;
  return id;
}

async function deleteTestTeam(sql: ReturnType<typeof postgres>, id: string) {
  // Delete dependent rows that might have cascaded (none by FK, but be safe)
  await sql`DELETE FROM public.teams WHERE id = ${id}`;
}

/** Assert that the async fn throws with pg code 23514 (check_violation). */
async function assertCheckViolation(fn: () => Promise<unknown>) {
  let threw = false;
  let pgCode: string | undefined;
  try {
    await fn();
  } catch (err: unknown) {
    threw = true;
    pgCode = (err as { code?: string }).code;
  }
  expect(threw).toBe(true);
  expect(pgCode).toBe("23514"); // check_violation
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("DB CHECK constraints on teams table (NEW-S-02 / NEW-S-03)", () => {
  let sql: ReturnType<typeof postgres>;
  let skip = false;

  beforeAll(async () => {
    skip = !(await isLocalDbReachable());
    if (skip) return;

    sql = await connectSuperuser();

    // Apply our REVOKE + CHECK migration (idempotent — safe to re-run)
    await applyMigration(sql, MIGRATION_REVOKE);
  });

  afterAll(async () => {
    await sql?.end();
  });

  it("skips if local DB is unreachable", () => {
    if (!skip) return;
    expect(skip).toBe(true);
  });

  // ── NEW-S-02a: subscription_tier ─────────────────────────────────────────

  it("rejects invalid subscription_tier value", async () => {
    if (skip) return;
    const id = await insertTestTeam(sql);
    try {
      await assertCheckViolation(async () => {
        await sql`
          UPDATE public.teams
          SET subscription_tier = 'enterprise'
          WHERE id = ${id}
        `;
      });
    } finally {
      await deleteTestTeam(sql, id);
    }
  });

  it("accepts all valid subscription_tier values", async () => {
    if (skip) return;
    const id = await insertTestTeam(sql);
    try {
      for (const tier of ["free", "starter", "growth", "pro"] as const) {
        await sql`
          UPDATE public.teams SET subscription_tier = ${tier} WHERE id = ${id}
        `;
      }
      // If we get here without throwing, all valid values were accepted
      const rows = await sql`
        SELECT subscription_tier FROM public.teams WHERE id = ${id}
      `;
      expect(rows[0].subscription_tier).toBe("pro"); // last written
    } finally {
      await deleteTestTeam(sql, id);
    }
  });

  // ── NEW-S-02b: subscription_status ───────────────────────────────────────

  it("rejects invalid subscription_status value", async () => {
    if (skip) return;
    const id = await insertTestTeam(sql);
    try {
      await assertCheckViolation(async () => {
        await sql`
          UPDATE public.teams
          SET subscription_status = 'expired'
          WHERE id = ${id}
        `;
      });
    } finally {
      await deleteTestTeam(sql, id);
    }
  });

  it("accepts all valid subscription_status values", async () => {
    if (skip) return;
    const id = await insertTestTeam(sql);
    try {
      const valid = ["active", "past_due", "canceled", "inactive", "trialing", "unpaid", "paused"] as const;
      for (const status of valid) {
        await sql`
          UPDATE public.teams SET subscription_status = ${status} WHERE id = ${id}
        `;
      }
      const rows = await sql`
        SELECT subscription_status FROM public.teams WHERE id = ${id}
      `;
      expect(rows[0].subscription_status).toBe("paused"); // last written
    } finally {
      await deleteTestTeam(sql, id);
    }
  });

  // ── NEW-S-03a: credit_balance >= 0 ───────────────────────────────────────

  it("rejects credit_balance = -1", async () => {
    if (skip) return;
    const id = await insertTestTeam(sql);
    try {
      await assertCheckViolation(async () => {
        await sql`
          UPDATE public.teams SET credit_balance = -1 WHERE id = ${id}
        `;
      });
    } finally {
      await deleteTestTeam(sql, id);
    }
  });

  it("accepts credit_balance = 0", async () => {
    if (skip) return;
    const id = await insertTestTeam(sql);
    try {
      await sql`
        UPDATE public.teams SET credit_balance = 0 WHERE id = ${id}
      `;
      const rows = await sql`
        SELECT credit_balance FROM public.teams WHERE id = ${id}
      `;
      expect(rows[0].credit_balance).toBe(0);
    } finally {
      await deleteTestTeam(sql, id);
    }
  });

  // ── NEW-S-03b: monthly_pages_used >= 0 ───────────────────────────────────

  it("rejects monthly_pages_used = -1", async () => {
    if (skip) return;
    const id = await insertTestTeam(sql);
    try {
      await assertCheckViolation(async () => {
        await sql`
          UPDATE public.teams SET monthly_pages_used = -1 WHERE id = ${id}
        `;
      });
    } finally {
      await deleteTestTeam(sql, id);
    }
  });

  it("accepts monthly_pages_used = 0", async () => {
    if (skip) return;
    const id = await insertTestTeam(sql);
    try {
      await sql`
        UPDATE public.teams SET monthly_pages_used = 0 WHERE id = ${id}
      `;
      const rows = await sql`
        SELECT monthly_pages_used FROM public.teams WHERE id = ${id}
      `;
      expect(rows[0].monthly_pages_used).toBe(0);
    } finally {
      await deleteTestTeam(sql, id);
    }
  });

  // ── Combined: both constraints fire independently ─────────────────────────

  it("invalid tier and invalid credit_balance each independently rejected", async () => {
    if (skip) return;
    const id = await insertTestTeam(sql);
    try {
      // Tier violation
      await assertCheckViolation(async () => {
        await sql`
          UPDATE public.teams SET subscription_tier = 'gold' WHERE id = ${id}
        `;
      });
      // Balance violation (row unchanged from above — still valid)
      await assertCheckViolation(async () => {
        await sql`
          UPDATE public.teams SET credit_balance = -999 WHERE id = ${id}
        `;
      });
    } finally {
      await deleteTestTeam(sql, id);
    }
  });
});
