/**
 * ES-B9.2 — /regenerate bulk-aware route + helper callback contracts.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROUTE = fs.readFileSync(
  path.resolve(process.cwd(), "app/api/sites/[id]/regenerate/route.ts"),
  "utf8",
);

describe("AC-B9.2-1 — /regenerate bulk-aware route", () => {
  it("removes the prior 400 bulk-block (lines 62-67 gone)", () => {
    expect(ROUTE).not.toMatch(/Bulk audits cannot be regenerated/);
    expect(ROUTE).not.toMatch(/Upload a new CSV on the landing page/);
  });

  it("auditMode==='bulk' branch reads site.bulkUrls (NOT crawlData.failedUrls)", () => {
    const bulkBranch = ROUTE.match(/AC-B9\.2-1[\s\S]*?if \(site\.auditMode === "bulk"\)[\s\S]*?return NextResponse\.json\([\s\S]*?status:\s*202/);
    expect(bulkBranch).toBeTruthy();
    expect(bulkBranch![0]).toMatch(/originalUrlSet\s*=\s*\(site\.bulkUrls/);
    // The bulk path must NOT pull from crawlData.failedUrls — that's the
    // retry-failed semantic (subset-only). Spec ES-B9 §d.1 matrix.
    expect(bulkBranch![0]).not.toMatch(/crawlData\.failedUrls/);
  });

  it("charges via bulkCreditsRequired(crawlLimit) — full set, NOT γ free-retry", () => {
    expect(ROUTE).toMatch(/effectiveCrawlLimit\(originalUrlSet\.length,\s*team\.creditBalance\)/);
    expect(ROUTE).toMatch(/reservedCredits\s*=\s*bulkCreditsRequired\(crawlLimitVal\)/);
    expect(ROUTE).toMatch(/type:\s*"bulk_crawl_reserve"/);
  });

  it("ES-B10 reversal: bulk regenerate UPDATEs in-place (no new spawn, no parentSiteId write)", () => {
    // Pre-B10 (B9.2): spawned a new geoSites row with parentSiteId ref.
    // Post-B10 (AC-B10-2): UPDATE-in-place on the same siteId; parentSiteId
    // preserved as a B9.3 historical breadcrumb but NOT written by B10.
    expect(ROUTE).not.toMatch(/tx\.insert\(geoSites\)/);
    expect(ROUTE).toMatch(/\.update\(geoSites\)\s*\.set\(\{/);
    // Bulk URL set still pulled from site.bulkUrls (originalUrlSet).
    expect(ROUTE).toMatch(/originalUrlSet\s*=\s*\(site\.bulkUrls/);
  });

  it("re-enqueues stage='crawl-fanout' on the SAME siteId with runNumber payload (post-B10)", () => {
    expect(ROUTE).toMatch(/enqueueStage\(\{\s*siteId:\s*id,\s*domain:\s*site\.domain,\s*stage:\s*"crawl-fanout",\s*runNumber:\s*newRunNumber/);
  });

  it("missing/empty bulkUrls → 400 with new copy", () => {
    expect(ROUTE).toMatch(/Original URL list missing — please re-upload via the landing page/);
    expect(ROUTE).toMatch(/originalUrlSet\.length === 0/);
  });

  it("running-state guard PRESERVED ahead of bulk branch (409 wins over bulk)", () => {
    const guardBeforeBulk = ROUTE.indexOf("Pipeline already running") <
      ROUTE.indexOf("AC-B9.2-1 — bulk-aware regenerate");
    expect(guardBeforeBulk).toBe(true);
  });

  it("ES-B10 reversal: bulk branch returns 202 with success:true + siteId=existing + accessToken + runNumber/runKind", () => {
    // Pre-B10 returned newSiteId + parentSiteId (spawn pattern). Post-B10
    // returns the SAME siteId (in-place) plus runNumber + runKind.
    const bulkBranch = ROUTE.match(/if \(site\.auditMode === "bulk"\)[\s\S]*?status:\s*202[^,]*\)/);
    expect(bulkBranch).toBeTruthy();
    expect(ROUTE).toMatch(/success:\s*true/);
    expect(ROUTE).toMatch(/siteId:\s*id\b/); // existing id, not newSiteId
    expect(ROUTE).toMatch(/accessToken:\s*newAccessToken/);
    expect(ROUTE).toMatch(/runNumber:\s*newRunNumber/);
    expect(ROUTE).toMatch(/runKind:\s*"regenerate"/);
  });

  it("single-mode path unchanged: existing resolveFirstAuditMaxPages helper still wired", () => {
    expect(ROUTE).toMatch(/resolveFirstAuditMaxPages\(\{/);
    // The single-mode path stays in the team-path branch below the bulk
    // branch — unchanged from B7.
    expect(ROUTE).toMatch(/if \(site\.teamId\)[\s\S]*?resolveFirstAuditMaxPages/);
  });
});

describe("AC-B9.2-4 — obsolete copy removed across app/, lib/, components/", () => {
  it("repo-wide grep returns 0 hits for 'Upload a new CSV on the landing page'", () => {
    const offenders: string[] = [];
    function walk(dir: string) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|jsx|md)$/.test(entry.name)) {
          const src = fs.readFileSync(full, "utf8");
          if (src.includes("Upload a new CSV on the landing page")) {
            // Allow historical mention in docs/specs/engineering/ES-B9.* (the
            // pre-fix ES references the old copy by design).
            if (full.includes("docs/specs/engineering/ES-B9")) continue;
            offenders.push(full);
          }
        }
      }
    }
    walk(path.resolve(process.cwd(), "app"));
    walk(path.resolve(process.cwd(), "lib"));
    walk(path.resolve(process.cwd(), "components"));
    expect(offenders).toEqual([]);
  });
});
