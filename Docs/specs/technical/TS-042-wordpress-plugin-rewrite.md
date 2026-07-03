# TS-042 — WordPress Plugin Rewrite: Proxy Architecture

## What

Complete rewrite of the `flowblinq-geo` WordPress plugin. The current plugin incorrectly copies GEO files (schema JSON, llms.txt) into `wp_options` and serves them locally. The correct architecture is a **thin proxy**: WordPress rewrite rules catch requests to well-known paths and proxy them to `geo.flowblinq.com/api/serve/{slug}/...`, with transient caching. Files always live on our platform.

## Why

The current implementation contradicts the geo platform's architecture. The platform generates and hosts files at `/api/serve/{slug}/*`. All other platform integrations (Vercel, Netlify, Cloudflare, Nginx, Apache) use rewrites/proxies to forward requests to our serve endpoints. The WordPress plugin should automate this same pattern rather than downloading and self-hosting the content.

## Current State (To Be Replaced)

The existing plugin:
- Fetches schema JSON and llms.txt from the API response URLs
- Stores them in `wp_options` (`fq_schema_blocks`, `fq_llms_txt_content`)
- Serves llms.txt from a WordPress rewrite rule reading from the database
- Injects schema JSON-LD from stored option on every `wp_head`

## New Architecture

### Core Concept

The plugin acts as a **transparent proxy with caching**:

```
AI crawler → example.com/llms.txt → WordPress rewrite → PHP handler
  → check transient cache (1hr TTL)
    → cache hit: serve from cache
    → cache miss: wp_remote_get("https://geo.flowblinq.com/api/serve/{slug}/llms.txt")
      → cache response in transient → serve
```

### Plugin Slug

The plugin needs the site's `{slug}` from the geo platform. The slug is returned in the audit API response and should be stored in `wp_options` as `fq_site_slug`.

### Settings Page (Settings → Flowblinq GEO)

**Fields:**
- Client ID (text input)
- Client Secret (password input, masked after save — HP-034 fix retained)
- Site Slug (read-only, auto-populated after first audit)
- Connection Status indicator (shows whether proxy is working)

**Behavior:**
- "Test Connection" button calls `GET /api/v1/account` to verify credentials
- Slug is populated automatically on first successful audit

### Proxy Endpoints

The plugin registers WordPress rewrite rules for these paths and handles them via `template_redirect`:

| WordPress Path | Proxied To | Content-Type | Cache TTL |
|---|---|---|---|
| `/llms.txt` | `geo.flowblinq.com/api/serve/{slug}/llms.txt` | text/plain | 1 hour |
| `/llms-full.txt` | `geo.flowblinq.com/api/serve/{slug}/llms-full.txt` | text/plain | 1 hour |
| `/.well-known/ucp.json` | `geo.flowblinq.com/api/serve/{slug}/business.json` | application/json | 1 hour |

**Transient cache keys:** `fq_proxy_{path_slug}` (e.g., `fq_proxy_llms_txt`)

**Cache invalidation:** Transients auto-expire after 1 hour. Manual "Clear Cache" button on settings page deletes all `fq_proxy_*` transients.

**Error handling:**
- If upstream returns non-200: return 502 with plain text "Service temporarily unavailable"
- If upstream times out (10s): return 504 with plain text "Gateway timeout"
- Never cache error responses

**Size limit:** Reject upstream responses > 512KB (consistent with HP-038 fix)

### Schema Injection

Schema JSON-LD blocks must be inline in `<head>` — they cannot be proxied as a file. The plugin fetches them server-side and injects them.

**Hook:** `wp_head` action

**Behavior:**
1. Check transient `fq_proxy_schema_json` (1 hour TTL)
2. On cache miss: `wp_remote_get("https://geo.flowblinq.com/api/serve/{slug}/schema.json")`
3. Response is a JSON array of schema objects
4. Validate: must be JSON array, each element must be an object, total size < 512KB
5. Cache the raw JSON string in transient
6. Output each element as `<script type="application/ld+json">...</script>`
7. Use `wp_json_encode($schema, JSON_HEX_TAG | JSON_UNESCAPED_SLASHES)` for output (HP-035 fix retained)

**If slug is not set:** Skip injection silently (plugin not yet configured)

### Robots.txt Integration

WordPress provides a `robots_txt` filter. The plugin appends AI crawler directives:

```
User-agent: GPTBot
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /.well-known/ucp.json

User-agent: ClaudeBot
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /.well-known/ucp.json

User-agent: PerplexityBot
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /.well-known/ucp.json
```

Only appended if `fq_site_slug` is set (plugin configured).

### Audit Flow (Tools → GEO Audit)

The audit UI flow remains similar but simplified:

1. **"Run Free Audit"** — `POST /api/v1/audit` with site URL
   - On success: store `audit_id` and `slug` (from response) in options
   - Start polling
2. **Poll loop** — `GET /api/v1/audit/{id}` every 5 seconds
   - Max 120 polls (10 minutes) — HP-041 fix retained
   - Display status and progress
3. **On completion:** Show scorecard, recommendations, overall score
   - The proxy endpoints are now automatically active (slug is set)
   - Show "Test Connection" button to verify `/llms.txt` is accessible
4. **"Verify My Changes"** — `POST /api/v1/audit/{id}/verify`
   - Triggers second run
   - Resumes polling
   - On completion: show before/after comparison

**Key difference from current:** No "Apply Optimizations" button. Once the audit completes and the slug is stored, the proxy is automatically active. The files are served from our platform via the rewrite rules.

### Plugin Lifecycle

**Activation:**
- Register all rewrite rules
- `flush_rewrite_rules()` (HP-040 fix retained)

**Deactivation:**
- `wp_clear_scheduled_hook()` for any scheduled events
- `flush_rewrite_rules()` (removes rewrite rules)

**Uninstall (uninstall.php):**
- Delete options: `fq_client_id`, `fq_client_secret`, `fq_site_slug`, `fq_active_audit_id`
- Delete transients: `fq_access_token`, `fq_proxy_llms_txt`, `fq_proxy_llms_full_txt`, `fq_proxy_business_json`, `fq_proxy_schema_json`
- `flush_rewrite_rules()`

### Security (All HP Fixes Retained)

| Concern | Mitigation |
|---|---|
| XSS in JSON-LD | `JSON_HEX_TAG` flag on `wp_json_encode()` |
| SSRF | All proxy targets are hardcoded to `geo.flowblinq.com` — no user-controlled URLs |
| Credential masking | Secret shown as `••••••••` after save |
| Nonces | Per-action nonces for each AJAX handler |
| Size limits | 512KB cap on all proxied responses |
| Poll timeout | MAX_POLLS = 120 (10 minutes) |
| Uninstall cleanup | All options and transients deleted |

**Note on SSRF:** The proxy architecture is inherently safer than the current design. Proxy targets are hardcoded constants — not extracted from API responses. The SSRF vector from HP-036 is eliminated by design, not just mitigated.

## File Structure

```
wordpress-plugin/
├── .gitignore
├── LICENSE
├── README.md
└── flowblinq-geo/
    ├── flowblinq-geo.php          # Plugin entry, hooks, activation/deactivation
    ├── uninstall.php              # Cleanup on deletion
    ├── includes/
    │   ├── class-api-client.php   # OAuth token + API calls (mostly unchanged)
    │   ├── class-admin-page.php   # Settings + audit UI (simplified, no "Apply" button)
    │   ├── class-proxy.php        # NEW — rewrite rules + proxy handlers + schema injection
    │   └── constants.php          # NEW — FQGEO_SERVE_BASE, proxy paths, cache TTLs
    ├── assets/
    │   ├── admin.css
    │   └── admin.js               # Simplified (no apply flow, just run + poll + verify)
    ├── languages/
    │   └── flowblinq-geo.pot
    └── readme.txt
```

## Dependencies

- WordPress ≥ 5.8
- PHP ≥ 7.4
- WordPress HTTP API (`wp_remote_get`)
- WordPress Transients API
- WordPress Rewrite API

No external dependencies. No Composer packages. No Node modules.

## Interfaces

### Options Stored in wp_options

| Option Key | Type | Purpose |
|---|---|---|
| `fq_client_id` | string | OAuth client ID |
| `fq_client_secret` | string | OAuth client secret |
| `fq_site_slug` | string | Site slug for serve endpoints |
| `fq_active_audit_id` | string | Current/last audit ID |

### Transients

