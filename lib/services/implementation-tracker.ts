/**
 * ES-045: Implementation Tracker
 *
 * Pure deterministic function — no LLM calls, no external dependencies.
 * Compares previous suggested fixes to current crawl data to detect
 * which fixes have been implemented by the site owner.
 * Target: <100ms for 500 pages.
 */

import type { PerPageFix } from "./page-fix-generator";
import type { CrawlData } from "./geo-crawler";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ImplementationStatus {
  url: string;
  fixes: Array<{
    fixType: "title" | "meta_description" | "h1" | "heading" | "schema" | "pillar";
    suggested: string;
    implemented: boolean;
    currentValue: string | null;
  }>;
  implementedCount: number;
  totalFixes: number;
}

// ── Levenshtein distance (inline DP, ~15 lines) ───────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

function isSimilar(suggested: string, current: string): boolean {
  const a = suggested.toLowerCase().trim();
  const b = current.toLowerCase().trim();
  return levenshtein(a, b) < 3;
}

// ── Main export ────────────────────────────────────────────────────────────

export function computeImplementationTracking(
  previousFixes: PerPageFix[],
  crawlData: CrawlData
): ImplementationStatus[] {
  // Build URL → page map for O(1) lookup
  const pageMap = new Map<string, CrawlData["pages"][number]>();
  for (const page of crawlData.pages) {
    pageMap.set(page.url, page);
  }

  const results: ImplementationStatus[] = [];

  for (const fix of previousFixes) {
    const page = pageMap.get(fix.url);
    if (!page) continue; // Page removed or URL changed — skip

    const fixes: ImplementationStatus["fixes"] = [];

    // Title fix
    if (fix.suggestedTitle != null) {
      const currentTitle = page.title ?? "";
      const implemented = isSimilar(fix.suggestedTitle, currentTitle);
      fixes.push({
        fixType: "title",
        suggested: fix.suggestedTitle,
        implemented,
        currentValue: currentTitle,
      });
    }

    // H1 fix
    if (fix.h1Fix != null) {
      const currentH1 = page.headings?.[0]?.text ?? "";
      const implemented = isSimilar(fix.h1Fix, currentH1);
      fixes.push({
        fixType: "h1",
        suggested: fix.h1Fix,
        implemented,
        currentValue: currentH1 || null,
      });
    }

    // Schema fixes — check if recommended @type now appears in existingSchema (string[])
    for (const schemaType of fix.matchedSchemaBlocks) {
      const existing = page.existingSchema ?? [];
      const implemented = existing.some(
        (s) => s.toLowerCase() === schemaType.toLowerCase()
      );
      fixes.push({
        fixType: "schema",
        suggested: schemaType,
        implemented,
        currentValue: existing.join(", ") || null,
      });
    }

    // Pillar fixes — always unimplemented (not auto-detectable)
    for (const pillarFix of fix.pillarFixes) {
      fixes.push({
        fixType: "pillar",
        suggested: pillarFix.fix,
        implemented: false,
        currentValue: null,
      });
    }

    if (fixes.length === 0) continue;

    const implementedCount = fixes.filter((f) => f.implemented).length;
    results.push({
      url: fix.url,
      fixes,
      implementedCount,
      totalFixes: fixes.length,
    });
  }

  return results;
}
