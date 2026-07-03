import { NextRequest, NextResponse } from "next/server";
import { resolveSiteForServing } from "@/lib/serve-lookup";
import { logCrawl } from "@/lib/log-crawl";
import {
  type SchemaBlock,
  groupSchemaBlocks,
  filterBlocksForPage,
  buildScriptTag,
  isSitewideBlock,
} from "@/lib/schema-block-filter";

interface RouteContext {
  params: Promise<{ slug: string; page: string }>;
}

const HEADERS = {
  "Cache-Control": "public, max-age=3600",
  "Access-Control-Allow-Origin": "*",
  "X-Generated-By": "FlowBlinq GEO Platform",
};

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { slug, page } = await params;
    const decodedPage = decodeURIComponent(page);

    const site = await resolveSiteForServing(slug, "generatedSchemaBlocks");

    if (!site || !site.generatedSchemaBlocks) {
      return NextResponse.json(
        { error: "not found" },
        { status: 404, headers: HEADERS }
      );
    }

    const blocks = site.generatedSchemaBlocks as SchemaBlock[];
    if (blocks.length === 0) {
      return NextResponse.json(
        { error: "not found" },
        { status: 404, headers: HEADERS }
      );
    }

    void logCrawl(req, site.id, slug, "schema_page");

    // Case A — _sitewide
    if (decodedPage === "_sitewide") {
      const sitewideBlocks = blocks.filter(
        (b) => b.type !== "RobotsTxt" && isSitewideBlock(b)
      );
      return NextResponse.json(
        {
          page: "_sitewide",
          blocks: sitewideBlocks,
          scriptTag: buildScriptTag(sitewideBlocks),
        },
        { headers: HEADERS }
      );
    }

    // Case B — _all (grouped)
    if (decodedPage === "_all") {
      const format = req.nextUrl.searchParams.get("format");
      if (format === "grouped") {
        const grouped = groupSchemaBlocks(blocks);
        return NextResponse.json(grouped, { headers: HEADERS });
      }
      // No format or unknown format — return flat array (backward compat)
      const filtered = blocks.filter((b) => b.type !== "RobotsTxt");
      return NextResponse.json(filtered, { headers: HEADERS });
    }

    // Case C — specific page
    const requestPath =
      decodedPage.startsWith("/") ? decodedPage : "/" + decodedPage;
    const { pageBlocks, sitewideBlocks } = filterBlocksForPage(
      blocks,
      requestPath
    );
    const allMatched = [...pageBlocks, ...sitewideBlocks];

    return NextResponse.json(
      {
        page: `https://${site.domain}/${decodedPage}`,
        blocks: pageBlocks,
        sitewide: sitewideBlocks,
        scriptTag: buildScriptTag(allMatched),
      },
      { headers: HEADERS }
    );
  } catch (err) {
    console.error("GET serve schema/[page] error:", err);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
