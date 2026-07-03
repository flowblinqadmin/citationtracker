# ES-042 — WordPress Plugin Rewrite: Proxy Architecture

**Source:** TS-042-wordpress-plugin-rewrite.md
**Language:** PHP + JavaScript (WordPress plugin — no external dependencies)
**Status:** NEW (complete rewrite of `flowblinq-geo` plugin)

---

## a) Overview

The `flowblinq-geo` WordPress plugin currently downloads GEO files (schema JSON, llms.txt) from the platform and stores them in `wp_options`. This is architecturally wrong — all other platform integrations (Vercel, Netlify, Cloudflare) use rewrites/proxies to `geo.flowblinq.com/api/serve/{slug}/*`.

This spec covers a complete rewrite to a **thin proxy** architecture: WordPress rewrite rules catch requests to well-known paths and proxy them to `geo.flowblinq.com/api/serve/{slug}/...`, with transient caching (1hr TTL). Files always live on the platform; WordPress never stores content.

### Current state (to be replaced)

- `Flowblinq_Injector` class fetches and stores files in `wp_options`
- `inject_all()` called from "Apply Optimizations" AJAX handler
- `fq_schema_blocks` and `fq_llms_txt_content` options hold content
- Only `llms.txt` served via rewrite (at non-standard `/flowblinq-llms.txt` path)
- No support for `llms-full.txt`, `business.json`, or `/.well-known/ucp.json`

### What changes

| Removed | Replaced By |
|---------|-------------|
| `class-injector.php` | `class-proxy.php` (new) |
| `inject_all()` / "Apply Optimizations" flow | Automatic proxy via rewrite rules |
| `fq_schema_blocks` option | Transient `fq_proxy_schema_json` |
| `fq_llms_txt_content` option | Transient `fq_proxy_llms_txt` |
| `/flowblinq-llms.txt` path | `/llms.txt` (standard path) |
| `fqgeo_apply` AJAX handler + nonce | Removed entirely |

### What stays (mostly unchanged)

- `class-api-client.php` — OAuth token + API calls (unchanged)
- `class-admin-page.php` — Settings + audit UI (simplified: remove "Apply" button, add slug display, add "Clear Cache" + "Test Connection")
- `admin.css` — Minor additions for connection status indicator
- `admin.js` — Simplified (remove apply flow, add test connection + clear cache)

---

## b) Implementation Requirements

### File structure

```
wordpress-plugin/flowblinq-geo/
├── flowblinq-geo.php          # Plugin entry — MODIFY
├── uninstall.php              # Cleanup — MODIFY
├── includes/
│   ├── class-api-client.php   # OAuth + API — UNCHANGED
│   ├── class-admin-page.php   # Settings + audit UI — MODIFY
│   ├── class-proxy.php        # NEW — rewrite rules, proxy handlers, schema injection, robots.txt
│   └── constants.php          # NEW — all hardcoded constants
├── assets/
│   ├── admin.css              # MODIFY (add connection status styles)
│   └── admin.js               # MODIFY (remove apply, add test connection + clear cache)
├── languages/
│   └── flowblinq-geo.pot
└── readme.txt
```

### File 1: `includes/constants.php` (NEW)

```php
<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

define( 'FQGEO_SERVE_BASE', 'https://geo.flowblinq.com/api/serve' );
define( 'FQGEO_PROXY_TIMEOUT', 10 );       // seconds
define( 'FQGEO_PROXY_MAX_SIZE', 524288 );   // 512KB
define( 'FQGEO_CACHE_TTL', 3600 );          // 1 hour
define( 'FQGEO_TOKEN_TTL', 3500 );          // just under 1hr
define( 'FQGEO_MAX_POLLS', 120 );           // 10 minutes at 5s intervals
```

### File 2: `includes/class-proxy.php` (NEW)

**Class:** `Flowblinq_Proxy`

#### Constructor hooks

