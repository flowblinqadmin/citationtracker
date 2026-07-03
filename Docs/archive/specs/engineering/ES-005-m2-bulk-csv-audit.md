# ES-005: M2 Bulk CSV URL Audit

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#82](https://github.com/flowblinqadmin/geo/issues/82) · [#83](https://github.com/flowblinqadmin/geo/issues/83) · [#84](https://github.com/flowblinqadmin/geo/issues/84) · [#85](https://github.com/flowblinqadmin/geo/issues/85) · [#86](https://github.com/flowblinqadmin/geo/issues/86) · [#87](https://github.com/flowblinqadmin/geo/issues/87)  
> **Delivery Commit:** `2bad500`  

---

**Source:** TS-002-bulk-csv-audit.md
**Agent:** 2-SpecMaster
**Date:** 2026-02-27
**Branch:** `dev-an-m2-extended` (forked from `main`)
**Repo:** flowblinqadmin/geo (local: `/home/aditya/flowblinq/geo`)
**Issues:** #77 (dynamic crawl depth)
**Deferred:** #78 (domain-layer pricing), #79 (Supabase Storage ZIP caching), #80 (per-page expandable dashboard view)
**Depends on:** ES-002, ES-003, ES-004 (M2 Sprint 1–3 complete)

---

## a) Overview

### What This Covers

Bulk CSV URL Audit is the **primary paid-tier differentiator for M2**. It adds CSV upload capability to the landing page (always visible, backend-gated to paid accounts), a bulk crawl pipeline (Firecrawl-only, no discovery phase), per-page vulnerability extraction, HTML report generation, ZIP download, and credit reserve-then-reconcile billing. Also integrates Issue #77 (dynamic crawl depth based on credits) for both single and bulk audits.

Six tasks across six phases:

```
Task 1 (Foundation: schema + config + jszip)
 ├──→ Task 2 (Dynamic crawl depth #77) ──→ Task 4 (Bulk pipeline) ──→ Task 5 (API layer) ──→ Task 6 (Frontend)
 └──→ Task 3 (Backend services) ──────────→ Task 4
```

### Current Implementation State

- **Schema (`lib/db/schema.ts`):** `geoSites` has NO bulk-related columns. `creditTransactions.type` is a free-text column (not an enum) with values: `"crawl_debit"`, `"topup"`, `"signup_bonus"`, `"refund"`.
- **Config (`lib/config.ts`):** Exists (created in ES-002). Has `PAGES_PER_CREDIT=5`, `PAID_MAX_PAGES=100`, `PAID_CRAWL_CREDIT_COST=20`. No bulk constants or helper functions.
- **Pipeline (`lib/pipeline/runner.ts`):** `startCrawl(siteId, domain, maxPages=100)` accepts maxPages but **does not propagate it** to `discoverSite()` — discovery always uses its own default (1000). `completePipeline()` has no bulk branch or credit reconciliation.
- **Crawler (`lib/services/geo-crawler.ts`):** `discoverSite(domain, maxPages=1000)` uses maxPages for URL selection. `jinaPass()` and `fireFirecrawlJobs()` process all URLs without a page cap. No `startBulkCrawl` function exists.
- **API routes:** `POST /api/sites` accepts `{url, email}` only. `POST verify` kicks off `startCrawl()` with no credit reservation. `GET /api/sites/[id]` has no bulk fields. No download-report endpoint.
- **Frontend:** `app/page.tsx` redirects authenticated users to `/dashboard`. No CSV upload UI. No auth-aware credit display. ResultsDashboard has no download button.
- **Services:** `lib/services/per-page-analyzer.ts`, `report-generator.ts`, `zip-builder.ts` do NOT exist. `jszip` is NOT a dependency.

### Ambiguities Flagged to CoFounder

**1. Single-audit credit model change (TS-002 §4.4):**
TS-002 says to switch single audits from flat `PAID_CRAWL_CREDIT_COST=20` deduction to actual-usage billing (charge for pages actually crawled). Currently, `regenerate/route.ts` deducts 20 credits atomically upfront. Switching to reserve-then-reconcile for single audits means changing the regenerate route, adding reconciliation to `completePipeline()` for ALL audit types, and adding new `creditTransactions` types (`single_crawl_reserve`, `single_crawl_refund`). This affects existing paid users immediately.
**Recommendation:** Implement reserve-then-reconcile for **bulk audits only** in this spec. Defer single-audit actual-usage billing to a follow-up issue to minimize risk and keep this spec focused.

**2. Bulk audit regeneration:**
TS-002 does not address what happens when a paid user clicks "Regenerate" on a completed bulk audit. Options: (a) re-use same CSV URLs and reserve new credits, (b) block regeneration and require new CSV upload, (c) allow regeneration with option to upload new CSV.
**Recommendation:** For M2, **block regeneration on bulk audits**. Show "Upload a new CSV on the landing page to re-run" message. This avoids complex re-reservation logic and keeps the UX simple.

**3. Pipeline failure refund (bulk):**
TS-002 §8 says "On `pipelineStatus: 'failed'`, refund full reserved amount minus any pages already crawled." If the pipeline fails during the AI analysis phase (after crawling but before `completePipeline()` finishes), `crawlData` exists but reconciliation hasn't run. How do we trigger refund?
**Recommendation:** Add a `handleBulkFailure()` function in `completePipeline()`'s failure path that counts pages in `crawlData` (if any) and refunds the difference. If no crawl data exists (failure during crawl phase), refund 100%.

**4. Authenticated user landing page redirect:**
Currently, `app/page.tsx` checks Supabase auth and redirects to `/dashboard`. TS-002 removes this redirect so authenticated users can use the bulk CSV upload on the landing page. This changes behavior for ALL authenticated users. A user who previously went to `geo.flowblinq.com` and got redirected to their dashboard will now see the marketing landing page.
**Recommendation:** Proceed as specified — the auth-aware landing page is the right UX. Users can still navigate to `/dashboard` directly.

**5. Free user bulk submit behavior:**
TS-002 §3.1 says reject with "Bulk audit requires a Pro account with sufficient credits." But the current POST `/api/sites` flow doesn't check authentication until after the email is submitted and OTP is sent. At what point should the free-user rejection happen?
**Recommendation:** Reject at `POST /api/sites` (before OTP is sent). Look up `teamMembers.email` → `teams.creditBalance`. If no team or insufficient credits, return 402 with the generic error message. This avoids wasting an OTP.

---

## b) Implementation Requirements

### Task 1: Foundation — Schema + Config + jszip (#77 prep)

**Phase 1 — no blockers**

#### 1.1 Modify `lib/db/schema.ts`

Add 7 columns to the `geoSites` table after the existing `pipelineError` column:

```ts
// Bulk CSV audit fields
auditMode:        text("audit_mode").default("single"),          // "single" | "bulk"
bulkUrls:         jsonb("bulk_urls"),                            // string[] of raw CSV URLs
bulkUrlCount:     integer("bulk_url_count"),                     // denormalized count
crawlLimit:       integer("crawl_limit"),                        // effective page cap: min(csv, affordable, ABSOLUTE_MAX_PAGES)
creditsReserved:  integer("credits_reserved"),                   // credits reserved at OTP verification
perPageResults:   jsonb("per_page_results"),                     // Array<PerPageResult>
reportZipUrl:     text("report_zip_url"),                        // future: Supabase Storage URL
```

All columns nullable/defaulted — non-breaking additive migration via `drizzle-kit push`.

No changes to `creditTransactions` table structure. New type values (`"bulk_crawl_reserve"`, `"bulk_crawl_refund"`) are free-text strings stored in the existing `type` text column.

#### 1.2 Modify `lib/config.ts`

Add after existing constants:

```ts
// Bulk CSV audit
export const BULK_MAX_URLS = 501;
export const BULK_CREDIT_PRICE_INR = 20;       // 1 credit = 20 INR (~$0.20)
export const ABSOLUTE_MAX_PAGES = 500;         // hard system ceiling per #77

/** Credits required for a given URL count */
export function bulkCreditsRequired(urlCount: number): number {
  return Math.ceil(urlCount / PAGES_PER_CREDIT);
}

/** Effective crawl limit for a bulk audit per #77 */
export function effectiveCrawlLimit(csvUrlCount: number, creditBalance: number): number {
  const affordable = creditBalance * PAGES_PER_CREDIT;
  return Math.min(csvUrlCount, affordable, ABSOLUTE_MAX_PAGES);
}
```

#### 1.3 Add `jszip` dependency

```bash
cd /home/aditya/flowblinq/geo && npm install jszip
```

Verify: `jszip` appears in `package.json` dependencies. ~90KB, Vercel-compatible (pure JS, no native modules).

#### 1.4 Run schema migration

```bash
cd /home/aditya/flowblinq/geo && npx drizzle-kit push
```

Verify new columns exist in Supabase.

---

### Task 2: Dynamic Crawl Depth (#77)

**Phase 2 — depends on Task 1 (imports config constants)**

This task makes crawl depth dynamic based on credit balance for BOTH single and bulk audits.

#### 2.1 Modify `lib/pipeline/runner.ts` — `startCrawl()` signature

Current signature: `startCrawl(siteId: string, domain: string, maxPages: number = 100)`

The `maxPages` parameter already exists but is not propagated to `discoverSite()`. Fix this:

