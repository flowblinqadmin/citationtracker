/**
 * Edge-runtime-compatible Supabase HTTP client.
 *
 * Vercel Edge has no TCP socket, so the Drizzle/postgres-js client in
 * lib/db/index.ts can't run there. The two high-volume anonymous beacon
 * routes (/api/t/collect, /api/t/[slug]) talk to Postgres via supabase-js
 * over HTTPS instead.
 *
 * This file is the ONLY place SUPABASE_SERVICE_ROLE_KEY is read. Service
 * role is required because the beacon writes happen as anonymous visitors
 * but bypass RLS (geo_page_views and geo_crawl_logs are intentionally
 * service-write-only, audited separately). The Edge function boundary is
 * the trust boundary — the key never leaves the server.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Lazy singleton so module load doesn't throw on missing env (build/tests).
// First runtime call surfaces the misconfig loudly instead.
let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  if (!url || !serviceRoleKey) {
    throw new Error(
      "[supabase-edge] missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
    );
  }

  _client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

/**
 * Proxy that forwards every property access / call to the lazily-created
 * client. Module consumers can `import { supabaseEdge } from ...` and use
 * it as if it were the real client; instantiation happens on first access.
 *
 * The proxy preserves `this`-binding (`.from(...).insert(...)` chains) by
 * returning method-bound functions when a function property is read.
 */
export const supabaseEdge: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, _receiver) {
    const client = getClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

/**
 * HMAC-SHA256(ip) → 64 lowercase hex chars. Used to populate
 * geo_page_views.ip_hash (ES-090 §b.1 COMP-2).
 *
 * Fail-CLOSED on missing secret: ES-090 compliance requires every row
 * pseudonymizes raw IP via HMAC. Inserting with ip_hash NULL would
 * silently break the compliance gate — so we throw and let the handler
 * return 5xx instead of swallowing the misconfig. Belt-and-suspenders:
 * the handler also checks for the secret at request entry.
 *
 * Returns null only when the caller passed null/empty ip (e.g.,
 * unknown header) — that's a data-quality case, not a config gap.
 */
export async function hashIp(ip: string | null | undefined): Promise<string | null> {
  if (!ip) return null;
  const secret = process.env.IP_HASH_SECRET;
  if (!secret) {
    throw new Error(
      "[supabase-edge] IP_HASH_SECRET not configured — refusing to write rows without ip_hash (ES-090 §b.1 COMP-2)",
    );
  }

  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(ip));
    const bytes = new Uint8Array(sig);
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, "0");
    }
    return out;
  } catch (err) {
    console.error("[supabase-edge] hashIp failed:", err);
    return null;
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Edge-compatible rate-limit check. Calls the check_rate_limit Postgres
 * function defined in lib/db/rpc/check_rate_limit.sql. Same shape as
 * lib/rate-limit.ts::checkRateLimit but over HTTPS via supabase-js.
 *
 * On RPC error we fail OPEN (allowed: true) so a Supabase outage doesn't
 * blackhole every beacon — collection rows are append-only telemetry, not
 * a security boundary.
 */
export async function checkRateLimitEdge(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const { data, error } = await supabaseEdge.rpc("check_rate_limit", {
    p_key: key,
    p_limit: limit,
    p_window_ms: windowMs,
  });

  if (error || !data) {
    console.error("[supabase-edge] check_rate_limit RPC error:", error);
    return { allowed: true, remaining: limit, resetAt: Date.now() + windowMs };
  }

  // Function returns jsonb { allowed, remaining, resetAt }
  const result = data as { allowed: boolean; remaining: number; resetAt: string };
  return {
    allowed: !!result.allowed,
    remaining: Number(result.remaining) || 0,
    resetAt: result.resetAt ? new Date(result.resetAt).getTime() : Date.now() + windowMs,
  };
}

export interface CollectPageviewResult extends RateLimitResult {
  inserted: boolean;
}

/**
 * Combined rate-limit + pageview insert in a single HTTPS round-trip via the
 * collect_pageview Postgres function. Replaces the prior pair of calls
 * (checkRateLimitEdge + supabaseEdge.from(...).insert(...)) on the Edge
 * beacon hot path. Same fail-OPEN semantics on RPC error.
 */
export async function collectPageviewEdge(
  rateKey: string,
  rateLimit: number,
  windowMs: number,
  row: Record<string, unknown>,
): Promise<CollectPageviewResult> {
  const { data, error } = await supabaseEdge.rpc("collect_pageview", {
    p_rate_key: rateKey,
    p_rate_limit: rateLimit,
    p_window_ms: windowMs,
    p_row: row,
  });

  if (error || !data) {
    console.error("[supabase-edge] collect_pageview RPC error:", error);
    // Fail-OPEN on RPC error: allowed=true so we don't blackhole telemetry,
    // inserted=false so the caller can log the drop. Telemetry is append-only,
    // not a security boundary.
    return {
      allowed: true,
      remaining: rateLimit,
      resetAt: Date.now() + windowMs,
      inserted: false,
    };
  }

  const result = data as {
    allowed: boolean;
    remaining: number;
    resetAt: string;
    inserted: boolean;
  };
  return {
    allowed: !!result.allowed,
    remaining: Number(result.remaining) || 0,
    resetAt: result.resetAt ? new Date(result.resetAt).getTime() : Date.now() + windowMs,
    inserted: !!result.inserted,
  };
}
