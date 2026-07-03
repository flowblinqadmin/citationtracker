/**
 * ES-e2e-fixtures — UT-4 + UT-9. Teardown plan introspection.
 */

import { describe, it, expect } from "vitest";
import { buildTeardownPlan, buildRateLimitPurgeKeys } from "@/scripts/e2e/teardown";
import { SITE_IDS, TEST_USER_EMAIL, TEST_USER_ID } from "@/e2e/fixtures/ids";

describe("UT-4: tag-enumerated teardown plan covers every seeded table (AC-12)", () => {
  const plan = buildTeardownPlan();
  const names = plan.map((s) => s.table);

  const REQUIRED_TABLES = [
    "teams",
    "team_members",
    "team_domains",
    "geo_sites",
    "geo_site_view",
    "credit_transactions",
    "consent_records",
    "citation_check_scores",
    "citation_check_responses",
    "geo_page_views",
    "firecrawl_jobs",
    "api_clients",
    "rate_limits",
    "exchange_codes",
  ];

  for (const t of REQUIRED_TABLES) {
    it(`covers ${t}`, () => {
      expect(names).toContain(t);
    });
  }

  it("every DELETE step names a scoping whereSummary", () => {
    for (const step of plan) {
      expect(step.whereSummary.length).toBeGreaterThan(0);
    }
  });
});

describe("UT-9: rate_limits purge covers the 10 real prefixes (HP-261, AC-11)", () => {
  const keys = buildRateLimitPurgeKeys();

  // Expected prefix families derived from ES §b.12. Each pattern is
  // prefix-anchored with a trailing `%` — so a key like
  // `otp_send:${TEST_USER_EMAIL}:someSuffix` is purged.
  const expected: { name: string; match: RegExp }[] = [
    { name: "otp_send:<email>",           match: new RegExp(`^otp_send:${escapeRegExp(TEST_USER_EMAIL)}%$`) },
    { name: "otp_verify:<email>",         match: new RegExp(`^otp_verify:${escapeRegExp(TEST_USER_EMAIL)}%$`) },
    { name: "invite:<user_id>",           match: new RegExp(`^invite:${escapeRegExp(TEST_USER_ID)}%$`) },
    { name: "sites_create:127.0.0.1",     match: /^sites_create:127\.0\.0\.1%$/ },
    { name: "sites_create:::1",           match: /^sites_create:::1%$/ },
    { name: "csp_report:127.0.0.1",       match: /^csp_report:127\.0\.0\.1%$/ },
    { name: "csp_report:::1",             match: /^csp_report:::1%$/ },
    { name: "auth_proxy:127.0.0.1",       match: /^auth_proxy:127\.0\.0\.1%$/ },
    { name: "auth_proxy:::1",             match: /^auth_proxy:::1%$/ },
    { name: "audit-ip:127.0.0.1",         match: /^audit-ip:127\.0\.0\.1%$/ },
    { name: "audit-ip:::1",               match: /^audit-ip:::1%$/ },
    { name: "oauth:e2e",                  match: /^oauth:e2e%$/ },
  ];

  for (const e of expected) {
    it(`includes pattern for ${e.name}`, () => {
      const hit = keys.find((k) => e.match.test(k));
      expect(hit, `missing pattern matching ${e.match}`).toBeDefined();
    });
  }

  it("includes chatbot + citation_check for every fixture siteId", () => {
    for (const id of Object.values(SITE_IDS)) {
      expect(keys).toContain(`chatbot:${id}%`);
      expect(keys).toContain(`citation_check:${id}%`);
    }
  });

  it("does NOT contain OTP-lockout-style keys (lives on geoSites, not rate_limits)", () => {
    // HP-261 rationale: otp_attempts/otp_locked_until live on geoSites, not
    // on rate_limits. The teardown purge correctly scopes to the 10 burst
    // prefixes and does NOT fabricate an `otp_lockout:` prefix.
    for (const k of keys) {
      expect(k).not.toMatch(/^otp_lockout:/);
      expect(k).not.toMatch(/^otp-email:/);
    }
  });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
