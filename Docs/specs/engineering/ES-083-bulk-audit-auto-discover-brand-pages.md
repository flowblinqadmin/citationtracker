# ES-083 — Bulk Audit Must Auto-Discover Brand-Level Pages

**Author:** SpecMaster (Agent 2)
**Source TS:** geo/docs/specs/technical/TS-083-bulk-audit-auto-discover-brand-pages.md
**Date:** 2026-04-09
**Priority:** P1 — improves dimensional richness for every bulk audit customer
**Sprint:** Bulk-audit dimensional data fix sprint (TS-083/084/085/086 ship together)
**Sprint role:** Adds an auto-discovery layer that probes brand-level URLs alongside the customer's bulk URL list
**Branch:** `fix/tree-extractor-and-bulk-audit` (NEW sprint branch)
**HolePoker status:** Cleared via HP-173 / HP-174 / HP-175 / HP-176 / HP-183 + observation O-3

---

## a) Overview

### What this covers

When a customer uploads a fixed URL list for a bulk audit, the GEO pipeline currently crawls ONLY those URLs. If the list misses brand-level anchor pages (homepage, brand about-us, services index, locations index, contact), downstream extractors lose canonical brand context and produce weaker dimensional outputs even after ES-086 ships.

ES-083 adds an **auto-discovery layer** that detects the input domain root from the customer's URL list and probes a small set of brand-level anchor pages (max 12) alongside the user list. Auto-discovered pages do NOT count against the customer's `bulk_url_count` budget — they are operational overhead.

The fix has six layers:

1. **Domain root detection** — extract canonical origin from the first valid bulk URL (AC-1)
2. **Probe URL candidates** — fixed pattern list (homepage, /about-us, /services, /locations, /contact, /team, etc.) (AC-2)
3. **HTTP probe** — `GET` with `Range: bytes=0-0` (NOT HEAD — many servers reject HEAD with 405) + 5-hop redirect chain handling (AC-3)
4. **Inline `canonicalizeUrl` helper** — 5-step normalization for dedup against the customer's input list (AC-4 — IDENTICAL to ES-085 AC-3 §b.2 normalization)
5. **Pipeline integration** — runs BEFORE crawl-fanout in `handleCrawlFanout` for bulk mode, fail-soft (AC-9, AC-10, AC-11)
6. **New schema field + customer-visible UX** — `auto_discovered_url_count` column on geo_sites + audit completion email + dashboard badge (AC-8, AC-12, AC-13)

### Source TS reference

`geo/docs/specs/technical/TS-083-bulk-audit-auto-discover-brand-pages.md`. Key sections:

- **§2.1** — Manipal evidence (255-URL bulk audit missed homepage + brand about-us)
- **§2.2** — Aditya's single-domain audit comparison (5 cities vs 1 city in geo_tree)
- **§2.3** — 6+ recent customer sites with the same pattern
- **§3.1** — Auto-discovery rules (AC-1..AC-5)
- **§3.2** — Credit accounting (AC-6, AC-7, AC-8)
- **§3.3** — Pipeline integration (AC-9..AC-11)
- **§3.4** — Customer-visible (AC-12, AC-13)
- **§3.5** — Test coverage (AC-14, AC-15, AC-16)
- **§5.1** — Cold-DNS / HTTP/1.1 latency risk (HP-176 budget rationale)

### Current implementation state

| Surface | File | Lines | State |
|---|---|---|---|
| Bulk fanout entry | `geo/app/api/pipeline/stage/route.ts` | 248-282 (`handleCrawlFanout` bulk branch) | Currently builds `pageMap` from bulk URLs (with the Hypothesis A bug from ES-085). Auto-discovery layer is the new step that runs HERE before the existing fanout logic. |
| `classifyPageType` | `geo/lib/services/geo-crawler.ts` | 153-163 (post-ES-085 rewrite) | Used by ES-083 to classify auto-discovered URLs alongside bulk URLs |
| `bulkUrls` field | `geo/lib/db/schema.ts` | 128 | `jsonb("bulk_urls")` — stores the customer's input list |
| `bulkUrlCount` field | `geo/lib/db/schema.ts` | 129 | `integer("bulk_url_count")` — denormalized count, used for credit billing |
| **`auto_discovered_url_count`** | — | — | **DOES NOT EXIST** — DDL needed (AC-8). New nullable integer column. |
| `lib/services/url-canonical.ts` | — | — | **DOES NOT EXIST** — verified. Round-1 of TS-083 referenced this as if it existed; HolePoker HP-183 corrected the spec. **Inline `canonicalizeUrl` per AC-4 instead.** |
| Existing helpers | `geo/lib/services/geo-crawler.ts` | 165-178 (`checkUrlExists`), 186-213 (`checkWwwRedirect`) | Existing HTTP probe utilities — `checkUrlExists` uses `HEAD` which is exactly what HP-173 says NOT to use. ES-083's new probe must use `GET` with `Range: bytes=0-0`. |
| Audit completion email | `geo/lib/email.ts` (existing — `sendCompletionEmail`) | (function exists per `pipeline-stage-errors.test.ts:58` mock) | Customer-facing audit completion email; needs amendment to mention auto-discovered count (AC-12) |

