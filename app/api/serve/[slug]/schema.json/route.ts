import { NextRequest, NextResponse } from "next/server";
import { resolveSiteForServing } from "@/lib/serve-lookup";
import { logCrawl } from "@/lib/log-crawl";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { slug } = await params;

    const site = await resolveSiteForServing(slug, "generatedSchemaBlocks");

    if (!site || !site.generatedSchemaBlocks) {
      return NextResponse.json([], {
        status: 404,
        headers: {
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    void logCrawl(req, site.id, slug, "schema_json");

    const blocks = site.generatedSchemaBlocks as Array<{ jsonLd: Record<string, unknown> }>;
    const schemas = blocks.map((b) => b.jsonLd);

    return NextResponse.json(schemas, {
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
        "X-Generated-By": "FlowBlinq GEO Platform",
      },
    });
  } catch (err) {
    console.error("GET serve schema.json error:", err);
    return NextResponse.json([], { status: 500 });
  }
}
