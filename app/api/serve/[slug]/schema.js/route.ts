import { NextRequest, NextResponse } from "next/server";
import { resolveSiteForServing } from "@/lib/serve-lookup";
import { logCrawl } from "@/lib/log-crawl";
import { buildSchemaInjectionJs } from "@/lib/schema-js-builder";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { slug } = await params;

    const site = await resolveSiteForServing(slug, "generatedSchemaBlocks");

    if (!site || !site.generatedSchemaBlocks) {
      return new NextResponse("// FlowBlinq GEO: no schema blocks found", {
        status: 404,
        headers: { "Content-Type": "application/javascript" },
      });
    }

    void logCrawl(req, site.id, slug, "schema_js");

    const blocks = site.generatedSchemaBlocks as Array<{
      type?: string;
      pageTarget?: string;
      jsonLd: Record<string, unknown>;
    }>;

    const js = buildSchemaInjectionJs(blocks);

    return new NextResponse(js, {
      status: 200,
      headers: {
        "Content-Type": "application/javascript",
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
        "X-Generated-By": "FlowBlinq GEO Platform",
      },
    });
  } catch (err) {
    console.error("GET serve schema.js error:", err);
    return new NextResponse("// FlowBlinq GEO: internal error", {
      status: 500,
      headers: { "Content-Type": "application/javascript" },
    });
  }
}
