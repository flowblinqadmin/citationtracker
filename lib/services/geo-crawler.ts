import { db } from "@/lib/db";
import { geoSites } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { CRAWL_MAX_CHUNKS } from "@/lib/config";

/**
 * GEO Crawler — Firecrawl-only crawl strategy (TS-010 / OPS-010 — third-party crawlers removed 2026-03-01):
 *  Phase 1: Firecrawl scrape pass — batched 20 at a time via scrapeWithFirecrawl()
 *  Phase 2 (per-URL fallback for Firecrawl failures):
 *    Tier 1: Direct fetch — fast, free, no JS rendering
 *    Tier 2: ScraperAPI — rotating residential proxies, handles Cloudflare/DDoS
 *    Tier 3: Firecrawl — credits-based
 *  Phase 3: Firecrawl async jobs — for bulk audit paths (fireBulkFirecrawlJobs)
 *
 * After crawling, scoreCrawlQuality() evaluates whether content is usable.
 * The pipeline uses this to decide whether to recrawl before spending AI credits.
 */

export type PageType =
  | "homepage"
  | "about"
  | "pricing"
  | "services"
  | "team"
  | "contact"
  | "blog"
  | "docs"
  | "faq"
  | "case-studies"
  | "legal"
  | "other";

export interface DiscoveryData {
  urls: string[];
  pageMap: Record<string, PageType>;
  hasLlmsTxt: boolean;
  hasUcp: boolean;
  hasSitemap: boolean;
  hasRobots: boolean;
  totalPages: number;
  discoveredPages?: number;   // raw Firecrawl map count before Gemini selection
  // www redirect health
  wwwRedirectStatus?: "ok" | "missing" | "unknown"; // ok = non-www redirects to www (or vice versa); missing = no redirect
  // Sitemap health
  sitemapStale?: boolean;         // true if pages were found that aren't in sitemap
  urlsNotInSitemap?: string[];    // pages found by nav crawl but missing from sitemap
  // Content of the site's own GEO files if they exist — used to give accurate scores
  ownLlmsTxt?: string;
  ownSchemaJson?: unknown;
  ownBusinessJson?: unknown;
  // FlowBlinq-generated assets from our DB (set when we have generated files for this domain)
  flowblinqGeneratedSchemaBlocks?: unknown;  // schema blocks array from our DB
  installedFromFlowblinq?: boolean;           // true if we found generated assets in our DB
  // FIND-033: true when the own-file fetch was indeterminate (fetch_failed)
  // rather than genuinely absent. The analyzer uses llmsTxtFetchFailed to avoid
  // penalizing a transient fetch failure as a hard "llms.txt absent".
  llmsTxtFetchFailed?: boolean;
  schemaFetchFailed?: boolean;
  businessFetchFailed?: boolean;
}

export interface CrawledPage {
  url: string;
  pageType: PageType;
  title: string;
  h1: string;
  headings: { level: number; text: string }[];
  content: string;
  existingSchema: string[];
  hasStructuredData: boolean;
  // Issue-L (2026-04-10): parsed JSON-LD block bodies, truncated to depth 2
  // and 150-char string values. Populated by extractSchemaBlocks() in both
  // fetchPage (single-mode) and mapDocumentToPage (bulk-mode). The LLM reads
  // this to evaluate schema quality (field completeness, nested structures)
  // in addition to mere presence of @type.
  schemaBlocks?: Record<string, unknown>[];
  contactInfo: string[];
  faqContent: { question: string; answer: string }[];
  testimonials: string[];
  certifications: string[];
}

export interface CrawlData {
  domain: string;
  pages: CrawledPage[];
  totalCrawled: number;
  failedUrls?: string[];        // attempted but blocked/errored — bulk audits only
  creditLimitedUrls?: string[]; // beyond crawlLimit, never attempted — bulk audits only
}

export interface CrawlQuality {
  totalAttempted: number;
  goodPages: number;       // content > 300 chars, not an error page
  thinPages: number;       // content 100-300 chars
  errorPages: number;      // bot challenge / timeout / error page detected
  coverageScore: number;   // 0-100: how well key page types were covered
  blockedByAntiBot: boolean;
  usable: boolean;         // true if good enough to run AI analysis on
  issues: string[];
}

const ERROR_SIGNALS = [
  "connection timed out", "error code 522", "error code 503",
  "just a moment", "checking your browser",
  "enable javascript",
  "403 forbidden", "404 not found", "this page isn't working",
];

function isErrorPage(content: string, title: string): boolean {
  const combined = (content + " " + title).toLowerCase();
  return ERROR_SIGNALS.some((sig) => combined.includes(sig));
}

/** Score the quality of a completed crawl — used to decide if recrawl is needed */
export function scoreCrawlQuality(crawlData: CrawlData): CrawlQuality {
  let goodPages = 0, thinPages = 0, errorPages = 0;
  let blockedByAntiBot = false;
  const issues: string[] = [];

  for (const page of crawlData.pages) {
    const len = page.content?.length ?? 0;
    if (isErrorPage(page.content ?? "", page.title ?? "")) {
      errorPages++;
      if ((page.content + page.title).toLowerCase().includes("cloudflare") ||
          (page.content + page.title).toLowerCase().includes("checking your browser") ||
          (page.content + page.title).toLowerCase().includes("ddos protection")) {
        blockedByAntiBot = true;
      }
    } else if (len >= 50) {
      goodPages++;
    } else {
      thinPages++;
    }
  }

  const coverageScore = 0;

  if (errorPages > 0) issues.push(`${errorPages} error/bot-challenge page(s) returned instead of content`);
  if (blockedByAntiBot) issues.push("Anti-bot protection (Cloudflare/DDoS) blocked crawl");
  if (goodPages === 0) issues.push("No pages with usable content were crawled");

  const usable = goodPages >= 1;

  return { totalAttempted: crawlData.totalCrawled, goodPages, thinPages, errorPages, coverageScore, blockedByAntiBot, usable, issues };
}

const PAGE_PRIORITY: Record<PageType, number> = {
  homepage: 0, about: 1, pricing: 2, services: 3, faq: 4,
  team: 5, "case-studies": 6, contact: 7, blog: 8, docs: 9, legal: 10, other: 11,
};