### Out of scope (verbatim from TS-083 §4)

- **TS-086** (tree extractor LLM bug) — separate, ships first
- **TS-084** (timing race) — separate
- **TS-085** (pageType classifier) — separate, but TS-083 + TS-085 are the strongest combination
- Subdomain auto-discovery (e.g., `homehealth.manipalhospitals.com`)
- Multi-language root detection (`/en/`, `/es/`, `/in/`)
- Dynamic / JavaScript-rendered SPA root pages

---

## b) Implementation Requirements

### b.1 New schema column — `auto_discovered_url_count` (AC-8)

**File:** `geo/lib/db/schema.ts` — add to the `geoSites` table near the existing bulk fields at line 129:

```ts
// ES-083 AC-8: count of brand-level URLs auto-discovered and added to the
// crawl beyond the customer's bulk URL list. Informational only — does NOT
// count against bulk_url_count credit budget per AC-6/AC-7.
autoDiscoveredUrlCount: integer("auto_discovered_url_count"),
```

**DDL migration:** `geo/lib/db/migrations/000Y_auto_discovered_url_count.sql`:

```sql
ALTER TABLE geo_sites
  ADD COLUMN auto_discovered_url_count integer;
```

Nullable. No default. Coordinate the migration number with ES-084's `tree_extraction_failed_at` migration on the same branch — they should be consecutive.

### b.2 Auto-discovery module (AC-1, AC-2, AC-3, AC-4, AC-5)

**File to create:** `geo/lib/services/auto-discover-brand-pages.ts`

**Rationale for new file:** the auto-discovery logic is ~120 LOC of focused functionality (probe builder + HTTP probe + canonicalize + dedup). Inlining into `geo-crawler.ts` (already 833 LOC) would bloat that file; inlining into `pipeline/stage/route.ts` (already 1098 LOC) is worse. A small dedicated module is cleaner.

**Constraint per AC-4 / HP-183:** the `canonicalizeUrl` helper is INLINE in this file, NOT a shared helper at `lib/services/url-canonical.ts` (which does not exist). The same 5-step normalization is also inline in `classifyPageType` per ES-085 AC-3. **Both implementations are identical step-for-step but live in two places.** This is intentional to avoid creating a shared helper file that crosses two specs.

**Module structure:**

