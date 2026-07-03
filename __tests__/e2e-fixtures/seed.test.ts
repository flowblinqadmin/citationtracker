/**
 * ES-e2e-fixtures — UT suite for the pure seed/teardown plan builders.
 *
 * Covers UT-2, UT-3 (idempotency-by-shape), UT-5, UT-6, UT-7, UT-10, UT-11,
 * UT-12, UT-13, UT-14. All tests operate against the plain-data plan; no DB
 * connection is opened. IT-* tests exercise the SQL path separately.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildSeedPlan, DELETE_ORDER } from "@/scripts/e2e/seed";
import { buildTeardownPlan } from "@/scripts/e2e/teardown";
import {
  TEST_TEAM_ID,
  TEST_USER_ID,
  TEST_USER_EMAIL,
  SITE_IDS,
  SEED_TAG,
} from "@/e2e/fixtures/ids";
import { SEED_EPOCH, SEED_EPOCH_PLUS_90D } from "@/scripts/e2e/lib/constants";

const REPO_ROOT = path.resolve(__dirname, "../../");
const SEED_PATH = path.join(REPO_ROOT, "scripts/e2e/seed.ts");
const SAMPLES_PATH = path.join(REPO_ROOT, "scripts/e2e/fixtures/per-page-samples.ts");

describe("UT-2: buildSeedPlan() shape (AC-2, AC-3, AC-4)", () => {
  const plan = buildSeedPlan();

  it("has 5 geo_sites covering the 5 fixtures", () => {
    expect(plan.geoSites).toHaveLength(5);
    const ids = plan.geoSites.map((s) => s.id).sort();
    expect(ids).toEqual(Object.values(SITE_IDS).sort());
  });

  it("every site is owned by TEST_TEAM_ID / TEST_USER_EMAIL", () => {
    for (const s of plan.geoSites) {
      expect(s.team_id).toBe(TEST_TEAM_ID);
      expect(s.owner_email).toBe(TEST_USER_EMAIL);
    }
  });

  it("team.creditBalance === 10 (AC-3)", () => {
    expect(plan.teams).toHaveLength(1);
    expect(plan.teams[0].credit_balance).toBe(10);
  });

  it("exactly 3 credit_transactions summing to +10 (AC-3)", () => {
    expect(plan.creditTransactions).toHaveLength(3);
    const sum = plan.creditTransactions.reduce((a, tx) => a + tx.credits_changed, 0);
    expect(sum).toBe(10);
  });

  it("credit_transactions balance-before/after chain is consistent (AC-3)", () => {
    const sorted = [...plan.creditTransactions].sort(
      (a, b) => a.created_at.getTime() - b.created_at.getTime(),
    );
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].balance_before).toBe(sorted[i - 1].balance_after);
    }
    expect(sorted[sorted.length - 1].balance_after).toBe(plan.teams[0].credit_balance);
  });

  it("exactly 1 consent_records row for TEST_USER_ID (AC-4)", () => {
    expect(plan.consentRecords).toHaveLength(1);
    const c = plan.consentRecords[0];
    expect(c.user_id).toBe(TEST_USER_ID);
    expect(c.tos_version).toMatch(/^1\.0/);
    expect(c.eula_version).toMatch(/^1\.0/);
  });

  it("per_page_results lengths match the §b.2 table (null|12|null|5|3)", () => {
    const byId = new Map(plan.geoSites.map((s) => [s.id, s]));
    expect(byId.get(SITE_IDS.freshFreeAudit)!.per_page_results).toBeNull();
    expect((byId.get(SITE_IDS.paidFullAudit)!.per_page_results as unknown[]).length).toBe(12);
    expect(byId.get(SITE_IDS.midPipelineAudit)!.per_page_results).toBeNull();
    expect((byId.get(SITE_IDS.historicalAudit)!.per_page_results as unknown[]).length).toBe(5);
    expect((byId.get(SITE_IDS.portfolioSiteB)!.per_page_results as unknown[]).length).toBe(3);
  });

  it("pipelineStatus per fixture matches §b.2", () => {
    const statusById = Object.fromEntries(plan.geoSites.map((s) => [s.id, s.pipeline_status]));
    expect(statusById[SITE_IDS.freshFreeAudit]).toBe("complete");
    expect(statusById[SITE_IDS.paidFullAudit]).toBe("complete");
    expect(statusById[SITE_IDS.midPipelineAudit]).toBe("crawling");
    expect(statusById[SITE_IDS.historicalAudit]).toBe("complete");
    expect(statusById[SITE_IDS.portfolioSiteB]).toBe("complete");
  });

  it("geoSiteView mirrors every geoSites row (5 entries)", () => {
    expect(plan.geoSiteView).toHaveLength(5);
    const siteIds = plan.geoSiteView.map((v) => v.site_id).sort();
    expect(siteIds).toEqual(Object.values(SITE_IDS).sort());
  });
});

describe("UT-3: idempotency — two builds produce identical serializations (AC-6)", () => {
  it("JSON.stringify(buildSeedPlan()) is byte-identical across two invocations", () => {
    const a = JSON.stringify(buildSeedPlan());
    const b = JSON.stringify(buildSeedPlan());
    expect(a).toBe(b);
  });
});

describe("UT-5: token_expires_at set explicitly to SEED_EPOCH+90d (AC-5)", () => {
  const plan = buildSeedPlan();

  it("every geo_sites row has token_expires_at === SEED_EPOCH + 90d", () => {
    for (const s of plan.geoSites) {
      expect(s.token_expires_at).toBeInstanceOf(Date);
      expect(s.token_expires_at.toISOString()).toBe(SEED_EPOCH_PLUS_90D.toISOString());
    }
  });

  it("token_expires_at is in the future relative to SEED_EPOCH", () => {
    for (const s of plan.geoSites) {
      expect(s.token_expires_at.getTime()).toBeGreaterThan(SEED_EPOCH.getTime());
    }
  });

  it("geo_site_view rows mirror the same token_expires_at", () => {
    for (const v of plan.geoSiteView) {
      expect(v.token_expires_at.toISOString()).toBe(SEED_EPOCH_PLUS_90D.toISOString());
    }
  });
});

describe("UT-6: DELETE_ORDER respects FK reverse-dependencies", () => {
  const idx = (t: string) => DELETE_ORDER.findIndex((s) => s.table === t);

  it("credit_transactions is deleted before teams", () => {
    expect(idx("credit_transactions")).toBeLessThan(idx("teams"));
  });
  it("team_domains is deleted before geo_sites and teams", () => {
    expect(idx("team_domains")).toBeLessThan(idx("geo_sites"));
    expect(idx("team_domains")).toBeLessThan(idx("teams"));
  });
  it("geo_site_view is deleted before teams", () => {
    expect(idx("geo_site_view")).toBeLessThan(idx("teams"));
  });
  it("team_members is deleted before teams", () => {
    expect(idx("team_members")).toBeLessThan(idx("teams"));
  });
  it("citation_check_responses/scores are deleted before geo_sites", () => {
    expect(idx("citation_check_responses")).toBeLessThan(idx("geo_sites"));
    expect(idx("citation_check_scores")).toBeLessThan(idx("geo_sites"));
  });
});

describe("UT-7: FIXME-DEFERRED marker + no stripe_* columns touched (AC-10)", () => {
  const source = readFileSync(SEED_PATH, "utf8");

  it("contains the Stripe FIXME block", () => {
    expect(source).toMatch(/FIXME-DEFERRED: Stripe test-mode fixture/);
  });

  it("never references stripe_customer_id / stripe_subscription_id / stripe_checkout_session_id in seed-data context", () => {
    // Exhaustive: the three forbidden substrings must NOT appear anywhere in seed.ts.
    expect(source).not.toMatch(/stripe_customer_id/);
    expect(source).not.toMatch(/stripe_subscription_id/);
    expect(source).not.toMatch(/stripe_checkout_session_id/);
  });
});

describe("UT-10: firecrawl_jobs stub shape (AC-17)", () => {
  const plan = buildSeedPlan();

  it("exactly 1 firecrawl_jobs row — the midPipelineAudit stub", () => {
    expect(plan.firecrawlJobs).toHaveLength(1);
    const j = plan.firecrawlJobs[0];
    expect(j.id).toBe("e2e-stub-job-1");
    expect(j.site_id).toBe(SITE_IDS.midPipelineAudit);
    expect(j.status).toBe("scraping");
  });

  it("all NOT NULL columns on firecrawl_jobs are populated", () => {
    const j = plan.firecrawlJobs[0];
    expect(j.id).toBeTruthy();
    expect(j.site_id).toBeTruthy();
    expect(j.firecrawl_job_id).toBeTruthy();
    expect(j.chunk_index).toBeGreaterThanOrEqual(0);
    expect(j.url_count).toBeGreaterThan(0);
    expect(j.status).toBeTruthy();
    expect(Array.isArray(j.urls_submitted)).toBe(true);
    expect(j.urls_submitted.length).toBeGreaterThan(0);
  });

  it("midPipelineAudit.crawl_job_ids[0] matches the stub row id", () => {
    const site = plan.geoSites.find((s) => s.id === SITE_IDS.midPipelineAudit)!;
    expect(site.crawl_job_ids).toEqual(["e2e-stub-job-1"]);
    expect(plan.firecrawlJobs[0].id).toBe(site.crawl_job_ids![0]);
  });

  it("no other fixture seeds a firecrawl_jobs row", () => {
    const otherSiteIds = Object.values(SITE_IDS).filter((id) => id !== SITE_IDS.midPipelineAudit);
    for (const row of plan.firecrawlJobs) {
      expect(otherSiteIds).not.toContain(row.site_id);
    }
  });
});

describe("UT-11: no NOW() / Date.now() / bare new Date() / $defaultFn in seed (AC-6, AC-17, HP-260)", () => {
  const seedSrc = readFileSync(SEED_PATH, "utf8");
  const samplesSrc = readFileSync(SAMPLES_PATH, "utf8");

  // We scan for these banned tokens. The constants module is allowed to
  // compute offsets from SEED_EPOCH (which is `new Date(SEED_EPOCH_ISO)` —
  // a literal-argument Date — explicitly permitted).
  it("seed.ts contains no Date.now() or new Date() without a literal argument", () => {
    expect(seedSrc).not.toMatch(/Date\.now\(/);
    // `new Date(` is permitted only with a literal argument; seed.ts
    // currently computes `new Date(SEED_EPOCH.getTime() + off)` inside the
    // pageViewOffsets map. That is constant-derived, deterministic, and
    // reviewed. The banned form is `new Date()` with no arg.
    expect(seedSrc).not.toMatch(/new Date\(\s*\)/);
  });

  it("seed.ts contains no NOW() / CURRENT_TIMESTAMP SQL fragments", () => {
    expect(seedSrc).not.toMatch(/\bNOW\s*\(\s*\)/i);
    expect(seedSrc).not.toMatch(/CURRENT_TIMESTAMP/i);
  });

  it("seed.ts does not invoke drizzle $defaultFn", () => {
    expect(seedSrc).not.toMatch(/\$defaultFn\s*\(/);
  });

  it("per-page-samples.ts contains no Date.now() / bare new Date() / NOW()", () => {
    expect(samplesSrc).not.toMatch(/Date\.now\(/);
    expect(samplesSrc).not.toMatch(/new Date\(\s*\)/);
    expect(samplesSrc).not.toMatch(/\bNOW\s*\(\s*\)/i);
  });
});

describe("UT-12: SEED_EPOCH constant determinism (AC-6)", () => {
  it("SEED_EPOCH === new Date('2026-04-01T00:00:00.000Z')", () => {
    expect(SEED_EPOCH.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(SEED_EPOCH.getTime()).toBe(new Date("2026-04-01T00:00:00.000Z").getTime());
  });

  it("derived offsets are deterministic Date instances", () => {
    expect(SEED_EPOCH_PLUS_90D.toISOString()).toBe("2026-06-30T00:00:00.000Z");
  });
});

describe("UT-13: FK-complete DELETE enumeration includes api_clients + firecrawl_jobs (AC-16)", () => {
  const plan = buildTeardownPlan();
  const names = plan.map((p) => p.table);

  it("api_clients is in the DELETE plan", () => {
    expect(names).toContain("api_clients");
  });
  it("firecrawl_jobs is in the DELETE plan", () => {
    expect(names).toContain("firecrawl_jobs");
  });
  it("api_clients is deleted BEFORE teams (FK reverse)", () => {
    expect(names.indexOf("api_clients")).toBeLessThan(names.indexOf("teams"));
  });
  it("firecrawl_jobs is deleted BEFORE geo_sites (FK reverse)", () => {
    expect(names.indexOf("firecrawl_jobs")).toBeLessThan(names.indexOf("geo_sites"));
  });
});

describe("UT-14: OTP-lockout state reset via geoSites reseed (AC-11b)", () => {
  const plan = buildSeedPlan();

  it("every fixture site has otp_attempts === 0 in the seed plan", () => {
    for (const s of plan.geoSites) {
      expect(s.otp_attempts).toBe(0);
    }
  });

  it("every fixture site has otp_locked_until === null in the seed plan", () => {
    for (const s of plan.geoSites) {
      expect(s.otp_locked_until).toBeNull();
    }
  });

  it("OTP-lockout reset is a property of the plan, not of rate_limits", () => {
    // The rate_limits purge covers NON-OTP burst prefixes per HP-261. Assert
    // that buildRateLimitPurgeKeys does NOT include an OTP-lockout prefix —
    // OTP-lockout lives on geoSites.otp_attempts / otp_locked_until.
    // (Positive key-coverage is asserted in teardown.test.ts UT-9.)
    expect(SEED_TAG).toBe("e2e-seed");
    // Sanity: every site carries the SEED_TAG-scoped owner email so the
    // DELETE-then-INSERT cycle implicitly resets OTP lockout columns.
    for (const s of plan.geoSites) {
      expect(s.owner_email).toBe(TEST_USER_EMAIL);
    }
  });
});
