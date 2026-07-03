import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { db } from "@/lib/db";
import { geoSiteView } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { checkRateLimit } from "@/lib/rate-limit";

// H5 (2026-05-27 audit): platform is interpolated into an OpenAI prompt.
// Previously a regex strip allowed newlines + instruction tokens, enabling
// prompt-injection that affected the response the customer sees. Move to a
// strict allowlist of supported platforms — anything else is rejected.
//
// Canonical (display-cased) value for each accepted slug. The UI sends
// free-text from a form input; we lowercase-compare to allow "wordpress",
// "Wordpress", or "WordPress" to all resolve to the canonical "WordPress"
// that gets interpolated into the prompt.
const SUPPORTED_PLATFORMS: Record<string, string> = {
  wordpress: "WordPress",
  shopify: "Shopify",
  wix: "Wix",
  squarespace: "Squarespace",
  webflow: "Webflow",
  "next.js": "Next.js",
  nextjs: "Next.js",
  nuxt: "Nuxt",
  rails: "Rails",
  django: "Django",
  laravel: "Laravel",
  express: "Express",
  flask: "Flask",
  "static html": "Static HTML",
  static: "Static HTML",
  other: "Other",
};

export async function POST(req: NextRequest) {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const token =
      req.headers.get("authorization")?.replace("Bearer ", "") ?? null;

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { platform, siteId } = await req.json() as {
      platform?: string;
      siteId?: string;
    };

    if (!platform || !siteId) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // H5: strict allowlist instead of regex strip — closes prompt-injection.
    // Case-insensitive lookup; the canonical (display-cased) value is what
    // ends up in the prompt so the LLM gets a consistent, vetted token.
    const cleanPlatform = SUPPORTED_PLATFORMS[platform.trim().toLowerCase()];
    if (!cleanPlatform) {
      return NextResponse.json(
        { error: "Unsupported platform" },
        { status: 400 },
      );
    }

    // H5: per-site rate limit caps LLM cost. A token holder paid once but
    // shouldn't be able to drain OpenAI quota by spamming this endpoint.
    const rl = await checkRateLimit(
      `integration-instructions:${siteId}`,
      5,
      60 * 60 * 1000,
    );
    if (!rl.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
      return NextResponse.json(
        { error: "Too Many Requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }

    // Verify token against DB — pull slug/domain server-side, never trust client
    const [site] = await db
      .select({ slug: geoSiteView.slug, domain: geoSiteView.domain, accessToken: geoSiteView.accessToken })
      .from(geoSiteView)
      .where(eq(geoSiteView.siteId, siteId));

    if (!site || site.accessToken !== token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { slug, domain } = site;

    const prompt = `You are a developer integration expert for FlowBlinq GEO, an AI visibility platform.

A merchant is using "${cleanPlatform}" to host their website at "${domain}".

Generate the exact integration instructions to:

1. Proxy these 3 routes from their domain to FlowBlinq GEO:
   - /llms.txt → https://geo.flowblinq.com/api/serve/${slug}/llms.txt
   - /llms-full.txt → https://geo.flowblinq.com/api/serve/${slug}/llms-full.txt
   - /.well-known/ucp.json → https://geo.flowblinq.com/api/serve/${slug}/business.json

2. Add a tracking pixel to their HTML body (works everywhere, no CSP changes needed):
   <img src="https://geo.flowblinq.com/api/t/${slug}" width="1" height="1" alt="" style="position:absolute;opacity:0" />
   This tracks human and bot visits. AI bots that visit the site will be detected automatically.

3. Add a script tag to their HTML head for automatic schema.org injection (mandatory):
   <script src="https://geo.flowblinq.com/api/serve/${slug}/schema.js" defer></script>
   This injects JSON-LD schema blocks for AI bots automatically. No server-side fetch needed.
   NOTE: If they have a Content-Security-Policy, they must add https://geo.flowblinq.com to img-src, script-src, and connect-src.

4. Add server-side referrer capture so the GEO analytics can attribute traffic from LinkedIn, Twitter, and email correctly.
   LinkedIn and Twitter use rel="noreferrer" which strips document.referrer in the browser.
   The fix: read the HTTP Referer header server-side on each incoming request and store it in a first-party cookie named _geo_ref.
   Cookie must be: Max-Age=1800, SameSite=Strict, Secure, HttpOnly=false (beacon JS needs to read it), Path=/.
   Only set it when the cookie does not already exist AND the Referer header is non-empty.
   Generate the correct server-side snippet for "${cleanPlatform}" — middleware, plugin, hook, filter, or config — whatever is idiomatic for that platform.

5. Add these entries to their robots.txt file (this tells AI crawlers where to find the GEO content):
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
   Allow: /.well-known/ucp.json

6. (Recommended for SSR platforms: Next.js, Nuxt, Rails, Django, Laravel)
   Fetch schema blocks server-side and inline them in your HTML <head>:

   URL: https://geo.flowblinq.com/api/serve/${slug}/schema.json

   Fetch at build time or with ISR/revalidation (e.g., every 3600s).
   For each block in the JSON array, render:
   <script type="application/ld+json">{JSON.stringify(block)}</script>

   This ensures crawlers see structured data in the initial HTML without requiring JavaScript execution.

   Next.js example:
   async function GeoSchema() {
     try {
       const schemas = await fetch("https://geo.flowblinq.com/api/serve/${slug}/schema.json", {
         next: { revalidate: 3600 },
       }).then((r) => r.json());
       return schemas.map((s, i) => (
         <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(s) }} />
       ));
     } catch { return null; }
   }
   // Place <GeoSchema /> in your root layout's <head> or <body>

Be specific and concise. Output only the config/code the merchant needs to copy-paste, with minimal inline comments. No preamble, no explanation outside of comments in the code itself.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 800,
      temperature: 0.2,
    });

    const instructions = completion.choices[0]?.message?.content?.trim();

    if (!instructions) {
      return NextResponse.json({ error: "No instructions generated" }, { status: 500 });
    }

    return NextResponse.json({ instructions });
  } catch (err) {
    console.error("POST /api/integration-instructions error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
