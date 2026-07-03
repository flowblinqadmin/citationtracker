# TS-bulk-url-fields-audit — Lifecycle survey of bulk-URL state

**Status:** Documentation + DEFERRED rename plan stub.
**Parent:** ES-B9 §d.1 (regenerate-mode-matrix, B9.2 amendment 2026-04-27).
**Owning agent:** SpecMaster (this doc) + ScriptDev (if rename plan promoted).
**Time-box:** SpecMaster 30 min — survey + duplication verdict, no source-code edits.
**Hard pin:** **DO NOT RENAME any DB columns or jsonb keys.** This is a survey + DEFERRED stub only.

---

## 1. Why this exists

ES-B9 §d.1 surfaced that `/api/sites/[id]/regenerate` hardcodes a 400 on bulk audits because it predates the `bulk_urls` jsonb column. Before authoring the regenerate-bulk-aware impl, SpecMaster surveyed the bulk-URL state surface to confirm there are no overlapping or contradictory fields that would make the impl ambiguous.

This document captures that survey.

---

## 2. Field inventory (verified against branch tip `03ab608` of `lib/db/schema.ts`)

### 2.1 Top-level columns on `geoSites`

| Field (drizzle) | DB column | Type | Schema:line | Source-of-truth role | Lifecycle |
|---|---|---|---|---|---|
| `bulkUrls` | `bulk_urls` | `jsonb` (`string[]`) | 145 | **Input set** — raw CSV URLs as submitted by the user | **Written:** at create-time on bulk POST `/api/sites` (and on bulk retry-spawn, `retry-failed/route.ts:172`). **Read:** by stage post-processing (`stage/route.ts:1070`), by `retry-failed` fallback (`retry-failed/route.ts:71-72` via `originalUrlSet` per Shastri evidence). **Never mutated after create.** |
| `bulkUrlCount` | `bulk_url_count` | `integer` | 146 | **Denormalized count** of `bulkUrls.length` | **Written:** at create-time alongside `bulkUrls`. **Read:** UI render (`SitePageClient.tsx:1434`, `ResultsDashboardLegacy.tsx:1770`). Convenience for non-jsonb sort/filter on dashboard rows. |
| `crawlLimit` | `crawl_limit` | `integer` | 147 | **Effective page cap** = `min(csvUrlCount, affordable, ABSOLUTE_MAX_PAGES)` from `effectiveCrawlLimit(...)` | **Written:** at create-time (and retry-spawn) based on team credit balance. **Read:** by stage post-processing (`stage/route.ts:1071`) to slice `bulkUrls` into `urlsAttempted` vs `creditLimitedUrls`. |
| `autoDiscoveredUrlCount` | `auto_discovered_url_count` | `integer` | 151 | **Counter** of brand-level URLs auto-discovered beyond the user CSV (ES-083 AC-8) | **Written:** by ES-083 brand-page discovery pre-crawl. **Read:** informational only — does NOT count against `bulk_url_count` credit budget per AC-6/AC-7. No interaction with regenerate/retry semantics. |
| `creditsReserved` | `credits_reserved` | `integer` | 152 | Credits reserved at OTP-verification (or fast-path) for the audit; reconciled against actuals at merge-crawl | **Written:** at create. **Read:** at merge-crawl reconciliation (`stage/route.ts:1080`) to compute refund delta. |
| `crawlFailedUrls` | `crawl_failed_urls` | `jsonb` (`string[]`) | 207 | **Intermediate accumulator** — Firecrawl per-job failed URLs reported via webhook | **Written:** by `app/api/pipeline/crawl-webhook/route.ts:36` (COALESCE-append) and `stage/route.ts:489` during fan-out submission. **Read:** by stage merge-crawl logic. **Distinct from `crawlData.failedUrls`** (see §3 duplication discussion). |

### 2.2 Inside the `crawlData` jsonb blob (top-level column `crawl_data`, schema:112)

The jsonb has no schema-level type guarantees. Keys observed in source:

| jsonb key | Source-of-truth role | Lifecycle |
|---|---|---|
| `crawlData.pages` | Final per-page crawl results (after merge) | **Written:** at merge-crawl (`stage/route.ts:1066+`). **Read:** by analyzer, perPageResults, UI. |
| `crawlData.failedUrls` | **Final classified set** of bulk URLs that were attempted but blocked/errored — `urlsAttempted.filter(!crawledUrlSet.has)` | **Written:** post-merge-crawl at `stage/route.ts:1074-1076` (computed inline, then merged into `crawlData` via `crawlDataWithFailed`). **Read:** by `retry-failed/route.ts:71-72`, UI bulk results card. |
| `crawlData.creditLimitedUrls` | **Final classified set** of bulk URLs **never attempted** because they fell beyond `crawlLimit` — `bulkUrls.slice(crawlLimit)` | **Written:** post-merge-crawl at `stage/route.ts:1075`. **Read:** UI (`SitePageClient.tsx:1433`, `ResultsDashboardLegacy.tsx:1769`), `bulk-retry.ts:32` helper. |

### 2.3 `submittedUrls` — DOES NOT EXIST

The dispatch listed `crawlData.submittedUrls` in the survey scope. **Verified absent:** `grep -rn "submittedUrls" lib app --include="*.ts*"` returns zero matches. The semantic that name suggests is fully captured by `urlsAttempted = bulkUrls.slice(0, crawlLimit)` computed inline at `stage/route.ts:1072` — never persisted as a distinct field. No action required; flag for dispatch-list-cleanup only.

