# TS-085 — Bulk audit pageType classifier under-classification regression

**Author:** CoFounder (Agent 1)
**Date:** 2026-04-09
**Priority:** P1 — affects every bulk audit customer; downstream multiplier on dimensional outputs
**Scope:** GEO app — crawl pipeline (`lib/services/geo-crawler.ts` mapDocumentToPage, possibly chunked-crawl path)
**Related:** TS-083, TS-084, TS-086 (sibling bulk-audit improvements)
**Status:** AMENDED 2026-04-09 (round 3) per HolePoker findings HP-170 / HP-171 / HP-172 / HP-182 + SpecMaster ES-085 recon (Hypothesis A confirmed dominant + pathHasSegment correction); DISPATCHED TO SCRIPTDEV

---

## 1. What

In bulk audit mode, the pageType classifier marks the vast majority of crawled pages as `pageType: "other"`. In single-domain audit mode, the same URLs get correctly classified as `about` / `homepage` / `services` / etc. This is a regression in the bulk-audit code path that breaks downstream consumers (the tree extractor's structural-page prioritization, the citation prompt generator's anchor pages).

This spec aligns the pageType classification logic between bulk and single-domain modes and adds URL-pattern-based fallback classification.

## 2. Why

### 2.1 Concrete evidence (Manipal customer vs Aditya test site)

Same domain (`manipalhospitals.com`), two crawls:

| Site | Mode | `pageType="homepage"` | `pageType="about"` | `pageType="other"` |
|---|---|---|---|---|
| Manipal customer (`-GzFX1KcKhmN0W_1t8SmY`) | bulk | 1 | **1** | **241** |
| Aditya test (`s8nbVx-w_XAf9Hzni_FBU`) | single | 6 | **91** | **1** |

The customer's bulk crawl has the page `https://www.manipalhospitals.com/bangalore/about-us/` with `title: "About Manipal Hospitals, Bangalore India"` — but it's classified as `pageType: "other"`. Aditya's single audit had similar URLs classified as `pageType: "about"`.

### 2.2 Why it cascades

The tree extractor at `lib/services/tree-extractor.ts:28` uses:
```ts
const STRUCTURAL_TYPES = new Set(["homepage", "about", "services", "pricing", "team", "contact"]);
```

It builds the LLM inventory by sorting structural pages first, then capping at 200 entries. When 241/243 pages are "other", the inventory is mostly undifferentiated content. Even after TS-086's LLM bug is fixed, the LLM has weaker signal to anchor on.

Empirical observation from this session: bumping the LLM token budget (TS-086) helped because the LLM falls back on URL pattern matching when pageType is "other" — but native pageType labels would have produced richer trees with less LLM cost.

### 2.3 The classifier divergence

Four hypotheses (D added 2026-04-09 per HolePoker HP-170):
- **Hypothesis A:** the bulk-mode crawl path uses a different (newer/buggier) classifier than single-mode
- **Hypothesis B:** the same classifier runs in both modes but bulk-mode passes different inputs (e.g., empty H1, missing headings due to chunked crawl quality)
- **Hypothesis C:** the bulk-mode firecrawl batch jobs return less metadata per page, starving the classifier
- **Hypothesis D (NEW per HP-170):** the bulk-mode classifier is invoked WITHOUT a `siteRoot` parameter that the single-mode classifier passes implicitly. Single-mode crawls discover URLs by following links from the homepage, so the classifier knows the site root context (`https://www.manipalhospitals.com/`) and can pattern-match relative-to-root paths like `/bangalore/about-us/` against canonical brand patterns. Bulk-mode receives an unordered URL list and may not have siteRoot resolved at classification time, so the classifier can only see the absolute URL and falls back to `"other"` for any path that doesn't trivially match a hard-coded pattern.

  HolePoker observed the bulk-mode classifier signature in `lib/services/geo-crawler.ts` mapDocumentToPage and noted that `siteRoot` is either passed empty or computed locally per-page rather than threaded through from the bulk audit input. This is the strongest hypothesis given the empirical evidence (single-mode classifies 91/98 as `about` for the same domain that bulk-mode classifies 1/243 — that's not a metadata gap, that's a context gap).

Investigation step (part of ScriptDev work in this TS): instrument the classifier in both modes against the same URL to identify which hypothesis holds. **ScriptDev MUST verify ALL FOUR hypotheses (A/B/C/D) before implementing the fix** (per AC-2). Multiple hypotheses may hold simultaneously; the fix must address each one that empirically contributes.

