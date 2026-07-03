# ES-089 — GEO Integration Security Hardening

**Status:** Draft
**Branch:** `feat/geo-security-hardening`
**Author:** Adithya Rao
**Date:** 2026-04-23
**Priority:** P0 (production vulnerability in § 3.1) + P1 infrastructure

---

## 1. Background

The Manipal Traffic Validation Study (22 Apr 2026) raised three security concerns about the FBQ GEO layer installed on Manipal Hospitals' Apache/PHP site:

1. **Beacon script supply chain** — a compromised `geo.flowblinq.com` could serve malicious JavaScript to every visitor on every customer's site
2. **JSON-LD schema injection** — the PHP echo block that injects `schema.json` inline is vulnerable to HTML injection via `</script>` sequences in crawled content
3. **Proxied file paths** — `.htaccess` rewrite rules proxy `llms.txt` and `ucp.json` from FBQ with no content-type enforcement

A security audit of the original mitigation plan revealed an additional dimension entirely absent from the Manipal analysis: **FBQ's own ingest endpoint has no server-side validation** — anyone can POST arbitrary data to it, spoofing beacons for any customer domain.

This spec addresses all four concerns. It also pressure-tests the mitigations against every platform Flowblinq will integrate with — not just Apache/PHP — since the original plan's mitigations are not portable to Shopify, Wix, Squarespace, Webflow, and other managed platforms.

---

## 2. Threat Model

Supply chain risk is **bidirectional**:

| Direction | Threat | Example |
|---|---|---|
| FBQ → Customer (downstream) | Compromised FBQ serves malicious beacon script | Attacker replaces `beacon.js`; XSS runs on every customer visitor |
| Customer → FBQ (upstream) | Spoofed or tampered beacon payloads | Attacker inflates analytics for a competitor's domain |

Both directions must be hardened. Existing mitigations (HTTPS, Firecrawl bot filtering) are necessary but not sufficient.

