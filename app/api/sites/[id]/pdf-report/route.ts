// LEGACY URL — kept for back-compat with any cached/hardcoded link.
// New outbound emails use the .pdf-suffixed URL at app/api/sites/[id]/[filename]/route.ts
// (Chromium silent-download fix per Aditya 2026-04-29). Same handler core
// in lib/services/audit-pdf-handler.ts; both routes are byte-equivalent.
// TODO: deprecate after 2026-07-01 once no external clients still hit this path.

import { NextRequest } from "next/server";
import { generateAuditPdfResponse } from "@/lib/services/audit-pdf-handler";

export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest | Request, { params }: RouteContext) {
  const { id } = await params;
  return generateAuditPdfResponse(req, id);
}
