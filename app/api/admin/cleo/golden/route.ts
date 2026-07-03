import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { chatbotLogs, geoSiteView } from "@/lib/db/schema";
import { asc, eq } from "drizzle-orm";
import { createClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/lib/auth/admin";

export const runtime = "nodejs";

const TARGET = path.join(process.cwd(), "eval", "failures", "curated.jsonl");

export async function POST(req: NextRequest) {
  // Defence-in-depth: refuse in production where the FS is read-only.
  if (process.env.VERCEL_ENV === "production") {
    return NextResponse.json(
      { error: "Disabled in production (write to read-only filesystem)", code: "DISABLED_IN_PROD" },
      { status: 503 },
    );
  }

  // Auth via Supabase session — never trust headers.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!isAdminEmail(user?.email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 404 });
  }

  // Cap body size — prevents memory exhaustion via a giant JSON payload.
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > 64 * 1024) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let body: {
    conversationId?: string;
    expectedAnswer?: string;
    mustContain?: string[];
    mustNotContain?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const conversationId = (body.conversationId ?? "").trim();
  const expectedAnswer = (body.expectedAnswer ?? "").trim();
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  }
  if (!expectedAnswer) {
    return NextResponse.json({ error: "expectedAnswer required" }, { status: 400 });
  }

  const rows = await db
    .select()
    .from(chatbotLogs)
    .where(eq(chatbotLogs.conversationId, conversationId))
    .orderBy(asc(chatbotLogs.createdAt));

  if (!rows.length) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  const last = rows[rows.length - 1];
  const query = last.query;
  const viewContext = last.viewContext as Record<string, unknown> | null;

  // Site context override built from the live site row, if available.
  let siteContextOverrides: Record<string, unknown> = {};
  if (last.siteId) {
    const [site] = await db
      .select({
        siteId: geoSiteView.siteId, domain: geoSiteView.domain, slug: geoSiteView.slug,
        platformDetected: geoSiteView.platformDetected, overallScore: geoSiteView.overallScore,
      })
      .from(geoSiteView)
      .where(eq(geoSiteView.siteId, last.siteId));
    if (site) {
      siteContextOverrides = {
        domain: site.domain,
        platformDetected: site.platformDetected,
        slug: site.slug,
        overallScore: site.overallScore,
        tier: "free",
      };
    }
  }

  const id = `curated-${conversationId.slice(0, 12)}-${Date.now().toString(36)}`;
  const testCase = {
    id,
    category: "curated-from-prod",
    severity: "high",
    query,
    siteContextOverrides,
    viewContext,
    mustContain: Array.isArray(body.mustContain) ? body.mustContain : [],
    mustNotContain: Array.isArray(body.mustNotContain) ? body.mustNotContain : [],
    sourceLogId: conversationId,
    expectedAnswer,
    why: "Promoted from /admin/cleo triage",
  };

  try {
    await fs.appendFile(TARGET, JSON.stringify(testCase) + "\n", "utf8");
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to write" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, id });
}
