import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditReports } from "@/lib/db/schema";
import { checkShareOfVoice } from "@/lib/services/commerce/sov-checker";
import { compileReport } from "@/lib/services/commerce/report-generator";
import type { IntelligenceResult } from "@/lib/services/commerce/intelligence-gatherer";
import { assertAuditAccess, consumeAuditCostBudget } from "@/lib/audit-entitlement";

export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { queries, brandName, competitorNames } = body;

    if (!queries || !Array.isArray(queries) || queries.length === 0) {
      return NextResponse.json(
        { error: "queries array is required" },
        { status: 400 }
      );
    }

    // C2: access check, then cache short-circuit, then rate limit only if
    // about to invoke checkShareOfVoice (Firecrawl + LLM).
    const access = await assertAuditAccess(id);
    if (!access.ok) return access.response;
    const { report } = access;

    if (report.sov_data) {
      return NextResponse.json(report.sov_data);
    }

    const limited = await consumeAuditCostBudget(id, "sov");
    if (limited) return limited;

    const result = await checkShareOfVoice(
      queries,
      brandName || report.merchant_name,
      competitorNames || []
    );

    // Compile final report — SoV is the last phase now
    const compiled = compileReport(
      (report.intelligence_data as IntelligenceResult) || null,
      null,
      result,
      null,
      report.revenue_estimate,
      report.product_category
    );

    await db
      .update(auditReports)
      .set({
        sov_data: result as unknown as Record<string, unknown>,
        overall_score: compiled.overall_score,
        status: "complete",
        updated_at: new Date(),
      })
      .where(eq(auditReports.id, id));

    return NextResponse.json(result);
  } catch (err) {
    console.error("SoV phase error:", err);
    return NextResponse.json(
      { error: "Share of Voice check failed", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
