# GEO Implementation Guide

This guide covers how to connect your website to FlowBlinq GEO and implement the recommended changes.

## Connecting Your Site to FlowBlinq GEO

After running an audit, go to the **Setup tab** on your results page to get platform-specific integration instructions. Click "Get Integration Instructions" and select your platform — the system generates copy-paste code tailored to your site.

### What Gets Connected
There are 3 things to set up on your website:

1. **Proxy routes** — Serve your GEO-generated files from your own domain:
   - `/llms.txt` → proxied from FlowBlinq GEO (auto-updates when you re-run audits)
   - `/llms-full.txt` → extended version
   - `/.well-known/ucp.json` → structured business data for AI agents

2. **Tracking pixel** — Detects which AI bots visit your site:
   ```html
   <img src="https://geo.flowblinq.com/api/t/YOUR-SLUG" width="1" height="1" alt="" style="position:absolute;opacity:0" />
   ```

3. **robots.txt entries** — Allow AI crawlers (GPTBot, ClaudeBot, PerplexityBot) to find your GEO files

### Platform-Specific Connection Instructions

**WordPress (self-hosted):**
- Install the code via `functions.php` or use "WPCode" (Insert Headers and Footers) plugin
- Proxy routes via `.htaccess` RewriteRules or WordPress rewrite API
- robots.txt: add via `robots_txt` filter in functions.php or Yoast SEO's file editor
- Tracking pixel: add to footer via `wp_footer` action or a plugin

**Shopify:**
- Edit `theme.liquid` to add the tracking pixel and schema injection script in the `<head>`
- robots.txt: Shopify auto-generates it, but you can customize via `robots.txt.liquid` in your theme
- Proxy routes: use Shopify app proxy or a CDN like Cloudflare to proxy `/llms.txt` requests
- Note: Shopify doesn't allow direct static file uploads to root — proxy approach is required

**Magento / Adobe Commerce:**
- Tracking pixel: add to your theme's `default.xml` layout or CMS page footer
- Proxy routes: configure in Nginx/Apache vhost config, or use Magento URL rewrites
- robots.txt: edit directly at `pub/robots.txt` (Magento 2) or via Admin → Marketing → SEO → robots.txt
- Structured data: use extensions like "Amasty SEO" or add JSON-LD blocks to `default_head_blocks.xml`
- Example Nginx proxy config for llms.txt:
  ```nginx
  location = /llms.txt {
      proxy_pass https://geo.flowblinq.com/api/serve/YOUR-SLUG/llms.txt;
  }
  ```

