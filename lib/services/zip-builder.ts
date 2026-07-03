import JSZip from "jszip";
import type { PerPageResult } from "./per-page-analyzer";
import type { PerPageFix } from "./page-fix-generator";
import type { ImplementationStatus } from "./implementation-tracker";
import { generatePerPageHtml, generateAggregateHtml } from "./report-generator";

interface SiteForZip {
  domain: string;
  geoScorecard: {
    overallScore: number;
    pillars: Array<{ pillarName: string; score: number; priority: string }>;
    topThreeImprovements: string[];
  };
  executiveSummary: string;
  failedUrls?: string[];
}

/**
 * Build a ZIP archive containing per-page HTML reports and an aggregate report.
 * Returns a Buffer suitable for streaming as application/zip.
 *
 * 501 pages × ~5KB = ~2.5MB uncompressed, ~500KB compressed. Generates in <2s.
 */
export async function buildReportZip(
  site: SiteForZip,
  perPageResults: PerPageResult[],
  perPageFixes?: PerPageFix[],
  implementationStatus?: ImplementationStatus[]
): Promise<Buffer> {
  const zip = new JSZip();

  // Build lookup maps
  const fixByUrl = new Map<string, PerPageFix>();
  for (const fix of perPageFixes ?? []) fixByUrl.set(fix.url, fix);
  const implByUrl = new Map<string, ImplementationStatus>();
  for (const impl of implementationStatus ?? []) implByUrl.set(impl.url, impl);

  // Aggregate report at root
  const aggregateHtml = generateAggregateHtml(site, perPageResults, implementationStatus, perPageFixes);
  zip.file("aggregate-report.html", aggregateHtml);

  // Per-page reports in pages/ folder — createFolders:false prevents JSZip from adding a "pages/" dir entry
  for (const result of perPageResults) {
    const filename = urlToFilename(result.url) + ".html";
    const fix = fixByUrl.get(result.url);
    const impl = implByUrl.get(result.url);
    const html = generatePerPageHtml(result, site.domain, fix, impl);
    zip.file(`pages/${filename}`, html, { createFolders: false });
  }

  // fixes-summary.csv (when fix data is available)
  if (perPageFixes && perPageFixes.length > 0) {
    const csvEscape = (v: string | null | undefined): string => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const headers = ["URL", "Current Title", "Suggested Title", "Suggested Meta Description", "H1 Fix", "Heading Fixes", "Schema Blocks", "Implementation Status"];
    const rows = perPageFixes.map((fix) => {
      const impl = implByUrl.get(fix.url);
      const implSummary = impl ? `${impl.implementedCount}/${impl.totalFixes} implemented` : "";
      return [
        csvEscape(fix.url),
        csvEscape(fix.currentTitle),
        csvEscape(fix.suggestedTitle),
        csvEscape(fix.suggestedMetaDescription),
        csvEscape(fix.h1Fix),
        csvEscape(fix.headingFixes),
        csvEscape(fix.matchedSchemaBlocks.join("; ")),
        csvEscape(implSummary),
      ].join(",");
    });
    const csv = [headers.map(h => `"${h}"`).join(","), ...rows].join("\n");
    zip.file("fixes-summary.csv", csv);
  }

  // Failed URLs CSV (blocked / unreachable pages)
  if (site.failedUrls && site.failedUrls.length > 0) {
    const csv = ["URL", ...site.failedUrls].join("\n");
    zip.file("failed_urls.csv", csv);
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return buffer as Buffer;
}

/**
 * Convert a URL to a safe filename.
 * e.g., "https://example.com/blog/my-post" → "blog_my-post"
 */
function urlToFilename(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\//, "").replace(/\/$/, "") || "index";
    return path
      .replace(/\//g, "_")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 100);
  } catch {
    return "page-" + Buffer.from(url).toString("base64url").slice(0, 20);
  }
}