```ts
// geo/lib/services/auto-discover-brand-pages.ts

/**
 * ES-083: bulk audit auto-discovery of brand-level pages.
 *
 * When a customer's bulk URL list omits canonical brand pages (homepage,
 * /about-us, /services, etc.), this module probes a fixed pattern list,
 * dedupes against the customer's input, and returns the additional URLs
 * that should be added to the crawl. Operational overhead — does not count
 * against bulk_url_count.
 *
 * See TS-083 + ES-083 for the spec.
 */

const PROBE_PATTERNS: string[] = [
  "/",                             // homepage
  "/about-us/", "/about-us",
  "/about/", "/about",
  "/services/", "/services",
  "/specialities/", "/specialities",
  "/specialties/", "/specialties",
  "/products/", "/products",
  "/solutions/", "/solutions",
  "/locations/", "/locations",
  "/clinics/", "/clinics",
  "/hospitals/", "/hospitals",
  "/branches/", "/branches",
  "/contact-us/", "/contact-us",
  "/contact/", "/contact",
  "/team/", "/team",
  "/leadership/", "/leadership",
  "/doctors/", "/doctors",
];

const MAX_AUTO_DISCOVERED = 12;        // AC-5 cap
const PROBE_TOTAL_BUDGET_MS = 8000;    // AC-10 — total wall clock for ALL probes (HP-176)
const PER_REQUEST_TIMEOUT_MS = 2000;   // AC-10 — per-probe timeout (HP-176)
const MAX_REDIRECT_HOPS = 5;           // AC-3 — raised from 3 per O-3 (HTTP→HTTPS→www→canonical chains)

/**
 * 5-step URL normalization. INLINE per HP-183 — DO NOT extract to a shared helper.
 * IDENTICAL to ES-085 AC-3 §b.2 normalization in geo-crawler.ts classifyPageType.
 *
 * Returns origin (lowercased) + canonical path (no query, no fragment, no
 * trailing slash unless path is "/"). Used for dedup against the customer's
 * input list.
 */
export function canonicalizeUrl(href: string): string {
  const u = new URL(href);
  let path = u.pathname.toLowerCase();
  // 1. /index.html → /
  path = path.replace(/\/index\.html?$/, "/");
  // 2. Collapse double slashes
  path = path.replace(/\/{2,}/g, "/");
  // 3. Strip trailing slash UNLESS the path is just "/"
  if (path !== "/") path = path.replace(/\/+$/, "");
  // Return origin (lowercased) + canonical path (no query, no fragment)
  return `${u.origin.toLowerCase()}${path}`;
}

/**
 * Detect the canonical origin for the bulk audit input.
 * Returns null if no URL in the list is parseable.
 */
export function detectInputOrigin(bulkUrls: string[]): string | null {
  for (const href of bulkUrls) {
    try {
      const u = new URL(href);
      return u.origin.toLowerCase();
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Probe a single URL via GET with Range: bytes=0-0 (NOT HEAD per HP-173 —
 * many servers reject HEAD with 405). Follows up to MAX_REDIRECT_HOPS
 * redirects manually. Returns the final canonical URL on success, null on
 * failure (4xx excluding 405-from-HEAD-not-applicable, 5xx, timeout, network).
 *
 * Timeout: PER_REQUEST_TIMEOUT_MS per probe.
 */
export async function probeUrl(url: string): Promise<string | null> {
  let currentUrl = url;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT_MS);
      const res = await fetch(currentUrl, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "Range": "bytes=0-0",
          "User-Agent": "FlowBlinqGEO/1.0 (auto-discover)",
        },
        redirect: "manual", // we follow manually to enforce hop limit
      });
      clearTimeout(tid);

      // Success: 200 or 206 Partial Content
      if (res.status === 200 || res.status === 206) {
        return currentUrl;
      }

      // Redirect: follow if within hop budget
      if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
        const location = res.headers.get("location");
        if (!location) return null;
        // Resolve relative redirects against the current URL
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      // 4xx / 5xx — drop the probe
      return null;
    } catch {
      // Timeout / network error / abort
      return null;
    }
  }
  // Hop budget exhausted
  return null;
}

/**
 * Run auto-discovery for a bulk audit.
 *
 * 1. Detect the input origin from bulkUrls
 * 2. Build candidate probe URLs from PROBE_PATTERNS
 * 3. Canonicalize the customer's input list (dedup target)
 * 4. Probe candidates in parallel (with 8s total budget)
 * 5. Filter successful probes against the canonicalized input
 * 6. Cap at MAX_AUTO_DISCOVERED
 *
 * Returns the additional URLs to add to the crawl. Returns [] on any failure
 * (network outage, no parseable URL in input, etc.) per AC-11 fail-soft.
 */
export async function autoDiscoverBrandPages(bulkUrls: string[]): Promise<string[]> {
  const origin = detectInputOrigin(bulkUrls);
  if (!origin) return [];

  // Build canonical set from customer input for dedup
  const inputCanonical = new Set<string>();
  for (const href of bulkUrls) {
    try { inputCanonical.add(canonicalizeUrl(href)); } catch { /* skip */ }
  }

  // Build candidate probe URLs
  const candidates: string[] = PROBE_PATTERNS.map((path) => `${origin}${path}`);

  // Run all probes in parallel with a TOTAL budget of 8 seconds
  const overallTimeout = new Promise<null[]>((resolve) =>
    setTimeout(() => resolve(candidates.map(() => null)), PROBE_TOTAL_BUDGET_MS)
  );
  const probesPromise = Promise.all(candidates.map((url) => probeUrl(url)));
  const results = await Promise.race([probesPromise, overallTimeout]);

  // Filter: keep successful probes, dedup against customer input via canonicalization
  const discovered: string[] = [];
  for (const result of results) {
    if (!result) continue;
    let canonical: string;
    try { canonical = canonicalizeUrl(result); } catch { continue; }
    if (inputCanonical.has(canonical)) continue;  // already in customer list
    if (discovered.some((d) => canonicalizeUrl(d) === canonical)) continue;  // dedupe within probe results
    discovered.push(result);
    if (discovered.length >= MAX_AUTO_DISCOVERED) break;
  }

  return discovered;
}
```

### b.3 Pipeline integration — wire into `handleCrawlFanout` (AC-9, AC-10, AC-11)

**File:** `geo/app/api/pipeline/stage/route.ts`, `handleCrawlFanout` bulk branch at lines 248-282.

