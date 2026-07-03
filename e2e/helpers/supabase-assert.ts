/**
 * e2e/helpers/supabase-assert.ts — DB-state assertion helpers for DRY-01..05.
 *
 * Uses Supabase @supabase/supabase-js with SERVICE_ROLE_KEY (bypasses RLS)
 * sourced lazily from process.env. Never logs the key value.
 *
 * Every helper throws on assertion failure with a message that includes the
 * table + where clause + actual row count (and up to 3 sample rows for
 * diagnosis). The assertNoMutation helper logs counts only, not row bodies.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || key.length === 0) {
    throw new Error(
      "[supabase-assert] SUPABASE_SERVICE_ROLE_KEY not set — cannot query DB. " +
        "Ensure playwright.config.ts LOCAL_SUPABASE_ENV is applied before invoking specs.",
    );
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
  // Lazy import to keep vitest unit-path light; this module is e2e-only.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createClient } = require("@supabase/supabase-js") as typeof import("@supabase/supabase-js");
  _client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _client;
}

type WhereClause = Record<string, unknown>;

function applyWhere<T extends { eq: (col: string, val: unknown) => T }>(q: T, where: WhereClause): T {
  let cur = q;
  for (const [col, val] of Object.entries(where)) {
    cur = cur.eq(col, val);
  }
  return cur;
}

function fmtWhere(where: WhereClause | undefined): string {
  if (!where) return "<none>";
  return Object.entries(where).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" AND ");
}

function fmtSample(rows: unknown[]): string {
  return JSON.stringify(rows.slice(0, 3), null, 2);
}

// ── assertions ──────────────────────────────────────────────────────────────

export async function assertRowExists(opts: {
  table: string;
  where: WhereClause;
  expected_columns?: Record<string, unknown>;
  /**
   * Optional ISO timestamp cutoff. When set, the query adds
   * `created_at > createdAfter` to isolate rows created after the cutoff.
   * Used by specs that run alongside other team-scoped specs in the same
   * batch to avoid cross-test contamination (e.g. DRY-05 bulk assertions
   * filtering out DRY-02's pre-existing credit_transactions rows).
   * Default-unset: preserves existing caller behaviour.
   */
  createdAfter?: string;
}): Promise<void> {
  const { table, where, expected_columns, createdAfter } = opts;
  const sb = getClient();
  let q = applyWhere(sb.from(table).select("*"), where);
  if (createdAfter) q = q.gt("created_at", createdAfter);
  const { data, error } = await q;
  if (error) throw new Error(`[assertRowExists] DB error on ${table} ${fmtWhere(where)}${createdAfter ? ` AND created_at > ${createdAfter}` : ""}: ${error.message}`);
  const rows = data ?? [];
  if (rows.length !== 1) {
    throw new Error(
      `[assertRowExists] ${table} WHERE ${fmtWhere(where)}${createdAfter ? ` AND created_at > ${createdAfter}` : ""} — expected exactly 1 row, got ${rows.length}.\n` +
      `Sample: ${fmtSample(rows)}`,
    );
  }
  if (expected_columns) {
    const [row] = rows as Record<string, unknown>[];
    for (const [col, expected] of Object.entries(expected_columns)) {
      if (row[col] !== expected) {
        throw new Error(
          `[assertRowExists] ${table} ${fmtWhere(where)} — column "${col}" expected ${JSON.stringify(expected)}, got ${JSON.stringify(row[col])}`,
        );
      }
    }
  }
}

export async function assertRowCount(opts: {
  table: string;
  where?: WhereClause;
  expected: number;
}): Promise<void> {
  const { table, where, expected } = opts;
  const sb = getClient();
  let q = sb.from(table).select("*", { count: "exact", head: true });
  if (where) q = applyWhere(q, where);
  const { count, error } = await q;
  if (error) throw new Error(`[assertRowCount] DB error on ${table} ${fmtWhere(where)}: ${error.message}`);
  if (count !== expected) {
    throw new Error(
      `[assertRowCount] ${table} WHERE ${fmtWhere(where)} — expected ${expected} rows, got ${count ?? 0}.`,
    );
  }
}

/**
 * Capture a baseline count (call once pre-action), then call again with
 * `before` + `expected_delta` to verify the post-action count. Two-call shape:
 *   const before = await baseline({ table, where });
 *   // ...action...
 *   await assertRowCountDelta({ table, where, before, expected_delta: 1 });
 */
export async function baselineCount(opts: { table: string; where?: WhereClause }): Promise<number> {
  const { table, where } = opts;
  const sb = getClient();
  let q = sb.from(table).select("*", { count: "exact", head: true });
  if (where) q = applyWhere(q, where);
  const { count, error } = await q;
  if (error) throw new Error(`[baselineCount] DB error on ${table} ${fmtWhere(where)}: ${error.message}`);
  return count ?? 0;
}

export async function assertRowCountDelta(opts: {
  table: string;
  where?: WhereClause;
  before: number;
  expected_delta: number;
}): Promise<void> {
  const { table, where, before, expected_delta } = opts;
  const expected = before + expected_delta;
  await assertRowCount({ table, where, expected });
}

/**
 * Query a single row and verify each named column transitioned from→to.
 * Throws if zero or multiple rows match, or any column fails.
 */
export async function assertColumnDelta(opts: {
  table: string;
  where: WhereClause;
  columns: Record<string, { from?: unknown; to: unknown }>;
}): Promise<void> {
  const { table, where, columns } = opts;
  const sb = getClient();
  const { data, error } = await applyWhere(sb.from(table).select("*"), where);
  if (error) throw new Error(`[assertColumnDelta] DB error on ${table} ${fmtWhere(where)}: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length !== 1) {
    throw new Error(
      `[assertColumnDelta] ${table} ${fmtWhere(where)} — expected exactly 1 row, got ${rows.length}.`,
    );
  }
  const [row] = rows;
  for (const [col, { to }] of Object.entries(columns)) {
    if (row[col] !== to) {
      throw new Error(
        `[assertColumnDelta] ${table} ${fmtWhere(where)} — column "${col}" expected ${JSON.stringify(to)}, got ${JSON.stringify(row[col])}`,
      );
    }
  }
}

/**
 * Verify a table's row count is unchanged from the provided baseline.
 * Intended for no-op invariants (e.g. "this failed request wrote nothing").
 * Logs counts only, never row bodies.
 */
export async function assertNoMutation(opts: {
  table: string;
  where?: WhereClause;
  baseline_count: number;
}): Promise<void> {
  const { table, where, baseline_count } = opts;
  const sb = getClient();
  let q = sb.from(table).select("*", { count: "exact", head: true });
  if (where) q = applyWhere(q, where);
  const { count, error } = await q;
  if (error) throw new Error(`[assertNoMutation] DB error on ${table} ${fmtWhere(where)}: ${error.message}`);
  const actual = count ?? 0;
  if (actual !== baseline_count) {
    throw new Error(
      `[assertNoMutation] ${table} WHERE ${fmtWhere(where)} — expected unchanged count ${baseline_count}, got ${actual} (delta ${actual - baseline_count}).`,
    );
  }
}
