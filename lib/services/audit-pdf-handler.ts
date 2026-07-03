// Shared core for the audit PDF download endpoints.
//
// Two routes call into this helper:
//   1. app/api/sites/[id]/pdf-report/route.ts            (legacy, kept for back-compat)
//   2. app/api/sites/[id]/[filename]/route.ts            (new — URL ends in .pdf so
//                                                         Chromium recognizes the
//                                                         download intent before
//                                                         binary processing; survives
//                                                         the popup-tab auto-close
//                                                         that swallowed the prior
//                                                         GMC delivery flow).
//
// Behavior is identical between both routes — same auth (purchaseToken OR
// accessToken), same credit-skip semantics, same generated PDF, same
// Content-Disposition. Only the URL path differs.
//
// Task 2 (2026-04-28): extracted renderAuditPdfBuffer() so the email-delivery
// path can attach the binary without going through a NextResponse.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSiteView, citationCheckScores, auditPurchases } from "@/lib/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { generatePdfReportHtml, brandLogoSvg, type PdfReportData } from "@/lib/services/pdf-report-html";
import type { DiscoveryData } from "@/lib/services/geo-crawler";
import { deductCredits } from "@/lib/services/credit-deduction";
import { ACTION_CREDITS } from "@/lib/config";

// ── Typed errors thrown by renderAuditPdfBuffer ───────────────────────────────

export class PdfAuthError extends Error {
  constructor(public readonly status: 401 | 402 | 404, message: string) {
    super(message);
    this.name = "PdfAuthError";
  }
}

// ── Core buffer renderer ──────────────────────────────────────────────────────

/**
 * Renders the audit PDF to a Buffer. Handles both auth paths (purchaseToken
 * bypass and accessToken + credit deduction). Throws PdfAuthError for
 * permission / not-found failures so callers can translate to HTTP responses.
 *
 * Extracted from generateAuditPdfResponse (Task 2) so the email-delivery
 * path can attach the binary without constructing a NextResponse.
 */
