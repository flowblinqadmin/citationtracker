import type { IntelligenceResult } from "./intelligence-gatherer";
import type { TechnicalResult } from "./technical-checker";
import type { SovResult } from "./sov-checker";
import type { SemanticResult } from "./semantic-checker";
import { getPlatformCopy } from "./platform-detector";
import { getBenchmark } from "@/lib/benchmarks";
import {
  calculateRevenueOpportunity,
  type RevenueOpportunity,
} from "@/lib/revenue-calculator";

export interface Issue {
  title: string;
  severity: "critical" | "warning" | "info";
  description: string;
  is_quick_win: boolean;
  estimated_effort: string;
}

export interface QuickWin {
  title: string;
  current_score_impact: number;
}

export interface NarrativeItem {
  type: "critical" | "warning" | "info";
  text: string;
}

export interface CompiledReport {
  overall_score: number;
  verdict: string;
  narrative: NarrativeItem[];
  intelligence: IntelligenceResult | null;
  technical: {
    checks: TechnicalResult["checks"];
    summary: TechnicalResult["summary"];
    platformDetected: string | null;
    platformCopy: string;
    paymentStack: string[];
  } | null;
  sov: SovResult["summary"] & { results: SovResult["results"] } | null;
  semantic: SemanticResult | null;
  revenue_opportunity: RevenueOpportunity;
  benchmark: {
    industry_average: number;
    top_performer: number;
    category: string;
    comparison: string;
  };
  issues: Issue[];
  quick_wins: QuickWin[];
  projected_score_after_fixes: number;
}

function generateNarrative(
  sov: SovResult | null,
  intelligence: IntelligenceResult | null
): NarrativeItem[] {
  const items: NarrativeItem[] = [];

  // Intelligence context
  if (intelligence) {
    const { brandName, vertical, coreCategorySummary, primaryMarkets } = intelligence.merchant;
    const queryCount = intelligence.queries.length;
    const competitorCount = intelligence.competitors.length;
    const marketText = primaryMarkets?.length
      ? ` serving customers in ${primaryMarkets.slice(0, 2).join(" and ")}`
      : "";
    items.push({
      type: "info",
      text: `We analyzed ${brandName} as a ${vertical} store${marketText}. ${coreCategorySummary} We generated ${queryCount} purchase queries that real customers in ${primaryMarkets?.[0] || "your market"} would ask AI assistants, and identified ${competitorCount} competitor${competitorCount !== 1 ? "s" : ""} in your space.`,
    });
  }

  // SoV — the core finding
  if (sov) {
    const { brandSov, topCompetitorName, topCompetitorSov, queriesRun, platformsQueried } = sov.summary;
    const platformList = platformsQueried.join(", ");

    if (brandSov === 0) {
      items.push({
        type: "critical",
        text: `We asked ${queriesRun} real purchase queries across ${platformList} — the same questions your customers are asking AI shopping assistants. Your brand wasn't mentioned a single time. ${topCompetitorName ? `Meanwhile, ${topCompetitorName} appeared in ${topCompetitorSov}% of responses.` : "Your competitors are getting all the visibility."}`,
      });
      items.push({
        type: "critical",
        text: `This means when customers ask ChatGPT, Claude, or Gemini for products you sell, they'll never hear about your store. They'll be directed to competitors instead.`,
      });
    } else if (brandSov < 20) {
      items.push({
        type: "warning",
        text: `Across ${queriesRun} purchase queries on ${platformList}, your brand appeared in only ${brandSov}% of AI responses. ${topCompetitorName ? `${topCompetitorName} leads with ${topCompetitorSov}%.` : ""} Most potential customers asking AI for product recommendations won't see your brand.`,
      });
    } else if (brandSov < 50) {
      items.push({
        type: "warning",
        text: `Your brand appeared in ${brandSov}% of AI responses across ${queriesRun} queries on ${platformList}. ${topCompetitorName ? `Your top competitor ${topCompetitorName} is at ${topCompetitorSov}%.` : ""} There's room to improve your visibility.`,
      });
    } else {
      items.push({
        type: "info",
        text: `Good news — your brand appeared in ${brandSov}% of AI responses across ${queriesRun} queries on ${platformList}. ${topCompetitorName ? `Your top competitor ${topCompetitorName} is at ${topCompetitorSov}%.` : ""} You have solid AI visibility.`,
      });
    }

    // Per-platform breakdown insight
    if (sov.results.length > 0) {
      const platformMentions: Record<string, { total: number; mentioned: number }> = {};
      for (const result of sov.results) {
        for (const platform of result.platforms) {
          if (!platformMentions[platform.platform]) {
            platformMentions[platform.platform] = { total: 0, mentioned: 0 };
          }
          platformMentions[platform.platform].total++;
          if (platform.targetBrandMentioned) {
            platformMentions[platform.platform].mentioned++;
          }
        }
      }

      const strongPlatforms: string[] = [];
      const weakPlatforms: string[] = [];
      for (const [name, data] of Object.entries(platformMentions)) {
        const pct = Math.round((data.mentioned / data.total) * 100);
        if (pct > 30) strongPlatforms.push(`${name} (${pct}%)`);
        else weakPlatforms.push(`${name} (${pct}%)`);
      }

      if (strongPlatforms.length > 0 && weakPlatforms.length > 0) {
        items.push({
          type: "info",
          text: `You're strongest on ${strongPlatforms.join(", ")} but nearly invisible on ${weakPlatforms.join(", ")}. Different AI platforms have different data sources — targeted optimization can close these gaps.`,
        });
      } else if (weakPlatforms.length > 0 && strongPlatforms.length === 0) {
        items.push({
          type: "warning",
          text: `You have weak visibility across all platforms: ${weakPlatforms.join(", ")}. AI shopping agents don't have enough data about your products to recommend them.`,
        });
      }
    }
  }

  return items;
}