const PAGE_PATTERNS: { type: PageType; p: string[] }[] = [
  { type: "about", p: ["about", "who-we-are", "our-story"] },
  { type: "pricing", p: ["pricing", "plans", "packages"] },
  { type: "services", p: ["services", "solutions", "offerings"] },
  { type: "team", p: ["team", "people", "staff", "leadership"] },
  { type: "contact", p: ["contact", "get-in-touch"] },
  { type: "blog", p: ["blog", "news", "articles", "insights"] },
  { type: "docs", p: ["docs", "documentation", "help", "support"] },
  { type: "faq", p: ["faq", "faqs", "questions"] },
  { type: "case-studies", p: ["case-stud", "portfolio", "work"] },
  { type: "legal", p: ["privacy", "terms", "legal", "cookie"] },
];

/**
 * ES-085 AC-3: classify a URL into a structural pageType using WHATWG URL
 * parsing + 5-step normalization. The 5 steps are IDENTICAL byte-for-byte
 * to the canonicalizeUrl helper in lib/services/auto-discover-brand-pages.ts
 * (HP-183 — DO NOT extract to a shared file).
 *
 * Normalization steps:
 *   1. /index.html or /index.htm → /
 *   2. Collapse double slashes
 *   3. Strip trailing slash UNLESS path is "/"
 *   (Lowercasing is folded into the upstream pathname.toLowerCase() call)
 *
 * Matcher strategy:
 *   - Brand pages (about-us / contact-us): endsWith() — last segment must
 *     be the literal brand-page slug. Catches multi-segment brand URLs like
 *     /india/bangalore/about-us/ AND prevents /blog/about-us-launch-q1 from
 *     matching about (the trailing -q1 means it's a blog post, not a brand
 *     page).
 *   - Section pages (services / blog / docs / etc): pathHasSegment() — the
 *     keyword must appear as a COMPLETE path component at ANY depth (not
 *     just the first segment). Catches /services/, /services/dermatology,
 *     AND geographically-prefixed variants like /bangalore/specialities/
 *     that are common on multi-city brand sites (Manipal Hospitals, retail
 *     chains, etc). Still prevents /blog/services-update from matching
 *     services because the regex requires a slash or string-end AFTER the
 *     keyword — `services-update` has a hyphen, so no match.
 *
 * pathHasSegment(path, segment): true iff the segment keyword appears in
 * the path bounded by `/` or string-edge on BOTH sides. Per HP-182 +
 * TS-085 §c.5 false-positive guard (still enforced via the word-boundary
 * regex). Regression fix 2026-04-10 — the prior first-segment-only impl
 * misclassified 98% of Manipal's /bangalore/specialities/* URLs as "other",
 * starving the geo-analyzer prompt of structural context and dragging
 * content-evaluation pillar scores by ~10 overall points.
 */
