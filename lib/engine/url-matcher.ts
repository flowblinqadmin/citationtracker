// AI Citation Tracker — URL normalization + citation matching
//
// The attribution engine: cited URLs extracted from AI responses are normalized
// to a canonical key, optionally redirect-resolved, then matched against a
// client's press-coverage article list.
//
// Why a bespoke normalizer (the existing lib/utils.ts normalizeUrl and
// geo-crawler.ts normalizeUrlForComparison are insufficient):
//   * They keep the query string, so two URLs that differ only by `?utm_*` look
//     distinct — breaking citation matching.
//   * They do not unwrap Google redirect wrappers (`google.com/url?q=…`), which
//     pepper the real seed coverage logs, nor Gemini grounding redirects
//     (`vertexaisearch.cloud.google.com/grounding-api-redirect/…`).
//   * They do not canonicalize AMP variants or strip mobile (`m.`) subdomains.
//
// The normalized key is `host + path` with: scheme dropped, host lowercased and
// stripped of `www.`/`m.`/`amp.` prefixes, default ports removed, tracking query
// params removed (remaining params sorted), fragment removed, and a trailing
// slash trimmed. Two URLs that a human would call "the same article" should
// produce the same key.

import { detectMention } from "@/lib/engine/brand-detector";
import { isPrivateHost, PRIVATE_RANGES } from "@/lib/engine/ssrf";

// Query params that never identify an article — analytics / share / click IDs.
// Anything matching `utm_*` is also dropped (prefix rule below).
const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "gclsrc", "dclid", "msclkid", "yclid", "twclid",
  "mc_cid", "mc_eid", "igshid", "ref", "ref_src", "ref_url", "source",
  "cmpid", "campaign", "spm", "_hsenc", "_hsmi", "vero_id", "oly_anon_id",
  "oly_enc_id", "__twitter_impression", "wt_mc", "ncid", "cmp",
]);

// Hosts whose path carries a redirect target we should unwrap before anything else.
// Each maps to the query param holding the real URL.
const REDIRECT_WRAPPERS: Array<{ hostMatch: (h: string) => boolean; params: string[] }> = [
  { hostMatch: (h) => h === "google.com" || h.endsWith(".google.com"), params: ["q", "url"] },
  { hostMatch: (h) => h === "news.url.google.com", params: ["url"] },
];

// Public suffixes we must keep whole when deriving the registrable domain.
// NOT the full PSL — a pragmatic subset covering (a) ccTLD registry suffixes
// that appear in PR coverage (India / UK / AU / etc.), and (b) multi-tenant
// hosting suffixes where the meaningful site is the SUBDOMAIN (blogspot.com,
// wordpress.com, …) so distinct tenants don't collapse to one "domain".
// Heuristic — the robust upgrade is a real PSL (e.g. the `tldts` package).
// Entries may be 2-label or 3-label; extractRegistrableDomain matches the
// longest applicable suffix.
const PUBLIC_SUFFIXES = new Set([
  // United Kingdom
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "net.uk", "ltd.uk", "plc.uk",
  // India (common in PCG's India-focused PR coverage)
  "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in", "gov.in",
  "nic.in", "ac.in", "res.in", "edu.in", "mil.in",
  // Australia / NZ / others
  "com.au", "net.au", "org.au", "gov.au", "edu.au", "asn.au", "id.au",
  "co.nz", "org.nz", "govt.nz", "ac.nz",
  "co.za", "org.za", "gov.za",
  "co.jp", "or.jp", "ne.jp", "go.jp",
  "com.br", "com.sg", "com.my", "co.id", "co.kr", "com.tr", "com.cn",
  "gov.cn", "edu.cn", "co.th", "com.ph", "com.hk", "com.mx", "co.ke",
  // Multi-tenant hosting — keep the tenant subdomain
  "blogspot.com", "wordpress.com", "medium.com", "substack.com", "tumblr.com",
  "github.io", "gitlab.io", "wixsite.com", "weebly.com", "web.app",
  "firebaseapp.com", "netlify.app", "vercel.app", "pages.dev", "blogspot.in",
]);
const MAX_SUFFIX_LABELS = 3;

