import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditReports } from "@/lib/db/schema";
import { computeSovSummary } from "@/lib/services/commerce/sov-checker";
import { compileReport } from "@/lib/services/commerce/report-generator";
import type { IntelligenceResult } from "@/lib/services/commerce/intelligence-gatherer";
import type { QueryResult, SovResult } from "@/lib/services/commerce/sov-checker";
import { assertAuditAccess, consumeAuditCostBudget } from "@/lib/audit-entitlement";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { results, brandName } = body as {
      results: QueryResult[];
      brandName: string;
      competitorNames: string[];
    };

    if (!results || !Array.isArray(results) || results.length === 0) {
      return NextResponse.json(
        { error: "results array is required" },
        { status: 400 }
      );
    }

    // C2: access check, then cache short-circuit, then rate limit only
    // when about to finalize and compile (compileReport + DB write).
    const access = await assertAuditAccess(id);
    if (!access.ok) return access.response;
    const { report } = access;

    if (report.sov_data) {
      return NextResponse.json(report.sov_data);
    }

    const limited = await consumeAuditCostBudget(id, "sov-complete");
    if (limited) return limited;

    const summary = computeSovSummary(results, brandName || report.merchant_name);
    const sovResult: SovResult = { results, summary };

    // Compile final report
    const compiled = compileReport(
      (report.intelligence_data as IntelligenceResult) || null,
      null,
      sovResult,
      null,
      report.revenue_estimate,
      report.product_category
    );

    await db
      .update(auditReports)
      .set({
        sov_data: sovResult as unknown as Record<string, unknown>,
        overall_score: compiled.overall_score,
        status: "complete",
        updated_at: new Date(),
      })
      .where(eq(auditReports.id, id));

    return NextResponse.json(sovResult);
  } catch (err) {
    console.error("SoV complete error:", err);
    return NextResponse.json(
      { error: "Failed to finalize SoV results", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
