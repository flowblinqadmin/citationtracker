/**
 * ES-B10 — in-place rerun architecture (15 ACs).
 *
 * Source-grep style tests pinning the contract on each AC. Drives stay
 * fast; runtime DB-backed coverage already lives in the existing
 * api-routes-es002 + bulk-flow tests (re-aligned post-B10 below).
 *
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();
const REGEN = fs.readFileSync(path.resolve(ROOT, "app/api/sites/[id]/regenerate/route.ts"), "utf8");
const RETRY = fs.readFileSync(path.resolve(ROOT, "app/api/sites/[id]/retry-failed/route.ts"), "utf8");
const STAGE = fs.readFileSync(path.resolve(ROOT, "app/api/pipeline/stage/route.ts"), "utf8");
const SITES = fs.readFileSync(path.resolve(ROOT, "app/api/sites/route.ts"), "utf8");
const SITE_CLIENT = fs.readFileSync(path.resolve(ROOT, "app/sites/[id]/SitePageClient.tsx"), "utf8");
const LEGACY = fs.readFileSync(path.resolve(ROOT, "app/sites/[id]/ResultsDashboardLegacy.tsx"), "utf8");
const SCHEMA = fs.readFileSync(path.resolve(ROOT, "lib/db/schema.ts"), "utf8");
const QSTASH = fs.readFileSync(path.resolve(ROOT, "lib/qstash.ts"), "utf8");
const DRIFT = fs.readFileSync(path.resolve(ROOT, "__tests__/schema-drift.test.ts"), "utf8");
const MIGRATIONS = fs.readdirSync(path.resolve(ROOT, "lib/db/migrations"));

describe("AC-B10-1 — bulk-init enqueues crawl-fanout (skip discover)", () => {
  it("app/api/sites/route.ts bulk-init uses stage='crawl-fanout'", () => {
    expect(SITES).toMatch(/AC-B10-1/);
    expect(SITES).toMatch(/enqueueStage\(\{[\s\S]{0,300}row\.domain[\s\S]{0,200}stage:\s*"crawl-fanout"/);
  });
});

describe("AC-B10-2 — /regenerate UPDATE-in-place (no INSERT new geoSites)", () => {
  it("source contains zero `tx.insert(geoSites)` in bulk branch (was INSERT pre-B10)", () => {
    expect(REGEN).not.toMatch(/tx\.insert\(geoSites\)/);
    expect(REGEN).not.toMatch(/tx\.insert\(teamDomains\)/);
  });

  it("UPDATE block sets currentRunNumber++, currentRunKind='regenerate', token rotated, snapshot stashed", () => {
    expect(REGEN).toMatch(/AC-B10-2/);
    expect(REGEN).toMatch(/\.update\(geoSites\)\s*\.set\(\{[\s\S]{0,800}currentRunNumber:\s*newRunNumber/);
    expect(REGEN).toMatch(/currentRunKind:\s*"regenerate"/);
    expect(REGEN).toMatch(/previousRunSnapshot:\s*stashedSnapshot/);
    // Token rotation, queued status, run-result reset.
    expect(REGEN).toMatch(/accessToken:\s*newAccessToken/);
    expect(REGEN).toMatch(/pipelineStatus:\s*"queued"/);
    expect(REGEN).toMatch(/geoScorecard:\s*null/);
  });

  it("response uses the existing siteId (no new spawn) + carries runNumber + runKind", () => {
    expect(REGEN).toMatch(/siteId:\s*id,[\s\S]{0,200}runNumber:\s*newRunNumber/);
    expect(REGEN).toMatch(/runKind:\s*"regenerate"/);
  });

  it("enqueueStage targets the existing siteId with runNumber payload", () => {
    expect(REGEN).toMatch(/enqueueStage\(\{\s*siteId:\s*id,\s*domain:\s*site\.domain,\s*stage:\s*"crawl-fanout",\s*runNumber:\s*newRunNumber/);
  });
});

describe("AC-B10-3 — /retry-failed UPDATE-in-place + retrySubsetUrls", () => {
  it("source contains zero `tx.insert(geoSites)` (was INSERT pre-B10)", () => {
    expect(RETRY).not.toMatch(/tx\.insert\(geoSites\)/);
    expect(RETRY).not.toMatch(/tx\.insert\(teamDomains\)/);
  });

  it("UPDATE block sets currentRunKind='retry-failed' + retrySubsetUrls = urlsToRetry", () => {
    expect(RETRY).toMatch(/AC-B10-3/);
    expect(RETRY).toMatch(/currentRunKind:\s*"retry-failed"/);
    expect(RETRY).toMatch(/retrySubsetUrls:\s*urlsToRetry/);
  });

  it("response status 202 + carries the existing siteId + runNumber", () => {
    expect(RETRY).toMatch(/siteId:\s*id[\s\S]{0,200}runNumber:\s*newRunNumber/);
    expect(RETRY).toMatch(/status:\s*202/);
  });
});

describe("AC-B10-4 — handleCrawlFanout URL-source ordering", () => {
  it("retrySubsetUrls (non-empty) precedes bulkUrls", () => {
    expect(STAGE).toMatch(/AC-B10-4/);
    expect(STAGE).toMatch(/retrySubsetUrls[\s\S]{0,400}sourceUrls\s*=\s*isRetryFailedRun/);
  });

  it("autoDiscoverBrandPages skipped on retry-failed runs", () => {
    expect(STAGE).toMatch(/if \(!isRetryFailedRun\)\s*\{[\s\S]{0,300}autoDiscoverBrandPages/);
  });
});

describe("AC-B10-6 — QStash idempotency: runNumber mismatch = ack-drop", () => {
  it("StagePayload schema has optional runNumber field", () => {
    expect(QSTASH).toMatch(/runNumber\?:\s*number/);
    expect(QSTASH).toMatch(/AC-B10-6/);
  });

  it("stage POST handler compares payload.runNumber to site.currentRunNumber", () => {
    expect(STAGE).toMatch(/AC-B10-6/);
    expect(STAGE).toMatch(/typeof runNumber === "number"/);
    expect(STAGE).toMatch(/runNumber !== currentRunNumber/);
    expect(STAGE).toMatch(/dropped:\s*"stale_run"/);
  });
});

describe("AC-B10-7 — schema migration (3 columns)", () => {
  it("schema.ts declares currentRunNumber, currentRunKind, retrySubsetUrls", () => {
    expect(SCHEMA).toMatch(/currentRunNumber:\s*integer\("current_run_number"\)\.notNull\(\)\.default\(1\)/);
    expect(SCHEMA).toMatch(/currentRunKind:\s*text\("current_run_kind"\)\.notNull\(\)\.default\("initial"\)/);
    expect(SCHEMA).toMatch(/retrySubsetUrls:\s*jsonb\("retry_subset_urls"\)/);
  });

  it("migration file exists with idempotent ADD COLUMN IF NOT EXISTS for all three", () => {
    const m = MIGRATIONS.find((f) => f.endsWith("geo-sites-run-tracking.sql"));
    expect(m).toBeTruthy();
    const sql = fs.readFileSync(path.resolve(ROOT, "lib/db/migrations", m!), "utf8");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS current_run_number\s+integer\s+NOT NULL\s+DEFAULT 1/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS current_run_kind\s+text\s+NOT NULL\s+DEFAULT 'initial'/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS retry_subset_urls\s+jsonb/);
  });
});

describe("AC-B10-8 — parent_site_id preserved nullable; no writes from B10 paths", () => {
  it("regenerate route does NOT write parentSiteId on the in-place UPDATE", () => {
    // The UPDATE().set({...}) call in regenerate must not include
    // parentSiteId — we keep it nullable + leave existing rows untouched.
    const updateBlock = REGEN.match(/\.update\(geoSites\)\s*\.set\(\{[\s\S]*?\}\)\s*\.where/);
    expect(updateBlock).toBeTruthy();
    expect(updateBlock![0]).not.toMatch(/parentSiteId:/);
  });

  it("retry-failed route does NOT write parentSiteId on the in-place UPDATE", () => {
    const updateBlock = RETRY.match(/\.update\(geoSites\)\s*\.set\(\{[\s\S]*?\}\)\s*\.where/);
    expect(updateBlock).toBeTruthy();
    expect(updateBlock![0]).not.toMatch(/parentSiteId:/);
  });

  it("schema column declaration preserved (B9.3 historical breadcrumbs)", () => {
    expect(SCHEMA).toMatch(/parentSiteId:\s*text\("parent_site_id"\)/);
  });
});

describe("AC-B10-9 — B9.3 client helper deleted", () => {
  it("regenerate-nav.ts file is gone", () => {
    expect(fs.existsSync(path.resolve(ROOT, "app/sites/[id]/_helpers/regenerate-nav.ts"))).toBe(false);
  });

  it("SitePageClient + ResultsDashboardLegacy no longer import handleRegenerateResponse", () => {
    expect(SITE_CLIENT).not.toMatch(/handleRegenerateResponse/);
    expect(SITE_CLIENT).not.toMatch(/regenerate-nav/);
    expect(LEGACY).not.toMatch(/handleRegenerateResponse/);
    expect(LEGACY).not.toMatch(/regenerate-nav/);
  });

  it("B9.3 helper UTs deleted", () => {
    expect(fs.existsSync(path.resolve(ROOT, "__tests__/b9-3/regenerate-nav.test.ts"))).toBe(false);
  });
});

describe("AC-B10-10 — SitePageClient handleRefreshScore in-place rerun", () => {
  it("handleRefreshScore writes session token + setSite optimistic + router.refresh — no router.push", () => {
    expect(SITE_CLIENT).toMatch(/AC-B10-10/);
    // The success branch does NOT navigate; it stays on the same /sites/{id}.
    const refreshBlock = SITE_CLIENT.match(/async function handleRefreshScore\(\)[\s\S]*?finally \{ setRetrying\(false\); \}/);
    expect(refreshBlock).toBeTruthy();
    expect(refreshBlock![0]).not.toMatch(/router\.push/);
    expect(refreshBlock![0]).toMatch(/router\.refresh\(\)/);
    expect(refreshBlock![0]).toMatch(/sessionStorage\.setItem\(`geo-token-\$\{siteId\}`,\s*newToken\)/);
  });
});

describe("AC-B10-11 — ResultsDashboardLegacy mirrors AC-10 simplifications", () => {
  it("handleRegenerate success branch is router.refresh + onRegenerate (no helper)", () => {
    const block = LEGACY.match(/async function handleRegenerate\(\)[\s\S]*?finally \{ setRegenerating\(false\); \}/);
    expect(block).toBeTruthy();
    expect(block![0]).toMatch(/AC-B10-11/);
    expect(block![0]).toMatch(/router\.refresh\(\)/);
    expect(block![0]).not.toMatch(/handleRegenerateResponse/);
  });
});

describe("AC-B10-14 — schema-drift snapshot updated", () => {
  it("geo_sites snapshot lists current_run_number, current_run_kind, retry_subset_urls", () => {
    expect(DRIFT).toMatch(/"current_run_number"/);
    expect(DRIFT).toMatch(/"current_run_kind"/);
    expect(DRIFT).toMatch(/"retry_subset_urls"/);
  });
});
