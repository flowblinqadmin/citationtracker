/**
 * ES-B9 — bulk-retry state-machine + UI parity tests.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { canRetryBulk, RUNNING_PIPELINE_STATES } from "@/app/sites/[id]/_helpers/bulk-retry";

const ROUTE = fs.readFileSync(
  path.resolve(process.cwd(), "app/api/sites/[id]/retry-failed/route.ts"),
  "utf8",
);
const SITE_CLIENT = fs.readFileSync(
  path.resolve(process.cwd(), "app/sites/[id]/SitePageClient.tsx"),
  "utf8",
);
const LEGACY = fs.readFileSync(
  path.resolve(process.cwd(), "app/sites/[id]/ResultsDashboardLegacy.tsx"),
  "utf8",
);

// ── canRetryBulk predicate ──────────────────────────────────────────────────

describe("canRetryBulk — shared bulk-retry predicate (AC-B9-7)", () => {
  it("U-B9-9: bulk + complete + failedUrls=['a'] + ungated → true", () => {
    expect(
      canRetryBulk(
        { auditMode: "bulk", pipelineStatus: "complete", failedUrls: ["a"] },
        false,
      ),
    ).toBe(true);
  });

  it("U-B9-10: bulk + failed + failedUrls=[] + ungated → true (status='failed' qualifies)", () => {
    expect(
      canRetryBulk(
        { auditMode: "bulk", pipelineStatus: "failed", failedUrls: [] },
        false,
      ),
    ).toBe(true);
  });

  it("U-B9-11: bulk + complete + nothing-to-retry → false", () => {
    expect(
      canRetryBulk(
        {
          auditMode: "bulk",
          pipelineStatus: "complete",
          failedUrls: [],
          creditLimitedUrls: [],
        },
        false,
      ),
    ).toBe(false);
  });

  it("U-B9-12: bulk + crawling (running) → false", () => {
    for (const running of RUNNING_PIPELINE_STATES) {
      expect(
        canRetryBulk(
          { auditMode: "bulk", pipelineStatus: running, failedUrls: ["a"] },
          false,
        ),
      ).toBe(false);
    }
  });

  it("U-B9-13: gated user → false", () => {
    expect(
      canRetryBulk(
        { auditMode: "bulk", pipelineStatus: "complete", failedUrls: ["a"] },
        true,
      ),
    ).toBe(false);
  });

  it("U-B9-14: single-mode audit → false", () => {
    expect(
      canRetryBulk(
        { auditMode: "single", pipelineStatus: "complete", failedUrls: ["a"] },
        false,
      ),
    ).toBe(false);
  });

  it("creditLimitedUrls non-empty also qualifies", () => {
    expect(
      canRetryBulk(
        {
          auditMode: "bulk",
          pipelineStatus: "complete",
          failedUrls: [],
          creditLimitedUrls: ["x"],
        },
        false,
      ),
    ).toBe(true);
  });

  it("null/undefined site → false", () => {
    expect(canRetryBulk(null, false)).toBe(false);
    expect(canRetryBulk(undefined, false)).toBe(false);
  });
});

// ── /retry-failed route source contracts ───────────────────────────────────

describe("/retry-failed route — state-machine expansion (AC-B9-1..4)", () => {
  it("AC-B9-1: status='failed' + crawlData null → falls back to site.bulkUrls", () => {
    expect(ROUTE).toMatch(/AC-B9-1/);
    expect(ROUTE).toMatch(/site\.pipelineStatus === "failed"\s*&&\s*originalUrlSet\.length > 0/);
  });

  it("AC-B9-2: empty failedUrls + no body URLs → 400 No failed URLs to retry", () => {
    // Existing 400 message preserved.
    expect(ROUTE).toMatch(/No failed URLs to retry/);
  });

  it("AC-B9-3: running-state guard returns 409", () => {
    expect(ROUTE).toMatch(/AC-B9-3/);
    expect(ROUTE).toMatch(/RUNNING_STATES\.has\(site\.pipelineStatus[\s\S]{0,300}status:\s*409/);
  });

  it("AC-B9-4: auditMode !== bulk → 400 preserved", () => {
    expect(ROUTE).toMatch(/Retry only available for bulk audits/);
  });

  it("Candidate-URL precedence: explicit body.urls > failedUrls > bulkUrls (status=failed)", () => {
    // The if/else-if chain selects body.urls first, then failedFromCrawl,
    // then bulkUrls (only when status=failed).
    expect(ROUTE).toMatch(/if \(Array\.isArray\(body\.urls\)[\s\S]{0,200}else if \(failedFromCrawl\.length > 0\)[\s\S]{0,200}else if \(site\.pipelineStatus === "failed"/);
  });

  it("Credit-policy branch landed: γ free-retry on status='failed', α re-charge otherwise", () => {
    // The TODO(B9-credit-branch) marker is gone — replaced by the γ
    // implementation per AC-B9-10 (see __tests__/b9/credit-gamma.test.ts
    // for the full credit-branch coverage).
    expect(ROUTE).not.toMatch(/TODO\(B9-credit-branch\)/);
    expect(ROUTE).toMatch(/AC-B9-10/);
    // α (re-charge) helpers still wired on the non-failed branch.
    expect(ROUTE).toMatch(/effectiveCrawlLimit/);
    expect(ROUTE).toMatch(/bulkCreditsRequired/);
  });
});

// ── UI parity ──────────────────────────────────────────────────────────────

describe("UI parity — both surfaces gate on canRetryBulk (AC-B9-5/6/7/8)", () => {
  it("AC-B9-7: both UIs import + invoke canRetryBulk", () => {
    expect(SITE_CLIENT).toMatch(/canRetryBulk\(/);
    expect(LEGACY).toMatch(/canRetryBulk\(/);
  });

  it("AC-B9-8: legacy gate replaced with canRetryBulk(site, isGated)", () => {
    expect(LEGACY).toMatch(/canRetryBulk\(site, isGated\)/);
    // The pre-fix isComplete-only gate (the standalone clause that combined
    // auditMode + isGated + isComplete) MUST be gone.
    expect(LEGACY).not.toMatch(/site\.auditMode === "bulk" && !isGated && isComplete && \(\(\) =>/);
  });

  it("AC-B9-5/6: SitePageClient renders Bulk Crawl Results card with retry button + role='alert' error", () => {
    expect(SITE_CLIENT).toMatch(/data-testid="bulk-retry-card"/);
    expect(SITE_CLIENT).toMatch(/Retry failed URLs/);
    expect(SITE_CLIENT).toMatch(/handleRetryFailed/);
    expect(SITE_CLIENT).toMatch(/role="alert"[\s\S]{0,800}bulkRetryError/);
  });

  it("AC-B9-6: handleRetryFailed POSTs to /retry-failed with Bearer auth + body shape", () => {
    expect(SITE_CLIENT).toMatch(/fetch\(`\/api\/sites\/\$\{siteId\}\/retry-failed`/);
    expect(SITE_CLIENT).toMatch(/Authorization:\s*"Bearer\s*"\s*\+\s*site\.token/);
    expect(SITE_CLIENT).toMatch(/body:\s*urls\s*\?\s*JSON\.stringify\(\{\s*urls\s*\}\)\s*:\s*"\{\}"/);
  });
});
