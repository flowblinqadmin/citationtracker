# TS-002: Bulk CSV URL Audit — Technical Specification

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#82](https://github.com/flowblinqadmin/geo/issues/82) · [#83](https://github.com/flowblinqadmin/geo/issues/83) · [#84](https://github.com/flowblinqadmin/geo/issues/84) · [#85](https://github.com/flowblinqadmin/geo/issues/85) · [#86](https://github.com/flowblinqadmin/geo/issues/86) · [#87](https://github.com/flowblinqadmin/geo/issues/87) · [#88](https://github.com/flowblinqadmin/geo/issues/88)  
> **Delivery Commit:** `2bad500`  

---

## Context

FlowBlinq GEO's landing page (`geo.flowblinq.com`) offers a free single-URL audit. Paid users currently get the same form — there's no differentiated entry point for premium features. This spec adds a **bulk CSV upload** capability visible to all users on the landing page, backend-gated to paid accounts. It's the primary paid-tier differentiator for M2 and a natural upsell path during customer acquisition.

**Branch:** `dev-an-m2-extended` (forked from `main`)
**Integrates:** GitHub issue #77 (dynamic crawl depth based on credits)

---

## Agreed Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| CSV field visibility | Always visible, backend-gated | Zero email enumeration risk |
| CSV scope | Any mix of URLs (multi-domain deferred) | Domain-layer pricing tracked as future GitHub issue |
| Pricing | 1 credit = 5 pages = 20 INR (~$0.20) | Matches Firecrawl per-page cost model |
| Max CSV size | 501 URLs | Hard limit, enforced client + server |
| Crawl depth | Dynamic: `min(csvUrlCount, affordable, ABSOLUTE_MAX_PAGES)` | Per #77 — credits determine crawl ceiling |
| Crawl limit transparency | Computed on CSV load, shown to user before submit | User can edit CSV and re-upload if over limit |
| Crawler for bulk | Firecrawl-only (premium) | Paid tier gets best quality |
| Credit model | Reserve on OTP verification, reconcile on pipeline completion | Per #77 — charge for actual pages crawled, refund unused |
| Per-page reports | HTML vulnerability checklist (not scorecard) | Site-level pillars don't apply per-page |
| Aggregate report | Same 16-pillar scorecard shown on results page | Reuses existing ResultsDashboard |
| Report delivery | ZIP archive (per-page HTML + aggregate HTML) | Download button on results page |
| Report format | Styled standalone HTML | Opens in any browser, professional look |

---

## 1. Database Schema Changes

**File:** `lib/db/schema.ts`

Add to `geoSites` table:

```
auditMode        text    default("single")    — "single" | "bulk"
bulkUrls         jsonb   nullable             — string[] of raw CSV URLs
bulkUrlCount     integer nullable             — denormalized count
crawlLimit       integer nullable             — effective page cap: min(csv, affordable, ABSOLUTE_MAX_PAGES)
creditsReserved  integer nullable             — credits reserved at OTP verification (for reconciliation)
perPageResults   jsonb   nullable             — Array<PerPageResult> (see §5.1)
reportZipUrl     text    nullable             — URL or null (future: Supabase Storage)
```

All columns nullable/defaulted — non-breaking additive migration via `drizzle-kit push`.

---

## 2. Config Changes

**File:** `lib/config.ts`

Add:

```typescript
export const BULK_MAX_URLS = 501;
export const BULK_CREDIT_PRICE_INR = 20;    // 1 credit = 20 INR
export const ABSOLUTE_MAX_PAGES = 500;      // hard system ceiling per #77
```

Reuse existing `PAGES_PER_CREDIT = 5`. Helpers:

```typescript
export function bulkCreditsRequired(urlCount: number): number {
  return Math.ceil(urlCount / PAGES_PER_CREDIT);
}

/** Compute effective crawl limit for a bulk audit per #77 */
export function effectiveCrawlLimit(csvUrlCount: number, creditBalance: number): number {
  const affordable = creditBalance * PAGES_PER_CREDIT;
  return Math.min(csvUrlCount, affordable, ABSOLUTE_MAX_PAGES);
}
```

---

## 3. API Changes

### 3.1 POST `/api/sites` — Accept bulk URLs

**File:** `app/api/sites/route.ts`

Accept `{ url?, email, bulkUrls?: string[] }`. When `bulkUrls` present:

1. Validate: array of valid HTTP/HTTPS URLs, length 1–501, SSRF checks on each
2. Look up team via `teamMembers.email` → `teams.creditBalance`
3. If no team OR insufficient credits → generic error: *"Bulk audit requires a Pro account with sufficient credits."* (same message regardless — no enumeration)
4. Create `geoSites` row with `auditMode: "bulk"`, `bulkUrls`, `bulkUrlCount`, `domain` from first URL
5. Send OTP as usual

