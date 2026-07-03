# ES-044: WordPress Plugin — Integration Tests, Security Tests & Local Staging

**Source:** TS-043-wordpress-plugin-integration-security-tests.md
**Author:** SpecMaster (Agent 2)
**Date:** 2026-03-14
**Status:** Ready for review

---

## a) Overview

### What
Docker-based test infrastructure for the Flowblinq GEO WordPress plugin (`wordpress-plugin/flowblinq-geo/`). Produces:
- 40 integration tests (I1–I40) via PHPUnit `WP_UnitTestCase` against real WordPress + MySQL
- 30 security tests (S1–S30) for nonce, capability, XSS, SSRF, CSRF, SQLi, path traversal
- Mock upstream server simulating `geo.flowblinq.com`
- Local staging via Docker Compose (4 services)

### Current State
- Plugin source exists in `wordpress-plugin/flowblinq-geo/` (5 PHP source files, ES-042 complete)
- 30 standalone unit tests (U1–U30) exist in `flowblinq-geo/tests/test-proxy.php` using mock stubs — no real WP
- No `wordpress-plugin/testing/` directory exists yet
- `Flowblinq_API_Client::$base_url` is `private` and hardcoded to `https://geo.flowblinq.com` — tests need a way to redirect API calls to mock upstream

### Key Plugin Classes (reference)
| Class | File | Key Methods |
|-------|------|-------------|
| `Flowblinq_Proxy` | `includes/class-proxy.php` | `handle_serve()`, `fetch_upstream()`, `inject_schema_jsonld()`, `append_robots_directives()`, `clear_cache()` |
| `Flowblinq_API_Client` | `includes/class-api-client.php` | `get_token()`, `submit_audit()`, `get_audit()`, `verify_audit()` |
| `Flowblinq_Admin_Page` | `includes/class-admin-page.php` | `handle_ajax_run_audit()`, `handle_ajax_poll_audit()`, `handle_ajax_verify()`, `handle_ajax_test_connection()`, `handle_ajax_clear_cache()`, `verify_request()` |

### Constants (from `includes/constants.php`)
| Constant | Default | Note |
|----------|---------|------|
| `FQGEO_SERVE_BASE` | `https://geo.flowblinq.com/api/serve` | Overridable via `define()` before plugin load |
| `FQGEO_PROXY_TIMEOUT` | `10` | Seconds |
| `FQGEO_PROXY_MAX_SIZE` | `524288` | 512KB |
| `FQGEO_CACHE_TTL` | `3600` | 1 hour |
| `FQGEO_MAX_POLLS` | `120` | Client-side JS only |

---

## b) Implementation Requirements

### File Tree (all new files inside `wordpress-plugin/testing/`)

```
wordpress-plugin/testing/
├── docker-compose.yml
├── Dockerfile.wp-test
├── Dockerfile.mock
├── phpunit.xml
├── run-tests.sh
├── mock-upstream/
│   ├── server.php
│   └── fixtures/
│       ├── llms.txt
│       ├── llms-full.txt
│       ├── business.json
│       └── schema.json
├── integration/
│   ├── bootstrap-wp.php
│   └── test-integration.php
└── security/
    └── test-security.php
```

**~14 new files. Zero changes to plugin source** (see §b.10 for API client testability decision).

---

### b.1 Fixtures (`mock-upstream/fixtures/`)

All fixtures must be deterministic — no random data, no timestamps.

**`llms.txt`** (~200B):
```
# Flowblinq GEO Test Site

## Services
- AI Visibility Optimization
- GEO Audit Reports
- Citation Monitoring
```

**`llms-full.txt`** (~500B):
```
# Flowblinq GEO Test Site

## Services
- AI Visibility Optimization
- GEO Audit Reports
- Citation Monitoring

## Location
123 Test Street, Suite 100
San Francisco, CA 94105

## Contact
Email: test@example.com
Phone: (555) 123-4567

## Hours
Monday-Friday: 9:00 AM - 5:00 PM
Saturday-Sunday: Closed
```

**`business.json`** (~300B):
```json
{
  "name": "Flowblinq GEO Test Site",
  "url": "http://example.com",
  "services": ["AI Visibility Optimization", "GEO Audit Reports"],
  "location": {
    "street": "123 Test Street",
    "city": "San Francisco",
    "state": "CA",
    "zip": "94105"
  }
}
```

**`schema.json`** (~400B):
```json
[
  {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    "name": "Flowblinq GEO Test Site",
    "url": "http://example.com",
    "address": {
      "@type": "PostalAddress",
      "streetAddress": "123 Test Street",
      "addressLocality": "San Francisco",
      "addressRegion": "CA",
      "postalCode": "94105"
    }
  },
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": "Flowblinq GEO Test Site",
    "url": "http://example.com"
  }
]
```

---

### b.2 Mock Upstream Server (`mock-upstream/server.php`)

**Runtime:** `php -S 0.0.0.0:8080 server.php` (~120 lines)

**Logging:** All requests logged to `/tmp/mock-requests.log` with format: `[ISO-8601] METHOD URI`

#### Serve Routes

