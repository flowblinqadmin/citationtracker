# TS-043: WordPress Plugin — Integration Tests, Security Tests & Local Staging

**Author:** CoFounder (Agent 1)
**Date:** 2026-03-14
**Status:** Draft
**Depends on:** TS-042 (WordPress Plugin Rewrite)

---

## What

A Docker-based test infrastructure for the Flowblinq GEO WordPress plugin (`wordpress-plugin/flowblinq-geo/`) that provides:

1. **40 integration tests** (I1–I40) running inside real WordPress + MySQL via PHPUnit `WP_UnitTestCase`
2. **30 security tests** (S1–S30) validating nonce, capability, XSS, SSRF, CSRF, SQLi, and other attack vectors
3. **Local staging** for manual verification of GEO asset serving

All tests run against a **mock upstream** (deterministic PHP server simulating `geo.flowblinq.com`) so tests are fast, offline-capable, and repeatable.

---

## Why

The plugin has 30 unit tests (U1–U30) using standalone stubs, but these don't exercise:
- Real WordPress function behavior (transients, options, rewrite rules, AJAX lifecycle)
- Real MySQL persistence
- Multi-role permission checks (subscriber vs admin)
- Actual HTTP proxy behavior through WordPress's HTTP API
- Security boundaries under real WordPress nonce/capability enforcement

Integration + security tests close these gaps before production deployment.

---

## Architecture

```
wordpress-plugin/
  flowblinq-geo/              ← existing plugin (UNCHANGED)
  testing/
    docker-compose.yml         ← orchestrates 4 services
    Dockerfile.wp-test         ← WordPress + PHPUnit image
    Dockerfile.mock            ← Mock upstream image
    phpunit.xml                ← test config
    run-tests.sh               ← single entry point
    mock-upstream/
      server.php               ← PHP built-in server (~120 lines)
      fixtures/                ← predictable test data
        llms.txt
        llms-full.txt
        business.json
        schema.json
    integration/
      bootstrap-wp.php         ← loads real WP, activates plugin
      test-integration.php     ← I1–I40
    security/
      test-security.php        ← S1–S30
```

**~14 new files, all inside `wordpress-plugin/testing/`. Zero changes to the plugin itself.**

---

## Docker Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| **wordpress** | `wordpress:6.7-php8.3-apache` | 8080 | Live WP site for manual staging |
| **mysql** | `mysql:8.0` | 3307→3306 | Database for WordPress + tests |
| **mock-upstream** | `php:8.3-cli` (custom) | 8081→8080 | Deterministic mock of geo.flowblinq.com |
| **wp-test** | Custom (WP CLI + PHPUnit) | none | Runs integration + security suites |

The plugin directory is bind-mounted into WordPress at `wp-content/plugins/flowblinq-geo`.

### Service Dependencies
- `wp-test` depends on: `mysql` (healthy), `mock-upstream` (started)
- `wordpress` depends on: `mysql` (healthy)
- `mock-upstream`: standalone

### Network
All services on a single Docker bridge network (`fqgeo-test-net`). Internal DNS:
- `mock-upstream:8080` — mock server
- `mysql:3306` — database
- `wordpress:80` — WordPress (for staging)

---

## Mock Upstream Server

**File:** `mock-upstream/server.php`
**Runtime:** `php -S 0.0.0.0:8080 server.php`

### Serve Routes
| Path | Response |
|------|----------|
| `GET /api/serve/{slug}/llms.txt` | `fixtures/llms.txt`, `text/plain` |
| `GET /api/serve/{slug}/llms-full.txt` | `fixtures/llms-full.txt`, `text/plain` |
| `GET /api/serve/{slug}/business.json` | `fixtures/business.json`, `application/json` |
| `GET /api/serve/{slug}/schema.json` | `fixtures/schema.json`, `application/json` |