// Known internal/metadata hostnames that are NOT IPs (so isPrivateHost misses
// them). Used to harden resolveRedirects against redirect-to-metadata SSRF.
const INTERNAL_HOSTNAMES = new Set([
  "metadata.google.internal", "metadata", "instance-data",
]);

/**
 * If `host`/`path` describe an AMP *cache* URL that embeds a real target host,
 * return the reconstructed inner URL string (so the caller can re-parse it and
 * take the query from the TARGET, not the cache wrapper). Otherwise null.
 *   - google.com/amp/s/example.com/article         (Google AMP cache, /amp/s/)
 *   - example-com.cdn.ampproject.org/c/s/example.com/article
 */
function ampCacheInnerUrl(host: string, path: string): string | null {
  if (host === "google.com" || host.endsWith(".google.com")) {
    const m = path.match(/^\/amp\/(?:s\/)?([^/]+)(\/.*)?$/i);
    if (m) return `https://${m[1]}${m[2] || ""}`;
  }
  if (host.endsWith(".cdn.ampproject.org") || host === "cdn.ampproject.org") {
    const m = path.match(/^\/c\/(?:s\/)?([^/]+)(\/.*)?$/i);
    if (m) return `https://${m[1]}${m[2] || ""}`;
  }
  return null;
}

/** Strip AMP path segments on the SAME host (no query-source change). */
function stripAmpPathSegments(path: string): string {
  let p = path.replace(/\/amp\/?$/i, "") || "/";
  p = p.replace(/^\/amp\//i, "/");
  return p;
}

/**
 * Remove www./m./amp. host prefixes, but ONLY when the prefix sat on a
 * subdomain — i.e. the remainder still contains a dot. This preserves real
 * registrable domains whose leftmost label is literally www/m/amp (e.g.
 * amp.com, m.co), which a length-based guard could not distinguish from a
 * mobile/AMP subdomain. Repeats for stacked prefixes (amp.m.example.com).
 */
function stripHostPrefixes(host: string, path: string): { host: string; path: string } {
  let h = host;
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of ["www.", "m.", "amp."]) {
      if (h.startsWith(prefix)) {
        const remainder = h.slice(prefix.length);
        if (remainder.includes(".")) {
          h = remainder;
          changed = true;
        }
      }
    }
  }
  return { host: h, path };
}

/** Parse a possibly-scheme-less URL string into a URL, or null. */
function safeParse(input: string): URL | null {
  if (!input || typeof input !== "string") return null;
  const s = input.trim().replace(/\s/g, "");
  if (!s) return null;

  // Try as-is first. A string with an explicit scheme (https:, mailto:,
  // javascript:, ftp:, …) parses here; we then require http/https, which
  // rejects non-web schemes outright (so "mailto:x@y.com" → null, not "y.com").
  let parsed: URL | null = null;
  try {
    parsed = new URL(s);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    // No scheme — assume https and retry. ("example.com/a", "m.foo.in/x")
    try {
      parsed = new URL(`https://${s}`);
    } catch {
      return null;
    }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname || !parsed.hostname.includes(".")) return null;
  return parsed;
}

/**
 * Normalize a URL to its canonical comparison key, or null if unparseable.
 * Idempotent: normalizeArticleUrl(normalizeArticleUrl(x)) === normalizeArticleUrl(x).
 */