| Path Pattern | Response |
|---|---|
| `GET /api/serve/{slug}/llms.txt` | `fixtures/llms.txt`, `Content-Type: text/plain` |
| `GET /api/serve/{slug}/llms-full.txt` | `fixtures/llms-full.txt`, `Content-Type: text/plain` |
| `GET /api/serve/{slug}/business.json` | `fixtures/business.json`, `Content-Type: application/json` |
| `GET /api/serve/{slug}/schema.json` | `fixtures/schema.json`, `Content-Type: application/json` |

#### API Routes

| Path | Method | Response |
|---|---|---|
| `/api/oauth/token` | POST | `{"access_token":"mock-token-{random}","token_type":"Bearer","expires_in":3600}` |
| `/api/v1/audit` | POST | `{"audit_id":"audit-{random}","slug":"test-site-123","status":"pending"}` |
| `/api/v1/audit/{id}` | GET | Poll count < 3: `{"status":"pending","progress":33*poll}` / Poll ≥ 3: `{"status":"complete","scorecard":{"overallScore":75,"pillars":[]}}` |
| `/api/v1/audit/{id}/verify` | POST | `{"status":"complete","scorecard":{"overallScore":82,"pillars":[]}}` |

**Track poll counts per audit_id** in a file `/tmp/mock-poll-counts.json` (read/write on each poll request).

#### Special Slug Behaviors

| Slug | Behavior |
|---|---|
| `error-500` | HTTP 500, body `{"error":"internal_server_error"}` |
| `timeout` | `sleep(5)` then respond normally (triggers timeout at `FQGEO_PROXY_TIMEOUT=2`) |
| `oversized` | Returns 513KB body (513 × 1024 bytes of `x`) |
| `malformed` | Returns `not valid json at all` for `schema.json` |
| `xss-payload` | Returns schema with `</script><script>alert(1)</script>` in name field |
| `not-array` | Returns `{"@context":"https://schema.org","@type":"WebSite"}` (object, not array) |

#### Special OAuth Behaviors

| Condition | Response |
|---|---|
| `client_id=invalid` OR `client_secret=invalid` | HTTP 401, `{"error":"invalid_client"}` |
| Missing `client_id` or `client_secret` | HTTP 400, `{"error":"missing_credentials"}` |

#### Special Audit Behaviors

| Condition | Response |
|---|---|
| Audit ID `error-audit` on GET | HTTP 500 |
| POST URL containing `error500` | HTTP 500, `{"error":"audit_submit_failed"}` |

---

### b.3 Dockerfile.mock

```dockerfile
FROM php:8.3-cli
COPY mock-upstream/ /app/mock-upstream/
WORKDIR /app/mock-upstream
EXPOSE 8080
CMD ["php", "-S", "0.0.0.0:8080", "server.php"]
```

---

### b.4 Dockerfile.wp-test

Build on `wordpress:cli-php8.3`. Must include:
1. Composer install PHPUnit 10.x
2. WordPress test library via `install-wp-tests.sh` from `wp-cli/scaffold-command`
3. Plugin bind-mounted at `/app/plugin`
4. Test files copied to `/app/tests/`

**Entrypoint script:**
1. Wait for MySQL (loop `mysqladmin ping` with 2s interval, max 30 tries)
2. Run `install-wp-tests.sh` with DB credentials from env
3. Execute `vendor/bin/phpunit` with passed arguments

**Environment variables** (set in docker-compose):

| Var | Value |
|---|---|
| `WORDPRESS_DB_HOST` | `mysql` |
| `WORDPRESS_DB_NAME` | `wordpress_test` |
| `WORDPRESS_DB_USER` | `root` |
| `WORDPRESS_DB_PASSWORD` | `testpass` |
| `FQGEO_SERVE_BASE` | `http://mock-upstream:8080/api/serve` |
| `FQGEO_PROXY_TIMEOUT` | `5` |
| `WP_TESTS_DIR` | `/tmp/wordpress-tests-lib` |

---

### b.5 docker-compose.yml

4 services on network `fqgeo-test-net`:

| Service | Image | Ports | Purpose | Depends On |
|---|---|---|---|---|
| `mysql` | `mysql:8.0` | `3307:3306` | Database | — |
| `mock-upstream` | Build from `Dockerfile.mock` | `8081:8080` | Mock geo.flowblinq.com | — |
| `wordpress` | `wordpress:6.7-php8.3-apache` | `8080:80` | Live WP for staging | `mysql` (healthy) |
| `wp-test` | Build from `Dockerfile.wp-test` | — | Run tests | `mysql` (healthy), `mock-upstream` (started) |

**MySQL healthcheck:** `mysqladmin ping -h localhost -ptestpass`, interval 5s, timeout 5s, retries 10.

**MySQL env:**
- `MYSQL_ROOT_PASSWORD=testpass`
- `MYSQL_DATABASE=wordpress_test`

**WordPress env:**
- `WORDPRESS_DB_HOST=mysql`
- `WORDPRESS_DB_USER=root`
- `WORDPRESS_DB_PASSWORD=testpass`
- `WORDPRESS_DB_NAME=wordpress`