function pathHasSegment(path: string, segment: string): boolean {
  const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|/)${escaped}(/|$)`).test(path);
}

export function classifyPageType(url: string): PageType {
  try {
    const u = new URL(url);
    let path = u.pathname.toLowerCase();

    // 5-step normalization (HP-182 — load-bearing for trailing slash)
    // 1. /index.html or /index.htm → /
    path = path.replace(/\/index\.html?$/, "/");
    // 2. Collapse double slashes
    path = path.replace(/\/{2,}/g, "/");
    // 3. Strip trailing slash UNLESS the path is just "/"
    if (path !== "/") path = path.replace(/\/+$/, "");

    // Homepage variants — preserve legacy semantics from the pre-ES-085
    // implementation: /, /index, /home all classify as homepage.
    if (path === "/" || path === "/index" || path === "/home") return "homepage";

    // Brand pages — endsWith for last-segment matching. Order matters:
    // case-studies/team-formation should match case-studies before team.
    // Legacy `/who-we-are` and `/our-story` aliases preserved.
    if (path.endsWith("/about-us") || path.endsWith("/about") ||
        path.endsWith("/who-we-are") || path.endsWith("/our-story")) return "about";
    if (path.endsWith("/contact-us") || path.endsWith("/contact") ||
        path.endsWith("/get-in-touch")) return "contact";

    // Section pages — first-segment matching via pathHasSegment.
    // Order matters: case-studies comes before team to avoid
    // /case-studies/team-formation matching team first.
    if (pathHasSegment(path, "case-studies") || pathHasSegment(path, "case-stud") ||
        pathHasSegment(path, "portfolio") || pathHasSegment(path, "work")) return "case-studies";
    if (pathHasSegment(path, "specialities") || pathHasSegment(path, "specialties") ||
        pathHasSegment(path, "services") || pathHasSegment(path, "products") ||
        pathHasSegment(path, "solutions") || pathHasSegment(path, "offerings")) return "services";
    if (pathHasSegment(path, "team") || pathHasSegment(path, "leadership") ||
        pathHasSegment(path, "doctors") || pathHasSegment(path, "doctors-list") ||
        pathHasSegment(path, "staff") || pathHasSegment(path, "people")) return "team";
    if (pathHasSegment(path, "pricing") || pathHasSegment(path, "plans") ||
        pathHasSegment(path, "packages")) return "pricing";
    if (pathHasSegment(path, "blog") || pathHasSegment(path, "news") ||
        pathHasSegment(path, "articles") || pathHasSegment(path, "insights")) return "blog";
    if (pathHasSegment(path, "docs") || pathHasSegment(path, "documentation") ||
        pathHasSegment(path, "help") || pathHasSegment(path, "support")) return "docs";
    if (pathHasSegment(path, "faq") || pathHasSegment(path, "faqs") ||
        pathHasSegment(path, "questions")) return "faq";
    if (pathHasSegment(path, "privacy") || pathHasSegment(path, "terms") ||
        pathHasSegment(path, "legal") || pathHasSegment(path, "cookie") ||
        pathHasSegment(path, "terms-of-service") || pathHasSegment(path, "cookie-policy")) return "legal";

    return "other";
  } catch { return "other"; }
}

/**
 * Bot-friendly user-agents that Cloudflare/Vercel/AWS WAFs and standard
 * robots.txt allowlists explicitly permit. The custom "FlowBlinqGEO/1.0" UA
 * we previously used was blocked by default WAF rules, causing every
 * `checkUrlExists` call against Cloudflare-fronted customer sites to return
 * false even when the resource was reachable from curl/browser. See Issue G
 * (follow-up to Issue A — discovery_data persistence gap).
 */
const BOT_FRIENDLY_USER_AGENTS = [
  "GPTBot/1.1",        // OpenAI
  "ClaudeBot/1.0",     // Anthropic
  "PerplexityBot/1.0", // Perplexity
];

async function checkUrlExists(url: string): Promise<boolean> {
  // Issue G fix: rotate through known-good bot user-agents AND use
  // GET-with-Range instead of HEAD. HEAD is rejected by some CDNs;
  // 1-byte Range request keeps bandwidth equivalent to HEAD while
  // accepting the broadest server compatibility. Same pattern as
  // ES-083 / HP-173 in auto-discover-brand-pages.ts.
  for (const agent of BOT_FRIENDLY_USER_AGENTS) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": agent,
          "Range": "bytes=0-0",
        },
      });
      clearTimeout(tid);
      // 200 = full body (server didn't honor Range)
      // 206 = Partial Content (server honored Range)
      // 429 = rate-limited but resource exists
      // 405 = method not allowed but resource exists
      if (res.status === 200 || res.status === 206 || res.status === 429 || res.status === 405) {
        return true;
      }
      // 403 / 404 / 5xx — try next agent
    } catch (err) {
      // DNS resolution failure — no UA change will make an unresolvable host
      // resolve. Short-circuit the retry loop.
      const e = err as { code?: string; cause?: { code?: string } };
      if (e?.code === "ENOTFOUND" || e?.cause?.code === "ENOTFOUND") {
        console.warn(`[geo-crawler] skipping retry on ENOTFOUND for ${url}`);
        return false;
      }
      // network error or abort — try next agent
    }
  }
  return false;
}

/**
 * Check whether non-www redirects to www (or www to non-www).
 * We assume www.domain.com is the canonical version (works for most sites).
 * Returns "ok" if non-www 301/302s to www, "missing" if it resolves independently
 * or errors, "unknown" on network failure.
 */
async function checkWwwRedirect(domain: string): Promise<"ok" | "missing" | "unknown"> {
  // Only check bare domains — skip if domain already starts with www
  if (domain.startsWith("www.")) return "ok";
  const nonWww = "https://" + domain;
  // Issue G fix: use bot-friendly UA + GET-with-Range instead of HEAD with
  // custom UA. Cloudflare WAFs block "FlowBlinqGEO/1.0", causing this
  // function to return "unknown" for every Cloudflare-fronted customer
  // domain. Try the first agent only — redirect detection doesn't need
  // full rotation since we just need ANY response to read .status.
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(nonWww, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual", // don't follow — we want to see the redirect itself
      headers: {
        "User-Agent": BOT_FRIENDLY_USER_AGENTS[0],
        "Range": "bytes=0-0",
      },
    });
    clearTimeout(tid);
    if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
      const location = res.headers.get("location") ?? "";
      if (location.includes("www." + domain)) return "ok";
      // redirects somewhere else (e.g. https://domain.com/ → https://domain.com/) — still a redirect, count as ok
      return "ok";
    }
    // 200 on non-www with no redirect = duplicate content, missing redirect
    if (res.status === 200) return "missing";
    // 5xx / 4xx on non-www = site is down or blocking, can't tell
    return "unknown";
  } catch {
    return "unknown";
  }
}

function extractSchemaTypes(html: string): string[] {
  const types: string[] = [];
  const blocks = html.match(/<script[^>]*type=[^>]*ld[^>]*>[\s\S]*?<\/script>/gi) ?? [];
  for (const block of blocks) {
    if (!block.includes("ld+json")) continue;
    const ms = block.match(/"@type"\s*:\s*"([^"]+)"/g) ?? [];
    for (const m of ms) {
      const t = m.match(/"([^"]+)"$/)?.[1];
      if (t && !types.includes(t)) types.push(t);
    }
  }
  return types;
}

// Issue-L (2026-04-10): Parse JSON-LD block bodies into structured objects
// so the LLM can evaluate schema QUALITY, not just presence of @type. The
// previous extractSchemaTypes() regex-stripped everything except the @type
// field, which meant Gemini saw "Organization is present" but couldn't check
// whether the Organization actually had sameAs/address/contactPoint/logo/etc.
// This left structured_data capped around 88 even on sites with rich schema.
//
// Size control (Manipal reference: 22 schema types × 222 pages):
//   - Parse each <script type="application/ld+json"> block to JSON
//   - Flatten @graph arrays to individual items
//   - Truncate string values to 150 chars
//   - Drop nested objects below depth 2 (replaced with {@type, _truncated})
//   - Cap to first 12 blocks per page
const MAX_SCHEMA_BLOCKS_PER_PAGE = 12;
const SCHEMA_STRING_MAX = 150;
const SCHEMA_MAX_DEPTH = 2;

function truncateSchemaValue(v: unknown, depth: number): unknown {
  if (typeof v === "string") {
    return v.length > SCHEMA_STRING_MAX ? v.slice(0, SCHEMA_STRING_MAX) + "…" : v;
  }
  if (Array.isArray(v)) {
    // Array wrappers are not a conceptual nesting level — pass depth through.
    // Without this, {contactPoint: [{@type: "ContactPoint", telephone}]} would
    // collapse to {contactPoint: [{@type: "ContactPoint", _truncated: true}]}
    // because the array increment + object increment hit SCHEMA_MAX_DEPTH.
    return v.slice(0, 3).map((x) => truncateSchemaValue(x, depth));
  }
  if (v && typeof v === "object") {
    if (depth >= SCHEMA_MAX_DEPTH) {
      const t = (v as Record<string, unknown>)["@type"];
      return { "@type": t ?? "object", _truncated: true };
    }
    const result: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      result[k] = truncateSchemaValue(val, depth + 1);
    }
    return result;
  }
  return v;
}

function extractSchemaBlocks(html: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const matches = html.match(/<script[^>]*type=[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of matches) {
    if (blocks.length >= MAX_SCHEMA_BLOCKS_PER_PAGE) break;
    const inner = block.replace(/<script[^>]*>|<\/script>/gi, "").trim();
    if (!inner) continue;
    try {
      const parsed = JSON.parse(inner) as unknown;
      // Flatten @graph arrays and bare arrays
      const items: unknown[] = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>)["@graph"])
          ? ((parsed as Record<string, unknown>)["@graph"] as unknown[])
          : [parsed];
      for (const item of items) {
        if (blocks.length >= MAX_SCHEMA_BLOCKS_PER_PAGE) break;
        if (item && typeof item === "object") {
          const truncated = truncateSchemaValue(item, 0) as Record<string, unknown>;
          blocks.push(truncated);
        }
      }
    } catch {
      // Malformed JSON-LD — skip silently (extractSchemaTypes still captures @type via regex)
    }
  }
  return blocks;
}

function extractFaq(text: string): { question: string; answer: string }[] {
  const faqs: { question: string; answer: string }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Match questions: heading/bold/numbered OR any plain line ending in ? under 150 chars
    // Strip trailing asterisks so bold patterns like **Question?** are recognised
    const stripped = line.replace(/\*+$/, "");
    const isQ = stripped.endsWith("?") && line.length > 10 && line.length < 150 &&
      (line.startsWith("#") || line.startsWith("**") || /^\d+\./.test(line) || /^[A-Z]/.test(line));
    if (isQ) {
      const question = line.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim();
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const nl = lines[j].trim();
        if (nl && !nl.startsWith("#")) {
          faqs.push({ question, answer: nl.replace(/\*\*/g, "").substring(0, 500) });
          break;
        }
      }
    }
  }
  return faqs.slice(0, 20);
}

/** Strip HTML tags and collapse whitespace */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractTitle(html: string): string {
  return html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? "";
}

function extractH1(html: string): string {
  return htmlToText(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "").trim();
}

function extractHeadings(html: string): { level: number; text: string }[] {
  const headings: { level: number; text: string }[] = [];
  const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = htmlToText(m[2]).trim();
    if (text) headings.push({ level: parseInt(m[1]), text });
    if (headings.length >= 30) break;
  }
  return headings;
}

/** Parse <loc> URLs out of sitemap XML text */
function parseSitemapXml(xml: string): string[] {
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/gi)].map((m) => m[1].trim());
}

/** Discover site using sitemap.xml — direct fetch only */
async function discoverUrlsFromSitemap(base: string): Promise<string[]> {
  const sitemapPaths = ["/sitemap.xml", "/sitemap_index.xml", "/sitemap/sitemap.xml"];
  for (const path of sitemapPaths) {
    const sitemapUrl = base + path;
    try {
      // Attempt 1: direct fetch
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(sitemapUrl, {
        signal: controller.signal,
        headers: { "User-Agent": "FlowBlinqGEO/1.0" },
      });
      clearTimeout(tid);

      if (res.status === 200) {
        const xml = await res.text();
        const locs = parseSitemapXml(xml);
        if (locs.length > 0) {
          console.warn(`[geo-crawler] Sitemap direct fetch: ${locs.length} URLs from ${path}`);
          return locs.slice(0, 100);
        }
      }
    } catch { continue; }
  }
  return [];
}

/** Fetch and parse a single page — direct HTTP */
async function fetchPage(url: string, pageType: PageType): Promise<CrawledPage | null> {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FlowBlinqGEO/1.0)",
        Accept: "text/html",
      },
      redirect: "follow",
    });
    clearTimeout(tid);
    if (!res.ok) return null;
    const html = await res.text();
    const title = extractTitle(html);
    const h1 = extractH1(html);
    const headings = extractHeadings(html);
    const text = htmlToText(html).substring(0, 3000);
    const existingSchema = extractSchemaTypes(html);
    const schemaBlocks = extractSchemaBlocks(html);
    const hasStructuredData = existingSchema.length > 0;
    const emails = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) ?? [];
    const phones = text.match(/(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) ?? [];
    const contactInfo = [...emails.slice(0, 3), ...phones.slice(0, 2)];
    const faqContent = extractFaq(text);
    const testimonials: string[] = [];
    const tp = /"([^"]{50,300})"/g;
    let tm;
    while ((tm = tp.exec(text)) !== null) { testimonials.push(tm[1]); if (testimonials.length >= 5) break; }
    const cp = /\b(ISO\s?\d+|SOC\s?\d|GDPR|HIPAA|PCI.DSS|CCPA|BBB|certified|accredited)\b/gi;
    const certifications = [...new Set(text.match(cp) ?? [])].slice(0, 10);
    return {
      url, pageType, title, h1,
      headings: headings.slice(0, 30),
      content: text, existingSchema, hasStructuredData, schemaBlocks,
      contactInfo, faqContent, testimonials, certifications,
    };
  } catch { return null; }
}

// ─── ScraperAPI path ─────────────────────────────────────────────────────────
// Rotating proxies + JS rendering. Purpose-built for bypassing Cloudflare,
// Vercel DDoS protection, and other anti-bot layers. Paid per-request.

async function fetchPageViaScraperAPI(url: string, pageType: PageType): Promise<CrawledPage | null> {
  const key = process.env.SCRAPER_API_KEY;
  if (!key) return null;

  const apiUrl = `http://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(url)}&render=true`;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(apiUrl, { signal: controller.signal });
    clearTimeout(tid);
    if (!res.ok) return null;

    const html = await res.text();
    if (!hasContent(htmlToText(html))) return null;

    const title = extractTitle(html);
    const h1 = extractH1(html);
    const headings = extractHeadings(html);
    const text = htmlToText(html).substring(0, 3000);
    const existingSchema = extractSchemaTypes(html);
    const schemaBlocks = extractSchemaBlocks(html);
    const hasStructuredData = existingSchema.length > 0;
    const emails = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) ?? [];
    const phones = text.match(/(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) ?? [];
    const contactInfo = [...emails.slice(0, 3), ...phones.slice(0, 2)];
    const faqContent = extractFaq(text);
    const testimonials: string[] = [];
    const tp = /"([^"]{50,300})"/g; let tm;
    while ((tm = tp.exec(text)) !== null) { testimonials.push(tm[1]); if (testimonials.length >= 5) break; }
    const cp = /\b(ISO\s?\d+|SOC\s?\d|GDPR|HIPAA|PCI.DSS|CCPA|BBB|certified|accredited)\b/gi;
    const certifications = [...new Set(text.match(cp) ?? [])].slice(0, 10);

    return { url, pageType, title, h1, headings: headings.slice(0, 30), content: text, existingSchema, hasStructuredData, schemaBlocks, contactInfo, faqContent, testimonials, certifications };
  } catch { return null; }
}

