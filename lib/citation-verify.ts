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
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Fetch a cited URL (guarded, manual redirects) and classify it. */
export async function verifyCitationUrl(
  url: string,
  brandKeywords: string[],
  fetcher: Fetcher = fetch,
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
      return { ...verdict, httpStatus: res.status };
    }
    return { status: "unverifiable" }; // redirect loop
  } catch {
    return { status: "dead" };
  }
}