**Volumes:**
- Plugin source: `../flowblinq-geo:/var/www/html/wp-content/plugins/flowblinq-geo` (wordpress service)
- Plugin source: `../flowblinq-geo:/app/plugin` (wp-test service)
- MySQL data: named volume `mysql-data` (for staging persistence; `down -v` cleans up)

---

### b.6 Bootstrap (`integration/bootstrap-wp.php`)

```php
<?php
$_tests_dir = getenv('WP_TESTS_DIR') ?: '/tmp/wordpress-tests-lib';
require_once $_tests_dir . '/includes/functions.php';

tests_add_filter('muplugins_loaded', function () {
    // Define overridable constants BEFORE plugin loads
    if (!defined('FQGEO_SERVE_BASE')) {
        define('FQGEO_SERVE_BASE', getenv('FQGEO_SERVE_BASE') ?: 'http://mock-upstream:8080/api/serve');
    }
    if (!defined('FQGEO_PROXY_TIMEOUT')) {
        define('FQGEO_PROXY_TIMEOUT', (int)(getenv('FQGEO_PROXY_TIMEOUT') ?: 5));
    }
    require dirname(dirname(__DIR__)) . '/flowblinq-geo/flowblinq-geo.php';
});

require $_tests_dir . '/includes/bootstrap.php';
```

**Note:** The plugin's `constants.php` uses `if (!defined(...))` guards, so defining constants before plugin load works.

---

### b.7 phpunit.xml

```xml
<?xml version="1.0"?>
<phpunit bootstrap="integration/bootstrap-wp.php"
         colors="true"
         stopOnFailure="false"
         beStrictAboutTestsThatDoNotTestAnything="false">
  <testsuites>
    <testsuite name="integration">
      <file>integration/test-integration.php</file>
    </testsuite>
    <testsuite name="security">
      <file>security/test-security.php</file>
    </testsuite>
  </testsuites>
</phpunit>
```

---

### b.8 run-tests.sh

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

case "${1:-all}" in
  --integration) ARGS="--group integration" ;;
  --security)    ARGS="--group security" ;;
  --staging)     docker compose up -d; echo "Staging: http://localhost:8080"; exit 0 ;;
  --down)        docker compose down -v; exit 0 ;;
  all)           ARGS="" ;;
  *)             echo "Usage: $0 [--integration|--security|--staging|--down]"; exit 1 ;;
esac

docker compose up -d mysql mock-upstream
echo "Waiting for MySQL healthcheck..."
docker compose run --rm wp-test ${ARGS:-}
echo "Tests complete."
```

---

### b.9 API Client Testability

**Problem:** `Flowblinq_API_Client::$base_url` is `private` and hardcoded to `https://geo.flowblinq.com`. Integration tests need to redirect API calls to the mock upstream.

**Decision for ScriptDev — three options:**

1. **Option 1 (recommended):** Use WordPress `pre_http_request` filter to intercept and redirect. Zero plugin source changes. In `bootstrap-wp.php` or test `setUp()`:
   ```php
   add_filter('pre_http_request', function($preempt, $args, $url) {
       if (strpos($url, 'https://geo.flowblinq.com') === 0) {
           $new_url = str_replace('https://geo.flowblinq.com', 'http://mock-upstream:8080', $url);
           return wp_remote_request($new_url, $args);
       }
       return $preempt;
   }, 10, 3);
   ```
   **Caveat:** `pre_http_request` intercepts before the actual request. Returning a non-false value skips the real request. But we need to make a *different* request, not skip it. The correct approach is to use `http_request_args` filter combined with a URL rewrite, OR use `pre_http_request` to execute a manual `wp_remote_request` to the mock URL.

   **Simpler alternative:** Use `http_api_debug` or just accept that API client tests (I18–I31) test indirectly through AJAX handlers, where `FQGEO_SERVE_BASE` already points to mock for proxy tests, and API calls go to the hardcoded URL. To test API client in isolation, ScriptDev should use the `pre_http_request` filter approach.

2. **Option 2:** Change `$base_url` from `private` to `protected`, add `protected function get_base_url()` used in all methods. Test subclass overrides. 1 file changed, minimal diff.

3. **Option 3:** Accept constructor parameter with default: `public function __construct(string $client_id, string $client_secret, string $base_url = 'https://geo.flowblinq.com')`. Simplest change, 1 line.

**ScriptDev decides.** The spec works with any option — test assertions are the same regardless. The TS recommends Option 1 (filter) or Option 2 (subclass). Option 3 is also acceptable.

---

### b.10 X-Content-Type-Options Header

The existing `Flowblinq_Proxy::handle_serve()` does NOT set `X-Content-Type-Options: nosniff`. Security test S28 checks for it. Two choices:
1. Add it to the proxy (1-line change to `handle_serve()`)
2. Mark S28 as "expected to fail; requires plugin patch"

**Recommendation:** Add the header. It's a 1-line security improvement. ScriptDev should add `$this->send_header('X-Content-Type-Options: nosniff');` after the `X-Generator` header in `handle_serve()`.

---

## c) Unit Test Plan

