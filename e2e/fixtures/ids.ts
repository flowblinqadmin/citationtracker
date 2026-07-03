/**
 * ES-e2e-fixtures §b.1 — shared identity for seeded local-Supabase E2E fixtures.
 *
 * Specs import these constants (never inline them) so a later id-rename
 * propagates in one place. TEST_USER_EMAIL MUST byte-equal
 * `e2e/fixtures/otp-helper.ts:TO_FILTER` — a grep test in
 * `__tests__/e2e-fixtures/email-consistency.test.ts` (UT-8) enforces it.
 */

export const TEST_TEAM_ID = "00000000-e2e-0000-0000-000000000001";
// Valid UUIDv4: version nibble '4' at pos 13, variant bits '8' (binary 1000) at pos 17.
// Required because Supabase auth.admin.createUser rejects non-UUIDv4 ids.
// Trailing 'a1' preserves the original's tail marker for grep/audit continuity.
export const TEST_USER_ID = "00000000-0000-4000-8000-0000000000a1";
export const TEST_USER_EMAIL = "adityanittoor+geotests@gmail.com";
export const TEST_TEAM_NAME = "E2E Test Team";
export const SEED_TAG = "e2e-seed";

export const SITE_IDS = {
  freshFreeAudit:   "00000000-e2e-site-0000-0000000000f1",
  paidFullAudit:    "00000000-e2e-site-0000-0000000000f2",
  midPipelineAudit: "00000000-e2e-site-0000-0000000000f3",
  historicalAudit:  "00000000-e2e-site-0000-0000000000f4",
  portfolioSiteB:   "00000000-e2e-site-0000-0000000000f5",
} as const;

export const SITE_SLUGS = {
  freshFreeAudit:   "e2e-fresh-free",
  paidFullAudit:    "e2e-paid-full",
  midPipelineAudit: "e2e-mid-pipeline",
  historicalAudit:  "e2e-historical",
  portfolioSiteB:   "e2e-portfolio-b",
} as const;

export const SITE_DOMAINS = {
  freshFreeAudit:   "fresh-free.e2e.flowblinq.test",
  paidFullAudit:    "paid-full.e2e.flowblinq.test",
  midPipelineAudit: "mid-pipeline.e2e.flowblinq.test",
  historicalAudit:  "historical.e2e.flowblinq.test",
  portfolioSiteB:   "portfolio-b.e2e.flowblinq.test",
} as const;

export type FixtureKey = keyof typeof SITE_IDS;

// ── Deterministic PKs for rotation-safe teardown ────────────────────────────
// Every row the seed inserts with a fixed primary key is enumerated here so
// teardown's WHERE can widen to `… OR id = <PK>` and purge orphans even
// after TEST_USER_ID / TEST_TEAM_ID rotates. See scripts/e2e/seed.ts
// DELETE block and scripts/e2e/teardown.ts for the consumers.
export const TEST_CONSENT_ID = "e2e-consent-01";
export const TEST_MEMBER_ID = "e2e-member-01";
export const FIRECRAWL_JOB_ID = "e2e-stub-job-1";
export const CREDIT_TX_ID_PREFIX = "e2e-tx-";          // matches e2e-tx-signup / -topup / -audit
export const TEAM_DOMAIN_ID_PREFIX = "e2e-tdom-";      // matches e2e-tdom-1 … e2e-tdom-5
export const PAGE_VIEW_ID_PREFIX = "e2e-pv-";          // matches e2e-pv-paid-1 …
export const CITATION_RESP_ID_PREFIX = "e2e-resp-";    // matches e2e-resp-paid-N
export const CITATION_CHECK_ID_PREFIX = "e2e-check-";  // matches e2e-check-paid-01 / -hist-01

// Deterministic PK for the Phase A credit grant — single row inserted
// post-seed by scripts/e2e/seed.ts. Rotation-safe DELETE covers it by id
// so a TEST_TEAM_ID rotation does not orphan prior grant rows.
export const CREDIT_GRANT_ID = "e2e-grant-dryrun";
export const CREDIT_GRANT_AMOUNT = 200;
