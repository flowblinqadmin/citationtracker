import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import dns from "dns/promises";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY!);

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const token =
      req.headers.get("authorization")?.replace("Bearer ", "") ??
      req.nextUrl.searchParams.get("token");

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [site] = await db.select().from(geoSites).where(eq(geoSites.id, id));

    if (!site) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (site.accessToken !== token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const domain = site.domain;
    const expectedToken = `flowblinq-verify-${id}`;

    let flat: string[] = [];
    let verified = false;

    // Check both @ (root) and _flowblinq-verify subdomain TXT records
    const lookups = [domain, `_flowblinq-verify.${domain}`];
    for (const host of lookups) {
      try {
        const records = await dns.resolveTxt(host);
        flat.push(...records.flat());
      } catch {
        // No TXT records at this host — normal, continue
      }
    }
    verified = flat.some((r) => r.includes(expectedToken));

    if (verified && !site.domainVerified) {
      await db
        .update(geoSites)
        .set({ domainVerified: true, updatedAt: new Date() })
        .where(eq(geoSites.id, id));

      // Notify on first connection
      resend.emails.send({
        from: "FlowBlinq GEO <noreply@send.flowblinq.com>",
        to: "ar@flowblinq.com",
        subject: `🔗 ${domain} just connected`,
        text: `${site.ownerEmail ?? "A customer"} (${domain}) verified domain ownership and connected their site to FlowBlinq GEO.\n\nSite ID: ${id}\nhttps://geo.flowblinq.com/sites/${id}`,
      }).catch(() => {}); // fire-and-forget
    }

    return NextResponse.json({ verified });
  } catch (err) {
    console.error("POST /api/sites/[id]/verify-domain error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