**Not applicable** — this spec IS the test infrastructure. The existing 30 unit tests (U1–U30) in `flowblinq-geo/tests/test-proxy.php` continue to work independently. The new tests below (I1–I40, S1–S30) are integration/security tests.

---

## d) Integration Test Plan

**File:** `integration/test-integration.php`
**Class:** `Test_Integration extends WP_UnitTestCase`
**PHPUnit group:** `integration`

### setUp() — every test

```php
public function setUp(): void {
    parent::setUp();
    wp_cache_flush();  // prevent object cache leaks between tests
    // Reset mock upstream log
    $log_url = 'http://mock-upstream:8080/__reset_log';  // server.php should support this
    wp_remote_get($log_url, ['timeout' => 2]);
}
```

**Note:** Add a `GET /__reset_log` route to `server.php` that truncates `/tmp/mock-requests.log` and resets `/tmp/mock-poll-counts.json`.

### A. Proxy Routes (I1–I8)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| I1 | `test_proxy_llms_txt_cold_cache` | Set `fq_site_slug` option to `test-site-123`. Delete transient `fq_proxy_llms_txt`. | Call `handle_serve()` with query var `fq_serve=llms_txt` | Response 200. Body matches `fixtures/llms.txt` content. `Content-Type: text/plain`. Transient `fq_proxy_llms_txt` is now set. |
| I2 | `test_proxy_llms_txt_warm_cache` | Set `fq_site_slug`. Pre-populate transient `fq_proxy_llms_txt` = `"cached content"`. | Call `handle_serve()` with `fq_serve=llms_txt` | Returns `"cached content"`. Mock log shows zero new requests to `/api/serve/*/llms.txt`. |
| I3 | `test_proxy_llms_full_txt_cold` | Set slug. No transient. | `handle_serve()` with `fq_serve=llms_full_txt` | 200. Body matches `fixtures/llms-full.txt`. |
| I4 | `test_proxy_business_json_cold` | Set slug. No transient. | `handle_serve()` with `fq_serve=business_json` | 200. `Content-Type: application/json`. Body is valid JSON matching `fixtures/business.json`. |
| I5 | `test_proxy_upstream_500` | Set slug to `error-500`. | `handle_serve()` with `fq_serve=llms_txt` | Returns 502. Body NOT cached (transient not set). |
| I6 | `test_proxy_upstream_timeout` | Set slug to `timeout`. Override `FQGEO_PROXY_TIMEOUT` to 2 via `pre_http_request` filter that sets timeout to 2. | `handle_serve()` with `fq_serve=llms_txt` | Returns 504. **Note:** `FQGEO_PROXY_TIMEOUT` is a constant, already defined. To override for this test, use `pre_http_request` filter to add timeout override, OR define it to 2 in bootstrap. The mock sleeps 5s, so even timeout=5 should trigger if mock sleeps 5s. **ScriptDev:** set `FQGEO_PROXY_TIMEOUT` to 2 in bootstrap and mock sleeps 5s. This guarantees timeout. |
| I7 | `test_proxy_oversized_body` | Set slug to `oversized`. | `handle_serve()` with `fq_serve=llms_txt` | Returns 502. Body NOT cached. |
| I8 | `test_proxy_response_headers` | Set slug. Populate transient for each serve key. | Call `handle_serve()` for each of `llms_txt`, `llms_full_txt`, `business_json` | Each response has: correct `Content-Type`, `Cache-Control: public, max-age=3600`, `X-Generator: FlowBlinq GEO`. |

**How to call `handle_serve()` in integration tests:** Set `$_GET['fq_serve']` or use `set_query_var('fq_serve', $key)` (WP test lib provides `$this->go_to()`). Since `handle_serve()` uses `get_query_var()`, the test must either:
- Call `$this->go_to('/?fq_serve=llms_txt')` then invoke the `template_redirect` action
- OR instantiate `Flowblinq_Proxy` and call `handle_serve()` directly after setting the global query vars via `$wp_query->set('fq_serve', 'llms_txt')`

**Recommended approach:** Use `$this->go_to()` for realistic routing, then call `do_action('template_redirect')`. Capture output with `ob_start()`/`ob_get_clean()`. The proxy's `do_exit()` throws `Flowblinq_GEO_Exit_Exception` in test context — catch it.

**Wait — `Flowblinq_GEO_Exit_Exception`:** This exception class is defined in the standalone test bootstrap (`tests/bootstrap.php`), not in the plugin itself. The proxy checks `class_exists('Flowblinq_GEO_Exit_Exception', false)` to decide whether to call `exit()` or throw. For integration tests, ScriptDev must define this class in `bootstrap-wp.php`:
```php
class Flowblinq_GEO_Exit_Exception extends \RuntimeException {}
```
This enables the proxy to throw instead of calling `exit()`.

