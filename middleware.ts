import { NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

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
  /\/wp-admin/i,
  /\/wp-login\.php/i,
  /\/xmlrpc\.php/i,
  /\/wp-json/i,
  /\/wp-config/i,
  /\/wp-content/i,
  /\/wp-includes/i,
  /\.php$/i,
  /\/\.env/i,
  /\/\.git/i,
  /\/\.svn/i,
  /\/\.htaccess/i,
  /\/web\.config/i,
  /\/\.vscode/i,
  /\.sql(\.gz)?$/i,
  /\.bak$/i,
  /\.old$/i,
  /\.orig$/i,
  /\/phpmyadmin/i,
  /\/adminer/i,
  /\/administrator/i,
  /\/node_modules/i,
  /\/vendor/i,
  /\/composer\.json/i,
  /\/package\.json/i,
  /\/debug/i,
  /\/server-status/i,
  /\/trace/i,
  /\/\.well-known\/security\.txt/i,
];

// Routes that pass through (auth enforced in each route handler)
const ALWAYS_ALLOWED = [
  /^\/_next\//,
  /^\/favicon\.ico$/,
  /^\/icon\.svg$/,
  /^\/apple-icon\.png$/,
  /^\/logo\.png$/,
  /^\/robots\.txt$/,                        // allow bots to read crawl rules
  /^\/sample-bulk-audit\.csv$/,             // bulk audit sample download
  /^\/$/,                                   // homepage — site creation form
  /^\/api\/serve\//,                        // customer AI files — fully public
  /^\/api\/report\//,                       // public share reports
  /^\/sites\/[^/]+$/,                       // /sites/[id]
  /^\/verify\/[^/]+$/,                      // /verify/[id]
  /^\/api\/sites\/[^/]+\/auth$/,            // email gate
  /^\/api\/sites\/[^/]+\/info$/,            // masked email lookup
  /^\/api\/sites\/[^/]+\/regenerate$/,      // report page action
  /^\/api\/sites\/[^/]+\/retry-failed$/,    // ES-B9.1 AC-B9.1-1 — bulk retry; auth enforced inside the route handler
  /^\/api\/sites\/[^/]+\/verify-domain$/,   // report page action
  /^\/api\/sites\/[^/]+\/verify-connection$/, // report page action
  /^\/api\/sites\/[^/]+\/verify$/,          // email verification flow
  /^\/api\/sites\/[^/]+\/consent$/,         // TOS/EULA consent recording (audit flow)
  /^\/api\/consent$/,                       // TOS/EULA consent check+accept (login flow)
  /^\/api\/sites\/[^/]+$/,                  // GET site by id
  /^\/api\/sites\/[^/]+\/download-report$/, // bulk ZIP download — auth in route
  /^\/api\/sites\/[^/]+\/fix-html-render$/, // Fix HTML tab paste-and-render — auth in route
  /^\/api\/sites\/[^/]+\/pdf-report$/,      // PDF report download — auth in route (legacy URL)
  /^\/api\/sites\/[^/]+\/[^/]+\.pdf$/,      // PDF report download with .pdf URL suffix + ?purchaseToken= query — auth in route (Aditya 2026-04-29 v1)
  /^\/api\/sites\/[^/]+\/[^/]+\/[^/]+\.pdf$/, // PDF report download with purchaseToken IN PATH (no query string) — auth in route (Aditya 2026-04-29 v2)
  /^\/api\/sites\/[^/]+\/citation-check$/,  // AI citation check SSE — auth in route
  /^\/api\/sites\/[^/]+\/citation-history$/, // per-run citation timeline — accessToken auth in route
  /^\/api\/sites\/[^/]+\/citation-narrative$/, // LLM narrative — auth in route
  /^\/api\/sites\/[^/]+\/competitor-discovery$/, // Competitor discovery SSE — auth in route
  /^\/api\/sites\/[^/]+\/competitors$/,     // Add/remove competitors — auth in route
  /^\/api\/sites$/,                         // POST site creation (public)
  /^\/api\/audit(\/|$)/,                    // commerce audit — public create (/api/audit) + /api/audit/[id]/* (boundary-anchored; does NOT match /api/audit-purchase)
  /^\/api\/audit-purchase\/(checkout|intake|status)$/, // commerce audit purchase — public, rate-limited in route
  /^\/audit\//,                             // commerce audit results pages
  /^\/api\/pipeline\/run$/,                 // cron — auth in route
  /^\/api\/pipeline\/stage$/,               // QStash pipeline stages — auth in route
  /^\/api\/pipeline\/crawl-webhook$/,          // Firecrawl webhook — auth via CRON_SECRET in route
  /^\/api\/cron\//,                         // cron — auth in route
  /^\/api\/integration-instructions$/,      // auth in route
  /^\/api\/chatbot$/,                       // AI chatbot — auth in route
  /^\/preview$/,                            // design preview — dev only
  /^\/auth\//,                              // all /auth/* routes (login, callback)
  /^\/dashboard/,                           // handled by Supabase middleware
  /^\/api\/teams\//,                        // teams API — auth via Supabase headers
  /^\/api\/checkout$/,                      // Stripe checkout
  /^\/api\/subscription-signup\//,          // payment-first subscription signup — unauthenticated, rate-limited in route
  /^\/api\/webhooks\//,                     // Stripe webhooks
  /^\/api\/subscription$/,                  // Subscription status, portal, crawl settings
  /^\/pricing$/,                            // public pricing page
  /^\/api\/pricing$/,                       // Public pricing config — cacheable
  /^\/api\/auth\/check$/,                    // email-exists check — public, rate-limited + no-enumeration in route
  /^\/api\/auth\/otp\//,                    // OTP send + verify — public (rate-limited in route)
  /^\/api\/auth\/proxy\//,                  // Supabase auth proxy — bypasses ISP blocks on *.supabase.co
  /^\/api\/oauth\/token$/,                  // OAuth token endpoint — JWT auth in route
  /^\/api\/v1\//,                           // Public API — JWT auth in route
  /^\/api\/t\//,                            // Tracking pixel — public (JS + beacon collection); Edge runtime
  /^\/api\/csp-report$/,                    // ES-090 §b.7 HP-190 — CSP violation reports
  /^\/admin\/cleo(\/[^/]+)?$/,              // admin chatbot triage UI — admin auth in route
  /^\/api\/admin\/cleo\/golden$/,           // POST golden-set seed — admin auth in route
  /^\/api\/parts\//,                        // Parts intel — auth in route handler
  /^\/parts-dashboard\.html$/,              // Parts dashboard static page — auth in JS
];

