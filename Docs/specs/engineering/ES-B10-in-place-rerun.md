# ES-B10 — In-place rerun architecture (single + bulk; reverts spawn pattern)

**Branch:** `fix/b10-in-place-rerun`
**Base:** `c9e21ce` (post-B9.3 merge on `e2e-comprehensive-suite`)
**Pivot:** `waves-1to6-cd-pivot-2026-04-26` — Vitest GREEN + Docker CI GREEN gate, NO Playwright per-spec.
**Source of truth:** `/tmp/b10-dispatch.json` `.payload.acceptance_criteria` (15 ACs verbatim — Shastri corr `b10-in-place-rerun-2026-04-27`).
**Supersedes:** spawn pattern from B9 (`/retry-failed`), B9.2 (`/regenerate` bulk), B9.3 (spawn-navigation client helper).

---

## a) Overview — architectural reversal rationale

Aditya pushed back on the spawn-on-rerun pattern after B9.3 UAT surfaced two distinct user-symptoms ("Invalid access token" on site-page, silent exit on dashboard). Architecture review surfaced a load-bearing observation: **stages 3-10 of the pipeline are mode-agnostic; only 3 deterministic divergence points exist** (`handleDiscover` skip for bulk-init; `handleCrawlFanout` URL-source branch; `handleAssemble` bulk credit refund). The spawn pattern is *independent of mode and tier* and can be reverted to in-place without touching the stage chain.

The existing schema already supports in-place rerun:

- `geoSites.baselineScorecard` (jsonb) — locked first-run anchor, written once at first analyze (`stage/route.ts:767-770`).
- `geoSites.previousRunSnapshot` (jsonb) — last-run stash, single-overwrite.
- `geoSites.manualRunsThisMonth` + `geoSites.freeRunNumber` — run counters.

**Spawn was a later choice, not an original constraint.** The 12 referencing tables (`chatbot_logs`, `citation_check_responses`, `citation_check_scores`, `credit_transactions`, `exchange_codes`, `firecrawl_jobs`, `geo_crawl_logs`, `geo_page_views`, `geo_site_view`, `geo_sites.parent_site_id`, `team_domains`, etc.) all keep their references valid under in-place; spawn was duplicating site rows AND leaving stale references.

B10 reverts to in-place with three new schema columns (`currentRunNumber`, `currentRunKind`, `retrySubsetUrls`), a relaxed pipeline state machine (`complete→queued`, `failed→queued` allowed), and QStash-stage idempotency keyed on `runNumber`.

**Multi-run history beyond `previousRunSnapshot` (i.e. an `audit_runs` sub-table) is explicitly OUT of scope** — the existing single-overwrite snapshot pattern is preserved as-is.

---

## b) Acceptance criteria (15, verbatim from `/tmp/b10-dispatch.json`)

