import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditReports } from "@/lib/db/schema";
import { checkSemanticQuality, type SemanticResult } from "@/lib/services/commerce/semantic-checker";
import { compileReport } from "@/lib/services/commerce/report-generator";
import type { IntelligenceResult } from "@/lib/services/commerce/intelligence-gatherer";
import type { TechnicalResult } from "@/lib/services/commerce/technical-checker";
import type { SovResult } from "@/lib/services/commerce/sov-checker";
import { assertAuditAccess, consumeAuditCostBudget } from "@/lib/audit-entitlement";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // C2: access first, cached short-circuit, rate limit only when
    // about to invoke checkSemanticQuality (Firecrawl).
    const access = await assertAuditAccess(id);
    if (!access.ok) return access.response;
    const { report } = access;

    if (report.semantic_data && report.status === "complete") {
      const cachedCompiled = compileReport(
        (report.intelligence_data as IntelligenceResult) || null,
        (report.technical_data as TechnicalResult) || null,
        (report.sov_data as SovResult) || null,
        (report.semantic_data as SemanticResult) || null,
        report.revenue_estimate,
        report.product_category
      );
      return NextResponse.json({ semantic: report.semantic_data, compiled: cachedCompiled });
    }

    const limited = await consumeAuditCostBudget(id, "semantic");
    if (limited) return limited;

    const semanticResult = await checkSemanticQuality(report.merchant_url);

    // Compile final report with all phase data
    const compiled = compileReport(
      (report.intelligence_data as IntelligenceResult) || null,
      (report.technical_data as TechnicalResult) || null,
      (report.sov_data as SovResult) || null,
      semanticResult,
      report.revenue_estimate,
      report.product_category
    );

    await db
      .update(auditReports)
      .set({
        semantic_data: semanticResult as unknown as Record<string, unknown>,
        overall_score: compiled.overall_score,
        status: "complete",
        updated_at: new Date(),
      })
      .where(eq(auditReports.id, id));

    return NextResponse.json({ semantic: semanticResult, compiled });
  } catch (err) {
    console.error("Semantic phase error:", err);
    return NextResponse.json(
      { error: "Semantic analysis failed", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
