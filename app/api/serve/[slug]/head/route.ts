import { NextRequest, NextResponse } from "next/server";
import { resolveSiteForServing } from "@/lib/serve-lookup";
import { logCrawl } from "@/lib/log-crawl";
import { filterBlocksForPage, buildScriptTag, type SchemaBlock } from "@/lib/schema-block-filter";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=3600",
} as const;

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { slug } = await params;
    const path = req.nextUrl.searchParams.get("path");

    if (!path) {
      return NextResponse.json(
        { error: "Missing required query param: path" },
        { status: 400 }
      );
    }

    const site = await resolveSiteForServing(slug, "generatedSchemaBlocks");

    if (!site || !site.generatedSchemaBlocks) {
      return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
    }

    void logCrawl(req, site.id, slug, "head_html");

    const blocks = site.generatedSchemaBlocks as SchemaBlock[];
    const { pageBlocks, sitewideBlocks } = filterBlocksForPage(blocks, path);
    const allBlocks = [...sitewideBlocks, ...pageBlocks];

    if (allBlocks.length === 0) {
      return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
    }

    const html = buildScriptTag(allBlocks);

    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html",
        ...CORS_HEADERS,
        "X-Generated-By": "FlowBlinq GEO Platform",
      },
    });
  } catch (err) {
    console.error("GET serve head error:", err);
    return new NextResponse(null, { status: 500 });
  }
}