### API Routes
| Path | Method | Response |
|------|--------|----------|
| `/api/oauth/token` | POST | `{"access_token":"mock-token-...","token_type":"Bearer","expires_in":3600}` |
| `/api/v1/audit` | POST | `{"audit_id":"audit-...","slug":"test-site-123","status":"pending"}` |
| `/api/v1/audit/{id}` | GET | Pending (polls 1-2) → Complete (poll 3+) with scorecard |
| `/api/v1/audit/{id}/verify` | POST | Complete with scorecard |

### Special Slug Behaviors
| Slug | Behavior |
|------|----------|
| `error-500` | Returns HTTP 500 |
| `timeout` | `sleep(5)` then respond (triggers timeout at `FQGEO_PROXY_TIMEOUT=1`) |
| `oversized` | Returns 513KB body (exceeds `FQGEO_PROXY_MAX_SIZE=524288`) |
| `malformed` | Returns invalid JSON for `schema.json` |
| `xss-payload` | Returns schema with `</script><script>alert(1)</script>` in name field |
| `not-array` | Returns JSON object instead of array for `schema.json` |

### Special OAuth Behaviors
| Credentials | Behavior |
|-------------|----------|
| `client_id=invalid` OR `client_secret=invalid` | Returns HTTP 401 `{"error":"invalid_client"}` |
| Missing credentials | Returns HTTP 400 `{"error":"missing_credentials"}` |

### Special Audit Behaviors
| Audit ID | Behavior |
|----------|----------|
| `error-audit` | Returns HTTP 500 on poll |
| URL containing `error500` | Submit returns HTTP 500 |

### Logging
All requests logged to `/tmp/mock-requests.log` with timestamp, method, URI. Tests can read this to verify upstream was/wasn't hit.

---

## Fixtures

| File | Content | Size |
|------|---------|------|
| `llms.txt` | Predictable markdown with heading, services list | ~200B |
| `llms-full.txt` | Extended markdown with location, contact, hours | ~500B |
| `business.json` | JSON object with name, URL, services, location | ~300B |
| `schema.json` | JSON array of 2 schema.org objects (LocalBusiness + WebSite) | ~400B |

Fixtures must be deterministic — no random data, no timestamps. Tests assert exact content or substrings.

---

## Dockerfile.wp-test

Builds on `wordpress:cli` (includes WP-CLI + PHP 8.3). Adds:
- PHPUnit 10.x via Composer
- WordPress test library (`wp-tests-lib`) installed via `install-wp-tests.sh` from `wp-cli/scaffold-command`
- The plugin bind-mounted at `/app/plugin`
- Test files copied to `/app/tests/`

### Environment Variables (set in docker-compose)
| Var | Value | Purpose |
|-----|-------|---------|
| `WORDPRESS_DB_HOST` | `mysql` | Database host |
| `WORDPRESS_DB_NAME` | `wordpress_test` | Test database |
| `WORDPRESS_DB_USER` | `root` | DB user |
| `WORDPRESS_DB_PASSWORD` | `testpass` | DB password |
| `FQGEO_SERVE_BASE` | `http://mock-upstream:8080/api/serve` | Override upstream URL |
| `FQGEO_PROXY_TIMEOUT` | `5` | Default timeout |
| `WP_TESTS_DIR` | `/tmp/wordpress-tests-lib` | WP test library path |

### Entrypoint
Wait for MySQL, then run PHPUnit.

---

## Dockerfile.mock

Minimal: `php:8.3-cli`, copies `mock-upstream/` to `/app/mock-upstream/`, runs `php -S 0.0.0.0:8080`.

---

## Bootstrap (`integration/bootstrap-wp.php`)

1. Loads WordPress test library (`WP_TESTS_DIR/includes/functions.php`)
2. Registers a `muplugins_loaded` callback that:
   - Defines `FQGEO_SERVE_BASE` from env (pointing to mock-upstream)
   - Defines `FQGEO_PROXY_TIMEOUT` from env
   - Activates the plugin via `activate_plugin('flowblinq-geo/flowblinq-geo.php')`