```php
public function __construct() {
    add_action( 'init',               [ $this, 'register_rewrite_rules' ] );
    add_filter( 'query_vars',         [ $this, 'register_query_vars' ] );
    add_action( 'template_redirect',  [ $this, 'handle_serve' ] );
    add_action( 'wp_head',            [ $this, 'inject_schema_jsonld' ] );
    add_filter( 'robots_txt',         [ $this, 'append_robots_directives' ], 10, 2 );
}
```

#### Property: `$serve_map`

```php
private static array $serve_map = [
    'llms_txt'      => [ 'path' => 'llms.txt',      'type' => 'text/plain; charset=utf-8' ],
    'llms_full_txt' => [ 'path' => 'llms-full.txt',  'type' => 'text/plain; charset=utf-8' ],
    'business_json' => [ 'path' => 'business.json',  'type' => 'application/json' ],
];
```

Note: `schema_json` is NOT in `$serve_map` — it is fetched separately for `wp_head` injection, not served as a rewrite endpoint.

#### Method: `register_rewrite_rules(): void`

Registers three rewrite rules at `'top'` priority:

```php
add_rewrite_rule( '^llms\.txt$',                'index.php?fq_serve=llms_txt', 'top' );
add_rewrite_rule( '^llms-full\.txt$',           'index.php?fq_serve=llms_full_txt', 'top' );
add_rewrite_rule( '^\.well-known/ucp\.json$',   'index.php?fq_serve=business_json', 'top' );
```

#### Method: `register_query_vars( array $vars ): array`

Adds `'fq_serve'` to WordPress query vars.

#### Method: `handle_serve(): void`

Main proxy handler, triggered on `template_redirect`:

1. Read `$key = get_query_var( 'fq_serve' )`. If empty, return (not our request).
2. If `$key` not in `self::$serve_map`, return.
3. Read `$slug = get_option( 'fq_site_slug', '' )`. If empty → `wp_die( 'Flowblinq GEO not configured', '', [ 'response' => 503 ] )`.
4. Check transient `fq_proxy_{$key}`:
   - **Cache hit:** `$content = get_transient( 'fq_proxy_' . $key )`. Serve it.
   - **Cache miss:** Call `$this->fetch_upstream( $key, $slug )`.
     - On success: set transient with `FQGEO_CACHE_TTL`, serve content.
     - On error: serve appropriate HTTP error (502 or 504) — **never cache errors**.
5. Output response:
   ```php
   status_header( 200 );
   header( 'Content-Type: ' . self::$serve_map[ $key ]['type'] );
   header( 'Cache-Control: public, max-age=3600' );
   header( 'X-Generator: FlowBlinq GEO' );
   echo $content; // plain-text/JSON body — not HTML, no escaping
   exit;
   ```

#### Method: `fetch_upstream( string $key, string $slug ): string|WP_Error`

Fetches content from `geo.flowblinq.com`:

1. Build URL: `FQGEO_SERVE_BASE . '/' . $slug . '/' . self::$serve_map[ $key ]['path']`
   - **SSRF hardening:** URL is built entirely from hardcoded constants + stored slug. No user-controlled URL components.
2. `wp_remote_get( $url, [ 'timeout' => FQGEO_PROXY_TIMEOUT ] )`
3. If `is_wp_error( $response )` → return `new WP_Error( 'fqgeo_upstream_timeout', 'Gateway timeout' )`
4. Check HTTP status: if not 200 → return `new WP_Error( 'fqgeo_upstream_error', 'Service temporarily unavailable' )`
5. Check body size: `strlen( $body ) > FQGEO_PROXY_MAX_SIZE` → return `new WP_Error( 'fqgeo_upstream_too_large', 'Response too large' )`
6. Return body string.

Error HTTP codes in `handle_serve()`:
- `WP_Error` with code `fqgeo_upstream_timeout` → HTTP 504, body: `"Gateway timeout"`
- All other `WP_Error` → HTTP 502, body: `"Service temporarily unavailable"`

#### Method: `inject_schema_jsonld(): void`