const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Permitted-Cross-Domain-Policies": "none",
};

// ── ES-090 §b.7 L-2 — Content-Security-Policy (HP-190 + HP-192) ───────────
// PR #1 ships Report-Only so we can observe violations before enforcing.
// HP-192 — nonce-based script-src with strict-dynamic; the eval-allowing
// source expression REMOVED (CSP bypass risk).
// HP-190 — Reporting-Endpoints header + /api/csp-report route (owned, not
// Sentry direct) so we can PII-scrub document-uri / blocked-uri server-side.

function buildCSP(nonce: string): string {
  return [
    "default-src 'self'",
    // HP-192: nonce + strict-dynamic + https: fallback for legacy scripts.
    // 'unsafe-inline' is tolerated per strict-dynamic semantics (ignored by
    // browsers that honor strict-dynamic, present as back-compat for older).
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' https:`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    // U75: supabase.co for auth + realtime; Stripe + Sentry for their SDKs.
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com https://*.sentry.io https://vitals.vercel-insights.com",
    "frame-src 'self' https://js.stripe.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
    "report-uri /api/csp-report",
    "report-to csp-endpoint",
  ].join("; ");
}

function applyCspHeaders(res: NextResponse, nonce: string): void {
  // PR #1: Report-Only so violations surface in Sentry without breaking
  // legitimate traffic. G5 gate flips to the enforcing header.
  res.headers.set("Content-Security-Policy-Report-Only", buildCSP(nonce));
  res.headers.set(
    "Reporting-Endpoints",
    `csp-endpoint="/api/csp-report"`,
  );
}

