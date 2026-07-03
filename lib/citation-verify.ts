// Hallucination guard for AI citations.
//
// AI platforms cite real-looking URLs that are dead or — worse — live pages
// about something else entirely (e.g. "AI Flow alternatives" cited for
// FlowBlinq). Every cited URL gets fetched and classified:
//   verified     live AND the visible text mentions a brand keyword
//   no_mention   live but the brand never appears — hallucinated relevance
//   dead         4xx/5xx or unreachable
//   unverifiable non-text content, or a URL/redirect we refuse to fetch
//
// The URLs come from AI output (untrusted), so the fetcher is SSRF-guarded:
// http(s) only, default ports, no IP literals, no localhost/private suffixes,
// and redirects are followed manually with the same guard per hop.

import type { CitationCheckStatus } from "@/lib/db/schema";

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_CHARS = 500_000;
const UA = "Mozilla/5.0 (compatible; FlowBlinqCitationCheck/1.0; +https://geo.flowblinq.com)";

const BLOCKED_SUFFIXES = [".local", ".internal", ".localdomain"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal"]);

export function isFetchableUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.port !== "") return false; // default ports only
  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return false;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return false;
  // Any IP literal (v4 or v6) — private ranges are dangerous, public ones are
  // junk citations; block them all.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":") || host.startsWith("[")) return false;
  if (!host.includes(".")) return false;
  return true;
}

/** Visible text only — a keyword inside an href/script/style is not a mention. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ");
}

export interface PageVerdict {
  status: CitationCheckStatus;
  brandMatched?: boolean;
}

// The page exists but blocks automated fetchers — no claim either way.
// (g2/producthunt return 403/429 to bots while opening fine in a browser.)
const BOT_BLOCKED = new Set([401, 403, 407, 429, 451]);

export function classifyPage(
  httpStatus: number,
  contentType: string | null,
  body: string,
  brandKeywords: string[],
): PageVerdict {
  if (BOT_BLOCKED.has(httpStatus)) return { status: "unverifiable" };
  if (httpStatus >= 400) return { status: "dead" };
  const type = (contentType ?? "").toLowerCase();
  if (!type.includes("html") && !type.includes("text/plain")) return { status: "unverifiable" };
  const text = stripHtml(body).toLowerCase();
  const matched = brandKeywords.some((k) => k.trim() && text.includes(k.trim().toLowerCase()));
  return matched ? { status: "verified", brandMatched: true } : { status: "no_mention", brandMatched: false };
}

export interface CitationVerdict extends PageVerdict {
  httpStatus?: number;
  /** How the final verdict was reached. */
  via?: "fetch" | "crawler";
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
/** Returns the page as markdown, or null when the crawl fails/unavailable. */
type Crawler = (url: string) => Promise<string | null>;

/** Brand keywords against markdown's visible text — link targets don't count. */
export function markdownMentionsBrand(markdown: string, brandKeywords: string[]): boolean {
  const text = markdown
    .replace(/\]\([^)]*\)/g, "] ") // markdown link targets
    .replace(/https?:\/\/\S+/g, " ") // bare URLs
    .toLowerCase();
  return brandKeywords.some((k) => k.trim() && text.includes(k.trim().toLowerCase()));
}

/**
 * Firecrawl scrape — the escalation path. It renders JS and gets through
 * bot walls (g2/producthunt 403 plain fetchers), so it settles the two
 * verdicts a plain fetch can't: bot-blocked pages and possible false
 * no_mention on JS-rendered content.
 */
async function firecrawlScrape(url: string): Promise<string | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: false, timeout: 30_000 }),
      signal: AbortSignal.timeout(40_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const md = body?.data?.markdown;
    return typeof md === "string" ? md.slice(0, MAX_BODY_CHARS) : null;
  } catch {
    return null;
  }
}

/**
 * Fetch a cited URL (guarded, manual redirects) and classify it. Verdicts a
 * plain fetch can't settle (bot-blocked, or live-but-no-mention that might be
 * JS-rendered) escalate to the crawler before being finalized.
 */
export async function verifyCitationUrl(
  url: string,
  brandKeywords: string[],
  fetcher: Fetcher = fetch,
  crawler: Crawler = firecrawlScrape,
): Promise<CitationVerdict> {
  const direct = await directFetchVerdict(url, brandKeywords, fetcher);
  if (direct.status !== "unverifiable" && direct.status !== "no_mention") return direct;
  if (!isFetchableUrl(url)) return direct; // never hand a blocked URL to the crawler

  const markdown = await crawler(url);
  if (markdown === null) return direct; // crawler unavailable — keep the honest verdict
  const matched = markdownMentionsBrand(markdown, brandKeywords);
  return matched
    ? { status: "verified", brandMatched: true, httpStatus: direct.httpStatus, via: "crawler" }
    : { status: "no_mention", brandMatched: false, httpStatus: direct.httpStatus, via: "crawler" };
}

async function directFetchVerdict(
  url: string,
  brandKeywords: string[],
  fetcher: Fetcher,
): Promise<CitationVerdict> {
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isFetchableUrl(current)) return { status: "unverifiable" };
      const res = await fetcher(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { status: "dead", httpStatus: res.status };
        current = new URL(location, current).toString();
        continue;
      }
      const body =
        res.status < 400 ? (await res.text()).slice(0, MAX_BODY_CHARS) : "";
      const verdict = classifyPage(res.status, res.headers.get("content-type"), body, brandKeywords);
      return { ...verdict, httpStatus: res.status, via: "fetch" };
    }
    return { status: "unverifiable" }; // redirect loop
  } catch {
    return { status: "dead" };
  }
}
