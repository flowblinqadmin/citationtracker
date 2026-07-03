import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { parseBotName } from "@/lib/bot-parser";
import { buildSchemaInjectionJs } from "@/lib/schema-js-builder";
import { buildBeaconJs } from "@/lib/tracking-beacon";
import { corsHeaders } from "@/lib/cors";
import { supabaseEdge, hashIp } from "@/lib/supabase-edge";
import { getClientIp } from "@/lib/client-ip";

export const runtime = "edge";

// 1x1 transparent GIF (43 bytes). Vercel Edge has no Buffer — decode via
// atob into a Uint8Array, which NextResponse accepts as a body.
const PIXEL_GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0),
);

interface RouteContext {
  params: Promise<{ slug: string }>;
}

/**
 * Edge-compatible site lookup. Mirrors lib/serve-lookup.resolveSiteForServing
 * but uses supabase-js instead of Drizzle. Returns the latest complete-audit
 * row with the requested asset for the slug's domain; falls back to slug
 * prefix matching, then to the exact slug.
 *
 * The `assetField` is the JS-side camelCase name; we map to the DB column
 * name for the supabase-js calls.
 */
async function resolveSiteForServingEdge(
  slug: string,
  assetField: "generatedSchemaBlocks",
): Promise<{ id: string; generatedSchemaBlocks: unknown; domain: string | null } | null> {
  // Map JS field name to DB column name for SELECT + NOT NULL filters
  const dbColumn = assetField === "generatedSchemaBlocks" ? "generated_schema_blocks" : assetField;

  // 1. Look up exact slug to get the domain
  const { data: exact } = await supabaseEdge
    .from("geo_sites")
    .select(`id, domain, ${dbColumn}, pipeline_status, created_at, slug`)
    .eq("slug", slug)
    .maybeSingle();

  const domain = (exact as { domain?: string } | null)?.domain ?? null;

  // 2. If we know the domain, find the latest complete audit with this asset
  if (domain) {
    const { data: latest } = await supabaseEdge
      .from("geo_sites")
      .select(`id, domain, ${dbColumn}`)
      .eq("domain", domain)
      .eq("pipeline_status", "complete")
      .not(dbColumn, "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latest) {
      return {
        id: (latest as { id: string }).id,
        generatedSchemaBlocks: (latest as Record<string, unknown>)[dbColumn],
        domain: (latest as { domain: string }).domain,
      };
    }
  }

  // 3. No exact slug match — try prefix matching (e.g., "flowblinq-com" matches "flowblinq-com-rkjDYU")
  if (!exact) {
    // Escape SQL LIKE wildcards to prevent unintended pattern matching
    const safeSlug = slug.replace(/%/g, "\\%").replace(/_/g, "\\_");
    const { data: latestBySlug } = await supabaseEdge
      .from("geo_sites")
      .select(`id, domain, ${dbColumn}`)
      .like("slug", `${safeSlug}%`)
      .eq("pipeline_status", "complete")
      .not(dbColumn, "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestBySlug) {
      return {
        id: (latestBySlug as { id: string }).id,
        generatedSchemaBlocks: (latestBySlug as Record<string, unknown>)[dbColumn],
        domain: (latestBySlug as { domain: string | null }).domain ?? null,
      };
    }
  }

  // 4. Fall back to exact match (even without asset, for 404 handling)
  if (exact) {
    return {
      id: (exact as { id: string }).id,
      generatedSchemaBlocks: (exact as Record<string, unknown>)[dbColumn],
      domain: (exact as { domain: string | null }).domain ?? null,
    };
  }
  return null;
}

/**
 * Edge-compatible crawl log writer. Mirrors lib/log-crawl.ts logCrawl but
 * uses supabase-js. Fire-and-forget (caller does `void`).
 */
async function logCrawlEdge(
  req: NextRequest,
  siteId: string,
  slug: string,
  fileType: "schema_js",
): Promise<void> {
  const ua = req.headers.get("user-agent");
  const country =
    req.headers.get("cf-ipcountry") ??
    req.headers.get("x-vercel-ip-country") ??
    null;
  // C4: prefer trusted infra-set headers over spoofable x-forwarded-for.
  // cf-connecting-ip is set by Cloudflare on the connection-level peer and
  // cannot be spoofed by the client.
  const cfIp = req.headers.get("cf-connecting-ip");
  const ip = cfIp ?? (getClientIp(req) === "unknown" ? null : getClientIp(req));

  const ipHashValue = await hashIp(ip);

  const row = {
    id: nanoid(),
    site_id: siteId,
    slug,
    file_type: fileType,
    request_path: req.nextUrl.pathname,
    user_agent: ua,
    bot_name: parseBotName(ua),
    ip,
    ip_hash: ipHashValue,
    country,
    requested_at: new Date().toISOString(),
  };

  const { error } = await supabaseEdge.from("geo_crawl_logs").insert(row);
  if (error) {
    const { error: retryErr } = await supabaseEdge
      .from("geo_crawl_logs")
      .insert({ ...row, id: nanoid() });
    if (retryErr) {
      console.error("logCrawl error (retry failed):", retryErr);
    }
  }
}