If `bulkUrls` not present → existing single-URL flow unchanged.

### 3.2 POST `/api/sites/[id]/verify` — Bulk credit reservation + pipeline

**File:** `app/api/sites/[id]/verify/route.ts`

After successful OTP, add bulk branch:

1. Re-check team + credits (may have changed since submit)
2. Compute `crawlLimit = effectiveCrawlLimit(bulkUrls.length, creditBalance)`
3. Compute `reservedCredits = bulkCreditsRequired(crawlLimit)`
4. **Atomic transaction:** reserve credits (deduct `reservedCredits`), insert `creditTransactions` (type: `"bulk_crawl_reserve"`, `pagesConsumed: crawlLimit`), update site status to `"crawling"` (skip discovery), store `crawlLimit` on site record
5. Call `startBulkCrawl(id, domain, bulkUrls.slice(0, crawlLimit))` via `after()`

### 3.3 Credit reconciliation on pipeline completion

**File:** `lib/pipeline/runner.ts` (in `completePipeline`)

After pipeline completes for a bulk audit:
1. Count `actualPagesCrawled` from merged crawl data (some pages may have failed/blocked)
2. Compute `actualCredits = bulkCreditsRequired(actualPagesCrawled)`
3. If `actualCredits < reservedCredits`: refund difference via `creditTransactions` (type: `"bulk_crawl_refund"`)
4. Update `creditTransactions` original reserve row with final `pagesConsumed = actualPagesCrawled`

This ensures users are charged for actual pages crawled, not the CSV size.

### 3.4 GET `/api/sites/[id]` — Return bulk fields

**File:** `app/api/sites/[id]/route.ts`

For bulk audits, add to response:
- `auditMode`, `bulkUrlCount`
- `perPageResults` (paid only, null for free)
- `reportZipUrl` (paid only, null for free)

### 3.5 NEW: GET `/api/sites/[id]/download-report`

**File:** `app/api/sites/[id]/download-report/route.ts`

- Auth via `?token=` (same as existing site access)
- Verify bulk audit + paid tier
- Generate ZIP on-the-fly (per-page HTML + aggregate HTML)
- Return as `application/zip` with `Content-Disposition: attachment`
- Future optimization: cache in Supabase Storage, store URL in `reportZipUrl`

---

## 4. Pipeline Changes

### 4.1 Dynamic crawl depth for single audits (Issue #77)

**Files:** `lib/pipeline/runner.ts`, `lib/services/geo-crawler.ts`

Modify `startCrawl()` and `runPipeline()` to accept `maxPages` parameter:

```typescript
export async function startCrawl(siteId: string, domain: string, maxPages?: number): Promise<void>
```

Callers (`app/api/sites/[id]/verify/route.ts`, `app/api/sites/[id]/regenerate/route.ts`) compute `maxPages` before calling:
- Look up `team.creditBalance`
- `maxPages = creditBalance > 0 ? Math.min(creditBalance * PAGES_PER_CREDIT, ABSOLUTE_MAX_PAGES) : FREE_MAX_PAGES`

Propagate `maxPages` through: `discoverSite()` → `jinaPass()` → `fireFirecrawlJobs()`.

### 4.2 New: `startBulkCrawl()` in `lib/pipeline/runner.ts`

Bulk equivalent of `startCrawl()`. Key differences:
- **No discovery phase** — user provided URLs, build synthetic `discoveryData` from CSV
- **Firecrawl-only** — all URLs go through Firecrawl async jobs (no Jina)
- **Accepts `crawlLimit`** — only processes first `crawlLimit` URLs from the CSV (already sliced by verify route)
- **Batch chunking** — 50 URLs per batch, up to 10 concurrent (vs 5 for single audit)
- Sets `pipelineStatus: "crawling"` directly
- Self-triggers `/api/cron/process-queue` for Phase 2

### 4.3 Modify `completePipeline()` in `lib/pipeline/runner.ts`

After existing analysis + generation + assembly steps:

1. If `auditMode === "bulk"`: call `extractPerPageVulnerabilities()` → store in `perPageResults`
2. **Credit reconciliation:** count actual pages crawled vs reserved credits, refund difference (see §3.3)
3. ZIP generation deferred to download endpoint (on-demand)

The existing Gemini analysis, content generation, and assembly steps work unchanged — they already process all crawled pages as a batch and produce a site-level scorecard.