export async function renderAuditPdfBuffer(
  siteId: string,
  options?: { purchaseToken?: string; skipCreditDeduction?: boolean },
): Promise<{ buffer: Buffer; filename: string; domain: string }> {
  const purchaseToken = options?.purchaseToken;

  // Auth path 1: purchaseToken from GMC audit purchase (no credit deduction)
  let isPurchaseAuth = false;
  let purchaseCustomerEmail: string | null = null;

  if (purchaseToken) {
    const [purchase] = await db
      .select({ id: auditPurchases.id, customerEmail: auditPurchases.customerEmail, purchaseTokenExpiresAt: auditPurchases.purchaseTokenExpiresAt })
      .from(auditPurchases)
      .where(
        and(
          eq(auditPurchases.purchaseToken, purchaseToken),
          eq(auditPurchases.siteId, siteId),
        ),
      );
    if (purchase) {
      // Fix #32: enforce purchaseToken expiry (30-day TTL stamped at creation).
      // NULL means a legacy row without expiry — treat as expired for safety.
      if (!purchase.purchaseTokenExpiresAt || purchase.purchaseTokenExpiresAt < new Date()) {
        throw new PdfAuthError(401, "purchaseToken has expired");
      }
      isPurchaseAuth = true;
      purchaseCustomerEmail = purchase.customerEmail;
    }
  }

  const [site] = await db.select().from(geoSiteView).where(eq(geoSiteView.siteId, siteId));

  if (!site) {
    throw new PdfAuthError(404, "Site not found");
  }

  // Skip credit deduction for purchase-authenticated requests
  if (!isPurchaseAuth && !options?.skipCreditDeduction) {
    if (!site.teamId) {
      throw new PdfAuthError(402, "Pro account required.");
    }

    const deduction = await deductCredits({
      teamId: site.teamId,
      cost: ACTION_CREDITS.pdfDownload,
      type: "pdf_download",
      description: `PDF report for ${site.domain}`,
      siteId: site.siteId,
    });
    if (!deduction.success) {
      throw new PdfAuthError(402, deduction.error ?? "Insufficient credits.");
    }
  }

  if (!site.overallScore) {
    throw new PdfAuthError(404, "Scorecard not yet available.");
  }

  // Fetch latest citation check
  const [lastCitationCheck] = await db
    .select()
    .from(citationCheckScores)
    .where(eq(citationCheckScores.siteId, site.siteId))
    .orderBy(desc(citationCheckScores.createdAt))
    .limit(1);

  const lc = lastCitationCheck ?? null;

  // Extract data from view table
  const pillars = (site.pillars ?? []) as Array<{
    pillar: string; pillarName: string; score: number;
    findings: string; recommendation: string; priority: string;
  }>;

  const storedRecs = (site.rankedRecommendations ?? []) as PdfReportData["recommendations"];

  // Fallback: if no recommendations, derive from pillar data
  const recs = storedRecs.length > 0 ? storedRecs : pillars
    .filter(p => p.recommendation)
    .map((p, i) => ({
      rank: i + 1,
      title: p.recommendation,
      pillar: p.pillar,
      estimatedBoost: "",
      priority: p.priority ?? (p.score < 25 ? "high" : p.score < 50 ? "medium" : "low"),
    }));
  const pageCount = site.pageCount ?? 0;

  type _PR = { provider: string; visibilityScore: number; mentionCount: number; totalQueries: number };
  const providerResults = (lc?.providerResults ?? []) as _PR[];
  const totalMentions = providerResults.reduce((s, p) => s + p.mentionCount, 0);
  const totalQueries = providerResults.reduce((s, p) => s + p.totalQueries, 0);
  const citationRate = totalQueries > 0 ? Math.round((totalMentions / totalQueries) * 100) : null;

  // Task 1: wire discoveryData fields into pdfData
  const discovery = (site.discoveryData ?? null) as DiscoveryData | null;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
  const reportUrl = `${appUrl}/sites/${siteId}`;

  // Task 4: populate coverPanel for purchase-auth requests
  const coverPanel = isPurchaseAuth
    ? {
        reportUrl,
        installUrl: `${appUrl}/sites/${siteId}/install`,
      }
    : undefined;

  const pdfData: PdfReportData = {
    domain: site.domain,
    overallScore: site.overallScore,
    pillars,
    recommendations: recs,
    executiveSummary: site.executiveSummary ?? null,
    lastCrawlAt: site.lastCrawlAt?.toISOString() ?? null,
    pageCount,
    // HP-253: read indirectVisibility (canonical SOV) — overallVisibility is
    // now an alias of indirectVisibility on the citation-checker return; both
    // names carry the same value on rows written post-fb1d6a0.
    overallVisibility: lc?.indirectVisibility ?? lc?.overallVisibility ?? null,
    citationRate,
    citationQualityScore: lc?.citationQualityScore ?? null,
    providerResults,
    competitorData: (lc?.competitorData ?? []) as PdfReportData["competitorData"],
    pillarVisibility: (lc?.pillarVisibility ?? {}) as Record<string, number>,
    geoVisibility: (lc?.geoVisibility ?? []) as PdfReportData["geoVisibility"],
    categoryVisibility: (lc?.categoryVisibility ?? []) as PdfReportData["categoryVisibility"],
    tierVisibility: (lc?.tierVisibility ?? []) as PdfReportData["tierVisibility"],
    ourSOV: lc?.indirectVisibility ?? lc?.overallVisibility ?? null,
    reportUrl,
    // Task 1: discovery signals
    hasLlmsTxt: discovery?.hasLlmsTxt === true,
    hasRobotsTxt: discovery?.hasRobots === true,
    hasBusinessJson: (() => {
      const bj = discovery?.ownBusinessJson;
      if (!bj || typeof bj !== "object" || Array.isArray(bj)) return false;
      return Object.keys(bj as Record<string, unknown>).length >= 4;
    })(),
    // TODO(stalePageCount): wire from assembler when stale-content metric is persisted.
    // Until then, leave undefined so the Content Freshness tile is suppressed rather
    // than rendering a misleading "All pages have recent dates ✅" with no real data.
    // projectedScore from view table
    projectedScore: site.projectedScore ?? undefined,
    // Task 4: cover panel
    coverPanel,
  };

  const html = generatePdfReportHtml(pdfData);

  // Render to PDF via Puppeteer + @sparticuz/chromium-min (Vercel) or system Chromium (Docker)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const puppeteer = require("puppeteer-core");

  let execPath: string;
  let args: string[];

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    // Docker: use system-installed Chromium
    execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    args = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];
  } else {
    // Vercel: use @sparticuz/chromium-min
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const chromium = require("@sparticuz/chromium-min");
    execPath = await chromium.executablePath("https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar");
    args = chromium.args;
  }

  const browser = await puppeteer.launch({
    executablePath: execPath,
    headless: true,
    args,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 15000 });

    // Brand Book v3.0 logomark — full-color primary-dark variant via the
    // shared brandLogoSvg() helper. Suffix 'header' namespaces gradient +
    // filter ids so they don't collide with the 'cover' suffix used by
    // pdf-report-html.ts (Puppeteer rejects duplicate ids in the merged
    // header+body+footer DOM).
    const headerLogoSvg = brandLogoSvg("header", 14);

    const headerHtml = `
      <div style="width: 100%; padding: 0 12mm; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 8px;">
        <div style="display: flex; align-items: center; justify-content: space-between; padding-bottom: 6px; border-bottom: 0.5px solid #E8E6E1;">
          <div style="display: flex; align-items: center; gap: 6px;">
            ${headerLogoSvg}
            <span style="font-weight: 400; letter-spacing: 3px; color: #5C6B3C; font-size: 8px;">FLOWBLINQ · GEO</span>
          </div>
          <span style="color: #5A5A56; font-size: 8px;">${site.domain.replace(/"/g, "")}</span>
        </div>
      </div>`;

    const footerHtml = `
      <div style="width: 100%; padding: 0 12mm; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 8px; color: #5A5A56;">
        <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 6px; border-top: 0.5px solid #E8E6E1;">
          <span style="letter-spacing: 0.4px;">AI VISIBILITY REPORT · ${site.domain.replace(/"/g, "")}</span>
          <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
        </div>
      </div>`;

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: headerHtml,
      footerTemplate: footerHtml,
      margin: { top: "28mm", bottom: "20mm", left: "12mm", right: "12mm" },
    });

    const filename = `${site.domain.replace(/[^a-zA-Z0-9.-]/g, "_")}-geo-audit-report.pdf`;

    console.warn(JSON.stringify({
      event: "pdf_report_download",
      siteId,
      domain: site.domain,
      pdfSizeBytes: pdfBuffer.length,
    }));

    return { buffer: Buffer.from(pdfBuffer), filename, domain: site.domain };
  } finally {
    await browser.close();
  }
}

