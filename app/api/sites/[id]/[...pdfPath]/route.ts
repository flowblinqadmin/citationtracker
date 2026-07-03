// PDF audit report download — catch-all route handling both v1 and v2 URL shapes.
//
// Two URL shapes coexist (per Aditya 2026-04-29 v1 + v2):
//   v1 (kept for back-compat with cached links from the first 2026-04-29 fix):
//     /api/sites/<id>/<filename>.pdf?purchaseToken=<token>
//     pdfPath = [<filename>.pdf], purchaseToken in query string.
//   v2 (used in NEW delivery emails — Chromium recognizes the .pdf URL
//   suffix as a download intent only when there's no query string):
//     /api/sites/<id>/<purchaseToken>/<filename>.pdf
//     pdfPath = [<purchaseToken>, <filename>.pdf], no query string.
//
// Why catch-all instead of two separate dynamic routes:
// Next.js rejects sibling dynamic segments with different slug names at the
// same level — '[filename]' and '[token]' as siblings under [id] error
// out at startup with 'You cannot use different slug names for the same
// dynamic path'. The catch-all consolidates both shapes under one slug
// ([...pdfPath]) and dispatches by array length. Catch-all has lower
// routing precedence than the 16 static sibling segments (pdf-report,
// citation-check, etc.), so existing static routes are unaffected.
//
// Auth: v1 falls through to the query-string purchaseToken path inside
// the helper; v2 validates the path-bound token here AND passes it
// explicitly to the helper. Both ultimately go through the same
// generateAuditPdfResponse() with isPurchaseAuth + credit-skip semantics.
//
// Filename validation: last segment must end in .pdf (case-insensitive)
// for both shapes; else 404.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auditPurchases } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { generateAuditPdfResponse } from "@/lib/services/audit-pdf-handler";

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string; pdfPath: string[] }>;
}

export async function GET(req: NextRequest | Request, { params }: RouteContext) {
  const { id, pdfPath } = await params;

  if (pdfPath.length === 0 || pdfPath.length > 2) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const filename = pdfPath[pdfPath.length - 1];
  if (!filename.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // v1 (length 1): filename only — purchaseToken comes from query string
  // (helper handles it). Falls through.
  if (pdfPath.length === 1) {
    return generateAuditPdfResponse(req, id);
  }

  // v2 (length 2): pdfPath[0] is the purchaseToken, pdfPath[1] is filename.
  // Validate the path-bound token here so we can 401 fast without invoking
  // the helper's geoSiteView fetch + Puppeteer launch.
  const token = pdfPath[0];
  const [purchase] = await db
    .select({ id: auditPurchases.id })
    .from(auditPurchases)
    .where(and(eq(auditPurchases.purchaseToken, token), eq(auditPurchases.siteId, id)));

  if (!purchase) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return generateAuditPdfResponse(req, id, { purchaseToken: token });
}
