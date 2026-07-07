// Drizzle declarations for the SHARED database this service uses.
//
// Every table here is a MIRROR of a table owned by the geo repo (public.*) or
// created by geo's tracker migrations (tracker.*). This repo NEVER emits
// migrations for them (except the one additive ledger index — see
// lib/db/migrations/). Declarations exist so Drizzle can query; column shapes
// were verified against prod information_schema on 2026-07-03 and must be kept
// in lockstep with geo (schema-drift test enforces).
//
// FK references and secondary indexes are intentionally omitted from mirrors —
// they exist in the real DB (geo's migrations); Drizzle only needs columns.
import { pgTable, pgSchema, text, boolean, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import type {
  TrackerPlatform,
  TrackerPromptCategory,
  TrackerMatchType,
  TrackerReviewStatus,
  TrackerClientStatus,
  TrackerRunFrequency,
  TrackerRunStatus,
  TrackerRunKind,
  TrackerCompetitor,
  TrackerRunMetrics,
  TrackerRunScope,
  TrackerSentiment,
  BrandKeywords,
} from "@/lib/types/tracker";

// ── public.teams — geo's billing tenant (credit balance lives here) ─────────
export const teams = pgTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerUserId: text("owner_user_id").notNull(), // Supabase auth.users UUID
  creditBalance: integer("credit_balance").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});


// ── public.team_members — geo team membership (user → team resolution) ──────
export const teamMembers = pgTable("team_members", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  userId: text("user_id"), // Supabase auth.users UUID — null until invite accepted
  email: text("email").notNull(),
  role: text("role").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});


// ── public.credit_transactions — geo's append-only credit ledger ────────────
// This service writes types citation_run / citation_run_refund /
// citation_redebit with siteId = the tracker runId (geo precedent: BB-03 uses
// siteId for Stripe session ids). A partial unique index on (site_id, type)
// for those types makes every ledger op idempotent by run.
export type CitationLedgerType = "citation_run" | "citation_run_refund" | "citation_redebit";

export const creditTransactions = pgTable("credit_transactions", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  siteId: text("site_id"), // for citation types: the tracker run id
  type: text("type").notNull(),
  description: text("description"),
  pagesConsumed: integer("pages_consumed").default(0),
  creditsChanged: integer("credits_changed").notNull(), // negative for debit
  balanceBefore: integer("balance_before").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});


// ── public.citation_checks — citation verification verdicts ─────────────────
// OWNED by this service (its second migration) — not a geo mirror. One row per
// tracker citation we fetched and classified against AI hallucination:
// 'verified' | 'no_mention' | 'dead' | 'unverifiable'. No FK to
// tracker.citations (geo may purge those); verdicts keep history.
export type CitationCheckStatus = "verified" | "no_mention" | "dead" | "unverifiable";