// ─── Firecrawl path ──────────────────────────────────────────────────────────

async function discoverWithFirecrawl(domain: string): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Firecrawl } = require("@mendable/firecrawl-js") as { Firecrawl: new (opts: { apiKey: string }) => import("@mendable/firecrawl-js").Firecrawl };
  const fc = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY! });
  // v2 SDK: mapUrl -> map; returns MapData = { links: SearchResultWeb[] } where SearchResultWeb.url is the URL string.
  const result = await fc.map("https://" + domain, { limit: 100000 });
  return result.links.map((l) => l.url);
}

/**
 * Use Gemini Flash to select the top 100 most SEO-valuable URLs from a large list.
 * This is a cheap single LLM call (~$0.001) that replaces blind priority-sorting.
 * Returns the selected URLs in priority order, or null if the call fails.
 */
async function selectTopUrlsWithGemini(urls: string[], domain: string): Promise<string[] | null> {
  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!geminiKey) return null;

  const currentYear = new Date().getFullYear();
  const prompt = `You are a GEO (Generative Engine Optimization) expert. Given this list of URLs from ${domain}, select the top 100 pages most valuable for a GEO audit — optimizing for AI answer engines like ChatGPT, Perplexity, and Google AI Overviews.

PRIORITIZE (in order):
- Homepage, about, team, mission/vision pages
- Pricing, features, product/service pages
- Case studies, testimonials, customer stories
- FAQ, knowledge base, how-it-works pages
- Blog posts and articles published or updated in ${currentYear} or ${currentYear - 1} (look for year in URL path or slug, e.g. /2024/, /2025/)
- Docs and technical guides with substantial content

EXCLUDE:
- Pagination pages (/page/2, ?page=, /p/2 etc.)
- Tag, category, author, and archive pages
- Search result pages (?s=, /search/, ?q=)
- Comment permalinks (#comment-, /comment/)
- URL parameter variants (?ref=, ?utm_source=, ?session=, ?token= etc.)
- Admin, login, checkout, cart pages
- Cookie policy, privacy policy, terms (keep at most 1 legal page)
- Thin pages likely under 300 words: single-image galleries, stub pages, redirect hops
- Any URL with path segments suggesting auto-generated or ephemeral content

Return ONLY a JSON array of the selected URL strings, sorted from most to least GEO-valuable.

URLs:
${urls.join("\n")}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`,  // 2026-06-10 modernization (was gemini-2.5-flash)
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          // 8192 (was 4096): 3.5-flash spends thinking tokens from this same
          // allowance; 4096 risks starving the URL-ranking JSON on long lists.
          generationConfig: { maxOutputTokens: 8192, responseMimeType: "application/json" },
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json() as { candidates?: { content: { parts: { text: string }[] } }[] };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return null;
    return (parsed as unknown[]).filter((u): u is string => typeof u === "string").slice(0, 100);
  } catch (err) {
    // ES-wave-4 §B5 AC-B5-1: surface the underlying error so an observer
    // sees the cause class (network / JSON / Gemini 4xx) and isn't blind
    // to silent fall-through to the priority-sort fallback.
    console.warn("[geo-crawler] selectTopUrlsWithGemini error:", err);
    return null;
  }
}

