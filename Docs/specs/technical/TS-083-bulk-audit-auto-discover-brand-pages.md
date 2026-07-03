# TS-083 — Bulk audit must auto-discover brand-level pages

**Author:** CoFounder (Agent 1)
**Date:** 2026-04-09
**Priority:** P1 — improves dimensional richness for every bulk audit customer; not gating Manipal customer (which is unblocked by TS-086)
**Scope:** GEO app — bulk audit pipeline (`lib/services/geo-crawler.ts`, `lib/pipeline/runner.ts`, possibly `app/api/sites/route.ts`)
**Related:** TS-084, TS-085, TS-086 (sibling bulk-audit improvements; TS-086 is the dominant root cause; TS-083 is a follow-up enhancement)
**Status:** AMENDED 2026-04-09 (round 2) per HolePoker findings HP-173 / HP-174 / HP-175 / HP-176 / HP-183 + observation O-3; READY FOR RE-DISPATCH

---

## 1. What

When a customer uploads a fixed URL list for a bulk audit, the GEO pipeline currently crawls ONLY those URLs. If the list misses brand-level anchor pages (homepage, brand about-us, services index, locations index, contact), downstream extractors lose canonical brand context and produce weaker dimensional outputs even after TS-086's tree extractor fix.

This spec adds an **auto-discovery layer** that detects the input domain root from the customer's URL list and crawls a small set of brand-level anchor pages alongside the user list. These auto-discovered pages do not count against the user's bulk URL credit budget (operational overhead).

## 2. Why

### 2.1 Concrete evidence (from Manipal customer)

The Manipal customer (`-GzFX1KcKhmN0W_1t8SmY`) uploaded a 255-URL bulk audit. None of those URLs included:
- `https://www.manipalhospitals.com/` (homepage)
- `https://www.manipalhospitals.com/about-us/` (brand-level about, not city-specific)

The customer's deep-page coverage was rich (city blogs, specialty pages, doctor pages) but the brand-level identity layer was missing. Even after TS-086's tree extractor fix, the extracted geo_tree only identified Bangalore (because the bulk URL list was Bangalore-heavy) — Delhi, Kolkata, Mumbai, Pune, etc., where Manipal also operates, were absent.

### 2.2 Aditya's manual single-domain audit (`s8nbVx-w_XAf9Hzni_FBU`) for the same domain produced:

- 5 cities in geo_tree (Bangalore, Karnataka, Delhi, India, Kolkata)
- 7 categories in category_tree (rich healthcare specialties)
- Real `pillar_visibility` values (19-50 across all 7 pillars)

The difference is the single-domain crawl reached the homepage and brand about-us via link discovery; the bulk audit's fixed list did not.

### 2.3 The systemic pattern

Querying production for sites with `research_data.topCompetitors > 0 AND discovered_competitors = 0`:

| Site | Owner | Pattern |
|---|---|---|
| Manipal customer | manipal.appiness@gmail.com | top=3, dc=0 |
| amnic.com | abhilash@amnic.com | top=4, dc=0 |
| breathpod.com | vinod@moshimoshi.in | top=3, dc=0 |
| godaddy.com | (anonaddy) | top=4, dc=0 |
| flowerlyco.com | (anonaddy) | top=3, dc=0 |
| medium.com (multiple owners) | (anonaddy) | top=3, dc=0 |

At least 6+ recent customer sites are silently affected. The customer journey: bulk upload → fixed URL list → audit completes → dashboard shows partial data → customer wonders why competitors look empty.

## 3. Acceptance criteria

### 3.1 Auto-discovery rules

- [ ] AC-1: At bulk audit kickoff, the pipeline detects the input domain root from the first valid URL in the customer's list (e.g., `https://www.manipalhospitals.com/...` → root `https://www.manipalhospitals.com`).
- [ ] AC-2: The pipeline probes a fixed list of brand-level URL patterns against the detected root using **`GET` with `Range: bytes=0-0`** (NOT `HEAD`). Rationale per HolePoker HP-173: many sites — including CDN-fronted, WAF-protected, and certain WordPress / Cloudflare configurations — respond `405 Method Not Allowed` to `HEAD` requests while accepting `GET`. Range-restricted `GET` keeps the bandwidth cost effectively the same as HEAD while accepting the broadest server compatibility. Pattern list:
  - `/` (homepage)
  - `/about-us/`, `/about-us`, `/about/`, `/about`
  - `/services/`, `/specialities/`, `/specialties/`, `/products/`
  - `/locations/`, `/clinics/`, `/hospitals/`, `/branches/`
  - `/contact-us/`, `/contact/`
  - `/team/`, `/leadership/`, `/doctors/`