3. Loads `WP_TESTS_DIR/includes/bootstrap.php` to complete WP initialization

This gives tests full access to `WP_UnitTestCase` with the plugin active.

---

## Integration Tests (I1–I40)

**File:** `integration/test-integration.php`
**Class:** `Test_Integration extends WP_UnitTestCase`
**PHPUnit group:** `integration`

### A. Proxy Routes (I1–I8)

| ID | Method | What | Assert |
|----|--------|------|--------|
| I1 | `test_proxy_llms_txt_cold_cache` | `GET /llms.txt` with empty transient cache | Response 200, body matches fixture, `Content-Type: text/plain`, transient now set |
| I2 | `test_proxy_llms_txt_warm_cache` | Set transient first, then `GET /llms.txt` | Returns cached content, mock log shows zero new requests |
| I3 | `test_proxy_llms_full_txt_cold` | `GET /llms-full.txt` cache miss | 200, body matches fixture |
| I4 | `test_proxy_business_json_cold` | `GET /.well-known/ucp.json` cache miss | 200, `Content-Type: application/json`, valid JSON body |
| I5 | `test_proxy_upstream_500` | Set slug to `error-500`, request `llms.txt` | Returns 502, body NOT cached |
| I6 | `test_proxy_upstream_timeout` | Set slug to `timeout`, `FQGEO_PROXY_TIMEOUT=1` | Returns 504 |
| I7 | `test_proxy_oversized_body` | Set slug to `oversized` | Returns 502, body NOT cached |
| I8 | `test_proxy_response_headers` | Request each serve route | Each has correct `Content-Type`, `Cache-Control: public, max-age=3600`, `X-Generator: FlowBlinq GEO` |

**Implementation approach:** Tests call `handle_serve()` directly after setting `fq_serve` query var and `fq_site_slug` option. For cold cache tests, verify the transient was set after the call. For warm cache, pre-populate the transient and verify mock log file wasn't appended.

**Note on I6:** Override `FQGEO_PROXY_TIMEOUT` to 1 second via `wp-config.php` or `define()` before the test. The mock sleeps 5 seconds, causing WordPress `wp_remote_get` to time out.

### B. Schema JSON-LD (I9–I14)

| ID | Method | What | Assert |
|----|--------|------|--------|
| I9 | `test_schema_jsonld_fresh_fetch` | Call `inject_schema_jsonld()` with no cache | Output contains `<script type="application/ld+json">`, valid JSON inside |
| I10 | `test_schema_stale_while_revalidate` | Expire transient, keep `_fq_stale_schema_json` option | Serves stale content, `shutdown` action registered for refresh |
| I11 | `test_schema_stampede_lock` | Set lock transient, call `inject_schema_jsonld()` twice | Only 1 upstream request (check mock log), lock prevents second fetch |
| I12 | `test_schema_malformed_json` | Set slug to `malformed` | No `<script>` tags in output |
| I13 | `test_schema_non_array_json` | Set slug to `not-array` | No `<script>` tags in output (json_decode returns assoc array with `@context` key, but `$decoded[0]` check fails) |
| I14 | `test_schema_xss_escaping` | Set slug to `xss-payload` | Output contains `\u003C` not literal `</script>` (via `JSON_HEX_TAG`) |

### C. Robots.txt (I15–I17)

| ID | Method | What | Assert |
|----|--------|------|--------|
| I15 | `test_robots_public_site` | `blog_public=1`, slug set | Output contains `GPTBot`, `ClaudeBot`, `PerplexityBot` Allow directives |
| I16 | `test_robots_private_site` | `blog_public=0` | No AI directives appended |
| I17 | `test_robots_no_slug` | `fq_site_slug` empty | Robots.txt unmodified |

**Implementation:** Call `append_robots_directives($existing_output, $public)` directly.

### D. OAuth (I18–I21)

