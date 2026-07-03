import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSiteView } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { slug } = await params;

    const [site] = await db
      .select({ id: geoSiteView.siteId, domain: geoSiteView.domain, pipelineStatus: geoSiteView.pipelineStatus })
      .from(geoSiteView)
      .where(eq(geoSiteView.slug, slug));

    if (!site || site.pipelineStatus !== "complete") {
      return new NextResponse("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
    }

    const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";

    const body = [
      `# FlowBlinq GEO — AI file manifest for ${site.domain}`,
      `# Four machine-readable files optimized for AI training and inference.`,
      `# Fetch any of these URLs to access structured content about this site.`,
      ``,
      `${base}/api/serve/${slug}/llms.txt`,
      `${base}/api/serve/${slug}/llms-full.txt`,
      `${base}/api/serve/${slug}/business.json`,
      `${base}/api/serve/${slug}/schema.json`,
    ].join("\n");

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
        "X-Generator": "FlowBlinq GEO",
      },
    });
  } catch (err) {
    console.error("GET serve urls.txt error:", err);
    return new NextResponse("Internal server error", { status: 500 });
  }
}
