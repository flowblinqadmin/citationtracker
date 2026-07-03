import { NextResponse, after } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditReports } from "@/lib/db/schema";
import { crawlCatalog } from "@/lib/services/commerce/catalog-crawler";
import { detectCurrency } from "@/lib/services/commerce/currency-detector";
import {
  computeCommerceScore,
  buildGapSection,
} from "@/lib/services/commerce/commerce-scorer";
import { computeRevenueImpact, computeAgenticPulse } from "@/lib/services/commerce/commerce-revenue";
import {
  probeCompetitors,
  extractCompetitorsFromSov,
  buildCompetitorAlert,
} from "@/lib/services/commerce/competitor-prober";
import { generateL2Narrative } from "@/lib/services/commerce/l2-narrative-generator";
import type { IntelligenceResult } from "@/lib/services/commerce/intelligence-gatherer";
import type { SovResult } from "@/lib/services/commerce/sov-checker";
import type {
  CommerceReportData,
  RevenueImpact,
  AgenticPulseStat,
  SovGapData,
  SovGapQuery,
  L2Competitors,
} from "@/lib/types/commerce-report";
import { assertAuditAccess, consumeAuditCostBudget } from "@/lib/audit-entitlement";

function extractSovGap(sovData: SovResult | null, brandName: string): SovGapData | null {
  if (!sovData?.results || sovData.results.length === 0) return null;

  const queries: SovGapQuery[] = sovData.results.map((r) => {
    const platforms = r.platforms.map((p) => {
      const competitorMentions = p.mentions
        .filter((m) => m.mentioned && m.brand.toLowerCase() !== brandName.toLowerCase())
        .sort((a, b) => (a.position || 99) - (b.position || 99));

      return {
        platform: p.platform,
        mentioned: p.targetBrandMentioned,
        position: p.targetBrandPosition,
        topCompetitor: competitorMentions[0]?.brand || null,
        snippet: p.fullResponse.length > 300
          ? p.fullResponse.slice(0, 300)
          : p.fullResponse,
      };
    });

    return {
      query: r.query,
      platforms,
      brandMentioned: platforms.some((p) => p.mentioned),
    };
  });

  return {
    brandSov: sovData.summary?.brandSov ?? 0,
    topCompetitorName: sovData.summary?.topCompetitorName ?? "",
    topCompetitorSov: sovData.summary?.topCompetitorSov ?? 0,
    queries,
  };
}

function getMerchantMentionCount(sovData: SovResult | null, brandName: string): number {
  if (!sovData?.results) return 0;
  let count = 0;
  for (const result of sovData.results) {
    for (const platform of result.platforms) {
      if (platform.targetBrandMentioned) count++;
    }
  }
  return count;
}

