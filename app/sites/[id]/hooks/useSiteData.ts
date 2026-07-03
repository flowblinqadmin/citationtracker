/**
 * useSiteData — all derived computations from (site, lastCitationCheck)
 *
 * Extracted from SitePageClient.tsx lines 491–632 (PR-A, ES-087).
 * Zero behavior change from the inline version.
 *
 * NOTE: filteredPillars, filteredPages, pagedRows are NOT here — they depend
 * on tab-local state (tierFilter, pageFilter, pageSearch, pageCursor) and
 * must be re-derived inside their respective tab components.
 */

import { useMemo } from "react";
import type {
  SiteData,
  GeoScorecard,
  GeoScore,
  RankedRec,
  ChangeLogEntry,
} from "../types";
import type { CitationCheckScore } from "@/lib/db/schema";
import { scoreTier } from "../design-tokens";

// ── Pipeline stages (must match SitePageClient shell) ────────────────────────

const ALL_STAGES = [
  { status: "discovery", label: "Discovering pages" },
  { status: "crawling", label: "Reading your content" },
  { status: "extracting", label: "Extracting structure" },
  { status: "researching", label: "Checking the landscape" },
  { status: "analyzing", label: "Running your AI audit" },
  { status: "generating", label: "Building your profile" },
  { status: "assembling", label: "Final checks" },
];

// ── Exported types ───────────────────────────────────────────────────────────

export interface PageVuln {
  pillar: string;
  pillarName: string;
  severity: "critical" | "high" | "medium" | "low";
  finding: string;
  recommendation: string;
}

export interface PageRow {
  url: string;
  title?: string;
  pageType?: string;
  overallPageHealth?: string;
  vulnerabilities?: PageVuln[];
}

export interface ProviderAggregate {
  name: string;
  mentionCount: number;
  totalQueries: number;
  visibilityScore: number;
}

export interface ProviderResultWithSamples {
  provider: string;
  visibilityScore: number;
  mentionCount: number;
  totalQueries: number;
  samples?: Array<{ question: string; answer: string; mentioned: boolean }>;
}

export interface CompetitorEntry {
  name: string;
  domain?: string;
  shareOfVoice: number;
}

export interface SiteDerivedData {
  // Core
  scorecard: GeoScorecard | null;
  pillars: GeoScore[];
  liveScore: number | null;
  pageCount: number;
  criticalCount: number;
  projectedScore: number | null;

  // Scorecard
  tierCounts: Record<"Poor" | "Weak" | "Fair" | "Good", number>;

  // Recommendations (sorted)
  recs: RankedRec[];

  // Pages (sorted, unfiltered — tabs re-derive filtered/paged slices)
  allPages: PageRow[];
  sortedPages: PageRow[];

  // Citations
  providerResults: ProviderResultWithSamples[];
  providerAggregates: ProviderAggregate[];
  competitorData: CompetitorEntry[];
  visibleCompetitors: CompetitorEntry[];
  hiddenCompetitorCount: number;
  totalMentions: number;
  totalQueryCount: number;
  citationRate: number | null;
  ourSOV: number | null;
  topCompetitor: CompetitorEntry | null;
  hasSovSamples: boolean;

  // Breakdowns
  pillarVisibility: Record<string, number>;
  geoVisibility: Array<{ geoId: string; geoName: string; visibility: number }>;
  categoryVisibility: Array<{
    categoryId: string;
    categoryName: string;
    visibility: number;
  }>;
  tierVisibility: Array<{
    tier: string;
    mentionCount: number;
    promptCount: number;
    visibility: number;
  }>;

  // History
  changeLog: ChangeLogEntry[];

  // Pipeline
  currentStageIndex: number;

  // Display helpers
  pillarDisplayName: (id: string) => string;
}

// ── Short names for long pillar IDs ──────────────────────────────────────────

const SHORT_NAMES: Record<string, string> = {
  evidence_statistics: "Evidence",
  entity_definitions: "Entities",
  competitive_positioning: "Positioning",
};

// ── Sort orders for recommendation priority ──────────────────────────────────

