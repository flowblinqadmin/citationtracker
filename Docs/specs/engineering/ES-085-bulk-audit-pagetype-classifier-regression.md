# ES-085 — Bulk Audit pageType Classifier Under-Classification Regression

**Author:** SpecMaster (Agent 2)
**Source TS:** geo/docs/specs/technical/TS-085-bulk-audit-pagetype-classifier-regression.md
**Date:** 2026-04-09
**Priority:** P1 — affects every bulk audit customer; downstream multiplier on dimensional outputs
**Sprint:** Bulk-audit dimensional data fix sprint (TS-083/084/085/086 ship together)
**Sprint role:** Classifier alignment between bulk and single-domain modes
**Branch:** `fix/tree-extractor-and-bulk-audit` (NEW sprint branch)
**HolePoker status:** Cleared via HP-170 / HP-171 / HP-172 / HP-182 amendments

---

## a) Overview

### What this covers

In bulk audit mode, the pageType classifier marks 241/243 pages as `"other"`. In single-domain mode, the same URLs get classified correctly. ES-085 aligns the two modes and adds URL-pattern-based fallback classification.

The fix has three layers:

1. **Hypothesis A fix (DOMINANT — see SpecMaster recon below):** the bulk-mode `handleCrawlFanout` at `pipeline/stage/route.ts:261` HARDCODES `pageMap[url] = "other"` for every bulk URL. The classifier is never called. Single mode runs `discoverSite` which properly populates `pageMap`. The fix is to call `classifyPageType(url)` in the bulk fanout loop.
2. **AC-3 URL-pattern fallback:** even after fix #1, URLs that don't match the substring patterns in `PAGE_PATTERNS` (lines 140-151) fall through to `"other"`. A second-pass URL-pattern fallback runs AFTER the primary classifier with WHATWG URL parsing + 5-step normalization (per HP-171 + HP-182).
3. **Backfill script:** operator-only `geo/scripts/reclassify-bulk-pagetype.ts` re-classifies pageTypes on existing geo_sites rows by re-running the classifier against persisted `crawl_data.pages`.

### SpecMaster recon finding — HYPOTHESIS A IS THE DOMINANT ROOT CAUSE

Per the AC-16 / TS-082 precedent: TS-085 §2.3 lists 4 hypotheses (A/B/C/D) and asks ScriptDev to verify all four. **My recon strongly supports Hypothesis A as the dominant cause** with a refinement:

Verified at `geo/app/api/pipeline/stage/route.ts:255-261`:

```ts
if (site.auditMode === "bulk") {
  // Bulk: build synthetic discoveryData from CSV URLs (no discover stage for bulk)
  const allUrls = (site.bulkUrls as string[] | null) ?? [];
  const crawlLimit = (site.crawlLimit as number | null) ?? allUrls.length;
  const urlsToProcess = allUrls.slice(0, crawlLimit);
  pageMap = {};
  for (const url of urlsToProcess) pageMap[url] = "other";  // ← HARDCODED
```

Compare with the deprecated `runner.ts:43` (the OLD bulk path):

```ts
const pageMap: Record<string, ReturnType<typeof classifyPageType>> = {};
for (const url of bulkUrls) {
  pageMap[url] = classifyPageType(url);  // ← classifier WAS called
}
```

When the bulk path was migrated from `lib/pipeline/runner.ts` to `app/api/pipeline/stage/route.ts:handleCrawlFanout`, the `classifyPageType(url)` call was replaced with the literal `"other"`. **This is a regression introduced during the runner→stage migration.** The single-mode path runs `discoverSite()` (called from `handleDiscover` at line 226) which builds `discoveryData.pageMap` with proper classification — see `geo/lib/services/geo-crawler.ts` `discoverSite`. Bulk mode bypasses `handleDiscover` entirely (per the comment at line 256: "no discover stage for bulk"), so the classifier is skipped.

Then at `app/api/pipeline/stage/route.ts:418` (the `poll-chunk` handler):

```ts
.map((d) => mapDocumentToPage(d, pageMap as Record<string, import("@/lib/services/geo-crawler").PageType>))
```

