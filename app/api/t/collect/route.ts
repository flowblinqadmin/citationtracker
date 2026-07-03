import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { parseBotName } from "@/lib/bot-parser";
import { corsHeaders } from "@/lib/cors";
import { hashIp, collectPageviewEdge } from "@/lib/supabase-edge";

export const runtime = "edge";

// ── CORS ─────────────────────────────────────────────────────────────────────
// Beacons are sent cred-less by default. Marketing-site origins are
// allow-listed for credential mode (fetch({ credentials: 'include' })).
// See lib/cors.ts for the allowlist.

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req, "POST, OPTIONS", { allowAll: true }),
  });
}

// ── Beacon collection ────────────────────────────────────────────────────────

interface BeaconPayload {
  s: string;    // slug
  u: string;    // page URL
  r?: string;   // referrer (document.referrer — stripped by noreferrer)
  sr?: string;  // server referrer (from _geo_ref cookie — survives noreferrer)
  vid?: string; // persistent visitor ID (from _geo_vid cookie — cross-page tracking)
  w?: number;   // screen width
  v?: string;   // website deploy ID (NEXT_PUBLIC_VERCEL_DEPLOYMENT_ID)
  // New analytics fields
  sid?: string;                      // session ID (sessionStorage)
  tms?: number;                      // time on page in milliseconds
  type?: string;                     // 'pageview' | 'event'
  event_name?: string;               // custom event name
  props?: Record<string, unknown>;   // custom event properties
}

export async function POST(req: NextRequest) {
  try {
    // Fail-closed config gate. ES-090 §b.1 COMP-2 requires ip_hash on every
    // row; SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL are required
    // for the insert itself. If any are missing on this deployment we 503
    // every request instead of silently dropping data with NULL ip_hash.
    if (
      !process.env.IP_HASH_SECRET ||
      !process.env.NEXT_PUBLIC_SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY
    ) {
      console.error(
        "[track-collect] missing required env config; refusing to serve",
      );
      return new NextResponse(null, { status: 503, headers: corsHeaders(req, "POST, OPTIONS", { allowAll: true }) });
    }

    // Body size guard — reject oversized payloads before parsing
    const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
    if (contentLength > 8192) {
      return new NextResponse(null, { status: 413, headers: corsHeaders(req, "POST, OPTIONS", { allowAll: true }) });
    }

    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";

    const body = (await req.json()) as BeaconPayload;

    if (!body.s || !body.u) {
      return new NextResponse(null, { status: 400, headers: corsHeaders(req, "POST, OPTIONS", { allowAll: true }) });
    }

    const ua = req.headers.get("user-agent");
    const country =
      req.headers.get("cf-ipcountry") ??
      req.headers.get("x-vercel-ip-country") ??
      null;

    // Truncate string fields before insert
    const sid = typeof body.sid === "string" ? body.sid.slice(0, 128) : null;
    const eventName = typeof body.event_name === "string" ? body.event_name.slice(0, 100) : null;
    const pageUrl = typeof body.u === "string" ? body.u.slice(0, 2048) : body.u;
    const rawRef = typeof (body.sr || body.r) === "string"
      ? (body.sr || body.r)!.slice(0, 2048)
      : (body.sr || body.r);

    // Extract UTM params from page URL
    let utmSource: string | null = null;
    let utmMedium: string | null = null;
    let utmCampaign: string | null = null;
    try {
      const parsedUrl = new URL(pageUrl);
      utmSource = parsedUrl.searchParams.get("utm_source");
      utmMedium = parsedUrl.searchParams.get("utm_medium");
      utmCampaign = parsedUrl.searchParams.get("utm_campaign");
    } catch {
      // Invalid URL — leave UTM fields null
    }

    // Geo enrichment from Vercel headers — Edge runtime injects these
    // natively on every request, so 100% geo coverage is preserved.
    const city = (req.headers.get("x-vercel-ip-city") ?? null)?.slice(0, 100) ?? null;
    const region = (req.headers.get("x-vercel-ip-region-code") ?? null)?.slice(0, 20) ?? null;

    // Filter referrers from Next.js internals (/_next/ paths)
    const referrer = rawRef?.includes("/_next/") ? null : rawRef ?? null;

    // Validate type field to enum
    const type = body.type === "event" ? "event" : "pageview";

    // Validate eventProps — flat object, max 50 scalar keys
    const SCALAR = ["string", "number", "boolean"];
    let eventProps: Record<string, unknown> | null = null;
    if (
      body.props !== null &&
      typeof body.props === "object" &&
      !Array.isArray(body.props)
    ) {
      const isFlat =
        Object.keys(body.props).length <= 50 &&
        Object.values(body.props).every(
          (v) => v === null || SCALAR.includes(typeof v)
        );
      eventProps = isFlat ? body.props : null;
    }

    // HMAC-SHA256(ip) — closes ES-090 §b.1 COMP-2 (dormant column today).
    const ipHash = await hashIp(ip);

    // supabase-js takes snake_case column names natively. Row keys must
    // match geo_page_views columns in lib/db/schema.ts.
    const row = {
      id: nanoid(),
      slug: body.s,
      page_url: pageUrl,
      referrer,
      visitor_id: body.vid || null,
      user_agent: ua,
      bot_name: parseBotName(ua),
      ip,
      ip_hash: ipHash,
      country,
      screen_width: typeof body.w === "number" ? body.w : null,
      website_deploy_id: body.v || null,
      viewed_at: new Date().toISOString(),
      // New analytics fields
      utm_source: utmSource,
      utm_medium: utmMedium,
      utm_campaign: utmCampaign,
      city,
      region,
      session_id: sid,
      time_on_page_ms: typeof body.tms === "number" ? body.tms : null,
      type,
      event_name: eventName,
      event_props: eventProps,
    };

    // Single HTTPS round-trip: atomic rate-limit + insert via the
    // collect_pageview Postgres function. Replaces the prior two-call pattern
    // (check_rate_limit RPC + .from(...).insert(...)) — measurable Edge CPU
    // win at sustained beacon volume.
    const result = await collectPageviewEdge(`beacon:${ip}`, 100, 60_000, row);
    if (!result.allowed) {
      return new NextResponse(null, { status: 429, headers: corsHeaders(req, "POST, OPTIONS", { allowAll: true }) });
    }
    if (!result.inserted) {
      console.error("[track-collect] pageview insert did not land");
    }

    return new NextResponse(null, { status: 204, headers: corsHeaders(req, "POST, OPTIONS", { allowAll: true }) });
  } catch (err) {
    console.error("POST /api/t/collect error:", err);
    return new NextResponse(null, { status: 204, headers: corsHeaders(req, "POST, OPTIONS", { allowAll: true }) });
  }
}
