// AI Search visibility — does Google's AI Overview answer this prompt, does
// it mention the brand, and which sources does it cite?
//
// Chat APIs can't see this surface. A Firecrawl scrape of the rendered SERP
// captures the AI Overview block as markdown (verified live 2026-07-03); this
// module extracts the block, the brand-mention signal, and the cited links.

import { markdownMentionsBrand } from "@/lib/citation-verify";

const MAX_OVERVIEW_CHARS = 6_000;

// The AI Overview block ends where the next SERP section begins.
const END_MARKERS = [
  "People also ask",
  "AI responses may include mistakes",
  "Dive deeper in AI Mode",
  "People also search for",
  "Search Results",
];

// SERP plumbing links that are never sources.
const NON_SOURCE_HOSTS = [
  "google.com",
  "www.google.com",
  "support.google.com",
  "accounts.google.com",
  "policies.google.com",
  "maps.google.com",
];

export interface AiOverviewParse {
  present: boolean;
  text: string | null;
  citations: Array<{ url: string; label: string }>;
}

/** Extract the AI Overview block from a scraped Google SERP (markdown). */
export function parseAiOverview(serpMarkdown: string): AiOverviewParse {
  // Only a line-start "AI Overview" heading counts (the "not available" banner
  // and inline phrases like "an AI overview right now" must not match), and it
  // must be followed by substantive content.
  let start = -1;
  let from = 0;
  while (true) {
    const i = serpMarkdown.indexOf("AI Overview", from);
    if (i === -1) break;
    const atLineStart = i === 0 || serpMarkdown[i - 1] === "\n";
    const after = serpMarkdown.slice(i + "AI Overview".length, i + 400);
    if (atLineStart && !/^\s*is not available/i.test(after) && after.trim().length > 80) {
      start = i;
      break;
    }
    from = i + "AI Overview".length;
  }
  if (start === -1) return { present: false, text: null, citations: [] };

  let block = serpMarkdown.slice(start + "AI Overview".length);
  let end = block.length;
  for (const marker of END_MARKERS) {
    const i = block.indexOf(marker);
    if (i !== -1 && i < end) end = i;
  }
  block = block.slice(0, Math.min(end, MAX_OVERVIEW_CHARS));

  const citations: Array<{ url: string; label: string }> = [];
  const seen = new Set<string>();
  for (const m of block.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const [, label, url] = m;
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (NON_SOURCE_HOSTS.includes(host)) continue;
    if (label.startsWith("![") || seen.has(url)) continue;
    seen.add(url);
    citations.push({ url, label: label.replace(/\s*\(\+\d+\).*$/, "").trim() });
  }

  const text = block
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\s+/g, " ")
    .trim();

  return { present: true, text: text.slice(0, MAX_OVERVIEW_CHARS), citations };
}

export interface AiSearchResult extends AiOverviewParse {
  brandMentioned: boolean | null; // null when no overview was shown
}

type SerpScraper = (query: string) => Promise<string | null>;

/** Scrape the Google SERP for `query` through Firecrawl; null when it fails. */
async function scrapeGoogleSerp(query: string): Promise<string | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`,
        formats: ["markdown"],
        onlyMainContent: false,
        waitFor: 3000,
        timeout: 40_000,
      }),
      signal: AbortSignal.timeout(50_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const md = body?.data?.markdown;
    return typeof md === "string" ? md : null;
  } catch {
    return null;
  }
}

/** Check one prompt against Google's AI Overview; null when the scrape fails. */
export async function checkAiSearch(
  query: string,
  brandKeywords: string[],
  scraper: SerpScraper = scrapeGoogleSerp,
): Promise<AiSearchResult | null> {
  const serp = await scraper(query);
  if (serp === null) return null;
  const parsed = parseAiOverview(serp);
  return {
    ...parsed,
    brandMentioned: parsed.present && parsed.text ? markdownMentionsBrand(parsed.text, brandKeywords) : null,
  };
}