`mapDocumentToPage` reads `pageMap[url] ?? classifyPageType(url)` at `geo-crawler.ts:796`. Because `pageMap[url]` is ALWAYS set (to `"other"`) in bulk mode, the `??` fallback to `classifyPageType` never fires. **The classifier is never invoked for any bulk URL anywhere in the pipeline.**

**Hypotheses B / C / D are SECONDARY** to this root cause:
- Hypothesis A (different classifier): TRUE — the bulk path has NO classifier. Confirmed.
- Hypothesis B (different inputs): partially true — bulk path skips `discoverSite` entirely, so the inputs differ in that the classifier isn't called.
- Hypothesis C (firecrawl metadata starvation): not verified; the classifier currently runs only on URLs, not metadata, so this is N/A.
- Hypothesis D (siteRoot context gap): the spec speculates that `siteRoot` should be threaded through. **But `siteRoot` is not currently used by `classifyPageType` at all** (line 153-163 takes only `url: string`). The function builds the path from `new URL(url).pathname` which is already domain-relative. Adding a `siteRoot` argument would be net-new functionality, not a fix. **Reject Hypothesis D as redundant.**

The fix per AC-2 is: ScriptDev still must verify all four hypotheses empirically per the spec, but the dominant action is the line-261 fix (hardcoded `"other"` → `classifyPageType(url)`), plus the AC-3 URL-pattern fallback for `"other"` cases.

### Source TS reference

`geo/docs/specs/technical/TS-085-bulk-audit-pagetype-classifier-regression.md`. Key sections:

- **§2.1** — Manipal customer evidence (1/241 vs 91/98 structural pageType ratio)
- **§2.3** — 4 hypotheses (A/B/C/D)
- **§3.2** — URL-pattern fallback with 5-step normalization (HP-171 + HP-182)

### Current implementation state

| Surface | File | Lines | State |
|---|---|---|---|
| `classifyPageType(url)` | `geo/lib/services/geo-crawler.ts` | 153-163 | Takes only URL, returns `PageType`. Uses substring matching against `PAGE_PATTERNS`. Currently uses raw `parsed.pathname.toLowerCase()` with no normalization. |
| `PAGE_PATTERNS` | `geo/lib/services/geo-crawler.ts` | 140-151 | 10 pattern groups for `about/pricing/services/team/contact/blog/docs/faq/case-studies/legal`. Substring match (`p.includes(pat)`). |
| `mapDocumentToPage` | `geo/lib/services/geo-crawler.ts` | 785-818 | Reads `pageMap[url] ?? classifyPageType(url)` at line 796. The `??` never fires in bulk mode because of the hardcoded "other" upstream. |
| Bulk pageMap initialization | `geo/app/api/pipeline/stage/route.ts` | 255-261 | **BUG (Hypothesis A):** `for (const url of urlsToProcess) pageMap[url] = "other";` — hardcodes every URL to "other", classifier never invoked |
| Single-mode discoverSite | `geo/lib/services/geo-crawler.ts` | (function `discoverSite`) | Builds `pageMap` correctly via classifier; called from `handleDiscover` at `pipeline/stage/route.ts:226` |
| Existing test | `geo/__tests__/crawl-fanout.test.ts` | 1-200 (mapDocumentToPage tests M-1..M-5 at line ~120) | Tests `mapDocumentToPage` happy path; does NOT cover the bulk pageMap hardcoding issue |
| `geo_sites` schema | `geo/lib/db/schema.ts` | 100-108 | `crawlData` is jsonb. The reclassify backfill (AC-8) updates `crawl_data.pages[*].pageType` in place. |

### Out of scope (verbatim from TS-085 §4)

- **TS-086** (tree extractor LLM bug) — must ship first
- **TS-083** (auto-discover brand pages) — sibling
- **TS-084** (timing race) — sibling
- Re-architecting firecrawl page metadata extraction
- AI-based pageType classifier — keep rule-based

---

## b) Implementation Requirements

### b.1 Hypothesis A fix — bulk pageMap initialization (AC-1, AC-2 dominant)

**File:** `geo/app/api/pipeline/stage/route.ts`, line 261.