| Transient Key | TTL | Purpose |
|---|---|---|
| `fq_access_token` | 3500s | Cached OAuth access token |
| `fq_proxy_llms_txt` | 3600s | Cached llms.txt content |
| `fq_proxy_llms_full_txt` | 3600s | Cached llms-full.txt content |
| `fq_proxy_business_json` | 3600s | Cached business.json content |
| `fq_proxy_schema_json` | 3600s | Cached schema.json content |

### Rewrite Rules

| Pattern | Query Var | Handler |
|---|---|---|
| `^llms\.txt$` | `fq_serve=llms_txt` | `Flowblinq_Proxy::handle_serve()` |
| `^llms-full\.txt$` | `fq_serve=llms_full_txt` | `Flowblinq_Proxy::handle_serve()` |
| `^\.well-known/ucp\.json$` | `fq_serve=business_json` | `Flowblinq_Proxy::handle_serve()` |

### Constants (constants.php)

```php
define( 'FQGEO_SERVE_BASE', 'https://geo.flowblinq.com/api/serve' );
define( 'FQGEO_PROXY_TIMEOUT', 10 );       // seconds
define( 'FQGEO_PROXY_MAX_SIZE', 524288 );   // 512KB
define( 'FQGEO_CACHE_TTL', 3600 );          // 1 hour
define( 'FQGEO_TOKEN_TTL', 3500 );          // just under 1hr
define( 'FQGEO_MAX_POLLS', 120 );           // 10 minutes at 5s intervals
```

### Serve URL Mapping

```php
$serve_map = [
    'llms_txt'      => [ 'path' => 'llms.txt',      'type' => 'text/plain; charset=utf-8' ],
    'llms_full_txt' => [ 'path' => 'llms-full.txt',  'type' => 'text/plain; charset=utf-8' ],
    'business_json' => [ 'path' => 'business.json',  'type' => 'application/json' ],
    'schema_json'   => [ 'path' => 'schema.json',    'type' => 'application/json' ],
];
```

## Acceptance Criteria

1. `GET example.com/llms.txt` returns content from `geo.flowblinq.com/api/serve/{slug}/llms.txt`
2. `GET example.com/llms-full.txt` returns content from the corresponding serve endpoint
3. `GET example.com/.well-known/ucp.json` returns content from the business.json serve endpoint
4. Schema JSON-LD blocks appear in `<head>` of every frontend page
5. Responses are cached in WordPress transients (1hr TTL)
6. Cache miss triggers a live fetch; cache hit serves from transient
7. robots.txt includes AI crawler Allow directives when plugin is configured
8. "Run Free Audit" flow works end-to-end: submit → poll → results → verify
9. No "Apply Optimizations" step — proxy activates automatically when slug is set
10. Plugin activation registers rewrite rules correctly (no 404 on first request)
11. Plugin uninstall removes all options and transients
12. All security fixes from HP-034 through HP-043 are preserved
13. No files are stored in `wp_options` — only credentials, slug, and audit ID
14. Upstream errors return 502/504 — never cached, never crash the site

## Risks

1. **Rewrite rule conflicts:** Other plugins or themes may register conflicting rules for `/llms.txt`. Mitigation: use `'top'` priority in `add_rewrite_rule()`.
2. **Cache stampede:** High-traffic sites may see many simultaneous requests when cache expires. Mitigation: acceptable at 1hr TTL; future enhancement could use stale-while-revalidate pattern.
3. **Upstream availability:** If `geo.flowblinq.com` is down, proxy returns 502. This is correct behavior — the content lives on our platform.
4. **Permalink structure:** Rewrite rules only work when WordPress uses "pretty permalinks" (not plain `?p=123`). Plugin should detect and warn if plain permalinks are active.

## What This Replaces

The following are **removed** from the current plugin:

- `Flowblinq_Injector` class (replaced by `Flowblinq_Proxy`)
- `inject_all()` method and the "Apply Optimizations" AJAX handler
- `fq_schema_blocks` option (schema is now fetched live + cached in transient)
- `fq_llms_txt_content` option (llms.txt is now proxied)
- `inject_schema_blocks()` / `register_llms_txt_rewrite()` (no more storing remote content)
- `inject_llms_txt_link()` (the phantom method that caused HP-044)
- `handle_ajax_apply()` AJAX handler
- `fqgeo_apply` nonce
- "Apply Optimizations" button in audit UI

## Out of Scope

- DNS domain verification (handled on geo.flowblinq.com dashboard, not in plugin)
- Paid tier / credits management
- WooCommerce integration
- Multisite support (future enhancement)