### 2.4 Hypothesis A confirmed dominant — SpecMaster ES-085 recon (NEW 2026-04-09 round 3)

SpecMaster's recon during ES-085 writing validated **Hypothesis A as the dominant root cause**. At `app/api/pipeline/stage/route.ts:261`, the bulk fanout has:

```ts
for (const url of urlsToProcess) pageMap[url] = "other";
```

This **HARDCODES every bulk URL to `"other"`** — the classifier (`classifyPageType` at `lib/services/geo-crawler.ts:153-163`) is NEVER invoked for bulk URLs. The deprecated `lib/pipeline/runner.ts:43` (the OLD bulk path that was migrated away from) used `classifyPageType(url)` correctly. **The regression was introduced when the bulk path migrated from `runner.ts` to `handleCrawlFanout` in `pipeline/stage/route.ts`** — the new code path never wired the classifier in.

**Impact:** every bulk audit since the migration has produced 100% `pageType: "other"` for the customer's input URLs. The 1-2 structural pages observed in §2.1 came from the discoveryData layer (not the bulk URL classifier). Aditya's single-mode test site uses a different code path (single-domain crawl with link discovery) that DOES invoke the classifier — explaining the 91/98 `about` classification gap between bulk-mode (1/243 about) and single-mode (91/98 about).

**Hypothesis D rejected per ES-085 recon:** `classifyPageType` doesn't currently take a `siteRoot` argument; adding one would be net-new functionality, not a fix for the regression. The siteRoot context observation was speculative; the actual missing wiring is far simpler — just invoke the existing classifier on each bulk URL.

**Hypothesis A fix surface:** a 1-line change at `pipeline/stage/route.ts:261` to invoke `classifyPageType(url)` on each bulk URL instead of hardcoding `"other"`. Documented as ES-085 §b.1.

The AC-3 URL pattern fallback is still required as the secondary fix (for bulk URLs that the primary classifier returns `"other"` for — e.g., city-specific brand pages like `/bangalore/about-us/` that the pattern-based `classifyPageType` may not recognize without the fallback). **The fallback is the safety net; the primary classifier wiring is the dominant fix.**

Hypothesis B + C remain valid investigation paths but are likely subordinate to A. ScriptDev still verifies all 4 per AC-2 — multiple hypotheses can hold simultaneously.

### 2.4 Hypothesis A confirmed dominant — SpecMaster ES-085 recon (NEW 2026-04-09 round 3)

SpecMaster's recon during ES-085 writing validated **Hypothesis A as the dominant root cause** (and rejected D as redundant). At `app/api/pipeline/stage/route.ts:261`, the bulk fanout has:

```ts
for (const url of urlsToProcess) pageMap[url] = "other";
```

This **HARDCODES every bulk URL to `"other"`** — the classifier (`classifyPageType` at `lib/services/geo-crawler.ts:153-163`) is NEVER invoked for bulk URLs. The deprecated `lib/pipeline/runner.ts:43` (the OLD bulk path that was migrated away from) used `classifyPageType(url)` correctly. **The regression was introduced when the bulk path migrated from `runner.ts` to `handleCrawlFanout` in `pipeline/stage/route.ts`** — the new code path never wired the classifier in.

**Impact:** every bulk audit since the migration has produced 100% `pageType: "other"` for the customer's input URLs (the 1-2 structural pages observed in §2.1 came from the discoveryData layer, not from the bulk URL classifier). Aditya's single-mode test site uses a different code path (single-domain crawl with link discovery) that does invoke the classifier — explaining the 91/98 `about` classification gap.

**Hypothesis D rejected per ES-085 recon:** `classifyPageType` doesn't currently take a `siteRoot` argument; adding one would be net-new functionality, not a fix for the regression. The siteRoot context observation was speculative; the actual missing wiring is far simpler.

**Hypothesis A fix surface:** a 1-line change at `pipeline/stage/route.ts:261` to invoke `classifyPageType(url)` on each bulk URL instead of hardcoding `"other"`. Documented as ES-085 §b.1.

The AC-3 URL pattern fallback is still required as the secondary fix (for bulk URLs that the primary classifier returns `"other"` for). The fallback is the safety net; the primary classifier wiring is the dominant fix.

Hypothesis B + C remain valid investigation paths but are likely subordinate to A. ScriptDev still verifies all 4 per AC-2 — multiple hypotheses can hold.

## 3. Acceptance criteria

### 3.1 Classifier alignment