- [ ] AC-3: A probe is considered successful and added to the crawl list if **either**:
  1. The response is HTTP 200 (or 206 Partial Content from the Range request), OR
  2. The response is a 3xx redirect (301/302/307/308), the redirect chain resolves to a 200/206 within **5 hops** (raised from 3 per HolePoker observation O-3 — HTTP→HTTPS→www→canonical-path chains commonly hit 4 hops), AND the FINAL post-redirect URL is recorded in the crawl list (not the original probe URL).

  4xx/5xx (excluding 405 if the underlying `GET` succeeds) are silently dropped. Per HolePoker HP-174: many brand domains respond to `/about` with `301 → /about-us/`; without explicit redirect handling these sites silently drop their canonical brand pages from the audit. Hop limit prevents redirect loops.
- [ ] **AC-4: Auto-discovered URLs are deduped against the customer's input list using post-redirect canonical URLs.** Per HP-174 companion + HP-183. The fetcher canonicalizes BOTH the input URL and the resolved-redirect URL using **inline normalization steps** (NOT a shared helper file — the round-1 reference to `lib/services/url-canonical.ts` was a fabricated path, that file does not exist in the codebase, per HolePoker HP-183). The inline canonicalization MUST be **identical** to TS-085 AC-3 step 1-5 to guarantee semantic consistency between the two specs:

  ```ts
  function canonicalizeUrl(href: string): string {
    const u = new URL(href);
    let path = u.pathname.toLowerCase();
    path = path.replace(/\/index\.html?$/, "/");
    path = path.replace(/\/{2,}/g, "/");
    if (path !== "/") path = path.replace(/\/+$/, "");
    // Return origin + canonical path (drop query string and fragment per the URL constructor)
    return `${u.origin.toLowerCase()}${path}`;
  }
  ```

  Then dedup is a simple Set-based comparison: probe URLs whose `canonicalizeUrl(...)` matches any canonicalized URL in the customer's input list are dropped. This prevents `/about` (probe input → resolved to `/about-us/`) being added twice when `/about-us/` is already in the user's list. Origin lowercase ensures case-insensitive host matching (`www.MANIPALHOSPITALS.COM` and `www.manipalhospitals.com` are the same site).

  **Schema/file verification (per CLAUDE.md spec rigour rule, 2026-04-09):** `lib/services/url-canonical.ts` does NOT exist in the codebase. Round 1 of this AC referenced it as if it did — that was a fabricated path. The amended AC inlines the normalization to avoid the dangling reference and to keep TS-083 + TS-085 in lockstep without introducing a shared helper file (which would be scope expansion).
- [ ] AC-5: Auto-discovered URL count is capped at 12 to prevent unbounded crawl bloat.

### 3.2 Credit accounting

- [ ] AC-6: Auto-discovered pages do NOT count against the customer's `bulk_url_count` budget. They are operational overhead.
- [ ] **AC-7: Auto-discovered pages do NOT count against the customer's `monthly_pages_used` (tier page limit) either.** **REVERSED 2026-04-09 per HolePoker HP-175.** Rationale: a customer at 99/100 monthly pages used who runs a bulk audit of 1 URL would have the audit FAIL mid-pipeline if 12 auto-discovered pages pushed them to 112/100. Counting these against the tier limit creates a silent double-charge at the boundary and degrades the audit experience precisely for the customers with the tightest budgets. Auto-discovery is operational enrichment for OUR data quality, not a customer-billable consumption. The cost (~12 firecrawl pages × ~$0.005 = ~$0.06 per audit) is absorbed by Flowblinq.
- [ ] AC-8: A new field `auto_discovered_url_count` on `geo_sites` tracks how many auto-discovered URLs were added to the crawl. This is informational only, not credit-billing.

### 3.3 Pipeline integration

- [ ] AC-9: Auto-discovery runs BEFORE crawl-fanout (in the `discover` stage or as a new sub-stage).
- [ ] **AC-10: Auto-discovery latency budget: 8 seconds total** (12 parallel `GET` requests with 2s per-request timeout, fail-soft). **AMENDED 2026-04-09 per HolePoker HP-176.** The original 5s/1s budget was tight on cold-DNS lookups, HTTP/1.1 sites without keep-alive, and TLS handshake overhead for sites the Vercel function has not contacted recently. 8s/2s gives a realistic safety margin without making auto-discovery a perceptible part of the audit kickoff latency.
- [ ] AC-11: If the entire auto-discovery layer throws (network outage, timeout), the bulk audit proceeds with the original URL list. No fail-stop.

### 3.4 Customer-visible

- [ ] AC-12: The audit completion email mentions auto-discovered pages: *"We also crawled N brand-level pages (homepage, about-us, services index) to enrich your audit."*
- [ ] AC-13: The dashboard shows a small badge or info note: *"N additional brand pages auto-discovered"* on the audit summary.

### 3.5 Test coverage

