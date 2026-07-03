import { pgTable, text, boolean, timestamp, integer, jsonb, index, real, varchar, uuid } from "drizzle-orm/pg-core";
import { vector } from "drizzle-orm/pg-core";
import { SIGNUP_BONUS_CREDITS, FREE_MAX_PAGES, type SubscriptionTier, type CrawlFrequency } from "@/lib/config";
import { type ProviderResult, type DiscoveredCompetitor, type UserCompetitor, type CompetitorCitationData, type PillarQA, type CitationPrompt, type GeoVisibility, type CategoryVisibility, type TierVisibility, type VisibilityGapEntry, type CrawlCoverageReport, type LocationCompetitor, type CategoryCompetitor, type DominanceMap, type RealPromptDiscovery } from "@/lib/types/citation";
import type { GeoTree, CategoryTree, GeoCategoryMapping } from "@/lib/types/trees";
import type { ContentStrategyReport, EnginePreference } from "@/lib/types/content-strategy";
import type { BrandKeywords } from "@/lib/services/brand-detector";
import type { ExtractedCategories } from "@/lib/services/category-extractor";

// ── Billing & lifecycle domain unions (FIX-018) ──────────────────────────────
// These encode the finite, load-bearing domains that were previously open `text`
// columns. Applying them via `.$type<>()` turns contradictory / typo / dead values
// into compile-time errors instead of silently-accepted strings. Runtime writers
// (the canonical entitlement writer, pipeline status transitions) live in their own
// modules — this file only declares the domains so every writer agrees on them.
//
// `SubscriptionTier` ('free'|'starter'|'growth'|'pro') and `CrawlFrequency`
// ('manual'|'daily'|'weekly'|'monthly') are imported from `@/lib/config`, which is
// the single source of truth for the tier table and frequency enum.

/**
 * Subscription lifecycle status — the Stripe-derived states we persist.
 * (FIND-TYPEDESIGN-005) Previously open `text`, forcing `as SubscriptionStatus`
 * casts at every read site.
 */
export type SubscriptionStatus = "active" | "past_due" | "canceled" | "inactive";

/**
 * Billing entitlement discriminator (FIND-TYPEDESIGN-001).
 *
 * Exactly ONE model governs a team's crawl budget:
 *   - 'free'           → FREE_MAX_PAGES only (no credit pool, no allowance)
 *   - 'page_allowance' → `monthlyPageAllowance` is authoritative; credits are top-ups
 *   - 'credit_pool'    → `creditBalance` is authoritative
 *
 * The previous design left credit pool vs page allowance implicit in two
 * orthogonal integer columns, so each Stripe webhook path wrote a different
 * (creditBalance, monthlyPageAllowance) quadrant and resolvers disagreed on the
 * authoritative denominator. This discriminator makes the model explicit; the
 * canonical entitlement writer is the only path that should mutate
 * `billingModel` together with `creditBalance` / `monthlyPageAllowance` /
 * `subscriptionTier`.
 */
export type BillingModel = "free" | "page_allowance" | "credit_pool";

/**
 * `credit_transactions.type` ledger domain (FIND-TYPEDESIGN-008).
 *
 * Enumerates every value written by a ledger insert today. Previously the
 * allowed set lived only in a column comment — which had already drifted
 * ('crawl_reserve' was written but undocumented). Encoding it here makes every
 * insert use a member and lets reconciliation/reporting switches be
 * exhaustiveness-checked.
 *
 * `crawl_debit` / `refund` have no current writer but are retained because this
 * is an append-only ledger and historical rows may still carry them — dropping
 * them from the domain would mis-type reads of pre-existing data.
 */
export type CreditTxnType =
  // reservations / debits
  | "crawl_reserve"
  | "single_crawl_reserve"
  | "bulk_crawl_reserve"
  | "recrawl_reserve"
  | "citation_check_debit"
  | "competitor_discovery_debit"
  | "pdf_download"
  | "zip_download"
  | "fix_html_render"
  // reversals / refunds
  | "crawl_reserve_reversal"
  | "crawl_refund"
  | "bulk_crawl_refund"
  // credits in
  | "topup"
  | "signup_bonus"
  | "bulk_retry_failed_free"
  // legacy — no current writer; retained for historical-row read safety
  | "crawl_debit"
  | "refund";

/**
 * `geo_sites.pipeline_status` lifecycle (FIND-TYPEDESIGN-009).
 *
 * The closed set of states a pipeline run can hold. Listed in lifecycle order:
 * pre-run → in-progress stages → terminal. The dead legacy 'processing' status
 * (FIND-CODE-033 — no production writer) is deliberately ABSENT so that the
 * recovery cron's status maps become a type error when they opt into this union,
 * forcing its removal (handled in the cron slot). The compare-only typos
 * 'running' / 'research' (present only in stale `===` checks, never written) are
 * likewise absent so the type surfaces them.
 */
export type PipelineStatus =
  | "pending"
  | "queued"
  | "discovery"
  | "crawling"
  | "extracting"
  | "researching"
  | "analyzing"
  | "generating"
  | "assembling"
  | "complete"
  | "failed";

