import { NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// ── Access policy: default-deny ─────────────────────────────────────────────
// This service runs under geo.flowblinq.com/citations (basePath). Login lives
// on geo; the shared Supabase session cookie authenticates users here. Only
// static assets and /api/cron/* (CRON_SECRET auth inside the route) skip the
// session. Every other path requires an authenticated session: API routes get
// 401, pages redirect to geo's login.

// Blocked user agent substrings (case-insensitive)
const BLOCKED_UA_PATTERNS = [
  "nikto", "sqlmap", "nmap", "masscan", "zgrab", "nuclei", "acunetix",
  "nessus", "openvas", "burpsuite", "metasploit", "w3af", "havij",
  "wpscan", "wpbot", "cms-checker", "joomscan",
  "ahrefsbot", "semrushbot", "mj12bot", "dotbot", "blexbot", "dataforseobot",
  "faviconhash", "shodan",
];

// Blocked path substrings / patterns
const BLOCKED_PATH_PATTERNS = [
  /\/wp-admin/i, /\/wp-login\.php/i, /\/xmlrpc\.php/i, /\/wp-json/i,
  /\/wp-config/i, /\/wp-content/i, /\/wp-includes/i, /\.php$/i,
  /\/\.env/i, /\/\.git/i, /\/\.svn/i, /\/\.htaccess/i, /\/web\.config/i,
  /\/\.vscode/i, /\.sql(\.gz)?$/i, /\.bak$/i, /\.old$/i, /\.orig$/i,
  /\/phpmyadmin/i, /\/adminer/i, /\/administrator/i, /\/node_modules/i,
  /\/vendor/i, /\/composer\.json/i, /\/package\.json/i, /\/debug/i,
  /\/server-status/i, /\/trace/i,
];

// Anonymous-public paths — skip session construction entirely.
const PUBLIC_PATHS = [
  /^\/_next\//,
  /^\/favicon\.ico$/,
  /^\/icon\.svg$/,
  /^\/api\/cron\//, // CRON_SECRET auth inside the route (lib/cron-auth)
];

const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Permitted-Cross-Domain-Policies": "none",
};

function withSecurityHeaders(res: NextResponse): NextResponse {
  Object.entries(SECURITY_HEADERS).forEach(([k, v]) => res.headers.set(k, v));
  return res;
}

function geoLoginUrl(pathname: string, search: string): string {
  const origin = process.env.GEO_ORIGIN ?? "https://geo.flowblinq.com";
  // pathname is basePath-stripped; the user-facing URL includes /citations.
  const next = encodeURIComponent(`/citations${pathname}${search}`);
  return `${origin}/auth/login?redirectTo=${next}`;
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const ua = req.headers.get("user-agent") ?? "";

  const uaLower = ua.toLowerCase();
  if (BLOCKED_UA_PATTERNS.some((p) => uaLower.includes(p))) {
    return new NextResponse(null, { status: 403 });
  }
  if (BLOCKED_PATH_PATTERNS.some((p) => p.test(pathname))) {
    return new NextResponse(null, { status: 403 });
  }

  if (PUBLIC_PATHS.some((p) => p.test(pathname))) {
    return withSecurityHeaders(NextResponse.next({ request: req }));
  }

  // Session-gated: validate/refresh the shared Supabase session. updateSession
  // strips client-supplied identity headers and stamps verified x-user-id /
  // x-user-email / x-supabase-token from the session.
  const res = await updateSession(req);
  const isAuthenticated = !!res.headers.get("x-user-id");

  if (!isAuthenticated) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(geoLoginUrl(pathname, search));
  }

  return withSecurityHeaders(res);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