```ts
// Before (BUG — Hypothesis A dominant root cause):
for (const url of urlsToProcess) pageMap[url] = "other";

// After (ES-085 §b.1):
for (const url of urlsToProcess) pageMap[url] = classifyPageType(url);
```

**Import requirement:** `classifyPageType` is already imported at line 21 (verified) — no new import needed.

**ScriptDev investigation requirement (AC-2):** before committing, ScriptDev runs the classifier against the Manipal fixture (the same `__tests__/fixtures/tree-extract-manipal.json` shared with ES-086 AC-7) and compares pre-fix vs post-fix distribution. Expected: pre-fix is 100% `"other"`, post-fix is at least 90% structural (per AC-6 hard target). Each hypothesis (A/B/C/D) gets a per-hypothesis verdict in the PR description: A = confirmed dominant, B = secondary, C = not applicable, D = rejected as redundant.

### b.2 URL-pattern fallback classifier (AC-3, AC-4)

**File:** `geo/lib/services/geo-crawler.ts`, modify `classifyPageType` at lines 153-163.

The current implementation uses substring matching with no normalization. AC-3 requires WHATWG URL parsing with explicit 5-step normalization that catches trailing-slash, query string, fragment, index.html, double-slash, and case variants:

```ts
export function classifyPageType(url: string): PageType {
  try {
    const u = new URL(url);
    let path = u.pathname.toLowerCase();

    // ES-085 AC-3 normalization steps (HP-182 — load-bearing for trailing slash):
    // 1. /index.html or /index.htm → /
    path = path.replace(/\/index\.html?$/, "/");
    // 2. Collapse double slashes
    path = path.replace(/\/{2,}/g, "/");
    // 3. Strip trailing slash UNLESS the path is just "/"
    if (path !== "/") path = path.replace(/\/+$/, "");

    // Now match the normalized path
    if (path === "/") return "homepage";

    // Specific suffix matchers (use endsWith for top-level brand pages, includes for subpaths)
    if (path.endsWith("/about-us") || path.endsWith("/about")) return "about";
    if (path.endsWith("/contact-us") || path.endsWith("/contact")) return "contact";
    if (path.includes("/specialities") || path.includes("/specialties") || path.includes("/services") || path.includes("/products") || path.includes("/solutions") || path.includes("/offerings")) return "services";
    if (path.includes("/team") || path.includes("/leadership") || path.includes("/doctors") || path.includes("/staff") || path.includes("/people")) return "team";
    if (path.includes("/pricing") || path.includes("/plans") || path.includes("/packages")) return "pricing";
    if (path.includes("/blog") || path.includes("/news") || path.includes("/articles") || path.includes("/insights")) return "blog";
    if (path.includes("/docs") || path.includes("/documentation") || path.includes("/help") || path.includes("/support")) return "docs";
    if (path.includes("/faq") || path.includes("/faqs") || path.includes("/questions")) return "faq";
    if (path.includes("/case-stud") || path.includes("/portfolio") || path.includes("/work")) return "case-studies";
    if (path.includes("/privacy") || path.includes("/terms") || path.includes("/legal") || path.includes("/cookie")) return "legal";

    return "other";
  } catch {
    return "other";
  }
}
```

**Diff against current:**
- Replaces the 10-line `PAGE_PATTERNS` lookup loop (lines 158-160) with explicit ordered if-statements
- Adds the WHATWG URL parsing + 5-step normalization
- Adds the `endsWith` discriminator for `about` / `contact` (which match brand pages, not blog post titles like `/blog/about-us-launch`)
- Promotes `pricing` / `team` / `case-studies` from PAGE_PATTERNS into the function body (preserving the existing matchers from lines 141-151)
- The exported `PAGE_PATTERNS` constant can be deleted OR kept for documentation; ScriptDev's call. If kept, add a comment that it's now informational only.

**False positive guard (per AC-3 §c.5 of TS-085):** the `endsWith("/about-us")` semantics ensure that `https://example.com/blog/about-us-launch-q1` does NOT match `about` (only `path.endsWith("/about-us")` is true if `about-us` is the last segment). Substring matching for the others (services, team, blog) is intentional because subpaths like `/services/dermatology/` should still classify as `services`.