---

## 3. Duplication / rename verdict — **NO RENAME PROPOSED**

### 3.1 Two `failedUrls`-named surfaces — analysis

There are *two* fields whose names contain "failed urls":

- `geoSites.crawlFailedUrls` (top-level column `crawl_failed_urls`, jsonb, schema:207) — **intermediate accumulator** during fan-out crawl. Appended to as Firecrawl webhooks fire per chunk.
- `crawlData.failedUrls` (jsonb key inside `crawl_data` column) — **final classified set** computed once at merge-crawl post-processing.

**These are NOT duplicates.** Lifecycles are distinct:

| Aspect | `crawl_failed_urls` (top-level) | `crawlData.failedUrls` (inside jsonb) |
|---|---|---|
| Phase populated | During crawl fan-out (each Firecrawl job webhook) | Once at merge-crawl post-processing |
| Append vs overwrite | COALESCE-append (`app/api/pipeline/crawl-webhook/route.ts:36`) | Single write of computed set |
| Source of truth for "what to retry" | NO — superseded once merge runs | YES — what `/retry-failed` reads |
| Cleared on regenerate | YES — `stage/route.ts:415` resets to null | Implicitly replaced when `crawlData` is overwritten on next pipeline run |

**Verdict:** semantically distinct, naming overlap is regrettable but not load-bearing. A rename of `crawl_failed_urls` → `crawl_failed_urls_intermediate` (or symmetric) would clarify but requires:
- DB migration with backfill (data preservation across rename).
- Source migration in 4 reader/writer sites (`crawl-webhook`, `stage:415,489,508`).
- Test fixtures + IT updates.

**Cost ≈ 3-4h ScriptDev time.** Benefit ≈ marginal readability win. **Not worth doing now** — defer until a separate refactor sprint.

### 3.2 Other potential overlaps — ruled out

- `bulkUrls` vs `bulkUrlCount`: not a duplicate — count is a denormalized convenience for non-jsonb-aware queries (dashboard sort/filter). Drop the count and you force every dashboard list query to deserialize jsonb. Keep both.
- `bulkUrls` vs `crawlData.failedUrls`: not a duplicate — input set vs output classification.
- `crawlLimit` vs `effectiveCrawlLimit(...)` call result: column persists the value computed by the fn at create-time so post-merge reconciliation can re-derive `urlsAttempted` without re-calling the fn. Keep.

### 3.3 Documentation-only output is the verdict

No DEFERRED rename TS stub authored — the `crawl_failed_urls` vs `crawlData.failedUrls` naming overlap is the only candidate, and it's not strong enough to justify even a deferred-stub commitment. If it bites readers in code review, file a follow-up TS at that point with concrete reader confusion as evidence.

---

## 4. Field-lifecycle reference for ES-B9.2 regenerate-bulk-aware impl

When ScriptDev (or a future SpecMaster authoring B9.2 ES) implements regenerate-bulk-aware semantics per ES-B9 §d.1, this is the lifecycle they MUST respect:

1. **Read** `site.bulkUrls` as the URL set (NOT `crawlData.failedUrls` — that's `/retry-failed`'s domain).
2. **Re-derive** `crawlLimit = effectiveCrawlLimit(bulkUrls.length, team.creditBalance)` against current credit balance (not the stale `site.crawlLimit` from prior run).
3. **Charge** `bulkCreditsRequired(crawlLimit)` credits with `bulk_crawl_reserve` ledger row (NOT γ free path — see ES-B9 §d.1 mode matrix).
4. **Reset** intermediate accumulator: `crawlFailedUrls: null` (mirror existing reset at `stage/route.ts:415`).
5. **Update** `crawlLimit` column with the re-derived value.
6. **Update** `creditsReserved` with the new charge.
7. **Re-enqueue** `crawl-fanout` stage (NOT `discover` — bulk URLs are already known; no discovery needed).
8. **Preserve** `bulkUrls` and `bulkUrlCount` (input set is invariant).
9. **Preserve** `autoDiscoveredUrlCount` (informational, not consumed by retry/regenerate logic).

Single-audit regenerate (the existing `/regenerate` happy path before the bulk-block guard) continues to work via `site.creditBalance * PAGES_PER_CREDIT` capped at `PAID_MAX_PAGES` per ES-B7 unified `resolveFirstAuditMaxPages` helper. Bulk and single share the route entry but diverge after the `auditMode` branch.

---

## 5. Rename plan — DEFERRED (per §3 verdict)

No rename plan to author. If telemetry ever shows reader confusion between `crawl_failed_urls` (top-level) and `crawlData.failedUrls` (jsonb), promote a new TS at that time with the concrete confusion as evidence.

---

## 6. SpecMaster sign-off

- Field inventory complete: 6 top-level columns + 3 jsonb keys + 1 dispatch-list non-existent (`submittedUrls`) flagged.
- Duplication verdict: NO rename — `crawl_failed_urls` vs `crawlData.failedUrls` are semantically distinct (intermediate vs final).
- Documentation-only output is valid per dispatch §AC-B9.2-8 trailing clause.
- Time-boxed: completed in <30 min SM effort; no surface for deeper investigation.