| ID | Method | What | Assert |
|----|--------|------|--------|
| I18 | `test_token_acquisition` | Call `get_token()` with valid credentials | Returns string token, request had correct `grant_type`, `client_id`, `client_secret` |
| I19 | `test_token_caching` | Call `get_token()` twice | Second call returns cached transient, only 1 HTTP request in mock log |
| I20 | `test_token_expiry_refetch` | Set transient, delete it, call `get_token()` | New HTTP request, fresh token |
| I21 | `test_token_invalid_credentials` | Use `client_id=invalid` | Returns `WP_Error` with code `fqgeo_token_error` |

**Implementation:** Instantiate `Flowblinq_API_Client` with credentials, point `$base_url` at mock-upstream. Since `$base_url` is private, tests should use `FQGEO_SERVE_BASE` env for proxy tests and test the API client indirectly through admin AJAX handlers.

**Note:** `Flowblinq_API_Client::$base_url` is hardcoded to `https://geo.flowblinq.com`. Tests need to either:
- Use a subclass that overrides `$base_url` (preferred — minimal change)
- Or use the pre-filter on `wp_remote_*` to redirect requests

**Recommendation:** ScriptDev should add a `protected function get_base_url()` method to `Flowblinq_API_Client` and use it throughout, allowing test subclass to override. This is the minimal change needed.

### E. Admin Settings (I22–I25)

| ID | Method | What | Assert |
|----|--------|------|--------|
| I22 | `test_settings_save` | POST `client_id` and `client_secret` via settings API | Options stored correctly |
| I23 | `test_secret_masking` | Submit `fq_client_secret=••••••••` | Original secret preserved (sanitize callback returns existing value) |
| I24 | `test_slug_validation` | Submit audit, mock returns `my-site-123` → accepted; `../etc/passwd` → rejected | Regex `^[a-z0-9\-]+$/i` enforces |
| I25 | `test_permalink_warning` | `permalink_structure` empty | Settings page contains `notice-error` div |

### F. Audit Flow (I26–I31)

| ID | Method | What | Assert |
|----|--------|------|--------|
| I26 | `test_audit_submit` | Call `handle_ajax_run_audit()` | `fq_active_audit_id` option set, `fq_site_slug` set, success JSON |
| I27 | `test_audit_poll_pending` | Poll with audit_id (first poll) | `status=pending`, progress < 100 |
| I28 | `test_audit_poll_complete` | Poll 3+ times | `status=complete`, scorecard present |
| I29 | `test_audit_verify` | Call verify endpoint | POST to `/api/v1/audit/{id}/verify`, returns scorecard |
| I30 | `test_audit_timeout` | N/A — `FQGEO_MAX_POLLS` is client-side JS logic | **Skip or test JS-level** (mark as placeholder) |
| I31 | `test_audit_api_error` | Use audit_id `error-audit` for poll, URL `error500` for submit | Returns error JSON |

### G. AJAX Endpoints (I32–I36)

| ID | Method | What | Assert |
|----|--------|------|--------|
| I32 | `test_ajax_run_audit_valid` | Admin user + valid nonce → `handle_ajax_run_audit()` | `wp_send_json_success` with audit data |
| I33 | `test_ajax_poll_audit_valid` | Admin + nonce → `handle_ajax_poll_audit()` | Success JSON |
| I34 | `test_ajax_verify_valid` | Admin + nonce → `handle_ajax_verify()` | Success JSON |
| I35 | `test_ajax_test_connection_valid` | Admin + nonce + slug set → `handle_ajax_test_connection()` | Success with "Connected" |
| I36 | `test_ajax_clear_cache_valid` | Admin + nonce → `handle_ajax_clear_cache()` | Success, transients deleted |

### H. Lifecycle (I37–I40)

