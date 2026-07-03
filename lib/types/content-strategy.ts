/**
 * ES-055: Tier 3 — Content Intelligence Types
 */

// ── Per-Page Strategy Scores ──────────────────────────────────────

export type QuotationScore = {
  count: number;           // quotation instances found
  hasAttribution: boolean; // at least one quote has a named source
  score: number;           // 0-100
};

export type StatisticsScore = {
  count: number;           // data points found
  hasSourceAttribution: boolean;
  score: number;           // 0-100
};

export type CitationSourceScore = {
  externalLinkCount: number;
  authoritativeLinkCount: number; // .gov, .edu, .org, pubmed, scholar.google, arxiv
  inlineCitationCount: number;
  score: number;                   // 0-100
};

export type PageStrategyScores = {
  url: string;
  quotations: QuotationScore;
  statistics: StatisticsScore;
  citations: CitationSourceScore;
  compositeScore: number;          // weighted average: quotations 41%, statistics 33%, citations 26%
};

// ── Aggregate Report ─────────────────────────────────────────────

export type ContentStrategyReport = {
  quotations: {
    avgPerPage: number;
    pagesWithQuotes: number;
    pagesTotal: number;
    overallScore: number;
  };
  statistics: {
    avgPerPage: number;
    pagesWithStats: number;
    pagesTotal: number;
    overallScore: number;
  };
  citations: {
    avgPerPage: number;
    pagesWithCitations: number;
    pagesTotal: number;
    overallScore: number;
  };
  computedAt: string;       // ISO-8601
};

// ── Content Zones ─────────────────────────────────────────────────

export type ContentZone =
  | "direct_answer"
  | "comparison_table"
  | "data_evidence"
  | "expert_quote"
  | "faq_section"
  | "quotable_block";

export type PageZoneAudit = {
  url: string;
  hasDirectAnswer: boolean;
  hasComparisonTable: boolean;
  hasDataEvidence: boolean;
  hasExpertQuote: boolean;
  hasFaqSection: boolean;
  hasQuotableBlock: boolean;
  missingZones: ContentZone[];
};

export type ZoneSuggestion = {
  zone: ContentZone;
  exists: boolean;
  suggestion: string;        // draft content (paid) or guidance (free)
  evidence: string;          // research backing
  insertAfter: string;       // suggested location
};

// ── Engine Preferences ────────────────────────────────────────────

export type EngineRule = {
  rule: string;
  confidence: "high" | "medium" | "low";
  evidence: string;
};

export type EnginePreference = {
  provider: string;
  rules: EngineRule[];
  analyzedAt: string;
  checkCount: number;
};
