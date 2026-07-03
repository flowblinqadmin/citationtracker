#!/usr/bin/env node
/**
 * Applies hand-written Postgres functions in lib/db/rpc/*.sql.
 *
 * Drizzle's `drizzle-kit push` only handles tables/columns/indexes — it
 * doesn't emit `CREATE FUNCTION` for Postgres routines. The Vercel Edge
 * beacon routes call check_rate_limit() via supabase-js .rpc(), so the
 * function must exist in the DB before the Edge routes run in prod.
 *
 * Usage:
 *   SUPABASE_DATABASE_URL=postgres://... node scripts/apply-rpcs.mjs
 *
 * The script is idempotent — each RPC uses CREATE OR REPLACE — and safe
 * to run on every deploy.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RPC_DIR = join(__dirname, "..", "lib", "db", "rpc");

const dbUrl =
  process.env.SUPABASE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL;

if (!dbUrl) {
  console.error("✗ No DB URL set (SUPABASE_DATABASE_URL | DATABASE_URL | POSTGRES_URL)");
  process.exit(1);
}

const sql = postgres(dbUrl, { max: 1, prepare: false });

try {
  const files = readdirSync(RPC_DIR).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) {
    console.log("ℹ no .sql files found in lib/db/rpc/");
    process.exit(0);
  }

  for (const file of files) {
    const body = readFileSync(join(RPC_DIR, file), "utf8");
    process.stdout.write(`→ applying ${file} ... `);
    await sql.unsafe(body);
    console.log("ok");
  }

  console.log(`✓ applied ${files.length} RPC file(s)`);
} catch (err) {
  console.error("✗ apply-rpcs failed:", err);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