### B. Schema JSON-LD (I9–I14)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| I9 | `test_schema_jsonld_fresh_fetch` | Set slug to `test-site-123`. No transient, no stale option. | Call `inject_schema_jsonld()` | Output contains `<script type="application/ld+json">`. JSON inside is valid. Contains `LocalBusiness` and `WebSite` types. Transient `fq_proxy_schema_json` now set. |
| I10 | `test_schema_stale_while_revalidate` | Set slug. Delete transient `fq_proxy_schema_json`. Set option `_fq_stale_schema_json` to fixture content. | Call `inject_schema_jsonld()` | Serves stale content immediately. A `shutdown` action is registered for refresh. |
| I11 | `test_schema_stampede_lock` | Set slug. Delete transient. Set stale option. Set lock transient `_fq_lock_schema_json`. | Call `inject_schema_jsonld()` twice | Only 1 upstream request in mock log (lock prevents second fetch). Both calls produce output from stale. |
| I12 | `test_schema_malformed_json` | Set slug to `malformed`. No cache. | Call `inject_schema_jsonld()` | No `<script>` tags in output. |
| I13 | `test_schema_non_array_json` | Set slug to `not-array`. No cache. | Call `inject_schema_jsonld()` | No `<script>` tags in output (json_decode returns assoc array with `@context` key, but `$decoded[0]` check fails). |
| I14 | `test_schema_xss_escaping` | Set slug to `xss-payload`. No cache. | Call `inject_schema_jsonld()` | Output contains `\u003C`, NOT literal `</script>`. |

### C. Robots.txt (I15–I17)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| I15 | `test_robots_public_site` | Set slug. `update_option('blog_public', '1')`. | Call `append_robots_directives($existing, true)` | Contains `GPTBot`, `ClaudeBot`, `PerplexityBot` Allow directives. |
| I16 | `test_robots_private_site` | `update_option('blog_public', '0')`. | Call `append_robots_directives($existing, false)` | No AI directives appended. Output equals input. |
| I17 | `test_robots_no_slug` | No `fq_site_slug` option. | Call `append_robots_directives($existing, true)` | Output equals input. |

### D. OAuth (I18–I21)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| I18 | `test_token_acquisition` | Set `fq_client_id=test-id`, `fq_client_secret=test-secret`. Intercept HTTP to redirect to mock (see §b.9). | Call `get_token()` on API client | Returns string token. Mock log shows POST to `/api/oauth/token` with `grant_type=client_credentials`. |
| I19 | `test_token_caching` | Same setup. | Call `get_token()` twice | Second call returns cached transient `fq_access_token`. Mock log shows only 1 POST to `/api/oauth/token`. |
| I20 | `test_token_expiry_refetch` | Same setup. Call `get_token()` once, then `delete_transient('fq_access_token')`. | Call `get_token()` again | New HTTP request in mock log. Fresh token returned. |
| I21 | `test_token_invalid_credentials` | Set `fq_client_id=invalid`. Intercept HTTP. | Call `get_token()` | Returns `WP_Error` with code `fqgeo_token_error`. |

### E. Admin Settings (I22–I25)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| I22 | `test_settings_save` | Log in as admin. | Submit settings form with `fq_client_id=my-id`, `fq_client_secret=my-secret` via `wp_ajax` or direct `update_option` through settings API | Options stored: `get_option('fq_client_id') === 'my-id'`, `get_option('fq_client_secret') === 'my-secret'`. |
| I23 | `test_secret_masking` | Store real secret. | Submit `fq_client_secret=••••••••` through sanitize callback | `get_option('fq_client_secret')` still equals original secret (sanitize callback preserves). |
| I24 | `test_slug_validation` | Log in as admin. Set credentials. Intercept HTTP. | Submit audit where mock returns `slug=my-site-123` → accepted. Then submit where mock returns `slug=../etc/passwd` → rejected. | First: `fq_site_slug === 'my-site-123'`. Second: `wp_send_json_error` with 'Invalid slug format'. |
| I25 | `test_permalink_warning` | Set `permalink_structure` to empty. | Render settings page via `render_settings_page()` | Output contains `notice-error` div. |

### F. Audit Flow (I26–I31)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| I26 | `test_audit_submit` | Admin user, credentials set, nonce valid. Intercept HTTP. | Call `handle_ajax_run_audit()` | `fq_active_audit_id` option set. `fq_site_slug` set. `wp_send_json_success` with audit data. |
| I27 | `test_audit_poll_pending` | Set `$_POST['audit_id']` and nonce. Intercept HTTP. | Call `handle_ajax_poll_audit()` (first poll) | `status=pending`, progress < 100. |
| I28 | `test_audit_poll_complete` | Same, but call poll 3+ times (or use audit_id that mock returns complete for). | Call `handle_ajax_poll_audit()` | `status=complete`, scorecard present. |
| I29 | `test_audit_verify` | Set `$_POST['audit_id']` and nonce. Intercept HTTP. | Call `handle_ajax_verify()` | POST to `/api/v1/audit/{id}/verify`. Returns scorecard. |
| I30 | `test_audit_timeout_placeholder` | N/A | **Skip** — `FQGEO_MAX_POLLS` is client-side JS logic | Mark as `@group placeholder`. `$this->markTestSkipped('MAX_POLLS is client-side JS logic')`. |
| I31 | `test_audit_api_error` | Use audit_id `error-audit` for poll. URL containing `error500` for submit. | Call poll / submit | Returns error JSON. |

