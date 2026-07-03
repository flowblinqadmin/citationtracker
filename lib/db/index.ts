import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

// Lazy init: Next evaluates route modules at build time, where DATABASE_URL is
// absent — connecting (or throwing) at import would break the build. The first
// real query creates the client; misconfig still fails loudly, just at request
// time.
let instance: Db | null = null;

function getDb(): Db {
  if (instance) return instance;
  // DATABASE_URL is set by the Supabase Vercel integration — use it first.
  // SUPABASE_DATABASE_URL is a manual override; POSTGRES_URL a last resort.
  const dbUrl =
    process.env.SUPABASE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    process.env.POSTGRES_URL;
  if (!dbUrl) throw new Error("No database URL set (SUPABASE_DATABASE_URL, DATABASE_URL, or POSTGRES_URL required)");

  // max: 1 on Vercel (each invocation is short-lived), higher locally.
  // prepare: false — Supabase pgbouncer runs in transaction mode, which
  // doesn't support prepared statements.
  const isVercel = !!process.env.VERCEL;
  const client = postgres(dbUrl, {
    max: isVercel ? 1 : 5,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  instance = drizzle(client, { schema });
  return instance;
}

export const db: Db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    const value = Reflect.get(getDb(), prop, receiver);
    return typeof value === "function" ? value.bind(getDb()) : value;
  },
});
