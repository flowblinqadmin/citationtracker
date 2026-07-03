import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Use direct connection for schema operations — pgbouncer transaction mode
    // can fail on DDL statements. Falls back to DATABASE_URL if not set.
    url: (process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL)!,
  },
});
