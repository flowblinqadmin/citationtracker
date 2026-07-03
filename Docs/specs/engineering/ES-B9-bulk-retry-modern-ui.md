# ES-B9 — Bulk-audit retry parity (modern UI + state coverage)

**Branch:** `fix/b9-bulk-retry-modern-ui`
**Base:** `d404665` (post-B7 merge on `e2e-comprehensive-suite`)
**Pivot:** `waves-1to6-cd-pivot-2026-04-26` — Vitest GREEN + Docker CI GREEN gate, NO Playwright per-spec.

---

## a) Overview — three gaps + Shastri's recommended semantics

UAT 2026-04-26 surfaced that bulk-audit retry is broken across three surfaces:

| Gap | Symptom | SpecMaster verification |
|---|---|---|
| **Gap 1** | `/api/sites/[id]/regenerate` 400s on bulk audits | **PRESERVE** — `app/api/sites/[id]/regenerate/route.ts:62-67` returns `{error: "Bulk audits cannot be regenerated. Upload a new CSV on the landing page."}, status=400`. Single-shot semantics correct. |
| **Gap 2** | Modern `SitePageClient.tsx` has zero bulk-retry UI | Verified: `grep -n 'auditMode\|retry-failed\|bulkUrls\|failedUrls' app/sites/[id]/SitePageClient.tsx` returns **0 matches**. Legacy `ResultsDashboardLegacy.tsx:1763-1880` has the retry button + `handleRetryFailed` (line 1015). Modern UI is silent on bulk affordances. |
| **Gap 3** | `/api/sites/[id]/retry-failed` only works for `status='complete'` with populated `crawlData.failedUrls`; `status='failed'` no-merge-crawl has **no retry path** | Verified: route at `app/api/sites/[id]/retry-failed/route.ts:70-72` reads `crawlDataRaw?.failedUrls ?? []`. If `crawlData` is null (pipeline failed before merge-crawl), `allFailed` is empty; with no body URLs the request 400s at line 110. |

Shastri's recommended semantics (this spec encodes them as ACs):

1. **Keep `/regenerate` blocking bulk** (Gap 1 — preserve as-is).
2. **Modify `/retry-failed`** to accept bulk in any state EXCEPT `'complete'`-with-zero-failures: `status='failed'` no-merge-crawl → retry full originally-submitted URL set; `status='complete'` with `failedUrls.length > 0` → retry those (current behaviour); legacy `'partial'`/`'incomplete'` references → **N/A** (see SpecMaster finding §b.3).
3. **Surface retry-failed button in BOTH `SitePageClient` AND `ResultsDashboardLegacy`** with a single shared conditional (mirror).
4. **(Optional)** `DomainTableRow` bulk Rerun-Audit dispatches to `/retry-failed` instead of `/regenerate` (today the dashboard row action calls `/regenerate?token=...` at `app/dashboard/RowActions.tsx:56` — which 400s on bulk).

---

## b) Schema audit + lexicon verification (SpecMaster recon)

### b.1 `geoSites` bulk fields (`lib/db/schema.ts:108, 140-143`)

```ts
crawlData:       jsonb("crawl_data"),                // final merged crawl result (complete) OR scrape-pass pages (crawling)
auditMode:       text("audit_mode").default("single"),  // "single" | "bulk"
bulkUrls:        jsonb("bulk_urls"),                    // string[] of raw CSV URLs
bulkUrlCount:    integer("bulk_url_count"),             // denormalized count
crawlLimit:      integer("crawl_limit"),                // effective page cap
```

### b.2 `bulkUrls` already captures originalUrlSet → **NO schema change required**

The dispatch raised surface decision (B) — *"Schema change: track originalUrlSet on bulk audits if not already"* — as potentially needed for `status='failed'` no-crawl-data retry. **Resolved by recon:** `geoSites.bulkUrls` is the original CSV URL set, persisted at the create-site call (`app/api/sites/[id]/retry-failed/route.ts:172` does the same on retry-spawn). Status='failed' retry can read `site.bulkUrls` directly. **Schema change verdict: NOT NEEDED.**