### Out of scope
- Denial-of-service at infrastructure level (Vercel/Cloudflare handles this)
- DNS hijacking of `geo.flowblinq.com` itself (mitigated by DNSSEC + Vercel's TLS)
- Prompt injection via crawled content (tracked separately; hardening notes in § 7)

---

## 3. Changes

### 3.1 JSON-LD / Schema Injection Fix (P0 — production vulnerability, ship immediately)

**Files:** `app/api/serve/[slug]/schema.json/route.ts`, `app/api/serve/[slug]/schema.js/route.ts`

**Problem:** Both routes call `NextResponse.json()` or `JSON.stringify()` and return the result. Node.js/V8's `JSON.stringify()` does **not** escape `<`, `>`, `/`, `\u2028`, or `\u2029`. A customer embedding this JSON inline as `<script type="application/ld+json">` is vulnerable to HTML injection if any crawled string (e.g., a business name) contains `</script>`.

This is a live vulnerability on production today — not a future risk.

**Fix:** Before returning any JSON-LD content, apply unicode-escape to HTML-sensitive characters:

```typescript
function safeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g,  '\\u003c')   // closes <script> tags
    .replace(/>/g,  '\\u003e')
    .replace(/\//g, '\\u002f')   // belt-and-suspenders for </
    .replace(/\u2028/g, '\\u2028') // LINE SEPARATOR — breaks scripts in old browsers
    .replace(/\u2029/g, '\\u2029'); // PARAGRAPH SEPARATOR
}
```

JSON parsers decode `\u003c` → `<` transparently; schema semantics are preserved.

Apply to:
- `schema.json` route (replace `NextResponse.json(schemas)` with `new Response(safeJsonLd(schemas), { headers: { 'Content-Type': 'application/json; charset=utf-8' } })`)
- `schema.js` route — wherever `buildSchemaInjectionJs` embeds the JSON-LD string

---

### 3.2 HMAC Token System (P0 — new infrastructure)

**Files:** `lib/beacon-token.ts` (new), `app/api/t/[slug]/token/route.ts` (new)

**Purpose:** Makes beacon data worthless to an attacker even if the FBQ beacon script is replaced. Tokens are generated server-side using a secret that never leaves FBQ's infrastructure; a replaced script cannot forge them.

**Token format:** `v1.<base64url(payload)>.<HMAC-SHA256(payload, secret)>`

The `v1.` prefix is an algorithm version identifier that enables future key rotation without a flag day.

**Token payload:**
```json
{ "slug": "manipalhospitals-com--GzFX1", "iat": 1745000000, "exp": 1745000300 }
```

TTL: **5 minutes** (not 1 hour — shorter window limits replay; token endpoint is open so longer TTL adds no security benefit).

**`GET /api/t/[slug]/token`:**
- No auth required; CORS open (`Access-Control-Allow-Origin: *`)
- Rate-limited: 60 requests/minute per IP (reuse `lib/rate-limit.ts`)
- Returns `{ token, expiresAt }`
- Must be added to `ALWAYS_ALLOWED` in `middleware.ts`

**`verifyToken` — critical implementation notes:**
```typescript
// lib/beacon-token.ts
export function verifyToken(token: string, slug: string): boolean {
  if (!token.startsWith('v1.')) return false;
  const rest = token.slice(3);
  const dotIdx = rest.lastIndexOf('.');
  if (dotIdx < 0) return false;
  const [payloadB64, sig] = [rest.slice(0, dotIdx), rest.slice(dotIdx + 1)];

  const expectedSig = crypto
    .createHmac('sha256', process.env.BEACON_HMAC_SECRET!)
    .update(payloadB64)
    .digest('base64url');

  // MUST check lengths before timingSafeEqual — mismatched lengths throw RangeError
  // (a thrown exception is a timing oracle that reveals signature length)
  const sigBuf = Buffer.from(sig, 'base64url');
  const expBuf = Buffer.from(expectedSig, 'base64url');
  if (sigBuf.length !== expBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  if (payload.exp < Math.floor(Date.now() / 1000)) return false;
  if (payload.slug !== slug) return false;

  return true;
}
```

**Secret rotation (zero-downtime):** Support `BEACON_HMAC_SECRET` (current) and `BEACON_HMAC_SECRET_PREV` (optional, previous). `verifyToken` tries current key first; if that fails and `PREV` is set, tries previous key. Remove `PREV` from env after one TTL (5 min) post-rotation.

---

### 3.3 Ingest Endpoint Hardening (P0)

**File:** `app/api/t/[slug]/collect/route.ts`

The collect endpoint currently has no origin validation, no schema validation, and no token verification. This section adds all three, with **backward compatibility** for existing deployments (§ 4).

#### 3.3.1 Slug-keyed URL (architectural change)

The endpoint must be `POST /api/t/[slug]/collect` — slug in the URL, **not** the body. This is required for CORS security.

**Why:** CORS preflight (`OPTIONS`) fires before the request body is readable. If slug is in the body, the server cannot validate `Origin` at preflight time and must respond with `Access-Control-Allow-Origin: *` unconditionally — which voids origin validation. With slug in the URL, `OPTIONS` can look up allowed origins for that slug and refuse unregistered domains before the POST is ever sent.

The existing route pattern `/api/t/[slug]/route.ts` already follows this convention.

#### 3.3.2 OPTIONS handler (CORS)

```typescript
export async function OPTIONS(req: Request, { params }: { params: { slug: string } }) {
  const origin = req.headers.get('origin') ?? '';
  if (!validateOrigin(origin, params.slug)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}
```

No wildcard CORS. Only registered customer domains get a preflight grant.

#### 3.3.3 Origin validation

```typescript
// lib/beacon-validation.ts
import { parse as parseDomain } from 'tldts';

export function validateOrigin(origin: string, slug: string): boolean {
  let hostname: string;
  try { hostname = new URL(origin).hostname; }
  catch { return false; }

  const domains = getRegisteredDomainsForSlug(slug); // DB lookup
  return domains.some(d => {
    // Guard against public-suffix registrations (e.g. 'co.uk')
    const parsed = parseDomain(d);
    if (!parsed.domain) return false;
    return hostname === d || hostname.endsWith('.' + d);
  });
}
```

**Critical:** suffix matching is performed on the parsed `hostname`, never on the raw `origin` string (which includes the scheme). `'https://attacker.co.in'.endsWith('.co.in')` = true — a bypass if matching on the full string.

#### 3.3.4 Payload schema validation

```typescript
import { z } from 'zod';

// Audit actual visitor_id / session_id format from beacon script before locking this regex
// Current beacon generates: Math.random().toString(36).slice(2) + Date.now().toString(36)
const beaconSchema = z.object({
  page_url:    z.string().url().max(2048).refine(u => /^https?:\/\//.test(u)),
  referrer:    z.string().url().max(2048).or(z.literal('')).default(''),
  visitor_id:  z.string().max(256),
  user_agent:  z.string().max(512).default(''),
  screen_width: z.number().int().min(0).max(8000).nullable(),
  beacon_token: z.string().optional(), // optional for legacy mode
  timestamp:   z.string().datetime(),
}).strict();
```

Payload size limit: 16 KB (checked before schema parse).

#### 3.3.5 Rate limiting + deduplication

Reuse `lib/rate-limit.ts`. Per-slug limits: 1,000 requests / 10 seconds, 6,000 / minute.

Dedup key: `SHA-256(slug + visitor_id + page_url + floor(timestamp_ms / 60000))` — timestamp rounded to 1-minute buckets (prevents trivial bypass by varying milliseconds). TTL: 24 hours in `rate_limits` table.

**Always return `204 No Content`** for accepted beacons — whether deduped or not. Never return `{ deduped: true }` in production; that is an oracle that reveals whether a specific visitor/URL combination is already tracked.

---

### 3.4 DB Schema Addition (P0)

**File:** `lib/db/schema.ts`

Add to `geoSites`:

```typescript
securityMode:       text('security_mode').default('legacy').notNull(),
// 'legacy' = accept beacons without token; 'secure' = token required
securityUpgradedAt: timestamp('security_upgraded_at'),
legacySunsetAt:     timestamp('legacy_sunset_at'),
```

Default `'legacy'` ensures zero breakage for all existing customers on deploy.

Run `npx drizzle-kit push` after merging to apply.

---

### 3.5 Proxied File Path Security (P1)

**Problem:** `.htaccess` `[P,L]` rewrite rules proxy `llms.txt`, `llms-full.txt`, and `.well-known/ucp.json` from FBQ with no content-type enforcement. A compromised FBQ can return HTML at these paths.

**Fix (Apache):** Add `Header always set Content-Type` and `X-Content-Type-Options: nosniff` after each rewrite rule. Apache overrides the proxied response's content-type regardless of what FBQ returns.

```apache
RewriteRule ^llms\.txt$ https://geo.flowblinq.com/api/serve/<slug>/llms.txt [P,L]
Header always set Content-Type "text/plain; charset=utf-8"
Header always set X-Content-Type-Options "nosniff"

RewriteRule ^\.well-known/ucp\.json$ https://geo.flowblinq.com/api/serve/<slug>/business.json [P,L]
Header always set Content-Type "application/json; charset=utf-8"
Header always set X-Content-Type-Options "nosniff"
# UCP spec requires max-age=60 exactly — not 3600
Header always set Cache-Control "public, max-age=60"
```

**Platform coverage:** Nginx, WordPress, Cloudflare Workers, and managed platforms (Shopify App Proxy, etc.) — full snippets in `docs/integration/`.

**UCP spec compliance:** Audit `app/api/serve/[slug]/business.json/route.ts` to confirm it emits `Cache-Control: public, max-age=60` (not 3600) and does not issue any 3xx redirects. Both are required by the UCP specification.

---

### 3.6 Versioned Beacon URL + SRI (P1)

**File:** `app/api/t/v[version]/[slug]/route.ts` (new)

For Tier 1 platforms (Apache/Nginx/WordPress VPS), publish a versioned beacon URL:

```
https://geo.flowblinq.com/api/t/v1.0.3/manipalhospitals-com--GzFX1
```

Customers can pin this URL with a SHA-384 SRI hash:

```html
<script
  src="https://geo.flowblinq.com/api/t/v1.0.3/{slug}"
  integrity="sha384-{HASH}"
  crossorigin="anonymous"
  async></script>
```

Publish hashes at `GET /.well-known/fbq-sri.json` (per slug) so customers can automate hash pinning in CI.

---

### 3.7 Middleware Updates (P0)

**File:** `middleware.ts`

Add to `ALWAYS_ALLOWED`:
- `/api/t/[slug]/token` — unauthenticated token generation
- Verify `/api/t/[slug]/collect` is present (should already be there as part of beacon collection)

Add environment guard for `/api/admin/` in the middleware itself — not just in `checkAdminAuth`. Defense-in-depth: if `checkAdminAuth` is ever refactored, the middleware guard prevents admin routes from being inadvertently exposed.

Update `middleware.test.ts` with tests for all new routes.

---

## 4. Backward Compatibility

All existing customers — including Manipal — send beacons without HMAC tokens. Rolling out token enforcement without a migration path would break every live integration on deploy.

### Migration model

Every `geoSite` row defaults to `securityMode: 'legacy'`. The collect endpoint behaviour by mode:

| Mode | Token present | Token absent |
|---|---|---|
| `legacy` | Validate token, accept if valid | Accept, log warning |
| `secure` | Validate token, accept if valid | 401 Token required |

Customers upgrade by:
1. Updating their `<script>` tag to the v2 beacon URL (which fetches tokens automatically)
2. A Flowblinq admin or dashboard toggle flips their row to `securityMode: 'secure'`

### Timeline
- **Phase 1 (this spec):** All new infrastructure ships. All existing customers in `legacy` mode. Zero breakage.
- **Phase 2 (~4 weeks post-ship):** Dashboard shows migration banner. Customers opt in to `secure` mode.
- **Phase 3 (~6 months post-ship):** Email all remaining `legacy` customers. Sunset date set. Auto-migrate on deadline.

### Sunset grace period
After the sunset date, the endpoint returns 429 (not 401) with a message for 90 days before hard-blocking. This prevents silent failures in case a customer misses the deadline.

---

## 5. Platform Integration Guide

### 5.1 What changes, and for whom

| Customer action required | Phase | Customers affected |
|---|---|---|
| None — server-side fix only | Phase 1 (ships with this spec) | All existing customers, including Manipal |
| Update `.htaccess` content-type headers | Phase 1 (recommended immediately) | Customers with Apache `[P,L]` rewrite rules (e.g. Manipal) |
| Update `<script>` tag to beacon v2 URL | Phase 2 (opt-in, ~4 weeks post-ship) | All customers who want HMAC token protection |
| Flip `securityMode` to `"secure"` | Phase 2 (after script updated) | Customers who have completed v2 upgrade |

### 5.2 Per-platform installation guides

---

#### Tier 0 — Cloudflare Workers (any platform)

Use this if your site is behind Cloudflare (free plan works). The Worker proxies the beacon first-party — the FBQ script never reaches visitor browsers, eliminating script supply-chain risk entirely. Works in front of Shopify, Squarespace, Wix, Apache, any origin.

**Step 1 — Deploy the Worker**

Copy the template from `scripts/cloudflare-worker/index.js` in the FBQ repo. Replace `YOUR_SLUG` with your site slug (find it in the Flowblinq dashboard under Integration → Slug).

In Cloudflare Dashboard → Workers → Create → paste the template → Deploy.

**Step 2 — Add a route**

In Cloudflare Dashboard → Workers → Routes, add:
```
yourdomain.com/fbq/*   →   your-worker-name
```

**Step 3 — Update your script tag**

Replace your existing FBQ `<script>` tag:
```html
<!-- Before -->
<script src="https://geo.flowblinq.com/api/t/YOUR_SLUG" async></script>

<!-- After -->
<script src="/fbq/beacon.js" async></script>
```

**Step 4 — Add CSP header (optional but recommended)**

In Cloudflare Dashboard → Rules → Transform Rules → Response Header Modification:
- Header name: `Content-Security-Policy`
- Value: `script-src 'self'; connect-src 'self'`
- Action: Set

**Verification:** Open browser DevTools → Network → reload page. The beacon script should load from your own domain, not `geo.flowblinq.com`.

---

#### Tier 1a — Apache VPS / Shared Hosting (Manipal-style)

**Phase 1 — Add content-type headers to existing `.htaccess`** (do this now, no other changes needed)

Find the three FBQ rewrite rules in your `.htaccess` and add `Header always set` lines immediately after each:

```apache
# Find these existing lines and add the Header directives below each one:

RewriteRule ^llms\.txt$ https://geo.flowblinq.com/api/serve/YOUR_SLUG/llms.txt [P,L]
Header always set Content-Type "text/plain; charset=utf-8"
Header always set X-Content-Type-Options "nosniff"

RewriteRule ^llms-full\.txt$ https://geo.flowblinq.com/api/serve/YOUR_SLUG/llms-full.txt [P,L]
Header always set Content-Type "text/plain; charset=utf-8"
Header always set X-Content-Type-Options "nosniff"

RewriteRule ^\.well-known/ucp\.json$ https://geo.flowblinq.com/api/serve/YOUR_SLUG/business.json [P,L]
Header always set Content-Type "application/json; charset=utf-8"
Header always set X-Content-Type-Options "nosniff"
Header always set Cache-Control "public, max-age=60"
```

**Phase 2 — Update beacon script tag in `header.php`** (when ready to upgrade to secure mode)

```php
<!-- Before (beacon v1 — continues to work in legacy mode) -->
<script
  src="https://geo.flowblinq.com/api/t/YOUR_SLUG"
  async></script>

<!-- After (beacon v2 — enables HMAC token protection) -->
<script
  src="https://geo.flowblinq.com/api/t/v2/YOUR_SLUG"
  async></script>
```

**Optional: SRI hash pinning** (highest security — ask Flowblinq for current hash)

```php
<script
  src="https://geo.flowblinq.com/api/t/v2.0.1/YOUR_SLUG"
  integrity="sha384-HASH_FROM_FLOWBLINQ"
  crossorigin="anonymous"
  async></script>
```

**Optional: CSP header** (add to `.htaccess`)

```apache
<IfModule mod_headers.c>
  Header always set Content-Security-Policy "script-src 'self' geo.flowblinq.com; connect-src geo.flowblinq.com"
</IfModule>
```

**Verification:** `curl -I https://yourdomain.com/llms.txt` — confirm `Content-Type: text/plain` and `X-Content-Type-Options: nosniff`.

---

#### Tier 1b — Nginx VPS

**Phase 1 — Add content-type overrides to `nginx.conf`**

```nginx
location = /llms.txt {
    proxy_pass https://geo.flowblinq.com/api/serve/YOUR_SLUG/llms.txt;
    proxy_ssl_verify on;
    add_header Content-Type "text/plain; charset=utf-8" always;
    add_header X-Content-Type-Options "nosniff" always;
    proxy_hide_header Content-Type;
}

location = /llms-full.txt {
    proxy_pass https://geo.flowblinq.com/api/serve/YOUR_SLUG/llms-full.txt;
    proxy_ssl_verify on;
    add_header Content-Type "text/plain; charset=utf-8" always;
    add_header X-Content-Type-Options "nosniff" always;
    proxy_hide_header Content-Type;
}

location = /.well-known/ucp.json {
    proxy_pass https://geo.flowblinq.com/api/serve/YOUR_SLUG/business.json;
    proxy_ssl_verify on;
    add_header Content-Type "application/json; charset=utf-8" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Cache-Control "public, max-age=60" always;
    proxy_hide_header Content-Type;
}
```

Run `nginx -t && nginx -s reload` after editing.

**Phase 2 — Update script tag** (same as Apache v2 snippet above).

---

#### Tier 1c — WordPress (self-hosted, VPS)

**Phase 1 — Add content-type enforcement** (add to `functions.php` or a custom plugin)

```php
add_action('template_redirect', function() {
    $map = [
        '/llms.txt'          => ['https://geo.flowblinq.com/api/serve/YOUR_SLUG/llms.txt', 'text/plain'],
        '/llms-full.txt'     => ['https://geo.flowblinq.com/api/serve/YOUR_SLUG/llms-full.txt', 'text/plain'],
        '/.well-known/ucp.json' => ['https://geo.flowblinq.com/api/serve/YOUR_SLUG/business.json', 'application/json'],
    ];

    $path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    if (!array_key_exists($path, $map)) return; // explicit allowlist — never expand to variables

    [$upstream, $ctype] = $map[$path];
    $resp = wp_remote_get($upstream, ['timeout' => 3]);

    header("Content-Type: $ctype; charset=utf-8");
    header('X-Content-Type-Options: nosniff');
    if ($ctype === 'application/json') header('Cache-Control: public, max-age=60');
    echo wp_remote_retrieve_body($resp);
    exit;
});
```

**Phase 2 — Update script tag** (in theme's `header.php` or via `wp_enqueue_script`)

```php
// In functions.php
function fbq_enqueue_beacon() {
    wp_enqueue_script('fbq-beacon', 'https://geo.flowblinq.com/api/t/v2/YOUR_SLUG', [], null, false);
}
add_action('wp_enqueue_scripts', 'fbq_enqueue_beacon');
```

**WordPress managed (WP Engine):** `.htaccess` is not supported. Add the CSP header via WP Engine Portal → Web Rules Engine → Header rules tab. Set `Content-Security-Policy` to `script-src 'self' geo.flowblinq.com`.

**WordPress managed (Kinsta):** Submit a support ticket to add `add_header Content-Security-Policy` to the Nginx config. The script tag PHP change is the same.

---

#### Tier 1d — WooCommerce / Magento 2

Same as WordPress (WooCommerce) or Nginx VPS (Magento 2). Magento 2 has built-in CSP support (v2.3.5+) — add `geo.flowblinq.com` to `script-src` via `csp_whitelist.xml` in your custom module instead of a separate header rule.

---

#### Tier 2a — Wix

**Phase 1 — No action required.** The schema.json fix is server-side.

**Phase 2 — Update script tag** via Wix Editor → Settings → Advanced → Custom Code → Head Code:

```html
<script src="https://geo.flowblinq.com/api/t/v2/YOUR_SLUG" async></script>
```

**For enhanced security (Cloudflare required):** Put Cloudflare in front of your Wix site (free plan). The Cloudflare Worker template (Tier 0 above) then handles first-party proxying and CSP injection without any Wix-specific work.

**llms.txt / ucp.json:** Wix cannot serve files at root paths. Two options:
1. Cloudflare Worker (recommended — Worker intercepts `/llms.txt` before reaching Wix)
2. Submit your Flowblinq-hosted URL directly to AI crawlers: `https://geo.flowblinq.com/api/serve/YOUR_SLUG/llms.txt`

---

#### Tier 2b — Squarespace

**Phase 1 — No action required.**

**Phase 2 — Update script tag** via Settings → Advanced → Code Injection → Header:

```html
<script src="https://geo.flowblinq.com/api/t/v2/YOUR_SLUG" async></script>
```

**For enhanced security:** Squarespace locks CSP headers. Use Cloudflare (Tier 0) for CSP control and first-party proxy.

**llms.txt / ucp.json:** Same as Wix — Cloudflare Worker or canonical FBQ URL.

---

#### Tier 2c — Webflow

**Phase 2 — Update script tag** via Project Settings → Custom Code → Head Code:

```html
<script src="https://geo.flowblinq.com/api/t/v2/YOUR_SLUG" async></script>
```

**CSP:** Standard Webflow plans lock CSP. Enterprise plans can set it via Dashboard → Security Headers. Non-Enterprise: use Cloudflare.

**llms.txt:** Place a static file in Webflow's `public/` folder (Designer → Assets). File name `llms.txt` served at `yourdomain.com/llms.txt`. Contents: copy from Flowblinq dashboard → Integration → llms.txt content.

---

#### Tier 2d — Framer

**Phase 2 — Update script tag** via Canvas → Settings → General → Custom Code → Head:

```html
<script src="https://geo.flowblinq.com/api/t/v2/YOUR_SLUG" async></script>
```

**CSP:** Framer Pro+ supports custom headers via Dashboard → Domain → Headers tab. Request `Content-Security-Policy` to be added to the whitelist via Framer support, then set `script-src 'self' geo.flowblinq.com`.

---

#### Tier 3a — Shopify

Shopify deprecated ScriptTag API (sunset: Aug 2026 for non-Plus). The replacement is the **Web Pixels API**, which runs in a sandboxed Web Worker — more secure than a page-level script tag.

**Phase 2 — Register a Web Pixel**

In Shopify Partner Dashboard → Your App → Web Pixels → Add pixel:

```javascript
// Pixel code (runs in sandboxed Web Worker — no DOM access)
const slug = 'YOUR_SLUG';

async function sendBeacon(eventName, eventData) {
  // Fetch a short-lived token
  const tokenResp = await fetch(`https://geo.flowblinq.com/api/t/${slug}/token`);
  const { token } = await tokenResp.json();

  // Send beacon
  await fetch(`https://geo.flowblinq.com/api/t/${slug}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page_url: document.location?.href ?? '',
      referrer: document.referrer ?? '',
      visitor_id: analytics.subscribe ? 'shopify-pixel' : 'unknown',
      timestamp: new Date().toISOString(),
      beacon_token: token,
    }),
  });
}

analytics.subscribe('page_viewed', sendBeacon);
```

**llms.txt / ucp.json:** Use Shopify App Proxy. In your app config, add a proxy subpath `/a/flowblinq` pointing to `https://geo.flowblinq.com/api/serve/YOUR_SLUG`. Shopify then serves `yourstore.com/a/flowblinq/llms.txt`.

---

#### Tier 3b — BigCommerce

**Phase 2 — Add script via Script Manager**

BigCommerce Dashboard → Storefront → Script Manager → Create Script:
- Name: `Flowblinq GEO Beacon v2`
- Location: `<head>`
- Script type: Script
- Script contents: `<script src="https://geo.flowblinq.com/api/t/v2/YOUR_SLUG" async></script>`

**CSP:** Enable PCI DSS 4.0 nonce protection in BigCommerce dashboard if on a supported plan.

---

#### Next.js / Vercel

**Phase 2 — Update `<Script>` component** (or `next.config.js` headers):

```tsx
// In layout.tsx or _document.tsx
import Script from 'next/script';
<Script src="https://geo.flowblinq.com/api/t/v2/YOUR_SLUG" strategy="afterInteractive" />
```

**CSP via `next.config.js`:**

```javascript
async headers() {
  return [{
    source: '/(.*)',
    headers: [{
      key: 'Content-Security-Policy',
      value: "script-src 'self' geo.flowblinq.com; connect-src 'self' geo.flowblinq.com"
    }]
  }]
}
```

**llms.txt:** Place `public/llms.txt` in your repo root. It will be served at `yourdomain.com/llms.txt` automatically by Next.js/Vercel.

---

### 5.3 Platform capability summary

| Platform | Phase 1 action | Phase 2 action | CSP path | llms.txt path |
|---|---|---|---|---|
| Apache VPS | Add Header directives to `.htaccess` | Update `<script>` tag | `mod_headers` | `.htaccess` rewrite |
| Nginx VPS | Add `add_header` to nginx.conf | Update `<script>` tag | `add_header` | `proxy_pass` location |
| WordPress VPS | Add `template_redirect` hook | Update `wp_enqueue_script` | `.htaccess` or plugin | Plugin rewrite |
| WP Engine / Kinsta | None | Update script tag | Web Rules Engine / support ticket | Plugin rewrite |
| Wix | None | Update Head code | Cloudflare Transform Rule | Cloudflare Worker |
| Squarespace | None | Update Code Injection | Cloudflare Transform Rule | Cloudflare Worker |
| Webflow | None | Update Custom Code | Cloudflare or Enterprise | Static asset upload |
| Framer | None | Update Head custom code | Dashboard (Pro+ with request) | Cloudflare Worker |
| Shopify | None | Register Web Pixel | Shopify managed | App Proxy |
| BigCommerce | None | Script Manager | Dashboard nonce toggle | N/A (no App Proxy) |
| Next.js / Vercel | None | Update `<Script>` | `next.config.js` | `public/llms.txt` |
| Any + Cloudflare | None | Deploy Worker template | Transform Rule | Worker route |

---

## 6. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BEACON_HMAC_SECRET` | Yes | Primary signing key (min 32 random bytes) |
| `BEACON_HMAC_SECRET_PREV` | No | Previous key during rotation window |

Both must be set in Vercel environment variables manually (production + preview).

---

## 7. Out-of-Scope Notes (tracked separately)

**Prompt injection:** The pipeline feeds Firecrawl-crawled page content directly into OpenAI prompts. A malicious customer controlling crawled content could inject prompt strings. Mitigation: wrap all crawled content in `<page_content>...</page_content>` delimiters in every prompt and add a system instruction treating content between those tags as untrusted data. This is a separate issue from this spec.

**Admin endpoint guard:** `lib/pipeline-studio/admin-auth.ts` is the sole guard for `/api/admin/` routes. Adding a middleware-level environment check is included in § 3.7 as defense-in-depth.

---

## 8. Verification Checklist

### P0 — Schema injection (verify against production immediately)
- [ ] `curl https://geo.flowblinq.com/api/serve/{slug}/schema.json` — body must NOT contain literal `</script>`, must contain `\u003c`
- [ ] Same check on `schema.js` route

### HMAC token
- [ ] GET `/api/t/{slug}/token` → token starts with `v1.`, `expiresAt` ~5 min from now
- [ ] POST `/api/t/{slug}/collect` with valid token → 204, empty body
- [ ] POST without token, site in `legacy` mode → 204 (accepted)
- [ ] POST without token, site in `secure` mode → 401
- [ ] POST with expired token → 401
- [ ] POST with token for slug A, URL slug B → 403
- [ ] POST with 1-byte signature (length mismatch) → 401, no RangeError in logs

### CORS / Origin
- [ ] `OPTIONS /api/t/{slug}/collect` with unregistered `Origin` → 403, no CORS headers
- [ ] `OPTIONS` with registered `Origin` → 200, `Access-Control-Allow-Origin` = origin (not `*`)
- [ ] Suffix matching operates on parsed hostname only, not raw origin string

### Payload validation
- [ ] `page_url: "javascript:alert(1)"` → 400
- [ ] Extra unknown field → 400
- [ ] Payload > 16 KB → 413
- [ ] 1,001 POSTs / 10s for one slug → 429 with `Retry-After: 10`
- [ ] Two identical beacons (same 1-min bucket) → both 204, no dedup signal in body

### File paths
- [ ] `curl -I https://customer.com/.well-known/ucp.json` → `Cache-Control: public, max-age=60`, no 3xx
- [ ] `curl -I https://geo.flowblinq.com/api/serve/{slug}/business.json` → `Cache-Control: public, max-age=60`

### Middleware
- [ ] `docker run --rm geo-test` — all new routes pass allowlist test
- [ ] `/api/admin/` has environment guard in `middleware.ts`, not just in `admin-auth.ts`

### Cloudflare Worker template
- [ ] Published template does NOT spread `request.headers` — only `FORWARDED_HEADERS` allowlist forwarded
