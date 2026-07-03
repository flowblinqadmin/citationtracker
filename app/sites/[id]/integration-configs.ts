/**
 * Build platform-specific integration config snippets from a site slug.
 * Extracted from SitePageClient.tsx lines 634-905 (ES-087 PR-A).
 */
export function getIntegrationConfigs(slug: string) {
  const geoBase = `https://geo.flowblinq.com/api/serve/${slug}`;
  const pixelTag = `<img src="https://geo.flowblinq.com/api/t/${slug}" width="1" height="1" alt="" style="position:absolute;opacity:0" />`;
  const scriptTag = `<script src="https://geo.flowblinq.com/api/t/${slug}" async></script>`;
  const preconnectTag = `<link rel="preconnect" href="https://geo.flowblinq.com">`;
  const cspNote = `// NOTE: If you have a Content-Security-Policy, add https://geo.flowblinq.com to img-src, script-src, and connect-src`;

  // Single mandatory GEO tag, rendered with a platform-specific comment prefix.
  // One async <script> serves AI schema to bots and a lightweight (<1KB) analytics
  // beacon to humans — there is no separate "tracking pixel" to add. The <img>
  // pixel is a no-JS fallback ONLY and must never be installed alongside the tag
  // (doing so double-loads an uncached request on every page view — the cause of
  // the 2026-06 mobile-jank report). The preconnect saves ~100-500ms of DNS/TLS
  // setup, which matters most on mobile networks. `live` emits paste-ready tag
  // lines; otherwise they are shown as comments (for config-file contexts).
  const geoTagBlock = (prefix: string, live: boolean): string => {
    const c = live ? "" : `${prefix} `;
    return [
      `${prefix} Step 2 — Add the GEO tag to your site's <head> (mandatory)`,
      `${prefix} One async tag: serves AI schema to bots + a lightweight analytics beacon to humans.`,
      `${prefix} The preconnect saves ~100-500ms of connection setup, which matters most on mobile.`,
      `${prefix} If you use a Content-Security-Policy, allow https://geo.flowblinq.com in script-src, connect-src, and img-src.`,
      `${c}${preconnectTag}`,
      `${c}${scriptTag}`,
      ``,
      `${prefix} No-JS fallback ONLY — use this 1x1 pixel INSTEAD of the tag above, never in addition:`,
      `${prefix} ${pixelTag}`,
    ].join("\n");
  };

  const robotsBlock = `# Step 3 — robots.txt (add to your existing robots.txt)
# Tells AI crawlers where your GEO content lives

User-agent: GPTBot
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /.well-known/ucp.json

User-agent: OAI-SearchBot
Allow: /llms.txt
Allow: /llms-full.txt

User-agent: ChatGPT-User
Allow: /llms.txt
Allow: /llms-full.txt

User-agent: ClaudeBot
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /.well-known/ucp.json

User-agent: anthropic-ai
Allow: /llms.txt
Allow: /llms-full.txt

User-agent: PerplexityBot
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /.well-known/ucp.json

User-agent: Google-Extended
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /.well-known/ucp.json`;

  const referrerSteps: Record<string, string> = {
    vercel: `// Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
// Add to middleware.ts (or create it at the root of your project)
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export function middleware(request: NextRequest) {
  const response = NextResponse.next()
  const ref = request.headers.get("referer") ?? ""
  if (!request.cookies.has("_geo_ref") && ref) {
    response.cookies.set("_geo_ref", ref, {
      maxAge: 1800, sameSite: "strict", secure: true, httpOnly: false, path: "/",
    })
  }
  return response
}
export const config = { matcher: ["/((?!api|_next|.*\\\\..*).*)"] }`,

    netlify: `# Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
# Create netlify/edge-functions/geo-ref.ts
export default async (request: Request, context: any) => {
  const response = await context.next()
  const ref = request.headers.get("referer") ?? ""
  const cookies = request.headers.get("cookie") ?? ""
  if (!cookies.includes("_geo_ref=") && ref) {
    response.headers.append(
      "Set-Cookie",
      \`_geo_ref=\${encodeURIComponent(ref)}; Max-Age=1800; SameSite=Strict; Secure; Path=/\`
    )
  }
  return response
}
export const config = { path: "/*" }`,

    cloudflare: `// Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
// Add to your Cloudflare Worker fetch handler
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const response = await fetch(request)
  const ref = request.headers.get('Referer') || ''
  const cookies = request.headers.get('Cookie') || ''
  if (ref && !cookies.includes('_geo_ref=')) {
    const modified = new Response(response.body, response)
    modified.headers.append(
      'Set-Cookie',
      \`_geo_ref=\${encodeURIComponent(ref)}; Max-Age=1800; SameSite=Strict; Secure; Path=/\`
    )
    return modified
  }
  return response
}`,

    nginx: `# Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
# Add inside your server {} block in nginx.conf
# Sets _geo_ref cookie when HTTP Referer is present and cookie not yet set
map $http_referer $geo_ref_cookie {
    default "_geo_ref=$http_referer; Max-Age=1800; SameSite=Strict; Secure; Path=/";
    ""      "";
}
# In location / block:
add_header Set-Cookie $geo_ref_cookie always;`,

    wordpress: `# Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
# Add to functions.php
add_action('init', function() {
    if (!isset($_COOKIE['_geo_ref']) && !empty($_SERVER['HTTP_REFERER'])) {
        setcookie('_geo_ref', $_SERVER['HTTP_REFERER'], [
            'expires'  => time() + 1800,
            'path'     => '/',
            'secure'   => true,
            'httponly' => false,
            'samesite' => 'Strict',
        ]);
    }
});`,

    apache: `# Step 4 — Server-side referrer capture (catches LinkedIn, Twitter, email links)
# Add to a PHP file loaded on every request (e.g. wp-config.php or a mu-plugin)
<?php
if (!isset($_COOKIE['_geo_ref']) && !empty($_SERVER['HTTP_REFERER'])) {
    setcookie('_geo_ref', $_SERVER['HTTP_REFERER'], [
        'expires'  => time() + 1800,
        'path'     => '/',
        'secure'   => true,
        'httponly' => false,
        'samesite' => 'Strict',
    ]);
}`,
  };

  const integrationConfigs: Record<string, string> = {
    vercel: `// Step 1 — vercel.json (rewrites for AI-facing files)
{
  "rewrites": [
    { "source": "/llms.txt", "destination": "${geoBase}/llms.txt" },
    { "source": "/llms-full.txt", "destination": "${geoBase}/llms-full.txt" },
    { "source": "/.well-known/ucp.json", "destination": "${geoBase}/business.json" }
  ]
}

${geoTagBlock("//", true)}

${referrerSteps.vercel}

${robotsBlock}`,

    netlify: `# Step 1 — netlify.toml (rewrites for AI-facing files)
[[redirects]]
  from = "/llms.txt"
  to = "${geoBase}/llms.txt"
  status = 200

[[redirects]]
  from = "/llms-full.txt"
  to = "${geoBase}/llms-full.txt"
  status = 200

[[redirects]]
  from = "/.well-known/ucp.json"
  to = "${geoBase}/business.json"
  status = 200

${geoTagBlock("#", false)}

${referrerSteps.netlify}

${robotsBlock}`,

    cloudflare: `// Step 1 — Cloudflare Worker routes (rewrites for AI-facing files)
addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const routes = {
    '/llms.txt': '${geoBase}/llms.txt',
    '/llms-full.txt': '${geoBase}/llms-full.txt',
    '/.well-known/ucp.json': '${geoBase}/business.json',
  };
  const dest = routes[url.pathname];
  if (dest) event.respondWith(fetch(dest));
});

${geoTagBlock("//", false)}

${referrerSteps.cloudflare}

${robotsBlock}`,

    nginx: `# Step 1 — nginx.conf proxy rules (rewrites for AI-facing files)
location = /llms.txt {
    proxy_pass ${geoBase}/llms.txt;
    proxy_set_header Host geo.flowblinq.com;
}
location = /llms-full.txt {
    proxy_pass ${geoBase}/llms-full.txt;
    proxy_set_header Host geo.flowblinq.com;
}
location = /.well-known/ucp.json {
    proxy_pass ${geoBase}/business.json;
    proxy_set_header Host geo.flowblinq.com;
}

${geoTagBlock("#", false)}

${referrerSteps.nginx}

${robotsBlock}`,

    wordpress: `# ── .htaccess ──
RewriteEngine On
RewriteRule ^llms\\.txt$ ${geoBase}/llms.txt [P,L]
RewriteRule ^llms-full\\.txt$ ${geoBase}/llms-full.txt [P,L]
RewriteRule ^\\.well-known/ucp\\.json$ ${geoBase}/business.json [P,L]
# ── END .htaccess ──

# ── functions.php ──
# Step 2 — Add the GEO tag to your <head> (mandatory)
# One async tag: serves AI schema to bots + a lightweight analytics beacon to humans.
# The preconnect saves ~100-500ms of connection setup, which matters most on mobile.
# If you use a Content-Security-Policy, allow https://geo.flowblinq.com in script-src, connect-src, and img-src.
# add_action('wp_head', function() {
#   echo '${preconnectTag}' . "\\n";
#   echo '${scriptTag}' . "\\n";
# });
#
# No-JS fallback ONLY — use this INSTEAD of the wp_head tag above, never in addition:
# add_action('wp_footer', function() { echo '${pixelTag}' . "\\n"; });

${referrerSteps.wordpress}
# ── END functions.php ──

${robotsBlock}`,

    apache: `# Step 1 — .htaccess proxy rules (rewrites for AI-facing files)
RewriteEngine On
RewriteRule ^llms\\.txt$ ${geoBase}/llms.txt [P,L]
RewriteRule ^llms-full\\.txt$ ${geoBase}/llms-full.txt [P,L]
RewriteRule ^\\.well-known/ucp\\.json$ ${geoBase}/business.json [P,L]

${geoTagBlock("#", false)}

${referrerSteps.apache}

${robotsBlock}`,
  };

  return {
    vercel: integrationConfigs.vercel,
    netlify: integrationConfigs.netlify,
    cloudflare: integrationConfigs.cloudflare,
    nginx: integrationConfigs.nginx,
    wordpress: integrationConfigs.wordpress,
    apache: integrationConfigs.apache,
    // Also return these for SetupTab to use directly
    geoBase,
    pixelTag,
    scriptTag,
    cspNote,
  };
}