// Pages where we use LLM extraction (costs 4 extra credits each — use sparingly)
const LLM_EXTRACT_TYPES: PageType[] = ["homepage", "contact", "about"];

const CONTACT_SCHEMA = {
  type: "object",
  properties: {
    email: { type: "string" },
    phone: { type: "string" },
    address: { type: "string" },
    socialProfiles: {
      type: "object",
      properties: {
        twitter: { type: "string" },
        linkedin: { type: "string" },
        instagram: { type: "string" },
        facebook: { type: "string" },
        youtube: { type: "string" },
        github: { type: "string" },
        tiktok: { type: "string" },
      },
    },
    faqs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          answer: { type: "string" },
        },
      },
    },
  },
};

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns true if Firecrawl key is set and not returning 401/402 */
async function checkFirecrawlAvailable(): Promise<boolean> {
  if (!process.env.FIRECRAWL_API_KEY) return false;
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "https://example.com", formats: ["markdown"], timeout: 5000 }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 402) {
      console.warn("[geo-crawler] Firecrawl out of credits — using direct fetch");
      return false;
    }
    return res.ok || res.status !== 401;
  } catch {
    return false;
  }
}

/**
 * Tri-state result of {@link fetchText} (FIND-033). Distinguishes a file that
 * is genuinely absent (404/410) from one we simply couldn't fetch (5xx, 403,
 * rate-limited after all agents, network error). Collapsing both to `null`
 * caused a transient fetch failure to be scored as a hard "file absent".
 */
type FetchTextResult =
  | { status: "present"; text: string }
  | { status: "absent" }
  | { status: "fetch_failed"; reason: string };

/**
 * Fetch a text file — used for GEO file reading (llms.txt, schema.json, business.json).
 * Uses a known AI crawler User-Agent so Vercel/CDN DDoS protection allows it through.
 * Retries with GPTBot if the first attempt is rate-limited.
 *
 * FIND-033: returns a tri-state — `present` (2xx), `absent` (explicit 404/410),
 * or `fetch_failed` (5xx, 403, exhausted all agents on 429, or network error).
 */
async function fetchText(url: string, timeoutMs = 8000): Promise<FetchTextResult> {
  const agents = [
    "GPTBot/1.1",        // OpenAI — widely allowlisted in robots.txt and CDN rules
    "ClaudeBot/1.0",     // Anthropic
    "PerplexityBot/1.0", // Perplexity
  ];
  let lastReason = "no_definitive_response";
  for (const agent of agents) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": agent },
      });
      if (res.ok) return { status: "present", text: await res.text() };
      if (res.status === 404 || res.status === 410) {
        return { status: "absent" }; // genuine absent — don't penalize as a fetch failure
      }
      if (res.status === 429 || res.status === 403) {
        // Rate-limited / forbidden — could be CDN protection. Try the next agent.
        console.warn(`[geo-crawler] fetchText ${res.status} for ${url} with ${agent} — trying next agent`);
        lastReason = `http_${res.status}`;
        continue;
      }
      // Other non-ok (5xx etc) — indeterminate, not a definitive absent.
      return { status: "fetch_failed", reason: `http_${res.status}` };
    } catch (err) {
      const e = err as { code?: string; cause?: { code?: string }; message?: string };
      if (e?.code === "ENOTFOUND" || e?.cause?.code === "ENOTFOUND") {
        console.warn(`[geo-crawler] skipping retry on ENOTFOUND for ${url}`);
        return { status: "fetch_failed", reason: "ENOTFOUND" };
      }
      lastReason = e?.message ?? String(err);
      continue;
    }
  }
  // Exhausted all agents without a definitive answer (e.g. 429/403 throughout).
  return { status: "fetch_failed", reason: lastReason };
}

/**
 * Result of FlowBlinq asset detection — independent of URL discovery.
 * Returned by `detectFlowblinqAssets` and consumed by both single-mode
 * (`discoverSite`) and bulk-mode (`handleCrawlFanout` in pipeline/stage/route.ts).
 */
export interface FlowblinqAssetsResult {
  hasLlmsTxt: boolean;
  hasUcp: boolean;
  hasSitemap: boolean;
  hasRobots: boolean;
  wwwRedirectStatus: "ok" | "missing" | "unknown";
  finalLlmsTxt: string | undefined;
  finalSchemaJson: unknown;
  finalBusinessJson: unknown;
  flowblinqGeneratedSchemaBlocks: unknown;
  installedFromFlowblinq: boolean;
  // FIND-033: true when the corresponding file fetch was indeterminate (5xx,
  // 403, rate-limited, network error) rather than a genuine absent (404/410).
  // Lets the analyzer avoid scoring a transient failure as a hard "file absent".
  llmsTxtFetchFailed: boolean;
  schemaFetchFailed: boolean;
  businessFetchFailed: boolean;
}

