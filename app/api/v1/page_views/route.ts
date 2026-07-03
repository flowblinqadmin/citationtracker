// GET /api/v1/page_views — filtered, paginated read-only endpoint for external
// analytics pipelines (see TS-087 + ES-087).

import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiClients, geoPageViews, geoSites } from "@/lib/db/schema";
import { verifyApiToken, requireScope, type ApiTokenPayload } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { encodeCursor, decodeCursor } from "@/lib/cursor";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 1000;
const RATE_LIMIT_PER_HOUR = 120;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_WINDOW_HOURS = 72;
const BAD_REQUEST_BLOCK_THRESHOLD = 20;

function errJson(error: string, status: number, extraHeaders?: Record<string, string>) {
  return NextResponse.json({ error }, { status, headers: extraHeaders });
}

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const domain = url.searchParams.get("domain");
  const cursorParam = url.searchParams.get("cursor");
  const sinceParam = url.searchParams.get("since");
  const limitParam = url.searchParams.get("limit");

  // [1] Bearer presence
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return errJson("missing_token", 401);
  }
  const bearer = authHeader.slice(7);

  // [2] JWT verify (stateless)
  let token: ApiTokenPayload;
  try {
    token = await verifyApiToken(bearer);
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === "ERR_JWT_EXPIRED") return errJson("token_expired", 401);
    return errJson("malformed_token", 401);
  }

  // [3] Rate limit (per client_id)
  const rl = await checkRateLimit(`pageviews:${token.sub}`, RATE_LIMIT_PER_HOUR, RATE_LIMIT_WINDOW_MS);
  if (!rl.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return errJson("rate_limit_exceeded", 429, { "Retry-After": String(retryAfterSec) });
  }

  // [4] Fetch api_client row for revocation/block check (stateless JWT doesn't carry these)
  const [client] = await db
    .select({
      id: apiClients.id,
      clientId: apiClients.clientId,
      teamId: apiClients.teamId,
      revokedAt: apiClients.revokedAt,
      blockedAt: apiClients.blockedAt,
      consecutiveBadRequests: apiClients.consecutiveBadRequests,
    })
    .from(apiClients)
    .where(eq(apiClients.clientId, token.sub));

  if (!client || client.revokedAt) return errJson("client_revoked", 401);
  if (client.blockedAt) return errJson("client_blocked", 401);

  // [5] Scope
  try {
    requireScope(token.scopes, "pageviews:read");
  } catch {
    return errJson("insufficient_scope", 403);
  }

  // Helper: increment consecutive-bad counter; auto-block on 21st.
  async function recordBad() {
    const [updated] = await db
      .update(apiClients)
      .set({
        consecutiveBadRequests: sql`${apiClients.consecutiveBadRequests} + 1`,
        blockedAt: sql`CASE
          WHEN ${apiClients.consecutiveBadRequests} + 1 > ${BAD_REQUEST_BLOCK_THRESHOLD}
            AND ${apiClients.blockedAt} IS NULL
          THEN NOW()
          ELSE ${apiClients.blockedAt}
        END`,
      })
      .where(eq(apiClients.id, client.id))
      .returning({
        consecutive: apiClients.consecutiveBadRequests,
        blockedAt: apiClients.blockedAt,
      });

    if (updated?.blockedAt && !client.blockedAt) {
      console.warn(JSON.stringify({
        event: "page_views.client_blocked",
        client_id: client.clientId,
        team_id: client.teamId,
        consecutive_bad_requests: updated.consecutive,
      }));
    }
  }

  // Helper: reset counter on success (short-circuits if already 0).
  async function recordOk() {
    if (client.consecutiveBadRequests > 0) {
      await db
        .update(apiClients)
        .set({ consecutiveBadRequests: 0 })
        .where(and(eq(apiClients.id, client.id), gt(apiClients.consecutiveBadRequests, 0)));
    }
  }

  function deny(error: string, status: number) {
    void recordBad();
    return errJson(error, status);
  }

  // [6] Param validation (all 400s → counter++)
  if (!domain) return deny("missing_domain", 400);
  if (cursorParam && sinceParam) return deny("conflicting_params", 400);

  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      return deny("bad_limit", 400);
    }
    limit = n;
  }

  let sinceTs: Date;
  let sinceId = "";
  let seedMode: "cursor" | "since" | "default_72h";
  if (cursorParam) {
    try {
      const c = decodeCursor(cursorParam);
      sinceTs = new Date(c.viewed_at);
      sinceId = c.id;
      seedMode = "cursor";
    } catch {
      return deny("bad_cursor", 400);
    }
  } else if (sinceParam) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/.test(sinceParam)) {
      return deny("bad_since", 400);
    }
    const n = Date.parse(sinceParam);
    if (Number.isNaN(n)) return deny("bad_since", 400);
    sinceTs = new Date(n);
    seedMode = "since";
  } else {
    sinceTs = new Date(Date.now() - DEFAULT_WINDOW_HOURS * 60 * 60 * 1000);
    seedMode = "default_72h";
  }

  // [7] Domain → slug (team-scoped). 404 is NOT a bad request (client supplied a valid shape).
  const [site] = await db
    .select({ slug: geoSites.slug })
    .from(geoSites)
    .where(and(eq(geoSites.teamId, token.team_id), eq(geoSites.domain, domain)));

  if (!site) return errJson("domain_not_found", 404);

  // [8] Query rows. Compound cursor: (viewed_at, id) > (since_ts, since_id).
  // NO bot_name filter — all classes are returned; bot_name is exposed to the
  // consumer so downstream sinks can route per-class. Flowblinq's product value
  // depends on LLM / bot visibility; filtering here would silently drop it.
  const q0 = Date.now();
  const rows = await db
    .select({
      id: geoPageViews.id,
      page_url: geoPageViews.pageUrl,
      referrer: geoPageViews.referrer,
      visitor_id: geoPageViews.visitorId,
      user_agent: geoPageViews.userAgent,
      bot_name: geoPageViews.botName,
      ip: geoPageViews.ip,
      country: geoPageViews.country,
      screen_width: geoPageViews.screenWidth,
      viewed_at: geoPageViews.viewedAt,
      type: geoPageViews.type,
      time_on_page_ms: geoPageViews.timeOnPageMs,
      session_id: geoPageViews.sessionId,
    })
    .from(geoPageViews)
    .where(and(
      eq(geoPageViews.slug, site.slug),
      // NOTE: no host-match filter. Slug is the binding; a row exists in
      // geo_page_views only because the tracker was served for that slug.
      // Anti-spoof (if ever needed) belongs at ingestion time (Referer check
      // in /api/t/<slug>), not at read time. See TS-087 §4 "Threat model".
      or(
        gt(geoPageViews.viewedAt, sinceTs),
        and(eq(geoPageViews.viewedAt, sinceTs), gt(geoPageViews.id, sinceId)),
      ),
    ))
    .orderBy(asc(geoPageViews.viewedAt), asc(geoPageViews.id))
    .limit(limit + 1);
  const queryMs = Date.now() - q0;

  const hasMore = rows.length > limit;
  const returnedRows = hasMore ? rows.slice(0, limit) : rows;
  const last = returnedRows[returnedRows.length - 1];

  const responseRows = returnedRows.map((r) => ({
    id: r.id,
    page_url: r.page_url,
    referrer: r.referrer ?? "",
    visitor_id: r.visitor_id ?? "",
    user_agent: r.user_agent ?? "",
    bot_name: r.bot_name ?? "visitor",
    ip: r.ip ?? "",
    country: r.country ?? "",
    screen_width: r.screen_width ?? 0,
    viewed_at: (r.viewed_at instanceof Date ? r.viewed_at : new Date(r.viewed_at as unknown as string)).toISOString(),
    type: r.type ?? "pageview",
    time_on_page_ms: r.time_on_page_ms ?? 0,
    session_id: r.session_id ?? "",
  }));

  const nextCursor = hasMore && last
    ? encodeCursor({
        viewed_at: (last.viewed_at instanceof Date ? last.viewed_at : new Date(last.viewed_at as unknown as string)).toISOString(),
        id: last.id,
      })
    : null;

  void recordOk();

  console.log(JSON.stringify({
    event: "page_views.served",
    client_id: client.clientId,
    team_id: client.teamId,
    domain,
    slug: site.slug,
    rows_count: returnedRows.length,
    has_more: hasMore,
    seed_mode: seedMode,
    limit_requested: limit,
    limit_effective: returnedRows.length,
    query_ms: queryMs,
    total_ms: Date.now() - t0,
  }));

  return NextResponse.json({
    domain,
    slug_resolved: site.slug,
    served_ts: new Date().toISOString(),
    rows: responseRows,
    has_more: hasMore,
    next_cursor: nextCursor,
  }, { status: 200 });
}
