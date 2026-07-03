import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { proxyFetch } from "@/lib/proxy-fetch";

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

    const { domain, slug } = site;
    const targetUrl = `https://${domain}/llms.txt`;

    const result = await proxyFetch(targetUrl, { method: "GET" });

    let connected = false;
    let detail: string;

    if (result === null) {
      // All proxy tiers failed — can't reach the site at all
      detail = `We couldn't reach ${domain}/llms.txt through any of our verification methods. This usually means your site has strict bot protection. If you've completed the setup steps, your connection is likely working — real AI crawlers (ChatGPT, Perplexity) use different IPs that aren't affected by this. Try triggering a new audit to confirm.`;
    } else if (!result.ok) {
      // ES-082 §b.7 — 503 branch MUST come before 404/429/403/generic.
      // The serve route now returns 503 when the row exists with empty
      // generatedLlmsTxt (Manipal-class generation failure). The customer's
      // proxy is correctly forwarding our response — the issue is upstream
      // generation, not their setup.
      if (result.status === 503) {
        detail = `Your site is correctly proxying to our serve URL, but our generated llms.txt file is currently empty for this site. Please re-run the audit from your dashboard. (We're aware of this and tracking it as a generation issue, not a setup issue on your end.)`;
      } else if (result.status === 404) {
        detail = `Your site returned a 404 for /llms.txt — the rewrite rule isn't installed yet. Double-check your vercel.json (or equivalent) has the rewrite from /llms.txt to the FlowBlinq serve URL, then redeploy.`;
      } else if (result.status === 429 || result.status === 403) {
        detail = `Your site is blocking all automated requests to /llms.txt (HTTP ${result.status}). Check that your CDN or WAF isn't blocking AI crawler bots. Real AI crawlers like GPTBot and ClaudeBot need to reach this file.`;
      } else {
        detail = `Got HTTP ${result.status} from ${domain}/llms.txt (checked via ${result.method}). Check your rewrite configuration and make sure the file is being served correctly.`;
      }
    } else {
      // Got a 200 — check it's a valid llms.txt (starts with # heading, has ## sections)
      const body = result.body ?? "";
      const hasLlmsFormat = body.startsWith("# ") && body.includes("## ");

      if (hasLlmsFormat) {
        connected = true;
        detail = `Connected — llms.txt confirmed at ${domain}/llms.txt (verified via ${result.method})`;
      } else {
        detail = `Found a file at /llms.txt but it doesn't look like a valid llms.txt. You may have an existing file overriding the FlowBlinq rewrite. Remove or rename it, then redeploy.`;
      }
    }

    return NextResponse.json({ connected, detail });
  } catch (err) {
    console.error("POST /api/sites/[id]/verify-connection error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
