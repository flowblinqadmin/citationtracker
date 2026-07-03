// Supabase Edge Function — GET /functions/v1/track-slug/<slug>
//
// Ports app/api/t/[slug]/route.ts. Critical changes vs the Next.js version:
//
//   1. Hardcoded `https://geo.flowblinq.com/api/t/collect` REMOVED. The
//      beacon JS now reads from `Deno.env.get("PUBLIC_COLLECT_URL")` so the
//      emitted script points at the Supabase function. Without this fix the
//      migration is a no-op — visitors keep beaconing to the Vercel route.
//   2. NEW rate limit at `slug-serve:<ip>` (100/min). The Next.js route had
//      no rate limit on this path; reviewer-flagged gap. Distinct namespace
//      from `beacon:<ip>` so the two limits don't cross-DoS each other.
//   3. Malicious-UA block via _shared/ua-block.ts. middleware.ts does NOT
//      run for Supabase Edge — the UA check must live in the handler.
//   4. PIXEL_GIF: Node `Buffer.from(b64, "base64")` swapped for
//      `Uint8Array.from(atob(b64), c => c.charCodeAt(0))`.
//   5. Slug extraction: Supabase Edge routes /functions/v1/track-slug/<slug>
//      — handler parses pathname directly (no Next.js `params` injection).
//   6. Geo enrichment via enrichGeo() instead of Vercel headers; ipHash via
//      hashIp() (ES-090 §b.1 COMP-2).
//
// All other behavior preserved 1:1: bot path serves schema-injection JS,
// img-pixel path returns 1x1 GIF + logs pageview, human path returns the
// beacon JS loader.

import { nanoid } from "npm:nanoid@5.1.11";
import { db } from "../_shared/db.ts";
import { geoPageViews } from "../_shared/schema.ts";
import { parseBotName } from "../_shared/bot-parser.ts";
import { resolveSiteForServing } from "../_shared/serve-lookup.ts";
import { logCrawl } from "../_shared/log-crawl.ts";
import { buildSchemaInjectionJs } from "../_shared/schema-js-builder.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rate-limit.ts";
import { isBlockedUA } from "../_shared/ua-block.ts";
import { hashIp } from "../_shared/ip-hash.ts";
import { enrichGeo } from "../_shared/geo-enrich.ts";

// 1x1 transparent GIF (43 bytes). Deno-compatible — no Node Buffer.
const PIXEL_GIF_B64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const PIXEL_GIF = Uint8Array.from(
  atob(PIXEL_GIF_B64),
  (c) => c.charCodeAt(0),
);

const ALLOW_METHODS = "GET, OPTIONS";

/**
 * Extract the slug from a Supabase Edge request path. The platform routes
 * `/functions/v1/track-slug/<slug>` to this function; we read the last
 * non-empty pathname segment.
 *
 * The URL constructor preserves percent-encoding in pathname segments, so we
 * decodeURIComponent here. Path-encoded `%2F` was already split away (split
 * on raw `/`), so this only restores benign characters like spaces / unicode.
 * Falls back to the raw segment on malformed encoding rather than throwing.
 */