```ts
export async function startCrawl(siteId: string, domain: string, maxPages?: number): Promise<void> {
  // ... existing code ...

  // Change: pass maxPages to discoverSite
  const discoveryData = await discoverSite(domain, maxPages ?? PAID_MAX_PAGES);

  // ... rest unchanged ...
}
```

The `maxPages` parameter already propagates into `discoverSite()` which uses it for URL selection. The `jinaPass()` and `fireFirecrawlJobs()` functions process all URLs from `discoveryData.pageMap`, which is already capped by `discoverSite()`.

#### 2.2 Modify `app/api/sites/[id]/verify/route.ts` — Compute maxPages

After successful OTP verification, before calling `startCrawl()` via `after()`:

```ts
import { FREE_MAX_PAGES, PAID_MAX_PAGES, ABSOLUTE_MAX_PAGES, PAGES_PER_CREDIT } from "@/lib/config";

// Inside POST handler, after OTP verified:
let maxPages = FREE_MAX_PAGES; // default for anonymous/free

if (site.teamId) {
  const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
  if (team && team.creditBalance > 0) {
    maxPages = Math.min(team.creditBalance * PAGES_PER_CREDIT, ABSOLUTE_MAX_PAGES);
  }
}

// Existing after() call — add maxPages
after(async () => {
  await startCrawl(site.id, site.domain, maxPages);
});
```

#### 2.3 Modify `app/api/sites/[id]/regenerate/route.ts` — Compute maxPages

In the **team path** (existing code deducts `PAID_CRAWL_CREDIT_COST`):

```ts
import { ABSOLUTE_MAX_PAGES, PAGES_PER_CREDIT } from "@/lib/config";

// Team path — after credit deduction:
const maxPages = Math.min(
  (team.creditBalance - PAID_CRAWL_CREDIT_COST) * PAGES_PER_CREDIT + PAID_MAX_PAGES,
  ABSOLUTE_MAX_PAGES
);
// Note: creditBalance was already decremented, so we use the post-deduction balance
// Actually simpler: the deducted amount buys PAID_MAX_PAGES. Cap at ABSOLUTE_MAX_PAGES.
const maxPages = Math.min(PAID_MAX_PAGES, ABSOLUTE_MAX_PAGES);

after(async () => {
  await startCrawl(id, site.domain, maxPages);
});
```

Wait — for single audits, the existing flat deduction of 20 credits buys exactly 100 pages (`20 * 5 = 100`). Since `ABSOLUTE_MAX_PAGES = 500 > PAID_MAX_PAGES = 100`, the effective cap for single audits remains 100. No behavioral change for single-audit regeneration.

In the **anonymous free path**:

```ts
after(async () => {
  await startCrawl(id, site.domain, FREE_MAX_PAGES);
});
```

This is already the case if the anonymous path passes `FREE_MAX_PAGES` — verify it does. If it currently calls `startCrawl(id, domain)` without maxPages, add `FREE_MAX_PAGES`.

#### 2.4 Modify `app/api/cron/recrawl/route.ts` — Use PAID_MAX_PAGES

The recrawl cron filters for `paymentStatus = "active"` (paid users only). Ensure it passes `PAID_MAX_PAGES`:

```ts
import { PAID_MAX_PAGES } from "@/lib/config";

// In the recrawl loop:
await startCrawl(site.id, site.domain, PAID_MAX_PAGES);
```

---

### Task 3: Backend Services — Per-Page Analyzer, Report Generator, ZIP Builder

**Phase 3 — depends on Task 1 (types). Can run in parallel with Task 2.**

#### 3.1 Create `lib/services/per-page-analyzer.ts`

**New file.** Rule-based, not LLM-powered.

```ts
import { CrawlData, CrawledPage } from "./geo-crawler";

// ── Types ──

export interface PerPageVulnerability {
  pillar: string;           // e.g., "semantic_html"
  pillarName: string;       // e.g., "Semantic HTML"
  severity: "critical" | "high" | "medium" | "low";
  finding: string;          // what's wrong
  recommendation: string;   // how to fix
}

export interface PerPageResult {
  url: string;
  pageType: string;
  title: string;
  vulnerabilities: PerPageVulnerability[];
  overallPageHealth: "good" | "needs-work" | "poor";
}

// ── Pillar mapping ──

const PILLAR_NAMES: Record<string, string> = {
  semantic_html: "Semantic HTML",
  structured_data: "Structured Data",
  content_structure: "Content Structure",
  faq_coverage: "FAQ Coverage",
  contact_trust: "Contact & Trust Signals",
  author_authority: "Author Authority (E-E-A-T)",
  metadata_freshness: "Metadata & Freshness",
};

// ── Main function ──

export function extractPerPageVulnerabilities(
  crawlData: CrawlData,
  scorecard?: { pillars: Array<{ pillar: string; impactedPages?: string[] }> }
): PerPageResult[] {
  return crawlData.pages.map((page) => {
    const vulns: PerPageVulnerability[] = [];

    // Rule 1: Missing or multiple H1
    if (!page.h1 || page.h1.trim() === "") {
      vulns.push({
        pillar: "semantic_html",
        pillarName: PILLAR_NAMES.semantic_html,
        severity: "high",
        finding: "Page has no H1 heading.",
        recommendation: "Add a single, descriptive H1 that summarizes the page content.",
      });
    }
    // Check for multiple H1s via headings array
    const h1Count = page.headings.filter((h) => h.level === 1).length;
    if (h1Count > 1) {
      vulns.push({
        pillar: "semantic_html",
        pillarName: PILLAR_NAMES.semantic_html,
        severity: "medium",
        finding: `Page has ${h1Count} H1 headings (should have exactly 1).`,
        recommendation: "Use a single H1 per page. Demote extras to H2 or lower.",
      });
    }

    // Rule 2: No structured data
    if (!page.hasStructuredData || page.existingSchema.length === 0) {
      vulns.push({
        pillar: "structured_data",
        pillarName: PILLAR_NAMES.structured_data,
        severity: "high",
        finding: "No JSON-LD structured data found.",
        recommendation: "Add JSON-LD schema markup (Article, FAQPage, Organization, etc.) for AI discoverability.",
      });
    }

    // Rule 3: Thin content (<300 chars)
    if (page.content.length < 300) {
      vulns.push({
        pillar: "content_structure",
        pillarName: PILLAR_NAMES.content_structure,
        severity: page.content.length < 100 ? "critical" : "medium",
        finding: `Thin content: only ${page.content.length} characters (minimum 300 recommended).`,
        recommendation: "Expand page content with substantive, original text. Aim for 500+ characters.",
      });
    }

    // Rule 4: No FAQ on content pages
    const contentTypes = ["services", "pricing", "faq", "about"];
    if (contentTypes.includes(page.pageType) && page.faqContent.length === 0) {
      vulns.push({
        pillar: "faq_coverage",
        pillarName: PILLAR_NAMES.faq_coverage,
        severity: "medium",
        finding: `No FAQ content found on ${page.pageType} page.`,
        recommendation: "Add an FAQ section with questions users commonly ask about this topic.",
      });
    }

    // Rule 5: No contact info on key pages
    const trustPages = ["homepage", "about", "contact", "services"];
    if (trustPages.includes(page.pageType) && page.contactInfo.length === 0) {
      vulns.push({
        pillar: "contact_trust",
        pillarName: PILLAR_NAMES.contact_trust,
        severity: page.pageType === "contact" ? "critical" : "medium",
        finding: `No contact information found on ${page.pageType} page.`,
        recommendation: "Add email, phone, or physical address to establish trust signals.",
      });
    }

    // Rule 6: No author signals
    const authorPages = ["blog", "case-studies", "docs"];
    if (authorPages.includes(page.pageType)) {
      const hasAuthor = page.content.toLowerCase().includes("author") ||
                        page.existingSchema.some((s) => s.includes("Person") || s.includes("Author"));
      if (!hasAuthor) {
        vulns.push({
          pillar: "author_authority",
          pillarName: PILLAR_NAMES.author_authority,
          severity: "medium",
          finding: "No author attribution found on content page.",
          recommendation: "Add author name, bio, and credentials to demonstrate E-E-A-T.",
        });
      }
    }

    // Rule 7: Missing meta/title
    if (!page.title || page.title.trim() === "") {
      vulns.push({
        pillar: "metadata_freshness",
        pillarName: PILLAR_NAMES.metadata_freshness,
        severity: "critical",
        finding: "Page has no title tag.",
        recommendation: "Add a unique, descriptive <title> tag (50-60 characters).",
      });
    }

    // Rule 8: Correlate from scorecard impactedPages
    if (scorecard) {
      for (const pillar of scorecard.pillars) {
        if (pillar.impactedPages?.some((p) => page.url.includes(p) || p.includes(page.url))) {
          // Only add if we haven't already flagged this pillar
          if (!vulns.some((v) => v.pillar === pillar.pillar)) {
            vulns.push({
              pillar: pillar.pillar,
              pillarName: PILLAR_NAMES[pillar.pillar] ?? pillar.pillar,
              severity: "low",
              finding: `Flagged by site-level GEO analysis as impacted for ${PILLAR_NAMES[pillar.pillar] ?? pillar.pillar}.`,
              recommendation: "Review the site-level scorecard for specific recommendations.",
            });
          }
        }
      }
    }

    // Compute health
    const criticalCount = vulns.filter((v) => v.severity === "critical").length;
    const highCount = vulns.filter((v) => v.severity === "high").length;
    let overallPageHealth: "good" | "needs-work" | "poor";
    if (criticalCount > 0 || highCount >= 3) {
      overallPageHealth = "poor";
    } else if (highCount > 0 || vulns.length >= 3) {
      overallPageHealth = "needs-work";
    } else {
      overallPageHealth = "good";
    }

    return {
      url: page.url,
      pageType: page.pageType,
      title: page.title || "(untitled)",
      vulnerabilities: vulns,
      overallPageHealth,
    };
  });
}
```