/**
 * GET /api/t/[slug] — unified tracking + schema serving endpoint.
 *
 * Bot UA → schema injection JS (JSON-LD blocks injected into page)
 * Human UA → tiny beacon JS (~350 bytes, fires pageview to /api/t/collect)
 *
 * Customer adds one tag: <script src="https://geo.flowblinq.com/api/t/SLUG" async></script>
 */
export async function GET(req: NextRequest, { params }: RouteContext) {
  // Fail-closed config gate. Both branches below (img pixel + bot schema)
  // write rows that require ip_hash + supabase-edge config. If any required
  // env var is missing, refuse to serve rather than silently drop ip_hash.
  if (
    !process.env.IP_HASH_SECRET ||
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    console.error("[track-slug] missing required env config; refusing to serve");
    return new NextResponse(null, { status: 503, headers: corsHeaders(req, undefined, { allowAll: true }) });
  }

  const { slug } = await params;

  // Slug is a path-param that gets baked into JS responses + used as a DB
  // filter. Reject anything outside [a-zA-Z0-9_-] or longer than 120 chars
  // to cap the LIKE-query length and prevent garbage from ending up in the
  // emitted JS. Returns 404 to match "slug not found" semantics for callers.
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(slug)) {
    return new NextResponse(null, { status: 404, headers: corsHeaders(req, undefined, { allowAll: true }) });
  }

  const ua = req.headers.get("user-agent") ?? "";
  const accept = req.headers.get("accept") ?? "";

  // ── Img pixel path: <img> tag requests image/* ───────────────────────────
  if (accept.includes("image/")) {
    const rawReferrer = req.headers.get("referer") ?? "unknown";
    // Filter Next.js internals and cap length
    const pageUrl = rawReferrer.includes("/_next/")
      ? null
      : rawReferrer.slice(0, 2048);
    const country =
      req.headers.get("cf-ipcountry") ??
      req.headers.get("x-vercel-ip-country") ??
      null;
    const ip = getClientIp(req);
    const ipHashValue = await hashIp(ip);

    // supabase-js takes snake_case column names natively.
    const row = {
      id: nanoid(),
      slug,
      page_url: pageUrl ?? "unknown",
      referrer: null,
      user_agent: ua,
      bot_name: parseBotName(ua),
      ip,
      ip_hash: ipHashValue,
      country,
      screen_width: null,
      viewed_at: new Date().toISOString(),
      // Fields added to geo_page_views after img pixel was written — supply defaults
      session_id: null,
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      city: null,
      region: null,
      type: "pageview" as const,
    };

    const { error } = await supabaseEdge.from("geo_page_views").insert(row);
    if (error) {
      const { error: retryErr } = await supabaseEdge
        .from("geo_page_views")
        .insert({ ...row, id: nanoid() });
      if (retryErr) {
        console.error("img pixel insert error (retry failed):", retryErr);
      }
    }

    return new NextResponse(PIXEL_GIF, {
      status: 200,
      headers: {
        "Content-Type": "image/gif",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        ...corsHeaders(req, undefined, { allowAll: true }),
      },
    });
  }

  const botName = parseBotName(ua);
  const isBot = botName !== "unknown";

  if (isBot) {
    // ── Bot path: serve schema injection JS ──────────────────────────────────
    try {
      const site = await resolveSiteForServingEdge(slug, "generatedSchemaBlocks");

      if (site?.generatedSchemaBlocks) {
        void logCrawlEdge(req, site.id, slug, "schema_js");

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
            "Vary": "User-Agent",
            ...corsHeaders(req, undefined, { allowAll: true }),
            "X-Generated-By": "FlowBlinq GEO Platform",
          },
        });
      }
    } catch (err) {
      console.error("GET /api/t bot path error:", err);
    }

    // Bot with no schema blocks → fall through to beacon JS
  }

  // ── Human path (or bot fallback): beacon JS ──────────────────────────────
  // Beacon JS lives in lib/tracking-beacon.ts so the code that runs on every
  // customer page is unit-testable + exercisable in the mobile perf harness.
  const deployId = req.nextUrl.searchParams.get("v") || "";
  const js = buildBeaconJs(slug, deployId);

  return new NextResponse(js, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "public, max-age=86400",
      "Vary": "User-Agent",
      ...corsHeaders(req, undefined, { allowAll: true }),
    },
  });
}