// Paths that require the Supabase session refresh path inside updateSession()
// — auth redirects for /dashboard, already-authed-redirect on /auth/login,
// OAuth code exchange, and the auth proxy that needs cookies. Everything else
// in ALWAYS_ALLOWED is anonymous-public and skips updateSession() to avoid
// constructing a Supabase server client + calling getSession() per request.
// PR #182 perf win — measurable Edge CPU reduction on the /api/t/* hot path
// and other anonymous routes.
//
// IMPORTANT: any /api/* route that calls lib/supabase/authenticated-client's
// getAuthenticatedUser() or createAuthenticatedClient() MUST be listed here.
// Those helpers read the x-supabase-token header that updateSession() stamps
// onto the request — if the route is in ALWAYS_ALLOWED but missing here, it
// short-circuits without resolving the session, the header is never stamped,
// and the route treats every authenticated browser as anonymous (401 /
// hasConsent=false). Audited 2026-05-21 after the consent route surfaced
// exactly this regression — see commit message for the full trace.
const NEEDS_SUPABASE_SESSION: readonly RegExp[] = [
  /^\/dashboard/,
  /^\/auth\/login$/,
  /^\/auth\/exchange$/,
  /^\/api\/auth\/proxy\//,
  /^\/api\/consent$/,                       // calls getAuthenticatedUser
  /^\/api\/checkout$/,                      // calls getAuthenticatedUser
  /^\/api\/subscription$/,                  // PATCH crawl settings — calls getAuthenticatedUser (FIX-022)
  /^\/api\/teams\//,                        // teams routes use createAuthenticatedClient / getAuthenticatedUser
  // C1 (2026-05-27 audit): /api/sites trusts x-user-email/x-user-id for the
  // Pro fast-path. Routing it through updateSession() strips any
  // client-supplied headers and re-stamps verified ones from the Supabase
  // session, closing the auth-bypass.
  /^\/api\/sites$/,
];

function needsSession(pathname: string): boolean {
  return NEEDS_SUPABASE_SESSION.some((p) => p.test(pathname));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const ua = req.headers.get("user-agent") ?? "";

  // 1. Block malicious user agents
  const uaLower = ua.toLowerCase();
  if (BLOCKED_UA_PATTERNS.some((p) => uaLower.includes(p))) {
    return new NextResponse(null, { status: 403 });
  }

  // 2. Block empty user agent (except /api/*, /_next/*, /auth/*)
  // /auth/* is exempt because corporate proxies (common in India, SE Asia) strip UA headers,
  // which would block legitimate users from completing the OAuth / email-OTP login flow.
  if (!ua && !pathname.startsWith("/api/") && !pathname.startsWith("/_next/") && !pathname.startsWith("/auth/")) {
    return new NextResponse(null, { status: 403 });
  }

  // 3. Block malicious paths
  if (BLOCKED_PATH_PATTERNS.some((p) => p.test(pathname))) {
    return new NextResponse(null, { status: 403 });
  }

  // ── HP-226: generate nonce BEFORE updateSession and stamp the REQUEST
  // header. NextResponse.next({ request }) (used inside updateSession)
  // propagates the stamped headers to the RSC layer, where app/layout.tsx
  // reads it via `headers().get("x-csp-nonce")` and forwards to every
  // `<Script nonce={...}>`. Rename from x-nonce → x-csp-nonce (request,
  // not response) so the header survives SSR rendering and isn't a
  // leak surface on the client.
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  req.headers.set("x-csp-nonce", nonce);

  // 4. Allowlist check FIRST. For public/anonymous paths, skip updateSession()
  // entirely — it constructs a Supabase server client, parses cookies, and
  // calls getSession() per request, all wasted work on anonymous traffic that
  // has no session to refresh (e.g., /api/serve/*, /api/cron/*, /api/v1/*,
  // /api/t/*). This is the PR #182 Edge CPU win.
  const isAllowed = ALWAYS_ALLOWED.some((p) => p.test(pathname));

  if (isAllowed && !needsSession(pathname)) {
    const res = NextResponse.next({ request: req });
    Object.entries(SECURITY_HEADERS).forEach(([k, v]) => res.headers.set(k, v));
    applyCspHeaders(res, nonce);
    return res;
  }

  // 5. Auth-aware path: run Supabase session refresh
  const supabaseRes = await updateSession(req);

  // 6. Allowlisted-auth path: stamp security headers and return
  if (isAllowed) {
    Object.entries(SECURITY_HEADERS).forEach(([k, v]) => supabaseRes.headers.set(k, v));
    // ES-090 §b.7 L-2: Report-Only CSP header uses the same nonce we
    // stamped on the request so `<Script nonce={n}>` emissions match.
    applyCspHeaders(supabaseRes, nonce);
    return supabaseRes;
  }

  // 7. Everything else — 403, no body, no info
  return new NextResponse(null, { status: 403 });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
