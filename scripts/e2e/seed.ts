// FIXME-DEFERRED: Stripe test-mode fixture
// ============================================
// FI-042 (credit purchase flow) requires:
//   - Stripe test-mode webhook signing secret
//   - Test-mode price IDs for each credit pack
//   - Mock/forwarded webhook delivery into local Next.js
// These are out-of-scope for ES-e2e-fixtures. Follow-up ES will scope
// Stripe test-mode setup. For now, FI-042 specs MUST be marked
// test.fixme() with a link to this comment.

/**
 * ES-e2e-fixtures §b.2–§b.9 — deterministic seeder for local-Supabase E2E.
 *
 * DELETE-then-INSERT in a single transaction, tag-scoped to SEED_TAG so the
 * DELETE touches only fixture rows. Every timestamp is computed as
 * `SEED_EPOCH + <fixed-offset>` (HP-260) — UT-11 asserts the banned tokens
 * (wall-clock readers, bare Date ctor, SQL wall-clock, drizzle defaultFn)
 * are absent from this file and from per-page-samples.
 *
 * Teardown is optional in local dev; required in CI via `afterAll` or a
 * dedicated teardown step (see scripts/e2e/teardown.ts).
 */

import { pathToFileURL } from "node:url";
import {
  TEST_TEAM_ID,
  TEST_USER_ID,
  TEST_USER_EMAIL,
  TEST_TEAM_NAME,
  SEED_TAG,
  SITE_IDS,
  SITE_SLUGS,
  SITE_DOMAINS,
  TEST_CONSENT_ID,
  TEST_MEMBER_ID,
  FIRECRAWL_JOB_ID,
  CREDIT_TX_ID_PREFIX,
  TEAM_DOMAIN_ID_PREFIX,
  PAGE_VIEW_ID_PREFIX,
  CITATION_RESP_ID_PREFIX,
  CITATION_CHECK_ID_PREFIX,
  CREDIT_GRANT_ID,
  CREDIT_GRANT_AMOUNT,
} from "../../e2e/fixtures/ids";
import {
  SEED_EPOCH,
  SEED_EPOCH_MINUS_1M,
  SEED_EPOCH_MINUS_2M,
  SEED_EPOCH_MINUS_10M,
  SEED_EPOCH_MINUS_1D,
  SEED_EPOCH_MINUS_2D,
  SEED_EPOCH_MINUS_30D,
  SEED_EPOCH_MINUS_37D,
  SEED_EPOCH_PLUS_90D,
} from "./lib/constants";
import { assertLocalDb, assertLocalSupabaseUrl } from "./lib/safety";
import {
  paidFullPerPageResults,
  paidFullPerPageFixes,
  historicalPerPageResults,
  historicalPerPageFixes,
  portfolioBPerPageResults,
  portfolioBPerPageFixes,
} from "./fixtures/per-page-samples";

// ── Plan shapes (plain data, no drizzle at this layer) ──────────────────────