### 4.4 Single-audit credit deduction change (Issue #77)

For non-bulk (single) audits, also switch to actual-usage billing:
- After pipeline completes, compute `actualCredits = Math.ceil(actualPagesCrawled / PAGES_PER_CREDIT)`
- Deduct `actualCredits` instead of flat `PAID_CRAWL_CREDIT_COST = 20`
- Log `pagesConsumed = actualPagesCrawled` in `creditTransactions`

---

## 5. New Modules

### 5.1 Per-Page Vulnerability Extractor

**File:** `lib/services/per-page-analyzer.ts` (NEW)

**Rule-based, not LLM-powered** — fast and cost-free.

Takes `crawlData` + `geoScorecard` → produces per-page vulnerability checklists.

Per-page checks:
- Missing/multiple H1 → `semantic_html`
- No structured data → `structured_data`
- Thin content (<300 chars) → `content_structure`
- No FAQ on content pages → `faq_coverage`
- No contact info on key pages → `contact_trust`
- No author signals → `author_authority`
- Missing meta/title → `metadata_freshness`
- Correlation from `scorecard.pillars[].impactedPages`

Output type:
```typescript
interface PerPageResult {
  url: string;
  pageType: string;
  title: string;
  vulnerabilities: PerPageVulnerability[];
  overallPageHealth: "good" | "needs-work" | "poor";
}

interface PerPageVulnerability {
  pillar: string;
  pillarName: string;
  severity: "critical" | "high" | "medium" | "low";
  finding: string;
  recommendation: string;
}
```

### 5.2 HTML Report Generator

**File:** `lib/services/report-generator.ts` (NEW)

Two functions:
- `generatePerPageHtml(result, domain)` → standalone HTML per page (styled, ~5KB each)
- `generateAggregateHtml(site, perPageResults)` → summary HTML with scorecard table, executive summary, page health distribution, top recommendations

Minimal inline CSS, no external dependencies. Professional look matching GEO brand (dark theme).

### 5.3 ZIP Builder

**File:** `lib/services/zip-builder.ts` (NEW)

**New dependency:** `jszip` (~90KB, Vercel-compatible)

Structure:
```
{domain}-geo-audit.zip
├── aggregate-report.html
└── pages/
    ├── about.html
    ├── pricing.html
    ├── blog_post-title.html
    └── ...
```

501 pages × ~5KB each = ~2.5MB uncompressed, ~500KB compressed. Generates in <2s.

---

## 6. Frontend Changes

### 6.1 Landing Page (`app/page.tsx`)

#### Auth-aware page load

Currently, authenticated users redirect to `/dashboard`. Change this:
- On page load, check Supabase session via `createClient().auth.getUser()`
- If authenticated: **do NOT redirect**. Instead, fetch credits via `GET /api/teams/me` and store `{ creditBalance, email }` in state
- If not authenticated: proceed as today (anonymous flow)

This allows paid users to use the landing page for bulk audits while keeping the marketing-first feel intact.

#### CSV upload with credit-aware transparency

Add below URL field, above submit button:

1. **CSV upload input** — always visible, dashed border, "Pro: Bulk URL Audit — Upload CSV with up to 501 URLs"
2. **Client-side CSV parsing** — extract URLs from first column, dedupe, validate format, enforce 501 limit
3. **Credit-aware pricing display on CSV load:**
   - **If authenticated (credits known):** Compute `crawlLimit = min(urlCount, creditBalance * 5, 500)` client-side. Show:
     - If all URLs fit: *"247 URLs detected — 50 credits required (₹1,000). All URLs will be processed."*
     - If credit-limited: *"247 URLs detected but your account has 20 credits (100 pages). 100 of 247 URLs will be processed. [Buy more credits](/pricing) or reduce your CSV."*
     - If over ABSOLUTE_MAX: *"520 URLs detected — max 500 per audit. First 500 will be processed (100 credits, ₹2,000)."*
   - **If not authenticated:** Show cost estimate only: *"247 URLs detected → 50 credits (₹1,000). [Sign in](/auth/login) to see your credit limit."*
4. **URL field auto-disable** — when CSV attached, URL field greys out (CSV takes precedence)
5. **Remove button** — clear CSV and re-enable URL field
6. **Email field auto-fill** — if authenticated, pre-fill email from session
7. **Modified submit** — send `{ email, bulkUrls }` instead of `{ url, email }` when CSV active

Tagline update: *"Free. No credit card. Results in ~3 minutes."* → conditionally show *"Pro feature — credits required"* when CSV is attached.

### 6.2 Progress UI (`app/sites/[id]/SitePageClient.tsx`)

