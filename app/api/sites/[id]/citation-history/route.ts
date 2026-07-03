import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites, citationCheckScores } from "@/lib/db/schema";
import { eq, desc, sql } from "drizzle-orm";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  const { id: siteId } = await params;

  // ── Auth: accessToken (Bearer header or ?token= query param) ──────────
  const token = req.headers.get("authorization")?.replace("Bearer ", "")
    ?? req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });
  if (site.accessToken !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // ── Parse limit param ─────────────────────────────────────────────────
  const rawLimit = req.nextUrl.searchParams.get("limit") ?? "10";
  const limit = parseInt(rawLimit, 10);
  if (!Number.isInteger(limit) || isNaN(limit) || limit < 1 || limit > 50) {
    console.warn(`[citation-history] siteId=${siteId} invalid limit param: ${rawLimit}`);
    return NextResponse.json({ error: "Invalid limit. Must be 1–50." }, { status: 400 });
  }

  // ── DB queries ────────────────────────────────────────────────────────
  try {
    const rows = await db
      .select()
      .from(citationCheckScores)
      .where(eq(citationCheckScores.siteId, siteId))
      .orderBy(desc(citationCheckScores.createdAt))
      .limit(limit);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(citationCheckScores)
      .where(eq(citationCheckScores.siteId, siteId));

    console.info(`[citation-history] siteId=${siteId} returned ${rows.length}/${count} records`);
    return NextResponse.json({ history: rows, total: count });
  } catch (err) {
    console.error(`[citation-history] siteId=${siteId} DB error:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
