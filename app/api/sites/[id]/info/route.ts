import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  const visible = local[0] ?? "*";
  const masked = visible + "***";
  return `${masked}@${domain}`;
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    // H6 (2026-05-27 audit): unauthenticated enumeration surface — masked
    // email + domain for any guessed site id. Per-IP rate limit caps
    // brute-force discovery of customer roster.
    const ip = getClientIp(req);
    const rl = await checkRateLimit(`site-info:${ip}`, 30, 60_000);
    if (!rl.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
      return NextResponse.json(
        { error: "Too Many Requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }

    const { id } = await params;
    const [site] = await db.select({
      id: geoSites.id,
      domain: geoSites.domain,
      ownerEmail: geoSites.ownerEmail,
    }).from(geoSites).where(eq(geoSites.id, id));

    if (!site) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({
      id: site.id,
      domain: site.domain,
      maskedEmail: maskEmail(site.ownerEmail),
    });
  } catch (err) {
    console.error("GET /api/sites/[id]/info error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