export function normalizeArticleUrl(input: string, _depth = 0): string | null {
  const u = safeParse(input);
  if (!u) return null;

  let host = u.hostname.toLowerCase();
  // strip a trailing dot (FQDN form) and default ports are already excluded by URL.
  host = host.replace(/\.$/, "");

  // 1) Unwrap redirect wrappers first (google.com/url?q=…). Recurse on the target.
  for (const w of REDIRECT_WRAPPERS) {
    if (w.hostMatch(host)) {
      for (const param of w.params) {
        const target = u.searchParams.get(param);
        if (target && _depth < 4) {
          const nested = normalizeArticleUrl(target, _depth + 1);
          if (nested) return nested;
        }
      }
    }
  }

  let path = u.pathname || "/";

  // 2) Unwrap AMP *cache* shapes by recursing on the embedded target URL. Carry
  //    the cache URL's query through to the inner article (the AMP cache passes
  //    the article's params on its own URL), then let the recursion strip
  //    tracking params — so meaningful params survive and utm/etc. do not leak.
  const ampInner = ampCacheInnerUrl(host, path);
  if (ampInner && _depth < 4) {
    const nested = normalizeArticleUrl(ampInner + (u.search || ""), _depth + 1);
    if (nested) return nested;
  }
  //    Same-host AMP path segments (/amp suffix, /amp/ prefix) — query unchanged.
  path = stripAmpPathSegments(path);

  // 3) Strip host prefixes (www./m./amp.) that sit on a subdomain.
  ({ host, path } = stripHostPrefixes(host, path));

  // 4) Clean query string: drop tracking params + utm_*, keep+sort the rest.
  const kept: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams.entries()) {
    const lk = k.toLowerCase();
    if (lk.startsWith("utm_")) continue;
    if (TRACKING_PARAMS.has(lk)) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const query = kept.length
    ? "?" + kept.map(([k, v]) => `${k}=${v}`).join("&")
    : "";

  // 5) Trim a single trailing slash (but keep root "/").
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "") path = "/";

  return `${host}${path}${query}`;
}

/** True when the normalized key points at a site root (homepage), no article path. */
export function isHomepageKey(normalized: string): boolean {
  const slashIdx = normalized.indexOf("/");
  if (slashIdx === -1) return true;
  const path = normalized.slice(slashIdx);
  return path === "/" || path === "";
}

/**
 * Registrable domain (eTLD+1) of a URL or bare host, lowercased, or null.
 * Heuristic: handles the common multi-part ccTLDs in MULTI_PART_SUFFIXES;
 * everything else falls back to the last two labels. Not a full PSL.
 */
export function extractRegistrableDomain(input: string): string | null {
  const u = safeParse(input);
  let host = u ? u.hostname.toLowerCase() : input.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  ({ host } = stripHostPrefixes(host, "/"));
  if (!host.includes(".")) return null;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  // Match the LONGEST known public suffix at the tail, then keep one more label.
  for (let suffixLen = Math.min(MAX_SUFFIX_LABELS, labels.length - 1); suffixLen >= 2; suffixLen--) {
    const suffix = labels.slice(-suffixLen).join(".");
    if (PUBLIC_SUFFIXES.has(suffix)) {
      return labels.slice(-(suffixLen + 1)).join(".");
    }
  }
  return labels.slice(-2).join(".");
}

export interface RedirectResolveOpts {
  maxHops?: number;
  timeoutMs?: number;
  cache?: Map<string, string>;
  fetchImpl?: typeof fetch;
  /**
   * Injectable DNS resolver for testing.  Given a hostname, returns the first
   * resolved IPv4/IPv6 address string.  When provided, resolveRedirects performs
   * a DNS pre-flight before each fetch hop and blocks any hop whose resolved
   * address falls in a private/internal range (SSRF guard — R09).
   *
   * In production (no dnsLookupImpl supplied) the pre-flight uses
   * `dns.promises.lookup` from Node's built-in `dns` module.  It is skipped
   * entirely when `fetchImpl` is also not supplied so that callers that inject
   * only a `fetchImpl` (unit tests) are not broken.
   */
  dnsLookupImpl?: (hostname: string) => Promise<string>;
}

/**
 * True if a URL's host is private/internal and must not be fetched or followed.
 * Guards resolveRedirects against redirect-to-metadata SSRF (e.g. a public
 * article URL that 302s to http://169.254.169.254/ or metadata.google.internal).
 * Unparseable → blocked (fail closed).
 */
export function isBlockedRedirectTarget(urlStr: string): boolean {
  let host: string;
  try {
    host = new URL(urlStr).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return true;
  }
  if (!host) return true;
  if (isPrivateHost(host)) return true;
  if (INTERNAL_HOSTNAMES.has(host)) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return true;
  return false;
}