/**
 * Detect FlowBlinq-relevant assets on a customer domain — independent of URL discovery.
 *
 * Used by both single-mode (`discoverSite`) and bulk-mode (`handleCrawlFanout`) so
 * both code paths surface the same FlowBlinq integration signals to the analyzer prompt.
 *
 * Pre-fix: bulk-mode constructed a synthetic discoveryData object that hardcoded
 * `hasLlmsTxt: false / installedFromFlowblinq: undefined / flowblinqGeneratedSchemaBlocks: undefined`,
 * causing every bulk-audit customer to score as if they had no FlowBlinq integration installed
 * — even when they had verified their domain and were serving FlowBlinq's content.
 * See `app/api/pipeline/stage/route.ts:309-317` and the prompt rendering at
 * `lib/services/geo-analyzer.ts:277-291`.
 */
export async function detectFlowblinqAssets(domain: string): Promise<FlowblinqAssetsResult> {
  const base = "https://" + domain;

  // Check what files exist in parallel — including GEO files the customer may have
  const [hasLlmsTxt, hasUcp, hasSitemap, hasRobots, wwwRedirectStatus] = await Promise.all([
    checkUrlExists(base + "/llms.txt"),
    checkUrlExists(base + "/.well-known/ucp"),
    checkUrlExists(base + "/sitemap.xml"),
    checkUrlExists(base + "/robots.txt"),
    checkWwwRedirect(domain),
  ]);

  // Fetch the customer's own GEO files if they exist — gives us ground truth for scoring
  // (their llms.txt tells us exactly how they want to be described; schema.json shows
  // what structured data they've already published)
  // FIND-033: tri-state fetch — distinguish genuine absent (404/410) from a
  // failed fetch (5xx, 403, rate-limited, network error). llms.txt is only
  // fetched when checkUrlExists already confirmed it exists; when it doesn't,
  // treat it as a clean absent (status "absent") rather than a fetch failure.
  const [llmsRes, schemaRes, businessRes]: FetchTextResult[] = await Promise.all([
    hasLlmsTxt ? fetchText(base + "/llms.txt") : Promise.resolve<FetchTextResult>({ status: "absent" }),
    fetchText(base + "/schema.json").catch((err) => ({ status: "fetch_failed", reason: err instanceof Error ? err.message : String(err) }) as FetchTextResult),
    fetchText(base + "/business.json").catch((err) => ({ status: "fetch_failed", reason: err instanceof Error ? err.message : String(err) }) as FetchTextResult),
  ]);

  const llmsTxtFetchFailed = llmsRes.status === "fetch_failed";
  const schemaFetchFailed = schemaRes.status === "fetch_failed";
  const businessFetchFailed = businessRes.status === "fetch_failed";

  if (llmsTxtFetchFailed) console.warn(JSON.stringify({ event: "geo_file_fetch_failed", domain, file: "llms.txt", reason: (llmsRes as { reason: string }).reason }));
  if (schemaFetchFailed) console.warn(JSON.stringify({ event: "geo_file_fetch_failed", domain, file: "schema.json", reason: (schemaRes as { reason: string }).reason }));
  if (businessFetchFailed) console.warn(JSON.stringify({ event: "geo_file_fetch_failed", domain, file: "business.json", reason: (businessRes as { reason: string }).reason }));

  const ownLlmsTxt = llmsRes.status === "present" ? llmsRes.text : undefined;
  const ownSchemaRaw = schemaRes.status === "present" ? schemaRes.text : null;
  const ownBusinessRaw = businessRes.status === "present" ? businessRes.text : null;
  let ownSchemaJson: unknown;
  let ownBusinessJson: unknown;
  try { if (ownSchemaRaw) ownSchemaJson = JSON.parse(ownSchemaRaw); } catch { /* ignore */ }
  try { if (ownBusinessRaw) ownBusinessJson = JSON.parse(ownBusinessRaw); } catch { /* ignore */ }

  if (ownLlmsTxt) console.warn(`[detectFlowblinqAssets] Found own llms.txt for ${domain} (${ownLlmsTxt.length} chars)`);
  if (ownSchemaJson) console.warn(`[detectFlowblinqAssets] Found own schema.json for ${domain}`);
  if (ownBusinessJson) console.warn(`[detectFlowblinqAssets] Found own business.json for ${domain}`);

  // Also check FlowBlinq's own serve endpoints for this domain —
  // customers install our generated files via geo.flowblinq.com/api/serve/[slug]/
  // If they haven't installed at their root, we still want to score them on what was GENERATED
  let flowblinqServedLlmsTxt: string | undefined;
  let flowblinqServedSchemaJson: unknown;
  let flowblinqServedBusinessJson: unknown;
  let flowblinqGeneratedSchemaBlocks: unknown;
  try {
    const [siteRecord] = await db.select({
      slug: geoSites.slug,
      generatedLlmsTxt: geoSites.generatedLlmsTxt,
      generatedSchemaBlocks: geoSites.generatedSchemaBlocks,
      generatedBusinessJson: geoSites.generatedBusinessJson,
    }).from(geoSites).where(eq(geoSites.domain, domain));

    if (siteRecord) {
      if (siteRecord.generatedLlmsTxt) flowblinqServedLlmsTxt = siteRecord.generatedLlmsTxt;
      if (siteRecord.generatedSchemaBlocks) flowblinqServedSchemaJson = siteRecord.generatedSchemaBlocks;
      if (siteRecord.generatedBusinessJson) flowblinqServedBusinessJson = siteRecord.generatedBusinessJson;
      if (siteRecord.generatedSchemaBlocks) flowblinqGeneratedSchemaBlocks = siteRecord.generatedSchemaBlocks;
      if (siteRecord.generatedLlmsTxt) console.warn(`[detectFlowblinqAssets] Found FlowBlinq-generated llms.txt for ${domain} (${siteRecord.generatedLlmsTxt.length} chars)`);
      if (siteRecord.generatedSchemaBlocks) console.warn(`[detectFlowblinqAssets] Found FlowBlinq-generated schema blocks for ${domain}`);
    }
  } catch (err) {
    console.warn(`[detectFlowblinqAssets] Failed to fetch FlowBlinq served assets for ${domain}:`, err);
  }

  return {
    hasLlmsTxt,
    hasUcp,
    hasSitemap,
    hasRobots,
    wwwRedirectStatus,
    // Prefer customer-installed files over generated ones (customer may have customized)
    finalLlmsTxt: ownLlmsTxt ?? flowblinqServedLlmsTxt,
    finalSchemaJson: ownSchemaJson ?? flowblinqServedSchemaJson,
    finalBusinessJson: ownBusinessJson ?? flowblinqServedBusinessJson,
    flowblinqGeneratedSchemaBlocks,
    installedFromFlowblinq: !!(flowblinqServedLlmsTxt || flowblinqServedSchemaJson),
    llmsTxtFetchFailed,
    schemaFetchFailed,
    businessFetchFailed,
  };
}