// ── HTTP wrapper ──────────────────────────────────────────────────────────────

export async function generateAuditPdfResponse(
  req: Request,
  siteId: string,
  options?: { purchaseToken?: string },
): Promise<NextResponse> {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    // The /[id]/[token]/[filename].pdf route passes purchaseToken in via
    // options because Aditya 2026-04-29 directive: URL must LITERALLY end
    // in .pdf (no query string at all). The two query-style routes still
    // work — they fall through to url.searchParams.
    const purchaseToken = options?.purchaseToken ?? url.searchParams.get("purchaseToken");

    // Auth path 1: purchaseToken — validated atomically inside renderAuditPdfBuffer.
    // Auth path 2: standard accessToken — validate accessToken here (no credits spent yet)
    // before handing off to the buffer helper. purchaseToken auth is owned entirely
    // by renderAuditPdfBuffer to avoid a TOCTOU window from a redundant pre-check.
    if (!purchaseToken) {
      if (!token) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      // Validate accessToken + TTL before spending credits.
      // H3 (2026-05-27 audit): other accessToken routes already enforce
      // tokenExpiresAt — without parity here, a leaked token is good for PDF
      // download forever even past the customer's TTL.
      const [site] = await db
        .select({
          accessToken: geoSiteView.accessToken,
          tokenExpiresAt: geoSiteView.tokenExpiresAt,
        })
        .from(geoSiteView)
        .where(eq(geoSiteView.siteId, siteId));
      if (
        !site ||
        site.accessToken !== token ||
        !site.tokenExpiresAt ||
        site.tokenExpiresAt < new Date()
      ) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const { buffer, filename } = await renderAuditPdfBuffer(siteId, {
      purchaseToken: purchaseToken ?? undefined,
      // For accessToken path, credit deduction is handled inside renderAuditPdfBuffer.
    });

    // NextResponse body must be BodyInit — cast via Uint8Array which Buffer extends
    return new NextResponse(buffer as unknown as Uint8Array, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(buffer.length),
      },
    });
  } catch (err) {
    if (err instanceof PdfAuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("audit-pdf generation error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
