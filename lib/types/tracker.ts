// Mirror of geo's lib/types/tracker.ts (deployed ref origin/main) — the shapes
// stored in the shared tracker tables. Keep in lockstep with geo.

/** Platforms queried each run by geo's worker (team-org runs include Claude). */
export type TrackerPlatform = "perplexity" | "openai" | "google" | "anthropic";

export type TrackerPromptCategory =
  | "brand"
  | "category"
  | "competitor"
  | "topic"
  | "claim";

/** How an extracted cited URL relates to the client's article list. */
export type TrackerMatchType = "exact" | "partial" | "unmatched";

/** Review state for partial matches. */
export type TrackerReviewStatus = "pending" | "confirmed" | "rejected";

export type TrackerClientStatus = "active" | "paused";

/** How often geo's cron auto-runs a client's prompt library. */
export type TrackerRunFrequency = "manual" | "weekly" | "monthly";
export type TrackerRunStatus = "pending" | "running" | "complete" | "failed";
export type TrackerRunKind = "scheduled" | "manual";

/**
 * Optional subset a run executes (single-prompt / single-platform runs).
 * NULL/absent = the full worklist. Geo's runner ignores empty arrays — a
 * scope can narrow, never empty, a run.
 */
export interface TrackerRunScope {
  promptVersionIds?: string[];
  platforms?: TrackerPlatform[];
}

/** How a response portrays the brand (null = not classified). */
export type TrackerSentiment = "positive" | "neutral" | "negative";

/** A named competitor tracked for Share-of-AI-Voice. */
export interface TrackerCompetitor {
  name: string;
  domain: string;
}

/** Brand-mention keyword set (geo lib/services/brand-detector shape). */
export interface BrandKeywords {
  keywords: string[]; // sorted longest-first
  isAmbiguous: boolean;
  source: "vendor" | "domain" | "manual";
}

export interface TrackerPlatformMetrics {
  platform: TrackerPlatform;
  citationRate: number;
  totalCitations: number;
  brandMentionRate: number;
}

export interface TrackerTopArticle {
  articleId: string;
  url: string;
  outlet: string | null;
  headline: string | null;
  publishedAt: string | null;
  count: number;
}

export interface TrackerCompetitorMetric {
  name: string;
  domain: string;
  citationRate: number;
  totalCitations: number;
}

/** Aggregated metrics the engine stores on tracker_runs.metrics. */
export interface TrackerRunMetrics {
  promptsTotal: number;
  citationRate: number;
  brandMentionRate: number;
  totalCitations: number;
  uniqueArticlesCited: number;
  newThisMonthCited: number;
  /** client ÷ (client + competitor) citations; null when no contest (R24). */
  shareOfAiVoice: number | null;
  topCitedArticles: TrackerTopArticle[];
  platformBreakdown: TrackerPlatformMetrics[];
  competitorMetrics: TrackerCompetitorMetric[];
}