**Key design decisions:**
- Pure function, no side effects, no async — fast and testable.
- Returns empty `vulnerabilities` array for healthy pages (not null).
- Health threshold: critical OR 3+ high = "poor"; any high OR 3+ total = "needs-work"; else "good".

#### 3.2 Create `lib/services/report-generator.ts`

**New file.** Generates styled standalone HTML reports.

```ts
import { PerPageResult } from "./per-page-analyzer";

// ── Types ──

interface SiteForReport {
  domain: string;
  geoScorecard: {
    overallScore: number;
    pillars: Array<{
      pillarName: string;
      score: number;
      priority: string;
    }>;
    topThreeImprovements: string[];
  };
  executiveSummary: string;
}

// ── Shared styles ──

const BRAND_STYLES = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #e5e5e5; margin: 0; padding: 24px; }
  .container { max-width: 800px; margin: 0 auto; }
  h1 { color: #f5f5f5; font-size: 24px; border-bottom: 2px solid #333; padding-bottom: 12px; }
  h2 { color: #f5f5f5; font-size: 18px; margin-top: 32px; }
  .score { font-size: 48px; font-weight: bold; text-align: center; margin: 24px 0; }
  .score.good { color: #22c55e; }
  .score.fair { color: #f59e0b; }
  .score.poor { color: #ef4444; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
  .badge.critical { background: #991b1b; color: #fca5a5; }
  .badge.high { background: #9a3412; color: #fdba74; }
  .badge.medium { background: #854d0e; color: #fde047; }
  .badge.low { background: #1e3a5f; color: #93c5fd; }
  .badge.good { background: #14532d; color: #86efac; }
  .badge.needs-work { background: #854d0e; color: #fde047; }
  .badge.poor { background: #991b1b; color: #fca5a5; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #333; }
  th { color: #a3a3a3; font-weight: 600; font-size: 13px; text-transform: uppercase; }
  .vuln { background: #171717; border-radius: 8px; padding: 16px; margin: 12px 0; }
  .footer { text-align: center; color: #737373; font-size: 12px; margin-top: 48px; padding-top: 16px; border-top: 1px solid #333; }
  a { color: #60a5fa; }
`;

// ── Per-page HTML ──

export function generatePerPageHtml(result: PerPageResult, domain: string): string {
  const healthClass = result.overallPageHealth;
  const vulnHtml = result.vulnerabilities.length === 0
    ? '<p style="color: #86efac;">No vulnerabilities detected. This page looks good.</p>'
    : result.vulnerabilities.map((v) => `
        <div class="vuln">
          <span class="badge ${v.severity}">${v.severity.toUpperCase()}</span>
          <strong style="margin-left: 8px;">${escapeHtml(v.pillarName)}</strong>
          <p style="margin: 8px 0 4px; color: #d4d4d4;">${escapeHtml(v.finding)}</p>
          <p style="margin: 0; color: #a3a3a3; font-size: 14px;">→ ${escapeHtml(v.recommendation)}</p>
        </div>
      `).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GEO Audit: ${escapeHtml(result.url)}</title>
  <style>${BRAND_STYLES}</style>
</head>
<body>
  <div class="container">
    <h1>Page Audit: ${escapeHtml(result.title)}</h1>
    <p style="color: #a3a3a3;">${escapeHtml(result.url)}</p>
    <p>Page type: <strong>${escapeHtml(result.pageType)}</strong> &nbsp; Health: <span class="badge ${healthClass}">${result.overallPageHealth}</span></p>
    <h2>Vulnerabilities (${result.vulnerabilities.length})</h2>
    ${vulnHtml}
    <div class="footer">
      Generated by <a href="https://geo.flowblinq.com">FlowBlinq GEO</a> for ${escapeHtml(domain)}
    </div>
  </div>
</body>
</html>`;
}

// ── Aggregate HTML ──

export function generateAggregateHtml(site: SiteForReport, perPageResults: PerPageResult[]): string {
  const scoreClass = site.geoScorecard.overallScore >= 80 ? "good" : site.geoScorecard.overallScore >= 50 ? "fair" : "poor";

  const pillarRows = site.geoScorecard.pillars
    .sort((a, b) => a.score - b.score)
    .map((p) => {
      const cls = p.score >= 80 ? "good" : p.score >= 50 ? "fair" : "poor";
      return `<tr><td>${escapeHtml(p.pillarName)}</td><td><span class="badge ${cls}">${p.score}/100</span></td><td>${escapeHtml(p.priority)}</td></tr>`;
    }).join("");

  const healthDist = {
    good: perPageResults.filter((r) => r.overallPageHealth === "good").length,
    "needs-work": perPageResults.filter((r) => r.overallPageHealth === "needs-work").length,
    poor: perPageResults.filter((r) => r.overallPageHealth === "poor").length,
  };

  const topRecs = site.geoScorecard.topThreeImprovements
    .map((r, i) => `<li>${escapeHtml(r)}</li>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GEO Audit Report: ${escapeHtml(site.domain)}</title>
  <style>${BRAND_STYLES}</style>
</head>
<body>
  <div class="container">
    <h1>GEO Audit Report: ${escapeHtml(site.domain)}</h1>
    <div class="score ${scoreClass}">${site.geoScorecard.overallScore}/100</div>
    <h2>Executive Summary</h2>
    <p>${escapeHtml(site.executiveSummary)}</p>
    <h2>Pillar Scores</h2>
    <table>
      <tr><th>Pillar</th><th>Score</th><th>Priority</th></tr>
      ${pillarRows}
    </table>
    <h2>Page Health Distribution (${perPageResults.length} pages)</h2>
    <table>
      <tr><th>Status</th><th>Count</th></tr>
      <tr><td><span class="badge good">Good</span></td><td>${healthDist.good}</td></tr>
      <tr><td><span class="badge needs-work">Needs Work</span></td><td>${healthDist["needs-work"]}</td></tr>
      <tr><td><span class="badge poor">Poor</span></td><td>${healthDist.poor}</td></tr>
    </table>
    <h2>Top Recommendations</h2>
    <ol>${topRecs}</ol>
    <div class="footer">
      Generated by <a href="https://geo.flowblinq.com">FlowBlinq GEO</a> &mdash; ${new Date().toISOString().split("T")[0]}
    </div>
  </div>
</body>
</html>`;
}

// ── Helpers ──

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
```

**Key design decisions:**
- Inline CSS only — no external dependencies. ~5KB per page HTML.
- Dark theme matching GEO brand (`#0a0a0a` bg, `#e5e5e5` text).
- `escapeHtml()` on all dynamic content to prevent XSS in generated reports.
- Aggregate report includes: overall score, pillar table, page health distribution, top 3 recommendations.

#### 3.3 Create `lib/services/zip-builder.ts`

**New file.** Uses `jszip` to build downloadable ZIP archive.

```ts
import JSZip from "jszip";
import { PerPageResult } from "./per-page-analyzer";
import { generatePerPageHtml, generateAggregateHtml } from "./report-generator";

interface SiteForZip {
  domain: string;
  geoScorecard: {
    overallScore: number;
    pillars: Array<{ pillarName: string; score: number; priority: string }>;
    topThreeImprovements: string[];
  };
  executiveSummary: string;
}

/**
 * Build a ZIP archive containing per-page HTML reports and an aggregate report.
 * Returns a Buffer suitable for streaming as application/zip.
 *
 * 501 pages × ~5KB = ~2.5MB uncompressed, ~500KB compressed. Generates in <2s.
 */
export async function buildReportZip(
  site: SiteForZip,
  perPageResults: PerPageResult[]
): Promise<Buffer> {
  const zip = new JSZip();

  // Aggregate report at root
  const aggregateHtml = generateAggregateHtml(site, perPageResults);
  zip.file("aggregate-report.html", aggregateHtml);

  // Per-page reports in pages/ folder
  const pagesFolder = zip.folder("pages")!;
  for (const result of perPageResults) {
    const filename = urlToFilename(result.url) + ".html";
    const html = generatePerPageHtml(result, site.domain);
    pagesFolder.file(filename, html);
  }

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) as Promise<Buffer>;
}

/**
 * Convert a URL to a safe filename.
 * e.g., "https://example.com/blog/my-post" → "blog_my-post"
 */
function urlToFilename(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\//, "").replace(/\/$/, "") || "index";
    return path
      .replace(/\//g, "_")         // slashes → underscores
      .replace(/[^a-zA-Z0-9_-]/g, "") // strip unsafe chars
      .slice(0, 100);              // cap filename length
  } catch {
    return "page-" + Buffer.from(url).toString("base64url").slice(0, 20);
  }
}
```

**Key design decisions:**
- DEFLATE compression — ~80% reduction.
- `urlToFilename()` sanitizes URLs to safe filesystem names (no `/`, no special chars, max 100 chars).
- Fallback filename uses base64url encoding for malformed URLs.
- Returns `Buffer` for direct streaming in API response.

---

### Task 4: Bulk Pipeline — `startBulkCrawl()` + `completePipeline()` Changes

**Phase 4 — depends on Tasks 1, 2, 3**

#### 4.1 Add `startBulkCrawl()` to `lib/pipeline/runner.ts`

New exported function, bulk equivalent of `startCrawl()`. Key differences from `startCrawl()`:
- **No discovery phase** — URLs are provided by the user
- **No Jina pass** — Firecrawl-only (premium quality)
- **Batch chunking** — 50 URLs per batch, up to 10 concurrent (vs 5 for single)
- **Synthetic discoveryData** — build from CSV URLs

```ts
import { ABSOLUTE_MAX_PAGES } from "@/lib/config";
import { classifyPageType, fireFirecrawlJobs } from "@/lib/services/geo-crawler";

/**
 * Start a bulk CSV audit. Called from verify route via after().
 * Skips discovery — builds synthetic discoveryData from CSV URLs,
 * then fires Firecrawl async jobs for all URLs.
 */
export async function startBulkCrawl(
  siteId: string,
  domain: string,
  bulkUrls: string[]
): Promise<void> {
  try {
    // Build synthetic discoveryData
    const pageMap: Record<string, string> = {};
    for (const url of bulkUrls) {
      pageMap[url] = classifyPageType(url);
    }

    const discoveryData = {
      urls: bulkUrls,
      pageMap,
      hasLlmsTxt: false,
      hasUcp: false,
      hasSitemap: false,
      hasRobots: false,
      totalPages: bulkUrls.length,
    };

    // Store discoveryData + set status to crawling (skip discovery stage)
    await db.update(geoSites).set({
      discoveryData,
      pipelineStatus: "crawling",
    }).where(eq(geoSites.id, siteId));

    // Fire Firecrawl async jobs — all URLs go through Firecrawl (no Jina)
    // Batch: 50 per chunk, 10 concurrent (doubled from single audit's 5)
    const jobIds = await fireBulkFirecrawlJobs(domain, bulkUrls);

    // Store job IDs for polling
    await db.update(geoSites).set({
      crawlJobIds: jobIds,
    }).where(eq(geoSites.id, siteId));

    // Trigger cron to start polling
    after(async () => {
      await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/cron/process-queue`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
    });

  } catch (error) {
    console.error(`[bulk-pipeline] startBulkCrawl failed for ${siteId}:`, error);
    await db.update(geoSites).set({
      pipelineStatus: "failed",
      pipelineError: error instanceof Error ? error.message : "Unknown bulk crawl error",
    }).where(eq(geoSites.id, siteId));
  }
}
```

#### 4.2 Add `fireBulkFirecrawlJobs()` to `lib/services/geo-crawler.ts`

New function, similar to `fireFirecrawlJobs()` but with higher concurrency:

```ts
/**
 * Fire Firecrawl async jobs for bulk audit.
 * 50 URLs per batch, up to 10 concurrent jobs.
 * Returns array of job IDs for polling.
 */