// Background worker: runs the full L2 pipeline and saves results to DB
async function generateCommerceReport(id: string, report: {
  merchant_url: string;
  merchant_name: string;
  intelligence_data: unknown;
  sov_data: unknown;
  product_category: string | null;
  revenue_estimate: string | null;
  platform_detected: string | null;
}) {
  try {
    const intelligence = report.intelligence_data as IntelligenceResult | null;
    const sovData = report.sov_data as SovResult | null;
    const brandName = intelligence?.merchant?.brandName || report.merchant_name;
    const vertical = intelligence?.merchant?.vertical || report.product_category || "general";
    const platform = report.platform_detected || (intelligence?.merchant as Record<string, unknown>)?.platform as string || "unknown";
    const currency = detectCurrency(report.merchant_url);
    // Revenue: use DB value, then category fallback, then $15M default
    const CATEGORY_REVENUE_DEFAULTS: Record<string, number> = {
      automotive: 25_000_000, "auto parts": 25_000_000, powersports: 15_000_000,
      beauty: 15_000_000, health: 10_000_000, supplements: 10_000_000,
      marine: 12_000_000, fashion: 20_000_000, industrial: 30_000_000,
      electronics: 25_000_000, food: 20_000_000,
    };
    const parsedRevenue = parseFloat(report.revenue_estimate || "0") || 0;
    const categoryFallback = Object.entries(CATEGORY_REVENUE_DEFAULTS)
      .find(([k]) => vertical.toLowerCase().includes(k))?.[1] || 15_000_000;
    const revenueEstimate = parsedRevenue > 0 ? parsedRevenue : categoryFallback;
    const missedMonthly = Math.round(revenueEstimate * 0.01 / 12);

    // Step 1: Extract SoV gap data from L1 audit
    const sovGap = extractSovGap(sovData, brandName);
    const merchantMentionCount = getMerchantMentionCount(sovData, brandName);

    // Step 2: Extract competitor list from SoV data
    const competitorInputs = extractCompetitorsFromSov(sovData, brandName);
    console.warn(`[L2:${id}] Found ${competitorInputs.length} competitors from SoV data`);

    // Step 3: Run 3 parallel branches
    console.warn(`[L2:${id}] Running parallel: crawl + competitor probes`);
    const [crawlResult, competitorProbeResults] = await Promise.all([
      // Branch A: Crawl catalog (with URL filtering)
      crawlCatalog(report.merchant_url, brandName),
      // Branch C: Probe competitors
      probeCompetitors(competitorInputs),
    ]);

    if (!crawlResult.success) {
      await db.update(auditReports).set({
        commerce_data: { status: "error", error: crawlResult.error },
        updated_at: new Date(),
      }).where(eq(auditReports.id, id));
      return;
    }

    const catalog = crawlResult.data;
    console.warn(`[L2:${id}] Crawl complete: ${catalog.totalCrawled} products`);

    // Step 4: Compute scores deterministically
    console.warn(`[L2:${id}] Computing scores`);
    let score;
    try {
      score = computeCommerceScore(catalog, vertical);
    } catch (err) {
      console.error(`[L2:${id}] Score computation failed:`, err);
      score = {
        overall: Math.round((catalog.visible / Math.max(catalog.totalCrawled, 1)) * 100),
        subScores: [],
      };
    }

    // Step 5: Revenue + pulse + gap (deterministic, no LLM)
    let revenue: RevenueImpact;
    let pulse: AgenticPulseStat[];
    try {
      revenue = computeRevenueImpact(report.revenue_estimate, report.product_category, brandName, currency);
    } catch (err) {
      console.error(`[L2:${id}] Revenue computation failed:`, err);
      revenue = { methodology: "Unable to compute", scenarios: [], aovInsight: "" };
    }
    try {
      pulse = computeAgenticPulse(revenueEstimate, currency);
    } catch (err) {
      console.error(`[L2:${id}] Pulse computation failed:`, err);
      pulse = [];
    }

    let gap;
    try {
      gap = buildGapSection(vertical);
    } catch (err) {
      console.error(`[L2:${id}] Gap section failed:`, err);
      gap = { items: [], timeline: [] };
    }

    // Step 6: Build competitor section (deterministic alert)
    const { alertType, alertHtml } = buildCompetitorAlert(
      competitorProbeResults,
      brandName,
      platform,
      vertical,
      report.product_category || vertical,
    );

    const competitorsSection: L2Competitors = {
      alertType,
      alertHtml,
      competitors: competitorProbeResults.map((c) => ({
        name: c.name,
        domain: c.domain,
        platform: c.platform,
        acpStatus: c.acpStatus,
        hasProductFeed: c.hasProductFeed,
        hasAcpEndpoint: c.hasAcpEndpoint,
        l1MentionCount: c.l1MentionCount,
      })),
      merchant: {
        name: brandName,
        platform,
        acpStatus: "NONE",
      },
    };

    // Step 7: ONE comprehensive LLM call
    console.warn(`[L2:${id}] Making single LLM call (Claude Sonnet 4.5)`);
    let narrative;
    try {
      narrative = await generateL2Narrative({
        merchantName: brandName,
        merchantDomain: report.merchant_url,
        vertical,
        platform,
        revenueEstimate,
        missedMonthly,
        score,
        catalog,
        competitors: competitorProbeResults,
        merchantMentionCount,
        currency,
      });
    } catch (err) {
      console.error(`[L2:${id}] LLM call failed:`, (err as Error).message);
      // Use fallback narrative
      narrative = null;
    }

    // Step 8: Assemble and save
    const commerceData: CommerceReportData = {
      merchantCurrency: { code: currency.code, symbol: currency.symbol, rate: currency.rate },
      hero: {
        brandName,
        vertical,
        subtitle: narrative?.subtitle?.text || `How AI shopping agents see your catalog today — and what you're leaving on the table.`,
        scenario: narrative?.subtitle?.scenario || "no_competitors",
      },
      score,
      verdict: {
        html: narrative?.verdict?.html || `${brandName} has ${catalog.visible} AI-visible products out of ${catalog.totalCrawled} crawled. Commerce readiness score: <strong>${score.overall}/100</strong>.`,
        urgencyLevel: narrative?.verdict?.urgency_level || "moderate",
      },
      catalog,
      sovGap,
      enrichment: narrative?.enrichment ? {
        productName: narrative.enrichment.product_name,
        before: narrative.enrichment.before,
        after: narrative.enrichment.after,
        fieldsBefore: narrative.enrichment.fields_before,
        fieldsAfter: narrative.enrichment.fields_after,
        fieldsTotal: narrative.enrichment.fields_total,
      } : null,
      simulation: narrative?.simulation ? {
        buyerQuery: narrative.simulation.buyer_query,
        withAcp: {
          productName: narrative.simulation.with_acp.product_name,
          price: narrative.simulation.with_acp.price,
          specs: narrative.simulation.with_acp.specs,
          reason: narrative.simulation.with_acp.reason,
          bundle: narrative.simulation.with_acp.bundle ? {
            items: narrative.simulation.with_acp.bundle.items,
            total: narrative.simulation.with_acp.bundle.total,
            aovUpliftPct: narrative.simulation.with_acp.bundle.aov_uplift_pct,
          } : null,
        },
        withoutAcp: {
          competitorName: narrative.simulation.without_acp.competitor_name,
          competitorProduct: narrative.simulation.without_acp.competitor_product,
          narrative: narrative.simulation.without_acp.narrative,
        },
      } : null,
      competitors: competitorsSection,
      competitiveInsight: narrative?.competitive_insight?.summary || "",
      revenue,
      pulse,
      gap,
      generatedAt: new Date().toISOString(),
    };

    await db.update(auditReports).set({
      commerce_data: commerceData,
      updated_at: new Date(),
    }).where(eq(auditReports.id, id));

    console.warn(`[L2:${id}] Done. Score: ${score.overall}, Products: ${catalog.totalCrawled}`);
  } catch (err) {
    console.error(`[L2:${id}] Background generation failed:`, err);
    await db.update(auditReports).set({
      commerce_data: { status: "error", error: (err as Error).message },
      updated_at: new Date(),
    }).where(eq(auditReports.id, id));
  }
}