- Skip "discovery" stage for `auditMode === "bulk"`
- Show URL count from `bulkUrlCount` in crawling progress bar
- Label: "Crawling X pages via premium crawler..."

### 6.3 Results Dashboard (`app/sites/[id]/ResultsDashboard.tsx`)

- **Download button** — "Download Full Report (ZIP)" for bulk paid audits
- Triggers GET `/api/sites/[id]/download-report?token=...`
- Aggregate scorecard displays as-is (no changes to existing rendering)

---

## 7. Implementation Sequence

| Phase | What | Files |
|-------|------|-------|
| **1. Foundation** | Schema columns + config + `jszip` dep | `lib/db/schema.ts`, `lib/config.ts`, `package.json` |
| **2. Pipeline (#77)** | Dynamic `maxPages` in `startCrawl`, propagate through crawler | `lib/pipeline/runner.ts`, `lib/services/geo-crawler.ts` |
| **3. Backend services** | Per-page analyzer, report generator, zip builder | `lib/services/per-page-analyzer.ts`, `lib/services/report-generator.ts`, `lib/services/zip-builder.ts` |
| **4. Pipeline (bulk)** | `startBulkCrawl()` + bulk post-processing + credit reconciliation in `completePipeline()` | `lib/pipeline/runner.ts` |
| **5. API layer** | Modify POST /api/sites, verify route (reservation), GET site route, new download endpoint | `app/api/sites/route.ts`, `app/api/sites/[id]/verify/route.ts`, `app/api/sites/[id]/regenerate/route.ts`, `app/api/sites/[id]/route.ts`, `app/api/sites/[id]/download-report/route.ts` |
| **6. Frontend** | Auth-aware landing page, CSV upload with credit transparency, progress UI, download button | `app/page.tsx`, `app/sites/[id]/SitePageClient.tsx`, `app/sites/[id]/ResultsDashboard.tsx` |

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| 501 URLs hits Firecrawl rate limits | Batch 50/chunk, max 10 concurrent. Monitor usage. |
| Gemini context overflow with 501 pages | Flash handles 1M tokens, Pro 2M. 501 pages × ~2KB ≈ 250K tokens — within budget. |
| Vercel function timeout on large crawls | `startBulkCrawl` only fires async jobs (~instant). `completePipeline` runs via 1-min cron. |
| Credit race condition | Reserve-then-reconcile model. Atomic reservation on OTP, refund on completion. |
| Refund edge case (pipeline fails mid-crawl) | On `pipelineStatus: "failed"`, refund full reserved amount minus any pages already crawled. |
| ZIP generation slow for max URLs | ~500KB compressed, <2s generation. On-demand, not pre-generated. |
| Authenticated user on landing page sees stale credits | Fetch credits on page load + on CSV upload. Credits are live from `/api/teams/me`. |

---

## 9. Deferred (GitHub Issues to Create)

1. **M2: Domain-layer pricing** — charge per unique domain in CSV (different cost for multi-domain vs single-domain bulk audits). Currently all URLs priced uniformly at 1 credit / 5 pages.
2. **M2: Supabase Storage for ZIP caching** — pre-generate and cache ZIP on pipeline completion instead of on-demand generation.
3. **M2: Per-page expandable view in ResultsDashboard** — inline vulnerability details per page on the results page (complement to ZIP download).

---

## 10. Verification Plan

1. **Unit tests:** Per-page analyzer (rule checks), zip builder (file structure), credit calculation, `effectiveCrawlLimit()`, `bulkCreditsRequired()`
2. **Integration test:** Full bulk flow — CSV submit → OTP → credit reservation → pipeline → per-page results → credit reconciliation → zip download
3. **Credit reconciliation tests:** Verify refund when actual < reserved, no refund when actual == reserved, full refund on pipeline failure
4. **Dynamic depth tests (single audit):** Verify `maxPages` scales with credit balance — 5 credits → 25 pages, 200 credits → 500 pages (capped at ABSOLUTE_MAX_PAGES)
5. **CSV load transparency tests:** Authenticated user sees crawl limit on CSV upload, unauthenticated user sees cost estimate + sign-in prompt
6. **Manual test:** Upload a 10-URL CSV on landing page while logged in, verify credit-aware pricing display, submit, verify OTP, watch pipeline progress, download ZIP, inspect HTML reports
7. **Edge cases:** Empty CSV, 501 URLs, duplicate URLs, mixed domains, non-paid user attempting bulk, insufficient credits, expired OTP, CSV exceeds affordable limit (user sees warning), pipeline fails mid-crawl (refund issued)
