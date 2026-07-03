// Drizzle + postgres-js client for Supabase Edge Functions.
//
// Ported from geo/lib/db/index.ts with the Deno-required substitutions:
//   - `process.env.X` → `Deno.env.get("X")`
//   - npm specifiers pinned (postgres@3.4.9, drizzle-orm@0.45.2)
//   - max:1 unconditional — Supabase Edge runs one connection per invocation,
//     and the upstream pgbouncer pool handles concurrency. No `isVercel`
//     branching ported over.
//   - prepare:false preserved — Supabase pgbouncer transaction mode does not
//     support prepared statements.
//
// Security: this module reads ONLY `SUPABASE_DB_URL`. If the project-level
// `SUPABASE_SERVICE_ROLE_KEY` is inherited into the function's env it does
// NOT get used here, but its mere presence is a red flag for RLS-bypass
// surface — log a warning so it surfaces in function logs.

import { drizzle } from "npm:drizzle-orm@0.45.2/postgres-js";
import postgres from "npm:postgres@3.4.9";
import * as schema from "./schema.ts";

const dbUrl = Deno.env.get("SUPABASE_DB_URL");
if (!dbUrl) {
  throw new Error(
    "[db] SUPABASE_DB_URL is required for Supabase Edge Functions",
  );
}

// Defense-in-depth: warn if the inherited project secrets include the
// service-role key. Source never imports it, but a visible key means a
// future bug could opt in by accident. See plan §"Service-role key exposure".
if (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
  console.warn(
    "[security] service role key visible to function — review project secret scoping",
  );
}

const client = postgres(dbUrl, {
  max: 1,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(client, { schema });