Hooked on `wp_head`. Injects schema JSON-LD into `<head>`:

1. `$slug = get_option( 'fq_site_slug', '' )`. If empty, return silently.
2. Check transient `fq_proxy_schema_json`:
   - **Cache hit:** `$raw = get_transient( 'fq_proxy_schema_json' )`.
   - **Cache miss:** `wp_remote_get( FQGEO_SERVE_BASE . '/' . $slug . '/schema.json', [ 'timeout' => FQGEO_PROXY_TIMEOUT ] )`
     - On error or non-200: return silently (don't break the page).
     - Check size: `strlen( $body ) > FQGEO_PROXY_MAX_SIZE` → return.
     - `json_decode( $body, true )` → must be an array. If not, return.
     - `set_transient( 'fq_proxy_schema_json', $body, FQGEO_CACHE_TTL )`.
     - `$raw = $body`.
3. `$schemas = json_decode( $raw, true )`. If not array, return.
4. For each `$schema` in `$schemas` (must be an object/assoc array):
   ```php
   echo '<script type="application/ld+json">'
       . wp_json_encode( $schema, JSON_HEX_TAG | JSON_UNESCAPED_SLASHES )
       . '</script>' . "\n";
   ```
   - `JSON_HEX_TAG` prevents `</script>` injection (HP-035 fix).
   - Each schema block gets its own `<script>` tag (not one big array).

#### Method: `append_robots_directives( string $output, bool $public ): string`

Hooked on `robots_txt` filter:

1. `$slug = get_option( 'fq_site_slug', '' )`. If empty, return `$output` unchanged.
2. Append AI crawler directives:
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
3. Return modified `$output`.

#### Static method: `clear_cache(): void`

Deletes all proxy transients:

```php
delete_transient( 'fq_proxy_llms_txt' );
delete_transient( 'fq_proxy_llms_full_txt' );
delete_transient( 'fq_proxy_business_json' );
delete_transient( 'fq_proxy_schema_json' );
```

### File 3: `flowblinq-geo.php` (MODIFY)

Changes:
1. Bump version: `'0.1.0'` → `'1.0.0'`
2. Add requires:
   ```php
   require_once FQGEO_PLUGIN_DIR . 'includes/constants.php';
   require_once FQGEO_PLUGIN_DIR . 'includes/class-proxy.php';
   ```
3. Remove: `require_once FQGEO_PLUGIN_DIR . 'includes/class-injector.php';`
4. Remove: `new Flowblinq_Injector();`
5. Add: `new Flowblinq_Proxy();` (outside `is_admin()` block — runs on all requests)
6. Update activation hook — register all three rewrite rules:
   ```php
   register_activation_hook( __FILE__, function () {
       $proxy = new Flowblinq_Proxy();
       $proxy->register_rewrite_rules();
       flush_rewrite_rules();
   } );
   ```
7. Deactivation hook — unchanged (already flushes rewrite rules + clears scheduled hooks).

### File 4: `includes/class-admin-page.php` (MODIFY)

#### Changes to constructor

- Remove: `add_action( 'wp_ajax_fqgeo_apply', ... )`
- Add: `add_action( 'wp_ajax_fqgeo_test_connection', [ $this, 'handle_ajax_test_connection' ] )`
- Add: `add_action( 'wp_ajax_fqgeo_clear_cache', [ $this, 'handle_ajax_clear_cache' ] )`

#### Changes to `enqueue_assets()`

- Load assets on BOTH `tools_page_fqgeo-audit` AND `settings_page_fqgeo-settings` hooks.
- Remove `nonce_apply` from `wp_localize_script`.
- Add `nonce_test` and `nonce_clear` nonces:
  ```php
  'nonce_test'  => wp_create_nonce( 'fqgeo_test_connection' ),
  'nonce_clear' => wp_create_nonce( 'fqgeo_clear_cache' ),
  ```
- Add `site_slug` to localized data: `'site_slug' => get_option( 'fq_site_slug', '' )`

#### Changes to `render_settings_page()`

Add after Client Secret field:

1. **Site Slug** — read-only field:
   ```php
   <tr>
       <th scope="row"><?php esc_html_e( 'Site Slug', 'flowblinq-geo' ); ?></th>
       <td>
           <?php $slug = get_option( 'fq_site_slug', '' ); ?>
           <code><?php echo $slug ? esc_html( $slug ) : esc_html__( '(auto-populated after first audit)', 'flowblinq-geo' ); ?></code>
       </td>
   </tr>
   ```

2. **Connection Status** — inline indicator:
   ```php
   <tr>
       <th scope="row"><?php esc_html_e( 'Proxy Status', 'flowblinq-geo' ); ?></th>
       <td>
           <span id="fqgeo-connection-status">—</span>
           <button type="button" id="fqgeo-test-connection" class="button"><?php esc_html_e( 'Test Connection', 'flowblinq-geo' ); ?></button>
           <button type="button" id="fqgeo-clear-cache" class="button"><?php esc_html_e( 'Clear Cache', 'flowblinq-geo' ); ?></button>
       </td>
   </tr>
   ```

3. **Permalink warning** — shown if plain permalinks are active:
   ```php
   <?php if ( ! get_option( 'permalink_structure' ) ) : ?>
       <div class="notice notice-error inline">
           <p><?php esc_html_e( 'Flowblinq GEO requires "pretty permalinks" to be enabled. Go to Settings → Permalinks and select any structure other than "Plain".', 'flowblinq-geo' ); ?></p>
       </div>
   <?php endif; ?>
   ```

#### Changes to `render_audit_page()`

- Remove the "Apply Optimizations" button entirely:
  ```html
  <!-- REMOVE: <button id="fqgeo-apply" ... -->
  ```
- After results render, show "Verify My Changes" immediately (no intermediate "Apply" step).
- Add proxy status note after scorecard:
  ```php
  <?php if ( get_option( 'fq_site_slug' ) ) : ?>
      <div class="notice notice-success inline">
          <p><?php esc_html_e( 'Proxy is active — your GEO files are being served automatically.', 'flowblinq-geo' ); ?></p>
      </div>
  <?php endif; ?>
  ```

#### Changes to `handle_ajax_run_audit()`

After storing `audit_id`, also store `slug` if present in response:

```php
if ( ! empty( $result['slug'] ) ) {
    update_option( 'fq_site_slug', sanitize_text_field( $result['slug'] ) );
}
```

#### Remove: `handle_ajax_apply()`

Delete entirely. This method and the `Flowblinq_Injector` dependency are removed.

#### New: `handle_ajax_test_connection(): void`

```php
public function handle_ajax_test_connection(): void {
    $this->verify_request( 'fqgeo_test_connection' );

    $slug = get_option( 'fq_site_slug', '' );
    if ( ! $slug ) {
        wp_send_json_error( [ 'message' => 'Site slug not configured. Run an audit first.' ] );
    }

    // Test by fetching llms.txt from upstream
    $url      = FQGEO_SERVE_BASE . '/' . $slug . '/llms.txt';
    $response = wp_remote_get( $url, [ 'timeout' => FQGEO_PROXY_TIMEOUT ] );

    if ( is_wp_error( $response ) ) {
        wp_send_json_error( [ 'message' => 'Connection failed: ' . $response->get_error_message() ] );
    }

    $code = wp_remote_retrieve_response_code( $response );
    if ( $code === 200 ) {
        wp_send_json_success( [ 'message' => 'Connected — proxy is working.' ] );
    } else {
        wp_send_json_error( [ 'message' => 'Upstream returned HTTP ' . $code ] );
    }
}
```

#### New: `handle_ajax_clear_cache(): void`

```php
public function handle_ajax_clear_cache(): void {
    $this->verify_request( 'fqgeo_clear_cache' );
    Flowblinq_Proxy::clear_cache();
    wp_send_json_success( [ 'message' => 'Cache cleared.' ] );
}
```

### File 5: `uninstall.php` (MODIFY)

Replace contents:

```php
<?php
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) { exit; }

// Options
delete_option( 'fq_client_id' );
delete_option( 'fq_client_secret' );
delete_option( 'fq_site_slug' );
delete_option( 'fq_active_audit_id' );

// Transients
delete_transient( 'fq_access_token' );
delete_transient( 'fq_proxy_llms_txt' );
delete_transient( 'fq_proxy_llms_full_txt' );
delete_transient( 'fq_proxy_business_json' );
delete_transient( 'fq_proxy_schema_json' );

flush_rewrite_rules();
```

Key changes vs current:
- Remove `fq_schema_blocks` and `fq_llms_txt_content` (no longer used)
- Add `fq_site_slug` option deletion
- Add all `fq_proxy_*` transient deletions

### File 6: `assets/admin.js` (MODIFY)

Complete rewrite. Key changes:

1. **Remove** all `$apply` references and the apply click handler.
2. **Remove** `nonce_apply` usage.
3. **Add** test connection handler:
   ```javascript
   $('#fqgeo-test-connection').on('click', function () {
       var $btn = $(this);
       var $status = $('#fqgeo-connection-status');
       $btn.prop('disabled', true);
       $status.text('Testing…');

       $.post(fqgeo.ajax_url, {
           action: 'fqgeo_test_connection',
           nonce:  fqgeo.nonce_test,
       }, function (resp) {
           $btn.prop('disabled', false);
           if (resp.success) {
               $status.text(resp.data.message).css('color', '#00a32a');
           } else {
               $status.text(resp.data.message).css('color', '#d63638');
           }
       });
   });
   ```

4. **Add** clear cache handler:
   ```javascript
   $('#fqgeo-clear-cache').on('click', function () {
       var $btn = $(this);
       $btn.prop('disabled', true);

       $.post(fqgeo.ajax_url, {
           action: 'fqgeo_clear_cache',
           nonce:  fqgeo.nonce_clear,
       }, function (resp) {
           $btn.prop('disabled', false);
           if (resp.success) {
               alert(resp.data.message);
           }
       });
   });
   ```

5. **Audit completion flow** — on `st === 'complete'`:
   - Show scorecard.
   - Show "Verify My Changes" button directly (no "Apply" step).
   - If `data.slug`: update `fqgeo.site_slug` in JS state.

6. **Verify flow** — unchanged (triggers second run, polls, shows before/after).

7. **`MAX_POLLS`** — use `fqgeo.max_polls || 120` (keep HP-041 fix).

### File 7: `assets/admin.css` (MODIFY)

Add connection status styles:

```css
#fqgeo-connection-status {
    display: inline-block;
    margin-right: 8px;
    font-weight: 600;
}

.notice.inline {
    margin: 8px 0;
}
```

### File 8: Delete `includes/class-injector.php`

This file is removed entirely. All its functionality is replaced by `class-proxy.php`.

---

## c) Unit Test Plan

**Test file:** `wordpress-plugin/flowblinq-geo/tests/test-proxy.php`

Uses WordPress test framework (`WP_UnitTestCase`).

### Tests for `Flowblinq_Proxy`

| # | Test | Input | Expected | Edge case? |
|---|------|-------|----------|------------|
| U1 | `register_rewrite_rules` adds 3 rules | Call method, inspect `$wp_rewrite->extra_rules_top` | 3 entries: `^llms\.txt$`, `^llms-full\.txt$`, `^\.well-known/ucp\.json$` | |
| U2 | `register_query_vars` adds `fq_serve` | Pass `['existing_var']` | Returns `['existing_var', 'fq_serve']` | |
| U3 | `handle_serve` — no query var | `fq_serve` not set | Returns without output | |
| U4 | `handle_serve` — invalid key | `fq_serve=invalid` | Returns without output | |
| U5 | `handle_serve` — no slug configured | `fq_serve=llms_txt`, no `fq_site_slug` | `wp_die()` with 503 | |
| U6 | `handle_serve` — cache hit | `fq_serve=llms_txt`, transient `fq_proxy_llms_txt` exists | Serves cached content, correct Content-Type | |
| U7 | `handle_serve` — cache miss, upstream 200 | Mock `wp_remote_get` → 200 | Fetches, caches in transient, serves | |
| U8 | `handle_serve` — upstream non-200 | Mock → 404 | HTTP 502, body = "Service temporarily unavailable" | |
| U9 | `handle_serve` — upstream timeout | Mock → WP_Error | HTTP 504, body = "Gateway timeout" | |
| U10 | `handle_serve` — upstream too large | Mock → 200 but body > 512KB | HTTP 502, not cached | Yes |
| U11 | `handle_serve` — error never cached | Mock → 500, then check transient | Transient not set | |
| U12 | `fetch_upstream` — correct URL built | `key=llms_txt`, `slug=my-site` | URL = `https://geo.flowblinq.com/api/serve/my-site/llms.txt` | |
| U13 | `fetch_upstream` — correct URL for business_json | `key=business_json`, `slug=my-site` | URL = `…/my-site/business.json` | |
| U14 | `inject_schema_jsonld` — no slug | `fq_site_slug` empty | No output | |
| U15 | `inject_schema_jsonld` — cache hit | Transient set with JSON array of 2 schemas | 2 `<script type="application/ld+json">` tags output | |
| U16 | `inject_schema_jsonld` — cache miss, valid JSON | Mock upstream → JSON array | Fetches, caches, outputs `<script>` tags | |
| U17 | `inject_schema_jsonld` — invalid JSON from upstream | Mock → non-JSON body | No output, no crash | |
| U18 | `inject_schema_jsonld` — non-array JSON | Mock → JSON object (not array) | No output | Yes |
| U19 | `inject_schema_jsonld` — JSON_HEX_TAG encoding | Schema contains `</script>` | Output uses `\u003C` not `</script>` | Security |
| U20 | `inject_schema_jsonld` — oversized | Mock → > 512KB | No output, no cache | |
| U21 | `append_robots_directives` — slug set | `fq_site_slug = 'my-site'` | Output includes GPTBot, ClaudeBot, PerplexityBot Allow directives | |
| U22 | `append_robots_directives` — no slug | Empty slug | Original output unchanged | |
| U23 | `clear_cache` — deletes all 4 transients | Set 4 transients, call `clear_cache()` | All 4 transients deleted | |

### Tests for `Flowblinq_Admin_Page` changes

| # | Test | Expected |
|---|------|----------|
| U24 | `handle_ajax_test_connection` — no slug | JSON error: "Site slug not configured" |
| U25 | `handle_ajax_test_connection` — upstream 200 | JSON success: "Connected" |
| U26 | `handle_ajax_test_connection` — upstream error | JSON error with HTTP code |
| U27 | `handle_ajax_clear_cache` — clears transients | `Flowblinq_Proxy::clear_cache()` called, JSON success |
| U28 | `handle_ajax_run_audit` — stores slug from response | Mock API returns `{ audit_id: '…', slug: 'my-site' }` → `fq_site_slug` option set |

### Tests for `uninstall.php`

| # | Test | Expected |
|---|------|----------|
| U29 | Uninstall deletes all options | `fq_client_id`, `fq_client_secret`, `fq_site_slug`, `fq_active_audit_id` deleted |
| U30 | Uninstall deletes all transients | All 5 transients deleted |

**Minimum coverage target:** 90% line coverage on `class-proxy.php`.

---

## d) Integration Test Plan

**Test file:** `wordpress-plugin/flowblinq-geo/tests/test-integration-proxy.php`

| # | Scenario | Flow |
|---|----------|------|
| IT1 | Full proxy flow: request → cache miss → upstream → cache → response | 1. Set `fq_site_slug`. 2. Request `/llms.txt`. 3. Verify upstream fetched. 4. Verify transient set. 5. Request again. 6. Verify served from cache (no upstream call). |
| IT2 | Audit → slug stored → proxy active | 1. Trigger audit AJAX. 2. Mock API returns slug. 3. Verify `fq_site_slug` stored. 4. Request `/llms.txt`. 5. Verify proxied. |
| IT3 | Schema injection end-to-end | 1. Set slug. 2. Mock schema.json upstream. 3. Render `wp_head`. 4. Verify `<script type="application/ld+json">` tags in output. |
| IT4 | Cache expiry → re-fetch | 1. Set transient with 1s TTL. 2. Wait for expiry. 3. Request again. 4. Verify upstream fetched. |
| IT5 | Activation → rewrite rules registered | 1. Activate plugin. 2. Verify rewrite rules present. 3. Request `/llms.txt`. 4. Verify no 404. |
| IT6 | Deactivation → rewrite rules removed | 1. Deactivate. 2. Verify `/llms.txt` returns 404. |
| IT7 | Uninstall cleanup | 1. Set options + transients. 2. Run uninstall. 3. Verify all deleted. |
| IT8 | robots.txt integration | 1. Set slug. 2. Request `robots.txt`. 3. Verify AI crawler directives present. |
| IT9 | Upstream error → 502, no cache | 1. Mock upstream 500. 2. Request `/llms.txt`. 3. Verify 502. 4. Verify no transient. 5. Mock upstream 200. 6. Request again. 7. Verify 200. |
| IT10 | `.well-known/ucp.json` path | 1. Set slug. 2. Request `/.well-known/ucp.json`. 3. Verify Content-Type: application/json. 4. Verify content from upstream business.json. |
| IT11 | Plain permalinks warning | 1. Set permalink_structure to empty. 2. Load settings page. 3. Verify warning notice rendered. |

---

## e) Profiling Requirements

| Metric | What to measure | Baseline |
|--------|-----------------|----------|
| Cache hit latency | Time from request to response when transient exists | < 10ms |
| Cache miss latency | Time from request through upstream fetch to response | < FQGEO_PROXY_TIMEOUT (10s) |
| Schema injection time | Time to decode + output N schema blocks in `wp_head` | < 5ms for 10 schemas |
| Memory | Peak PHP memory during proxy response | < 2MB additional |

**Tool:** WordPress Query Monitor plugin or custom `microtime()` instrumentation.

---

## f) Load Test Plan

| # | Scenario | Success criteria |
|---|----------|------------------|
| L1 | 100 concurrent requests to `/llms.txt` (warm cache) | p95 < 50ms, zero errors |
| L2 | Cache stampede: expire cache, 50 simultaneous requests | All get valid response, at most ~5 upstream calls (WordPress transient race is acceptable) |
| L3 | Upstream down: 100 requests with upstream timing out | All return 502/504 within 12s, no PHP fatal errors |

**Tool:** WP-CLI + Apache Bench (`ab`) or `wrk`.

---

## g) Logging & Instrumentation

| Event | Log level | When |
|-------|-----------|------|
| Proxy cache hit | DEBUG | `handle_serve()` serves from transient |
| Proxy cache miss + upstream fetch | INFO | `handle_serve()` fetches from upstream |
| Upstream error (non-200) | WARNING | `fetch_upstream()` receives non-200 |
| Upstream timeout | WARNING | `fetch_upstream()` gets WP_Error |
| Upstream response too large | WARNING | `fetch_upstream()` body > 512KB |
| Schema injection: N blocks output | DEBUG | `inject_schema_jsonld()` outputs N blocks |
| Schema fetch error | WARNING | `inject_schema_jsonld()` upstream error |
| Cache cleared | INFO | `clear_cache()` called |
| Slug stored from audit | INFO | `handle_ajax_run_audit()` stores slug |

**Implementation:** Use `error_log()` with `[Flowblinq GEO]` prefix. WordPress sites typically use `WP_DEBUG_LOG` for debug-level messages.

Format: `error_log( '[Flowblinq GEO] Proxy cache miss: ' . $key . ' → fetching from upstream' );`

---

## h) Acceptance Criteria

| # | Criterion | Spec section |
|---|-----------|--------------|
| AC1 | `GET /llms.txt` returns content from `geo.flowblinq.com/api/serve/{slug}/llms.txt` | §b File 2 |
| AC2 | `GET /llms-full.txt` returns content from the corresponding serve endpoint | §b File 2 |
| AC3 | `GET /.well-known/ucp.json` returns content from business.json serve endpoint | §b File 2 |
| AC4 | Schema JSON-LD blocks appear in `<head>` as individual `<script>` tags | §b File 2 |
| AC5 | Responses are cached in WordPress transients (1hr TTL) | §b File 2 |
| AC6 | Cache miss triggers live fetch; cache hit serves from transient | §b File 2 |
| AC7 | `robots.txt` includes GPTBot, ClaudeBot, PerplexityBot Allow directives when slug is set | §b File 2 |
| AC8 | "Run Free Audit" flow: submit → poll → results → verify (no "Apply" step) | §b Files 4, 6 |
| AC9 | Proxy activates automatically when slug is set from audit response | §b File 4 |
| AC10 | Plugin activation registers rewrite rules (no 404 on first request) | §b File 3 |
| AC11 | Plugin uninstall removes all options and transients | §b File 5 |
| AC12 | `JSON_HEX_TAG` used on schema output (HP-035 XSS fix preserved) | §b File 2 |
| AC13 | All proxy targets hardcoded to `geo.flowblinq.com` — no user-controlled URLs (SSRF safe) | §b File 2 |
| AC14 | Client secret masked as `••••••••` after save (HP-034 fix preserved) | §b File 4 |
| AC15 | 512KB size limit on all proxied responses (HP-038 fix preserved) | §b File 2 |
| AC16 | MAX_POLLS = 120 (HP-041 fix preserved) | §b File 6 |
| AC17 | Upstream errors return 502/504, never cached, never crash the site | §b File 2 |
| AC18 | No files stored in `wp_options` — only credentials, slug, and audit ID | §b Files 2, 5 |
| AC19 | `class-injector.php` deleted, all references removed | §b Files 3, 8 |
| AC20 | Per-action nonces for each AJAX handler (run, poll, verify, test_connection, clear_cache) | §b File 4 |
| AC21 | Settings page shows read-only slug field + connection status + clear cache button | §b File 4 |
| AC22 | Warning shown if plain permalinks are active | §b File 4 |

---

## ScriptDev Notes

1. **Rewrite rules require `flush_rewrite_rules()`** — this is called on activation. If developing locally, manually visit Settings → Permalinks after activating the plugin to force a flush.

2. **The `$serve_map` does not include `schema_json`** — schema is fetched and injected via `wp_head`, not served as a URL endpoint. Schema JSON-LD must be inline in HTML `<head>`.

3. **WordPress transients are the caching layer** — no Redis, no object cache plugins required. Transients auto-expire via WordPress core.

4. **Output in `handle_serve()`** — the body is plain text or JSON from a trusted upstream (our own platform). Do NOT apply `esc_html()` or `wp_kses()` — this would corrupt JSON and markdown content.

5. **`flush_rewrite_rules()` is expensive** — only call it on activation, deactivation, and uninstall. Never on every page load.

6. **The `.well-known/ucp.json` rewrite** — WordPress doesn't normally serve `.well-known` paths. The rewrite rule with `'top'` priority ensures WordPress catches this before falling through to a 404.

7. **Test connection** — tests upstream availability by fetching llms.txt (lightest endpoint). Does NOT require API credentials — serve endpoints are public.

8. **Audit response must return `slug`** — verify the `/api/v1/audit` POST response includes a `slug` field. If it doesn't, the slug needs to be obtained from the `/api/v1/account` response or a separate endpoint. The spec assumes `slug` is in the audit response per TS-042.