export const maxDuration = 300;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // C2: access first, cached + processing short-circuits, then rate
    // limit only when about to kick off the L2 pipeline (Firecrawl + Sonnet).
    const access = await assertAuditAccess(id);
    if (!access.ok) return access.response;
    const { report } = access;

    const existing = report.commerce_data as Record<string, unknown> | null;
    if (existing && existing.generatedAt) {
      return NextResponse.json({
        status: "complete",
        data: existing as unknown as CommerceReportData,
      });
    }

    if (existing && existing.status === "processing") {
      return NextResponse.json({ status: "processing" });
    }

    const limited = await consumeAuditCostBudget(id, "commerce-report");
    if (limited) return limited;

    // Mark as processing in DB
    await db.update(auditReports).set({
      commerce_data: { status: "processing", startedAt: new Date().toISOString() },
      updated_at: new Date(),
    }).where(eq(auditReports.id, id));

    // Run the heavy work in the background after response is sent
    after(async () => {
      await generateCommerceReport(id, report);
    });

    return NextResponse.json({ status: "processing" });
  } catch (err) {
    console.error("Commerce report error:", err);
    return NextResponse.json(
      { error: `Failed to start commerce report: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const [report] = await db
      .select()
      .from(auditReports)
      .where(eq(auditReports.id, id))
      .limit(1);

    if (!report) {
      return NextResponse.json({ error: "Audit not found" }, { status: 404 });
    }

    const commerceData = report.commerce_data as Record<string, unknown> | null;

    if (!commerceData) {
      return NextResponse.json({
        status: "not_generated",
        merchant_name: report.merchant_name,
        merchant_url: report.merchant_url,
      });
    }

    // Processing in background
    if (commerceData.status === "processing") {
      return NextResponse.json({ status: "processing" });
    }

    // Failed
    if (commerceData.status === "error") {
      return NextResponse.json({
        status: "error",
        error: commerceData.error || "Report generation failed",
      });
    }

    // Complete
    return NextResponse.json({
      status: "complete",
      data: commerceData as unknown as CommerceReportData,
    });
  } catch (err) {
    console.error("Commerce report GET error:", err);
    return NextResponse.json(
      { error: "Failed to fetch commerce report" },
      { status: 500 }
    );
  }
}