| ID | Method | What | Assert |
|----|--------|------|--------|
| I37 | `test_activation` | Trigger activation hook | Rewrite rules registered (`llms\.txt`, `llms-full\.txt`, `\.well-known/ucp\.json`), `flush_rewrite_rules` called |
| I38 | `test_deactivation` | Trigger deactivation hook | `wp_clear_scheduled_hook('fqgeo_poll_audit')` called, `flush_rewrite_rules` called |
| I39 | `test_uninstall` | Include `uninstall.php` | Options `fq_client_id`, `fq_client_secret`, `fq_site_slug`, `fq_active_audit_id` deleted; transients `fq_access_token`, `fq_proxy_llms_txt`, `fq_proxy_llms_full_txt`, `fq_proxy_business_json`, `fq_proxy_schema_json` deleted |
| I40 | `test_constant_overrides` | Define `FQGEO_SERVE_BASE` before plugin load | Plugin uses overridden value (verified by checking proxy URL in fetch) |

---

## Security Tests (S1–S30)

**File:** `security/test-security.php`
**Class:** `Test_Security extends WP_UnitTestCase`
**PHPUnit group:** `security`

Uses `$this->factory->user->create(['role' => 'subscriber'])` etc. for multi-role testing.

### A. Nonce Bypass (S1–S5)