### G. AJAX Endpoints (I32–I36)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| I32 | `test_ajax_run_audit_valid` | Admin user. Valid nonce in `$_REQUEST['nonce']`. Credentials set. Intercept HTTP. | `handle_ajax_run_audit()` | `wp_send_json_success` with audit data. |
| I33 | `test_ajax_poll_audit_valid` | Admin. Nonce. `$_POST['audit_id']` set. Intercept HTTP. | `handle_ajax_poll_audit()` | Success JSON. |
| I34 | `test_ajax_verify_valid` | Admin. Nonce. `$_POST['audit_id']` set. Intercept HTTP. | `handle_ajax_verify()` | Success JSON. |
| I35 | `test_ajax_test_connection_valid` | Admin. Nonce. Slug set. | `handle_ajax_test_connection()` | Success with "Connected" (proxy test hits mock upstream via `FQGEO_SERVE_BASE`). |
| I36 | `test_ajax_clear_cache_valid` | Admin. Nonce. Pre-populate transients. | `handle_ajax_clear_cache()` | Success. All proxy transients deleted. |

### H. Lifecycle (I37–I40)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| I37 | `test_activation` | — | Trigger activation hook (call the registered callback) | Rewrite rules registered (check `$wp_rewrite->extra_rules_top` contains `llms\.txt`, `llms-full\.txt`, `\.well-known/ucp\.json`). `flush_rewrite_rules` was called. |
| I38 | `test_deactivation` | — | Trigger deactivation hook | `wp_clear_scheduled_hook('fqgeo_poll_audit')` was called. `flush_rewrite_rules` was called. Verify via `has_action` or mock tracking. |
| I39 | `test_uninstall` | Set all options and transients. | Include `uninstall.php` (define `WP_UNINSTALL_PLUGIN` first) | Options deleted: `fq_client_id`, `fq_client_secret`, `fq_site_slug`, `fq_active_audit_id`. Transients deleted: `fq_access_token`, `fq_proxy_llms_txt`, `fq_proxy_llms_full_txt`, `fq_proxy_business_json`, `fq_proxy_schema_json`. |
| I40 | `test_constant_overrides` | `FQGEO_SERVE_BASE` is already overridden in bootstrap. | Verify proxy `fetch_upstream` URL | URL starts with `http://mock-upstream:8080/api/serve/` (not `https://geo.flowblinq.com`). |

---

## e) Security Test Plan

**File:** `security/test-security.php`
**Class:** `Test_Security extends WP_UnitTestCase`
**PHPUnit group:** `security`

### setUp()

```php
public function setUp(): void {
    parent::setUp();
    wp_cache_flush();
    // Create test users
    $this->admin_id      = $this->factory->user->create(['role' => 'administrator']);
    $this->subscriber_id = $this->factory->user->create(['role' => 'subscriber']);
    $this->editor_id     = $this->factory->user->create(['role' => 'editor']);
    $this->author_id     = $this->factory->user->create(['role' => 'author']);
}
```

### A. Nonce Bypass (S1–S5)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| S1 | `test_nonce_missing_run_audit` | Log in as admin. Do NOT set `$_REQUEST['nonce']`. | `handle_ajax_run_audit()` | `wp_die` / 403. `check_ajax_referer` kills the request. |
| S2 | `test_nonce_missing_poll_audit` | Same — no nonce. | `handle_ajax_poll_audit()` | 403 |
| S3 | `test_nonce_missing_verify` | Same. | `handle_ajax_verify()` | 403 |
| S4 | `test_nonce_missing_test_connection` | Same. | `handle_ajax_test_connection()` | 403 |
| S5 | `test_nonce_missing_clear_cache` | Same. | `handle_ajax_clear_cache()` | 403 |

**Implementation note:** WordPress `check_ajax_referer` calls `wp_die()` with status 403 when nonce is missing/invalid. Use `$this->expectException('WPDieException')` or catch via `add_filter('wp_die_ajax_handler', ...)`.

### B. Capability Escalation (S6–S10)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| S6 | `test_subscriber_run_audit` | `wp_set_current_user($this->subscriber_id)`. Valid nonce. | `handle_ajax_run_audit()` | 403 via `current_user_can('manage_options')` check. |
| S7 | `test_editor_poll_audit` | `wp_set_current_user($this->editor_id)`. Valid nonce. | `handle_ajax_poll_audit()` | 403 |
| S8 | `test_author_verify` | `wp_set_current_user($this->author_id)`. Valid nonce. | `handle_ajax_verify()` | 403 |
| S9 | `test_subscriber_test_connection` | Subscriber. Valid nonce. | `handle_ajax_test_connection()` | 403 |
| S10 | `test_subscriber_clear_cache` | Subscriber. Valid nonce. | `handle_ajax_clear_cache()` | 403 |

**Implementation note:** The `verify_request()` method calls `wp_send_json_error(..., 403)` which sends JSON and exits. Catch via expected exception or output buffer capture.

