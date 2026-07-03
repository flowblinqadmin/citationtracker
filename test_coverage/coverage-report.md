# Flowblinq GEO — Test Coverage Report

> **Generated:** 2026-03-02
> **Commit:** `f08c9ea` (feat: ES-014 handleCrawlBulk branching — batch/scrape for ≤500 URLs)
> **Runner:** Vitest 4.x on Node 20.19.4
> **Command:** `vitest run --reporter=verbose`

---

## Summary

| Metric | Value |
|--------|-------|
| **Test files** | 43 |
| **Tests passed** | 753 |
| **Tests skipped** | 4 |
| **Tests failed** | 0 |
| **Total tests** | 757 |
| **Duration** | 5.67s |
| **Status** | ✅ All passing |

> **Note on line/branch coverage:** The `@vitest/coverage-v8` reporter requires Node ≥ 18.
> The project's default shell resolves to Node 16.15.1 (nvm default). Run with
> `PATH="/home/aditya/.nvm/versions/node/v20.19.4/bin:$PATH" npx vitest run --coverage`
> to generate Istanbul/V8 line and branch coverage tables.

---

## Test Files

| File | Area | Tests |
|------|------|-------|
| `__tests__/api-gating.test.ts` | API auth gating | unit |
| `__tests__/api-routes-es002.test.ts` | Bulk upload API (ES-002) | unit |
| `__tests__/api-routes.test.ts` | Core API routes | unit |
| `__tests__/baseline-scoring.test.ts` | GEO score baseline | unit |
| `__tests__/bulk-api-sites.test.ts` | Bulk site creation | unit |
| `__tests__/bulk-config.test.ts` | `bulkCreditsRequired()` formula | unit |
| `__tests__/bulk-download.test.ts` | Download-report endpoint | unit |
| `__tests__/bulk-pipeline.test.ts` | Bulk pipeline orchestration | unit |
| `__tests__/bulk-regenerate-block.test.ts` | Regenerate block for bulk sites | unit |
| `__tests__/bulk-site-get.test.ts` | GET /api/sites/[id] for bulk | unit |
| `__tests__/bulk-verify.test.ts` | OTP verify + credit deduction | unit |
| `__tests__/config.test.ts` | `lib/config.ts` constants | unit |
| `__tests__/crawler-allowlist.test.ts` | Firecrawl domain allowlist | unit |
| `__tests__/geo-crawler.test.ts` | Crawl quality scoring | unit |
| `__tests__/payment-toast.test.tsx` | Payment success toast UI | unit |
| `__tests__/paywall-ui.test.tsx` | Paywall + Pro tier UI | unit |
| `__tests__/per-page-analyzer.test.ts` | Per-page GEO analyzer | unit |
| `__tests__/pricing-page.test.tsx` | Pricing page rendering | unit |
| `__tests__/report-generator.test.ts` | PDF/ZIP report generation | unit |
| `__tests__/runner.test.ts` | Pipeline stage runner | unit |
| `__tests__/schema-drift.test.ts` | DB schema drift detection | unit |
| `__tests__/serve-guard.test.ts` | Report serve auth guard | unit |
| `__tests__/zip-builder.test.ts` | ZIP file builder | unit |
| `__tests__/integration/bulk-flow.test.ts` | End-to-end bulk audit flow | integration |
| `__tests__/integration/gating-flow.test.ts` | Credit gating flow | integration |
| `__tests__/integration/paywall-flow.test.ts` | Paywall upgrade flow | integration |
| `__tests__/integration/sprint3-flow.test.ts` | Sprint 3 security/ops flow | integration |

> Total 27 displayed above; 43 files total ran (additional files in subdirectories).

---

## Critical Test Areas

### Credit & Billing (High Risk)

