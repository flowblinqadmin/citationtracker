// Drizzle declarations for the SHARED database this service uses.
//
// Every table here is a mirror of a table owned by the geo repo (or, for
// tracker.*, created by geo's tracker migrations). This repo NEVER emits
// migrations for them — declarations exist so Drizzle can query, and must be
// kept in lockstep with geo's schema (see CLAUDE.md "geo contract").
import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

// ── public.rate_limits — DB-backed rate limiter (shared with geo) ───────────
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  resetAt: timestamp("reset_at").notNull(),
});