export async function fireBulkFirecrawlJobs(
  domain: string,
  urls: string[]
): Promise<string[]> {
  const BATCH_SIZE = 50;
  const MAX_CONCURRENT = 10;
  const batches: string[][] = [];

  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    batches.push(urls.slice(i, i + BATCH_SIZE));
  }

  const jobIds: string[] = [];

  // Process batches with concurrency limit
  for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
    const chunk = batches.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.all(
      chunk.map(async (batchUrls) => {
        const paths = batchUrls.map((u) => {
          try { return new URL(u).pathname; }
          catch { return u; }
        });
        const job = await fc.asyncCrawlUrl(domain, {
          includePaths: paths,
          limit: batchUrls.length,
          scrapeOptions: { formats: ["markdown", "rawHtml"] },
        });
        return job.id;
      })
    );
    jobIds.push(...results);
  }

  return jobIds;
}
```

**Note:** `fc` is the existing Firecrawl client instance in `geo-crawler.ts`. The function reuses the same `asyncCrawlUrl` pattern as `fireFirecrawlJobs()` but with 50-URL batches and 10x concurrency.

#### 4.3 Modify `completePipeline()` — Bulk branch + credit reconciliation

In `lib/pipeline/runner.ts`, after the existing assembly step (before final DB update), add:

```ts
// Inside completePipeline(), after assembleResults():

// ── Bulk post-processing ──
if (site.auditMode === "bulk" && crawlData) {
  // 1. Per-page vulnerability extraction
  const perPageResults = extractPerPageVulnerabilities(crawlData, geoScorecard);

  // 2. Credit reconciliation
  const actualPagesCrawled = crawlData.pages.length;
  const actualCredits = bulkCreditsRequired(actualPagesCrawled);
  const reservedCredits = site.creditsReserved ?? 0;

  if (actualCredits < reservedCredits && site.teamId) {
    const refundCredits = reservedCredits - actualCredits;
    const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
    if (team) {
      await db.transaction(async (tx) => {
        await tx.update(teams).set({
          creditBalance: team.creditBalance + refundCredits,
        }).where(eq(teams.id, site.teamId));

        await tx.insert(creditTransactions).values({
          id: nanoid(),
          teamId: site.teamId,
          siteId: siteId,
          type: "bulk_crawl_refund",
          pagesConsumed: actualPagesCrawled,
          creditsChanged: refundCredits,  // positive = refund
          balanceBefore: team.creditBalance,
          balanceAfter: team.creditBalance + refundCredits,
          createdAt: new Date(),
        });
      });
    }
  }

  // Store per-page results
  bulkUpdates = {
    perPageResults,
  };
}

// Include bulkUpdates in the final DB update
await db.update(geoSites).set({
  // ... existing fields ...
  ...bulkUpdates,
}).where(eq(geoSites.id, siteId));
```

#### 4.4 Modify `completePipeline()` — Bulk failure refund

In the failure path of `completePipeline()` (where `pipelineStatus` is set to `"failed"`):

```ts
// Inside completePipeline(), in the failure/error handler:

if (site.auditMode === "bulk" && site.creditsReserved && site.teamId) {
  // Count pages already crawled (if any)
  const partialCrawlData = site.crawlData as CrawlData | null;
  const pagesCrawled = partialCrawlData?.pages?.length ?? 0;
  const creditsUsed = bulkCreditsRequired(pagesCrawled);
  const refundCredits = Math.max(0, (site.creditsReserved ?? 0) - creditsUsed);

  if (refundCredits > 0) {
    const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
    if (team) {
      await db.transaction(async (tx) => {
        await tx.update(teams).set({
          creditBalance: team.creditBalance + refundCredits,
        }).where(eq(teams.id, site.teamId));

        await tx.insert(creditTransactions).values({
          id: nanoid(),
          teamId: site.teamId,
          siteId,
          type: "bulk_crawl_refund",
          pagesConsumed: pagesCrawled,
          creditsChanged: refundCredits,
          balanceBefore: team.creditBalance,
          balanceAfter: team.creditBalance + refundCredits,
          createdAt: new Date(),
        });
      });
    }
  }
}
```

---

### Task 5: API Layer

**Phase 5 — depends on Tasks 1, 2, 4**

#### 5.1 Modify `app/api/sites/route.ts` — Accept bulk URLs

Add bulk URL handling to the existing POST handler:

```ts
import { BULK_MAX_URLS } from "@/lib/config";

// Inside POST handler, after parsing body:
const { url, email, bulkUrls } = await req.json();

// If bulkUrls present → bulk flow
if (bulkUrls && Array.isArray(bulkUrls)) {
  // Validate: array of valid HTTP/HTTPS URLs, length 1–501
  if (bulkUrls.length === 0 || bulkUrls.length > BULK_MAX_URLS) {
    return NextResponse.json(
      { error: `Bulk audit accepts 1 to ${BULK_MAX_URLS} URLs.` },
      { status: 400 }
    );
  }

  // SSRF check each URL
  const invalidUrls: string[] = [];
  for (const u of bulkUrls) {
    try {
      const parsed = new URL(u);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        invalidUrls.push(u);
        continue;
      }
      // Reuse existing SSRF validation (isPrivateRange check)
      if (isPrivateRange(parsed.hostname)) {
        invalidUrls.push(u);
      }
    } catch {
      invalidUrls.push(u);
    }
  }

  if (invalidUrls.length > 0) {
    return NextResponse.json(
      { error: `${invalidUrls.length} invalid URL(s) in CSV. All URLs must be valid HTTP/HTTPS addresses.` },
      { status: 400 }
    );
  }

  // Dedupe
  const uniqueUrls = [...new Set(bulkUrls)];

  // Check team + credits via email
  const [member] = await db.select().from(teamMembers).where(eq(teamMembers.email, email.toLowerCase()));
  if (!member) {
    return NextResponse.json(
      { error: "Bulk audit requires a Pro account with sufficient credits." },
      { status: 402 }
    );
  }

  const [team] = await db.select().from(teams).where(eq(teams.id, member.teamId));
  const requiredCredits = bulkCreditsRequired(uniqueUrls.length);
  if (!team || team.creditBalance < requiredCredits) {
    return NextResponse.json(
      { error: "Bulk audit requires a Pro account with sufficient credits." },
      { status: 402 }
    );
  }

  // Extract domain from first URL
  const firstDomain = new URL(uniqueUrls[0]).hostname.replace(/^www\./, "");

  // Create geoSites row
  const siteId = nanoid();
  const verificationCode = generateCode();
  const codeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

  await db.insert(geoSites).values({
    id: siteId,
    domain: firstDomain,
    slug: nanoid(10),
    ownerEmail: email.toLowerCase(),
    teamId: member.teamId,
    auditMode: "bulk",
    bulkUrls: uniqueUrls,
    bulkUrlCount: uniqueUrls.length,
    pipelineStatus: "pending",
    verificationCode: hashCode(verificationCode),
    codeExpiresAt,
    accessToken: nanoid(32),
  });

  // Send OTP
  await sendVerificationEmail(email, verificationCode, firstDomain);

  return NextResponse.json({ id: siteId, message: "Verification code sent." }, { status: 201 });
}

