/**
 * ES-055: C8 — Content Strategy Scoring
 * Pure regex-based detection — no LLM, no side effects.
 */

import type { CrawledPage } from "@/lib/services/geo-crawler";
import type {
  QuotationScore,
  StatisticsScore,
  CitationSourceScore,
  PageStrategyScores,
  ContentStrategyReport,
} from "@/lib/types/content-strategy";

// ── C8: Quotation Scoring ─────────────────────────────────────────

/**
 * Score a single page for quotation blocks.
 * Detection: <blockquote>, "> " markdown, "..." — Name, According to Name, Name says/noted/stated/explained.
 */
export function scoreQuotations(content: string): QuotationScore {
  let count = 0;
  let hasAttribution = false;

  // 1. <blockquote> HTML tags
  const blockquoteTags = content.match(/<blockquote[\s\S]*?<\/blockquote>/gi) ?? [];
  count += blockquoteTags.length;

  // 2. Markdown blockquotes (> prefix lines)
  const markdownQuotes = content.match(/^>\s+.+/gm) ?? [];
  count += markdownQuotes.length;

  // 3. Attributed quotes: "..." — Name (FIX-6: includes smart/curly quotes)
  const attributedQuotes = content.match(/["\u201C][^"\u201D]{15,}["\u201D][\s]*[—–-]\s*[A-Z]/g) ?? [];
  if (attributedQuotes.length > 0) {
    count += attributedQuotes.length;
    hasAttribution = true;
  }

  // 4. Attribution phrases: According to / says / noted / stated / explained + capitalized name
  const attributionPhrases = content.match(/\b(According to|says|noted|stated|explained)\s+[A-Z][a-z]+/g) ?? [];
  if (attributionPhrases.length > 0) {
    count += attributionPhrases.length;
    hasAttribution = true;
  }

  // 4b. "Name says" pattern: title + name OR first + last name followed by attribution verb
  const nameBeforeVerb = content.match(
    /\b(?:Dr|Prof|Mr|Mrs|Ms)\.\s+[A-Z][a-z]+\s+(?:says|noted|stated|explained)\b|\b[A-Z][a-z]+\s+[A-Z][a-z]+\s+(?:says|noted|stated|explained)\b/g
  ) ?? [];
  if (nameBeforeVerb.length > 0) {
    count += nameBeforeVerb.length;
    hasAttribution = true;
  }

  // Score: 0 if none, 50 if found but no attribution, 100 if found with attribution
  const score = count === 0 ? 0 : hasAttribution ? 100 : 50;

  return { count, hasAttribution, score };
}

// ── C8: Statistics Scoring ────────────────────────────────────────

/**
 * Score a single page for statistics/data points.
 * Detection: N%, Nx/N×, $N, N million/billion/thousand, comparatives, tables/figures.
 */
export function scoreStatistics(content: string): StatisticsScore {
  let count = 0;

  // 1. Numeric patterns: %, x/×, $, million/billion/thousand
  const numericPatterns = [
    ...( content.match(/\d+(\.\d+)?(%|x|×)/g) ?? []),
    ...( content.match(/\$[\d,.]+/g) ?? []),
    ...( content.match(/\d+\s*(million|billion|thousand)/gi) ?? []),
  ];
  count += numericPatterns.length;

  // 2. Comparative phrases
  const comparatives = content.match(/(increased|decreased|grew|reduced|compared to|rose|fell)\s+by/gi) ?? [];
  count += comparatives.length;

  // 3. Data element tags (<table>, <figure>, <data>)
  const dataElements = content.match(/<(table|figure|data)[\s>]/gi) ?? [];
  count += dataElements.length;

  // 4. Source attribution near numbers
  const hasSourceAttribution = /\bSource[:\s]|Source:\s*[A-Z]/.test(content) ||
    /\([A-Z][a-z]+,?\s*\d{4}\)/.test(content);

  // Score: 0 if count=0, 50 if count>0 but no source, 100 if count>=3 with sources
  const score = count === 0 ? 0 : (count >= 3 && hasSourceAttribution) ? 100 : 50;

  return { count, hasSourceAttribution, score };
}

// ── C8: Citation Source Scoring ───────────────────────────────────

// Authoritative domain patterns
const AUTHORITATIVE_DOMAINS = /\.(gov|edu|org)\b|pubmed\.ncbi|scholar\.google|arxiv\.org/i;

/**
 * Score a single page for cited external sources.
 */
export function scoreCitedSources(content: string): CitationSourceScore {
  // 1. External links — markdown [text](url) and HTML <a href="url">text</a> (FIX-2)
  type LinkEntry = { anchor: string; url: string };
  const markdownLinks: LinkEntry[] = [...content.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)]
    .map(m => ({ anchor: m[1].trim(), url: m[2] }));

  const htmlLinks: LinkEntry[] = [...content.matchAll(/<a\s+[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([^<]+)<\/a>/gi)]
    .map(m => ({ anchor: m[2].trim(), url: m[1] }));

  // Deduplicate by URL, keep anchor from first occurrence
  const seenUrls = new Set<string>();
  const allLinks: LinkEntry[] = [];
  for (const link of [...markdownLinks, ...htmlLinks]) {
    if (!seenUrls.has(link.url)) {
      seenUrls.add(link.url);
      allLinks.push(link);
    }
  }

  const externalLinks = allLinks.filter(l => l.anchor.split(/\s+/).length > 2);
  const externalLinkCount = externalLinks.length;

  const authoritativeLinkCount = externalLinks.filter(l => AUTHORITATIVE_DOMAINS.test(l.url)).length;

  // 2. Inline citations: "according to [Source" (bracket required), "(Author, Year)", "[N]"
  const inlineCitations = [
    ...( content.match(/according to\s+\[/gi) ?? []),
    ...( content.match(/\([A-Z][a-z]+,?\s*\d{4}\)/g) ?? []),
    ...( content.match(/\[\d+\]/g) ?? []),
  ];
  const inlineCitationCount = inlineCitations.length;

  // Score: 0 if no links and no citations, 50 if links but no authoritative, 100 if auth>0 and inline>0
  const score = (externalLinkCount === 0 && inlineCitationCount === 0)
    ? 0
    : (authoritativeLinkCount > 0 && inlineCitationCount > 0)
      ? 100
      : 50;

  return { externalLinkCount, authoritativeLinkCount, inlineCitationCount, score };
}

// ── C8: Per-Page + Aggregate ──────────────────────────────────────

/**
 * Score all three strategies for a single page.
 * Composite: quotations 41%, statistics 33%, citations 26%.
 */
export function scorePageStrategies(page: CrawledPage): PageStrategyScores {
  const content = page.content ?? "";
  const quotations = scoreQuotations(content);
  const statistics = scoreStatistics(content);
  const citations = scoreCitedSources(content);

  const compositeScore = Math.round(
    quotations.score * 0.41 +
    statistics.score * 0.33 +
    citations.score * 0.26
  );

  return {
    url: page.url,
    quotations,
    statistics,
    citations,
    compositeScore,
  };
}

/**
 * Aggregate per-page scores into a ContentStrategyReport.
 */
export function aggregateStrategyReport(pages: CrawledPage[]): ContentStrategyReport {
  if (pages.length === 0) {
    return {
      quotations: { avgPerPage: 0, pagesWithQuotes: 0, pagesTotal: 0, overallScore: 0 },
      statistics: { avgPerPage: 0, pagesWithStats: 0, pagesTotal: 0, overallScore: 0 },
      citations: { avgPerPage: 0, pagesWithCitations: 0, pagesTotal: 0, overallScore: 0 },
      computedAt: new Date().toISOString(),
    };
  }

  const perPage = pages.map(p => scorePageStrategies(p));
  const n = perPage.length;

  const quotationCounts = perPage.map(p => p.quotations.count);
  const statisticsCounts = perPage.map(p => p.statistics.count);
  const citationCounts = perPage.map(p => p.citations.externalLinkCount + p.citations.inlineCitationCount);

  return {
    quotations: {
      avgPerPage: Math.round((quotationCounts.reduce((a, b) => a + b, 0) / n) * 10) / 10,
      pagesWithQuotes: perPage.filter(p => p.quotations.count > 0).length,
      pagesTotal: n,
      overallScore: Math.round(perPage.reduce((a, p) => a + p.quotations.score, 0) / n),
    },
    statistics: {
      avgPerPage: Math.round((statisticsCounts.reduce((a, b) => a + b, 0) / n) * 10) / 10,
      pagesWithStats: perPage.filter(p => p.statistics.count > 0).length,
      pagesTotal: n,
      overallScore: Math.round(perPage.reduce((a, p) => a + p.statistics.score, 0) / n),
    },
    citations: {
      avgPerPage: Math.round((citationCounts.reduce((a, b) => a + b, 0) / n) * 10) / 10,
      pagesWithCitations: perPage.filter(p => p.citations.externalLinkCount > 0 || p.citations.inlineCitationCount > 0).length,
      pagesTotal: n,
      overallScore: Math.round(perPage.reduce((a, p) => a + p.citations.score, 0) / n),
    },
    computedAt: new Date().toISOString(),
  };
}