```ts
async function handleCrawlFanout(siteId: string, domain: string, maxPages: number): Promise<void> {
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) throw new Error("Site not found");

  let urls: string[];
  let pageMap: Record<string, string>;
  let autoDiscoveredCount = 0;  // ES-083 AC-8

  if (site.auditMode === "bulk") {
    const allUrls = (site.bulkUrls as string[] | null) ?? [];
    const crawlLimit = (site.crawlLimit as number | null) ?? allUrls.length;
    let urlsToProcess = allUrls.slice(0, crawlLimit);

    // ES-083 AC-9: auto-discover brand-level pages BEFORE building pageMap.
    // Fail-soft per AC-11 — if discovery throws, proceed with the original list.
    let autoDiscovered: string[] = [];
    try {
      const discoveryStart = Date.now();
      autoDiscovered = await autoDiscoverBrandPages(urlsToProcess);
      const discoveryMs = Date.now() - discoveryStart;
      console.info(JSON.stringify({
        event: "bulk_auto_discover_complete",
        domain,
        added: autoDiscovered.length,
        latencyMs: discoveryMs,
      }));
    } catch (err) {
      console.warn(JSON.stringify({
        event: "bulk_auto_discover_failed",
        domain,
        errMsg: (err as Error).message,
      }));
      autoDiscovered = [];
    }

    autoDiscoveredCount = autoDiscovered.length;
    urlsToProcess = [...urlsToProcess, ...autoDiscovered];

    pageMap = {};
    // ES-085 AC-1 fix: classify each URL (was hardcoded to "other" pre-ES-085)
    for (const url of urlsToProcess) pageMap[url] = classifyPageType(url);

    const syntheticDiscovery: DiscoveryData = {
      urls: urlsToProcess,
      pageMap: pageMap as Record<string, import("@/lib/services/geo-crawler").PageType>,
      hasLlmsTxt: false,
      hasUcp: false,
      hasSitemap: false,
      hasRobots: false,
      totalPages: urlsToProcess.length,
    };
    await db.update(geoSites).set({
      discoveryData: syntheticDiscovery as unknown as Record<string, unknown>,
      autoDiscoveredUrlCount: autoDiscoveredCount,  // ES-083 AC-8
      updatedAt: new Date(),
    }).where(eq(geoSites.id, siteId));
    urls = urlsToProcess;
  } else {
    // ... single-mode branch unchanged
  }

  // ... rest of handleCrawlFanout unchanged
}
```

**Key wire-up points:**
- Auto-discovery runs INSIDE `handleCrawlFanout` for bulk mode, BEFORE the pageMap initialization
- Fail-soft: any throw from `autoDiscoverBrandPages` falls back to the original `urlsToProcess` (per AC-11)
- The 8-second total budget is enforced inside `autoDiscoverBrandPages` itself via `Promise.race` against `PROBE_TOTAL_BUDGET_MS`
- The new column `autoDiscoveredUrlCount` is written in the same UPDATE as `discoveryData` — single transaction
- **Coexists cleanly with ES-085 §b.1 fix** (line 261 hardcoded "other" → `classifyPageType`)
- The newly auto-discovered URLs flow through `classifyPageType` for free (since the for-loop at line 261 now classifies every URL post-ES-085)

**Import addition:** add `import { autoDiscoverBrandPages } from "@/lib/services/auto-discover-brand-pages";` at the top of the file.

### b.4 Audit completion email update (AC-12)

**File:** `geo/lib/email.ts` (existing — read first to understand the function signature)

ScriptDev reads `lib/email.ts` `sendCompletionEmail` and adds an optional `autoDiscoveredCount?: number` parameter. When it's > 0, the email body includes:

> "We also crawled N brand-level pages (homepage, about-us, services index) to enrich your audit."

**Call site:** wherever `sendCompletionEmail` is invoked at the end of the bulk pipeline (likely `handleAssemble` or similar in `pipeline/stage/route.ts`). ScriptDev locates via `grep "sendCompletionEmail" pipeline/stage/route.ts` and passes `site.autoDiscoveredUrlCount ?? 0` as the new arg.

**Constraint:** the email change is OPTIONAL on the receiving end (zero-default). Existing callers that don't pass the new arg continue to work unchanged.

### b.5 Dashboard badge (AC-13)

**File:** TBD — depends on the existing audit summary display code. ScriptDev locates the audit summary component and adds a small info badge or note when `autoDiscoveredUrlCount > 0`:

> *"N additional brand pages auto-discovered"*

**ScriptDev investigation requirement:** locate the dashboard audit summary component (likely under `app/dashboard/` or `app/site/[id]/`). Add the badge as a small text snippet — no new component, no design system change required for v1.

### b.6 Files summary

| Action | Path | LOC est. |
|---|---|---|
| **CREATE** | `geo/lib/services/auto-discover-brand-pages.ts` | ~120 |
| **CREATE** | `geo/lib/db/migrations/000Y_auto_discovered_url_count.sql` | ~3 |
| **MODIFY** | `geo/lib/db/schema.ts` | +3 (one column declaration) |
| **MODIFY** | `geo/app/api/pipeline/stage/route.ts` | +30, -2 (handleCrawlFanout bulk branch + import) |
| **MODIFY** | `geo/lib/email.ts` | +5 (optional autoDiscoveredCount param + body interpolation) |
| **MODIFY** | `app/dashboard/...` (TBD) | +10 (audit summary badge) |
| **CREATE** | `geo/__tests__/services/auto-discover-brand-pages.test.ts` | ~250 (probe + canonicalize + dedup + integration) |
| **CREATE** | `geo/__tests__/integration/pipeline/bulk-auto-discover.integration.test.ts` | ~150 |

**One DDL migration. No new dependencies.**

---

## c) Unit Test Plan

New file: `geo/__tests__/services/auto-discover-brand-pages.test.ts`

### c.1 `canonicalizeUrl` (AC-4)

