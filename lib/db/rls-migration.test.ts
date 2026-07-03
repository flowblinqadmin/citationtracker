/**
 * Fitness function — guards the RLS fix against silent regression.
 *
 * The recurring Supabase `rls_disabled_in_public` advisor is closed by
 * migrations/20260605-enable-rls-all-tables.sql, which enables Row-Level
 * Security on EVERY public table via a dynamic DO-block (so new tables are
 * auto-covered when it's re-applied). These tests fail the build if that
 * migration is deleted, or weakened into a hardcoded subset that would miss
 * future tables. Runtime enforcement against a live DB is `npm run check:rls`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(here, "migrations", "20260605-enable-rls-all-tables.sql");
const SCHEMA = join(here, "schema.ts");

describe("RLS enable-all migration (anti-regression for rls_disabled_in_public)", () => {
  it("the enable-RLS-on-all-tables migration exists", () => {
    expect(existsSync(MIGRATION)).toBe(true);
  });

  it("enables RLS dynamically over ALL public tables (not a hardcoded subset)", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    // Dynamic loop over the catalog — this is what makes it cover future tables.
    expect(/DO\s+\$\$/i.test(sql)).toBe(true);
    expect(/pg_class/i.test(sql)).toBe(true);
    expect(/nspname\s*=\s*'public'/i.test(sql)).toBe(true);
    expect(/relrowsecurity\s*=\s*false/i.test(sql)).toBe(true);
    expect(/ENABLE ROW LEVEL SECURITY/i.test(sql)).toBe(true);
    // relkind='r' so it targets tables, not views/matviews.
    expect(/relkind\s*=\s*'r'/i.test(sql)).toBe(true);
  });

  it("does NOT hardcode a per-table list that could omit new tables", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    // A dynamic migration should have at most a trivial number of literal
    // `ALTER TABLE public.<name>` statements (ideally zero — the DO-block does it).
    const hardcoded = sql.match(/ALTER TABLE\s+public\.[a-z_]+\s+ENABLE ROW LEVEL/gi) ?? [];
    expect(hardcoded.length).toBe(0);
  });

  it("schema still declares tables (sanity: there is something to protect)", () => {
    const schema = readFileSync(SCHEMA, "utf8");
    const tables = schema.match(/pgTable\(\s*"/g) ?? [];
    expect(tables.length).toBeGreaterThan(0);
  });

  it("a runnable runtime guard (check:rls) is wired in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "..", "package.json"), "utf8")
    );
    expect(pkg.scripts?.["check:rls"]).toBeTruthy();
  });

  it("the migrations dir is reachable (guards the path)", () => {
    expect(readdirSync(join(here, "migrations")).length).toBeGreaterThan(0);
  });
});