const SORT_ORDER: Record<string, number> = {
  critical: 0,
  HIGH: 0,
  high: 1,
  MED: 2,
  med: 2,
  medium: 2,
  LOW: 3,
  low: 3,
};

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useSiteData(
  site: SiteData | null,
  lastCitationCheck: CitationCheckScore | null,
): SiteDerivedData {
  return useMemo(() => {
    // ── Scorecard ──
    const scorecard = (site?.geoScorecard as GeoScorecard | null) ?? null;
    const pillars = scorecard?.pillars ?? [];
    const liveScore = scorecard?.overallScore ?? null;
    const pageCount =
      (site as unknown as { pageCount?: number })?.pageCount ??
      (site?.crawlData as { pages?: unknown[] } | null)?.pages?.length ??
      0;
    const criticalCount = pillars.filter(
      (p) => (p.score ?? 100) < 25 || p.priority === "critical",
    ).length;

    // Pipeline stage — alias "extracting" to "crawling" (see SitePageClient comment)
    const stageLookupStatus =
      site?.pipelineStatus === "extracting"
        ? "crawling"
        : site?.pipelineStatus;
    const currentStageIndex = ALL_STAGES.findIndex(
      (s) => s.status === stageLookupStatus,
    );

    // ── Tier counts ──
    const tierCounts = { Poor: 0, Weak: 0, Fair: 0, Good: 0 };
    for (const p of pillars) {
      const t = scoreTier(p.score ?? 0);
      tierCounts[t]++;
    }

    // ── Recommendations sorted by priority ──
    const recs = [...(site?.rankedRecommendations ?? [])].map((r) => ({
      ...r,
      priority:
        (r as RankedRec).priority ??
        (r as { impact?: string }).impact ??
        "LOW",
    })) as RankedRec[];
    recs.sort(
      (a, b) => (SORT_ORDER[a.priority] ?? 4) - (SORT_ORDER[b.priority] ?? 4),
    );

    // ── Pages (sorted worst-first) ──
    const allPages = ((site?.perPageResults ?? []) as PageRow[]);
    const healthOrder = (h?: string) =>
      h === "poor" ? 0 : h === "needs-work" ? 1 : 2;
    const critScore = (p: PageRow) =>
      (p.vulnerabilities ?? []).filter(
        (v) => v.severity === "critical" || v.severity === "high",
      ).length;
    const sortedPages = [...allPages].sort((a, b) => {
      const hd =
        healthOrder(a.overallPageHealth) - healthOrder(b.overallPageHealth);
      return hd !== 0 ? hd : critScore(b) - critScore(a);
    });

    const projectedScore = site?.projectedScore ?? null;

    // ── Citation data ──
    const lc = lastCitationCheck;
    type _PR = {
      provider: string;
      visibilityScore: number;
      mentionCount: number;
      totalQueries: number;
    };
    const providerResults = ((lc?.providerResults ?? []) as ProviderResultWithSamples[]);
    const competitorData = ((lc?.competitorData ?? []) as CompetitorEntry[]);
    const visibleCompetitors = competitorData;
    const hiddenCompetitorCount: number = 0;

    // Samples availability
    const hasSovSamples = providerResults.some(
      (p) => (p.samples?.length ?? 0) > 0,
    );

    const pillarVisibility = ((lc?.pillarVisibility ?? {}) as Record<string, number>);
    const geoVisibility = ((lc?.geoVisibility ?? []) as SiteDerivedData["geoVisibility"]);
    const categoryVisibility = ((lc?.categoryVisibility ?? []) as SiteDerivedData["categoryVisibility"]);
    const tierVisibility = ((lc?.tierVisibility ?? []) as SiteDerivedData["tierVisibility"]);
    const changeLog = ((site?.changeLog ?? []) as ChangeLogEntry[]);

    // ── Provider aggregation ──
    const providerAggMap = new Map<
      string,
      { mentionCount: number; totalQueries: number; visibilityScore: number }
    >();
    for (const p of (providerResults as _PR[])) {
      const key = p.provider.toLowerCase().includes("perplexity")
        ? "Perplexity"
        : p.provider.toLowerCase().includes("openai") ||
            p.provider.toLowerCase().includes("gpt")
          ? "OpenAI"
          : p.provider.toLowerCase().includes("anthropic") ||
              p.provider.toLowerCase().includes("claude")
            ? "Anthropic"
            : p.provider.charAt(0).toUpperCase() + p.provider.slice(1);
      const existing = providerAggMap.get(key);
      if (!existing) {
        providerAggMap.set(key, {
          mentionCount: p.mentionCount,
          totalQueries: p.totalQueries,
          visibilityScore: p.visibilityScore,
        });
      } else {
        existing.mentionCount += p.mentionCount;
        existing.totalQueries += p.totalQueries;
        existing.visibilityScore = Math.round(
          (existing.visibilityScore + p.visibilityScore) / 2,
        );
      }
    }
    const providerAggregates = Array.from(providerAggMap.entries()).map(
      ([name, v]) => ({ name, ...v }),
    );

    const totalMentions = (providerResults as _PR[]).reduce(
      (s, p) => s + p.mentionCount,
      0,
    );
    const totalQueryCount = (providerResults as _PR[]).reduce(
      (s, p) => s + p.totalQueries,
      0,
    );
    const citationRate =
      totalQueryCount > 0
        ? Math.round((totalMentions / totalQueryCount) * 100)
        : null;

    const ourSOV = (lc?.overallVisibility as number | undefined) ?? null;
    const topCompetitor =
      competitorData.length > 0
        ? [...competitorData].sort(
            (a, b) => b.shareOfVoice - a.shareOfVoice,
          )[0]
        : null;

    // ── Pillar display names ──
    const pillarNameMap = new Map<string, string>();
    for (const p of pillars) {
      pillarNameMap.set(p.pillar, p.pillarName);
    }
    function pillarDisplayName(id: string): string {
      if (SHORT_NAMES[id]) return SHORT_NAMES[id];
      const full = pillarNameMap.get(id);
      if (full) return full;
      return id
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    return {
      scorecard,
      pillars,
      liveScore,
      pageCount,
      criticalCount,
      projectedScore,
      tierCounts,
      recs,
      allPages,
      sortedPages,
      providerResults,
      providerAggregates,
      competitorData,
      visibleCompetitors,
      hiddenCompetitorCount,
      totalMentions,
      totalQueryCount,
      citationRate,
      ourSOV,
      topCompetitor,
      hasSovSamples,
      pillarVisibility,
      geoVisibility,
      categoryVisibility,
      tierVisibility,
      changeLog,
      currentStageIndex,
      pillarDisplayName,
    };
  }, [site, lastCitationCheck]);
}
