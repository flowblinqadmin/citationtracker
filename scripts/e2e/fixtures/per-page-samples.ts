/**
 * ES-e2e-fixtures §b.3 — per-page payloads for fixture seeding.
 *
 * Static (no timestamps) so the seed remains deterministic (HP-260).
 * Types are intentionally loose (`unknown[]`) — the UI shape is an evolving
 * surface and the seed's contract is "length + presence", not full schema
 * conformance. Specs that care about field shape assert against their own
 * narrower types at read-time.
 */

import { SITE_DOMAINS } from "../../../e2e/fixtures/ids";

function makePerPageResult(domain: string, slug: string, idx: number) {
  return {
    url: `https://${domain}/page-${idx}`,
    slug,
    pageIndex: idx,
    crawledAt: "2026-04-01T00:00:00.000Z",
    title: `E2E fixture page ${idx}`,
    metaDescription: `Deterministic fixture description for page ${idx}.`,
    wordCount: 500 + idx * 10,
    hasProductSchema: idx % 2 === 0,
    hasFAQSchema: idx % 3 === 0,
    hasReviewSchema: false,
    overallScore: 60 + (idx % 10),
  };
}

function makePerPageFix(domain: string, slug: string, idx: number) {
  return {
    url: `https://${domain}/page-${idx}`,
    slug,
    pageIndex: idx,
    severity: idx % 3 === 0 ? "high" : idx % 2 === 0 ? "medium" : "low",
    category: "schema",
    name: `Add Product schema to page ${idx}`,
    timeEstimate: "15 min",
    description: "Stub fix payload used by the E2E fixture suite.",
  };
}

export const paidFullPerPageResults: unknown[] = Array.from({ length: 12 }, (_, i) =>
  makePerPageResult(SITE_DOMAINS.paidFullAudit, "e2e-paid-full", i),
);
export const paidFullPerPageFixes: unknown[] = Array.from({ length: 12 }, (_, i) =>
  makePerPageFix(SITE_DOMAINS.paidFullAudit, "e2e-paid-full", i),
);

export const historicalPerPageResults: unknown[] = Array.from({ length: 5 }, (_, i) =>
  makePerPageResult(SITE_DOMAINS.historicalAudit, "e2e-historical", i),
);
export const historicalPerPageFixes: unknown[] = Array.from({ length: 5 }, (_, i) =>
  makePerPageFix(SITE_DOMAINS.historicalAudit, "e2e-historical", i),
);

export const portfolioBPerPageResults: unknown[] = Array.from({ length: 3 }, (_, i) =>
  makePerPageResult(SITE_DOMAINS.portfolioSiteB, "e2e-portfolio-b", i),
);
export const portfolioBPerPageFixes: unknown[] = Array.from({ length: 3 }, (_, i) =>
  makePerPageFix(SITE_DOMAINS.portfolioSiteB, "e2e-portfolio-b", i),
);