// ... existing single-URL flow unchanged ...
```

**Key design decisions:**
- SSRF validation reuses existing `isPrivateRange()` function on each URL.
- Dedupe before counting (user may have duplicates in CSV).
- Generic error message for no-team AND insufficient-credits (no enumeration).
- Credit check at submit time is **advisory** — real reservation happens at OTP verify.

#### 5.2 Modify `app/api/sites/[id]/verify/route.ts` — Bulk credit reservation

After successful OTP verification, add a bulk branch:

```ts
import { effectiveCrawlLimit, bulkCreditsRequired, ABSOLUTE_MAX_PAGES } from "@/lib/config";
import { startBulkCrawl } from "@/lib/pipeline/runner";

// Inside POST handler, after OTP verified and accessToken generated:

if (site.auditMode === "bulk" && site.bulkUrls && site.teamId) {
  // Re-check team + credits (may have changed since submit)
  const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
  if (!team || team.creditBalance <= 0) {
    return NextResponse.json(
      { error: "Insufficient credits. Please top up before verifying." },
      { status: 402 }
    );
  }

  const bulkUrls = site.bulkUrls as string[];
  const crawlLimit = effectiveCrawlLimit(bulkUrls.length, team.creditBalance);
  const reservedCredits = bulkCreditsRequired(crawlLimit);

  // Atomic transaction: reserve credits + update site
  await db.transaction(async (tx) => {
    // Deduct credits
    await tx.update(teams).set({
      creditBalance: team.creditBalance - reservedCredits,
    }).where(eq(teams.id, site.teamId));

    // Log transaction
    await tx.insert(creditTransactions).values({
      id: nanoid(),
      teamId: site.teamId,
      siteId: site.id,
      type: "bulk_crawl_reserve",
      pagesConsumed: crawlLimit,
      creditsChanged: -reservedCredits,
      balanceBefore: team.creditBalance,
      balanceAfter: team.creditBalance - reservedCredits,
      createdAt: new Date(),
    });

    // Update site with crawl parameters
    await tx.update(geoSites).set({
      emailVerified: true,
      verificationCode: null,
      codeExpiresAt: null,
      accessToken: nanoid(32),
      crawlLimit,
      creditsReserved: reservedCredits,
      pipelineStatus: "crawling",  // skip discovery
    }).where(eq(geoSites.id, site.id));
  });

  // Kick off bulk pipeline
  after(async () => {
    await startBulkCrawl(site.id, site.domain, bulkUrls.slice(0, crawlLimit));
  });

  return NextResponse.json({
    success: true,
    siteId: site.id,
    accessToken: site.accessToken,  // Note: we just set a new one in the tx above — re-query or use the generated value
  });
}

// ... existing single-URL verify flow ...
```

**Implementation note:** The `accessToken` returned should be the one generated in the transaction. Store it in a variable before the transaction and use it in both the DB update and the response.

#### 5.3 Modify `app/api/sites/[id]/route.ts` — Return bulk fields

In the GET handler's response builder, add bulk fields for bulk audits:

```ts
// Inside GET handler, when building response object:

// Always include (if present)
auditMode: site.auditMode ?? "single",
bulkUrlCount: site.bulkUrlCount ?? null,

// Paid-only bulk fields (when tier === "paid" and auditMode === "bulk")
...(tier === "paid" && site.auditMode === "bulk" ? {
  perPageResults: site.perPageResults ?? null,
  reportZipUrl: site.reportZipUrl ?? null,
} : {}),
```

#### 5.4 Create `app/api/sites/[id]/download-report/route.ts`

**New file.** Generates and streams ZIP on-the-fly.

```ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites, teams } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { buildReportZip } from "@/lib/services/zip-builder";
import type { PerPageResult } from "@/lib/services/per-page-analyzer";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const token = req.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Load site
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, id));
  if (!site || site.accessToken !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify bulk audit + paid tier
  if (site.auditMode !== "bulk") {
    return NextResponse.json({ error: "Download only available for bulk audits." }, { status: 400 });
  }

  if (!site.teamId) {
    return NextResponse.json({ error: "Pro account required." }, { status: 402 });
  }

  if (site.pipelineStatus !== "complete") {
    return NextResponse.json({ error: "Audit not yet complete." }, { status: 409 });
  }

  const perPageResults = (site.perPageResults as PerPageResult[]) ?? [];
  if (perPageResults.length === 0) {
    return NextResponse.json({ error: "No per-page results available." }, { status: 404 });
  }

  // Build ZIP
  const zipBuffer = await buildReportZip(
    {
      domain: site.domain,
      geoScorecard: site.geoScorecard as any,
      executiveSummary: (site.executiveSummary as string) ?? "",
    },
    perPageResults
  );

  const filename = `${site.domain.replace(/[^a-zA-Z0-9.-]/g, "_")}-geo-audit.zip`;

  return new NextResponse(zipBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(zipBuffer.length),
    },
  });
}
```

#### 5.5 Modify `app/api/sites/[id]/regenerate/route.ts` — Block bulk regeneration

At the top of the POST handler, after loading the site:

```ts
// Block regeneration for bulk audits
if (site.auditMode === "bulk") {
  return NextResponse.json(
    { error: "Bulk audits cannot be regenerated. Upload a new CSV on the landing page." },
    { status: 400 }
  );
}
```

---

### Task 6: Frontend — Auth-Aware Landing Page, CSV Upload, Progress UI, Download Button

**Phase 6 — depends on Task 5 (API layer)**

#### 6.1 Modify `app/page.tsx` — Auth-aware + CSV upload

**Remove** the redirect to `/dashboard` for authenticated users. Replace with:

```tsx
"use client";
import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";

export default function HomePage() {
  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);

  // Auth + credits state (NEW)
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [authEmail, setAuthEmail] = useState<string | null>(null);

  // CSV state (NEW)
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvUrls, setCsvUrls] = useState<string[]>([]);
  const [csvError, setCsvError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Check auth — do NOT redirect
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        setIsAuthenticated(true);
        setAuthEmail(data.user.email ?? null);
        setEmail(data.user.email ?? "");
        // Fetch credits
        fetch("/api/teams/me").then((r) => r.json()).then((d) => {
          setCreditBalance(d.creditBalance ?? 0);
        }).catch(() => {});
      }
    });
  }, []);

  // CSV parsing handler
  const handleCsvUpload = (file: File) => {
    setCsvError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const lines = text.split(/\r?\n/).filter(Boolean);
      const urls: string[] = [];

      for (const line of lines) {
        const firstCol = line.split(",")[0].trim().replace(/^["']|["']$/g, "");
        try {
          const parsed = new URL(firstCol);
          if (["http:", "https:"].includes(parsed.protocol)) {
            urls.push(firstCol);
          }
        } catch { /* skip non-URL lines (headers, etc.) */ }
      }

      const unique = [...new Set(urls)];
      if (unique.length === 0) {
        setCsvError("No valid URLs found in CSV. Ensure URLs are in the first column.");
        return;
      }
      if (unique.length > 501) {
        setCsvError(`CSV contains ${unique.length} URLs — max 501 per audit.`);
        return;
      }

      setCsvUrls(unique);
      setCsvFile(file);
    };
    reader.readAsText(file);
  };

  // Credit-aware pricing display (computed)
  const csvPricingMessage = (() => {
    if (csvUrls.length === 0) return null;
    const urlCount = csvUrls.length;
    const creditsNeeded = Math.ceil(urlCount / 5);
    const costInr = creditsNeeded * 20;

    if (isAuthenticated && creditBalance !== null) {
      const crawlLimit = Math.min(urlCount, creditBalance * 5, 500);
      const limitedCredits = Math.ceil(crawlLimit / 5);

      if (crawlLimit >= urlCount) {
        return `${urlCount} URLs detected — ${creditsNeeded} credits required (₹${costInr.toLocaleString()}). All URLs will be processed.`;
      } else if (crawlLimit > 0) {
        return `${urlCount} URLs detected but your account has ${creditBalance} credits (${creditBalance * 5} pages). ${crawlLimit} of ${urlCount} URLs will be processed. Buy more credits or reduce your CSV.`;
      } else {
        return `${urlCount} URLs detected — you need ${creditsNeeded} credits. Your balance is 0.`;
      }
    }

    return `${urlCount} URLs detected → ${creditsNeeded} credits (₹${costInr.toLocaleString()}). Sign in to see your credit limit.`;
  })();

  // Submit handler
  const handleSubmit = async () => {
    setLoading(true);
    try {
      const body = csvUrls.length > 0
        ? { email, bulkUrls: csvUrls }
        : { url, email };

      const res = await fetch("/api/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Something went wrong");
        return;
      }
      router.push(`/verify/${data.id}`);
    } finally {
      setLoading(false);
    }
  };

  // CSV upload UI (render below URL field, above submit):
  // - Dashed border drop zone: "Pro: Bulk URL Audit — Upload CSV with up to 501 URLs"
  // - When CSV attached: show filename, URL count, pricing message, remove button
  // - URL field: disabled (greyed out) when CSV is active
  // - Email field: pre-filled if authenticated
  // - Tagline: conditionally show "Pro feature — credits required" when CSV attached
}
```

**Implementation notes:**
- The above is a **structural guide**, not copy-paste code. The existing `app/page.tsx` has extensive JSX/styling that should be preserved. ScriptDev should integrate the new state variables and CSV handling into the existing component.
- CSV parsing runs client-side — no server round-trip.
- `handleCsvUpload` extracts URLs from the first column, strips quotes, dedupes, validates format.
- Drag-and-drop: add `onDrop` handler to the CSV zone matching the `onDragOver`/`onDrop` pattern.

#### 6.2 Modify `app/sites/[id]/SitePageClient.tsx` — Bulk progress UI

In the progress monitor (Phase 2), add bulk-specific display:

```tsx
// In STAGES array or stage rendering logic:

