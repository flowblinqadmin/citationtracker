import { NextRequest, NextResponse } from "next/server";
import { resolveSiteForServing } from "@/lib/serve-lookup";
import { logCrawl } from "@/lib/log-crawl";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { slug } = await params;

    const site = await resolveSiteForServing(slug, "generatedBusinessJson");

    if (!site || !site.generatedBusinessJson) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    void logCrawl(req, site.id, slug, "business_json");

    return NextResponse.json(site.generatedBusinessJson, {
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
        "X-Generator": "FlowBlinq GEO",
      },
    });
  } catch (err) {
    console.error("GET serve business.json error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