Reuses the same 5-step normalization tests as ES-085 §c.1 (which tests `classifyPageType` normalization). The point is to verify that ES-083's inline copy is byte-identical to ES-085's. ScriptDev MAY share fixtures via a common test data file.

| # | Test | Input | Expected |
|---|---|---|---|
| U1 | Homepage `/` preserved | `https://example.com/` | `https://example.com/` |
| U2 | Trailing slash stripped | `https://www.example.com/about-us/` | `https://www.example.com/about-us` |
| U3 | Query string dropped | `https://example.com/about-us?utm_source=email` | `https://example.com/about-us` |
| U4 | Fragment dropped | `https://example.com/contact#form` | `https://example.com/contact` |
| U5 | Index.html collapsed | `https://example.com/about/index.html` | `https://example.com/about` |
| U6 | Double slash collapsed | `https://example.com//about-us//` | `https://example.com/about-us` |
| U7 | Origin lowercased | `https://EXAMPLE.com/About-Us/` | `https://example.com/about-us` |

### c.2 `detectInputOrigin` (AC-1)

| # | Test | Input | Expected |
|---|---|---|---|
| U8 | First valid URL wins | `["https://manipalhospitals.com/bangalore/", "https://other.com/"]` | `https://manipalhospitals.com` |
| U9 | Skips invalid URLs | `["not-a-url", "https://valid.com/page"]` | `https://valid.com` |
| U10 | Returns null on all-invalid input | `["not-a-url", "also-not-a-url"]` | `null` |
| U11 | Returns null on empty input | `[]` | `null` |
| U12 | Origin lowercase | `["https://EXAMPLE.com/page"]` | `https://example.com` |

### c.3 `probeUrl` (AC-3)

Mock `global.fetch` for these tests.

| # | Test | Mock setup | Expected result |
|---|---|---|---|
| U13 | 200 OK → returns the URL | Mock fetch to return `{ status: 200 }` | `"https://example.com/about-us"` |
| U14 | 206 Partial Content → returns the URL | Mock fetch to return `{ status: 206 }` | Same |
| U15 | 404 → returns null | Mock fetch to return `{ status: 404 }` | `null` |
| U16 | 500 → returns null | Mock fetch to return `{ status: 500 }` | `null` |
| U17 | 405 (HEAD-rejecting server) → returns null | Mock fetch to return `{ status: 405 }` | `null` (we use GET so this should be uncommon, but the GET-with-Range might still get 405 from very strict servers) |
| U18 | 301 redirect → follows once → 200 → returns final URL | Mock 1st fetch: `{ status: 301, headers: { location: "/about-us/" } }`. Mock 2nd: `{ status: 200 }`. | The post-redirect URL |
| U19 | 302→302→200 (2 hops) → returns final URL | Three mocked responses | Final URL after 2 redirects |
| U20 | 5-hop redirect chain → returns final URL | Five mocked responses ending in 200 | Final URL after 5 redirects |
| U21 | 6-hop redirect (over limit) → returns null | Six mocked responses, none reaching 200 within 5 hops | `null` |
| U22 | Redirect loop (301 → same URL) → drops at hop limit | Mock to always return 301 to same location | `null` after 5 hops |
| U23 | Network error → returns null | Mock fetch to throw `Error("ECONNRESET")` | `null` |
| U24 | Timeout (AbortError) → returns null | Mock fetch to delay > 2s, AbortController fires | `null` |
| U25 | Per-request 2s timeout enforced | Use fake timers, mock fetch to delay 3s | Returns null after 2s |
| U26 | Sends Range: bytes=0-0 header | Capture fetch call args | Captured headers include `"Range": "bytes=0-0"` |
| U27 | Uses GET method, NOT HEAD | Capture fetch call args | Captured `method === "GET"` per HP-173 |
| U28 | Resolves relative redirects against current URL | Mock 301 to `/relative-path`. | The post-redirect URL is the absolute form `${origin}/relative-path` |

### c.4 `autoDiscoverBrandPages` (AC-1, AC-2, AC-5, AC-9, AC-10, AC-11)

