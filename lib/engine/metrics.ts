// AI Citation Tracker — monthly metrics computation
//
// Pure function over one run's responses + citations. Computed at run
// completion (and recomputed when a partial match is confirmed/rejected in
// review) and stored on tracker.runs.metrics. Month-over-month trends are
// derived by the dashboard comparing run N against run N-1 — NOT here.
//
// Key semantics (PCG brief §4.5):
//   * Denominator for every "rate" is the number of PROMPTS in the run
//     (distinct prompt versions), never the number of responses.
//   * A "counting" citation is one that attributes to the client: an exact
//     article-URL match, OR a partial (outlet-homepage) match that a human has
//     CONFIRMED in review. Pending/rejected partials and unmatched URLs do not
//     count toward client metrics.
//   * Competitor citations are a separate bucket (any citation whose domain is a
//     named competitor) and drive Share of AI Voice + Competitor Citation Rate.

import type {
  TrackerPlatform,
  TrackerCompetitor,
  TrackerRunMetrics,
  TrackerPlatformMetrics,
  TrackerTopArticle,
  TrackerCompetitorMetric,
} from "@/lib/types/tracker";
import { extractRegistrableDomain } from "@/lib/engine/url-matcher";

const DEFAULT_PLATFORMS: TrackerPlatform[] = ["perplexity", "openai", "google"];

export interface MetricsResponseRow {
  promptVersionId: string;
  platform: TrackerPlatform;
  brandMentioned: boolean;
}

export interface MetricsCitationRow {
  promptVersionId: string | null;
  platform: TrackerPlatform | null;
  matchType: "exact" | "partial" | "unmatched";
  reviewStatus: "pending" | "confirmed" | "rejected" | null;
  articleId: string | null;
  competitorDomain: string | null;
}

export interface MetricsArticleRow {
  id: string;
  url: string;
  outlet: string | null;
  headline: string | null;
  publishedAt: Date | string | null;
}

export interface ComputeMetricsInput {
  /** Every prompt version submitted in this run — the rate denominator. */
  promptVersionIds: string[];
  responses: MetricsResponseRow[];
  citations: MetricsCitationRow[];
  articles: MetricsArticleRow[];
  competitors: TrackerCompetitor[];
  /** Run period 'YYYY-MM' — used for "articles published this month" metric. */
  period: string;
  /** Platforms to break down by (defaults to the three launch platforms). */
  platforms?: TrackerPlatform[];
}

/** A citation that attributes to the client (counts toward client metrics). */
function isCounting(c: MetricsCitationRow): boolean {
  return c.matchType === "exact" || (c.matchType === "partial" && c.reviewStatus === "confirmed");
}

