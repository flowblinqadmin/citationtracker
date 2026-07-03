import { NextRequest, NextResponse } from "next/server";
import { resolveSiteForServing } from "@/lib/serve-lookup";
import { logCrawl } from "@/lib/log-crawl";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

const EMPTY_GENERATION_BODY =
  "Generation pending or failed — please re-run the audit from your dashboard.";

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { slug } = await params;

    const site = await resolveSiteForServing(slug, "generatedLlmsFullTxt");

    // ES-082 §b.6 + AC-9 — defensive symmetry with the short serve route.
    // Same 200/404/503 discrimination; currently no full-text empty cases
    // exist but the contract matches.
    if (!site) {
      return new NextResponse("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const value = site.generatedLlmsFullTxt;
    if (value == null) {
      return new NextResponse("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }
    if (value.length === 0) {
      console.warn(JSON.stringify({
        event: "serve_llms_txt_empty_503",
        slug,
        site_id: site.id,
        asset: "llms_full_txt",
      }));
      void logCrawl(req, site.id, slug, "llms_full_txt_empty");
      return new NextResponse(EMPTY_GENERATION_BODY, {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Retry-After": "600",
          "X-Generator": "FlowBlinq GEO",
          "Cache-Control": "no-store",
        },
      });
    }

    void logCrawl(req, site.id, slug, "llms_full_txt");

    return new NextResponse(value, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
        "X-Generator": "FlowBlinq GEO",
      },
    });
  } catch (err) {
    console.error("GET serve llms-full.txt error:", err);
    return new NextResponse("Internal server error", { status: 500 });
  }
}
