import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditReports } from "@/lib/db/schema";
import { gatherIntelligence } from "@/lib/services/commerce/intelligence-gatherer";
import { assertAuditAccess, consumeAuditCostBudget } from "@/lib/audit-entitlement";

export const maxDuration = 60;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // C2: cheap access check first (email_verified + report exists).
    // Cache short-circuit BEFORE charging the rate-limit so polling
    // doesn't drain the customer's own budget.
    const access = await assertAuditAccess(id);
    if (!access.ok) return access.response;
    const { report } = access;

    if (report.intelligence_data) {
      return NextResponse.json(report.intelligence_data);
    }

    // No cache → about to invoke Anthropic + Firecrawl. Charge the budget.
    const limited = await consumeAuditCostBudget(id, "intelligence");
    if (limited) return limited;

    const result = await gatherIntelligence(
      report.merchant_url,
      report.merchant_name
    );

    await db
      .update(auditReports)
      .set({
        intelligence_data: result as unknown as Record<string, unknown>,
        status: "intelligence_complete",
        updated_at: new Date(),
      })
      .where(eq(auditReports.id, id));

    return NextResponse.json(result);
  } catch (err) {
    console.error("Intelligence phase error:", err);
    return NextResponse.json(
      { error: "Intelligence gathering failed", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
