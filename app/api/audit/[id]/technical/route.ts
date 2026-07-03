import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditReports } from "@/lib/db/schema";
import { runTechnicalChecks } from "@/lib/services/commerce/technical-checker";
import { assertAuditAccess, consumeAuditCostBudget } from "@/lib/audit-entitlement";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // C2: access check, then cache short-circuit, then rate limit only
    // before invoking runTechnicalChecks.
    const access = await assertAuditAccess(id);
    if (!access.ok) return access.response;
    const { report } = access;

    if (report.technical_data) {
      return NextResponse.json(report.technical_data);
    }

    const limited = await consumeAuditCostBudget(id, "technical");
    if (limited) return limited;

    const result = await runTechnicalChecks(report.merchant_url);

    await db
      .update(auditReports)
      .set({
        technical_data: result as unknown as Record<string, unknown>,
        platform_detected: result.raw.platformDetected,
        updated_at: new Date(),
      })
      .where(eq(auditReports.id, id));

    return NextResponse.json(result);
  } catch (err) {
    console.error("Technical phase error:", err);
    return NextResponse.json(
      { error: "Technical checks failed", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