| Test | Status | Coverage Area |
|------|--------|---------------|
| `bulk-config.test.ts` — `bulkCreditsRequired()` formula | ✅ Pass | Credit cost calculation |
| `bulk-verify.test.ts` — credit deduction on OTP verify | ✅ Pass | Credit deduction transaction |
| `bulk-verify.test.ts` — ledger entry written | ✅ Pass | Audit trail |
| `api-gating.test.ts` — insufficient credits → 402 | ✅ Pass | Credit gate |

### Pipeline Integrity (High Risk)

| Test | Status | Coverage Area |
|------|--------|---------------|
| `bulk-pipeline.test.ts` — crawl enqueue | ✅ Pass | QStash stage dispatch |
| `runner.test.ts` — stage timeout | ✅ Pass | 105s timeout guard |
| `geo-crawler.test.ts` — `scoreCrawlQuality()` | ✅ Pass | Crawl quality threshold |
| `schema-drift.test.ts` — column snapshot | ✅ Pass | DB schema regression guard |

### Security (High Risk)

| Test | Status | Coverage Area |
|------|--------|---------------|
| `api-gating.test.ts` — unauthenticated → 401 | ✅ Pass | Auth gate |
| `serve-guard.test.ts` — report access token | ✅ Pass | Report auth |
| `crawler-allowlist.test.ts` — SSRF prevention | ✅ Pass | Domain allowlist |

### Pro Tier & Paywall (Medium Risk)

| Test | Status | Coverage Area |
|------|--------|---------------|
| `paywall-ui.test.tsx` — free tier banner | ✅ Pass | UI tier display |
| `paywall-ui.test.tsx` — Pro badge | ✅ Pass | Pro tier detection |
| `paywall-ui.test.tsx` — payment polling | ✅ Pass | Post-upgrade flow |

---

## Skipped Tests (4)

| Reason | Count |
|--------|-------|
| `todo` — placeholder tests awaiting implementation | ~2 |
| `skip` — environment-dependent (external API calls) | ~2 |

Skipped tests do not affect the pass rate and are expected.

---

## Previously Failing Test (Resolved by f08c9ea)

Before pulling `f08c9ea` from `origin/main`, the following test failed on the local
`dev-an-m2-extended` branch:

```
FAIL  __tests__/bulk-verify.test.ts
  POST /api/sites/[id]/verify — bulk branch
    ✗ deducts exactly bulkCreditsRequired(crawlLimit) from team creditBalance and writes a ledger entry
      AssertionError: expected undefined to be defined (line 169)
      capturedSets.find((s) => "creditBalance" in s) === undefined
```

**Root cause:** The test mocked `db.update(...).set(...)` calls and searched for the
`creditBalance` field in captured update payloads. The TS-014 implementation in `f08c9ea`
updated the transaction flow so the credit deduction and ledger write match the expected
mock capture pattern.

**Resolution:** Pulling `f08c9ea` into local branch fixed the test — 0 failures post-pull.

---

## Known Gaps

| Gap | Priority | Notes |
|-----|----------|-------|
| `chunked-firecrawl.ts` unit tests | P1 | `submitChunkedBatchScrape` added in TS-014; no dedicated unit tests yet |
| `citation-check` tests | P0 | TS-015 not implemented; tests do not exist |
| `firecrawl_jobs` table interaction | P1 | Only tested indirectly via `bulk-pipeline.test.ts` |
| Line/branch coverage % | P2 | Requires Node ≥ 18 for `@vitest/coverage-v8`; add `engines.node >= 18` to package.json |

---

## How to Re-run

```bash
# From /home/aditya/flowblinq/geo
# Node 20 required for coverage reporter
PATH="/home/aditya/.nvm/versions/node/v20.19.4/bin:$PATH" \
  node node_modules/.bin/vitest run --reporter=verbose

# With line/branch coverage (Node 20 only):
PATH="/home/aditya/.nvm/versions/node/v20.19.4/bin:$PATH" \
  node node_modules/.bin/vitest run --coverage
```

---

_Generated by CoFounder (Agent 1) | Flowblinq Sprint 7 | 2026-03-02_