export const citationChecks = pgTable("citation_checks", {
  citationId: text("citation_id").primaryKey(),
  runId: text("run_id").notNull(),
  clientId: text("client_id").notNull(),
  url: text("url").notNull(),
  status: text("status").$type<CitationCheckStatus>().notNull(),
  httpStatus: integer("http_status"),
  brandMatched: boolean("brand_matched"),
  via: text("via").$type<"fetch" | "crawler" | null>(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── public.ai_search_snapshots — AI Search (Google AI Overview) visibility ──
// OWNED by this service. One row per (prompt, engine) check: was an AI
// Overview shown for the prompt as a Google query, did it mention the brand,
// and which sources it cited. Latest row per prompt is what the UI shows.
export const aiSearchSnapshots = pgTable("ai_search_snapshots", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  promptId: text("prompt_id").notNull(),
  engine: text("engine").notNull().default("google_aio"),
  query: text("query").notNull(),
  present: boolean("present").notNull(),
  brandMentioned: boolean("brand_mentioned"),
  overviewText: text("overview_text"),
  citedUrls: jsonb("cited_urls").$type<Array<{ url: string; label: string }>>().default([]),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── public.rate_limits — DB-backed rate limiter (shared with geo) ───────────
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  resetAt: timestamp("reset_at").notNull(),
});

// ─────────────────────────────────────────────────────────────────────────────
// tracker.* — geo's AI Citation Tracker tables (created by geo's migrations).
// This service stores its data here, scoped to one org per geo team
// (id `team_<teamId>`, NO tracker.members rows — see CLAUDE.md geo contract).
// ─────────────────────────────────────────────────────────────────────────────
const trackerSchema = pgSchema("tracker");

export const trackerOrgs = trackerSchema.table("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  shareDefaults: jsonb("share_defaults").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});


export const trackerClients = trackerSchema.table("clients", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  name: text("name").notNull(),
  domain: text("domain"),
  brandKeywords: jsonb("brand_keywords").$type<BrandKeywords>(),
  competitors: jsonb("competitors").$type<TrackerCompetitor[]>().default([]),
  status: text("status").$type<TrackerClientStatus>().notNull().default("active"),
  runFrequency: text("run_frequency").$type<TrackerRunFrequency>().notNull().default("monthly"),
  shareToken: text("share_token"),
  nextRunAt: timestamp("next_run_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type TrackerClient = typeof trackerClients.$inferSelect;

export const trackerPrompts = trackerSchema.table("prompts", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  name: text("name").notNull(),
  category: text("category").$type<TrackerPromptCategory>().notNull(),
  status: text("status").notNull().default("active"), // "active" | "archived"
  createdAt: timestamp("created_at").defaultNow(),
});


export const trackerPromptVersions = trackerSchema.table("prompt_versions", {
  id: text("id").primaryKey(),
  promptId: text("prompt_id").notNull(),
  version: integer("version").notNull(),
  text: text("text").notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
});


export const trackerRuns = trackerSchema.table("runs", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  orgId: text("org_id").notNull(),
  period: text("period").notNull(), // 'YYYY-MM'
  kind: text("kind").$type<TrackerRunKind>().notNull().default("scheduled"),
  status: text("status").$type<TrackerRunStatus>().notNull().default("pending"),
  cursor: integer("cursor").notNull().default(0),
  promptsTotal: integer("prompts_total"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  error: text("error"),
  metrics: jsonb("metrics").$type<TrackerRunMetrics>(),
  promptVersionsChanged: jsonb("prompt_versions_changed").$type<string[]>().default([]),
  modelsUsed: jsonb("models_used").$type<Record<string, string>>().default({}),
  // Optional execution subset ({promptVersionIds?, platforms?}); NULL = full
  // worklist. Geo's runner filters by this (geo migration
  // 20260703-tracker-run-scope-sentiment).
  scope: jsonb("scope").$type<TrackerRunScope | null>(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type TrackerRun = typeof trackerRuns.$inferSelect;

export const trackerResponses = trackerSchema.table("responses", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  clientId: text("client_id").notNull(),
  promptVersionId: text("prompt_version_id").notNull(),
  platform: text("platform").$type<TrackerPlatform>().notNull(),
  model: text("model"),
  attempt: integer("attempt").notNull().default(1),
  responseText: text("response_text"),
  citedUrls: jsonb("cited_urls").$type<string[]>().default([]),
  brandMentioned: boolean("brand_mentioned").notNull().default(false),
  // 'positive' | 'neutral' | 'negative'; NULL = not classified (pre-migration
  // rows, brand not mentioned, or classification failed).
  sentiment: text("sentiment").$type<TrackerSentiment | null>(),
  responseTimeMs: integer("response_time_ms"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
});


// PCG's article lists (CSV/manual imports). Team brands have none — the
// engine's URL matcher simply finds no article matches ('unmatched'). Mirrored
// because the ported runner/run-metrics read it unconditionally.
export const trackerArticles = trackerSchema.table("articles", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  url: text("url").notNull(),
  normalizedUrl: text("normalized_url").notNull(),
  outlet: text("outlet"),
  headline: text("headline"),
  publishedAt: timestamp("published_at"),
  source: text("source").notNull().default("manual"), // "manual" | "csv"
  batchId: text("batch_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const trackerCitations = trackerSchema.table("citations", {
  id: text("id").primaryKey(),
  responseId: text("response_id"),
  runId: text("run_id").notNull(),
  clientId: text("client_id").notNull(),
  promptVersionId: text("prompt_version_id"),
  platform: text("platform").$type<TrackerPlatform>(),
  rawUrl: text("raw_url").notNull(),
  resolvedUrl: text("resolved_url"),
  normalizedUrl: text("normalized_url").notNull(),
  domain: text("domain").notNull(),
  matchType: text("match_type").$type<TrackerMatchType>().notNull(),
  articleId: text("article_id"),
  competitorDomain: text("competitor_domain"),
  reviewStatus: text("review_status").$type<TrackerReviewStatus>(),
  createdAt: timestamp("created_at").defaultNow(),
});

