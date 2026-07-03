import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSiteView, auditPurchases } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { buildReportZip } from "@/lib/services/zip-builder";
import { deductCredits } from "@/lib/services/credit-deduction";
import { ACTION_CREDITS } from "@/lib/config";
import type { PerPageResult } from "@/lib/services/per-page-analyzer";
import type { PerPageFix } from "@/lib/services/page-fix-generator";
import type { ImplementationStatus } from "@/lib/services/implementation-tracker";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest | Request, { params }: RouteContext) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    const purchaseToken = url.searchParams.get("purchaseToken");

    // Auth path 1: purchaseToken from GMC audit purchase (no credit deduction)
    // M4 (2026-05-27 audit): also enforce purchaseTokenExpiresAt — citation-check
    // + PDF routes do this; without the parity, an expired purchaseToken
    // authorizes a free ZIP forever.
    let isPurchaseAuth = false;
    if (purchaseToken) {
      const [purchase] = await db
        .select({
          id: auditPurchases.id,
          purchaseTokenExpiresAt: auditPurchases.purchaseTokenExpiresAt,
        })
        .from(auditPurchases)
        .where(
          and(
            eq(auditPurchases.purchaseToken, purchaseToken),
            eq(auditPurchases.siteId, id),
          ),
        );
      if (
        purchase &&
        purchase.purchaseTokenExpiresAt &&
        purchase.purchaseTokenExpiresAt > new Date()
      ) {
        isPurchaseAuth = true;
      }
    }

    if (!isPurchaseAuth && !token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [site] = await db.select().from(geoSiteView).where(eq(geoSiteView.siteId, id));

    // H3 (2026-05-27 audit): accessToken paths also enforce tokenExpiresAt
    // (other routes already do — sites/[id], chatbot, citation-check).
    if (
      !isPurchaseAuth &&
      (!site ||
        site.accessToken !== token ||
        !site.tokenExpiresAt ||
        site.tokenExpiresAt < new Date())
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!site) {
      return NextResponse.json({ error: "Site not found" }, { status: 404 });
    }

    if (!isPurchaseAuth) {
      if (!site.teamId) {
        return NextResponse.json({ error: "Pro account required." }, { status: 402 });
      }

      const deduction = await deductCredits({
        teamId: site.teamId,
        cost: ACTION_CREDITS.zipDownload,
        type: "zip_download",
        description: `ZIP download for ${site.domain}`,
        siteId: site.siteId,
      });
      if (!deduction.success) {
        return NextResponse.json({ error: deduction.error }, { status: 402 });
      }
    }

    const perPageResults = (site.perPageResults as PerPageResult[]) ?? [];
    if (perPageResults.length === 0) {
      return NextResponse.json({ error: "No per-page results available." }, { status: 404 });
    }

    if (!site.overallScore) {
      return NextResponse.json({ error: "Scorecard not yet available." }, { status: 404 });
    }

    const pillars = (site.pillars ?? []) as Array<{ pillarName: string; score: number; priority: string }>;
    const perPageFixes = (site.perPageFixes as PerPageFix[]) ?? [];
    const implementationStatus = (site.implementationStatus as ImplementationStatus[]) ?? [];

    const start = Date.now();
    const zipBuffer = await buildReportZip(
      {
        domain: site.domain,
        geoScorecard: {
          overallScore: site.overallScore,
          pillars,
          topThreeImprovements: [],
        },
        executiveSummary: site.executiveSummary ?? "",
        failedUrls: [],
      },
      perPageResults,
      perPageFixes.length > 0 ? perPageFixes : undefined,
      implementationStatus.length > 0 ? implementationStatus : undefined
    );
    const generationMs = Date.now() - start;

    console.warn(JSON.stringify({
      event: "single_audit_zip_download",
      siteId: id,
      domain: site.domain,
      pageCount: perPageResults.length,
      zipSizeBytes: zipBuffer.length,
      generationMs,
    }));

    const filename = `${site.domain.replace(/[^a-zA-Z0-9.-]/g, "_")}-geo-audit.zip`;

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(zipBuffer.length),
      },
    });
  } catch (err) {
    console.error("GET /api/sites/[id]/download-report error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