| # | Test | Setup | Assertion |
|---|---|---|---|
| U29 | Empty bulk URLs → returns [] | `autoDiscoverBrandPages([])` | `[]` |
| U30 | All-invalid bulk URLs → returns [] | `autoDiscoverBrandPages(["not-a-url"])` | `[]` (no origin detected) |
| U31 | All probes 404 → returns [] | Mock fetch to return 404 for all probes | `[]` |
| U32 | All probes succeed → returns up to MAX_AUTO_DISCOVERED | Mock fetch to return 200 for all 27 PROBE_PATTERNS | Returns exactly 12 URLs (the cap) |
| U33 | Dedup against customer input | Customer list: `["https://example.com/about-us"]`. Mock all probes to 200. | Returns 11 URLs (the about-us probe is deduped against the customer input) |
| U34 | Dedup canonicalization (trailing slash) | Customer list: `["https://example.com/about-us/"]`. Mock probe to return `https://example.com/about-us` (different trailing slash but same canonical). | The probe is deduped — `canonicalizeUrl` strips both trailing slashes and the comparison succeeds |
| U35 | Dedup post-redirect | Customer list: `["https://example.com/about-us/"]`. Mock probe `/about` to redirect 301 to `/about-us/`. | The post-redirect URL canonicalizes to the same as customer input → deduped |
| U36 | Dedup within probe results | Probe 12 patterns, all of which redirect to the same final URL (`/about-us/`) | Returns at most 1 URL (canonical dedup within the probe set) |
| U37 | 8-second total budget enforced | Mock fetch to delay 9s for all probes. Use fake timers, advance to 8s. | Returns `[]` (the overall timeout fires before any probe resolves) |
| U38 | Origin lowercased | Customer list with mixed case origin | The canonical comparison still works |
| U39 | Per-probe failure does not break others | Mock 11 probes to succeed, 1 to throw | Returns 11 URLs (the throwing probe is filtered out) |
| U40 | Throws (e.g. URL constructor failure) → propagates to call site | Pass `null` as bulkUrls (cast as never) | Throws — caller's try/catch in `handleCrawlFanout` catches it |

### c.5 Total unit tests: 40 (U1–U40)

---

## d) Integration Test Plan

New file: `geo/__tests__/integration/pipeline/bulk-auto-discover.integration.test.ts`

### d.1 Auto-discovery wire-up in handleCrawlFanout (AC-9, AC-10, AC-11, AC-15, AC-16)

| # | Test | Setup | Assertion |
|---|---|---|---|
| IT1 | Auto-discovery adds brand pages to bulk crawl | Insert a `geo_sites` row with `auditMode: "bulk"`, `bulkUrls: ["https://example.com/page-1", "https://example.com/page-2"]`. Mock `autoDiscoverBrandPages` to return `["https://example.com/", "https://example.com/about-us"]`. POST stage `crawl-fanout`. | After `handleCrawlFanout` completes, the persisted `discoveryData.urls` has 4 entries (2 customer + 2 auto-discovered). The `auto_discovered_url_count` column is set to 2. |
| IT2 | Auto-discovery does NOT count against bulkUrlCount | Setup: `bulk_url_count: 50`. After IT1, verify `bulkUrlCount` is unchanged (still 50). Per AC-6/AC-7. | `bulkUrlCount === 50` (unchanged), `autoDiscoveredUrlCount === 2` (new) |
| IT3 | Fail-soft on autoDiscoverBrandPages throw | Mock `autoDiscoverBrandPages` to throw. Same setup as IT1. | The bulk audit proceeds with the original 2 URLs. `autoDiscoveredUrlCount === 0`. The `bulk_auto_discover_failed` log event is emitted. |
| IT4 | Network outage simulation | Mock `autoDiscoverBrandPages` to return `[]` (the fail-soft return value when network is down). | Same as IT3 — the bulk audit continues with the original list. |
| IT5 | Auto-discovered URLs flow through classifyPageType post-ES-085 | After IT1, verify the persisted `discoveryData.pageMap` has structural pageTypes for the auto-discovered URLs. | `pageMap["https://example.com/"] === "homepage"`, `pageMap["https://example.com/about-us"] === "about"` |
| IT6 | Single-mode is unaffected | Insert a `geo_sites` row with `auditMode: "single"`. POST stage `crawl-fanout`. Spy on `autoDiscoverBrandPages`. | `autoDiscoverBrandPages` NOT called. The single-mode branch is unchanged. `autoDiscoveredUrlCount IS NULL` on the row. |

### d.2 Probe + redirect + dedup integration (AC-3, AC-4, AC-5, AC-15)

These tests use the real `autoDiscoverBrandPages` (not mocked) but mock `global.fetch`.

| # | Test | Setup | Assertion |
|---|---|---|---|
| IT7 | Probe redirect chain integration | Customer input: `["https://example.com/page-1"]`. Mock probes: `/about` → 301 → `/about-us/` → 200. | The discovered list contains `https://example.com/about-us/` (the post-redirect URL, NOT the original `/about` probe). Per AC-3 / HP-174. |
| IT8 | Probe dedup post-redirect against customer input | Customer input: `["https://example.com/about-us/"]` (already in customer list). Mock probe `/about` to redirect 301 to `/about-us/`. | The discovered list does NOT contain the about-us URL (deduped via canonicalization after redirect). Per AC-4. |
| IT9 | Mixed probe results | Mock 5 probes to succeed (200), 5 to fail (404), 2 to redirect 5 hops to final 200. | The discovered list has 5 + 2 = 7 URLs. |

### d.3 Customer-visible UX (AC-12, AC-13)

| # | Test | Setup | Assertion |
|---|---|---|---|
| IT10 | Audit completion email mentions auto-discovered count | Trigger the bulk pipeline end-to-end (or just the email send call) with a row where `autoDiscoveredUrlCount: 5`. Spy on `sendCompletionEmail`. | The email body contains "5 brand-level pages" or equivalent. |
| IT11 | Email omits the mention when count is 0 | Same setup with `autoDiscoveredUrlCount: 0` (or null) | The email body does NOT contain the auto-discovery mention. |