// Teams table — one team per account (created on first Supabase login)
export const teams = pgTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerUserId: text("owner_user_id").notNull(), // Supabase auth.users UUID
  creditBalance: integer("credit_balance").notNull().default(SIGNUP_BONUS_CREDITS),
  stripeCustomerId: text("stripe_customer_id"),

  // Subscription fields
  subscriptionTier: text("subscription_tier").$type<SubscriptionTier>().notNull().default("free"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  subscriptionStatus: text("subscription_status").$type<SubscriptionStatus>().notNull().default("inactive"),
  // Billing entitlement discriminator (FIX-018 / FIND-TYPEDESIGN-001) — see BillingModel.
  // Governs whether creditBalance or monthlyPageAllowance is authoritative. Defaults to
  // 'free'; the canonical entitlement writer sets it alongside the tier on every paid path.
  billingModel: text("billing_model").$type<BillingModel>().notNull().default("free"),
  monthlyPageAllowance: integer("monthly_page_allowance").notNull().default(FREE_MAX_PAGES),
  monthlyPagesUsed: integer("monthly_pages_used").notNull().default(0),
  currentPeriodEnd: timestamp("current_period_end"),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;

// Team members — owner + invited members
export const teamMembers = pgTable("team_members", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull().references(() => teams.id),
  userId: text("user_id"),       // Supabase auth.users UUID — null until invite accepted
  email: text("email").notNull(), // denormalized
  role: text("role").notNull().default("member"), // "owner" | "member"
  inviteToken: text("invite_token"), // nanoid, null once accepted
  inviteAcceptedAt: timestamp("invite_accepted_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;

// Team domains — links geo_sites to teams
export const teamDomains = pgTable("team_domains", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull().references(() => teams.id),
  siteId: text("site_id").notNull().references(() => geoSites.id),
  domain: text("domain").notNull(), // denormalized
  addedByUserId: text("added_by_user_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type TeamDomain = typeof teamDomains.$inferSelect;
export type NewTeamDomain = typeof teamDomains.$inferInsert;

// Credit transactions — full audit log of credits in/out
export const creditTransactions = pgTable("credit_transactions", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull().references(() => teams.id),
  siteId: text("site_id"), // which crawl consumed credits (nullable for topups)
  // ES-B9 §credit AC-B9-10: when type='bulk_retry_failed_free' (γ policy),
  // siteId is the new retry site row and parentSiteId points back at the
  // original failed bulk audit. NULL on every other ledger type.
  parentSiteId: text("parent_site_id"),
  type: text("type").$type<CreditTxnType>().notNull(), // closed domain — see CreditTxnType (FIX-018 / FIND-TYPEDESIGN-008)
  description: text("description"), // FIND-025: optional human-readable ledger note; persisted by deductCredits
  pagesConsumed: integer("pages_consumed").default(0),
  creditsChanged: integer("credits_changed").notNull(), // negative for debit
  balanceBefore: integer("balance_before").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type CreditTransaction = typeof creditTransactions.$inferSelect;
export type NewCreditTransaction = typeof creditTransactions.$inferInsert;

export const geoSites = pgTable("geo_sites", {
  id: text("id").primaryKey(),
  domain: text("domain").notNull(),
  slug: text("slug").unique().notNull(),
  ownerEmail: text("owner_email").notNull(),
  // Supabase team/user link — null for anonymous (pre-login) users
  teamId: text("team_id").references(() => teams.id),
  userId: text("user_id"), // nullable Supabase auth.users UUID

  // Email verification
  emailVerified: boolean("email_verified").default(false),
  verificationCode: text("verification_code"),
  codeExpiresAt: timestamp("code_expires_at"),
  accessToken: text("access_token"),
  // ES-090 §b.1 CRIT-1: NOT NULL with 90-day DEFAULT so new rows always have an expiry
  // even if the writer forgets. Backfill (migration) satisfies existing rows.
  // HP-196/HP-197: closes the "NULL = valid forever" class of bugs at the column level.
  // JS-side default via $defaultFn keeps schema.ts free of `sql` imports (many
  // tests partial-mock drizzle-orm and would need to re-export it otherwise).
  // The DB column default is set at the migration-SQL level (`NOW() + 90 days`).
  tokenExpiresAt: timestamp("token_expires_at").notNull().$defaultFn(() => new Date(Date.now() + 90 * 86_400_000)),
  tokenRotatedAt: timestamp("token_rotated_at"), // nullable — rotate writes it, fresh rows don't need it

  // Stripe / payment
  stripeCustomerId: text("stripe_customer_id"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  paymentStatus: text("payment_status").default("pending"),

  // Pipeline data (jsonb)
  discoveryData: jsonb("discovery_data"),
  crawlData: jsonb("crawl_data"),           // final merged crawl result (complete) OR scrape-pass pages (crawling)
  crawlJobIds: jsonb("crawl_job_ids").$type<string[]>(),  // active Firecrawl async job IDs being polled
  researchData: jsonb("research_data"),
  geoScorecard: jsonb("geo_scorecard"),

  // Geographic & Category trees (ES-053 / C2+C3)
  geoTree: jsonb("geo_tree").$type<GeoTree>(),
  categoryTree: jsonb("category_tree").$type<CategoryTree>(),
  geoCategoryMapping: jsonb("geo_category_mapping").$type<GeoCategoryMapping>(),
  // ES-084 AC-3: operator-monitoring only — set by handleExtractTrees catch
  // block on extraction failure. NO production code path consumes this field
  // per HP-177 amendment (re-extraction trigger uses ES-086 AC-15 treeIsEmpty
  // structure detection, not failure timestamp).
  treeExtractionFailedAt: timestamp("tree_extraction_failed_at"),

  // Generated files
  generatedLlmsTxt: text("generated_llms_txt"),
  generatedLlmsFullTxt: text("generated_llms_full_txt"),
  generatedBusinessJson: jsonb("generated_business_json"),
  generatedSchemaBlocks: jsonb("generated_schema_blocks"),
  recommendations: jsonb("recommendations"),
  executiveSummary: text("executive_summary"),

  // Site metadata
  platformDetected: text("platform_detected"),
  siteType: text("site_type"),

  // Pipeline state
  pipelineStatus: text("pipeline_status").$type<PipelineStatus>().default("pending"),
  pipelineError: text("pipeline_error"),

  // Bulk CSV audit fields
  auditMode:       text("audit_mode").default("single"),   // "single" | "bulk"
  // ES-B9.3 (legacy) — preserved nullable; B10 reverted to in-place rerun
  // and no longer writes this column. Historical breadcrumbs from the
  // pre-B10 spawn-on-rerun architecture remain readable.
  parentSiteId:    text("parent_site_id"),
  // ES-B10 AC-B10-7 — in-place rerun tracking.
  currentRunNumber: integer("current_run_number").notNull().default(1),
  currentRunKind:   text("current_run_kind").notNull().default("initial"),
  retrySubsetUrls:  jsonb("retry_subset_urls"),
  bulkUrls:        jsonb("bulk_urls"),                     // string[] of raw CSV URLs
  bulkUrlCount:    integer("bulk_url_count"),              // denormalized count
  crawlLimit:      integer("crawl_limit"),                 // effective page cap: min(csv, affordable, ABSOLUTE_MAX_PAGES)
  // ES-083 AC-8: count of brand-level URLs auto-discovered and added to the
  // crawl beyond the customer's bulk URL list. Informational only — does NOT
  // count against bulk_url_count credit budget per AC-6/AC-7.
  autoDiscoveredUrlCount: integer("auto_discovered_url_count"),
  creditsReserved: integer("credits_reserved"),            // credits reserved at OTP verification
  subscriptionPagesReserved: integer("subscription_pages_reserved").default(0), // subscription pages reserved at audit start — cleared + reconciled at assemble (NEW-P-01)
  perPageResults:       jsonb("per_page_results"),              // Array<PerPageResult>
  perPageFixes:         jsonb("per_page_fixes"),               // Array<PerPageFix>
  previousPerPageFixes: jsonb("previous_per_page_fixes"),      // Array<PerPageFix> — snapshot from prior run
  implementationStatus: jsonb("implementation_status"),        // Array<ImplementationStatus>
  crawlCoverageReport:      jsonb("crawl_coverage_report").$type<CrawlCoverageReport>(), // ES-054
  contentStrategyScores:    jsonb("content_strategy_scores").$type<ContentStrategyReport>(), // ES-055
  enginePreferences:        jsonb("engine_preferences").$type<EnginePreference[]>(),          // ES-055
  reportZipUrl:    text("report_zip_url"),                 // future: Supabase Storage URL
  // Bulk batch identifier — all domains from the same CSV upload share this ID.
  // null for single-audit sites. Never cleared after creation (unlike verificationCode).
  batchId:         text("batch_id"),

  // Public API / free-tier tracking (ES-019)
  freeOptimizationUsed: boolean("free_optimization_used").default(false),
  freeRunNumber:        integer("free_run_number").default(1),   // 1 = baseline, 2 = post-opt
  apiClientId:          text("api_client_id"),                   // nullable FK to api_clients.client_id

  // Subscription crawl settings
  crawlFrequency: text("crawl_frequency").$type<CrawlFrequency>().notNull().default("manual"),
  selectedPages: jsonb("selected_pages").$type<string[]>(),

  // Crawl scheduling
  lastCrawlAt: timestamp("last_crawl_at"),
  nextCrawlAt: timestamp("next_crawl_at"),
  crawlCount: integer("crawl_count").default(0),
  manualRunsThisMonth: integer("manual_runs_this_month").default(0),
  manualRunsResetAt: timestamp("manual_runs_reset_at"),

  // Marketing report (public, no generated files)
  shareToken: text("share_token"),

  // Previous run snapshot (for diff view on regenerate)
  previousRunSnapshot: jsonb("previous_run_snapshot"),

  // Baseline scorecard (Score0: first pipeline run, for before/after comparison)
  baselineScorecard: jsonb("baseline_scorecard"),

  // Change tracking
  changeLog: jsonb("change_log"),
  lastSignificantChange: timestamp("last_significant_change"),

  // Domain verification
  domainVerified: boolean("domain_verified").default(false),
  verifyToken: text("verify_token"),

  // Email alias canonicalization for free-audit-limit enforcement (NEW-A-02).
  // Stores the canonical form of ownerEmail (gmail dot/plus stripped) so the
  // FREE_AUDIT_LIMIT count can use an indexed equality scan instead of a full
  // table scan + app-side filter. Nullable — populated going forward; existing
  // rows may be NULL (limit only needs going-forward correctness).
  ownerEmailCanonical: text("owner_email_canonical"),

  // OTP brute-force protection (DB-backed, persists across Vercel instances)
  otpAttempts:    integer("otp_attempts").notNull().default(0),
  otpLockedUntil: timestamp("otp_locked_until"),

  // Crawl fan-out coordination (ES-023 / TS-023)
  crawlChunksTotal:  integer("crawl_chunks_total"),
  crawlChunksDone:   integer("crawl_chunks_done"),
  crawlChunkResults: jsonb("crawl_chunk_results").$type<import("@/lib/services/geo-crawler").CrawledPage[][]>(),
  crawlStartedAt:    timestamp("crawl_started_at"),
  crawlFailedUrls:   jsonb("crawl_failed_urls").$type<string[]>(),

  // Generate fan-out coordination (TS-034+)
  generateChunksTotal: integer("generate_chunks_total"),
  generateChunksDone:  integer("generate_chunks_done"),

  // Pre-analyze fan-in counter — extract-trees + research increment, analyze
  // reads. Starts at 0; reset to 0 at the start of a fresh pipeline run (see
  // app/api/pipeline/stage/route.ts:597). HP perf Fix 1.
  preAnalyzeDone: integer("pre_analyze_done").notNull().default(0),

  // Competitor intelligence (TS-030)
  discoveredCompetitors: jsonb("discovered_competitors").$type<DiscoveredCompetitor[]>().default([]),
  userCompetitors: jsonb("user_competitors").$type<UserCompetitor[]>().default([]),
  competitorBlocklist: jsonb("competitor_blocklist").$type<string[]>().default([]),

  // Hallucination risk score (0-100) — computed from grounding check failures
  hallucinationRisk: integer("hallucination_risk"),

  // LLM-generated citation narrative (cached, regenerated on each new scan)
  citationNarrative: text("citation_narrative"),

  // Brand detection (ES-059 / Part A)
  brandKeywords:       jsonb("brand_keywords").$type<BrandKeywords>(),
  // LLM category extraction (ES-059 / Part B)
  extractedCategories: jsonb("extracted_categories").$type<ExtractedCategories>(),

  // Timestamps
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  // NEW-A-02: indexed equality scan for free-audit-limit enforcement via canonical email.
  ownerEmailCanonicalIdx: index("idx_geo_sites_owner_email_canonical").on(table.ownerEmailCanonical),
}));

export type GeoSite = typeof geoSites.$inferSelect;
export type NewGeoSite = typeof geoSites.$inferInsert;

// ── Read-optimized view table for dashboard + report page rendering ──────────
// Pipeline writes here at the end of each stage. Rendering reads ONLY from this table.
// geoSites is the pipeline working table — never read for rendering.
// NOTE (integration review 2026-06-09): despite the `_view` suffix, this is a
// real BASE TABLE — a denormalized READ-MODEL of geo_sites for fast public/serve
// reads (serve/[slug]/*, report/[shareToken], dashboard). It is NOT a SQL view
// and is NOT auto-synced; writers must update it alongside geo_sites. Treat it as
// `geo_site_read_model`. Kept as `geo_site_view` to avoid a high-blast-radius
// rename across the serve endpoints + migrations; renaming is tracked as a
// follow-up. Reads here go via the service role, so RLS+REVOKE don't affect it.
export const geoSiteView = pgTable("geo_site_view", {
  siteId:             text("site_id").primaryKey(),
  domain:             text("domain").notNull(),
  slug:               text("slug"),
  teamId:             text("team_id"),
  accessToken:        text("access_token"),
  // ES-090 §b.1 CRIT-1: mirror of geoSites.tokenExpiresAt so GET /sites/[id]
  // can enforce expiry without a join. Nullable on the view (treat NULL as expired per HP-197).
  tokenExpiresAt:     timestamp("token_expires_at"),
  pipelineStatus:     text("pipeline_status").$type<PipelineStatus>(),  // FIX-018 — mirror of geoSites.pipelineStatus domain
  pipelineError:      text("pipeline_error"),
  overallScore:       integer("overall_score"),
  previousScore:      integer("previous_score"),
  projectedScore:     integer("projected_score"),
  projectedBoost:     integer("projected_boost"),
  baselineScore:      integer("baseline_score"),
  pillars:            jsonb("pillars"),
  pillarDeltas:       jsonb("pillar_deltas"),
  pageCount:          integer("page_count").default(0),
  citationRate:       integer("citation_rate"),
  crawlCount:         integer("crawl_count").default(0),
  manualRunsMonth:    integer("manual_runs_month").default(0),
  executiveSummary:   text("executive_summary"),
  rankedRecommendations: jsonb("ranked_recommendations"),
  changeLog:          jsonb("change_log"),
  perPageResults:     jsonb("per_page_results"),
  perPageFixes:       jsonb("per_page_fixes"),
  implementationStatus: jsonb("implementation_status"),
  generatedLlmsTxt:      text("generated_llms_txt"),
  generatedLlmsFullTxt:  text("generated_llms_full_txt"),
  generatedBusinessJson: jsonb("generated_business_json"),
  generatedSchemaBlocks: jsonb("generated_schema_blocks"),
  discoveryData:      jsonb("discovery_data"),
  platformDetected:   text("platform_detected"),
  shareToken:         text("share_token"),
  domainVerified:     boolean("domain_verified").default(false),
  verifyToken:        text("verify_token"),
  citationNarrative:  text("citation_narrative"),
  discoveredCompetitors: jsonb("discovered_competitors"),
  userCompetitors:    jsonb("user_competitors"),
  competitorBlocklist: jsonb("competitor_blocklist"),
  brandKeywords:      jsonb("brand_keywords"),
  extractedCategories: jsonb("extracted_categories"),
  baselineScorecard:  jsonb("baseline_scorecard"),
  lastCrawlAt:        timestamp("last_crawl_at"),
  nextCrawlAt:        timestamp("next_crawl_at"),
  createdAt:          timestamp("created_at"),
  updatedAt:          timestamp("updated_at").defaultNow(),
}, (table) => ({
  teamIdx:   index("idx_gsv_team").on(table.teamId),
  domainIdx: index("idx_gsv_domain").on(table.domain),
}));

export type GeoSiteView = typeof geoSiteView.$inferSelect;
export type NewGeoSiteView = typeof geoSiteView.$inferInsert;

// Known AI crawler user agent patterns
// GPTBot, ClaudeBot, PerplexityBot, GoogleExtended, cohere-ai, meta-externalagent, Applebot, etc.
export const geoCrawlLogs = pgTable("geo_crawl_logs", {
  id: text("id").primaryKey(),                          // nanoid
  siteId: text("site_id").notNull(),                    // FK to geo_sites.id
  slug: text("slug").notNull(),                         // denormalized for fast queries without join

  // What was requested
  fileType: text("file_type").notNull(),                // llms_txt | llms_full_txt | business_json | schema_json
  requestPath: text("request_path").notNull(),          // full path e.g. /api/serve/flowblinq-com/llms.txt

  // Who requested it
  userAgent: text("user_agent"),                        // raw UA string
  botName: text("bot_name"),                            // parsed: GPTBot | ClaudeBot | PerplexityBot | GoogleExtended | unknown
  ip: text("ip"),                                       // hashed or raw depending on privacy decision later
  ipHash: text("ip_hash"),                              // ES-090 §b.1 COMP-2: HMAC-SHA256 of raw IP; raw ip retained until backfill + 1w safety window
  country: text("country"),                             // from CF-IPCountry or x-vercel-ip-country header

  // When
  requestedAt: timestamp("requested_at").defaultNow(),
}, (table) => ({
  siteIdIdx: index("geo_crawl_logs_site_id_idx").on(table.siteId),
  requestedAtIdx: index("geo_crawl_logs_requested_at_idx").on(table.requestedAt),
  botNameIdx: index("geo_crawl_logs_bot_name_idx").on(table.botName),
}));

export type GeoCrawlLog = typeof geoCrawlLogs.$inferSelect;
export type NewGeoCrawlLog = typeof geoCrawlLogs.$inferInsert;

// Chunked Firecrawl batch scrape jobs — one row per 500-URL chunk (OPS-010 Task 4)
// status: pending → scraping → completed | failed
export const firecrawlJobs = pgTable("firecrawl_jobs", {
  id: text("id").primaryKey(),                              // nanoid
  siteId: text("site_id").notNull().references(() => geoSites.id), // the bulk audit site
  firecrawlJobId: text("firecrawl_job_id").notNull(),       // Firecrawl batch/scrape job ID
  chunkIndex: integer("chunk_index").notNull(),             // 0-based chunk position
  urlCount: integer("url_count").notNull(),                 // number of URLs in this chunk
  status: text("status").notNull().default("pending"),      // "pending" | "scraping" | "completed" | "failed"
  urlsSubmitted: jsonb("urls_submitted").$type<string[]>().notNull(), // exact URLs sent
  urlsCompleted: jsonb("urls_completed").$type<string[]>().default([]), // URLs that returned content
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type FirecrawlJob = typeof firecrawlJobs.$inferSelect;
export type NewFirecrawlJob = typeof firecrawlJobs.$inferInsert;

// ── AI Citation Monitoring (TS-015 / Issue #104) ──────────────────────────

// One row per (site, provider, prompt) combination
export const citationCheckResponses = pgTable("citation_check_responses", {
  id:                   text("id").primaryKey(),
  checkId:              text("check_id").notNull(),
  siteId:               text("site_id").notNull().references(() => geoSites.id, { onDelete: "cascade" }),
  provider:             text("provider").notNull(),
  model:                text("model").notNull(),
  query:                text("query").notNull(),
  response:             text("response"),
  responseTimeMs:       integer("response_time_ms"),
  mentioned:            boolean("mentioned").notNull().default(false),
  position:             integer("position"),
  sentiment:            text("sentiment"),
  competitorsMentioned: jsonb("competitors_mentioned").$type<string[]>().default([]),
  impressionShare:      integer("impression_share"), // ES-054: 0-100, nullable
  error:                text("error"),
  createdAt:            timestamp("created_at").defaultNow(),
}, (table) => ({
  checkIdIdx: index("citation_responses_check_id_idx").on(table.checkId),
  siteIdIdx:  index("citation_responses_site_id_idx").on(table.siteId),
}));

export type CitationCheckResponse = typeof citationCheckResponses.$inferSelect;
export type NewCitationCheckResponse = typeof citationCheckResponses.$inferInsert;

// One row per check run — aggregated scores
export const citationCheckScores = pgTable("citation_check_scores", {
  checkId:              text("check_id").primaryKey(),
  siteId:               text("site_id").notNull().references(() => geoSites.id, { onDelete: "cascade" }),
  teamId:               text("team_id").notNull(),
  domain:               text("domain").notNull(),
  overallVisibility:    integer("overall_visibility").notNull(),
  bestProvider:         text("best_provider"),
  worstProvider:        text("worst_provider"),
  avgPosition:          integer("avg_position"),
  sentimentScore:       integer("sentiment_score").notNull(),
  providerResults:      jsonb("provider_results").$type<ProviderResult[]>().notNull(),
  competitorVisibility: jsonb("competitor_visibility").$type<Record<string, number>>().default({}), // deprecated — use competitorData
  competitorData:       jsonb("competitor_data").$type<CompetitorCitationData[]>().default([]),
  pillarVisibility:     jsonb("pillar_visibility").$type<Record<string, number>>().default({}),
  pillarQA:             jsonb("pillar_qa").$type<Record<string, PillarQA>>().default({}),
  indirectVisibility:   integer("indirect_visibility").notNull().default(0),
  brandKnowledge:       integer("brand_knowledge").notNull().default(0),
  citationQualityScore: integer("citation_quality_score").notNull().default(0),
  creditsUsed:          integer("credits_used").notNull().default(5),
  promptsUsed:          jsonb("prompts_used").$type<string[]>().notNull(),
  // Full prompt array with geo/category/tier tags (ES-053 / C4)
  promptMetadata:       jsonb("prompt_metadata").$type<CitationPrompt[]>(),
  // ES-054: Tier 2 — dimensional visibility + impression share + gap analysis
  geoVisibility:        jsonb("geo_visibility").$type<GeoVisibility[]>().default([]),
  categoryVisibility:   jsonb("category_visibility").$type<CategoryVisibility[]>().default([]),
  tierVisibility:       jsonb("tier_visibility").$type<TierVisibility[]>().default([]),
  avgImpressionShare:   integer("avg_impression_share"),
  visibilityGapAnalysis: jsonb("visibility_gap_analysis").$type<VisibilityGapEntry[]>().default([]),
  // ES-056: Tier 4 — competitive intelligence
  locationCompetitors:  jsonb("location_competitors").$type<LocationCompetitor[]>().default([]),
  categoryCompetitors:  jsonb("category_competitors").$type<CategoryCompetitor[]>().default([]),
  dominanceMap:         jsonb("dominance_map").$type<DominanceMap>(),
  realPromptDiscovery:  jsonb("real_prompt_discovery").$type<RealPromptDiscovery[]>(),
  // TS-058: V2 prompt architecture version flag
  promptArchitectureVersion: integer("prompt_architecture_version").default(1),
  createdAt:            timestamp("created_at").defaultNow(),
}, (table) => ({
  siteIdIdx: index("citation_scores_site_id_idx").on(table.siteId),
  teamIdIdx: index("citation_scores_team_id_idx").on(table.teamId),
}));

export type CitationCheckScore = typeof citationCheckScores.$inferSelect;
export type NewCitationCheckScore = typeof citationCheckScores.$inferInsert;

// ── IP Rate Limit Persistence (TS-017 / Issue #109) ──────────────────────────
// DB-backed rate limiter — replaces in-memory Map that resets on cold start.

export const rateLimits = pgTable("rate_limits", {
  key:     text("key").primaryKey(),
  count:   integer("count").notNull().default(0),
  resetAt: timestamp("reset_at").notNull(),
});

// ── TOS/EULA Click-Wrap Consent Records (immutable legal log) ───────────────
export const consentRecords = pgTable("consent_records", {
  id:          text("id").primaryKey(),
  userId:      text("user_id").notNull(),
  email:       text("email").notNull(),
  tosVersion:  text("tos_version").notNull(),
  eulaVersion: text("eula_version").notNull(),
  acceptedAt:  timestamp("accepted_at").notNull().defaultNow(),
  ipAddress:   text("ip_address"),
  userAgent:   text("user_agent"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index("idx_consent_records_user_id").on(table.userId),
}));

export type ConsentRecord = typeof consentRecords.$inferSelect;
export type NewConsentRecord = typeof consentRecords.$inferInsert;

// ── Public API Clients (ES-019) ───────────────────────────────────────────────
// One row per OAuth client (e.g. a WordPress plugin install, a CI runner)

export const apiClients = pgTable("api_clients", {
  id:               text("id").primaryKey(),                          // nanoid()
  teamId:           text("team_id").notNull().references(() => teams.id),
  clientId:         text("client_id").unique().notNull(),             // nanoid(24), public
  clientSecretHash: text("client_secret_hash").notNull(),            // bcrypt hash
  name:             text("name").notNull(),                           // e.g. "WordPress Plugin"
  scopes:           text("scopes").array().notNull().default([]),     // ["audit:read","audit:write","account:read"]
  createdByUserId:  text("created_by_user_id"),                       // nullable for backcompat
  lastUsedAt:       timestamp("last_used_at"),
  revokedAt:        timestamp("revoked_at"),
  consecutiveBadRequests: integer("consecutive_bad_requests").notNull().default(0),  // ES-087: auto-block counter
  blockedAt:        timestamp("blocked_at", { withTimezone: true }),                  // ES-087: auto-set on threshold breach
  createdAt:        timestamp("created_at").defaultNow(),
});

export type ApiClient = typeof apiClients.$inferSelect;
export type NewApiClient = typeof apiClients.$inferInsert;

// ── API Audit Tables (Commerce Readiness Audit) ─────────────────────────────

export const auditReports = pgTable("audit_reports", {
  id: text("id").primaryKey(),
  merchant_url: text("merchant_url").notNull(),
  merchant_name: text("merchant_name").notNull(),
  contact_email: text("contact_email").notNull(),
  product_category: text("product_category"),
  revenue_estimate: text("revenue_estimate"),

  // Verification
  verification_code: text("verification_code"),
  code_expires_at: timestamp("code_expires_at"),
  email_verified: boolean("email_verified").default(false),

  // Processing status
  status: text("status").notNull().default("pending_verification"),

  // Phase results (stored as JSONB)
  intelligence_data: jsonb("intelligence_data"),
  technical_data: jsonb("technical_data"),
  sov_data: jsonb("sov_data"),
  semantic_data: jsonb("semantic_data"),

  // Commerce readiness report data
  commerce_data: jsonb("commerce_data"),

  // Computed results
  overall_score: integer("overall_score"),
  platform_detected: text("platform_detected"),

  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export type AuditReport = typeof auditReports.$inferSelect;
export type NewAuditReport = typeof auditReports.$inferInsert;

export const acpMonitoring = pgTable("acp_monitoring", {
  id: text("id").primaryKey(),
  domain: text("domain").notNull(),
  vertical: text("vertical").notNull(),
  probe_results: jsonb("probe_results").notNull(),
  probe_scores: jsonb("probe_scores").notNull(),
  infrastructure_score: integer("infrastructure_score").notNull(),
  checked_at: timestamp("checked_at").defaultNow(),
});

export type AcpMonitoring = typeof acpMonitoring.$inferSelect;
export type NewAcpMonitoring = typeof acpMonitoring.$inferInsert;

// ── Tracking Pixel Page Views ────────────────────────────────────────────────
// Logged by /api/t/collect — customers embed a <script> tag that fires a beacon on every pageview.

export const geoPageViews = pgTable("geo_page_views", {
  id:              text("id").primaryKey(),                      // nanoid
  siteId:          text("site_id"),                              // resolved from slug (nullable)
  slug:            text("slug").notNull(),                       // customer slug baked into the JS
  pageUrl:         text("page_url").notNull(),                   // full URL of the visited page
  referrer:        text("referrer"),                             // document.referrer or _geo_ref (server-side)
  visitorId:       text("visitor_id"),                           // _geo_vid cookie — persistent 30-day visitor ID for journey tracking
  userAgent:       text("user_agent"),                           // raw UA string
  botName:         text("bot_name").notNull().default("visitor"),// parsed bot name or "visitor"
  ip:              text("ip"),                                   // visitor IP
  ipHash:          text("ip_hash"),                              // ES-090 §b.1 COMP-2: HMAC-SHA256 of raw IP
  country:         text("country"),                              // x-vercel-ip-country / cf-ipcountry
  screenWidth:     integer("screen_width"),                      // screen.width from browser
  websiteDeployId: text("website_deploy_id"),                    // NEXT_PUBLIC_VERCEL_DEPLOYMENT_ID of the site that loaded us
  viewedAt:        timestamp("viewed_at").defaultNow(),
  // Analytics enrichment fields
  utmSource:       text("utm_source"),                           // utm_source from page URL query string
  utmMedium:       text("utm_medium"),                           // utm_medium from page URL query string
  utmCampaign:     text("utm_campaign"),                         // utm_campaign from page URL query string
  city:            text("city"),                                 // x-vercel-ip-city header
  region:          text("region"),                               // x-vercel-ip-region-code header
  sessionId:       text("session_id"),                           // client-generated session ID (sessionStorage)
  timeOnPageMs:    integer("time_on_page_ms"),                   // time on page in milliseconds
  type:            text("type").default("pageview"),             // 'pageview' | 'event'
  eventName:       text("event_name"),                           // custom event name
  eventProps:      jsonb("event_props"),                         // custom event properties
}, (table) => ({
  slugIdx:      index("geo_page_views_slug_idx").on(table.slug),
  viewedAtIdx:  index("geo_page_views_viewed_at_idx").on(table.viewedAt),
  botNameIdx:   index("geo_page_views_bot_name_idx").on(table.botName),
  visitorIdIdx: index("geo_page_views_visitor_id_idx").on(table.visitorId),
}));

export type GeoPageView = typeof geoPageViews.$inferSelect;
export type NewGeoPageView = typeof geoPageViews.$inferInsert;

// ── Integration Probe Cache (Chatbot) ──────────────────────────────────────
// Caches HEAD probe results for llms.txt and schema.json (15-min TTL).
// Tracking pixel last-seen is queried fresh (cheap indexed query).
export const integrationProbeCache = pgTable("integration_probe_cache", {
  siteId: varchar("site_id", { length: 191 }).primaryKey(),
  llmsTxtOk: boolean("llms_txt_ok"),
  llmsTxtMethod: varchar("llms_txt_method", { length: 32 }),
  llmsTxtCheckedAt: timestamp("llms_txt_checked_at"),
  schemaJsonOk: boolean("schema_json_ok"),
  schemaJsonCheckedAt: timestamp("schema_json_checked_at"),
  trackingPixelLastSeenAt: timestamp("tracking_pixel_last_seen_at"),
  refreshedAt: timestamp("refreshed_at").defaultNow(),
});

export type IntegrationProbeCache = typeof integrationProbeCache.$inferSelect;
export type NewIntegrationProbeCache = typeof integrationProbeCache.$inferInsert;

// ── RAG Knowledge Embeddings (Chatbot) ──────────────────────────────────────
// Stores chunked + embedded documentation for chatbot RAG retrieval.
// Requires: CREATE EXTENSION IF NOT EXISTS vector;

export const knowledgeEmbeddings = pgTable("knowledge_embeddings", {
  id: varchar("id", { length: 191 }).primaryKey(),
  content: text("content").notNull(),
  source: varchar("source", { length: 500 }).notNull(),
  category: varchar("category", { length: 50 }).notNull(), // "platform" | "geo-guide" | "seo-reference" | "product"
  platform: varchar("platform", { length: 50 }),            // "wordpress", "shopify", etc. (null for non-platform docs)
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("embedding_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
]);

export type KnowledgeEmbedding = typeof knowledgeEmbeddings.$inferSelect;
export type NewKnowledgeEmbedding = typeof knowledgeEmbeddings.$inferInsert;

// ── Audit Purchases (GMC one-time $10 product) ──────────────────────────────

export const auditPurchases = pgTable("audit_purchases", {
  id: text("id").primaryKey(),
  stripeSessionId: text("stripe_session_id").notNull().unique(),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  stripeChargeId: text("stripe_charge_id"),
  customerEmail: text("customer_email").notNull(),
  domain: text("domain"),
  siteId: text("site_id"),
  purchaseToken: text("purchase_token").notNull(),
  purchaseTokenExpiresAt: timestamp("purchase_token_expires_at"),
  amountCents: integer("amount_cents").notNull().default(1000),
  // paid | intake_complete | delivered | failed | failed_payment | refunded | disputed | expired
  status: text("status").notNull().default("paid"),
  pdfDeliveredAt: timestamp("pdf_delivered_at"),
  // User/team link (nullable for back-compat) — stamped at webhook time (Task 7.1)
  userId: text("user_id"),
  teamId: text("team_id"),
  // One-time-use Supabase magic link for onboarding (stored so finalize stage can read it)
  // SECURITY: magicLink MUST be set to NULL after pdfDeliveredAt is stamped.
  // TODO(audit-purchase/bravo): scrub magicLink (set NULL) in the finalize/email stage when
  // pdfDeliveredAt is written. Bravo team owns the PDF delivery flow. This column retains
  // the raw link until then — keep access strictly to server-side code, never log it.
  magicLink: text("magic_link"),
  // magicLinkExpiresAt: Supabase default magic link TTL is 1 hour from generation.
  // Stamp at webhook time so expiry-aware code can reject stale links before attempting
  // to send them to the customer.
  magicLinkExpiresAt: timestamp("magic_link_expires_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("audit_purchases_stripe_session_idx").on(table.stripeSessionId),
  // Fix L: index names match migration SQL (20260428-audit-purchases-partial-indexes.sql).
  // The WHERE NOT NULL partial predicate is authoritative in the migration file — Drizzle
  // schema does not add .where() here because the pg-core index() API requires importing
  // `sql` from drizzle-orm into schema.ts which conflicts with the Vitest mock environment
  // (tests mock the whole drizzle-orm module). Migration SQL is the source of truth.
  index("audit_purchases_site_id_idx").on(table.siteId),
  index("audit_purchases_purchase_token_idx").on(table.purchaseToken),
  // Blocker E: stripeChargeId lookup for dispute handler
  index("audit_purchases_charge_id_idx").on(table.stripeChargeId),
]);

export type AuditPurchase = typeof auditPurchases.$inferSelect;
export type NewAuditPurchase = typeof auditPurchases.$inferInsert;

// ── Chatbot Conversation Logs (monitoring + future fine-tuning) ─────────────

export const chatbotLogs = pgTable("chatbot_logs", {
  id: varchar("id", { length: 191 }).primaryKey(),
  conversationId: varchar("conversation_id", { length: 191 }).notNull(),
  siteId: varchar("site_id", { length: 191 }),
  teamId: varchar("team_id", { length: 191 }),
  query: text("query").notNull(),
  response: text("response").notNull(),
  retrievedChunks: jsonb("retrieved_chunks"),
  topSimilarity: real("top_similarity"),
  confidenceTier: varchar("confidence_tier", { length: 20 }), // "full" | "hedged" | "refused"
  viewContext: jsonb("view_context"),
  toolCalls: jsonb("tool_calls"), // Array of { type, name?, result? }
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("chatbot_logs_site_id_idx").on(table.siteId),
  index("chatbot_logs_conversation_id_idx").on(table.conversationId),
]);

// ── ES-090 §b.1 — Admin audit log (COMP-1 DPDP right-to-erasure trail) ────
// Records administrative actions (account deletion, etc.) with actor, payload, ts.

export const adminAuditLog = pgTable("admin_audit_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  action: text("action").notNull(),                    // e.g. "account_deletion"
  actorEmail: text("actor_email"),
  payload: jsonb("payload"),                           // { teamIds: [...], geoSiteIds: [...] }
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AdminAuditLog = typeof adminAuditLog.$inferSelect;
export type NewAdminAuditLog = typeof adminAuditLog.$inferInsert;

// ── ES-090 §b.1 — Exchange codes (MED-6, DB-backed one-time redemption) ───
// HP-186: supersedes stateless JWT for new call sites. CAS-guarded redeem.
// Email integrity enforced at redemption via proof-of-email (HP-202).

export const exchangeCodes = pgTable("exchange_codes", {
  code: text("code").primaryKey(),                     // 32-char nanoid; URL-safe
  email: text("email").notNull(),                      // denormalized; indexed for DPDP erasure
  siteId: text("site_id").references(() => geoSites.id, { onDelete: "cascade" }), // nullable — site-scoped codes cascade; auth-only codes don't
  payload: jsonb("payload").notNull(),                 // { accessToken?, supabaseAccessToken?, supabaseRefreshToken?, redirect? }
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),        // issue-time + ttlSeconds
  redeemedAt: timestamp("redeemed_at"),                // null until first successful redeem; atomic UPDATE sets this
  redeemedByIpHash: text("redeemed_by_ip_hash"),       // hashed per COMP-2 at redeem time
}, (t) => ({
  emailIdx: index("exchange_codes_email_idx").on(t.email),
  expiresIdx: index("exchange_codes_expires_idx").on(t.expiresAt),
}));

export type ExchangeCode = typeof exchangeCodes.$inferSelect;
export type NewExchangeCode = typeof exchangeCodes.$inferInsert;

// ── ES-wave-2 §B3 AC-B3-3 — re-audit audit log ────────────────────────────
// One row per successful re-audit. mechanism documents which auth path
// fired: 'pro_session' (B3 Option (a) auto-pass), 'access_token' (the
// existing /api/sites/[id]/regenerate token-validated path), or 'otp'
// (OTP-verified re-audit through the existing email-gate flow).
// Critical for incident response if a JWT compromise is later suspected.

export const reAuditActions = pgTable("re_audit_actions", {
  id: uuid("id").primaryKey(),
  actorUserId: uuid("actor_user_id"),
  actorEmail: text("actor_email"),
  siteId: text("site_id"),
  teamId: text("team_id"),
  mechanism: text("mechanism").notNull(),       // 'pro_session' | 'access_token' | 'otp'
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  teamCreatedIdx: index("re_audit_actions_team_created_idx").on(t.teamId, t.createdAt),
}));

export type ReAuditAction = typeof reAuditActions.$inferSelect;
export type NewReAuditAction = typeof reAuditActions.$inferInsert;

// Pipeline health alert dedupe — one row per failure-condition key.
// Cron checks last_alerted_at before sending an alert email so we don't
// re-alert hello@flowblinq.com on every run while a problem persists.
export const pipelineHealthState = pgTable("pipeline_health_state", {
  key: text("key").primaryKey(),
  lastAlertedAt: timestamp("last_alerted_at", { withTimezone: true }).defaultNow().notNull(),
  payload: jsonb("payload"),
});

export type PipelineHealthState = typeof pipelineHealthState.$inferSelect;
export type NewPipelineHealthState = typeof pipelineHealthState.$inferInsert;
