// Supabase Edge Function — POST /functions/v1/track-collect
//
// Ports app/api/t/collect/route.ts. Substitutions per plan:
//   - NextRequest/NextResponse → Web Request/Response
//   - `@/lib/...` → relative `../_shared/*.ts`
//   - `process.env` → not used (this handler reads no env directly; _shared/db
//     pulls SUPABASE_DB_URL)
//   - nanoid via npm: specifier
//   - Geo enrichment via enrichGeo() (Vercel/CF headers don't exist here);
//     header reads kept as fallback so a downstream proxy that does inject
//     them still works.
//   - ipHash via hashIp() — closes ES-090 §b.1 COMP-2 (column existed but
//     was never written by the Next.js route).
//
// Security controls preserved 1:1: body cap 8KB, field truncation, flat
// `props` guard, type-enum coercion, UTM try/catch, per-IP DB rate limit at
// key `beacon:<ip>` (literal — the _verify harness greps for this exact
// string), CORS via corsHeaders().
//
// Method restriction: only POST and OPTIONS. Anything else → 405. This is a
// new control vs the Next.js route which let the framework return 405; the
// Deno handler must do it explicitly.
//
// UA blocking: per plan, track-collect does NOT 403 on malicious UA. Only
// track-slug enforces ua-block. Reason: collect already has body cap + rate
// limit + flat-object guard; UA-blocking it would silently drop legitimate
// custom-tracker traffic.
//
// ── Batched payloads (task #5) ─────────────────────────────────────────────
// The handler also accepts an ARRAY of beacon objects:
//   [{ s, u, ... }, { s, u, ... }, ...]
// Caps:
//   - array length ≤ 20 (anything larger → 400 before per-row work)
//   - empty array → 400 (nothing to validate; client bug)
// Strict per-row validation: if any row is missing `s`/`u`, the whole batch
// is rejected (400). Single bad row poisons the batch — matches how the
// single-object path already rejects on `!body.s || !body.u`.
// Per-row independence: each row gets its own ipHash (NOT shared) and its
// own UTM parse (a malformed `u` in one row doesn't poison another's UTMs).
// Rate limit is once per REQUEST, not per row. A 20-beacon batch counts as
// one hit against `beacon:<ip>` — that's the whole point of batching.
// DB write uses a single bulk `db.insert(...).values(rows)` call.

import { nanoid } from "npm:nanoid@5.1.11";
import { db } from "../_shared/db.ts";
import { geoPageViews } from "../_shared/schema.ts";
import { parseBotName } from "../_shared/bot-parser.ts";
import { checkRateLimit } from "../_shared/rate-limit.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { hashIp } from "../_shared/ip-hash.ts";
import { enrichGeo } from "../_shared/geo-enrich.ts";

interface BeaconPayload {
  s: string;
  u: string;
  r?: string;
  sr?: string;
  vid?: string;
  w?: number;
  v?: string;
  sid?: string;
  tms?: number;
  type?: string;
  event_name?: string;
  props?: Record<string, unknown>;
}

const ALLOW_METHODS = "POST, OPTIONS";
const MAX_BATCH_SIZE = 20;

interface BuiltRow {
  id: string;
  slug: string;
  pageUrl: string;
  referrer: string | null;
  visitorId: string | null;
  userAgent: string | null;
  botName: string;
  ip: string;
  ipHash: string | null;
  country: string | null;
  screenWidth: number | null;
  websiteDeployId: string | null;
  viewedAt: Date;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  city: string | null;
  region: string | null;
  sessionId: string | null;
  timeOnPageMs: number | null;
  type: string;
  eventName: string | null;
  eventProps: Record<string, unknown> | null;
}

interface RequestCtx {
  ip: string;
  ua: string | null;
  cfCountry: string | null;
  vercelCountry: string | null;
  vercelCity: string | null;
  vercelRegion: string | null;
}

/**
 * Build one DB row from a single beacon payload. All per-row controls
 * (truncation, flat-object guard, type enum, UTM try/catch) apply here.
 * Per-row independence: each call computes its own ipHash and geo lookup so
 * a malformed entry in a batch can't corrupt its neighbours.
 */