### C. XSS (S11–S14)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| S11 | `test_xss_schema_script_tags` | Set slug to `xss-payload`. | `inject_schema_jsonld()` | Output uses `JSON_HEX_TAG` → `\u003C`. No literal `</script>` in output. |
| S12 | `test_xss_proxy_response_scripts` | Mock upstream returns body with `<script>alert(1)</script>` for llms.txt. | `handle_serve()` for `llms_txt` | Served as `text/plain; charset=utf-8`. Content is raw text, not executable. |
| S13 | `test_xss_slug_img_onerror` | Set slug to `<img onerror=alert(1)>` via `update_option`. | Call `handle_ajax_run_audit()` | Slug is validated by regex `^[a-z0-9\-]+$/i` — `wp_send_json_error` with 'Invalid slug format'. |
| S14 | `test_xss_slug_encoded` | Set slug to `%3Cscript%3E`. | Submit audit where mock returns this slug. | `sanitize_text_field` + regex rejects. |

### D. SSRF via Slug (S15–S17)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| S15 | `test_ssrf_path_traversal` | `update_option('fq_site_slug', '../../internal')`. | Call `fetch_upstream('llms_txt', '../../internal')` | URL contains `..%2F..%2Finternal` (rawurlencode), no actual traversal. |
| S16 | `test_ssrf_metadata_endpoint` | `update_option('fq_site_slug', 'http://169.254.169.254')`. | Call `fetch_upstream(...)` | URL is `FQGEO_SERVE_BASE/http%3A%2F%2F169.254.169.254/llms.txt` — encoded, no SSRF. |
| S17 | `test_ssrf_slash_encoding` | `update_option('fq_site_slug', 'my-site/../../admin')`. | Call `fetch_upstream(...)` | Slashes encoded: `my-site%2F..%2F..%2Fadmin`. |

### E. CSRF (S18)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| S18 | `test_csrf_settings_post_no_nonce` | POST to settings form without `_wpnonce`. | Settings API rejects. | WordPress `check_admin_referer` / `settings_fields` blocks the request. |

### F. SQL Injection (S19)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| S19 | `test_sqli_client_id` | `update_option('fq_client_id', "'; DROP TABLE wp_options; --")`. | `get_option('fq_client_id')` | Value round-trips safely. `wp_options` table still exists. No SQL error. |

### G. Path Traversal (S20–S21)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| S20 | `test_path_traversal_rewrite` | — | `GET /llms.txt/../wp-config.php` via `$this->go_to()` | Rewrite rule regex `^llms\.txt$` doesn't match. Returns 404. |
| S21 | `test_path_traversal_query_var` | Set `fq_serve=../../../wp-config` via query var. | `handle_serve()` | Not in `$serve_map` array → returns early, no output. |

### H. Response Splitting (S22)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| S22 | `test_response_splitting_crlf` | Mock upstream returns body with embedded `\r\nSet-Cookie: evil=1`. | Proxy serves the response. | Plugin only uses `wp_remote_retrieve_body()` and sets own headers via `send_header()`. No injected headers in response. |

### I. Token/Secret Exposure (S23–S24)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| S23 | `test_secret_not_in_html` | Store `fq_client_secret = 'super-secret-value'`. | Render settings page. | HTML contains `••••••••`, NOT `super-secret-value`. |
| S24 | `test_no_secrets_in_js` | Store credentials. | Capture `wp_localize_script` output (the `fqgeo` JS object). | Object keys do NOT include `client_id`, `client_secret`, or `access_token`. |

### J. Cache Poisoning (S25)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| S25 | `test_non_admin_clear_cache` | Subscriber user. Valid nonce. Pre-populate transients. | `handle_ajax_clear_cache()` | 403. Transients still present. |

### K. Other (S26–S30)

| ID | Method | Setup | Action | Assert |
|---|---|---|---|---|
| S26 | `test_audit_url_not_user_supplied` | Admin. Nonce. Intercept HTTP to verify request body. | `handle_ajax_run_audit()` | The URL sent to API is `get_site_url()`, NOT from `$_POST`. |
| S27 | `test_timing_safe_comparison` | — | — | `$this->markTestSkipped('Verified by WP core design: hash_equals used for nonce verification')` |
| S28 | `test_content_type_explicit` | Set slug. Populate transients for each serve key. | Call `handle_serve()` for each key. | Each response has explicit `Content-Type` from `$serve_map`. Check for `X-Content-Type-Options: nosniff` (requires plugin patch — see §b.10). |
| S29 | `test_empty_credentials_audit` | `fq_client_id` and `fq_client_secret` both empty. | `handle_ajax_run_audit()` | Returns `WP_Error` / error JSON. No crash, no null pointer exception. |
| S30 | `test_rapid_ajax_calls` | Admin. Valid nonce. | Call `handle_ajax_clear_cache()` 5 times sequentially. | All 5 succeed (nonce validation passes each time). No bypass on rapid fire. |

---

## f) Profiling Requirements

| Metric | Target | How to Measure |
|---|---|---|
| Full test suite runtime | < 60s after first build | `time docker compose run --rm wp-test` |
| Individual test case | < 2s each (except I6 timeout test ~5s) | PHPUnit `--log-junit` output |
| Docker image build | < 120s | `time docker compose build` |
| MySQL startup to healthy | < 15s | Healthcheck log |

---

## g) Load Test Plan