// For auditMode === "bulk":
// 1. Skip "Discovery" stage — bulk audits start at "Crawling"
// 2. Show URL count from bulkUrlCount in crawling progress bar
// 3. Label: "Crawling {bulkUrlCount} pages via premium crawler..."

// Condition:
const stages = site?.auditMode === "bulk"
  ? STAGES.filter((s) => s.key !== "discovery")
  : STAGES;

// In crawling stage label:
const crawlingLabel = site?.auditMode === "bulk"
  ? `Crawling ${site.bulkUrlCount} pages via premium crawler...`
  : "Reading your content";
```

**Implementation note:** `auditMode` and `bulkUrlCount` must be included in the `SiteData` type and returned by the GET API (Task 5.3).

#### 6.3 Modify `app/sites/[id]/ResultsDashboard.tsx` — Download button

Add a "Download Full Report (ZIP)" button for bulk paid audits:

```tsx
// In the results header area, after the Regenerate button:

{site.auditMode === "bulk" && site.tier === "paid" && site.pipelineStatus === "complete" && (
  <button
    onClick={() => {
      window.location.href = `/api/sites/${site.id}/download-report?token=${token}`;
    }}
    style={{
      padding: "10px 20px",
      background: "#22c55e",
      color: "#fff",
      border: "none",
      borderRadius: "8px",
      cursor: "pointer",
      fontWeight: 600,
    }}
  >
    Download Full Report (ZIP)
  </button>
)}
```

Also, **disable the Regenerate button for bulk audits**:

```tsx
// In the Regenerate button:
{site.auditMode !== "bulk" && (
  // existing regenerate button
)}

{site.auditMode === "bulk" && (
  <p style={{ color: "#a3a3a3", fontSize: "14px" }}>
    To re-run a bulk audit, upload a new CSV on the landing page.
  </p>
)}
```

---

## c) Unit Test Plan

All tests use **Vitest + React Testing Library**. Test files follow the existing `__tests__/` convention.

### Test File: `__tests__/bulk-config.test.ts`

Tests for Task 1 config changes.

| # | Test Case | Input | Expected | Edge |
|---|-----------|-------|----------|------|
| 1 | `BULK_MAX_URLS` is 501 | — | `501` | — |
| 2 | `ABSOLUTE_MAX_PAGES` is 500 | — | `500` | — |
| 3 | `BULK_CREDIT_PRICE_INR` is 20 | — | `20` | — |
| 4 | `bulkCreditsRequired(5)` | 5 URLs | `1` | Exact multiple |
| 5 | `bulkCreditsRequired(6)` | 6 URLs | `2` | Rounds up |
| 6 | `bulkCreditsRequired(501)` | 501 URLs | `101` | Max CSV |
| 7 | `bulkCreditsRequired(0)` | 0 URLs | `0` | Zero |
| 8 | `effectiveCrawlLimit(100, 20)` | 100 URLs, 20 credits | `100` | All fit |
| 9 | `effectiveCrawlLimit(200, 10)` | 200 URLs, 10 credits | `50` | Credit-limited |
| 10 | `effectiveCrawlLimit(600, 200)` | 600 URLs, 200 credits | `500` | ABSOLUTE_MAX_PAGES cap |
| 11 | `effectiveCrawlLimit(100, 0)` | 100 URLs, 0 credits | `0` | No credits |
| 12 | `effectiveCrawlLimit(0, 100)` | 0 URLs, 100 credits | `0` | No URLs |

**Coverage target:** 100% of `bulkCreditsRequired()` and `effectiveCrawlLimit()`.

### Test File: `__tests__/per-page-analyzer.test.ts`

Tests for Task 3 per-page analyzer.

**Mock requirements:** None (pure function).

| # | Test Case | Input/Setup | Expected | Edge |
|---|-----------|-------------|----------|------|
| 1 | Page with no H1 | `{ h1: "", headings: [] }` | Vuln: `semantic_html`, severity `high` | |
| 2 | Page with multiple H1 | `{ headings: [{level:1,...}, {level:1,...}] }` | Vuln: `semantic_html`, severity `medium` | |
| 3 | Page with no structured data | `{ hasStructuredData: false, existingSchema: [] }` | Vuln: `structured_data`, severity `high` | |
| 4 | Thin content (<100 chars) | `{ content: "x".repeat(50) }` | Vuln: `content_structure`, severity `critical` | |
| 5 | Thin content (100-300 chars) | `{ content: "x".repeat(200) }` | Vuln: `content_structure`, severity `medium` | |
| 6 | No FAQ on services page | `{ pageType: "services", faqContent: [] }` | Vuln: `faq_coverage` | |
| 7 | FAQ on services page | `{ pageType: "services", faqContent: [{q:"?",a:"a"}] }` | No `faq_coverage` vuln | |
| 8 | No contact on contact page | `{ pageType: "contact", contactInfo: [] }` | Vuln: `contact_trust`, severity `critical` | |
| 9 | No author on blog | `{ pageType: "blog", content: "no author", existingSchema: [] }` | Vuln: `author_authority` | |
| 10 | Blog with author schema | `{ pageType: "blog", existingSchema: ["Person"] }` | No `author_authority` vuln | |
| 11 | Missing title | `{ title: "" }` | Vuln: `metadata_freshness`, severity `critical` | |
| 12 | Healthy page — no vulns | Good page (all fields populated, >300 chars, H1, schema, title) | `vulnerabilities: []`, health `good` | |
| 13 | Health = "poor" | 1 critical vuln | `overallPageHealth: "poor"` | |
| 14 | Health = "needs-work" | 1 high + 2 medium vulns | `overallPageHealth: "needs-work"` | |
| 15 | Scorecard impactedPages correlation | Scorecard with `impactedPages: ["/about"]`, page URL contains `/about` | Vuln from scorecard pillar added | |
| 16 | No duplicate pillar from scorecard | Page already has `semantic_html` vuln + scorecard impactedPages flags same pillar | Only 1 `semantic_html` vuln | |
| 17 | Empty crawlData | `{ pages: [] }` | Returns `[]` | |

**Coverage target:** 95% line coverage for `per-page-analyzer.ts`.

### Test File: `__tests__/report-generator.test.ts`

Tests for Task 3 report generator.

| # | Test Case | Input | Expected | Edge |
|---|-----------|-------|----------|------|
| 1 | Per-page HTML contains title | `{ title: "About Us" }` | HTML includes "About Us" | |
| 2 | Per-page HTML escapes XSS | `{ title: "<script>alert(1)</script>" }` | HTML contains `&lt;script&gt;`, NOT raw `<script>` | Security |
| 3 | Per-page HTML — no vulns | `{ vulnerabilities: [] }` | "No vulnerabilities detected" message | |
| 4 | Per-page HTML — severity badges | 1 critical + 1 low vuln | HTML contains `class="badge critical"` and `class="badge low"` | |
| 5 | Aggregate HTML — score color green | `{ overallScore: 85 }` | `class="score good"` | |
| 6 | Aggregate HTML — score color amber | `{ overallScore: 55 }` | `class="score fair"` | |
| 7 | Aggregate HTML — score color red | `{ overallScore: 30 }` | `class="score poor"` | |
| 8 | Aggregate HTML — health distribution | 2 good, 1 poor | Table shows counts 2 and 1 | |
| 9 | Aggregate HTML — pillar rows sorted | Pillars [80, 30, 60] | HTML rows ordered 30, 60, 80 (ascending) | |
| 10 | Both functions return valid HTML | Any input | Starts with `<!DOCTYPE html>`, ends with `</html>` | |

**Coverage target:** 90% line coverage for `report-generator.ts`.

### Test File: `__tests__/zip-builder.test.ts`

Tests for Task 3 ZIP builder.

**Mock requirements:** None (uses jszip).

| # | Test Case | Input | Expected | Edge |
|---|-----------|-------|----------|------|
| 1 | ZIP contains aggregate-report.html | 1 page | Buffer is valid ZIP, contains `aggregate-report.html` | |
| 2 | ZIP contains pages/ folder | 3 pages | ZIP has `pages/` folder with 3 `.html` files | |
| 3 | Filename sanitization — slashes | URL: `/blog/my-post` | Filename: `blog_my-post.html` | |
| 4 | Filename sanitization — special chars | URL: `/page?q=1&a=2` | Filename: `pageq1a2.html` | |
| 5 | Filename sanitization — root path | URL: `https://example.com/` | Filename: `index.html` | |
| 6 | Filename length cap | 150-char path | Filename <= 104 chars (100 + `.html`) | |
| 7 | ZIP size reasonable | 501 pages | Buffer.length < 5MB | |
| 8 | Empty per-page results | 0 pages | ZIP contains only aggregate-report.html | |

