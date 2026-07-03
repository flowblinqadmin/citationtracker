/**
 * Attempt to fetch a URL through escalating proxy tiers.
 * Tier 1: Direct fetch with AI crawler User-Agents
 * Tier 2: ScraperAPI — rotating residential proxies
 * Tier 3: Firecrawl — credits-based, last resort
 *
 * Returns { ok, status, body, method } or null if all tiers fail.
 */
export async function proxyFetch(
  url: string,
  init?: RequestInit & { method?: "HEAD" | "GET" },
): Promise<{ ok: boolean; status: number; method: string | null; body?: string } | null> {
  const isHead = init?.method === "HEAD";

  // Tier 1: Direct fetch with AI crawler User-Agents
  for (const agent of ["GPTBot/1.1", "ClaudeBot/1.0", "PerplexityBot/1.0"]) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": agent },
        redirect: "follow",
        ...init,
      });
      // If we get anything other than rate-limited, use this result
      if (res.status !== 429 && res.status !== 403) {
        const body = !isHead && res.ok ? await res.text() : "";
        return { ok: res.ok, status: res.status, body, method: `direct (${agent})` };
      }
    } catch { continue; }
  }

  // Tier 2: ScraperAPI — rotating residential proxies
  const scraperKey = process.env.SCRAPER_API_KEY;
  if (scraperKey) {
    try {
      const res = await fetch(
        `http://api.scraperapi.com?api_key=${scraperKey}&url=${encodeURIComponent(url)}`,
        { signal: AbortSignal.timeout(20000) }
      );
      if (res.status !== 429 && res.status !== 403) {
        const body = !isHead && res.ok ? await res.text() : "";
        return { ok: res.ok, status: res.status, body, method: "ScraperAPI" };
      }
    } catch { /* fall through */ }
  }

  // Tier 3: Firecrawl — credits-based, last resort
  const firecrawlKey = process.env.FIRECRAWL_API_KEY;
  if (firecrawlKey) {
    try {
      const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        signal: AbortSignal.timeout(20000),
        headers: { "Authorization": `Bearer ${firecrawlKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: false }),
      });
      if (res.ok) {
        const data = await res.json() as { success?: boolean; data?: { markdown?: string } };
        const body = data.data?.markdown ?? "";
        if (body.length > 0) return { ok: true, status: 200, body, method: "Firecrawl" };
      }
    } catch { /* fall through */ }
  }

  return null;
}