- [ ] AC-14: Unit test for the URL pattern probe function. Mock HTTP responses including 200, 206, 301→200, 302→302→200, 4xx, 5xx, 405 (HEAD-rejecting servers), and redirect loops (>3 hops). Verifies that 200/206/successful-redirects are kept and 4xx/5xx/loops are dropped.
- [ ] **AC-15: Integration test fixture explicitly includes redirect-bearing URLs.** Per HolePoker HP-174 companion. Fixture cases:
  - `/about` → `301` → `/about-us/` → `200`  (canonical redirect)
  - `/services` → `302` → `/services/` → `200`  (trailing-slash redirect)
  - `/products` → `301` → `/products` → `301` → loop  (asserted dropped)
  - Customer's input list contains `/about-us/`, probe sends `/about` which redirects to it → asserted deduped via post-redirect URL match.
- [ ] AC-16: Regression test: customer upload with all auto-discovery patterns ALREADY included → auto-discovery returns 0 new URLs, dedup works correctly.

## 4. Out of scope

- **TS-086** (tree extractor LLM bug) — separate, ships first. Without TS-086, TS-083 has no effect because the trees can't extract regardless of input richness.
- **TS-084** (timing race) — separate.
- **TS-085** (pageType classifier) — separate, but TS-083 + TS-085 together are the strongest combination (more brand pages + correct classification).
- **Subdomain auto-discovery** (e.g., `homehealth.manipalhospitals.com`) — riskier, requires DNS / link-graph traversal. Defer to TS-083+ follow-up.
- **Multi-language root detection** (e.g., `/en/`, `/es/`, `/in/`) — defer.
- **Dynamic / JavaScript-rendered SPA root pages** — assumes static or server-rendered HTML for the brand layer; rare exceptions handled by graceful failure.

## 5. Risks

### 5.1 Wasted probe on hostile sites + cold-DNS / HTTP/1.1 latency (HP-176)

A site with no brand-level pages (e.g., a single landing page with no `/about/`, no `/services/`) would still consume the 12 `GET Range` probes. **Mitigation:** 8-second total budget (per AC-10) with parallel requests caps the cost. Worst case: 12 × ~$0.001 raw HTTP = ~$0.012 wasted per audit; auto-discovery uses raw HTTP `GET` with `Range: bytes=0-0` (NOT firecrawl) so the per-probe cost is negligible.

**Cold-DNS / HTTP/1.1 risk (NEW per HP-176):** Vercel serverless functions cold-start with no DNS cache and no warm TLS connections. The first request to a previously-uncontacted brand domain incurs:
- DNS resolution: 50-200ms (varies by ISP/provider)
- TLS handshake: 100-300ms (TLS 1.3 single round trip; TLS 1.2 two round trips)
- HTTP/1.1 sites without keep-alive: an additional connection open per request (no connection multiplexing)
- Slow upstream response: some brand sites have 2-3s TTFB

The original 5s/1s budget was empirically tight on these conditions. AC-10's 8s/2s budget gives a realistic safety margin without making auto-discovery a perceptible audit-kickoff cost. ScriptDev should instrument the actual probe latency in the integration test fixture and confirm the budget holds for the slowest realistic test case (e.g., a fresh-DNS HTTP/1.1 site).

### 5.2 Customer surprise about extra pages

Some customers may notice their `monthly_pages_used` go up by N more than they expected. **Mitigation:** AC-12 + AC-13 surface the auto-discovery transparently in the email and dashboard. Customers see WHAT was added and WHY.

### 5.3 Auto-discovery false positives

A `/about/` URL on some domains might not be the brand about-us page (could be a category page, redirect, etc.). **Mitigation:** the tree extractor (post-TS-086) will assign these pages weight based on actual content, not URL alone. False-positive auto-discoveries don't pollute outputs because they get classified normally.

### 5.4 Coupling with TS-085

If TS-085 isn't fixed, the auto-discovered brand pages might still be classified as "other" by the bulk-mode pageType classifier. **Mitigation:** TS-083 should ship AFTER or WITH TS-085 to maximize impact.

## 6. Open questions

- **Q1: Pattern list — should it be domain-vertical-aware?** E.g., healthcare sites might have `/specialties/`, retail sites might have `/products/`. A static union of all patterns is the simplest start but may produce wasted probes for some verticals. Recommend: ship a static union for v1, add vertical-aware optimization later.
- **Q2: Should auto-discovery use firecrawl or raw HTTP HEAD?** firecrawl gives cleaner HTML extraction; raw HEAD is cheaper. Recommend: raw HEAD for the probe (200/non-200 check), then full firecrawl crawl for the discovered URLs alongside the user list. Saves firecrawl cost during the probe.
- **Q3: Should TS-083 backfill existing affected customers?** Could write a script that detects "broken pattern" customers (research_data.topCompetitors > 0 AND discovered_competitors = 0), runs auto-discovery, augments crawl_data, re-runs downstream stages. Recommend: defer to follow-up; ship TS-083 forward-only for v1.

## 7. Cross-reference

- TS-086 (must ship first — tree extractor bug)
- TS-085 (sibling — pageType classifier)
- TS-084 (sibling — timing race; lower priority after TS-086)
- ES-053 (original tree extraction spec)
- ES-005 (M2 bulk CSV audit spec)

---

**End of TS-083.**