export interface TeamRow {
  id: string; name: string; owner_user_id: string; credit_balance: number;
  subscription_tier: string; subscription_status: string;
  monthly_page_allowance: number; monthly_pages_used: number;
  created_at: Date; updated_at: Date;
}
export interface TeamMemberRow {
  id: string; team_id: string; user_id: string | null; email: string;
  role: string; invite_token: string | null; invite_accepted_at: Date | null;
  created_at: Date;
}
export interface GeoSiteRow {
  id: string; domain: string; slug: string; owner_email: string;
  team_id: string; user_id: string | null;
  access_token: string | null;
  token_expires_at: Date; token_rotated_at: Date | null;
  payment_status: string;
  pipeline_status: string; audit_mode: string;
  per_page_results: unknown[] | null;
  per_page_fixes: unknown[] | null;
  geo_scorecard: unknown | null;
  previous_run_snapshot: unknown | null;
  baseline_scorecard: unknown | null;
  bulk_url_count: number | null;
  crawl_job_ids: string[] | null;
  crawl_chunks_total: number | null;
  crawl_chunks_done: number | null;
  crawl_frequency: string;
  otp_attempts: number;
  otp_locked_until: Date | null;
  created_at: Date; updated_at: Date;
}
export interface GeoSiteViewRow {
  site_id: string; domain: string; slug: string; team_id: string;
  access_token: string | null; token_expires_at: Date;
  pipeline_status: string; pipeline_error: string | null;
  overall_score: number | null; previous_score: number | null;
  pillars: unknown | null; page_count: number; citation_rate: number | null;
  crawl_count: number; executive_summary: string | null;
  per_page_results: unknown[] | null; per_page_fixes: unknown[] | null;
  generated_llms_txt: string | null; discovery_data: unknown | null;
  platform_detected: string | null; share_token: string | null;
  domain_verified: boolean;
  created_at: Date; updated_at: Date;
}
export interface TeamDomainRow {
  id: string; team_id: string; site_id: string; domain: string;
  added_by_user_id: string; created_at: Date;
}
export interface CreditTransactionRow {
  id: string; team_id: string; site_id: string | null; type: string;
  pages_consumed: number; credits_changed: number;
  balance_before: number; balance_after: number; created_at: Date;
}
export interface ConsentRecordRow {
  id: string; user_id: string; email: string;
  tos_version: string; eula_version: string;
  accepted_at: Date; ip_address: string | null; user_agent: string;
  created_at: Date;
}
export interface FirecrawlJobRow {
  id: string; site_id: string; firecrawl_job_id: string; chunk_index: number;
  url_count: number; status: string;
  urls_submitted: string[]; urls_completed: string[];
  created_at: Date; updated_at: Date;
}
export interface CitationCheckScoreRow {
  check_id: string; site_id: string; team_id: string; domain: string;
  overall_visibility: number; sentiment_score: number;
  provider_results: unknown[]; prompts_used: string[];
  created_at: Date;
}
export interface CitationCheckResponseRow {
  id: string; check_id: string; site_id: string; provider: string; model: string;
  query: string; mentioned: boolean; created_at: Date;
}
export interface GeoPageViewRow {
  id: string; site_id: string; slug: string; page_url: string;
  bot_name: string; viewed_at: Date; ip: string;
}

export interface SeedPlan {
  teams: TeamRow[];
  teamMembers: TeamMemberRow[];
  geoSites: GeoSiteRow[];
  geoSiteView: GeoSiteViewRow[];
  teamDomains: TeamDomainRow[];
  creditTransactions: CreditTransactionRow[];
  consentRecords: ConsentRecordRow[];
  firecrawlJobs: FirecrawlJobRow[];
  citationCheckScores: CitationCheckScoreRow[];
  citationCheckResponses: CitationCheckResponseRow[];
  geoPageViews: GeoPageViewRow[];
}

// Delete-ordering respects FK-reverse (§b.7, HP-252). Each entry is a
// table-name plus a scoping clause so teardown shares the same ordering.
export interface DeleteStep {
  table: string;
  // Parameterized WHERE fragment. Actual param binding happens at run-time.
  whereSummary: string;
}

export const DELETE_ORDER: DeleteStep[] = [
  { table: "api_clients",             whereSummary: "team_id = TEST_TEAM_ID" },
  { table: "firecrawl_jobs",          whereSummary: "site_id = ANY(SITE_IDS)" },
  { table: "credit_transactions",     whereSummary: "team_id = TEST_TEAM_ID" },
  { table: "geo_page_views",          whereSummary: "site_id = ANY(SITE_IDS) OR slug LIKE 'e2e-%'" },
  { table: "citation_check_responses", whereSummary: "site_id = ANY(SITE_IDS)" },
  { table: "citation_check_scores",   whereSummary: "site_id = ANY(SITE_IDS)" },
  { table: "exchange_codes",          whereSummary: "email = TEST_USER_EMAIL" },
  { table: "geo_site_view",           whereSummary: "team_id = TEST_TEAM_ID" },
  { table: "team_domains",            whereSummary: "team_id = TEST_TEAM_ID" },
  { table: "geo_sites",               whereSummary: "team_id = TEST_TEAM_ID" },
  { table: "team_members",            whereSummary: "team_id = TEST_TEAM_ID" },
  { table: "teams",                   whereSummary: "id = TEST_TEAM_ID" },
  { table: "consent_records",         whereSummary: "user_id = TEST_USER_ID" },
  { table: "rate_limits",             whereSummary: "key LIKE <10 real prefixes, see teardown>" },
];