function extractSlug(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  const raw = parts[parts.length - 1] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(req, ALLOW_METHODS),
    });
  }

  if (req.method !== "GET") {
    return new Response(null, {
      status: 405,
      headers: { ...corsHeaders(req, ALLOW_METHODS), Allow: ALLOW_METHODS },
    });
  }

  const ua = req.headers.get("user-agent") ?? "";
  const accept = req.headers.get("accept") ?? "";
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";

  // Malicious-UA block — handled before any DB work to short-circuit cost
  if (isBlockedUA(ua)) {
    console.warn(`[track-slug] blocked malicious UA ip=${ip}`);
    return new Response(null, {
      status: 403,
      headers: corsHeaders(req, ALLOW_METHODS),
    });
  }

  // Rate limit — namespaced `slug-serve:` so it cannot collide with collect's
  // `beacon:` namespace. The verify harness depends on this exact literal.
  const rl = await checkRateLimit(`slug-serve:${ip}`, 100, 60_000);
  if (!rl.allowed) {
    return new Response(null, {
      status: 429,
      headers: corsHeaders(req, ALLOW_METHODS),
    });
  }

  const url = new URL(req.url);
  const slug = extractSlug(url.pathname);

  if (!slug) {
    return new Response("missing slug", {
      status: 400,
      headers: corsHeaders(req, ALLOW_METHODS),
    });
  }

  // ── Img pixel path: <img> tag requests image/* ─────────────────────────
  if (accept.includes("image/")) {
    const rawReferrer = req.headers.get("referer") ?? "unknown";
    const pageUrl = rawReferrer.includes("/_next/")
      ? null
      : rawReferrer.slice(0, 2048);

    const [geo, ipHash] = await Promise.all([
      enrichGeo(ip === "unknown" ? null : ip),
      hashIp(ip === "unknown" ? null : ip),
    ]);
    const country =
      req.headers.get("cf-ipcountry") ??
      req.headers.get("x-vercel-ip-country") ??
      geo?.country ??
      null;

    const row = {
      id: nanoid(),
      slug,
      pageUrl: pageUrl ?? "unknown",
      referrer: null,
      userAgent: ua,
      botName: parseBotName(ua),
      ip,
      ipHash,
      country,
      screenWidth: null,
      viewedAt: new Date(),
      sessionId: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      city: geo?.city ? geo.city.slice(0, 100) : null,
      region: geo?.region ? geo.region.slice(0, 20) : null,
      type: "pageview" as const,
    };
    try {
      await db.insert(geoPageViews).values(row);
    } catch {
      try {
        await db.insert(geoPageViews).values({ ...row, id: nanoid() });
      } catch (err) {
        console.error("img pixel insert error (retry failed):", err);
      }
    }

    return new Response(PIXEL_GIF, {
      status: 200,
      headers: {
        "Content-Type": "image/gif",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        ...corsHeaders(req, ALLOW_METHODS),
      },
    });
  }

  const botName = parseBotName(ua);
  const isBot = botName !== "unknown";

  if (isBot) {
    // ── Bot path: serve schema injection JS ───────────────────────────────
    try {
      const site = await resolveSiteForServing(slug, "generatedSchemaBlocks");

      if (site?.generatedSchemaBlocks) {
        const ipHashForLog = await hashIp(ip === "unknown" ? null : ip);
        const geoForLog = await enrichGeo(ip === "unknown" ? null : ip);
        void logCrawl({
          req,
          pathname: url.pathname,
          siteId: site.id,
          slug,
          fileType: "schema_js",
          ip,
          ipHash: ipHashForLog,
          country: geoForLog?.country ?? null,
        });

        const blocks = site.generatedSchemaBlocks as Array<{
          type?: string;
          pageTarget?: string;
          jsonLd: Record<string, unknown>;
        }>;

        const js = buildSchemaInjectionJs(blocks);

        return new Response(js, {
          status: 200,
          headers: {
            "Content-Type": "application/javascript",
            "Cache-Control": "public, max-age=3600",
            Vary: "User-Agent",
            ...corsHeaders(req, ALLOW_METHODS),
            "X-Generated-By": "FlowBlinq GEO Platform",
          },
        });
      }
    } catch (err) {
      console.error("GET /track-slug bot path error:", err);
    }
    // Bot with no schema blocks → fall through to beacon JS
  }

  // ── Human path (or bot fallback): beacon JS ─────────────────────────────
  const deployId = url.searchParams.get("v") || "";
  const collectUrl = Deno.env.get("PUBLIC_COLLECT_URL");
  if (!collectUrl) {
    console.error(
      "[track-slug] PUBLIC_COLLECT_URL is not set — emitted beacon JS would 404. Set the secret before deploy.",
    );
    return new Response(null, {
      status: 500,
      headers: corsHeaders(req, ALLOW_METHODS),
    });
  }

  // Parse sample-rate from the loader URL. `?sample=0.5` means 50% of
  // pageview events get dropped at the client. Event/engagement types are
  // never sampled (low volume, high signal). Falls back to 1.0 (full
  // sampling) on missing or malformed values. Clamped to [0, 1].
  const sampleRaw = url.searchParams.get("sample");
  let sampleRate = 1.0;
  if (sampleRaw != null) {
    const parsed = Number(sampleRaw);
    if (Number.isFinite(parsed)) {
      sampleRate = Math.max(0, Math.min(1, parsed));
    }
  }

  // Batched + sampled emitter. Design notes:
  //   q  — in-closure queue (NOT window-global; closure scoped)
  //   sr — sample rate baked at emit time
  //   bs — batch-size hard cap (matches server MAX_BATCH_SIZE = 20)
  //   tm — pending flush timer id (cleared on flush so no leak on SPA churn)
  //   enq() — push + maybe-flush; pageview type applies sample at enqueue
  //   flush() — drain q, JSON.stringify as array, send via sendBeacon or fetch
  //   flushes: 5s debounce after first enqueue, visibilitychange (hidden),
  //   beforeunload, hard cap when q.length >= bs
  // No setTimeout that isn't cleared. No Promises/async. No XHR.
  const js = `(function(){try{if(window!==window.top)return}catch(e){return}var s=${
    JSON.stringify(slug)
  },v=${JSON.stringify(deployId)},e=${
    JSON.stringify(collectUrl)
  },sr=${sampleRate},bs=20,q=[],tm=null;function gc(n){try{var m=document.cookie.match(new RegExp("(?:^|;\\s*)"+n+"=([^;]*)"));return m?decodeURIComponent(m[1]):""}catch(e){return""}}function gs(){try{var k='_geo_sid',w=sessionStorage.getItem(k);if(!w){w=Math.random().toString(36).slice(2)+Date.now().toString(36);sessionStorage.setItem(k,w)}return w}catch(e){return''}}function pp(){return location.pathname+location.search}function flush(){if(tm){clearTimeout(tm);tm=null}if(!q.length)return;var batch=q.splice(0,q.length);var b=JSON.stringify(batch);if(navigator.sendBeacon){navigator.sendBeacon(e,new Blob([b],{type:"text/plain"}))}else{try{fetch(e,{method:"POST",body:b,headers:{"Content-Type":"text/plain"},keepalive:true})}catch(x){}}}function enq(d){if(d.type==null||d.type==="pageview"){if(Math.random()>sr)return}q.push(d);if(q.length>=bs){flush();return}if(!tm){tm=setTimeout(flush,5000)}}function pv(){enq({s:s,u:location.href,r:document.referrer,sr:gc("_geo_ref"),vid:gc("_geo_vid"),w:screen.width,v:v,sid:gs(),type:"pageview"})}function start(){pv();var t=Date.now();document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden'){enq({s:s,u:location.href,sid:gs(),tms:Date.now()-t,type:'engagement'});flush()}});window.addEventListener('beforeunload',flush);var l=pp();var p=history.pushState;history.pushState=function(){p.apply(this,arguments);var np=pp();if(np!==l){l=np;t=Date.now();pv()}};window.addEventListener("popstate",function(){var np=pp();if(np!==l){l=np;t=Date.now();pv()}})}if(document.prerendering){document.addEventListener('prerenderingchange',start,{once:true})}else{start()}})();`;

  return new Response(js, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "public, max-age=86400",
      Vary: "User-Agent",
      ...corsHeaders(req, ALLOW_METHODS),
    },
  });
}

Deno.serve(handler);