async function buildRow(
  body: BeaconPayload,
  ctx: RequestCtx,
): Promise<BuiltRow> {
  const [geo, ipHash] = await Promise.all([
    enrichGeo(ctx.ip === "unknown" ? null : ctx.ip),
    hashIp(ctx.ip === "unknown" ? null : ctx.ip),
  ]);
  const country = ctx.cfCountry ?? ctx.vercelCountry ?? geo?.country ?? null;
  const cityRaw = ctx.vercelCity ?? geo?.city ?? null;
  const regionRaw = ctx.vercelRegion ?? geo?.region ?? null;
  const city = cityRaw ? cityRaw.slice(0, 100) : null;
  const region = regionRaw ? regionRaw.slice(0, 20) : null;

  const sid = typeof body.sid === "string" ? body.sid.slice(0, 128) : null;
  const eventName = typeof body.event_name === "string"
    ? body.event_name.slice(0, 100)
    : null;
  const pageUrl = typeof body.u === "string" ? body.u.slice(0, 2048) : body.u;
  const rawRef = typeof (body.sr || body.r) === "string"
    ? (body.sr || body.r)!.slice(0, 2048)
    : (body.sr || body.r);

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

  const referrer = rawRef?.includes("/_next/") ? null : rawRef ?? null;
  const type = body.type === "event" ? "event" : "pageview";

  const SCALAR = ["string", "number", "boolean"];
  let eventProps: Record<string, unknown> | null = null;
  if (
    body.props !== null &&
    body.props !== undefined &&
    typeof body.props === "object" &&
    !Array.isArray(body.props)
  ) {
    const isFlat = Object.keys(body.props).length <= 50 &&
      Object.values(body.props).every(
        (v) => v === null || SCALAR.includes(typeof v),
      );
    eventProps = isFlat ? (body.props as Record<string, unknown>) : null;
  }

  return {
    id: nanoid(),
    slug: body.s,
    pageUrl,
    referrer,
    visitorId: body.vid || null,
    userAgent: ctx.ua,
    botName: parseBotName(ctx.ua),
    ip: ctx.ip,
    ipHash,
    country,
    screenWidth: typeof body.w === "number" ? body.w : null,
    websiteDeployId: body.v || null,
    viewedAt: new Date(),
    utmSource,
    utmMedium,
    utmCampaign,
    city,
    region,
    sessionId: sid,
    timeOnPageMs: typeof body.tms === "number" ? body.tms : null,
    type,
    eventName,
    eventProps,
  };
}

export async function handler(req: Request): Promise<Response> {
  // OPTIONS preflight — short-circuit before any DB work
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(req, ALLOW_METHODS),
    });
  }

  // Method restriction — Supabase Edge does not gate the verb for us
  if (req.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { ...corsHeaders(req, ALLOW_METHODS), Allow: ALLOW_METHODS },
    });
  }

  try {
    // Body size guard — reject oversized payloads before parsing
    const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
    if (contentLength > 8192) {
      return new Response(null, {
        status: 413,
        headers: corsHeaders(req, ALLOW_METHODS),
      });
    }

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";

    // DB-backed rate limiter — key MUST be exactly `beacon:<ip>` so the
    // verify harness's grep at supabase/functions/_verify/checks/15-* matches.
    // Once per request, not per row — a batch of 20 counts as 1 hit.
    const rl = await checkRateLimit(`beacon:${ip}`, 100, 60_000);
    if (!rl.allowed) {
      return new Response(null, {
        status: 429,
        headers: corsHeaders(req, ALLOW_METHODS),
      });
    }

    // Tolerant JSON parse — malformed bodies fall through to 204 like the
    // Next.js route did (visitors should never see an error).
    let body: BeaconPayload | BeaconPayload[];
    try {
      body = (await req.json()) as BeaconPayload | BeaconPayload[];
    } catch {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(req, ALLOW_METHODS),
      });
    }

    // Normalize to a list. Detect array via Array.isArray (preserves backward
    // compat for the single-object emitter).
    const payloads: BeaconPayload[] = Array.isArray(body) ? body : [body];

    // Batch caps. Empty array is a client bug — nothing to insert.
    if (Array.isArray(body)) {
      if (payloads.length === 0 || payloads.length > MAX_BATCH_SIZE) {
        return new Response(null, {
          status: 400,
          headers: corsHeaders(req, ALLOW_METHODS),
        });
      }
    }

    // Strict per-row required-field validation. One bad entry rejects the
    // whole batch — matches the single-row behaviour where missing s/u → 400.
    for (const p of payloads) {
      if (!p || !p.s || !p.u) {
        return new Response(null, {
          status: 400,
          headers: corsHeaders(req, ALLOW_METHODS),
        });
      }
    }

    const ua = req.headers.get("user-agent");
    const ctx: RequestCtx = {
      ip,
      ua,
      cfCountry: req.headers.get("cf-ipcountry"),
      vercelCountry: req.headers.get("x-vercel-ip-country"),
      vercelCity: req.headers.get("x-vercel-ip-city"),
      vercelRegion: req.headers.get("x-vercel-ip-region-code"),
    };

    // Build rows in parallel — per-row hashIp + enrichGeo are independent.
    const rows: BuiltRow[] = await Promise.all(
      payloads.map((p) => buildRow(p, ctx)),
    );

    try {
      await db.insert(geoPageViews).values(rows);
    } catch {
      // Retry once with fresh ids in case of a (vanishingly rare) collision.
      try {
        const retryRows = rows.map((r) => ({ ...r, id: nanoid() }));
        await db.insert(geoPageViews).values(retryRows);
      } catch (err) {
        console.error("pageview insert error (retry failed):", err);
      }
    }

    return new Response(null, {
      status: 204,
      headers: corsHeaders(req, ALLOW_METHODS),
    });
  } catch (err) {
    console.error("POST /track-collect error:", err);
    return new Response(null, {
      status: 204,
      headers: corsHeaders(req, ALLOW_METHODS),
    });
  }
}

// Entry point — Supabase Edge runtime invokes this.
Deno.serve(handler);