**Not applicable.** This is a test infrastructure spec, not a production service. The mock upstream and Docker Compose setup are development-only.

---

## h) Logging & Instrumentation

| Component | What to Log | Where |
|---|---|---|
| Mock upstream | All requests: `[timestamp] METHOD URI` | `/tmp/mock-requests.log` inside container |
| PHPUnit | Test results: pass/fail/skip per test | stdout + optional `--log-junit report.xml` |
| `run-tests.sh` | Start/stop timestamps, exit code | stdout |

---

## i) Acceptance Criteria

### Infrastructure (AC1–AC6)
- [ ] **AC1:** `docker compose build` succeeds for all 4 services
- [ ] **AC2:** `docker compose up -d` starts all services; MySQL passes healthcheck within 15s
- [ ] **AC3:** Mock upstream responds correctly to all serve routes (`/api/serve/{slug}/llms.txt` etc.)
- [ ] **AC4:** Mock upstream handles all special slug behaviors (error-500, timeout, oversized, malformed, xss-payload, not-array)
- [ ] **AC5:** Mock upstream handles OAuth and audit API routes correctly
- [ ] **AC6:** `docker compose down -v` cleans up completely (no orphan volumes or networks)

### Integration Tests (AC7–AC14)
- [ ] **AC7:** I1–I8 (proxy routes) all pass — cold cache, warm cache, error codes, headers
- [ ] **AC8:** I9–I14 (schema JSON-LD) all pass — fresh fetch, stale-while-revalidate, stampede lock, malformed, XSS
- [ ] **AC9:** I15–I17 (robots.txt) all pass — public/private/no-slug
- [ ] **AC10:** I18–I21 (OAuth) all pass — token acquisition, caching, expiry, invalid credentials
- [ ] **AC11:** I22–I25 (admin settings) all pass — save, masking, slug validation, permalink warning
- [ ] **AC12:** I26–I31 (audit flow) all pass (I30 skipped as placeholder)
- [ ] **AC13:** I32–I36 (AJAX endpoints) all pass — valid admin requests
- [ ] **AC14:** I37–I40 (lifecycle) all pass — activation, deactivation, uninstall, constant overrides

### Security Tests (AC15–AC22)
- [ ] **AC15:** S1–S5 (nonce bypass) all pass — missing nonce → 403
- [ ] **AC16:** S6–S10 (capability escalation) all pass — non-admin roles → 403
- [ ] **AC17:** S11–S14 (XSS) all pass — JSON_HEX_TAG, text/plain content type, regex rejection
- [ ] **AC18:** S15–S17 (SSRF) all pass — rawurlencode prevents traversal
- [ ] **AC19:** S18 (CSRF) passes — no-nonce settings POST rejected
- [ ] **AC20:** S19 (SQLi) passes — sanitize_text_field + safe round-trip
- [ ] **AC21:** S20–S21 (path traversal) pass — rewrite regex + serve_map gate
- [ ] **AC22:** S22–S30 (remaining) all pass — response splitting, secret exposure, cache poisoning, rapid fire

### Overall (AC23–AC26)
- [ ] **AC23:** `docker compose run --rm wp-test` exits 0 with 70 tests (40 integration + 30 security; I30 skipped)
- [ ] **AC24:** Zero tests depend on external network access — all HTTP goes to mock-upstream or localhost
- [ ] **AC25:** Tests complete in < 60 seconds after first build
- [ ] **AC26:** Staging mode works: WordPress accessible at `localhost:8080`, plugin activates, proxy routes serve mock content

---

## ScriptDev Notes

1. **Flowblinq_GEO_Exit_Exception:** Must be defined in `bootstrap-wp.php` so the proxy throws instead of calling `exit()` during tests.
2. **API client testability:** Choose one of the three options in §b.9. Option 1 (pre_http_request filter) requires zero plugin changes. Options 2/3 require a small change to `class-api-client.php`.
3. **AJAX testing pattern:** WordPress test lib provides `WPAjaxDieContinueException` and `WPAjaxDieStopException` for testing AJAX handlers. Use `$this->_handleAjax('fqgeo_run_audit')` or call handler methods directly.
4. **Mock log verification:** Use `file_get_contents('http://mock-upstream:8080/__log')` to read the log. Add a `GET /__log` route to `server.php` that returns the log contents. Add `GET /__reset_log` to clear it.
5. **I6 timeout test:** Bootstrap sets `FQGEO_PROXY_TIMEOUT=2`. Mock `timeout` slug sleeps 5s. This guarantees a timeout. Adjust if flaky.
6. **S28 nosniff header:** Requires adding `$this->send_header('X-Content-Type-Options: nosniff')` to `Flowblinq_Proxy::handle_serve()`. This is a 1-line plugin change. If ScriptDev defers this, mark S28 as `@group pending-plugin-patch`.
7. **Object cache flush:** Call `wp_cache_flush()` in every `setUp()` to prevent leaks between tests via WP's object cache.
8. **I39 uninstall test:** Must define `WP_UNINSTALL_PLUGIN` before including `uninstall.php`. The constant is already defined in the plugin's `uninstall.php` guard.