function getVerdict(score: number): string {
  if (score <= 20) return "AI agents can't find your products.";
  if (score <= 40)
    return "You're barely visible to AI shopping agents.";
  if (score <= 60)
    return "Partially visible, but you're losing sales to competitors who are fully indexed.";
  if (score <= 80)
    return "Good visibility, but there are gaps costing you revenue.";
  return "Excellent. Your products are well-positioned for AI commerce.";
}

export function compileReport(
  intelligence: IntelligenceResult | null,
  technical: TechnicalResult | null,
  sov: SovResult | null,
  semantic: SemanticResult | null,
  revenueEstimate?: string | null,
  productCategory?: string | null
): CompiledReport {
  // Compute overall score — SoV 75%, Intelligence 25%
  let totalWeight = 0;
  let weightedSum = 0;

  if (sov) {
    weightedSum += sov.summary.brandSov * 75;
    totalWeight += 75;
  }
  if (intelligence) {
    // Intelligence doesn't have a direct score — reward having it
    weightedSum += 75 * 25;
    totalWeight += 25;
  }

  const overallScore =
    totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

  // Category detection
  const detectedCategory =
    productCategory ||
    intelligence?.merchant.vertical ||
    null;
  const benchmark = getBenchmark(detectedCategory);
  const comparison =
    overallScore >= benchmark.industry_average
      ? `You're above the ${benchmark.category} industry average of ${benchmark.industry_average}%.`
      : `You're below the ${benchmark.category} industry average of ${benchmark.industry_average}%. Top performers are at ${benchmark.top_performer}%.`;

  // Issues — SoV focused
  const issues: Issue[] = [];

  if (sov && sov.summary.brandSov < 20) {
    issues.push({
      title: "Low AI Share of Voice",
      severity: "critical",
      description: `Your brand was only mentioned in ${sov.summary.brandSov}% of AI purchase queries. ${sov.summary.topCompetitorName ? `${sov.summary.topCompetitorName} leads at ${sov.summary.topCompetitorSov}%.` : ""}`,
      is_quick_win: false,
      estimated_effort: "Requires FlowBlinq",
    });
  }

  if (sov && sov.summary.brandSov === 0) {
    issues.push({
      title: "Zero AI Visibility",
      severity: "critical",
      description: `Your brand was not mentioned in any AI shopping response. When customers ask AI assistants for products you sell, they're being directed exclusively to your competitors.`,
      is_quick_win: false,
      estimated_effort: "Requires FlowBlinq",
    });
  }

  // Quick wins — none without technical analysis
  const quickWins: QuickWin[] = [];
  const projectedScore = overallScore;

  // Revenue opportunity
  const revenueOpportunity = calculateRevenueOpportunity(
    overallScore,
    revenueEstimate,
    detectedCategory
  );

  // Narrative explanation — SoV focused
  const narrative = generateNarrative(sov, intelligence);

  return {
    overall_score: overallScore,
    verdict: getVerdict(overallScore),
    narrative,
    intelligence,
    technical: technical
      ? {
          checks: technical.checks,
          summary: technical.summary,
          platformDetected: technical.raw.platformDetected,
          platformCopy: getPlatformCopy(technical.raw.platformDetected),
          paymentStack: technical.raw.paymentStack,
        }
      : null,
    sov: sov
      ? {
          ...sov.summary,
          results: sov.results,
        }
      : null,
    semantic,
    revenue_opportunity: revenueOpportunity,
    benchmark: {
      industry_average: benchmark.industry_average,
      top_performer: benchmark.top_performer,
      category: benchmark.category,
      comparison,
    },
    issues,
    quick_wins: quickWins,
    projected_score_after_fixes: projectedScore,
  };
}