- [ ] **AC-1: Bulk-mode classification consistency on the shared Manipal fixture.** Per HolePoker HP-172. ScriptDev runs the classifier against the Manipal fixture **shared with TS-086 AC-7** at `__tests__/fixtures/tree-extract-manipal.json` (single source of truth — DO NOT create a parallel 20-URL synthetic fixture). The Manipal fixture contains the actual 243-page production crawl_data. The test asserts:
  1. **Hard target: ≥90% of pages get a structural pageType** (not `"other"`). The current bulk-mode result is ~1% structural (1/243 about) — the fix must move this to ≥90%.
  2. The hypothesis-D fix (passing siteRoot through to mapDocumentToPage) closes the gap between bulk-mode and single-mode classification on the same URLs.
  3. Distribution sanity: the post-fix distribution should resemble Aditya's single-mode crawl (~1 homepage, ~10-30 about variants, ~100-150 services pages, ~50-70 other) — not necessarily identical, but in the same order of magnitude.
- [ ] **AC-2: Investigation findings document ALL FOUR hypotheses (A/B/C/D from §2.3).** Per HolePoker HP-170. ScriptDev MUST verify each hypothesis empirically with code references and a per-hypothesis verdict (confirmed / refuted / not-applicable). The fix surface must address each confirmed hypothesis. A bare "Hypothesis D was the cause" is INSUFFICIENT — multiple hypotheses can hold simultaneously and the fix must close every empirically-confirmed gap.

### 3.2 URL-pattern fallback

- [ ] **AC-3: URL-pattern fallback uses `new URL(href).pathname` semantics, not substring matching.** Per HolePoker HP-171 + HP-182. A URL-pattern-based fallback classifier runs AFTER the primary classifier but BEFORE persisting `pageType`. If the primary classifier returns `"other"` AND the URL matches a known structural pattern, the fallback overrides. **The matcher MUST parse the URL via the WHATWG URL constructor and inspect `.pathname` only**, with explicit normalization:

  1. `const u = new URL(href)` — drops query string and fragment
  2. `let path = u.pathname.toLowerCase()` — case fold first so subsequent regexes work uniformly
  3. `path = path.replace(/\/index\.html?$/, "/")` — `/about/index.html` becomes `/about/`
  4. `path = path.replace(/\/{2,}/g, "/")` — collapse double slashes (e.g., `/about//us/` → `/about/us/`)
  5. **Strip the trailing slash UNLESS the path is just `/`:**
     ```ts
     if (path !== "/") path = path.replace(/\/+$/, "");
     ```
     This handles the canonical CMS form (`/about-us/` → `/about-us`) so the matchers below work. Per HolePoker HP-182: the prior wording collapsed multiple slashes to a single trailing slash but did NOT strip it, so `endsWith("/about-us")` always failed for the canonical CMS form. **This is the most common case on real-world sites and was the load-bearing miss in round 1.** The strip preserves the homepage signal (`/` stays `/`).
  6. **Now match the normalized `path` using `pathHasSegment` (NOT raw substring matching) — AMENDED 2026-04-09 round 3 per SpecMaster ES-085 recon:**

     The matcher MUST use a helper that requires the matched segment be followed by `/` or end-of-string, NOT a raw `String.prototype.includes()`. The original draft used `path.includes("/team")` and `path.includes("/services")` which has a false-positive surface:
     - `/case-studies/team-formation` → `path.includes("/team")` is `true` → wrong (should be `other`)
     - `/blog/services-update` → `path.includes("/services")` is `true` → wrong (should be `other`)
     - `/news/contact-tracing` → `path.includes("/contact")` is `true` → wrong (should be `other`)

     `pathHasSegment` helper definition (inline in the classifier file, NOT a shared helper — per the same INLINE pattern as TS-086 AC-15 `treeIsEmpty`):

     ```ts
     function pathHasSegment(path: string, segment: string): boolean {
       const idx = path.indexOf(segment);
       if (idx === -1) return false;
       const after = path[idx + segment.length];
       return after === undefined || after === "/";
     }
     ```

     Matcher list using `pathHasSegment`:
     - `path === "/"` → `homepage`
     - `path.endsWith("/about-us")` or `path.endsWith("/about")` → `about`
     - `path.endsWith("/contact-us")` or `path.endsWith("/contact")` → `contact`
     - `pathHasSegment(path, "/specialities")` or `/specialties` or `/services` or `/products` → `services`
     - `pathHasSegment(path, "/team")` or `/leadership` or `/doctors` or `/staff` or `/people` → `team`

     `endsWith` is preserved for the `about` and `contact` matchers because those patterns are typically the LAST segment of the URL path (the brand `/about-us` is `/about-us`, not `/about-us/something-else`). `pathHasSegment` is used for matchers where the structural segment can appear in the middle of a longer path (`/india/bangalore/specialities/cardiology` should still match `services` via the `/specialities` segment).

  **Empirical examples (verify these explicitly in AC-5 fixture):**
  | Input href | After normalization | Matched type |
  |---|---|---|
  | `https://www.manipalhospitals.com/bangalore/about-us/` | `/bangalore/about-us` | `about` |
  | `https://www.manipalhospitals.com/specialities/cardiology/` | `/specialities/cardiology` | `services` |
  | `https://example.com/contact-us` | `/contact-us` | `contact` |
  | `https://example.com/contact-us/?utm_source=newsletter` | `/contact-us` | `contact` |
  | `https://example.com/about/index.html` | `/about` | `about` |
  | `https://example.com/about/#leadership` | `/about` | `about` |
  | `https://example.com/` | `/` | `homepage` |
  | `https://example.com//about-us//` | `/about-us` | `about` |
  | `https://example.com/blog/about-us-launch-q1/` | `/blog/about-us-launch-q1` | `other` (NOT about — endsWith match fails) |

  Rationale per HP-171: substring matching fails on UTM-tagged URLs (`/about-us?utm_source=email&utm_campaign=q1` would NOT match `endsWith("/about-us")` if the tester used `href.endsWith(...)` instead of `pathname.endsWith(...)`), URL fragments (`/about-us#leadership`), index.html variants (`/about/index.html`), and case variants. WHATWG URL parsing handles all of these consistently.

  Rationale per HP-182: the round-1 normalization preserved trailing slashes, breaking matchers on the canonical CMS form. Step 5 strips them so the matchers actually fire on `/about-us/`, `/specialities/`, etc.