| ID | Criterion |
|---|---|
| **AC-B10-1** | `app/api/sites/route.ts` bulk-init path (around line 198) — change `enqueueStage` from `stage='discover'` to `stage='crawl-fanout'`. Single-init path unchanged. Vitest UT pinning the bulk-init enqueue stage. *(Removes wasted `discover` stage that `handleCrawlFanout` ignores for bulk anyway.)* |
| **AC-B10-2** | `app/api/sites/[id]/regenerate/route.ts` — REPLACE the bulk INSERT(geoSites) block (lines ~119-188) with an UPDATE on the **same** `siteId`. Update fields: `pipelineStatus='queued'`, `currentRunNumber = site.currentRunNumber + 1`, `currentRunKind='regenerate'`, `accessToken` rotated via `buildRegeneratePatch`, `previousRunSnapshot = stashed-prior-state`, **reset** `crawlData/failedUrls/creditLimitedUrls/geoScorecard/recommendations` to null, **do NOT touch** `baselineScorecard`. Then `enqueueStage` on SAME `siteId`, `stage='crawl-fanout'` for bulk OR `stage='discover'` for single. Single-audit INSERT(geoSites) block also reverts to UPDATE — same pattern. Mirror `credit_transactions` ledger row (write to existing `siteId`, NOT `newSiteId`). **DO NOT spawn a new geoSites row in either branch.** |
| **AC-B10-3** | `app/api/sites/[id]/retry-failed/route.ts` — REPLACE the INSERT(geoSites) block (lines ~184-273) with UPDATE on the same `siteId`. Update fields: `pipelineStatus='queued'`, `currentRunNumber++`, `currentRunKind='retry-failed'`, `retrySubsetUrls = site.crawlData.failedUrls` (the URLs being retried this run), `previousRunSnapshot = stashed-prior-state`, reset other run-result fields. `enqueueStage` on SAME `siteId`, `stage='crawl-fanout'`. `credit_transactions` ledger row writes to existing `siteId`. |
| **AC-B10-4** | `app/api/pipeline/stage/route.ts` `handleCrawlFanout` (around line 290-330) — read order for URLs: `site.retrySubsetUrls` if non-null and non-empty (retry-failed path) → `site.bulkUrls` (bulk full re-audit) → `discoveryData.urls` (single). Existing `autoDiscoverBrandPages` call only on bulk full re-audit (NOT on retry-failed — we already know the URLs). At terminal state in `handleAssemble`, **clear `retrySubsetUrls` back to null**. |
| **AC-B10-5** | Pipeline state machine — explicit allow `complete→queued` and `failed→queued` re-entry in regenerate + retry-failed routes. `RUNNING_PIPELINE_STATES` guard remains for in-flight blocking (returns 409 'Pipeline already running'). |
| **AC-B10-6** | QStash idempotency — every stage handler entry checks if `site.currentRunNumber` matches the run-number embedded in the stage message payload. **Mismatch = log + skip + return 200** (avoids QStash retry storm). Add `runNumber` to `enqueueStage` payload schema. Stage handlers read it and compare against current site row. Vitest UT mocks a stale stage message hitting after a rerun; asserts skip path. |
| **AC-B10-7** | Schema migration — `lib/db/schema.ts` adds three columns to `geoSites`: `currentRunNumber int NOT NULL DEFAULT 1`, `currentRunKind text NOT NULL DEFAULT 'initial'`, `retrySubsetUrls jsonb NULL`. New migration file `lib/db/migrations/20260427-geo-sites-run-tracking.sql` with idempotent `ADD COLUMN IF NOT EXISTS` for all three. Drizzle journal updated. Apply to LOCAL Supabase via `drizzle-kit push --force`; verify columns. **DO NOT apply to prod** — Shastri surfaces the SQL after dispatch lands. |
| **AC-B10-8** | Wire `parentSiteId`-or-not — `geoSites.parent_site_id` is preserved as a nullable column; in-place rerun does **NOT** populate it (parent linkage is meaningless when there's no spawn). Existing rows that have it from B9.3 era retain their values as historical breadcrumbs. **No code that writes `parent_site_id` on geoSites in B10** (except for any pre-existing data we don't touch). |
| **AC-B10-9** | `app/sites/[id]/_helpers/regenerate-nav.ts` — **DELETE** the file. Reverts the B9.3 navigation-to-spawn helper. Update `import` statements in `SitePageClient` + `ResultsDashboardLegacy` to remove reference. Vitest UT for the helper goes away too. |
| **AC-B10-10** | `app/sites/[id]/SitePageClient.tsx` `handleRefreshScore` (line ~328) + `handleRetryFailed` (line ~444) — simplify: no spawn nav, no separate token-write to a different `siteId`. Just await response, on 202/201 success: `setSite` optimistic state (`pipelineStatus='queued'`), call `router.refresh()` (server component re-fetches and reflects the new run state in place). Type cast updated: `{ siteId?: string; accessToken?: string }` no longer needed for navigation; just check `ok` flag. **Header gains run-number display** from `site.currentRunNumber` when > 1. **Score block gains '↑ from N' delta** when `previousRunSnapshot.geoScorecard` is present. Bulk Crawl Card text differentiates retry-failed-running (S3) from full-rerun-running by reading `currentRunKind` + `retrySubsetUrls.length`. |
| **AC-B10-11** | `app/sites/[id]/ResultsDashboardLegacy.tsx` — same simplifications as AC-B10-10 + same header/score additions. |
| **AC-B10-12** | `app/dashboard/DomainTableRow.tsx` + `app/dashboard/RowActions.tsx` — read `currentRunKind` + `currentRunNumber` from row data (extend the dashboard query to include them). When `pipelineStatus` is in `RUNNING_PIPELINE_STATES` AND `currentRunNumber > 1`, display **'Re-running run #N' chip** instead of generic 'Discovering pages'. `handleRerunAudit` simplifies to single POST + `router.refresh` + tooltip on errors. **No spawn detection logic.** |
| **AC-B10-13** | Vitest UTs — at minimum: (a) regenerate single audit updates row in place (no INSERT); (b) regenerate bulk audit updates row in place using `bulkUrls`; (c) retry-failed updates row with `retrySubsetUrls`; (d) `handleCrawlFanout` reads `retrySubsetUrls` when set; (e) `handleAssemble` clears `retrySubsetUrls`; (f) state machine allows `complete→queued`; (g) QStash idempotency skips stale stage messages; (h) UI: `DomainTableRow` renders 'Re-running run #N' for `currentRunNumber>1` + RUNNING; (i) UI: `SitePageClient.handleRefreshScore` calls `router.refresh`, NOT `router.push`. **Minimum 12 new UTs + 4 new ITs.** |
| **AC-B10-14** | schema-drift test (existing `__tests__/schema-drift.test.ts`) updated to expect the three new columns. |
| **AC-B10-15** | Cleanup — search the codebase for any code that READS `geoSites.parent_site_id` and is no longer relevant after B10 (likely none, since B9.3 only WROTE the column at spawn time). Surface any lingering reads in the reply payload. |