**AC-4 fallback logging:** add a single log at the call site of `classifyPageType` in the bulk fanout (and in `mapDocumentToPage`) when the result is `"other"` and the URL has a non-trivial path. This is INFO-level, throttled to avoid log spam:

```ts
// Inside handleCrawlFanout, after the classifier call:
const classified = classifyPageType(url);
pageMap[url] = classified;
if (classified === "other") {
  // ES-085 AC-4 — visibility into structural URL coverage
  console.info(JSON.stringify({
    event: "classifier_fallback_other",
    domain,
    url,
  }));
}
```

(Or batch the count and emit a single summary log per chunk to reduce noise. ScriptDev's call.)

### b.3 Backfill script — `reclassify-bulk-pagetype.ts` (AC-8, AC-9)

**File to create:** `geo/scripts/reclassify-bulk-pagetype.ts`

**CLI surface:**

```
Usage: tsx geo/scripts/reclassify-bulk-pagetype.ts [options]

Options:
  --site <site-id>     Reclassify one specific site only
  --owner <email>      Reclassify all bulk-mode sites for a single owner
  --commit             Actually write to the database (default: dry-run)
  --max <n>            Maximum number of sites to process (default: unlimited)
  --help               Show this help

Examples:
  # Dry-run: list all candidates, don't change anything
  tsx geo/scripts/reclassify-bulk-pagetype.ts

  # Dry-run for one specific site
  tsx geo/scripts/reclassify-bulk-pagetype.ts --site -GzFX1KcKhmN0W_1t8SmY

  # Actually reclassify Manipal
  tsx geo/scripts/reclassify-bulk-pagetype.ts --site -GzFX1KcKhmN0W_1t8SmY --commit
```

**Selection query (default — no filter flags):**

```sql
SELECT id, domain, owner_email, crawl_data
FROM geo_sites
WHERE pipeline_status = 'complete'
  AND audit_mode = 'bulk'
  AND crawl_data IS NOT NULL
ORDER BY updated_at DESC
LIMIT $maxLimit
```

**Per-site flow:**

1. SELECT the row.
2. Read `crawlData.pages` array.
3. For each page, run `classifyPageType(page.url)` (post-AC-3 fix logic).
4. Build a new `crawl_data` object with `pages[*].pageType` updated.
5. Compute the diff: how many pages changed from `"other"` to a structural type.
6. If `--commit`, UPDATE the row:
   ```sql
   UPDATE geo_sites
   SET crawl_data = $newCrawlData,
       updated_at = NOW()
   WHERE id = $siteId
   ```
7. Print summary: `[ok|dry-run] {siteId} {domain} → {n_changed} pages reclassified`

**AC-9 constraint:** the script MUST NOT trigger tree extraction or citation check. It only updates the `pageType` field on each page in `crawl_data.pages`. Downstream re-extraction is triggered separately via the citation-check lazy code path (ES-086 AC-15) or a manual re-run.

**Operator-only:** the script is NEVER invoked from application code, NEVER scheduled via cron, NEVER imported from CI. Place a `// OPERATOR-ONLY — do not invoke from application code` comment at the top of the file (per the same convention as ES-082's regenerate-empty-llms-txt.ts).

### b.4 Files summary

| Action | Path | LOC est. |
|---|---|---|
| **MODIFY** | `geo/app/api/pipeline/stage/route.ts` | +5, -1 (line 261 fix + AC-4 log) |
| **MODIFY** | `geo/lib/services/geo-crawler.ts` | +35, -10 (`classifyPageType` rewrite) |
| **CREATE** | `geo/scripts/reclassify-bulk-pagetype.ts` | ~180 |
| **MODIFY** | `geo/__tests__/services/geo-crawler.classify-page-type.test.ts` (or new file) | +250 (50+ URL fixture cases per AC-5) |
| **MODIFY** | `geo/__tests__/crawl-fanout.test.ts` | +30 (extend existing M-1..M-5 cases with bulk hardcoded "other" regression cases) |
| **CREATE** | `geo/__tests__/integration/pipeline/bulk-classifier-consistency.integration.test.ts` | ~150 (AC-1 / AC-11) |

**No DDL.** **No new dependencies.** **Manipal fixture file is SHARED with ES-086 AC-7.**

---

## c) Unit Test Plan

### c.1 URL pattern fallback — 50+ fixture cases (AC-3, AC-5, AC-10)

New test file: `geo/__tests__/services/geo-crawler.classify-page-type.test.ts` (or extend an existing file). Per HP-182, **every structural pattern MUST be tested in BOTH trailing-slash and non-slash form, asserting both forms produce the same classification.**

| # | Test category | Inputs | Expected |
|---|---|---|---|
| U1-U2 | `/about-us` trailing-slash variants | `/about-us/`, `/about-us` | both `about` |
| U3-U4 | `/about` trailing-slash variants | `/about/`, `/about` | both `about` |
| U5-U6 | `/contact-us` variants | `/contact-us/`, `/contact-us` | both `contact` |
| U7-U8 | `/contact` variants | `/contact/`, `/contact` | both `contact` |
| U9-U10 | `/specialities` variants | `/specialities/`, `/specialities` | both `services` |
| U11-U12 | `/specialties` variants | `/specialties/`, `/specialties` | both `services` |
| U13-U14 | `/services` variants | `/services/`, `/services` | both `services` |
| U15-U16 | `/products` variants | `/products/`, `/products` | both `services` |
| U17-U18 | `/team` variants | `/team/`, `/team` | both `team` |
| U19-U20 | `/pricing` variants | `/pricing/`, `/pricing` | both `pricing` |
| U21 | Homepage `/` (single slash, must NOT be stripped) | `https://example.com/` | `homepage` |
| U22 | Homepage empty (URL constructor returns `/`) | `https://example.com` | `homepage` |
| U23-U25 | Query string preserved | `/about-us?utm_source=email`, `/contact-us?ref=footer`, `/about?utm_campaign=launch` | `about`, `contact`, `about` |
| U26-U28 | Fragments preserved | `/about-us#leadership`, `/contact#form`, `/services#dermatology` | `about`, `contact`, `services` |
| U29 | Combined query + fragment + trailing slash | `/about-us/?utm_source=newsletter&utm_campaign=q1#leadership` | `about` |
| U30-U32 | Index.html variants | `/about/index.html`, `/services/index.htm`, `/about-us/index.html` | `about`, `services`, `about` |
| U33 | Double slash collapse with match | `//about-us/` | `about` |
| U34 | Double slash with no match | `/about//us/` | `other` (collapses to `/about/us`, no exact match) |
| U35-U37 | Case variants | `/About-Us/`, `/CONTACT/`, `/SPECIALITIES/` | `about`, `contact`, `services` |
| U38 | Multi-segment brand path | `/india/bangalore/about-us/` | `about` (city-specific brand about page — Manipal pattern) |
| U39-U41 | Subpath false positives — blog | `/blog/about-us-launch-q1`, `/blog/services-update`, `/news/contact-tracing` | `other`, `other`, `other` (NOT structural — blog post titles, not brand pages) |
| U42 | Subpath false positive — case study | `/case-studies/team-formation` | `case-studies` (matches /case-stud first, before /team substring; documentation: ScriptDev verifies the matcher order) |
| U43 | Subpath trailing slash | `/services/dermatology/` | `services` |
| U44-U46 | Existing matchers regression | `/blog/`, `/docs/`, `/faq/` | `blog`, `docs`, `faq` |
| U47-U49 | Legal patterns | `/privacy/`, `/terms-of-service/`, `/cookie-policy/` | `legal`, `legal`, `legal` |
| U50 | Unknown path | `/random-page` | `other` |
| U51 | Invalid URL fallback | `not-a-url` | `other` (catch block handles `new URL` throw) |
| U52-U54 | Special edge cases | `/about-us/#`, `https://EXAMPLE.com/SERVICES/`, `https://www.EXAMPLE.com/ABOUT-US/` | `about`, `services`, `about` |

**Total: 54 unit test cases.** Per AC-5: at least 50+ patterns, both trailing-slash and non-slash variants for every structural type.

### c.2 Existing crawl-fanout test extension (AC-1 / AC-11)

Extend `geo/__tests__/crawl-fanout.test.ts` with new test cases:

| # | Test | Setup | Assertion |
|---|---|---|---|
| U55 | mapDocumentToPage uses pageMap when populated | `pageMap = { "https://example.com/": "homepage" }`. Doc with url=`https://example.com/`. | Result has `pageType: "homepage"` |
| U56 | mapDocumentToPage falls back to classifyPageType when pageMap missing | `pageMap = {}`. Doc with url=`https://example.com/about-us/`. | Result has `pageType: "about"` (post-AC-3 normalization fires) |
| U57 | bulk pageMap is no longer hardcoded "other" | Mock `db.update` chain. POST stage `crawl-fanout` with `auditMode: "bulk"` and a bulk URL list of `["/", "/about-us", "/services/cardiology"]`. | The persisted `discoveryData.pageMap` has `"/" → "homepage"`, `"/about-us" → "about"`, `"/services/cardiology" → "services"` |

### c.3 Total unit tests: 57 (U1–U57)

---

## d) Integration Test Plan

New file: `geo/__tests__/integration/pipeline/bulk-classifier-consistency.integration.test.ts`

### d.1 Manipal fixture consistency (AC-1, AC-6)

Uses the SHARED Manipal fixture from `__tests__/fixtures/tree-extract-manipal.json` (created by ES-086 ScriptDev impl).

| # | Test | Setup | Assertion |
|---|---|---|---|
| IT1 | Bulk-mode classifier consistency on Manipal fixture | Load the 243-page Manipal fixture. Run `classifyPageType` against each page URL. Compute distribution. | **Hard target:** ≥ 90% of pages get a structural pageType (NOT `"other"`). Per AC-6. (Pre-fix: 1/243 ≈ 0.4%; post-fix target: ≥ 219/243 ≈ 90%.) |
| IT2 | Distribution sanity check | Same fixture | Distribution should resemble Aditya's single-mode crawl (~1 homepage, ~10-30 about variants, ~100-150 services pages). The exact target is informational; the hard gate is AC-6's 90%. |
| IT3 | Bulk-mode vs single-mode parity | Run the classifier in BOTH bulk and single mode (mock `discoverSite` for single mode if needed). | Both modes produce the same `pageType` for each URL. Per Hypothesis A/D resolution. |

### d.2 Bulk pipeline end-to-end (AC-11)

| # | Test | Setup | Assertion |
|---|---|---|---|
| IT4 | Bulk audit run produces classified pageMap | Insert a `geo_sites` row with `auditMode: "bulk"`, valid `bulkUrls`. POST `/api/pipeline/stage` with `stage: "crawl-fanout"`. | After `handleCrawlFanout` completes, the `discoveryData.pageMap` persisted to the row has structural pageTypes for the bulk URLs (NOT all `"other"`) |
| IT5 | Bulk run does NOT call discoverSite | Spy on `discoverSite`. Run IT4 setup. | `discoverSite` is NOT called (bulk path skips discover stage per the existing comment). The classification happens in `handleCrawlFanout` directly. |

### d.3 Backfill script integration test (AC-8)

| # | Test | Setup | Assertion |
|---|---|---|---|
| IT6 | reclassify-bulk-pagetype.ts dry-run does not modify DB | Insert 3 rows with bulk `crawl_data.pages[*].pageType === "other"`. Run script with no flags. | `db.update` not called. stdout lists 3 candidates with the planned diff. |
| IT7 | reclassify-bulk-pagetype.ts --commit updates pages | Same setup. Run with `--commit`. | All 3 rows have `crawl_data.pages[*].pageType` updated per the new classifier. Pre vs post diff matches the expected count. |
| IT8 | reclassify does NOT trigger tree extraction or citation check | Spy on `extractTrees` and `runCitationCheck`. Run with `--commit`. | Neither is called. Per AC-9. |
| IT9 | --site filter restricts SELECT to that site | Pass `--site abc123 --commit`. | The select call has `where(eq(geoSites.id, "abc123"))`. Other rows untouched. |

### d.4 Total integration tests: 9 (IT1–IT9)

---

## e) Profiling Requirements

Not applicable. Classification is a sub-millisecond pure function. The bulk pipeline already touches every URL exactly once.

The new AC-4 `classifier_fallback_other` log event (or summary count per chunk) is operator-facing only. **Expected:** the count drops sharply post-fix (from ~100% to ~10% on the Manipal fixture).

---

## f) Load Test Plan

Not applicable. No latency-bearing changes.

---

## g) Logging & Instrumentation

### g.1 New log events

| Event | Level | Source | Payload | Purpose |
|---|---|---|---|---|
| `classifier_fallback_other` | info | `pipeline/stage/route.ts` `handleCrawlFanout` | `{ event, domain, url }` | Track bulk URLs that don't match any structural pattern |
| `bulk_pagemap_classified` | info | same | `{ event, domain, total, structural, other }` | Per-chunk summary of classifier output (alternative to per-URL logging — ScriptDev's call) |
| `reclassify_bulk_pagetype_summary` | info | `scripts/reclassify-bulk-pagetype.ts` | `{ event, mode, eligible, reclassified, skipped, failed }` | Operator audit trail |

### g.2 No removed logs

All existing logs preserved.

---

## h) Acceptance Criteria

### h.1 Classifier alignment (TS-085 §3.1)

- [ ] **AC-1:** Bulk-mode classification consistency on the SHARED Manipal fixture from `__tests__/fixtures/tree-extract-manipal.json` (created by ES-086 ScriptDev impl). Hard target: ≥ 90% of pages get a structural pageType. Distribution sanity matches single-mode within an order of magnitude. Hypothesis-D status: **REJECTED as redundant** per SpecMaster recon (siteRoot is not currently used by classifyPageType and adding it would be net-new functionality). **Verified by:** IT1, IT2, IT3.
- [ ] **AC-2:** Investigation findings document ALL FOUR hypotheses (A/B/C/D from §2.3). Per HolePoker HP-170. ScriptDev MUST verify each hypothesis empirically with code references and a per-hypothesis verdict. **Per SpecMaster recon, the dominant cause is Hypothesis A** (bulk pageMap hardcoded to "other" at `pipeline/stage/route.ts:261`). The fix at §b.1 addresses this directly. **Verified by:** PR description verdict table.

### h.2 URL-pattern fallback (TS-085 §3.2)

- [ ] **AC-3:** URL-pattern fallback uses `new URL(href).pathname` semantics with the explicit 5-step normalization (per HP-171 + HP-182). **Verified by:** U1–U54 fixture cases.
- [ ] **AC-4:** Fallback classifier emits `classifier_fallback_other` log (or per-chunk summary `bulk_pagemap_classified`) at INFO level. **Verified by:** code review + IT4 log assertion.
- [ ] **AC-5:** Fallback rules unit-tested against an expanded fixture of 50+ URL patterns covering trailing-slash, query string, fragment, index.html, double-slash, case variants, and false-positive cases. Per HP-182, **every structural pattern MUST be tested in BOTH trailing-slash and non-slash form**. **Verified by:** U1–U54 (54 cases total).

### h.3 Regression coverage (TS-085 §3.3)

- [ ] **AC-6:** Per-URL classifier hard target: ≥ 90% structural on the Manipal fixture (raised from 50% per HP-172). **Verified by:** IT1.
- [ ] **AC-7:** Regression test for the 9 sites with the legacy stem pattern (per the TS-081 backfill discovery). The reclassification does not break their existing trees. **Verified by:** IT8 (reclassify script does not trigger downstream re-extraction, so existing trees are unaffected).

### h.4 Backfill (TS-085 §3.4)

- [ ] **AC-8:** Backfill script `geo/scripts/reclassify-bulk-pagetype.ts` exists with the §b.3 CLI surface. Idempotent (re-running on already-classified data is a no-op). Dry-run by default. `--commit` gate. Operator-only. **Verified by:** IT6, IT7, IT9.
- [ ] **AC-9:** The backfill script does NOT trigger tree extraction or citation check — it only updates `pageType` on each page in `crawl_data.pages`. **Verified by:** IT8.

### h.5 Test coverage (TS-085 §3.5)

- [ ] **AC-10:** Unit tests for the URL pattern fallback (AC-5). **Verified by:** U1–U54.
- [ ] **AC-11:** Integration test for bulk vs single-mode classification consistency. **Verified by:** IT3, IT4.
- [ ] **AC-12:** Manipal-row regression test using the SHARED fixture from ES-086 AC-7. **Verified by:** IT1.

### h.6 Cross-cutting

- [ ] **AC-13:** No new dependencies. No DDL migrations.
- [ ] **AC-14:** Branch is `fix/tree-extractor-and-bulk-audit` (shared sprint branch).
- [ ] **AC-15:** ES-085 ScriptDev tasks BLOCK on ES-086 ScriptDev tasks completing first because ES-085 consumes the Manipal fixture file that ES-086 creates. CostMaster taskboard reflects this dependency.

### h.7 Done definition

ES-085 is **done** when:

1. All 15 ACs are checked
2. ReviewMaster Phase A delivers test scaffolding for the 57 unit + 9 integration tests
3. ScriptDev's commit modifies `pipeline/stage/route.ts:261` (Hypothesis A fix) AND `geo-crawler.ts:153-163` (URL pattern fallback)
4. The Manipal fixture (created by ES-086) is consumed by IT1
5. The backfill script ships with the operator-only header comment
6. Per-hypothesis verdict table is in the PR description

---

## Notes for downstream agents

### For ReviewMaster (Phase A)

1. **Test count:** 57 unit + 9 integration. Mid-size spec.
2. **Use distinct fixture identifiers** — never the literal `-GzFX1KcKhmN0W_1t8SmY`.
3. **The Manipal fixture is SHARED with ES-086 AC-7.** Your IT1/IT2/IT3 tests CONSUME the fixture; ScriptDev's ES-086 work CREATES it. Phase A test files for ES-085 may need to wait for ScriptDev to land the fixture, or use a synthetic placeholder until then. Coordinate via the ScriptDev brief.
4. **U1-U54 is the bulk of the work** — 54 fixture cases for the URL pattern fallback. Per HP-182, both trailing-slash and non-slash forms must be tested for every structural type.
5. **IT1's 90% hard target** is the critical regression gate. Per AC-6, the post-fix Manipal classifier output must be ≥ 90% structural.

### For CostMaster

1. **Files (CREATE):** 2 (`reclassify-bulk-pagetype.ts` script, `bulk-classifier-consistency.integration.test.ts`)
2. **Files (MODIFY):** 3 (`pipeline/stage/route.ts` line 261, `geo-crawler.ts` classifyPageType, existing crawl-fanout test)
3. **NEW unit test file (or modify existing):** `geo-crawler.classify-page-type.test.ts` (~250 LOC, 54 cases)
4. **Total LOC est.:** ~220 (impl) + ~430 (tests) = ~650
5. **No new dependencies, no DDL, no env vars.**
6. **Branch:** shared sprint branch
7. **Lang:** `typescript`
8. **CRITICAL DEPENDENCY:** ScriptDev tasks BLOCK on ES-086 ScriptDev tasks completing first (Manipal fixture consumption). Document in T-task `blocked_by` field.
9. **Hypothesis A fix is the dominant change** — 1 line at `pipeline/stage/route.ts:261`. Don't bury this in a "URL pattern fallback" task; call it out as the primary fix.

### For CoFounder

1. **SpecMaster recon validates Hypothesis A as the dominant root cause** — bulk pageMap hardcoded to `"other"` at `pipeline/stage/route.ts:261`. The classifier was never being called for bulk URLs. Single mode runs `discoverSite` which classifies properly.
2. **Hypothesis D (siteRoot threading) is rejected as redundant** — `classifyPageType` does not currently take a `siteRoot` argument; adding one would be net-new functionality, not a fix. The function builds paths from `new URL(url).pathname` which is already domain-relative.
3. **The fix is one line** at `pipeline/stage/route.ts:261` (Hypothesis A) plus the URL pattern fallback rewrite of `classifyPageType` (AC-3). Both small.
4. **Manipal fixture file is shared with ES-086** — coordinate ScriptDev task ordering (ES-086 creates, ES-085 consumes).
5. **Per AC-2 ScriptDev still verifies all 4 hypotheses** before committing, per the original spec. My recon is a starting point, not a substitute.

---

**End of ES-085**