/** Format a date-ish value to 'YYYY-MM', or null. */
function toYearMonth(d: Date | string | null): string | null {
  if (!d) return null;
  const date = typeof d === "string" ? new Date(d) : d;
  const t = date.getTime();
  if (Number.isNaN(t)) return null;
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export function computeRunMetrics(input: ComputeMetricsInput): TrackerRunMetrics {
  const platforms = input.platforms ?? DEFAULT_PLATFORMS;
  const promptsTotal = input.promptVersionIds.length;

  const articleById = new Map(input.articles.map((a) => [a.id, a]));
  const counting = input.citations.filter(isCounting);
  // Competitor citations: flagged with a competitor domain AND not counted as a
  // client citation. The `!isCounting` guard keeps the client and competitor
  // buckets mutually exclusive, so a single citation can never inflate both
  // sides of Share of AI Voice (defense-in-depth: matchCitation already drops
  // competitorDomain on client-outlet partial matches).
  const competitorCitations = input.citations.filter((c) => c.competitorDomain && !isCounting(c));

  // ── Citation Rate: prompts with ≥1 counting citation ÷ total prompts ────────
  const promptsWithCitation = new Set(
    counting.map((c) => c.promptVersionId).filter((p): p is string => !!p),
  );
  const citationRate = rate(promptsWithCitation.size, promptsTotal);

  // ── Brand Mention Rate: prompts where any response mentioned the brand ──────
  const promptsWithBrand = new Set(
    input.responses.filter((r) => r.brandMentioned).map((r) => r.promptVersionId),
  );
  const brandMentionRate = rate(promptsWithBrand.size, promptsTotal);

  // ── Totals ──────────────────────────────────────────────────────────────────
  const totalCitations = counting.length;
  const uniqueArticleIds = new Set(
    counting.map((c) => c.articleId).filter((a): a is string => !!a),
  );
  const uniqueArticlesCited = uniqueArticleIds.size;

  // ── Articles published THIS month that were cited (instances) ───────────────
  const newThisMonthCited = counting.filter((c) => {
    if (!c.articleId) return false;
    const art = articleById.get(c.articleId);
    return art ? toYearMonth(art.publishedAt) === input.period : false;
  }).length;

  // ── Top 5 cited articles ─────────────────────────────────────────────────────
  const perArticleCount = new Map<string, number>();
  for (const c of counting) {
    if (!c.articleId) continue;
    perArticleCount.set(c.articleId, (perArticleCount.get(c.articleId) ?? 0) + 1);
  }
  const topCitedArticles: TrackerTopArticle[] = [...perArticleCount.entries()]
    // Count desc, then articleId asc as a STABLE tie-break so the Top-5 is
    // deterministic across recomputes regardless of citation-row order.
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 5)
    .map(([articleId, count]) => {
      const art = articleById.get(articleId);
      return {
        articleId,
        url: art?.url ?? "",
        outlet: art?.outlet ?? null,
        headline: art?.headline ?? null,
        publishedAt: art ? toYearMonthIso(art.publishedAt) : null,
        count,
      };
    });

  // ── Platform breakdown ───────────────────────────────────────────────────────
  const platformBreakdown: TrackerPlatformMetrics[] = platforms.map((platform) => {
    const platCounting = counting.filter((c) => c.platform === platform);
    const platPrompts = new Set(
      platCounting.map((c) => c.promptVersionId).filter((p): p is string => !!p),
    );
    const platBrandPrompts = new Set(
      input.responses.filter((r) => r.platform === platform && r.brandMentioned).map((r) => r.promptVersionId),
    );
    return {
      platform,
      citationRate: rate(platPrompts.size, promptsTotal),
      totalCitations: platCounting.length,
      brandMentionRate: rate(platBrandPrompts.size, promptsTotal),
    };
  });

  // ── Share of AI Voice: client ÷ (client + competitor) citations ─────────────
  // Return null when there is no contest (both counts 0) so consumers can
  // render "—" instead of a fabricated 0%.  A numeric 0 is still valid when
  // competitor citations exist but the client has none.
  const clientCount = totalCitations;
  const competitorCount = competitorCitations.length;
  const shareOfAiVoice: number | null =
    clientCount + competitorCount === 0
      ? null
      : rate(clientCount, clientCount + competitorCount);

  // ── Per-competitor citation rate ─────────────────────────────────────────────
  const competitorMetrics: TrackerCompetitorMetric[] = input.competitors.map((comp) => {
    const compDomain = extractRegistrableDomain(comp.domain);
    const compCitations = competitorCitations.filter((c) => c.competitorDomain === compDomain);
    const compPrompts = new Set(
      compCitations.map((c) => c.promptVersionId).filter((p): p is string => !!p),
    );
    return {
      name: comp.name,
      domain: comp.domain,
      citationRate: rate(compPrompts.size, promptsTotal),
      totalCitations: compCitations.length,
    };
  });

  return {
    promptsTotal,
    citationRate,
    brandMentionRate,
    totalCitations,
    uniqueArticlesCited,
    newThisMonthCited,
    shareOfAiVoice,
    topCitedArticles,
    platformBreakdown,
    competitorMetrics,
  };
}

/** Top-article publishedAt is surfaced as an ISO date (or null) for the report. */
function toYearMonthIso(d: Date | string | null): string | null {
  if (!d) return null;
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