---

## c) Schema migration shape

`lib/db/migrations/20260427-geo-sites-run-tracking.sql` — three columns, idempotent (per AC-B10-7):

```sql
ALTER TABLE geo_sites ADD COLUMN IF NOT EXISTS current_run_number integer NOT NULL DEFAULT 1;
ALTER TABLE geo_sites ADD COLUMN IF NOT EXISTS current_run_kind text NOT NULL DEFAULT 'initial';
ALTER TABLE geo_sites ADD COLUMN IF NOT EXISTS retry_subset_urls jsonb;
```

**Drizzle schema snippet** (insert into `geoSites` table definition; alongside the bulk-related fields ~line 145):

```ts
currentRunNumber: integer("current_run_number").notNull().default(1),
currentRunKind:   text("current_run_kind").notNull().default("initial"),
retrySubsetUrls:  jsonb("retry_subset_urls").$type<string[]>(),
```

**`currentRunKind` enum (string values, not pg enum):**

| Value | Set by | Cleared by |
|---|---|---|
| `'initial'` | DDL DEFAULT on row create | never |
| `'regenerate'` | `/api/sites/[id]/regenerate` UPDATE (AC-B10-2) | next regenerate or retry-failed UPDATE |
| `'retry-failed'` | `/api/sites/[id]/retry-failed` UPDATE (AC-B10-3) | next regenerate or retry-failed UPDATE |

**Verification queries** (post-`drizzle-kit push --force`, local-Supabase only):

```sql
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name='geo_sites'
   AND column_name IN ('current_run_number','current_run_kind','retry_subset_urls');
```

**Operator-approval pin:** ScriptDev MUST report this SQL + verification query in their reply payload so CoFounder can relay verbatim to Aditya for prod application. Local-only apply per AC-B10-7 + hard constraint.

---

## d) Test strategy

### d.1 Vitest UTs — minimum 12 (AC-B10-13)

| ID | Scenario | Asserts |
|---|---|---|
| U-1 | Regenerate single audit | UPDATE on existing siteId; no INSERT issued; `currentRunNumber` incremented; `currentRunKind='regenerate'` |
| U-2 | Regenerate bulk audit | UPDATE on existing siteId; `enqueueStage` called with `stage='crawl-fanout'`; URL source = `bulkUrls`; no INSERT |
| U-3 | Retry-failed bulk | UPDATE on existing siteId; `retrySubsetUrls = site.crawlData.failedUrls`; `currentRunKind='retry-failed'` |
| U-4 | `handleCrawlFanout` reads `retrySubsetUrls` when set | URL list = `retrySubsetUrls`; `bulkUrls` ignored; `autoDiscoverBrandPages` NOT called |
| U-5 | `handleCrawlFanout` reads `bulkUrls` when `retrySubsetUrls` empty | URL list = `bulkUrls`; `autoDiscoverBrandPages` called |
| U-6 | `handleCrawlFanout` reads `discoveryData.urls` for single | URL list = `discoveryData.urls` |
| U-7 | `handleAssemble` clears `retrySubsetUrls` | DB row mutated to `retrySubsetUrls=null` at terminal state |
| U-8 | State machine allows `complete→queued` | regenerate route on `pipelineStatus='complete'` row → 202 + UPDATE; no 409 |
| U-9 | State machine allows `failed→queued` | regenerate route on `pipelineStatus='failed'` row → 202 + UPDATE |
| U-10 | RUNNING_PIPELINE_STATES guard preserved | regenerate route on `pipelineStatus='crawling'` row → 409 |
| U-11 | QStash idempotency — stale message skip | mock stage message with `runNumber=1`, site row `currentRunNumber=2` → handler logs + returns 200 + does NOT mutate DB |
| U-12 | QStash idempotency — fresh message proceeds | mock stage message with `runNumber=2`, site row `currentRunNumber=2` → handler proceeds normally |
| U-13 | UI: `DomainTableRow` renders 'Re-running run #N' | mock row with `currentRunNumber=2`, `pipelineStatus='crawling'` → chip text contains `#2` |
| U-14 | UI: `DomainTableRow` shows generic 'Discovering pages' for `currentRunNumber=1` | initial run → no rerun chip |
| U-15 | UI: `SitePageClient.handleRefreshScore` calls `router.refresh` (NOT `router.push`) | mock 202 response → assert `router.refresh()` invoked, `router.push` mock NEVER called |
| U-16 | UI: `SitePageClient` header renders run-number display when `site.currentRunNumber > 1` | snapshot/text assertion |

### d.2 Vitest ITs — minimum 4 (AC-B10-13)

