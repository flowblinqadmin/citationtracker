/**
 * ES-083 — Bulk audit auto-discovery of brand-level pages.
 *
 * When a customer's bulk URL list omits canonical brand pages (homepage,
 * /about-us, /services, etc.), this module probes a fixed pattern list,
 * dedupes against the customer's input, and returns the additional URLs
 * that should be added to the crawl. Operational overhead — does not count
 * against bulk_url_count or monthly_pages_used.
 *
 * See ES-083 + TS-083 for the spec.
 *
 * Constraints (per HolePoker review):
 *   - HP-173: probe via GET with `Range: bytes=0-0` (NOT HEAD — many servers
 *     reject HEAD with 405)
 *   - HP-174 + O-3: follow up to 5 redirect hops; record the final URL
 *   - HP-175: auto-discovered URLs do NOT count against monthly_pages_used
 *   - HP-176: 8s total budget / 2s per-request timeout (cold-DNS HTTP/1.1)
 *   - HP-183: inline canonicalizeUrl — do NOT extract to lib/services/url-canonical.ts
 *     (which does not exist). The same 5-step normalization is also inline
 *     in geo-crawler.ts:classifyPageType per ES-085 AC-3.
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
const MAX_REDIRECT_HOPS = 5;           // AC-3 — raised from 3 per O-3

/**
 * 5-step URL normalization. INLINE per HP-183 — DO NOT extract to a shared
 * helper. IDENTICAL step-for-step to ES-085 AC-3 §b.2 normalization in
 * geo-crawler.ts:classifyPageType.
 *
 * Returns origin (lowercased) + canonical path (no query, no fragment, no
 * trailing slash unless path is "/"). Used for dedup against the customer's
 * input list.
 */
export function canonicalizeUrl(href: string): string {
  const u = new URL(href);
  let path = u.pathname.toLowerCase();
  // 1. /index.html or /index.htm → /
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
 * Probe a single URL via GET with Range: bytes=0-0 (NOT HEAD per HP-173).
 * Follows up to MAX_REDIRECT_HOPS redirects manually. Returns the final
 * canonical URL on success, null on failure (4xx, 5xx, timeout, network).
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
    try { inputCanonical.add(canonicalizeUrl(href)); } catch { /* skip invalid */ }
  }

  // Build candidate probe URLs
  const candidates: string[] = PROBE_PATTERNS.map((path) => `${origin}${path}`);

  // Run all probes in parallel with a TOTAL budget of 8 seconds
  const overallTimeout = new Promise<null[]>((resolve) =>
    setTimeout(() => resolve(candidates.map(() => null)), PROBE_TOTAL_BUDGET_MS),
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
    if (discovered.some((d) => {
      try { return canonicalizeUrl(d) === canonical; } catch { return false; }
    })) continue;  // dedupe within probe results
    discovered.push(result);
    if (discovered.length >= MAX_AUTO_DISCOVERED) break;
  }

  return discovered;
}
