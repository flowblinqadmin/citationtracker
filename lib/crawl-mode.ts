/**
 * Crawl mode abstraction.
 *
 * firecrawl — Quality path (Pro/Enterprise): synchronous Firecrawl scrape per URL
 *             via firecrawlScrapePass(), with async fireFirecrawlJobs() for any
 *             URLs that the sync scrape fails. Immediate per-URL quality checks,
 *             fastest time-to-first-result. Higher Vercel function execution time.
 *
 * standard  — Cost-optimized path (free tier): skip the synchronous scrape pass
 *             entirely. All discovered URLs go straight to Firecrawl's async
 *             crawler (fireFirecrawlJobs). Near-instant crawl stage submission,
 *             minimal function execution time, results arrive via the poll stage.
 *
 * Note: free-tier single audits are currently paused (402), so in production all
 * single-site crawls use "firecrawl" mode. "standard" mode is wired and ready for
 * when free-tier is re-enabled.
 */
export type CrawlMode = "standard" | "firecrawl";

/**
 * Derives crawl mode from the site record at runtime.
 *
 * Accounts with credits (creditBalance > 0) get the synchronous firecrawl
 * scrape path — higher quality, per-URL feedback, best for single-site audits.
 *
 * Zero-credit accounts get the async-only path — skip the sync scrape,
 * all URLs go straight to Firecrawl's async batch crawler, reducing Vercel
 * function execution time and cost.
 *
 * Bulk audits always use async-only (fireBulkFirecrawlJobs) regardless of
 * credit balance — that function is optimised for high-URL-count batch submission.
 */
export function getCrawlMode(site: {
  auditMode?: string | null;
}, creditBalance: number): CrawlMode {
  if (site.auditMode === "bulk") return "standard"; // bulk has its own path, mode is informational
  if (creditBalance > 0) return "firecrawl";
  return "standard";
}