| ID | Method | What | Assert |
|----|--------|------|--------|
| S1 | `test_nonce_missing_run_audit` | Call `handle_ajax_run_audit()` with no nonce in `$_REQUEST` | `wp_die` / 403 (WP's `check_ajax_referer` kills the request) |
| S2 | `test_nonce_missing_poll_audit` | Same for poll | 403 |
| S3 | `test_nonce_missing_verify` | Same for verify | 403 |
| S4 | `test_nonce_missing_test_connection` | Same for test_connection | 403 |
| S5 | `test_nonce_missing_clear_cache` | Same for clear_cache | 403 |

**Implementation:** Don't set `$_REQUEST['nonce']` or `$_REQUEST['_wpnonce']`. WordPress `check_ajax_referer` calls `wp_die()` with 403.

### B. Capability Escalation (S6–S10)

| ID | Method | What | Assert |
|----|--------|------|--------|
| S6 | `test_subscriber_run_audit` | Log in as subscriber, valid nonce | 403 via `current_user_can('manage_options')` check |
| S7 | `test_editor_poll_audit` | Log in as editor, valid nonce | 403 |
| S8 | `test_author_verify` | Log in as author, valid nonce | 403 |
| S9 | `test_subscriber_test_connection` | Log in as subscriber | 403 |
| S10 | `test_subscriber_clear_cache` | Log in as subscriber | 403 |

**Implementation:** Use `wp_set_current_user($this->factory->user->create(['role' => 'subscriber']))`.

### C. XSS (S11–S14)

| ID | Method | What | Assert |
|----|--------|------|--------|
| S11 | `test_xss_schema_script_tags` | Schema with `</script>` in field | Output uses `JSON_HEX_TAG` → `\u003C`, no literal `</script>` |
| S12 | `test_xss_proxy_response_scripts` | Proxy response body with `<script>alert(1)</script>` | Served as `text/plain`, no execution context |
| S13 | `test_xss_slug_img_onerror` | Slug `<img onerror=alert(1)>` | Rejected by regex `^[a-z0-9\-]+$/i` |
| S14 | `test_xss_slug_encoded` | Slug `%3Cscript%3E` | `sanitize_text_field` + regex rejects |

### D. SSRF via Slug (S15–S17)

| ID | Method | What | Assert |
|----|--------|------|--------|
| S15 | `test_ssrf_path_traversal` | Slug `../../internal` | `rawurlencode` converts to `..%2F..%2Finternal`, no traversal |
| S16 | `test_ssrf_metadata_endpoint` | Slug `http://169.254.169.254` | Rejected by regex (contains `:` and `/`) |
| S17 | `test_ssrf_slash_encoding` | Slug `my-site/../../admin` | `rawurlencode` converts slashes |

**Implementation:** Set the slug via `update_option`, trigger `fetch_upstream`, verify the URL passed to `wp_remote_get` has the slug properly encoded.

### E. CSRF (S18)

| ID | Method | What | Assert |
|----|--------|------|--------|
| S18 | `test_csrf_settings_post_no_nonce` | POST to settings form without nonce | WordPress `settings_fields` / `check_admin_referer` rejects |

### F. SQL Injection (S19)

| ID | Method | What | Assert |
|----|--------|------|--------|
| S19 | `test_sqli_client_id` | Set `fq_client_id` to `'; DROP TABLE wp_options; --` | `sanitize_text_field` strips, value round-trips safely via `get_option` |

### G. Path Traversal (S20–S21)

| ID | Method | What | Assert |
|----|--------|------|--------|
| S20 | `test_path_traversal_rewrite` | Request `GET /llms.txt/../wp-config.php` | Rewrite rule regex doesn't match, WordPress 404 |
| S21 | `test_path_traversal_query_var` | Set `fq_serve=../../../wp-config` | Not in `$serve_map` array, `handle_serve` returns early |

### H. Response Splitting (S22)

| ID | Method | What | Assert |
|----|--------|------|--------|
| S22 | `test_response_splitting_crlf` | Mock upstream includes `\r\nSet-Cookie: evil=1` in body | Plugin only uses `wp_remote_retrieve_body`, sets own headers — no CRLF injection |

### I. Token/Secret Exposure (S23–S24)

| ID | Method | What | Assert |
|----|--------|------|--------|
| S23 | `test_secret_not_in_html` | Render settings page with secret stored | HTML contains `••••••••`, NOT the actual secret |
| S24 | `test_no_secrets_in_js` | Check `wp_localize_script` output | The localized `fqgeo` object contains no `client_id`, `client_secret`, or `access_token` keys |

### J. Cache Poisoning (S25)

| ID | Method | What | Assert |
|----|--------|------|--------|
| S25 | `test_non_admin_clear_cache` | Subscriber calls `handle_ajax_clear_cache()` with valid nonce | 403 — capability check blocks |

### K. Other (S26–S30)

| ID | Method | What | Assert |
|----|--------|------|--------|
| S26 | `test_audit_url_not_user_supplied` | `handle_ajax_run_audit` calls `submit_audit(get_site_url())` | URL is hardcoded `get_site_url()`, not from `$_POST` |
| S27 | `test_timing_safe_comparison` | WordPress uses `hash_equals` for nonce verification | Informational — verify via code inspection (WP core, not plugin code). Mark as verified-by-design. |
| S28 | `test_content_type_explicit` | Each proxy response | `Content-Type` explicitly set from `$serve_map`, `X-Content-Type-Options: nosniff` checked |
| S29 | `test_empty_credentials_audit` | `fq_client_id` and `fq_client_secret` empty, try audit | Returns `WP_Error`, no crash, no null pointer |
| S30 | `test_rapid_ajax_calls` | 5 sequential AJAX calls to `clear_cache` | All 5 get nonce validation (no bypass on rapid fire) |

---

## phpunit.xml Configuration

```xml
<phpunit bootstrap="integration/bootstrap-wp.php"
         colors="true"
         stopOnFailure="false">
  <testsuites>
    <testsuite name="integration">
      <file>integration/test-integration.php</file>
    </testsuite>
    <testsuite name="security">
      <file>security/test-security.php</file>
    </testsuite>
  </testsuites>
  <groups>
    <include>
      <group>integration</group>
      <group>security</group>
    </include>
  </groups>
</phpunit>
```

---

## run-tests.sh

Single entry point script:
1. `docker compose up -d mysql mock-upstream` — start dependencies
2. Wait for MySQL healthcheck
3. `docker compose run --rm wp-test` — run all tests
4. Print results
5. Exit with PHPUnit's exit code

Flags:
- `--integration` → run only `@group integration`
- `--security` → run only `@group security`
- `--staging` → `docker compose up -d` (all services including WordPress for manual testing)
- `--down` → `docker compose down -v`

---

## Local Staging

### Two Modes

**Mock mode (default for testing):**
```bash
cd wordpress-plugin/testing
docker compose up -d
# FQGEO_SERVE_BASE → http://mock-upstream:8080/api/serve
```

**Live mode (real geo.flowblinq.com):**
```bash
docker compose up -d mysql wordpress
# Don't start mock-upstream
# Default FQGEO_SERVE_BASE → https://geo.flowblinq.com/api/serve
# Enter real credentials in WP admin
```

### Manual Verification Checklist
1. `http://localhost:8080/wp-admin/` — complete install wizard
2. Activate Flowblinq GEO plugin
3. Settings > Permalinks > "Post name" > Save
4. Settings > Flowblinq GEO > enter credentials
5. Tools > GEO Audit > Run Free Audit > verify completion
6. Verify proxy routes: `/llms.txt`, `/llms-full.txt`, `/.well-known/ucp.json`
7. View page source — `<script type="application/ld+json">` present
8. `/robots.txt` — AI crawler directives present
9. Test Connection — green success
10. Clear Cache — confirmed

---

## Commands Reference

| Task | Command |
|------|---------|
| Start staging | `docker compose up -d` |
| Run all tests | `docker compose run --rm wp-test` |
| Run integration only | `docker compose run --rm wp-test phpunit --group integration` |
| Run security only | `docker compose run --rm wp-test phpunit --group security` |
| Run existing unit tests | `docker compose run --rm wp-test php /app/plugin/tests/test-proxy.php` |
| View mock logs | `docker compose exec mock-upstream cat /tmp/mock-requests.log` |
| Stop | `docker compose down` |
| Full reset | `docker compose down -v` |

---

## Dependencies

- Docker + Docker Compose
- No changes to the existing plugin source code (except potentially `Flowblinq_API_Client::$base_url` — see OAuth section note)
- WordPress test library (installed automatically in Dockerfile)

---

## Plugin Modification Required

**One minimal change needed:** `Flowblinq_API_Client::$base_url` is `private` and hardcoded. Integration tests for OAuth and audit flows need to redirect API calls to the mock upstream.

**Options (ScriptDev decides):**
1. Change `$base_url` from `private` to `protected`, add `protected function get_base_url()` used throughout → test subclass overrides
2. Use WordPress `pre_http_request` filter to intercept and redirect
3. Accept a constructor parameter with default fallback

Option 1 is cleanest. Option 2 requires no plugin changes. ScriptDev should choose.

---

## Acceptance Criteria

1. `docker compose run --rm wp-test` exits 0 with 70 tests passing (40 integration + 30 security)
2. Zero tests depend on external network access
3. Tests complete in < 60 seconds after first build
4. Mock upstream logs verify upstream hit/miss patterns
5. Staging mode works: WordPress accessible at `localhost:8080`, plugin activates, proxy routes serve content
6. `docker compose down -v` cleans up completely

---

## Risks

1. **WordPress test library version compatibility** — Pin to WP 6.7 to match the WordPress Docker image. PHPUnit 10 required (WP 6.7+ supports it).
2. **Mock timing for timeout test (I6)** — `sleep(5)` in mock + `FQGEO_PROXY_TIMEOUT=1` might be flaky if DNS resolution is slow. Add 2s buffer: mock sleeps 5s, timeout is 2s.
3. **`WP_UnitTestCase` transaction rollback** — Each test runs in a transaction that rolls back. This means transients stored in the DB are test-isolated but in-memory object caches may leak between tests. Call `wp_cache_flush()` in `setUp()`.
4. **I30 (MAX_POLLS)** — This is client-side JS logic, not server-side. Mark as a placeholder or test the JS separately.

---

## Sequencing (for ScriptDev)

1. Fixtures (4 files)
2. Mock upstream server (`server.php`)
3. `Dockerfile.mock`, `Dockerfile.wp-test`
4. `docker-compose.yml`
5. `bootstrap-wp.php` + `phpunit.xml`
6. Integration tests I1–I40
7. Security tests S1–S30
8. `run-tests.sh`
9. Verify everything passes