export async function discoverSite(domain: string, maxPages = 1000): Promise<DiscoveryData> {
  const base = "https://" + domain;

  // Detect FlowBlinq assets — extracted to a shared helper so bulk-mode (which skips
  // discoverSite) can call the same logic. Pre-extraction this lived inline here.
  const flowblinqAssets = await detectFlowblinqAssets(domain);
  const {
    hasLlmsTxt, hasUcp, hasSitemap, hasRobots, wwwRedirectStatus,
    finalLlmsTxt, finalSchemaJson, finalBusinessJson,
    flowblinqGeneratedSchemaBlocks, installedFromFlowblinq,
    llmsTxtFetchFailed, schemaFetchFailed, businessFetchFailed,
  } = flowblinqAssets;

  // URL discovery: Firecrawl map() (v2) as primary (~8s, 1 credit, guaranteed URL list)
  let fcUrls: string[] = [];
  try {
    fcUrls = await discoverWithFirecrawl(domain);
    console.warn(`[geo-crawler] Firecrawl map: ${fcUrls.length} URLs`);
  } catch (err) {
    console.warn(`[geo-crawler] Firecrawl map failed: ${err} — falling back`);
  }

  const merged: string[] = [...fcUrls];

  // Fallback: common path seeds if Firecrawl returns nothing
  if (merged.length === 0) {
    const commonPaths = ["/", "/about", "/pricing", "/services", "/contact", "/blog", "/team", "/faq"];
    merged.push(...commonPaths.map((p) => base + p));
    console.warn("[geo-crawler] Using common path seeds");
  }

  // Select top maxPages using Gemini if we have a large URL pool, else fall back to priority sort
  let urls: string[];
  if (merged.length > maxPages) {
    console.warn(`[geo-crawler] ${merged.length} URLs found — asking Gemini to select top ${maxPages}`);
    const geminiSelected = await selectTopUrlsWithGemini(merged, domain);
    if (geminiSelected && geminiSelected.length > 0) {
      console.warn(`[geo-crawler] Gemini selected ${geminiSelected.length} URLs`);
      urls = geminiSelected.slice(0, maxPages);
    } else {
      console.warn(`[geo-crawler] Gemini selection failed — falling back to priority sort`);
      // Decorate-sort-undecorate: classify each URL once (O(n)) instead of inside the
      // comparator (Θ(n log n) classifications). classifyPageType is a pure URL parse +
      // ~15 segment checks, so the precompute is the dominant cost — pay it once.
      const ranked = merged.map((u) => ({ u, priority: PAGE_PRIORITY[classifyPageType(u)] ?? 99 }));
      ranked.sort((a, b) => a.priority - b.priority);
      urls = ranked.slice(0, maxPages).map((r) => r.u);
    }
  } else {
    urls = merged.slice(0, maxPages);
  }

  if (!urls.some((u) => u === base || u === base + "/")) {
    urls.unshift(base + "/");
  }

  console.warn(`[geo-crawler] Discovery complete: ${urls.length} URLs total`);

  const pageMap: Record<string, PageType> = {};
  for (const url of urls) pageMap[url] = classifyPageType(url);

  return {
    urls, pageMap, hasLlmsTxt, hasUcp, hasSitemap, hasRobots,
    totalPages: urls.length,
    discoveredPages: merged.length > urls.length ? merged.length : undefined,
    wwwRedirectStatus,
    sitemapStale: false, urlsNotInSitemap: [],
    ownLlmsTxt: finalLlmsTxt, ownSchemaJson: finalSchemaJson, ownBusinessJson: finalBusinessJson,
    flowblinqGeneratedSchemaBlocks,
    installedFromFlowblinq,
    llmsTxtFetchFailed, schemaFetchFailed, businessFetchFailed,
  };
}

/** Jitter sleep: base ± 30% random variance to avoid thundering-herd patterns */
function jitterSleep(baseMs: number): Promise<void> {
  const variance = baseMs * 0.3;
  const delay = baseMs + (Math.random() * variance * 2 - variance);
  return new Promise((r) => setTimeout(r, delay));
}

/**
 * Crawl a single page — proxied tiers first (never expose Vercel's datacenter IP
 * directly to the target site). Direct fetch is last resort only.
 *
 * Tier 1: Direct fetch — fast, free, no JS rendering
 * Tier 2: ScraperAPI (paid — rotating residential proxies, handles Cloudflare)
 * Tier 3: Firecrawl (paid — credits-based, LLM extraction)
 */
async function crawlPageWithFallbacks(
  url: string,
  pageType: PageType,
  pageMap: Record<string, PageType>
): Promise<CrawledPage | null> {
  // Tier 1: Direct fetch — fast, free, no JS rendering
  let result = await fetchPage(url, pageType);
  if (result && !isErrorPage(result.content, result.title)) return result;

  // Tier 2: ScraperAPI — paid, rotating residential proxies, handles Cloudflare/DDoS
  console.warn(`[geo-crawler] Direct fetch failed for ${url}, trying ScraperAPI`);
  result = await fetchPageViaScraperAPI(url, pageType);
  if (result && !isErrorPage(result.content, result.title)) return result;

  // [pipeline] All tiers exhausted — if we reach here, mark URL as failed
  console.warn(`[geo-crawler] All fallback tiers exhausted for ${url}`);
  return null;
}

/**
 * Retry only the pages that came back as error/bot-challenge pages in a previous crawl.
 * Used by the pipeline when scoreCrawlQuality() says the crawl was poor.
 * Returns a merged CrawlData with the retried pages replacing the bad ones.
 */
