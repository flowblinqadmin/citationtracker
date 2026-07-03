/**
 * ES-e2e-fixtures §b.9 + §b.12 — tag-scoped teardown for local-Supabase E2E.
 *
 * Purges every seeded row + the 10 real non-OTP rate_limit prefix families
 * (HP-261). OTP-lockout repeatability is a side effect of the geo_sites
 * reseed (§b.12 rationale), NOT of rate_limits purges.
 */

import { pathToFileURL } from "node:url";
import {
  TEST_TEAM_ID,
  TEST_USER_ID,
  TEST_USER_EMAIL,
  SITE_IDS,
  TEST_CONSENT_ID,
  TEST_MEMBER_ID,
  FIRECRAWL_JOB_ID,
  CREDIT_TX_ID_PREFIX,
  TEAM_DOMAIN_ID_PREFIX,
  PAGE_VIEW_ID_PREFIX,
  CITATION_RESP_ID_PREFIX,
  CITATION_CHECK_ID_PREFIX,
  CREDIT_GRANT_ID,
} from "../../e2e/fixtures/ids";
import { assertLocalDb } from "./lib/safety";
import { DELETE_ORDER } from "./seed";

/**
 * Ordered list of rate_limits key patterns used by teardown and by seed's
 * purge-on-reseed (§b.7 trailing DELETE). Each pattern is prefix-anchored
 * with a trailing `%`. Patterns are grep-verified against the 10 real
 * prefix source files listed in §b.12 (HP-261).
 */
export function buildRateLimitPurgeKeys(): string[] {
  const keys: string[] = [
    // (1) (2) OTP send/verify email-keyed counters
    `otp_send:${TEST_USER_EMAIL}%`,
    `otp_verify:${TEST_USER_EMAIL}%`,
    // (3) invite throttle by user_id
    `invite:${TEST_USER_ID}%`,
    // (4) (5) (6) (7) loopback-IP-keyed counters
    "sites_create:127.0.0.1%", "sites_create:::1%",
    "csp_report:127.0.0.1%",    "csp_report:::1%",
    "auth_proxy:127.0.0.1%",    "auth_proxy:::1%",
    "audit-ip:127.0.0.1%",      "audit-ip:::1%",
    // (8) oauth by client_id — any e2e-scoped client
    "oauth:e2e%",
  ];
  // (9) (10) chatbot + citation_check by site_id
  for (const id of Object.values(SITE_IDS)) {
    keys.push(`chatbot:${id}%`);
    keys.push(`citation_check:${id}%`);
  }
  return keys;
}

/**
 * Pure plan builder — returns an ordered list of `DELETE FROM <t> WHERE <w>`
 * statements for unit-test inspection (UT-4, UT-13). The runtime executor
 * binds params via parameterized SQL; the strings here are documentation.
 */
export function buildTeardownPlan(): { table: string; whereSummary: string }[] {
  return DELETE_ORDER.map((s) => ({ ...s }));
}

export async function runTeardown(): Promise<void> {
  assertLocalDb();

  const start = Date.now();
  const { default: postgres } = await import("postgres");
  const url = process.env.DATABASE_URL!;
  const sql = postgres(url, { max: 1, prepare: false });
  let purged = 0;

  try {
    const siteIdList = Object.values(SITE_IDS);
    await sql.begin(async (tx) => {
      purged += (await tx`DELETE FROM api_clients             WHERE team_id = ${TEST_TEAM_ID}`).count ?? 0;
      purged += (await tx`DELETE FROM firecrawl_jobs          WHERE site_id = ANY(${siteIdList as string[]}) OR id = ${FIRECRAWL_JOB_ID}`).count ?? 0;
      purged += (await tx`DELETE FROM credit_transactions     WHERE team_id = ${TEST_TEAM_ID} OR id LIKE ${CREDIT_TX_ID_PREFIX + "%"} OR id = ${CREDIT_GRANT_ID}`).count ?? 0;
      purged += (await tx`DELETE FROM geo_page_views          WHERE site_id = ANY(${siteIdList as string[]}) OR slug LIKE ${"e2e-%"} OR id LIKE ${PAGE_VIEW_ID_PREFIX + "%"}`).count ?? 0;
      purged += (await tx`DELETE FROM citation_check_responses WHERE site_id = ANY(${siteIdList as string[]}) OR id LIKE ${CITATION_RESP_ID_PREFIX + "%"}`).count ?? 0;
      purged += (await tx`DELETE FROM citation_check_scores   WHERE site_id = ANY(${siteIdList as string[]}) OR check_id LIKE ${CITATION_CHECK_ID_PREFIX + "%"}`).count ?? 0;
      purged += (await tx`DELETE FROM exchange_codes          WHERE email   = ${TEST_USER_EMAIL}`).count ?? 0;
      purged += (await tx`DELETE FROM geo_site_view           WHERE team_id = ${TEST_TEAM_ID} OR site_id = ANY(${siteIdList as string[]})`).count ?? 0;
      purged += (await tx`DELETE FROM team_domains            WHERE team_id = ${TEST_TEAM_ID} OR id LIKE ${TEAM_DOMAIN_ID_PREFIX + "%"}`).count ?? 0;
      purged += (await tx`DELETE FROM geo_sites               WHERE team_id = ${TEST_TEAM_ID} OR id = ANY(${siteIdList as string[]})`).count ?? 0;
      purged += (await tx`DELETE FROM team_members            WHERE team_id = ${TEST_TEAM_ID} OR id = ${TEST_MEMBER_ID}`).count ?? 0;
      purged += (await tx`DELETE FROM teams                   WHERE id      = ${TEST_TEAM_ID}`).count ?? 0;
      purged += (await tx`DELETE FROM consent_records         WHERE user_id = ${TEST_USER_ID} OR id = ${TEST_CONSENT_ID}`).count ?? 0;
      for (const pattern of buildRateLimitPurgeKeys()) {
        purged += (await tx`DELETE FROM rate_limits WHERE key LIKE ${pattern}`).count ?? 0;
      }
    });
    const elapsed = Date.now() - start;
    console.log(`[teardown] purged ${purged} rows in ${elapsed}ms`);
    if (elapsed > 2000) console.warn(`[teardown] WARN: exceeded 2s SLO (AC-15)`);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runTeardown().catch((err) => {
    console.error("[teardown] FAILED:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
