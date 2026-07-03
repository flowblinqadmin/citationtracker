import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";

const BLOCKED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

const BLOCKED_RESPONSE_HEADERS = new Set([
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "content-encoding",
]);

// Only forward requests to these standard Supabase auth paths.
// Admin endpoints (/auth/v1/admin/*) are intentionally excluded.
const ALLOWED_AUTH_PATHS = new Set([
  "token", "user", "logout", "otp", "signup",
  "recover", "callback", "verify", "settings",
]);

/**
 * Returns the allowed CORS origin if the request origin matches the app URL,
 * or a localhost dev origin. Returns null for unknown origins.
 * Never reflects arbitrary origins with Allow-Credentials: true.
 */
function getAllowedCorsOrigin(req: NextRequest): string | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  if (appUrl && origin === appUrl) return origin;
  // Allow localhost in development
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return origin;
  return null;
}

async function proxyAuthRequest(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error(JSON.stringify({ event: "auth_proxy_misconfigured", missing: !SUPABASE_URL ? "SUPABASE_URL" : "SUPABASE_ANON_KEY" }));
    return NextResponse.json({ error: "Proxy misconfigured" }, { status: 500 });
  }

  // Rate limit per IP — 30 auth requests per minute
  const ip = getClientIp(req);
  const ipLimit = await checkRateLimit("auth_proxy:" + ip, 30, 60 * 1000);
  if (!ipLimit.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const startTime = Date.now();
  const { path } = await params;
  const topLevelPath = path[0] ?? "";

  // Allowlist: only forward to known safe Supabase auth paths
  if (!ALLOWED_AUTH_PATHS.has(topLevelPath)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const targetPath = path.join("/");

  // Build target URL
  const targetUrl = new URL(`${SUPABASE_URL}/auth/v1/${targetPath}`);
  req.nextUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.set(key, value);
  });

  // Build forwarded headers
  const forwardHeaders = new Headers();
  for (const [key, value] of req.headers.entries()) {
    if (!BLOCKED_REQUEST_HEADERS.has(key.toLowerCase())) {
      forwardHeaders.set(key, value);
    }
  }
  forwardHeaders.set("apikey", SUPABASE_ANON_KEY);
  if (!req.headers.get("authorization")) {
    forwardHeaders.set("authorization", `Bearer ${SUPABASE_ANON_KEY}`);
  }

  // Read body for mutating methods
  const method = req.method;
  const body = ["POST", "PUT", "PATCH", "DELETE"].includes(method)
    ? await req.arrayBuffer()
    : undefined;

  // Proxy to Supabase
  let upstream: Response;
  try {
    upstream = await fetch(targetUrl.toString(), {
      method,
      headers: forwardHeaders,
      body,
      redirect: "manual",
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "auth_proxy_network_failure", path: targetPath, error }));
    return NextResponse.json({ error: "Upstream unavailable" }, { status: 502 });
  }

  // Build response headers — strip hop-by-hop headers
  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (!BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== "set-cookie") {
      responseHeaders.set(key, value);
    }
  }

  // CORS: only allow explicitly permitted origins — never reflect arbitrary Origin
  const allowedOrigin = getAllowedCorsOrigin(req);
  if (allowedOrigin) {
    responseHeaders.set("Access-Control-Allow-Origin", allowedOrigin);
    responseHeaders.set("Access-Control-Allow-Credentials", "true");
  }

  if (upstream.status >= 400) {
    console.warn(JSON.stringify({ event: "auth_proxy_upstream_error", path: targetPath, status: upstream.status }));
    if (upstream.status === 429) {
      console.warn(JSON.stringify({ event: "auth_proxy_rate_limited", path: targetPath, retryAfter: upstream.headers.get("retry-after") }));
    }
  }

  console.log(JSON.stringify({
    event: "auth_proxy_request",
    method,
    path: targetPath,
    status: upstream.status,
    durationMs: Date.now() - startTime,
  }));

  // 204/304 responses must have no body
  const responseBody = upstream.status === 204 || upstream.status === 304
    ? null
    : await upstream.arrayBuffer();

  return new NextResponse(responseBody, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = proxyAuthRequest;
export const POST = proxyAuthRequest;
export const PUT = proxyAuthRequest;
export const PATCH = proxyAuthRequest;
export const DELETE = proxyAuthRequest;

export async function OPTIONS(req: NextRequest): Promise<NextResponse> {
  const allowedOrigin = getAllowedCorsOrigin(req);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
    "Access-Control-Max-Age": "86400",
  };
  if (allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return new NextResponse(null, { status: 204, headers });
}