**Validation approach:** Use `JSZip.loadAsync()` to read the generated buffer and verify contents.

**Coverage target:** 90% line coverage for `zip-builder.ts`.

### Test File: `__tests__/bulk-api-sites.test.ts`

Tests for Task 5 POST /api/sites bulk flow.

**Mock requirements:** `db` (drizzle), `sendVerificationEmail`, `nanoid`.

| # | Test Case | Input/Setup | Expected | Edge |
|---|-----------|-------------|----------|------|
| 1 | Valid bulk submit | `{ email, bulkUrls: [10 valid URLs] }`, team exists with 100 credits | 201, site created with `auditMode: "bulk"` | |
| 2 | Empty bulkUrls array | `{ email, bulkUrls: [] }` | 400, "1 to 501 URLs" | |
| 3 | Over 501 URLs | 502-URL array | 400, "1 to 501 URLs" | |
| 4 | Invalid URL in array | Mix of valid + `ftp://invalid` | 400, "X invalid URL(s)" | |
| 5 | SSRF URL (private range) | `["http://192.168.1.1/"]` | 400, "invalid URL(s)" | Security |
| 6 | No team for email | Email not in teamMembers | 402, "Pro account required" | |
| 7 | Insufficient credits | Team has 0 credits | 402, "Pro account required" | |
| 8 | Same error for no-team and no-credits | Both cases | Same 402 message (no enumeration) | Security |
| 9 | Deduplication | 5 duplicate URLs | `bulkUrlCount` = 1, not 5 | |
| 10 | Domain from first URL | `["https://www.example.com/a", "https://other.com/b"]` | `domain: "example.com"` (www stripped) | |
| 11 | Single URL flow unchanged | `{ url, email }` (no bulkUrls) | Existing behavior preserved | Regression |

**Coverage target:** 90% line coverage for bulk path in `sites/route.ts`.

### Test File: `__tests__/bulk-verify.test.ts`

Tests for Task 5 verify route bulk credit reservation.

**Mock requirements:** `db` (drizzle), `startBulkCrawl`, `after`.

| # | Test Case | Input/Setup | Expected | Edge |
|---|-----------|-------------|----------|------|
| 1 | Successful bulk OTP + reservation | Bulk site, team with 100 credits, 50 URLs | Credits deducted, `crawlLimit` set, `startBulkCrawl` called | |
| 2 | Credit reservation amount | 50 URLs, 100 credits | `reservedCredits = 10`, `crawlLimit = 50` | |
| 3 | Credit-limited crawl | 200 URLs, 10 credits | `crawlLimit = 50`, `reservedCredits = 10` | |
| 4 | ABSOLUTE_MAX cap | 600 URLs, 200 credits | `crawlLimit = 500` | |
| 5 | Zero credits at verify | Credits depleted since submit | 402 error | |
| 6 | Transaction atomicity | Any bulk verify | `creditTransactions` row has type `"bulk_crawl_reserve"` | |
| 7 | Pipeline status set to crawling | Any bulk verify | `pipelineStatus: "crawling"` (skip discovery) | |
| 8 | startBulkCrawl called with sliced URLs | 100 URLs, crawlLimit 50 | `startBulkCrawl` called with first 50 URLs | |
| 9 | Single verify unchanged | `auditMode: "single"` site | Existing flow, `startCrawl` called | Regression |

**Coverage target:** 90% line coverage for bulk path in `verify/route.ts`.

### Test File: `__tests__/bulk-download.test.ts`

Tests for Task 5 download-report endpoint.

**Mock requirements:** `db` (drizzle), `buildReportZip`.

| # | Test Case | Input/Setup | Expected | Edge |
|---|-----------|-------------|----------|------|
| 1 | Successful download | Bulk, paid, complete, perPageResults populated | 200, Content-Type: application/zip | |
| 2 | No token | Missing `?token=` | 401 | |
| 3 | Wrong token | Token doesn't match | 401 | |
| 4 | Not a bulk audit | `auditMode: "single"` | 400, "bulk audits" | |
| 5 | No team (free) | `teamId: null` | 402 | |
| 6 | Not complete | `pipelineStatus: "crawling"` | 409 | |
| 7 | No per-page results | `perPageResults: null` | 404 | |
| 8 | Filename sanitization | Domain: `my-site.com` | Content-Disposition includes `my-site.com-geo-audit.zip` | |

**Coverage target:** 90% line coverage for `download-report/route.ts`.

### Test File: `__tests__/bulk-regenerate-block.test.ts`

Tests for Task 5 regenerate blocking.

| # | Test Case | Input/Setup | Expected | Edge |
|---|-----------|-------------|----------|------|
| 1 | Bulk audit blocked | `auditMode: "bulk"` | 400, "cannot be regenerated" | |
| 2 | Single audit unchanged | `auditMode: "single"` | Existing behavior | Regression |

**Coverage target:** 100% of the new guard clause.

---

## d) Integration Test Plan

### Test File: `__tests__/integration/bulk-flow.test.ts`

**End-to-end scenarios testing the complete bulk audit lifecycle.**

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 1 | **Happy path — full bulk flow** | POST /api/sites with 10 bulkUrls → Verify OTP → Credits reserved → startBulkCrawl called → completePipeline produces perPageResults → GET site returns bulk fields → Download ZIP returns valid archive | All steps succeed, credits reconciled |
| 2 | **Credit-limited flow** | 100 URLs, 10 credits → Verify → crawlLimit = 50 → Pipeline completes with 45 pages → Refund issued | `refundCredits = 10 - 9 = 1` credit refunded |
| 3 | **Pipeline failure refund** | Bulk verify → Pipeline fails → Full refund minus pages crawled | Credits restored, `bulk_crawl_refund` transaction logged |
| 4 | **Free user attempt** | POST /api/sites with bulkUrls, email not in any team | 402 at submit, no OTP sent |
| 5 | **Credits depleted between submit and verify** | POST succeeds (100 credits) → User spends credits elsewhere → Verify: 0 credits | 402 at verify |

### Failure Mode Tests

| # | Failure | Expected Behavior |
|---|---------|-------------------|
| 1 | Firecrawl job never completes | Staleness guard in completePipeline marks failed after 15 min, refund issued |
| 2 | All URLs blocked by anti-bot | Pipeline completes with 0 good pages → marks failed → full refund |
| 3 | Database error during credit reservation | Transaction rolls back, no credits deducted, 500 error returned |
| 4 | ZIP generation fails (malformed data) | Download endpoint returns 500, site data unaffected |

---

## e) Profiling Requirements

### What to Measure

| Metric | Where | Baseline | Target |
|--------|-------|----------|--------|
| CSV parse time (client) | `app/page.tsx` CSV handler | — | < 200ms for 501-URL CSV |
| `extractPerPageVulnerabilities()` latency | `per-page-analyzer.ts` | — | < 50ms for 501 pages |
| `buildReportZip()` latency | `zip-builder.ts` | — | < 2s for 501 pages |
| `buildReportZip()` memory | `zip-builder.ts` | — | < 50MB peak |
| POST /api/sites response time (bulk) | `sites/route.ts` | 200ms (single) | < 500ms for 501 URLs (SSRF validation) |
| Verify route transaction time | `verify/route.ts` | 150ms (single) | < 300ms (atomic credit reservation) |
| Download endpoint TTFB | `download-report/route.ts` | — | < 3s for 501 pages |

### How to Measure

- **Client-side:** `performance.now()` around CSV parse logic
- **Server-side:** `console.time()` / `console.timeEnd()` in development; structured log timestamps in production
- **Memory:** Node `process.memoryUsage().heapUsed` before/after ZIP generation
- **E2E:** Chrome DevTools Network tab for download endpoint latency

### When to Profile

- After Task 3 (services) is complete — profile `extractPerPageVulnerabilities()` and `buildReportZip()` with 501-page synthetic data
- After Task 5 (API) is complete — profile download endpoint
- After Task 6 (frontend) is complete — profile CSV parsing

---

## f) Load Test Plan

### Scenarios