- [ ] AC-4: The fallback classifier is logged at INFO level with the original classification and the new one: `[classifier-fallback] url=X primary=other → fallback=about`. Helps quantify how often the fallback fires.
- [ ] **AC-5: Fallback rules unit-tested against an expanded fixture of 50+ URL patterns** covering all listed cases plus the edge cases HolePoker raised. **Per HP-182, EVERY structural pattern MUST be tested in BOTH trailing-slash and non-slash form, asserting both forms produce the same classification:**
  - **Trailing-slash variants (load-bearing — HP-182):**
    - `/about-us/` → `about` AND `/about-us` → `about` (both must pass)
    - `/contact-us/` → `contact` AND `/contact-us` → `contact`
    - `/specialities/` → `services` AND `/specialities` → `services`
    - `/services/` → `services` AND `/services` → `services`
    - `/team/` → `team` AND `/team` → `team`
    - `/` → `homepage` (single-slash homepage signal preserved — must NOT be stripped)
  - **Query strings:** `/about-us?utm_source=email&utm_campaign=launch`, `/contact-us?ref=footer`
  - **Fragments:** `/about-us#leadership`, `/contact#form`
  - **Combined query + fragment + trailing slash:** `/about-us/?utm_source=newsletter&utm_campaign=q1#leadership`
  - **Index.html variants:** `/about/index.html`, `/services/index.htm`, `/about-us/index.html`
  - **Double slashes:** `/about//us/` (collapses to `/about/us`, no match), `//about-us/` (collapses to `/about-us`, matches `about`)
  - **Case variants:** `/About-Us/`, `/CONTACT/`, `/SPECIALITIES/`
  - **Multi-segment brand paths:** `/india/bangalore/about-us/` → still `about` (city-specific brand about page — Manipal pattern)
  - **Subpath false positives that should NOT match:**
    - `/blog/about-us-launch-q1` → `other` (NOT `about` — about-us is a path component within blog, not the brand /about-us page)
    - `/blog/services-update` → `other`
    - `/news/contact-tracing` → `other`
    - `/case-studies/team-formation` → `other`
  - **Edge cases:**
    - Empty pathname (`https://example.com` → URL constructor returns pathname `"/"`) → `homepage`
    - Trailing slash on subpath: `/services/dermatology/` → `services` (the includes-match catches `/services` after step 5 strips the trailing slash)

### 3.3 Regression coverage