### d.4 Total integration tests: 11 (IT1–IT11)

---

## e) Profiling Requirements

### e.1 Auto-discovery latency budget (AC-10 — HP-176)

| Metric | Target | Tolerance |
|---|---|---|
| `autoDiscoverBrandPages` total wall-clock | ≤ 8 seconds | Hard cap enforced inside the function via Promise.race |
| Per-probe latency | ≤ 2 seconds | Per-request AbortController timeout |
| Cold-DNS / HTTP/1.1 sites | ≤ 8 seconds | Realistic worst case per HP-176 cold-DNS analysis |

**Profiling tool:** the new `bulk_auto_discover_complete` log event captures `latencyMs`. ScriptDev reviews production logs for the first week post-deploy to verify the 8s budget holds for slow upstreams.

### e.2 Per-probe cost

Raw HTTP `GET` with `Range: bytes=0-0` — negligible cost (~$0.001 per audit worst case for 12 probes). No firecrawl, no AI. Per TS-083 §5.1 mitigation.

---

## f) Load Test Plan

Not applicable for sustained load. One scenario for the budget validation:

| # | Scenario | Setup | Success criteria |
|---|---|---|---|
| L1 | Slow-upstream burst | Run `autoDiscoverBrandPages` against a fixture domain with 12 probes that each take 3 seconds (longer than per-request timeout but within total budget) | Returns within 8 seconds. Some probes succeed (those that resolve before 2s per-request timeout), others are dropped. `latencyMs ≤ 8000`. |

---

## g) Logging & Instrumentation

### g.1 New log events

| Event | Level | Source | Payload | Purpose |
|---|---|---|---|---|
| `bulk_auto_discover_complete` | info | `pipeline/stage/route.ts` `handleCrawlFanout` | `{ event, domain, added, latencyMs }` | Operator monitoring of auto-discovery success rate and latency |
| `bulk_auto_discover_failed` | warn | same | `{ event, domain, errMsg }` | Auto-discovery layer threw — fail-soft fallback engaged |

### g.2 Existing logs preserved

All existing pipeline logs preserved.

---

## h) Acceptance Criteria

### h.1 Auto-discovery rules (TS-083 §3.1)

- [ ] **AC-1:** Pipeline detects the input domain root from the first valid URL in the customer's bulk list. Implemented as `detectInputOrigin(bulkUrls): string | null`. **Verified by:** U8–U12.
- [ ] **AC-2:** Probe candidate list is the fixed `PROBE_PATTERNS` array (homepage + 17 path patterns). Probe uses `GET` with `Range: bytes=0-0` (NOT `HEAD` per HP-173). **Verified by:** U26, U27.
- [ ] **AC-3:** Probe is successful if response is 200, 206, OR a 3xx redirect that resolves to 200/206 within **5 hops** (raised from 3 per HolePoker O-3). The FINAL post-redirect URL is recorded, not the original probe URL. **Verified by:** U13, U14, U18, U19, U20, U21, U22.
- [ ] **AC-4:** Inline `canonicalizeUrl` function (NOT a shared helper file — `lib/services/url-canonical.ts` does NOT exist per HP-183). Identical 5-step normalization to ES-085 AC-3. **Verified by:** U1–U7.
- [ ] **AC-5:** Auto-discovered URL count capped at 12. **Verified by:** U32.

### h.2 Credit accounting (TS-083 §3.2)

- [ ] **AC-6:** Auto-discovered pages do NOT count against the customer's `bulk_url_count` budget. **Verified by:** IT2.
- [ ] **AC-7:** Originally listed in TS-083 §3.2 (per HP-175) — auto-discovered pages do NOT count against `monthly_pages_used`. The `auto_discovered_url_count` column is informational only. **Verified by:** IT2 + code review (no `monthly_pages_used` increment in the auto-discover path).
- [ ] **AC-8:** New field `auto_discovered_url_count` on `geo_sites` tracks the count. Nullable integer column added via DDL migration. **Verified by:** IT1 (asserts column is set), code review of migration file.

### h.3 Pipeline integration (TS-083 §3.3)

- [ ] **AC-9:** Auto-discovery runs BEFORE crawl-fanout (in the bulk branch of `handleCrawlFanout` per §b.3). **Verified by:** IT1, IT5.
- [ ] **AC-10:** Auto-discovery latency budget: 8 seconds total / 2 seconds per request (raised from 5s/1s per HP-176). **Verified by:** U25 (per-request), U37 (total budget), L1 (slow-upstream load test).
- [ ] **AC-11:** If the entire auto-discovery layer throws or returns empty (network outage, timeout), the bulk audit proceeds with the original URL list. No fail-stop. **Verified by:** IT3, IT4, U29, U30, U39.

### h.4 Customer-visible (TS-083 §3.4)

