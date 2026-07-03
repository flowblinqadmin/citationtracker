import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditReports } from "@/lib/db/schema";
import { compileReport } from "@/lib/services/commerce/report-generator";
import type { IntelligenceResult } from "@/lib/services/commerce/intelligence-gatherer";
import type { TechnicalResult } from "@/lib/services/commerce/technical-checker";
import type { SovResult } from "@/lib/services/commerce/sov-checker";
import type { SemanticResult } from "@/lib/services/commerce/semantic-checker";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // H7: per-IP rate limit caps brute-force enumeration of audit IDs.
    // Legitimate polling from one client stays well under 60/min; an
    // attacker iterating nanoid space gets blocked quickly.
    const ip = getClientIp(request);
    const rl = await checkRateLimit(`audit-get:${ip}`, 60, 60_000);
    if (!rl.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
      return NextResponse.json(
        { error: "Too Many Requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }

    const [report] = await db
      .select()
      .from(auditReports)
      .where(eq(auditReports.id, id))
      .limit(1);

    if (!report) {
      return NextResponse.json({ error: "Audit not found" }, { status: 404 });
    }

    // If still pending verification, return minimal info
    if (!report.email_verified) {
      return NextResponse.json({
        id: report.id,
        status: report.status,
        merchant_name: report.merchant_name,
        merchant_url: report.merchant_url,
      });
    }

    // Compile report from whatever phase data is available
    const compiled = compileReport(
      (report.intelligence_data as IntelligenceResult) || null,
      (report.technical_data as TechnicalResult) || null,
      (report.sov_data as SovResult) || null,
      (report.semantic_data as SemanticResult) || null,
      report.revenue_estimate,
      report.product_category
    );

    // Auto-correct status if core phase data is present but status wasn't updated
    let effectiveStatus = report.status;
    if (
      report.status !== "complete" &&
      report.intelligence_data &&
      report.sov_data
    ) {
      effectiveStatus = "complete";
      // Fix the DB status asynchronously
      db.update(auditReports)
        .set({ status: "complete", overall_score: compiled.overall_score, updated_at: new Date() })
        .where(eq(auditReports.id, id))
        .then(() => {})
        .catch(() => {});
    }

    return NextResponse.json({
      id: report.id,
      status: effectiveStatus,
      merchant_url: report.merchant_url,
      merchant_name: report.merchant_name,
      product_category: report.product_category,
      created_at: report.created_at,
      ...compiled,
    });
  } catch (err) {
    console.error("Fetch report error:", err);
    return NextResponse.json(
      { error: "Failed to fetch report" },
      { status: 500 }
    );
  }
}
