import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// DATABASE_URL is set by the Supabase Vercel integration — use it first
// SUPABASE_DATABASE_URL is a manual override (legacy)
// POSTGRES_URL may point to old Neon integration — last resort
const dbUrl =
  process.env.SUPABASE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL;
if (!dbUrl) throw new Error("No database URL set (SUPABASE_DATABASE_URL, DATABASE_URL, or POSTGRES_URL required)");

// max: 1 on Vercel (each invocation is short-lived), higher locally for concurrent requests
// prepare: false — Supabase pgbouncer runs in transaction mode, which doesn't support prepared statements
const isVercel = !!process.env.VERCEL;
const client = postgres(dbUrl, {
  max: isVercel ? 1 : 5,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 10,
});
export const db = drizzle(client, { schema });