// ── Pure plan builder (no DB I/O) ───────────────────────────────────────────

export function buildSeedPlan(): SeedPlan {
  const siteIdList = Object.values(SITE_IDS);

  const teams: TeamRow[] = [{
    id: TEST_TEAM_ID,
    name: `${TEST_TEAM_NAME} (${SEED_TAG})`,
    owner_user_id: TEST_USER_ID,
    credit_balance: 10,
    subscription_tier: "free",
    subscription_status: "inactive",
    // Simulates free-tier-exhausted state so single-URL audit debits 1
    // credit per §b.16.8 cost table (Aditya corr d8a5afd6, AC-32).
    monthly_page_allowance: 0,
    monthly_pages_used: 0,
    created_at: SEED_EPOCH_MINUS_30D,
    updated_at: SEED_EPOCH_MINUS_1D,
  }];

  const teamMembers: TeamMemberRow[] = [{
    id: "e2e-member-01",
    team_id: TEST_TEAM_ID,
    user_id: TEST_USER_ID,
    email: TEST_USER_EMAIL,
    role: "owner",
    invite_token: `${SEED_TAG}:owner-accepted`,
    invite_accepted_at: SEED_EPOCH_MINUS_30D,
    created_at: SEED_EPOCH_MINUS_30D,
  }];

  const common = {
    team_id: TEST_TEAM_ID,
    user_id: TEST_USER_ID,
    owner_email: TEST_USER_EMAIL,
    access_token: null as string | null,  // overridden per-site in post-build map below
    token_expires_at: SEED_EPOCH_PLUS_90D,  // HP-260: literal, not $defaultFn
    token_rotated_at: null as Date | null,
    crawl_frequency: "manual",
    otp_attempts: 0,
    otp_locked_until: null as Date | null,
    audit_mode: "single",
  };

  const geoSites: GeoSiteRow[] = [
    {
      ...common,
      id: SITE_IDS.freshFreeAudit,
      domain: SITE_DOMAINS.freshFreeAudit,
      slug: SITE_SLUGS.freshFreeAudit,
      payment_status: "pending",
      pipeline_status: "complete",
      per_page_results: null,
      per_page_fixes: null,
      geo_scorecard: { overallScore: 42, pillars: [] },
      previous_run_snapshot: null,
      baseline_scorecard: null,
      bulk_url_count: null,
      crawl_job_ids: null,
      crawl_chunks_total: null,
      crawl_chunks_done: null,
      created_at: SEED_EPOCH_MINUS_10M,
      updated_at: SEED_EPOCH_MINUS_10M,
    },
    {
      ...common,
      id: SITE_IDS.paidFullAudit,
      domain: SITE_DOMAINS.paidFullAudit,
      slug: SITE_SLUGS.paidFullAudit,
      payment_status: "paid",
      pipeline_status: "complete",
      per_page_results: paidFullPerPageResults,
      per_page_fixes: paidFullPerPageFixes,
      geo_scorecard: { overallScore: 72, pillars: [] },
      previous_run_snapshot: null,
      baseline_scorecard: null,
      bulk_url_count: null,
      crawl_job_ids: null,
      crawl_chunks_total: null,
      crawl_chunks_done: null,
      created_at: SEED_EPOCH_MINUS_1D,
      updated_at: SEED_EPOCH_MINUS_1D,
    },
    {
      ...common,
      id: SITE_IDS.midPipelineAudit,
      domain: SITE_DOMAINS.midPipelineAudit,
      slug: SITE_SLUGS.midPipelineAudit,
      payment_status: "paid",
      pipeline_status: "crawling",
      per_page_results: null,
      per_page_fixes: null,
      geo_scorecard: null,
      previous_run_snapshot: null,
      baseline_scorecard: null,
      bulk_url_count: null,
      crawl_job_ids: ["e2e-stub-job-1"],
      crawl_chunks_total: 3,
      crawl_chunks_done: 1,
      created_at: SEED_EPOCH_MINUS_2M,
      updated_at: SEED_EPOCH_MINUS_1M,
    },
    {
      ...common,
      id: SITE_IDS.historicalAudit,
      domain: SITE_DOMAINS.historicalAudit,
      slug: SITE_SLUGS.historicalAudit,
      payment_status: "paid",
      pipeline_status: "complete",
      per_page_results: historicalPerPageResults,
      per_page_fixes: historicalPerPageFixes,
      geo_scorecard: { overallScore: 58, pillars: [] },
      previous_run_snapshot: { overallScore: 31, createdAt: SEED_EPOCH_MINUS_37D.toISOString(), pillars: [] },
      baseline_scorecard: { overallScore: 31, pillars: [] },
      bulk_url_count: null,
      crawl_job_ids: null,
      crawl_chunks_total: null,
      crawl_chunks_done: null,
      created_at: SEED_EPOCH_MINUS_30D,
      updated_at: SEED_EPOCH_MINUS_1D,
    },
    {
      ...common,
      id: SITE_IDS.portfolioSiteB,
      domain: SITE_DOMAINS.portfolioSiteB,
      slug: SITE_SLUGS.portfolioSiteB,
      payment_status: "paid",
      pipeline_status: "complete",
      per_page_results: portfolioBPerPageResults,
      per_page_fixes: portfolioBPerPageFixes,
      geo_scorecard: { overallScore: 63, pillars: [] },
      previous_run_snapshot: null,
      baseline_scorecard: null,
      bulk_url_count: null,
      crawl_job_ids: null,
      crawl_chunks_total: null,
      crawl_chunks_done: null,
      created_at: SEED_EPOCH_MINUS_2D,
      updated_at: SEED_EPOCH_MINUS_1D,
    },
  ];

  // Derive deterministic access_tokens per site and back-fill the base
  // geoSites rows so app routes that read from geo_sites (e.g. citation-check)
  // can validate the URL token. geoSiteView below uses the same pattern.
  for (const s of geoSites) {
    s.access_token = `e2e-${s.slug}-token`;
  }

  const geoSiteView: GeoSiteViewRow[] = geoSites.map((s) => ({
    site_id: s.id,
    domain: s.domain,
    slug: s.slug,
    team_id: TEST_TEAM_ID,
    // Deterministic access token per site so /dashboard/domains/[id]
    // can redirect to /sites/[id]?token=<slug>-token and the route's
    // token-match check passes. Without this, redirect passes 'null'
    // as a string → token-mismatch → Access denied page renders.
    access_token: s.access_token,
    token_expires_at: s.token_expires_at,
    pipeline_status: s.pipeline_status,
    pipeline_error: null,
    overall_score:
      s.id === SITE_IDS.paidFullAudit   ? 72 :
      s.id === SITE_IDS.historicalAudit ? 58 :
      s.id === SITE_IDS.portfolioSiteB  ? 63 :
      s.id === SITE_IDS.freshFreeAudit  ? 42 : null,
    previous_score: s.id === SITE_IDS.historicalAudit ? 31 : null,
    pillars: [],
    page_count:
      s.id === SITE_IDS.paidFullAudit   ? 12 :
      s.id === SITE_IDS.historicalAudit ? 5 :
      s.id === SITE_IDS.portfolioSiteB  ? 3 : 0,
    citation_rate: null,
    crawl_count: 1,
    executive_summary: null,
    per_page_results: s.per_page_results,
    per_page_fixes: s.per_page_fixes,
    generated_llms_txt: null,
    discovery_data: null,
    platform_detected: null,
    share_token: null,
    domain_verified: false,
    created_at: s.created_at,
    updated_at: s.updated_at,
  }));

  const teamDomains: TeamDomainRow[] = geoSites.map((s, i) => ({
    id: `e2e-tdom-${i + 1}`,
    team_id: TEST_TEAM_ID,
    site_id: s.id,
    domain: s.domain,
    added_by_user_id: TEST_USER_ID,
    created_at: s.created_at,
  }));

  const creditTransactions: CreditTransactionRow[] = [
    {
      id: "e2e-tx-signup", team_id: TEST_TEAM_ID, site_id: null,
      type: "signup_bonus", pages_consumed: 0, credits_changed: 5,
      balance_before: 0, balance_after: 5,
      created_at: SEED_EPOCH_MINUS_30D,
    },
    {
      id: "e2e-tx-topup", team_id: TEST_TEAM_ID, site_id: null,
      type: "topup", pages_consumed: 0, credits_changed: 10,
      balance_before: 5, balance_after: 15,
      created_at: SEED_EPOCH_MINUS_2D,
    },
    {
      id: "e2e-tx-audit", team_id: TEST_TEAM_ID, site_id: SITE_IDS.paidFullAudit,
      type: "crawl_debit", pages_consumed: 5, credits_changed: -5,
      balance_before: 15, balance_after: 10,
      created_at: SEED_EPOCH_MINUS_1D,
    },
  ];

  const consentRecords: ConsentRecordRow[] = [{
    id: "e2e-consent-01",
    user_id: TEST_USER_ID,
    email: TEST_USER_EMAIL,
    // Must match lib/config.ts CURRENT_TOS_VERSION / CURRENT_EULA_VERSION
    // so /api/consent hasConsent check returns true for the seeded user —
    // otherwise the login flow hits the in-place requiresConsent branch on
    // /auth/login which has no UI (dead state; tracked as product-gap-ui-missing).
    tos_version: "1.0-2026-04-02",
    eula_version: "1.0-2026-04-02",
    accepted_at: SEED_EPOCH_MINUS_1D,
    ip_address: null,
    user_agent: SEED_TAG,
    created_at: SEED_EPOCH_MINUS_1D,
  }];

  const firecrawlJobs: FirecrawlJobRow[] = [{
    id: "e2e-stub-job-1",
    site_id: SITE_IDS.midPipelineAudit,
    firecrawl_job_id: "fc-e2e-stub-0001",
    chunk_index: 0,
    url_count: 1,
    status: "scraping",
    urls_submitted: [`https://${SITE_DOMAINS.midPipelineAudit}/`],
    urls_completed: [],
    created_at: SEED_EPOCH_MINUS_2M,
    updated_at: SEED_EPOCH_MINUS_1M,
  }];

  const citationCheckScores: CitationCheckScoreRow[] = [
    {
      check_id: "e2e-check-paid-01",
      site_id: SITE_IDS.paidFullAudit,
      team_id: TEST_TEAM_ID,
      domain: SITE_DOMAINS.paidFullAudit,
      overall_visibility: 62,
      sentiment_score: 78,
      provider_results: [{ provider: "openai", visibility: 62 }],
      prompts_used: ["e2e prompt 1", "e2e prompt 2"],
      created_at: SEED_EPOCH_MINUS_1D,
    },
    {
      check_id: "e2e-check-hist-01",
      site_id: SITE_IDS.historicalAudit,
      team_id: TEST_TEAM_ID,
      domain: SITE_DOMAINS.historicalAudit,
      overall_visibility: 31,
      sentiment_score: 50,
      provider_results: [{ provider: "openai", visibility: 31 }],
      prompts_used: ["e2e prompt 1"],
      created_at: SEED_EPOCH_MINUS_30D,
    },
  ];

  const citationCheckResponses: CitationCheckResponseRow[] = (
    ["openai", "anthropic", "google", "perplexity"] as const
  ).map((provider, i) => ({
    id: `e2e-resp-paid-${i + 1}`,
    check_id: "e2e-check-paid-01",
    site_id: SITE_IDS.paidFullAudit,
    provider,
    model: "stub-model",
    query: "e2e prompt 1",
    mentioned: i % 2 === 0,
    created_at: SEED_EPOCH_MINUS_1D,
  }));

  const pageViewOffsets = [
    -60 * 60_000, -55 * 60_000, -45 * 60_000, -35 * 60_000, -25 * 60_000, -15 * 60_000,
  ];
  const pageViewBotRotation = ["visitor", "GPTBot", "ClaudeBot", "visitor", "GPTBot", "visitor"];
  const pageViewPaths = ["/", "/", "/", "/about", "/pricing", "/about"];
  const geoPageViews: GeoPageViewRow[] = pageViewOffsets.map((off, i) => ({
    id: `e2e-pv-paid-${i + 1}`,
    site_id: SITE_IDS.paidFullAudit,
    slug: SITE_SLUGS.paidFullAudit,
    page_url: `https://${SITE_DOMAINS.paidFullAudit}${pageViewPaths[i]}`,
    bot_name: pageViewBotRotation[i],
    viewed_at: new Date(SEED_EPOCH.getTime() + off),
    ip: "127.0.0.1",
  }));
  // Guard against silly unused void complaint from tsc
  void siteIdList;

  return {
    teams,
    teamMembers,
    geoSites,
    geoSiteView,
    teamDomains,
    creditTransactions,
    consentRecords,
    firecrawlJobs,
    citationCheckScores,
    citationCheckResponses,
    geoPageViews,
  };
}