/**
 * Follow HTTP redirects manually to resolve a wrapper/short URL to its final
 * destination. REQUIRED for Gemini grounding URLs
 * (`vertexaisearch.cloud.google.com/grounding-api-redirect/…`). Best-effort:
 * on any failure returns the best URL reached so far (caller still normalizes).
 * `fetchImpl` is injectable for deterministic tests (no network).
 *
 * DNS pre-flight (R09): before each fetch hop, the hostname is resolved via
 * `dnsLookupImpl` (or the built-in `dns.promises.lookup` in production).  If
 * the resolved address falls in a private/internal range the hop is blocked and
 * we return the last safe URL (fail-closed).  The pre-flight is skipped when
 * `dnsLookupImpl` is not provided AND `fetchImpl` IS provided — this keeps all
 * existing unit tests green without requiring them to supply a DNS stub.
 */
export async function resolveRedirects(url: string, opts: RedirectResolveOpts = {}): Promise<string> {
  const maxHops = opts.maxHops ?? 5;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const cache = opts.cache;
  const doFetch = opts.fetchImpl ?? fetch;

  // Determine whether to perform DNS pre-flight.
  // Rule: run when dnsLookupImpl is explicitly provided, OR when we are on the
  // production path (no fetchImpl override).  Unit tests that only inject
  // fetchImpl get no DNS check (keeps them passing without stubs).
  const runDnsPreflight = opts.dnsLookupImpl != null || opts.fetchImpl == null;

  /**
   * Resolve a hostname to its first address and check against PRIVATE_RANGES.
   * Returns true (= blocked) on any DNS error or private result (fail-closed).
   */
  async function isBlockedByDns(hostname: string): Promise<boolean> {
    if (!runDnsPreflight) return false;
    try {
      let resolvedIp: string;
      if (opts.dnsLookupImpl) {
        resolvedIp = await opts.dnsLookupImpl(hostname);
      } else {
        // Production path: use Node's built-in DNS (mirrors lib/ssrf.ts pattern).
        const { promises: dnsPromises } = await import("dns");
        const result = await dnsPromises.lookup(hostname);
        resolvedIp = result.address;
      }
      return isPrivateIp(resolvedIp);
    } catch {
      // DNS resolution failure → fail closed (block).
      return true;
    }
  }

  if (cache?.has(url)) return cache.get(url)!;

  // Sync hostname check (catches literal IPs and known internal FQDNs).
  if (isBlockedRedirectTarget(url)) {
    cache?.set(url, url);
    return url;
  }

  // DNS pre-flight on the initial URL.
  try {
    const initialHostname = new URL(url).hostname;
    if (await isBlockedByDns(initialHostname)) {
      cache?.set(url, url);
      return url;
    }
  } catch {
    // Unparseable → already caught by isBlockedRedirectTarget above; safe to continue.
  }

  let current = url;
  try {
    for (let hop = 0; hop < maxHops; hop++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await doFetch(current, {
          method: "HEAD",
          redirect: "manual",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const status = res.status;
      const location = res.headers.get("location");
      if (status >= 300 && status < 400 && location) {
        const next = new URL(location, current).toString();
        // Sync SSRF guard: do NOT follow (or return) a redirect into a private/
        // internal host. Stop here and keep the last public URL.
        if (isBlockedRedirectTarget(next)) break;
        // DNS pre-flight on the redirect target hostname.
        let blockedByDns = false;
        try {
          const nextHostname = new URL(next).hostname;
          blockedByDns = await isBlockedByDns(nextHostname);
        } catch {
          blockedByDns = true; // unparseable next URL → block
        }
        if (blockedByDns) break;
        current = next;
        continue;
      }
      break; // not a redirect — done
    }
  } catch {
    // network/abort failure — fall through with whatever we have
  }
  cache?.set(url, current);
  return current;
}

/**
 * Returns true if `address` (an IPv4 or IPv6 address string) is private or
 * internal — same logic as PRIVATE_RANGES but works on raw address strings
 * (no bracket wrapping for IPv6).
 */
function isPrivateIp(address: string): boolean {
  if (!address) return true;
  // For IPv6: wrap in brackets so PRIVATE_RANGES regexes match (they expect the
  // URL-hostname form like [::1], [::ffff:...], etc.).
  const normalized = address.includes(":") ? `[${address}]` : address;
  return PRIVATE_RANGES.some((r) => r.test(normalized));
}

export interface MatchContext {
  /** normalized article URL → article id. */
  articlesByNormalizedUrl: Map<string, string>;
  /** registrable domains of the client's article outlets (for partial/homepage match). */
  articleDomains: Set<string>;
  /** registrable domains of named competitors → competitor domain string. */
  competitorDomains: Set<string>;
}

export interface MatchResult {
  matchType: "exact" | "partial" | "unmatched";
  articleId: string | null;
  competitorDomain: string | null;
  normalizedUrl: string | null;
  domain: string | null;
}

/**
 * Classify one already-redirect-resolved cited URL against the client's article
 * list. Pure + synchronous (resolve redirects upstream).
 *
 *   exact     — normalized URL is in the article list.
 *   partial   — same outlet registrable domain as an article, but the cited URL
 *               is the outlet homepage / a non-article path (needs human review).
 *   unmatched — neither; if the domain is a named competitor, competitorDomain
 *               is set (still reportable as competitor/third-party citation).
 */
export function matchCitation(resolvedUrl: string, ctx: MatchContext): MatchResult {
  const normalizedUrl = normalizeArticleUrl(resolvedUrl);
  const domain = extractRegistrableDomain(resolvedUrl);

  if (!normalizedUrl) {
    return { matchType: "unmatched", articleId: null, competitorDomain: null, normalizedUrl: null, domain };
  }

  // Exact article match.
  const articleId = ctx.articlesByNormalizedUrl.get(normalizedUrl);
  if (articleId) {
    return { matchType: "exact", articleId, competitorDomain: null, normalizedUrl, domain };
  }

  // Partial: same outlet as one of the client's articles, but not the article
  // URL. Client-outlet attribution takes PRECEDENCE — a partial is a (pending)
  // CLIENT citation, so it must NOT also carry a competitorDomain (which would
  // let one citation land in both the client and competitor buckets and skew
  // Share of AI Voice). Competitor classification applies only to the unmatched
  // branch below.
  if (domain && ctx.articleDomains.has(domain)) {
    return { matchType: "partial", articleId: null, competitorDomain: null, normalizedUrl, domain };
  }

  const competitorDomain = domain && ctx.competitorDomains.has(domain) ? domain : null;
  return { matchType: "unmatched", articleId: null, competitorDomain, normalizedUrl, domain };
}

/**
 * Build a MatchContext from a client's article list + competitor domains.
 * Articles are keyed by their stored normalized_url (already canonical).
 */
export function buildMatchContext(
  articles: Array<{ id: string; normalizedUrl: string }>,
  competitorDomains: string[],
): MatchContext {
  const articlesByNormalizedUrl = new Map<string, string>();
  const articleDomains = new Set<string>();
  for (const a of articles) {
    articlesByNormalizedUrl.set(a.normalizedUrl, a.id);
    const d = extractRegistrableDomain(a.normalizedUrl);
    if (d) articleDomains.add(d);
  }
  const competitorSet = new Set<string>();
  for (const c of competitorDomains) {
    const d = extractRegistrableDomain(c);
    if (d) competitorSet.add(d);
  }
  return { articlesByNormalizedUrl, articleDomains, competitorDomains: competitorSet };
}

/**
 * Detect whether a client's brand is mentioned in a response body. Thin wrapper
 * over the shared brand detector so the tracker and audit agree on semantics.
 */
export function isBrandMentioned(
  responseText: string,
  domain: string | null,
  brandKeywords?: import("@/lib/engine/brand-detector").BrandKeywords,
): boolean {
  if (!responseText || !domain) return false;
  return detectMention(responseText, domain, brandKeywords).mentioned;
}
