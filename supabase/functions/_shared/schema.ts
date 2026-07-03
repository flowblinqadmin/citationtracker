// Drizzle table definitions — subset required by the beacon Edge Functions.
//
// Sourced from geo/lib/db/schema.ts. Only the columns the two handlers read
// or write are mirrored here. The app-level schema is intentionally NOT
// imported because:
//   1. It drags in @/ aliased app-type modules that don't resolve under Deno.
//   2. It bloats the Edge bundle (each function has its own cold-start cost).
//   3. Defense-in-depth: less surface = less can go wrong if a future query
//      tries to write a table the beacon shouldn't touch.
//
// Mirrors must stay column-name-compatible with the Next.js schema —
// migrations live exclusively in lib/db/migrations/. NEVER define a column
// here that does not already exist in production.

import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "npm:drizzle-orm@0.45.2/pg-core";

// ── geo_sites (read-only for serve-lookup; subset of columns) ───────────────
// resolveSiteForServing() needs: id, domain, slug, pipelineStatus,
// generatedLlmsTxt, generatedLlmsFullTxt, generatedBusinessJson,
// generatedSchemaBlocks, createdAt. Everything else stays out of the bundle.
export const geoSites = pgTable("geo_sites", {
  id: text("id").primaryKey(),
  domain: text("domain").notNull(),
  slug: text("slug").unique().notNull(),
  pipelineStatus: text("pipeline_status").default("pending"),
  generatedLlmsTxt: text("generated_llms_txt"),
  generatedLlmsFullTxt: text("generated_llms_full_txt"),
  generatedBusinessJson: jsonb("generated_business_json"),
  generatedSchemaBlocks: jsonb("generated_schema_blocks"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── rate_limits ────────────────────────────────────────────────────────────
// Used by _shared/rate-limit.ts. Atomic upsert + windowed counter. Keys are
// namespaced by caller (beacon:<ip>, slug-serve:<ip>).
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  resetAt: timestamp("reset_at").notNull(),
});

// ── geo_crawl_logs ─────────────────────────────────────────────────────────
// Written by track-slug via logCrawl(). Records every AI-crawler hit to the
// served asset files. siteId is the FK to geo_sites; the column nullability
// matches the production schema (NOT NULL).
export const geoCrawlLogs = pgTable("geo_crawl_logs", {
  id: text("id").primaryKey(),
  siteId: text("site_id").notNull(),
  slug: text("slug").notNull(),
  fileType: text("file_type").notNull(),
  requestPath: text("request_path").notNull(),
  userAgent: text("user_agent"),
  botName: text("bot_name"),
  ip: text("ip"),
  ipHash: text("ip_hash"), // ES-090 §b.1 COMP-2: HMAC-SHA256 of raw IP
  country: text("country"),
  requestedAt: timestamp("requested_at").defaultNow(),
  // deno-lint-ignore no-explicit-any
}, (table: any) => ({
  siteIdIdx: index("geo_crawl_logs_site_id_idx").on(table.siteId),
  requestedAtIdx: index("geo_crawl_logs_requested_at_idx").on(table.requestedAt),
  botNameIdx: index("geo_crawl_logs_bot_name_idx").on(table.botName),
}));

// ── geo_page_views ─────────────────────────────────────────────────────────
// Written by track-collect on every visitor pageview / custom event. All
// fields from the production table — partial inserts are not safe because
// Drizzle would otherwise reject unknown columns at type-check time.
export const geoPageViews = pgTable("geo_page_views", {
  id: text("id").primaryKey(),
  siteId: text("site_id"),
  slug: text("slug").notNull(),
  pageUrl: text("page_url").notNull(),
  referrer: text("referrer"),
  visitorId: text("visitor_id"),
  userAgent: text("user_agent"),
  botName: text("bot_name").notNull().default("visitor"),
  ip: text("ip"),
  ipHash: text("ip_hash"), // ES-090 §b.1 COMP-2: HMAC-SHA256 of raw IP
  country: text("country"),
  screenWidth: integer("screen_width"),
  websiteDeployId: text("website_deploy_id"),
  viewedAt: timestamp("viewed_at").defaultNow(),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  city: text("city"),
  region: text("region"),
  sessionId: text("session_id"),
  timeOnPageMs: integer("time_on_page_ms"),
  type: text("type").default("pageview"),
  eventName: text("event_name"),
  eventProps: jsonb("event_props"),
  // deno-lint-ignore no-explicit-any
}, (table: any) => ({
  slugIdx: index("geo_page_views_slug_idx").on(table.slug),
  viewedAtIdx: index("geo_page_views_viewed_at_idx").on(table.viewedAt),
  botNameIdx: index("geo_page_views_bot_name_idx").on(table.botName),
  visitorIdIdx: index("geo_page_views_visitor_id_idx").on(table.visitorId),
}));