- [ ] AC-6: Unit test against the Manipal test row's 243 pages (the SHARED fixture from TS-086 AC-7 — see AC-1). Expected post-fix distribution: ~1 homepage, ~10-30 about (city-specific about-us pages), ~100-130 services (specialty pages), ~50-70 other (blog posts). **Hard target: at least 90% of pages get a structural type, not `"other"`** (raised from 50% per HP-172 — the empirical single-mode result is 99% structural; 90% is a realistic floor that accounts for genuine "other" pages like blog posts).
- [ ] AC-7: Regression test for the 9 sites with the legacy stem pattern (per the TS-081 backfill discovery). The reclassification should not break their existing trees.

### 3.4 Backfill consideration

- [ ] AC-8: A separate backfill script `geo/scripts/reclassify-bulk-pagetype.ts` is provided (similar pattern to TS-081's T226/T227 backfill scripts). It re-classifies pageTypes on existing geo_sites rows by re-running the classifier (or applying the new fallback rules) against existing crawl_data. Idempotent, dry-run by default. Operator-only.
- [ ] AC-9: The backfill script does NOT re-trigger tree extraction or citation check — it only updates the `pageType` field on each page in `crawl_data.pages`. Downstream re-extraction is triggered separately via the citation-check lazy code path or a manual re-run.

### 3.5 Test coverage summary

- [ ] AC-10: Unit tests for the URL pattern fallback (AC-5).
- [ ] AC-11: Integration test for bulk vs single-mode classification consistency (AC-1).
- [ ] AC-12: Manipal-row regression test (AC-6) — uses the test row crawl_data.

## 4. Out of scope

- **TS-086** (tree extractor LLM bug) — must ship first.
- **TS-083** (auto-discover brand pages) — sibling enhancement.
- **TS-084** (timing race).
- **Re-architecting the firecrawl page metadata extraction** — if Hypothesis C is correct, the fix is to enrich the chunked-crawl metadata, not to replace firecrawl. Stay in scope of `lib/services/geo-crawler.ts`.
- **AI-based pageType classifier** — keep the rule-based approach. LLM-based classification adds cost and latency.

## 5. Risks

### 5.1 Reclassifying existing sites changes their tree extraction

If the backfill script (AC-8) is run against existing sites, and TS-086 is also live, those sites' next citation check will trigger lazy re-extraction with new pageType labels → new tree → new dimensional outputs on the dashboard.

**Mitigation:** the backfill is operator-only and dry-run by default. Customer comms can warn that "we improved your audit categorization; your dashboard now shows additional dimensional data."

### 5.2 False positives in URL pattern fallback

A URL like `https://example.com/about/some-team-member-bio` might match `/about/` and get classified as `about` when it's really a team profile. **Mitigation:** the fallback only fires when the primary classifier returned `"other"` — sites with working classifiers are unaffected. False positives degrade gracefully (a "team profile" classified as "about" is better than "other").

### 5.3 Aditya's site classified everything as "about" (91/98)

Aditya's single-audit `manipalhospitals.com` crawl classified 91 of 98 pages as "about". That's likely an over-classification too — many of those are probably specialty pages that should be "services". But the fact that the OVER-classifier produces good downstream results suggests the current STRUCTURAL_TYPES prioritization in the tree extractor is forgiving.

**Mitigation:** the new fallback uses tighter URL patterns (`/specialities/` → `services`, not `about`) which should produce more accurate labels than the over-eager single-mode classifier.

### 5.4 Unknown root cause (Hypothesis A/B/C)

We don't know yet whether the divergence is in the classifier code itself (A), the input data (B), or firecrawl metadata (C). The fix may need to address multiple hypotheses.

**Mitigation:** AC-2 mandates a documented investigation. ScriptDev surfaces findings before implementing the fix.

## 6. Open questions

- **Q1: Backfill rollout strategy?** Run the reclassifier once across all bulk-audit sites with `pipeline_status = 'complete'` and `audit_mode = 'bulk'`? Or only on customer-flagged sites? Recommend: ship the script as operator-only (`--commit` gate); decide rollout per case.
- **Q2: Should the URL pattern fallback be configurable per vertical?** E.g., healthcare sites might need different patterns than retail. Recommend: ship a static union for v1, add vertical-aware rules later if needed.

## 7. Cross-reference

- TS-086 (must ship first)
- TS-083 (sibling — auto-discover brand pages)
- TS-084 (sibling — timing race)
- ES-053 (tree extraction spec)
- ES-005 (M2 bulk CSV audit spec)

---

**End of TS-085.**