**Wix:**
- Tracking pixel: go to Settings → Custom Code → add tracking pixel to Body (end)
- Structured data: use Wix SEO settings or Velo (Wix's development platform) to inject JSON-LD
- robots.txt: Wix manages robots.txt automatically — you can add custom rules via SEO settings
- Proxy routes: NOT directly supported — use Cloudflare Workers or a CDN to proxy llms.txt from your domain
- Note: Wix has limited server-side customization — the proxy approach requires an external service

**Squarespace:**
- Tracking pixel: go to Settings → Advanced → Code Injection → add to Footer
- Structured data: inject via Code Injection → Header (paste JSON-LD script tags)
- robots.txt: not directly editable — contact Squarespace support or use custom domain DNS workarounds
- Proxy routes: NOT directly supported — use Cloudflare or a reverse proxy

**Webflow:**
- Tracking pixel: go to Project Settings → Custom Code → Footer Code
- Structured data: add JSON-LD in Custom Code → Head Code, or per-page in page settings
- robots.txt: fully editable in Project Settings → SEO → robots.txt
- Proxy routes: use Webflow's reverse proxy feature or Cloudflare Workers

**Next.js / React:**
- Tracking pixel: add to your root layout component (`app/layout.tsx`)
- Proxy routes: add API routes or middleware rewrites in `next.config.js`:
  ```javascript
  // next.config.js
  async rewrites() {
    return [
      { source: '/llms.txt', destination: 'https://geo.flowblinq.com/api/serve/YOUR-SLUG/llms.txt' },
      { source: '/llms-full.txt', destination: 'https://geo.flowblinq.com/api/serve/YOUR-SLUG/llms-full.txt' },
      { source: '/.well-known/ucp.json', destination: 'https://geo.flowblinq.com/api/serve/YOUR-SLUG/business.json' },
    ];
  }
  ```
- robots.txt: create `app/robots.ts` using Next.js metadata API
- Structured data: use `generateMetadata()` or add `<script type="application/ld+json">` in layout

**Drupal:**
- Tracking pixel: add via Blocks or a module like "Asset Injector"
- Proxy routes: configure in Apache/Nginx vhost, or use Drupal's path aliases module
- robots.txt: managed by the `robotstxt` module or directly at `/robots.txt`
- Structured data: use the "Schema.org Metatag" module

**Ghost:**
- Tracking pixel: go to Settings → Code Injection → Site Footer
- Structured data: inject in Settings → Code Injection → Site Header
- robots.txt: create via `routes.yaml` configuration
- Proxy routes: configure in your reverse proxy (Nginx) or use Cloudflare Workers

**Other / Custom Platforms:**
- Place `llms.txt` and `llms-full.txt` as static files in your web root
- Add the tracking pixel `<img>` tag to your HTML footer
- Add robots.txt entries for AI crawlers
- For platforms that don't allow static files, use Cloudflare Workers or a CDN reverse proxy to serve from `https://geo.flowblinq.com/api/serve/YOUR-SLUG/`

### Finding Your Slug
Your site slug is visible in the Setup tab URL and in the proxy URLs shown in the integration instructions. It's derived from your domain (e.g., `example-com` for `example.com`).

## 1. Serving llms.txt

The llms.txt file tells AI agents what your website is about. It must be accessible at `https://yourdomain.com/llms.txt`.

### What llms.txt Contains
- Your business name and description
- Key products/services
- Contact information
- Content structure overview
- Important pages

### Deployment Options

**Option A: Static File (simplest)**
Place the generated llms.txt file in your website's public/root directory so it's served at /llms.txt.

**Option B: Proxy Route (recommended for hosted platforms)**
If you can't place static files, set up a proxy/redirect:
- Your domain /llms.txt → https://geo.flowblinq.com/api/serve/{your-slug}/llms.txt
- Your domain /llms-full.txt → https://geo.flowblinq.com/api/serve/{your-slug}/llms-full.txt
- Your domain /.well-known/ucp.json → https://geo.flowblinq.com/api/serve/{your-slug}/business.json

The proxy approach keeps files automatically updated when you re-run audits.

## 2. Adding Structured Data (JSON-LD)

Structured data helps AI agents understand your content. Add JSON-LD blocks to your page's `<head>` section.

### Common Schema Types
- **Organization** — Business name, logo, contact, social profiles
- **WebSite** — Site name, URL, search action
- **WebPage** — Individual page title, description, author
- **Product** — Product name, price, availability, reviews
- **LocalBusiness** — Address, hours, phone, coordinates
- **FAQPage** — Questions and answers
- **Article** — Blog posts, news articles
- **BreadcrumbList** — Navigation path

### Implementation
Add a `<script type="application/ld+json">` tag in your page's `<head>`:
```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Your Business",
  "url": "https://yourdomain.com",
  "description": "What your business does"
}
</script>
```

The GEO audit generates ready-to-use schema blocks in the Setup tab. Copy and paste them into your pages.

## 3. Configuring robots.txt for AI Crawlers

AI crawlers respect robots.txt rules. You need to explicitly allow them access to your AI-optimized content.

### Required Entries
Add these to your robots.txt file:

```
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
```

### Important
- Do NOT add `Disallow: /` rules for these crawlers
- If you have existing Disallow rules, make sure the Allow rules come first (most crawlers respect the first matching rule)
- If your robots.txt currently blocks GPTBot or ClaudeBot, removing the block is the single highest-impact change you can make

## 4. Adding the Tracking Pixel

The GEO tracking pixel monitors which AI bots visit your site.

### HTML Implementation
Add this to your page's `<body>`:
```html
<img src="https://geo.flowblinq.com/api/t/{your-slug}" width="1" height="1" alt="" style="position:absolute;opacity:0" />
```

### Script Tag (Optional, adds schema injection)
Add this to your page's `<head>`:
```html
<script src="https://geo.flowblinq.com/api/t/{your-slug}" async></script>
```
This script automatically injects JSON-LD schema blocks when AI bots visit. For human visitors, it sends a tracking beacon.

### Content Security Policy
If your site uses CSP headers, add `https://geo.flowblinq.com` to:
- `img-src` (for the tracking pixel)
- `script-src` (for the schema injection script)
- `connect-src` (for the beacon)

## 5. Meta Tags Best Practices

### Essential Meta Tags
Every page should have:
- `<title>` — Unique, descriptive, 50-60 characters
- `<meta name="description">` — Unique summary, 150-160 characters
- `<meta name="robots" content="index, follow">`

### Open Graph Tags
For social sharing and AI context:
- `<meta property="og:title">` — Page title
- `<meta property="og:description">` — Page description
- `<meta property="og:image">` — Featured image URL
- `<meta property="og:type">` — website, article, product, etc.
- `<meta property="og:url">` — Canonical page URL

### Twitter Cards
- `<meta name="twitter:card" content="summary_large_image">`
- `<meta name="twitter:title">` — Page title
- `<meta name="twitter:description">` — Page description

## 6. Content Optimization for AI

### Structure
- Use clear heading hierarchy (H1 → H2 → H3)
- One H1 per page
- Break content into scannable sections
- Use bullet points and numbered lists
- Include FAQ sections where relevant

### Quality
- Write comprehensive, in-depth content (500+ words for key pages)
- Include specific data, statistics, and examples
- Cite authoritative sources
- Keep content up to date
- Add author information and credentials

### AI-Specific
- Answer common questions directly in your content
- Use natural language that matches how people ask AI assistants
- Include your business name naturally in content
- Create dedicated "About" and "FAQ" pages

## 7. Server-Side Referrer Capture

LinkedIn and Twitter strip the Referer header using rel="noreferrer". To track traffic from these sources:

1. Read the HTTP Referer header on each incoming request
2. If the Referer is non-empty and no _geo_ref cookie exists, set a cookie:
   - Name: `_geo_ref`
   - Value: the Referer URL
   - Max-Age: 1800 (30 minutes)
   - SameSite: Strict
   - Secure: true
   - HttpOnly: false (the beacon JavaScript needs to read it)
   - Path: /

The GEO tracking script automatically reads this cookie and includes it in the beacon payload.

## Platform-Specific Notes

Different platforms have different capabilities:

### Full Control Platforms
WordPress (self-hosted), Next.js, Drupal, custom builds — can implement everything: static files, server-side code, full robots.txt control.

### Partial Control Platforms
Shopify, Squarespace, Webflow — can add code injection and some customization but may need workarounds for robots.txt and static file hosting.

### Limited Control Platforms
Wix, GoDaddy Builder, WordPress.com (free plans) — limited to what the platform allows. Use proxy approach for llms.txt, code injection for structured data where available.

For detailed platform-specific instructions, see the individual platform guides.