// ── Runtime executor (called from CLI entry) ────────────────────────────────

export async function runSeed(): Promise<void> {
  assertLocalDb();
  assertLocalSupabaseUrl();

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey || serviceRoleKey.length === 0) {
    console.error(
      "[seed] REFUSING: Missing SUPABASE_SERVICE_ROLE_KEY in process.env — " +
        "ensure playwright.config.ts LOCAL_SUPABASE_ENV is applied OR set " +
        "explicitly before invoking seed.",
    );
    process.exit(2);
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";

  const start = process.hrtime.bigint();
  const plan = buildSeedPlan();

  // AC-24 / Fix 4: provision auth.users BEFORE the pg transaction so that
  // SQL inserts keyed by TEST_USER_ID land against an auth row with the same
  // id. Placing the admin calls outside the pg tx keeps the single-transaction
  // semantics of the pg-side DELETE+INSERT intact (HTTP side-effects cannot
  // be rolled back by pg anyway; the pre-delete step makes this step itself
  // idempotent, so a pg rollback followed by a re-run still converges).
  const { createClient } = await import("@supabase/supabase-js");
  const adminSb = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Step A: remove any prior auth.users row with our test email (may have a
  // random UUIDv4 id from a prior signInWithOtp run) so the createUser call
  // with an explicit deterministic id does not collide on the email unique.
  {
    // HP-266: listUsers() default perPage is 50. Cap at 1000 so a local
    // auth.users table with >50 rows still surfaces the TEST_USER_EMAIL row
    // (otherwise the email filter misses and createUser collides).
    const { data: listData, error: listErr } = await adminSb.auth.admin.listUsers({ perPage: 1000 });
    if (listErr) throw new Error(`[seed] auth.admin.listUsers failed: ${listErr.message}`);
    const prior = listData.users.find((u) => u.email?.toLowerCase() === TEST_USER_EMAIL.toLowerCase());
    if (prior) {
      const { error: delErr } = await adminSb.auth.admin.deleteUser(prior.id);
      if (delErr) throw new Error(`[seed] auth.admin.deleteUser(${prior.id}) failed: ${delErr.message}`);
    }
  }

  // Step B: create the deterministic auth.users row.
  {
    const { error: createErr } = await adminSb.auth.admin.createUser({
      id: TEST_USER_ID,
      email: TEST_USER_EMAIL,
      email_confirm: true,
    });
    if (createErr) {
      throw new Error(
        `[seed] auth.admin.createUser(id=${TEST_USER_ID}) failed: ${createErr.message}`,
      );
    }
  }
  console.log(`[seed] auth.users provisioned: { id: ${TEST_USER_ID}, email: ${TEST_USER_EMAIL} }`);

  // Lazy imports so vitest unit tests can pull buildSeedPlan without
  // pulling in the postgres driver / schema graph.
  const { default: postgres } = await import("postgres");
  const url = process.env.DATABASE_URL!;
  const sql = postgres(url, { max: 1, prepare: false });

  try {
    console.log("[seed] target:", url.replace(/:[^:@]*@/, ":***@"));
    console.log("[seed] tag:   ", SEED_TAG);

    await sql.begin(async (tx) => {
      // DELETE in FK-reverse. Tag-scoped per §b.7, widened with OR-PK clauses
      // so TEST_USER_ID / TEST_TEAM_ID rotations don't orphan deterministic-PK
      // rows from prior runs (rotation-safe teardown).
      const siteIdList = Object.values(SITE_IDS);
      // Child tables FK to geo_sites; geo_sites is deleted by team_id below, so
      // the child deletes must cover EVERY site of TEST_TEAM_ID — not just the
      // fixture SITE_IDS. Otherwise a non-fixture site created by a test run
      // (e.g. an in-flight bulk audit) orphans firecrawl_jobs / crawl logs and
      // the geo_sites delete FK-conflicts (the seed fragility from the 2026-06-09
      // integration review). Subquery widens each site-scoped delete to the team.
      const teamSites = tx`SELECT id FROM geo_sites WHERE team_id = ${TEST_TEAM_ID}`;
      await tx`DELETE FROM api_clients             WHERE team_id = ${TEST_TEAM_ID}`;
      await tx`DELETE FROM firecrawl_jobs          WHERE site_id = ANY(${siteIdList as string[]}) OR site_id IN (${teamSites}) OR id = ${FIRECRAWL_JOB_ID}`;
      await tx`DELETE FROM geo_crawl_logs          WHERE site_id = ANY(${siteIdList as string[]}) OR site_id IN (${teamSites})`;
      await tx`DELETE FROM credit_transactions     WHERE team_id = ${TEST_TEAM_ID} OR id LIKE ${CREDIT_TX_ID_PREFIX + "%"} OR id = ${CREDIT_GRANT_ID}`;
      await tx`DELETE FROM geo_page_views          WHERE site_id = ANY(${siteIdList as string[]}) OR site_id IN (${teamSites}) OR slug LIKE ${"e2e-%"} OR id LIKE ${PAGE_VIEW_ID_PREFIX + "%"}`;
      await tx`DELETE FROM citation_check_responses WHERE site_id = ANY(${siteIdList as string[]}) OR site_id IN (${teamSites}) OR id LIKE ${CITATION_RESP_ID_PREFIX + "%"}`;
      await tx`DELETE FROM citation_check_scores   WHERE site_id = ANY(${siteIdList as string[]}) OR check_id LIKE ${CITATION_CHECK_ID_PREFIX + "%"}`;
      await tx`DELETE FROM exchange_codes          WHERE email   = ${TEST_USER_EMAIL}`;
      await tx`DELETE FROM geo_site_view           WHERE team_id = ${TEST_TEAM_ID} OR site_id = ANY(${siteIdList as string[]}) OR site_id IN (${teamSites})`;
      await tx`DELETE FROM team_domains            WHERE team_id = ${TEST_TEAM_ID} OR id LIKE ${TEAM_DOMAIN_ID_PREFIX + "%"}`;
      await tx`DELETE FROM geo_sites               WHERE team_id = ${TEST_TEAM_ID} OR id = ANY(${siteIdList as string[]})`;
      await tx`DELETE FROM team_members            WHERE team_id = ${TEST_TEAM_ID} OR id = ${TEST_MEMBER_ID}`;
      await tx`DELETE FROM teams                   WHERE id      = ${TEST_TEAM_ID}`;
      await tx`DELETE FROM consent_records         WHERE user_id = ${TEST_USER_ID} OR id = ${TEST_CONSENT_ID}`;
      // rate_limits purge delegated to teardown contract; seed also runs it to
      // guarantee a fresh world-state on every seed cycle (AC-11, HP-261).
      const { buildRateLimitPurgeKeys } = await import("./teardown");
      const keys = buildRateLimitPurgeKeys();
      for (const pattern of keys) {
        await tx`DELETE FROM rate_limits WHERE key LIKE ${pattern}`;
      }

      // INSERT in FK order.
      for (const t of plan.teams) await tx`INSERT INTO teams ${tx(t)}`;
      for (const m of plan.teamMembers) await tx`INSERT INTO team_members ${tx(m)}`;
      for (const s of plan.geoSites) await tx`INSERT INTO geo_sites ${tx(s)}`;
      for (const v of plan.geoSiteView) await tx`INSERT INTO geo_site_view ${tx(v)}`;
      for (const d of plan.teamDomains) await tx`INSERT INTO team_domains ${tx(d)}`;
      for (const j of plan.firecrawlJobs) await tx`INSERT INTO firecrawl_jobs ${tx(j)}`;
      for (const c of plan.creditTransactions) await tx`INSERT INTO credit_transactions ${tx(c)}`;
      for (const r of plan.consentRecords) await tx`INSERT INTO consent_records ${tx(r)}`;
      for (const cs of plan.citationCheckScores) await tx`INSERT INTO citation_check_scores ${tx(cs)}`;
      for (const cr of plan.citationCheckResponses) await tx`INSERT INTO citation_check_responses ${tx(cr)}`;
      for (const pv of plan.geoPageViews) await tx`INSERT INTO geo_page_views ${tx(pv)}`;

      // Phase A credit grant (Aditya D1): +CREDIT_GRANT_AMOUNT via ledger-write
      // pattern that mirrors the prod webhook path (see app/api/webhooks/stripe
      // /route.ts:143-149). Idempotent because the prior DELETE block already
      // purges any stale `CREDIT_GRANT_ID` row (widened above with OR id=...).
      const [teamRow] = await tx<{ credit_balance: number }[]>`
        SELECT credit_balance FROM teams WHERE id = ${TEST_TEAM_ID}
      `;
      const balanceBefore = Number(teamRow?.credit_balance ?? 0);
      const balanceAfter = balanceBefore + CREDIT_GRANT_AMOUNT;
      await tx`
        UPDATE teams SET credit_balance = credit_balance + ${CREDIT_GRANT_AMOUNT}
        WHERE id = ${TEST_TEAM_ID}
      `;
      await tx`
        INSERT INTO credit_transactions
          (id, team_id, site_id, type, pages_consumed, credits_changed, balance_before, balance_after, created_at)
        VALUES
          (${CREDIT_GRANT_ID}, ${TEST_TEAM_ID}, NULL, 'topup', 0, ${CREDIT_GRANT_AMOUNT},
           ${balanceBefore}, ${balanceAfter}, ${SEED_EPOCH_MINUS_1M})
      `;
      console.log(
        `[seed] Credit grant: +${CREDIT_GRANT_AMOUNT}, balance ${balanceBefore}→${balanceAfter}`,
      );
    });

    const elapsedMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
    console.log(`[seed] complete in ${elapsedMs}ms`);
    if (elapsedMs > 5000) console.warn(`[seed] WARN: exceeded 5s SLO (AC-15)`);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

// Export SEED_EPOCH for spec convenience.
export { SEED_EPOCH };

// ── CLI entry ──────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runSeed().catch((err) => {
    console.error("[seed] FAILED:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