- [ ] **AC-12:** Audit completion email mentions auto-discovered pages when `autoDiscoveredUrlCount > 0`. **Verified by:** IT10, IT11.
- [ ] **AC-13:** Dashboard shows a small badge or info note for auto-discovered count > 0. **Verified by:** code review of the audit summary component (ScriptDev locates and updates).

### h.5 Test coverage (TS-083 §3.5)

- [ ] **AC-14:** Unit test for the URL pattern probe function. Mock HTTP responses including 200, 206, 301→200, 302→302→200, 4xx, 5xx, 405, redirect loops (>3 hops). **Verified by:** U13–U28.
- [ ] **AC-15:** Integration test fixture explicitly includes redirect-bearing URLs. Per HP-174 companion. **Verified by:** IT7, IT8, IT9.
- [ ] **AC-16:** Regression test: customer upload with all auto-discovery patterns ALREADY included → auto-discovery returns 0 new URLs, dedup works correctly. **Verified by:** U33, U34, U35, U36.

### h.6 Cross-cutting

- [ ] **AC-17:** No new dependencies. The probe uses the built-in `fetch` API.
- [ ] **AC-18:** Branch is `fix/tree-extractor-and-bulk-audit` (shared sprint branch).
- [ ] **AC-19:** DDL migration `000Y_auto_discovered_url_count.sql` exists, runs cleanly, and is tracked in `geo/lib/db/migrations/`. Coordinate migration ordering with ES-084's `tree_extraction_failed_at` migration on the same branch (consecutive numbers).
- [ ] **AC-20:** ES-083 ScriptDev tasks are independent of ES-086 ScriptDev tasks (no shared fixture dependency). They can run in parallel after the sprint branch is set up.

### h.7 Done definition

ES-083 is **done** when:

1. All 20 ACs are checked
2. ReviewMaster Phase A delivers test scaffolding for the 40 unit + 11 integration tests
3. The new auto-discover module is committed alongside the pipeline integration
4. The DDL migration runs cleanly
5. The audit completion email update is verified by IT10
6. The dashboard badge is added (location TBD by ScriptDev)
7. ES-083 ships in the same branch as ES-084, ES-085, ES-086

---

## Notes for downstream agents

### For ReviewMaster (Phase A)

1. **Test count:** 40 unit + 11 integration. Mid-large spec.
2. **Use distinct fixture identifiers** — never the literal `-GzFX1KcKhmN0W_1t8SmY`.
3. **U13–U28 are the probe coverage** — mock `global.fetch` carefully (capture call args + scripted responses).
4. **U37's total-budget test needs fake timers** — use `vi.useFakeTimers()` and `vi.advanceTimersByTime(8000)`.
5. **IT8's redirect dedup is load-bearing** — exercises the canonical comparison after the probe URL changes via redirect.
6. **`canonicalizeUrl` is the IDENTICAL function from ES-085 §b.2** — your unit tests can share fixtures with ES-085's classify-page-type tests. Coordinate via the ScriptDev brief.

### For CostMaster

1. **Files (CREATE):** 3 (auto-discover module, DDL migration, integration test)
2. **Files (CREATE — tests):** 1 unit test file
3. **Files (MODIFY):** 4 (schema, pipeline route, email lib, dashboard summary)
4. **Total LOC est.:** ~290 (impl + DDL + email + dashboard) + ~400 (tests) = ~690
5. **DDL migration:** YES (one nullable integer column). Coordinate numbering with ES-084's `tree_extraction_failed_at` migration on the same branch.
6. **No new dependencies, no env vars.**
7. **Branch:** shared sprint branch
8. **Lang:** `typescript` + `sql`
9. **Independent of ES-086 fixture creation** — ES-083 can run in parallel with ES-085 and ES-086 ScriptDev tasks.
10. **Probe pattern list is hardcoded in the module** — no config file, no env var. ScriptDev verifies the patterns match the §b.2 list verbatim.

### For CoFounder

1. **Module file `auto-discover-brand-pages.ts` is NEW** — placed at `lib/services/` per the §b.2 rationale (clean separation, ~120 LOC).
2. **`canonicalizeUrl` is duplicated inline in two places** — once in `auto-discover-brand-pages.ts`, once in `geo-crawler.ts:classifyPageType` (per ES-085 AC-3). This is intentional per HP-183 — both implementations are byte-identical. If this becomes a maintenance burden in v2, the right fix is to extract to a shared helper (and update both call sites in lockstep).
3. **No fabricated paths** — verified `lib/services/url-canonical.ts` does NOT exist via Glob. The inline pattern avoids the round-1 dangling reference HolePoker caught.
4. **DDL migration coordination:** ES-083 + ES-084 both add columns to `geo_sites` on the same sprint branch. Sequential migration numbers required.
5. **Per AC-13, the dashboard badge location is TBD** — ScriptDev will locate the right component during impl. If you have a preferred location (e.g., "audit summary header" vs "settings panel"), flag it in the ScriptDev brief.

---

**End of ES-083**