### b.3 `pipelineStatus` lexicon — `'partial'` does NOT exist

The dispatch raised surface decision (C) — *"Default behavior for status='partial' — does 'partial' state even exist?"* — as a likely surface. **Resolved by recon:** `grep "pipelineStatus.*=.*\"" lib/services/site-view-sync.ts app/api/pipeline/stage/route.ts` enumerates only `"complete"`, `"crawling"`, `"failed"`, `"researching"` (plus running-states `"queued"/"discovery"/"processing"/"analyzing"/"generating"/"assembling"` from `regenerate/route.ts:71-79`). **No `'partial'`/`'incomplete'`/`'complete-with-failures'` state exists.** This narrows the AC matrix:

| State | Has `bulkUrls`? | Has `crawlData.failedUrls`? | Retry source |
|---|---|---|---|
| `complete` + `failedUrls.length > 0` | yes | yes | `crawlData.failedUrls` (current behaviour) |
| `complete` + `failedUrls.length === 0` | yes | empty | **NO retry** (no failures to retry) |
| `failed` (pre-merge-crawl) | yes | null | **NEW: `bulkUrls` full set** |
| `failed` (post-merge-crawl partial) | yes | yes (subset) | `crawlData.failedUrls` (treat same as `complete` branch) |
| `crawling`/`researching`/etc. (in-progress) | yes | maybe | **NO retry** — block (consistent with regenerate's running-state block) |

### b.4 `crawlData.failedUrls` shape

`crawlDataRaw?.failedUrls ?? []` at `route.ts:71-72`. Confirmed populated by merge-crawl pipeline stage. No additional fields needed for the spec.

---

## c) Acceptance criteria

### c.1 `/retry-failed` route — state-machine expansion

| ID | Criterion |
|---|---|
| **AC-B9-1** | When `site.pipelineStatus === 'failed'` AND `crawlData?.failedUrls` is empty/null, route MUST fall back to `site.bulkUrls` as the candidate URL list (the originally-submitted CSV set). Existing SSRF validation (lines 86-101) applies verbatim. **Credit gate behaviour is governed by AC-B9-10 (Option γ ratified)** — `status='failed'` retries bypass `effectiveCrawlLimit + bulkCreditsRequired` entirely. |
| **AC-B9-2** | When `site.pipelineStatus === 'complete'` AND `crawlData.failedUrls.length === 0` AND no `body.urls`, route MUST 400 with `{error: "No failed URLs to retry."}` (current line 110-112 behaviour preserved). Caller-supplied `body.urls` continues to override regardless of state per current `route.ts:81-83` — explicit-override semantics preserved. |
| **AC-B9-3** | When `site.pipelineStatus` is in the running-states set (`queued`, `discovery`, `crawling`, `researching`, `processing`, `analyzing`, `generating`, `assembling`), route MUST 409 with `{error: "Pipeline already running"}` — mirrors `regenerate/route.ts:80-85` behaviour for consistency. (Currently `/retry-failed` has no running-state guard; this is a new defensive check.) |
| **AC-B9-4** | Audit-mode block at `route.ts:62-64` (`if (site.auditMode !== "bulk") → 400`) PRESERVED. AC-B9-1/2/3 do not weaken the bulk-only invariant. |

### c.2 `SitePageClient.tsx` — surface retry button (Gap 2)

| ID | Criterion |
|---|---|
| **AC-B9-5** | `app/sites/[id]/SitePageClient.tsx` MUST render a "Bulk Crawl Results" card with the retry button when the **shared conditional** (defined in AC-B9-7) evaluates true. Layout/styling can mirror the legacy at `ResultsDashboardLegacy.tsx:1763-1880` but ScriptDev may modernize per the existing copper design system. The card MUST display: success count, failed count, credit-limited count, retry button, per-row retry buttons (mirroring legacy line 1846). |
| **AC-B9-6** | Retry button click MUST POST to `/api/sites/${site.id}/retry-failed` with `Authorization: Bearer ${site.token}` and `body: urls ? JSON.stringify({urls}) : "{}"` — verbatim semantics from `ResultsDashboardLegacy.tsx:1015-1031`. On success (`res.ok && data.siteId`), MUST surface a toast/redirect to the new bulk-retry site. On failure, MUST display the server `data.error` (or "Network error — retry failed."). |

### c.3 Shared conditional (AC-B9-7) — both UIs use the same predicate

| ID | Criterion |
|---|---|
| **AC-B9-7** | Define a shared helper `canRetryBulk(site)` (location: `app/sites/[id]/types.ts` or `app/sites/[id]/_helpers/bulk-retry.ts`) that returns `true` iff: `site.auditMode === 'bulk'` AND NOT-isGated AND `site.pipelineStatus !== 'crawling' && !== 'researching' && !== 'queued' && !== 'discovery' && !== 'processing' && !== 'analyzing' && !== 'generating' && !== 'assembling'` (i.e. terminal state) AND `(site.failedUrls?.length > 0 OR site.creditLimitedUrls?.length > 0 OR site.pipelineStatus === 'failed')`. Both `ResultsDashboardLegacy.tsx:1763` and `SitePageClient.tsx` (per AC-B9-5) MUST gate on this exact symbol. Grep test enforces. |
| **AC-B9-8** | The legacy gate `auditMode==='bulk' && !isGated && isComplete` at `ResultsDashboardLegacy.tsx:1763` MUST be replaced by `auditMode==='bulk' && !isGated && canRetryBulk(site)` (or the equivalent inline). The `isComplete`-only restriction is removed — `status='failed'` bulks now show the retry surface (this is the user-visible Gap 3 fix). |

### c.4 `DomainTableRow` / `RowActions` — bulk-aware dispatcher (optional Gap 4)

| ID | Criterion |
|---|---|
| **AC-B9-9** *(optional, ScriptDev may defer)* | `app/dashboard/RowActions.tsx:56` (current: `fetch(/api/sites/${siteId}/regenerate?token=${accessToken}`) MUST branch on `site.auditMode`: for `'bulk'` rows, dispatch to `/api/sites/${siteId}/retry-failed` with `Authorization: Bearer` header and `{}` body (full-failed-set retry). For `'single'` rows, retain `/regenerate`. Alternative: surface a distinct "Retry failed" affordance in DomainTableRow when `site.auditMode === 'bulk'` AND `canRetryBulk(site)`. ScriptDev's choice between bulk-aware-dispatcher vs distinct-affordance is acceptable; both satisfy the AC. |

### c.5 Credit policy — Option γ ratified (Shastri 2026-04-27)

| ID | Criterion |
|---|---|
| **AC-B9-10** | When `/retry-failed` is invoked for a parent site with `site.pipelineStatus === 'failed'`: route MUST charge **0 credits** (bypass `effectiveCrawlLimit + bulkCreditsRequired` entirely; do NOT mutate `teams.creditBalance`). Route MUST insert exactly one `creditTransactions` row with: `type='bulk_retry_failed_free'`, `siteId=<newSite.id>` (the spawned retry site), `pagesConsumed=urlsToRetry.length`, `creditsChanged=0`, `balanceBefore=team.creditBalance`, `balanceAfter=team.creditBalance` (no delta), and a new `parentSiteId=<originalSite.id>` reference column on `creditTransactions` (or, if avoiding schema change, encode parent-site ref in the existing `siteId` field as the parent and use a new column-free pattern — see §c.5.1). When `site.pipelineStatus === 'complete'` (with populated `failedUrls`), the existing charge path (`bulk_crawl_reserve` ledger entry, full credit deduction) is UNCHANGED. **Verifier:** Vitest UT — case A: mock `status='failed'` → POST `/retry-failed` → assert `team.creditBalance` unchanged AND assert one row in `creditTransactions` with `type='bulk_retry_failed_free'` AND `creditsChanged=0`; case B: mock `status='complete'` + `failedUrls=['x']` → assert existing charge path runs (`bulkCreditsRequired(1)=1` deducted, `type='bulk_crawl_reserve'` ledger row). |

#### c.5.1 `parent_site_id` linkage — SpecMaster note

Current `creditTransactions` schema (`lib/db/schema.ts`) does not include a `parent_site_id` column. Two options for ScriptDev — both acceptable, neither requires Shastri:

- **Option (i) — schema additive:** add nullable `parentSiteId: text("parent_site_id")` column to `creditTransactions` (idempotent migration; nullable so existing rows are unaffected). Set on `bulk_retry_failed_free` insert; NULL elsewhere.
- **Option (ii) — no schema change:** encode parent linkage via the existing `siteId` field set to the **new** retry site, and rely on `geoSites.parentSiteId` (if it exists; if not, persisted via the new bulk-retry create at `route.ts:162-179`) for the inverse lookup. Search by `creditTransactions.type='bulk_retry_failed_free'` joined to `geoSites.id=creditTransactions.siteId` then `geoSites.parentSiteId` for the audit trail.

ScriptDev's choice; AC-B9-10 verifier accepts both — the assertion is on charge-amount and ledger-type, not on schema layout.

---

## d) SHASTRI SURFACE — credit policy on `status='failed'` retry (decision A) — **RESOLVED γ**

**Shastri ratify (corr `b9-credit-gamma-pick-2026-04-27`):** Option γ adopted — `status='failed'` retries are **free** (charge=0); `status='complete'` retries continue to charge per existing path.

**Rationale (carried from Shastri):** bulk failures are predominantly platform-side — Firecrawl outages, pipeline bugs, cloudflared disruptions, downstream API failures. Double-charging users for our infrastructure failures is a worse trust outcome than the marginal abuse risk. The abuse vector (user submits CSV with all-blocked URLs → free retry loop) is captured as a Phase 2 deferred item via `docs/specs/technical/TS-b9-phase2-free-retry-rate-limit.md` (rate-limit `bulk_retry_free:<parentSiteId>` keyed in the existing `rate_limits` table). Phase 2 is **NOT** implemented in this spec.

**Implementation locus:** AC-B9-10 (above). The original 3-option matrix (α / β / γ) is preserved below for HolePoker traceability — but only γ is in scope.

<details>
<summary>Original 3-option matrix (preserved for traceability — α and β NOT in scope)</summary>

- **Option α (RE-CHARGE) — REJECTED:** user pays twice for perceived single failed attempt; trust-hostile.
- **Option β (REFUND-THEN-RECHARGE) — REJECTED:** doubles impl surface (refund ledger + idempotency) without commensurate user-trust gain over γ.
- **Option γ (FREE RETRY) — RATIFIED:** bypass charge entirely on `status='failed'`; ledger row for audit trail.

</details>

---

## d.1) `/regenerate` vs `/retry-failed` mode matrix — bulk-aware semantics (B9.2 amendment 2026-04-27)

**Why this section exists:** Aditya UAT 2026-04-27 hit a 400 stale message ("Bulk audits cannot be regenerated. Upload a new CSV...") when clicking *Refresh Score* on the bulk site report. Recon: `app/api/sites/[id]/regenerate/route.ts:62-67` hardcodes a 400 for `auditMode === 'bulk'` — a guard that **predates the `bulk_urls` jsonb column**. With `geoSites.bulkUrls` (`schema.ts:145`) now persisting the original CSV URL set (manipal `VI5W` has `bulk_url_count=255` populated), forcing the user back to the landing page to re-upload is no longer necessary.

**Two distinct semantics — both supported, neither overlaps the other:**

| Route | Scope | Source URL set | Charge model | When user clicks |
|---|---|---|---|---|
| `POST /api/sites/[id]/regenerate` | **Full re-audit** | `site.bulkUrls` (the original CSV, all 255 URLs for manipal) | **Full charge** — same as a fresh bulk submission (`effectiveCrawlLimit + bulkCreditsRequired` against current credit balance) — applies to bulk OR single | "Refresh Score" / "Rerun audit" — wants the latest GEO state across the whole site |
| `POST /api/sites/[id]/retry-failed` | **Subset retry** of `failedUrls + creditLimitedUrls` ONLY | `crawlData.failedUrls ∪ crawlData.creditLimitedUrls` (or `body.urls` override) | **Free per AC-B9-10 γ** when parent `pipelineStatus='failed'`; charge per existing `bulk_crawl_reserve` path when parent `pipelineStatus='complete'` with non-empty `failedUrls` | "Retry failed URLs" in bulk results card — wants to fill in gaps from a partially-successful run |

**Implication for the regenerate route:** the bulk-block at `route.ts:62-67` MUST be removed. For bulk sites, regenerate should:
1. Read `site.bulkUrls` as the URL set (analogous to how `retry-failed` reads `crawlData.failedUrls ?? site.bulkUrls`).
2. Compute `crawlLimit = effectiveCrawlLimit(bulkUrls.length, team.creditBalance)` — same as a fresh bulk submission.
3. Charge `bulkCreditsRequired(crawlLimit)` credits. NO γ free-retry path on regenerate — full re-audit always charges (this is "I want fresh data", not "your infra failed me").
4. Re-enqueue `crawl-fanout` stage (NOT `discover`) since the URL set is already known.

**Out of scope for this amendment** (deferred to a B9.2 ScriptDev impl PR): the actual route handler edits, new ACs for regenerate-bulk-aware behaviour, and tests for the matrix above. This §d.1 is documentation-only — it pins the *correct semantics* so a downstream B9.2 ES (or amendment to ES-B9) can encode them as ACs without re-litigating the design. Reference: see `docs/specs/technical/TS-bulk-url-fields-audit.md` for the full bulk-URL fields lifecycle survey that surfaced this gap.

---

## e) Test strategy

### e.1 Vitest UTs — `app/api/sites/[id]/retry-failed/__tests__/route.test.ts` (new file)

| ID | Scenario | Expected |
|---|---|---|
| **U-B9-1** | `status='complete'`, `failedUrls=['a','b','c']`, no body URLs | Retry candidate = `['a','b','c']`; 201; new bulk site created with these 3 |
| **U-B9-2** | `status='complete'`, `failedUrls=[]`, no body URLs | 400 `{error:"No failed URLs to retry."}` (AC-B9-2) |
| **U-B9-3** | `status='complete'`, `failedUrls=[]`, body URLs `['x']` | 201 retry of `['x']` (explicit override preserved) |
| **U-B9-4** | `status='failed'`, `crawlData=null`, `bulkUrls=['p','q','r']` | Retry candidate = `['p','q','r']`; 201 (AC-B9-1) |
| **U-B9-5** | `status='failed'`, `crawlData={failedUrls:['a']}`, `bulkUrls=['a','b','c']` | Retry candidate = `['a']` (failedUrls non-empty wins; bulkUrls fallback only when failedUrls empty/null) |
| **U-B9-6** | `status='crawling'` | 409 `{error:"Pipeline already running"}` (AC-B9-3) |
| **U-B9-7** | `auditMode='single'` | 400 `{error:"Retry only available for bulk audits."}` (AC-B9-4 — preserved) |
| **U-B9-8** | Credit policy γ — case A: `status='failed'`, `bulkUrls=['p','q']`, team credits=10 → 201; assert team balance still 10 (no mutation); assert one `creditTransactions` row with `type='bulk_retry_failed_free'`, `creditsChanged=0`. Case B: `status='complete'`, `failedUrls=['x']`, team credits=10 → 201; assert team balance decremented to 9 (`bulkCreditsRequired(1)=1`); assert `creditTransactions` row with `type='bulk_crawl_reserve'`, `creditsChanged=-1` (existing path unchanged). |

### e.2 Vitest UTs — shared conditional `canRetryBulk`

| ID | Scenario | Expected |
|---|---|---|
| **U-B9-9** | `auditMode='bulk'`, `pipelineStatus='complete'`, `failedUrls=['a']`, isGated=false | true |
| **U-B9-10** | `auditMode='bulk'`, `pipelineStatus='failed'`, `failedUrls=[]`, isGated=false | true (status='failed' qualifies) |
| **U-B9-11** | `auditMode='bulk'`, `pipelineStatus='complete'`, `failedUrls=[]`, `creditLimitedUrls=[]`, isGated=false | false (nothing to retry) |
| **U-B9-12** | `auditMode='bulk'`, `pipelineStatus='crawling'` | false (running state) |
| **U-B9-13** | `auditMode='bulk'`, isGated=true | false (gated user) |
| **U-B9-14** | `auditMode='single'` | false (single audit) |

### e.3 Vitest IT — `app/api/sites/[id]/retry-failed/__tests__/retry-failed.it.test.ts` (new file)

Drives the full state machine end-to-end against a real `geoSites` row + transactional credit deduction:

| ID | Scenario | Assertion |
|---|---|---|
| **IT-B9-1** | Insert bulk site with `status='failed'`, `bulkUrls=['u1','u2']`, team credits=10 | POST `/retry-failed` → 201; new site row created with `bulkUrls=['u1','u2']`, `auditMode='bulk'`, `pipelineStatus='crawling'`; **team credits UNCHANGED at 10** (Option γ ratified — see AC-B9-10); one `creditTransactions` row inserted with `type='bulk_retry_failed_free'`, `creditsChanged=0`; QStash `crawl-fanout` enqueued |
| **IT-B9-2** | Same as IT-B9-1 but `status='complete'` + `crawlData.failedUrls=['u1']` | Retries `['u1']` only (not `['u1','u2']`) |
| **IT-B9-3** | `status='crawling'` (running) | 409 |

### e.4 Component-render UT (Gap 2 surface) — `SitePageClient.bulk-retry.test.tsx`

| **U-B9-15** | Render `SitePageClient` with `site.auditMode='bulk', pipelineStatus='failed', bulkUrls=['a','b']` | `getByRole('button', {name: /retry/i})` present; click triggers POST to `/retry-failed` (assert via fetch mock) |
| **U-B9-16** | Render with `auditMode='single'` | `queryByRole('button', {name: /retry/i})` returns null |

### e.5 Verification gate

Per pivot `waves-1to6-cd-pivot-2026-04-26`:

- `vitest run` → 16 UTs + 3 ITs GREEN.
- Docker CI GREEN.
- **NO Playwright.**

---

## f) Out of scope

- Pipeline-side retry logic / Firecrawl retry exponential backoff: unchanged.
- `/regenerate` route bulk-block (Gap 1): preserved as-is, no edits.
- Bulk audit credit-pricing model: only the *retry* charge policy is in scope (per surface §d); base bulk pricing unchanged.
- DomainTableRow design — AC-B9-9 is optional; ScriptDev choice between bulk-aware-dispatcher vs distinct-affordance is fine.
- Email/notification on retry start: out of scope.

---

## g) HolePoker pre-review checklist

- [ ] Confirm SpecMaster recon §b.2 (no schema change — `bulkUrls` is the originalUrlSet) and §b.3 (no `'partial'` state) are both correct.
- [x] **RESOLVED 2026-04-27** — Shastri ratified Option γ (free retry on `status='failed'`); AC-B9-10 encodes the credit-zero invariant + ledger-type pin (`bulk_retry_failed_free`).
- [ ] Confirm AC-B9-7 `canRetryBulk` symbol-grep test catches both call sites.
- [ ] Confirm AC-B9-3 running-state guard list is complete (matches `regenerate/route.ts:71-79`).
- [ ] Confirm AC-B9-9 (DomainTableRow) is appropriately marked optional (depends on whether dashboard-row bulk dispatch is in this PR's scope).
- [ ] Confirm 0 product-code edits in this spec.