| ID | Scenario | Asserts |
|---|---|---|
| IT-1 | Full regenerate-bulk in-place flow | Insert bulk site `parent-1` complete; POST `/regenerate` → SELECT same `parent-1` row → `currentRunNumber=2`, `pipelineStatus='queued'`, `crawlData=null`, `baselineScorecard` UNCHANGED, **no new geoSites row exists** |
| IT-2 | Full retry-failed in-place flow | Bulk site `parent-2` complete + `failedUrls=['x','y']`; POST `/retry-failed` → SELECT same `parent-2` → `currentRunNumber=2`, `currentRunKind='retry-failed'`, `retrySubsetUrls=['x','y']`, no new geoSites row |
| IT-3 | retrySubsetUrls clearing at terminal | After IT-2, simulate `handleAssemble` → `retrySubsetUrls=null` |
| IT-4 | QStash idempotency end-to-end | Insert site, regenerate (sets `currentRunNumber=2`), then deliver a stale `runNumber=1` stage message → DB unmutated, handler returns 200 |

### d.3 schema-drift test (AC-B10-14)

`__tests__/schema-drift.test.ts` extended — add `current_run_number`, `current_run_kind`, `retry_subset_urls` to the `geo_sites` expected-columns set.

### d.4 Verification gate

Per pivot `waves-1to6-cd-pivot-2026-04-26`:
- `vitest run` → ≥12 UTs (d.1) + ≥4 ITs (d.2) + drift test (d.3) GREEN.
- Docker CI GREEN.
- **NO Playwright** — full coverage via Vitest UT/IT.

---

## e) UI states (referenced from AC-B10-10/11)

| State | `pipelineStatus` | `currentRunKind` | `currentRunNumber` | Display |
|---|---|---|---|---|
| **S1** | `pending`/`discovery`/`crawling`/etc. | `initial` | 1 | "Initial audit running" |
| **S2** | RUNNING | `regenerate` | > 1 | "Re-running run #N" (full rerun) |
| **S3** | RUNNING | `retry-failed` | > 1 | "Retrying X failed URLs" (subset) — `X = retrySubsetUrls.length` |
| **S4** | `complete` | `initial` | 1 | "Audit complete" |
| **S5** | `complete` | `regenerate`/`retry-failed` | > 1 | "Audit complete" + "↑ from N" delta from `previousRunSnapshot.geoScorecard` |
| **S6** | `failed` | any | any | "Audit failed — click to retry" |
| **S7** | RUNNING (any) AND `currentRunNumber == 1` (initial NOT-yet-rerun) | `initial` | 1 | Same as S1 |

---

## f) Out of scope

- **`audit_runs` sub-table** for multi-run history beyond `previousRunSnapshot` — single-overwrite snapshot pattern preserved per dispatch hard constraint.
- **Prod migration execution** — local-Supabase only per AC-B10-7 + hard constraint. Shastri will surface SQL for Aditya operator approval.
- **Drop or rename `geoSites.parent_site_id`** — keep nullable; revisit later. Existing B9.3-era rows with populated values stay as historical breadcrumbs (AC-B10-8).
- **Roll up or modify pre-existing spawned site rows in prod** — they remain.
- **Extend `baselineScorecard` or `previousRunSnapshot` semantics** — preserve as-is.
- **Playwright per pivot** — Vitest gate only.

---

## g) Ambiguity flag for HolePoker round-trip

**None.** All 15 ACs verbatim from canonical Shastri dispatch corr `b10-in-place-rerun-2026-04-27` (sourced from `/tmp/b10-dispatch.json` `.payload.acceptance_criteria`). File:line pins all reference Shastri-verified locations on branch tip `c9e21ce`:

- `app/api/sites/route.ts` bulk-init line ~198 — `enqueueStage` site
- `app/api/sites/[id]/regenerate/route.ts` lines ~119-188 — bulk INSERT block to convert
- `app/api/sites/[id]/retry-failed/route.ts` lines ~184-273 — INSERT block to convert
- `app/api/pipeline/stage/route.ts` lines ~290-330 — `handleCrawlFanout` URL-source branch
- `app/sites/[id]/SitePageClient.tsx` lines ~328 + ~444 — `handleRefreshScore` + `handleRetryFailed`
- `app/sites/[id]/ResultsDashboardLegacy.tsx` — mirror simplifications
- `app/dashboard/DomainTableRow.tsx` + `RowActions.tsx` — `currentRunKind`/`currentRunNumber` reads
- `app/sites/[id]/_helpers/regenerate-nav.ts` — DELETE target (B9.3 helper)
- `__tests__/schema-drift.test.ts` — extension target

Per dispatch §process: HP round-trip ONLY if SpecMaster finds material spec ambiguity — none found. Direct hand-off to ScriptDev. Cofounder retains autonomy to skip HP.
