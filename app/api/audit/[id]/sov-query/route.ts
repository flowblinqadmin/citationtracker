import { NextResponse } from "next/server";
import { checkSingleQuery } from "@/lib/services/commerce/sov-checker";
import { assertAuditAccess, consumeAuditCostBudget } from "@/lib/audit-entitlement";

export const maxDuration = 30;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { query, queryIndex, brandName, competitorNames, primaryMarket } = body;

    if (!query || typeof query !== "string") {
      return NextResponse.json(
        { error: "query string is required" },
        { status: 400 }
      );
    }

    // C2: per-query route is high-volume (UI fires one per query). Access
    // check is cheap; rate-limit only when about to fire an LLM call.
    // sov-query has no cached short-circuit (each query is per-call distinct).
    const access = await assertAuditAccess(id);
    if (!access.ok) return access.response;
    const { report } = access;

    const limited = await consumeAuditCostBudget(id, "sov-query", 60);
    if (limited) return limited;

    const result = await checkSingleQuery(
      query,
      brandName || report.merchant_name,
      competitorNames || [],
      primaryMarket
    );

    return NextResponse.json({ ...result, queryIndex });
  } catch (err) {
    console.error("SoV single-query error:", err);
    return NextResponse.json(
      { error: "Query check failed", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