| # | Scenario | Params | Success Criteria |
|---|----------|--------|-----------------|
| 1 | Concurrent bulk submits | 10 users submitting 100-URL CSVs simultaneously | p95 < 2s, 0 errors, all OTPs sent |
| 2 | Concurrent verify + reserve | 10 users verifying OTP at the same time | No credit race conditions (sum of deductions matches sum of reservations) |
| 3 | Concurrent ZIP downloads | 20 users downloading ZIP simultaneously | p95 < 5s, no OOM, all ZIPs valid |
| 4 | Firecrawl job saturation | 5 bulk audits × 100 URLs = 500 URLs → 10 Firecrawl jobs × 5 | Firecrawl rate limiting handled gracefully (retry or queue) |

### Resource Consumption Bounds

| Resource | Bound |
|----------|-------|
| Vercel function memory (ZIP generation) | < 256MB per invocation |
| Vercel response body size | < 4.5MB (ZIP ~500KB for 501 pages ✓) |
| Firecrawl concurrent jobs | Monitor against plan limits (hobby: 5 concurrent) |
| Supabase connection pool | No N+1 queries; transaction uses single connection |

### Tool Recommendation

Use `k6` with a script that simulates the full flow: submit → verify → poll → download. Focus on credit consistency under concurrent load.

---

## g) Logging & Instrumentation

### Events to Log

| Event | Level | Fields | When |
|-------|-------|--------|------|
| `bulk_submit` | `info` | `siteId`, `urlCount`, `email` (hashed), `teamId` | POST /api/sites bulk accepted |
| `bulk_submit_rejected` | `warn` | `reason` ("no_team", "insufficient_credits", "invalid_urls"), `urlCount` | POST /api/sites bulk rejected |
| `bulk_credit_reserved` | `info` | `siteId`, `teamId`, `reservedCredits`, `crawlLimit`, `urlCount` | Verify route reserves credits |
| `bulk_crawl_started` | `info` | `siteId`, `urlCount`, `jobCount` | startBulkCrawl fires Firecrawl jobs |
| `bulk_crawl_complete` | `info` | `siteId`, `actualPages`, `reservedCredits`, `actualCredits`, `refundCredits` | completePipeline bulk path |
| `bulk_crawl_failed` | `error` | `siteId`, `error`, `pagesCrawled`, `refundCredits` | Pipeline failure for bulk audit |
| `bulk_credit_refund` | `info` | `siteId`, `teamId`, `refundAmount`, `reason` ("reconciliation" or "failure") | Credit refund issued |
| `bulk_zip_generated` | `info` | `siteId`, `pageCount`, `zipSizeBytes`, `generationMs` | Download endpoint generates ZIP |
| `bulk_csv_parsed` | `info` (client) | `urlCount`, `duplicatesRemoved`, `parseMs` | Client-side CSV parsing complete |

### Metrics to Emit

| Metric | Type | Labels |
|--------|------|--------|
| `bulk_audit_total` | counter | `status` (submitted, verified, completed, failed) |
| `bulk_credits_reserved` | counter | — |
| `bulk_credits_refunded` | counter | `reason` (reconciliation, failure) |
| `bulk_zip_generation_ms` | histogram | — |
| `bulk_pages_crawled` | histogram | — |

### Log Level Guidance

- **Production:** `info` for business events (submit, reserve, complete, refund). `error` for failures.
- **Debug:** `console.log` for per-URL SSRF validation results, Firecrawl job status polling.
- **Implementation:** Use `console.log(JSON.stringify({ event, ...fields }))` format matching existing codebase pattern. No structured logging library required.

---

## h) Acceptance Criteria

### Task 1: Foundation

- [ ] `geoSites` table has 7 new columns: `auditMode`, `bulkUrls`, `bulkUrlCount`, `crawlLimit`, `creditsReserved`, `perPageResults`, `reportZipUrl`
- [ ] `drizzle-kit push` succeeds without errors
- [ ] `lib/config.ts` exports `BULK_MAX_URLS`, `BULK_CREDIT_PRICE_INR`, `ABSOLUTE_MAX_PAGES`
- [ ] `bulkCreditsRequired()` and `effectiveCrawlLimit()` pass all 12 unit tests
- [ ] `jszip` in `package.json` dependencies
- [ ] Existing single-URL flow unchanged (regression check)

### Task 2: Dynamic Crawl Depth (#77)

- [ ] `startCrawl()` propagates `maxPages` to `discoverSite()`
- [ ] Verify route computes `maxPages` from team credit balance
- [ ] Regenerate route passes `PAID_MAX_PAGES` (team) or `FREE_MAX_PAGES` (anonymous)
- [ ] Recrawl cron passes `PAID_MAX_PAGES`
- [ ] Free user gets 20-page crawl; paid user with 5 credits gets 25-page crawl

### Task 3: Backend Services

- [ ] `extractPerPageVulnerabilities()` passes all 17 unit tests
- [ ] `generatePerPageHtml()` and `generateAggregateHtml()` pass all 10 unit tests
- [ ] HTML output is XSS-safe (escapeHtml on all dynamic content)
- [ ] `buildReportZip()` passes all 8 unit tests
- [ ] ZIP for 501 pages generates in < 2s and is < 5MB

### Task 4: Bulk Pipeline

- [ ] `startBulkCrawl()` creates synthetic discoveryData, fires Firecrawl jobs, triggers cron
- [ ] `completePipeline()` bulk branch: calls `extractPerPageVulnerabilities()`, stores `perPageResults`
- [ ] Credit reconciliation: refunds difference when actual < reserved
- [ ] Failure path: refunds credits proportional to pages not crawled
- [ ] `fireBulkFirecrawlJobs()` batches 50/chunk, 10 concurrent

### Task 5: API Layer

- [ ] POST /api/sites accepts `bulkUrls`, validates URLs, SSRF checks, creates bulk site
- [ ] POST /api/sites rejects free users with generic 402 (no enumeration)
- [ ] POST verify: atomic credit reservation + `bulk_crawl_reserve` transaction logged
- [ ] POST verify: `startBulkCrawl` called with `bulkUrls.slice(0, crawlLimit)`
- [ ] GET /api/sites/[id]: returns `auditMode`, `bulkUrlCount`, `perPageResults` (paid only)
- [ ] GET download-report: returns valid ZIP with correct Content-Type and Content-Disposition
- [ ] POST regenerate: returns 400 for bulk audits
- [ ] All 11 bulk-api-sites tests pass, all 9 verify tests pass, all 8 download tests pass

### Task 6: Frontend

- [ ] Authenticated users no longer redirect from landing page to dashboard
- [ ] Credit balance fetched and displayed on CSV upload
- [ ] CSV parsing: extracts first-column URLs, dedupes, validates format, enforces 501 limit
- [ ] Credit-aware pricing: shows crawl limit message for auth users, cost estimate for anon
- [ ] URL field disabled when CSV active
- [ ] Email auto-filled for authenticated users
- [ ] Submit sends `bulkUrls` when CSV active
- [ ] Bulk progress UI: skips discovery stage, shows "Crawling X pages via premium crawler"
- [ ] Download button appears on completed bulk paid audits
- [ ] Regenerate button hidden for bulk audits

---

## Files Summary

| File | Action | Task |
|------|--------|------|
| `lib/db/schema.ts` | MODIFY | 1 |
| `lib/config.ts` | MODIFY | 1 |
| `package.json` | MODIFY (add jszip) | 1 |
| `lib/pipeline/runner.ts` | MODIFY (maxPages + startBulkCrawl + completePipeline) | 2, 4 |
| `lib/services/geo-crawler.ts` | MODIFY (fireBulkFirecrawlJobs) | 4 |
| `lib/services/per-page-analyzer.ts` | CREATE | 3 |
| `lib/services/report-generator.ts` | CREATE | 3 |
| `lib/services/zip-builder.ts` | CREATE | 3 |
| `app/api/sites/route.ts` | MODIFY | 5 |
| `app/api/sites/[id]/verify/route.ts` | MODIFY | 2, 5 |
| `app/api/sites/[id]/route.ts` | MODIFY | 5 |
| `app/api/sites/[id]/regenerate/route.ts` | MODIFY | 2, 5 |
| `app/api/sites/[id]/download-report/route.ts` | CREATE | 5 |
| `app/api/cron/recrawl/route.ts` | MODIFY | 2 |
| `app/page.tsx` | MODIFY | 6 |
| `app/sites/[id]/SitePageClient.tsx` | MODIFY | 6 |
| `app/sites/[id]/ResultsDashboard.tsx` | MODIFY | 6 |
| `__tests__/bulk-config.test.ts` | CREATE | 1 |
| `__tests__/per-page-analyzer.test.ts` | CREATE | 3 |
| `__tests__/report-generator.test.ts` | CREATE | 3 |
| `__tests__/zip-builder.test.ts` | CREATE | 3 |
| `__tests__/bulk-api-sites.test.ts` | CREATE | 5 |
| `__tests__/bulk-verify.test.ts` | CREATE | 5 |
| `__tests__/bulk-download.test.ts` | CREATE | 5 |
| `__tests__/bulk-regenerate-block.test.ts` | CREATE | 5 |
| `__tests__/integration/bulk-flow.test.ts` | CREATE | all |

**Total:** 9 files modified, 12 files created, 5 test files for unit tests, 1 integration test file.