export async function retryBlockedPages(crawlData: CrawlData, pageMap: Record<string, PageType>): Promise<CrawlData> {
  const badUrls = crawlData.pages
    .filter(p => isErrorPage(p.content ?? "", p.title ?? ""))
    .map(p => p.url);

  if (badUrls.length === 0) return crawlData;
  console.warn(`[geo-crawler] Retrying ${badUrls.length} blocked page(s) with ScraperAPI priority`);

  const retried: CrawledPage[] = [];
  for (const url of badUrls) {
    const pageType = pageMap[url] ?? classifyPageType(url);
    // For retry, lead with ScraperAPI
    let result = await fetchPageViaScraperAPI(url, pageType);
    if (!result || isErrorPage(result.content, result.title)) {
      result = await fetchPage(url, pageType);
    }
    if (result && !isErrorPage(result.content, result.title)) retried.push(result);
    await jitterSleep(1500);
  }

  // Merge: replace bad pages with retried ones, keep good original pages
  const goodOriginals = crawlData.pages.filter(p => !isErrorPage(p.content ?? "", p.title ?? ""));
  const merged = [...goodOriginals, ...retried];
  console.warn(`[geo-crawler] Retry complete — recovered ${retried.length}/${badUrls.length} pages`);
  return { ...crawlData, pages: merged, totalCrawled: merged.length };
}

export async function deepCrawl(domain: string, pageMap: Record<string, PageType>): Promise<CrawlData> {
  const sorted = Object.entries(pageMap)
    .sort(([, a], [, b]) => (PAGE_PRIORITY[a] ?? 99) - (PAGE_PRIORITY[b] ?? 99))
    .map(([url]) => url);

  const pages: CrawledPage[] = [];
  // Fully sequential — ScraperAPI/Firecrawl proxy the requests so the origin site
  // never sees concurrent hits, but we still space them out to avoid
  // rate-limit fingerprinting at the proxy layer too.
  for (let i = 0; i < sorted.length; i++) {
    const url = sorted[i];
    const pageType = pageMap[url] ?? classifyPageType(url);

    const result = await crawlPageWithFallbacks(url, pageType, pageMap);
    if (result) pages.push(result);

    // 1s ± 300ms jitter between pages — balances rate-limit evasion vs Vercel timeout budget
    if (i < sorted.length - 1) await jitterSleep(1000);
  }

  console.warn(`[geo-crawler] Deep crawl complete: ${pages.length} pages`);
  return { domain, pages, totalCrawled: pages.length };
}

// ─── Fan-out crawl utilities (ES-023) ────────────────────────────────────────

// Minimum markdown length for fan-out batch pages to be considered usable.
// Raised 50 -> 200 in M-8 follow-up per dev-ui-design-pass branch intent (commit ecb5bac).
const MIN_CONTENT_LENGTH = 50;  // FIX-029 (2026-06-09): reverted from 200 — the bump in M-8 follow-up commit 085bd6e silently dropped 80%+ of pages on JS-heavy SPAs (e.g. flowblinq.com Pro tier crawled 10/49 URLs)

function hasContent(md: string): boolean {
  return md.replace(/\s+/g, " ").trim().length >= MIN_CONTENT_LENGTH;
}

// FIX-032 (2026-06-09): URL normalization for submitted-vs-returned comparison.
// Firecrawl reports back the final post-redirect URL (e.g. https://www.x.com/p/)
// while we submitted https://x.com/p -- exact string comparison then marks every
// successfully-crawled URL as "failed" (sigmaindia.in: 500/500 false failures).
// Comparison ignores scheme, www-prefix, host case, and trailing slashes.
export function normalizeUrlForComparison(u: string): string {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return host + path + url.search;
  } catch {
    return u.trim().toLowerCase().replace(/\/+$/, "");
  }
}

export type FcDoc = {
  markdown?: string;
  rawHtml?: string;
  metadata?: { title?: string; url?: string; sourceURL?: string; [key: string]: unknown };
};

/**
 * Map a Firecrawl Document to a CrawledPage.
 * Returns null if content is too thin or URL is missing.
 */
export function mapDocumentToPage(
  doc: FcDoc,
  pageMap: Record<string, PageType>
): CrawledPage | null {
  const md = doc.markdown ?? "";
  if (!hasContent(md)) return null;

  const meta = doc.metadata ?? {};
  const url = String(meta.url ?? meta.sourceURL ?? "");
  if (!url) return null;

  const pageType = pageMap[url] ?? classifyPageType(url);
  const title = String(meta.title ?? "");

  const h1m = md.match(/^#\s+(.+)/m);
  const h1 = h1m ? h1m[1].trim() : "";
  const headings: { level: number; text: string }[] = [];
  const hp = /^(#{1,6})\s+(.+)/gm;
  let hm;
  while ((hm = hp.exec(md)) !== null) headings.push({ level: hm[1].length, text: hm[2].trim() });

  const content = md.replace(/!\[.*?\]\(.*?\)/g, "").substring(0, 3000);
  const emails = md.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) ?? [];
  const phones = md.match(/(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) ?? [];

  // Issue-K fix (2026-04-10): Firecrawl's bulk scrape returns markdown only
  // by default, which strips JSON-LD <script> blocks. Single-mode direct
  // fetch path extracts schema via extractSchemaTypes(html) at fetchPage().
  // For bulk mode we now request formats: ["markdown", "rawHtml"] (see
  // pipeline/stage/route.ts handleCrawlFanout) so doc.rawHtml contains the
  // untouched HTML including all <script type="application/ld+json"> blocks.
  // rawHtml is used for extraction ONLY — we don't store it on CrawledPage,
  // so crawl_chunk_results JSONB stays the same size. existingSchema is an
  // array of up to ~20 @type strings per page.
  const rawHtml = doc.rawHtml ?? "";
  const existingSchema = rawHtml ? extractSchemaTypes(rawHtml) : [];
  const schemaBlocks = rawHtml ? extractSchemaBlocks(rawHtml) : [];
  const hasStructuredData = existingSchema.length > 0;

  return {
    url, pageType,
    title: title || h1 || url,
    h1, headings: headings.slice(0, 30), content,
    existingSchema, hasStructuredData, schemaBlocks,
    contactInfo: [...emails.slice(0, 3), ...phones.slice(0, 2)],
    faqContent: extractFaq(md), testimonials: [], certifications: [],
  };
}

/**
 * Compute fan-out chunk count and chunk size from total page count.
 *
 * Formula: num_chunks = min(CRAWL_MAX_CHUNKS, total_pages)
 *          chunk_size = ceil(total_pages / num_chunks)
 *
 * Edge case: totalPages === 0 → returns { numChunks: 0, chunkSize: 0 }
 */
export function computeChunks(totalPages: number): { numChunks: number; chunkSize: number } {
  if (totalPages === 0) return { numChunks: 0, chunkSize: 0 };
  const numChunks = Math.min(CRAWL_MAX_CHUNKS, totalPages);
  const chunkSize = Math.ceil(totalPages / numChunks);
  return { numChunks, chunkSize };
}
