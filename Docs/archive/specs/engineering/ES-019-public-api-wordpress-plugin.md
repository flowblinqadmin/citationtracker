# ES-019: Public API + WordPress Plugin

**Status:** Draft
**Author:** SpecMaster (2-specmaster)
**Date:** 2026-03-03
**Source TS:** TS-019-public-api-wordpress-plugin.md
**Priority:** P1
**Downstream:** ReviewMaster → ScriptDev

---

## a) Overview

Extends Flowblinq GEO from a web-only product into a public API with OAuth 2.0 authentication and a WordPress plugin as the first external consumer. This creates a free-tier acquisition channel via WordPress's 43% market share.

**Three layers:**
1. **OAuth 2.0 auth server** — `POST /api/oauth/token`, `apiClients` DB table, dashboard UI for key management
2. **Public API `/api/v1/*`** — versioned, JWT-authenticated, MCP-compatible REST endpoints
3. **WordPress plugin** — PHP, full free-tier flow, WP.org compliant

**Current implementation state:**
- No public API routes exist. All site creation goes through `/api/sites` (email-based OTP flow).
- No OAuth infra. Auth is entirely Supabase session-based.
- `geoSites` schema lacks free-tier tracking columns.
- No `apiClients` table.
- `rateLimits` table exists and `checkRateLimit()` utility is ready to reuse.
- `jose` is available in the Next.js edge runtime but **must be added** as an explicit project dependency.
- `bcryptjs` is **not yet installed** — must be added (`npm install bcryptjs @types/bcryptjs`).

---

## b) Implementation Requirements

### New Dependencies

```bash
npm install jose bcryptjs
npm install -D @types/bcryptjs
```

Notes:
- `jose` → JWT sign/verify (JOSE spec, edge-runtime safe for verification)
- `bcryptjs` → secret hashing (pure JS, works in Node.js runtime only — do NOT use in Edge middleware)
- `POST /api/oauth/token` must NOT be marked `export const runtime = 'edge'` — use default Node.js runtime

---

### New Environment Variable

```env
API_JWT_SECRET=<32-byte random hex string>   # sign/verify API access tokens
```

Add to `.env.local`, `.env.production`, and Vercel project settings. ScriptDev must document generation: `openssl rand -hex 32`.

---

### DB Schema Changes — `lib/db/schema.ts`

#### 1. New table: `apiClients`

Add after the `rateLimits` table definition:

```typescript
export const apiClients = pgTable("api_clients", {
  id:               text("id").primaryKey(),                           // nanoid()
  teamId:           text("team_id").notNull().references(() => teams.id),
  clientId:         text("client_id").unique().notNull(),              // nanoid(24), public
  clientSecretHash: text("client_secret_hash").notNull(),             // bcrypt hash
  name:             text("name").notNull(),                            // e.g. "WordPress Plugin"
  scopes:           text("scopes").array().notNull().default([]),      // ["audit:read", "audit:write", "account:read"]
  lastUsedAt:       timestamp("last_used_at"),
  revokedAt:        timestamp("revoked_at"),
  createdAt:        timestamp("created_at").defaultNow(),
});

export type ApiClient = typeof apiClients.$inferSelect;
export type NewApiClient = typeof apiClients.$inferInsert;
```

#### 2. New columns on `geoSites`

Add to the `geoSites` table (after `batchId`):

```typescript
freeOptimizationUsed: boolean("free_optimization_used").default(false),
freeRunNumber:        integer("free_run_number").default(1),    // 1 = baseline, 2 = post-opt
apiClientId:          text("api_client_id"),                    // nullable FK to api_clients.client_id
```

---

### Migration File

**File:** `geo/drizzle/migrations/0002_api_clients.sql`

```sql
-- ES-019: Add apiClients table and free-tier columns on geoSites

CREATE TABLE IF NOT EXISTS "api_clients" (
  "id"                  TEXT PRIMARY KEY,
  "team_id"             TEXT NOT NULL REFERENCES "teams"("id"),
  "client_id"           TEXT UNIQUE NOT NULL,
  "client_secret_hash"  TEXT NOT NULL,
  "name"                TEXT NOT NULL,
  "scopes"              TEXT[] NOT NULL DEFAULT '{}',
  "last_used_at"        TIMESTAMP,
  "revoked_at"          TIMESTAMP,
  "created_at"          TIMESTAMP DEFAULT NOW()
);

ALTER TABLE "geo_sites"
  ADD COLUMN IF NOT EXISTS "free_optimization_used" BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "free_run_number"        INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "api_client_id"          TEXT;
```

---

### New File: `lib/api-auth.ts`

JWT utility for the public API. Contains sign, verify, and scope-enforcement.

```typescript
// Responsibilities:
// - signApiToken(payload: ApiTokenPayload): Promise<string>
//   Signs a JWT using jose SignJWT. HS256 algorithm. exp = now + 3600s.
//   Payload: { sub: clientId, team_id: teamId, scopes: string[], iat, exp }
//
// - verifyApiToken(token: string): Promise<ApiTokenPayload>
//   Verifies JWT signature and expiry using jose jwtVerify.
//   Throws if invalid/expired. Safe to call from Edge middleware.
//
// - requireScope(scopes: string[], required: string): void
//   Throws 403-equivalent if required scope not in scopes array.
//
// - API_JWT_SECRET: Buffer
//   Loaded from process.env.API_JWT_SECRET. Throws at module load if missing.

export interface ApiTokenPayload {
  sub: string;        // clientId
  team_id: string;
  scopes: string[];
  iat: number;
  exp: number;
}
```

Implementation constraints:
- Import `SignJWT`, `jwtVerify` from `jose`
- Key: `new TextEncoder().encode(process.env.API_JWT_SECRET)`
- Algorithm: `HS256`
- Do NOT store tokens — stateless verification only

---

### New File: `lib/db/api-clients.ts`

DB query helpers for the `apiClients` table.

```typescript
// Functions to implement:

// createApiClient(input: { teamId, name, scopes }) => Promise<{ client_id, client_secret }>
//   Generates clientId = nanoid(24), secret = nanoid(32)
//   Hashes secret with bcrypt (saltRounds: 12)
//   Inserts row. Returns { client_id, client_secret } — secret is shown ONCE, never stored

// getApiClientByClientId(clientId: string) => Promise<ApiClient | null>
//   Returns row from api_clients where client_id = clientId

// verifyApiClientSecret(client: ApiClient, secret: string) => Promise<boolean>
//   bcrypt.compare(secret, client.clientSecretHash)

// touchApiClientLastUsed(clientId: string) => Promise<void>
//   Updates lastUsedAt = NOW() for the given clientId

// listApiClientsForTeam(teamId: string) => Promise<ApiClient[]>
//   Returns all non-revoked clients for the team

// revokeApiClient(clientId: string, teamId: string) => Promise<void>
//   Sets revokedAt = NOW() where client_id = clientId AND team_id = teamId
```

---

### New File: `app/api/oauth/token/route.ts`

`POST /api/oauth/token` — issues JWT access tokens.

**Runtime:** Default (Node.js) — required for `bcryptjs`.

```typescript
// Request body: { grant_type, client_id, client_secret }
// Validations:
//   1. grant_type must be "client_credentials"
//   2. client_id and client_secret must be non-empty strings
//   3. Rate limit: checkRateLimit("oauth:clientId:" + client_id, 10, 60_000)
//      → 429 if exceeded
//   4. Look up client by client_id. → 401 if not found
//   5. Check revokedAt — if set, → 401 { error: "client_revoked" }
//   6. bcrypt.compare(client_secret, client.clientSecretHash) → 401 if false
//   7. Sign JWT with signApiToken({ sub: clientId, team_id, scopes })
//   8. touchApiClientLastUsed(clientId)
//   9. Return: { access_token, token_type: "Bearer", expires_in: 3600, scope: scopes.join(" ") }
//
// Error responses:
//   400: invalid_request (missing/wrong grant_type, missing fields)
//   401: invalid_client (not found, revoked, wrong secret)
//   429: rate_limit_exceeded
//   500: internal_server_error
```

---

### Middleware Update: `middleware.ts`

Add to `ALWAYS_ALLOWED` array:

```typescript
/^\/api\/oauth\/token$/,          // public — auth is in the handler
/^\/api\/v1\//,                   // JWT auth enforced per-route (not in middleware)
```

**Decision:** JWT verification is done **per-route** (not in middleware) to keep the middleware lean and to allow the MCP manifest (`GET /api/v1/mcp`) to be unauthenticated. Each `/api/v1/*` route handler calls `verifyApiToken()` at the top of its function.

**No JWT logic in `middleware.ts`** — only allowlist it here.

---

### New File: `app/api/v1/audit/route.ts`

`POST /api/v1/audit` — submit a URL for GEO audit.

**Scope required:** `audit:write`

```typescript
// Auth: extract Bearer token from Authorization header → verifyApiToken() → 401 if invalid
// requireScope(scopes, "audit:write") → 403 if missing

// Request: { url: string, mode?: "single" | "bulk", urls?: string[] }
// Validation:
//   - url must be valid http/https, not SSRF range (reuse PRIVATE_RANGES from sites/route.ts)
//   - mode "bulk" requires urls array (future — v0.1 only implements "single")
//
// Free-tier logic (single mode):
//   1. normalizeDomain(url) to get domain
//   2. Query geoSites WHERE domain = ? AND teamId = ? (using x-api-team-id from token)
//   3. Case A — no existing site: insert new site, freeRunNumber=1, freeOptimizationUsed=false,
//      apiClientId=token.sub (clientId), crawlLimit=50, pipelineStatus="pending"
//      Enqueue pipeline via enqueueStage() (same as existing flow)
//      Return: { audit_id, status: "pending", free_tier: true, free_run_number: 1,
//                estimated_completion_seconds: 120 }
//   4. Case B — exists, freeRunNumber=1, freeOptimizationUsed=false, pipelineStatus="complete":
//      → 409 { error: "audit_exists", message: "Use POST /api/v1/audit/{id}/verify for second run",
//               audit_id: existing.id }
//   5. Case C — exists, freeRunNumber=2, freeOptimizationUsed=true:
//      → 402 { error: "free_tier_exhausted", credits_purchase_url: "https://geo.flowblinq.com/pricing" }
//   6. Case D — exists, pipelineStatus="pending"|"running": → 200 with existing audit_id + status
//
// crawlLimit=50 is set on the geoSites row. The pipeline runner must respect this cap.
// (Spec note for ScriptDev: audit route sets crawlLimit=50 on insert; pipeline runner already
//  reads crawlLimit — no changes to runner needed for the cap itself.)
```

---

### New File: `app/api/v1/audit/[id]/route.ts`

`GET /api/v1/audit/{id}` — poll status and retrieve results.

**Scope required:** `audit:read`

```typescript
// Auth: verifyApiToken() → requireScope("audit:read")
// Ownership check: site.teamId must match token.team_id → 403 if not

// Fetch site by id from geoSites
// → 404 if not found

// Determine output format:
//   - Check Accept header for "application/mcp+json"
//   - Check ?format=mcp query param
//   → if MCP format requested, return formatAsMcp(site) using lib/mcp-formatter.ts
//   → else return JSON response (see shape below)

// JSON response shape:
// {
//   audit_id, domain, status: site.pipelineStatus,
//   overall_score: site.geoScorecard?.overallScore ?? null,
//   free_run_number: site.freeRunNumber,
//   scorecard: site.geoScorecard,
//   recommendations: site.recommendations,
//   executive_summary: site.executiveSummary,
//   files: {
//     llms_txt_url: site.slug ? `https://geo.flowblinq.com/api/serve/${site.slug}/llms.txt` : null,
//     business_json_url: ...,
//     schema_json_url: ...
//   },
//   created_at: site.createdAt,
//   completed_at: site.updatedAt  // proxy — no explicit completedAt column
// }
```

---

### New File: `lib/mcp-formatter.ts`

MCP output formatter (isolated to keep MCP spec evolution from polluting route handlers).

```typescript
// formatAsMcp(site: GeoSite): McpToolResult
// Returns:
// {
//   type: "tool_result",
//   tool: "get_audit",
//   content: [
//     { type: "text", text: "<summary string: domain, score, top issues>" },
//     { type: "resource", resource: { uri: llms_txt_url, mimeType: "text/plain", text: site.generatedLlmsTxt } }
//   ]
// }
//
// Pin to MCP spec version via a `MCP_SPEC_VERSION = "1.0"` constant.
// If site is not complete, return single text content item with status message.
```

---

### New File: `app/api/v1/audit/[id]/verify/route.ts`

`POST /api/v1/audit/{id}/verify` — trigger post-optimization second run.

**Scope required:** `audit:write`

```typescript
// Auth: verifyApiToken() → requireScope("audit:write")
// Ownership: site.teamId === token.team_id → 403 if not

// Validations:
//   - freeRunNumber must be 1 → 400 if 2 ("second run already used or in progress")
//   - freeOptimizationUsed must be false → 400 if true
//   - pipelineStatus must be "complete" → 400 if pending/running

// On valid:
//   SET freeOptimizationUsed=true, freeRunNumber=2, pipelineStatus="pending",
//       previousRunSnapshot=geoScorecard (save current scorecard for before/after diff)
//   Enqueue pipeline re-run via enqueueStage()
//   Return: { audit_id: id, status: "pending", free_run_number: 2 }
```

---

### New File: `app/api/v1/account/route.ts`

`GET /api/v1/account` — credit balance and usage.

**Scope required:** `account:read`

```typescript
// Auth: verifyApiToken() → requireScope("account:read")
// Fetch team by token.team_id
// Count geoSites WHERE teamId = ? AND freeOptimizationUsed = false (free opts remaining domains)
// Return:
// {
//   team_id,
//   credit_balance: team.creditBalance,
//   free_optimization_domains: count (domains with freeRunNumber=1, not yet post-opted),
//   credits_purchase_url: "https://geo.flowblinq.com/pricing"
// }
```

---

### New File: `app/api/v1/mcp/route.ts`

`GET /api/v1/mcp` — MCP server manifest. **No auth required.**

```typescript
// Returns static JSON manifest describing MCP tools and OAuth config
// Manifest shape: per TS-019 Layer 2 spec (protocol, version, auth, tools array)
// Include input schemas for each tool using JSON Schema subset
// Cache-Control: public, max-age=3600
```

---

### Dashboard Update: `app/dashboard/page.tsx`

Add "API Access" section after existing content.

```typescript
// New section: <ApiAccessSection teamId={team.id} />
// Implemented as a new component: app/dashboard/ApiAccessSection.tsx
//
// ApiAccessSection responsibilities:
//   - GET /api/teams/{teamId}/api-clients → list clients (name, clientId, createdAt, lastUsedAt, revokedAt)
//   - "Generate new key" button → POST /api/teams/{teamId}/api-clients → show secret ONCE in modal
//   - "Revoke" button → DELETE /api/teams/{teamId}/api-clients/{clientId}
```

---

### New File: `app/api/teams/[teamId]/api-clients/route.ts`

Internal API for the dashboard UI (Supabase session auth, not JWT).

```typescript
// GET  → listApiClientsForTeam(teamId) — session-auth, return array
// POST → createApiClient({ teamId, name, scopes }) — session-auth
//        Returns { client_id, client_secret } (secret shown once)
```

### New File: `app/api/teams/[teamId]/api-clients/[clientId]/route.ts`

```typescript
// DELETE → revokeApiClient(clientId, teamId) — session-auth
```

---

### WordPress Plugin: `wordpress-plugin/flowblinq-geo/`

New directory at project root (alongside `geo/`, `docs/`, etc.).

#### File structure (create all):

```
wordpress-plugin/flowblinq-geo/
├── flowblinq-geo.php                 # Main plugin file — headers, activation hooks
├── readme.txt                        # WP.org directory listing (required)
├── includes/
│   ├── class-api-client.php          # HTTP wrapper — all calls via wp_remote_post/get
│   ├── class-admin-page.php          # WP admin settings + audit UI
│   └── class-injector.php            # Auto-inject schema blocks + llms.txt <link>
├── assets/
│   ├── admin.css                     # Admin panel styles
│   └── admin.js                      # Poll audit status (setInterval every 5s), render scorecard
└── languages/
    └── flowblinq-geo.pot             # i18n template (empty for v0.1, required by WP rules)
```

#### `flowblinq-geo.php` — required headers:

```php
<?php
/*
 * Plugin Name:       Flowblinq GEO
 * Plugin URI:        https://geo.flowblinq.com
 * Description:       AI visibility optimization for your WordPress site.
 * Version:           0.1.0
 * Author:            Flowblinq
 * Author URI:        https://flowblinq.com
 * License:           GPL v2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       flowblinq-geo
 * Domain Path:       /languages
 */
```

Must include:
- `register_activation_hook()` — flush rewrite rules
- `register_deactivation_hook()` — flush rewrite rules, remove scheduled events
- `require_once` includes for all three classes
- `add_action('init', ...)` to load text domain

#### `includes/class-api-client.php`

```php
class Flowblinq_API_Client {
  private string $base_url = 'https://geo.flowblinq.com';
  private string $client_id;
  private string $client_secret;
  private ?string $access_token = null;
  private int $token_expires_at = 0;

  // __construct(string $client_id, string $client_secret)
  // get_token(): string|WP_Error — POST /api/oauth/token, cache in transient 'fq_access_token' (TTL 3500s)
  // submit_audit(string $url): array|WP_Error — POST /api/v1/audit
  // get_audit(string $audit_id): array|WP_Error — GET /api/v1/audit/{id}
  // verify_audit(string $audit_id): array|WP_Error — POST /api/v1/audit/{id}/verify
  // get_account(): array|WP_Error — GET /api/v1/account
  //
  // All HTTP via wp_remote_post() / wp_remote_get()
  // All pass Authorization: Bearer token header
  // Timeouts: 15s for submit, 10s for get
  // wp_remote_retrieve_response_code() for status check
}
```

#### `includes/class-admin-page.php`

```php
class Flowblinq_Admin_Page {
  // add_menu_pages(): registers Settings > Flowblinq GEO and Tools > GEO Audit
  // render_settings_page(): client_id field, client_secret field (type=password), test connection button
  // render_audit_page(): domain (get_site_url()), Run Free Audit button, progress bar,
  //   results panel, Apply Optimizations button, Verify My Changes button, before/after table
  // handle_ajax_run_audit(): wp_ajax hook — calls API_Client::submit_audit()
  // handle_ajax_poll_audit(): wp_ajax hook — calls API_Client::get_audit()
  // handle_ajax_apply(): wp_ajax hook — triggers Injector::inject_all()
  // handle_ajax_verify(): wp_ajax hook — calls API_Client::verify_audit()
  //
  // Options stored via update_option('fq_client_id', ...) and update_option('fq_client_secret', ...)
  // All AJAX handlers: verify wp_verify_nonce(), check current_user_can('manage_options')
}
```

#### `includes/class-injector.php`

```php
class Flowblinq_Injector {
  // inject_all(array $audit_data): void
  //   - Calls inject_schema_blocks($audit_data['files']['schema_json_url'])
  //   - Calls inject_llms_txt_link()
  //   - Calls register_llms_txt_rewrite($audit_data['files']['llms_txt_url'])
  //   - Stores audit_id in option 'fq_active_audit_id'
  //
  // inject_schema_blocks(string $schema_url): void
  //   - wp_remote_get(schema_url), store JSON in wp_options 'fq_schema_blocks'
  //   - add_action('wp_head', [self, 'output_schema_blocks'])
  //
  // output_schema_blocks(): void
  //   - echo '<script type="application/ld+json">' . get_option('fq_schema_blocks') . '</script>'
  //
  // inject_llms_txt_link(): void
  //   - add_action('wp_head', [self, 'output_llms_txt_link'])
  //
  // output_llms_txt_link(): void
  //   - echo '<link rel="alternate" type="text/plain" href="' . home_url('/flowblinq-llms.txt') . '">'
  //
  // register_llms_txt_rewrite(string $source_url): void
  //   - wp_remote_get(source_url), store content in wp_options 'fq_llms_txt_content'
  //   - add_rewrite_rule('^flowblinq-llms\.txt$', 'index.php?fq_llms_txt=1', 'top')
  //   - add_filter('query_vars', add 'fq_llms_txt')
  //   - add_action('template_redirect', serve from option if var is set)
  //
  // is_active(): bool — true if 'fq_active_audit_id' option is set
}
```

#### `assets/admin.js`

```javascript
// jQuery-based (WP standard)
// - On "Run Free Audit" click: nonce-authenticated wp.ajax call → handle_ajax_run_audit
//   Sets polling interval (5s) on returned audit_id
// - Polling: wp.ajax → handle_ajax_poll_audit(audit_id)
//   On pipelineStatus === "complete": clear interval, render scorecard panel
// - On "Apply Optimizations": wp.ajax → handle_ajax_apply(audit_id)
//   Shows confirmation toast, reveals "Verify My Changes" button
// - On "Verify My Changes": wp.ajax → handle_ajax_verify(audit_id)
//   Re-starts polling interval for second run
//   On second run complete: render before/after comparison table
// - On "Test Connection": wp.ajax → get_account, show balance or error
// No background polling — all user-initiated
```

#### `readme.txt` required sections:

```
=== Flowblinq GEO ===
Contributors: flowblinq
Tags: seo, ai, geo, llm, optimization
Requires at least: 5.8
Tested up to: 6.7
Stable tag: 0.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

== Description ==
== Installation ==
== Frequently Asked Questions ==
== Screenshots ==
== Changelog ==
== Upgrade Notice ==
```

---

## c) Unit Test Plan

**Test file:** `geo/__tests__/api-auth.test.ts`

| ID | Function | Input | Expected |
|----|----------|-------|----------|
| U-1 | `signApiToken` | valid payload | returns string JWT |
| U-2 | `verifyApiToken` | valid token | returns payload with correct sub/team_id/scopes |
| U-3 | `verifyApiToken` | expired token | throws (JWTExpired or similar) |
| U-4 | `verifyApiToken` | tampered signature | throws (JWSInvalid) |
| U-5 | `verifyApiToken` | wrong secret | throws |
| U-6 | `requireScope` | scopes includes required | no throw |
| U-7 | `requireScope` | scopes missing required | throws with 403 marker |
| U-8 | Module load | missing `API_JWT_SECRET` env | throws at import |

**Test file:** `geo/__tests__/oauth-token.test.ts`

Mock: `@/lib/db`, `@/lib/db/api-clients`, `@/lib/api-auth`, `@/lib/rate-limit`

| ID | Scenario | Input | Expected Status |
|----|----------|-------|-----------------|
| O-1 | Valid credentials | correct client_id + secret, active client | 200, access_token in body |
| O-2 | Wrong secret | correct client_id, bad secret | 401 |
| O-3 | Client not found | unknown client_id | 401 |
| O-4 | Revoked client | revokedAt is set | 401, error: "client_revoked" |
| O-5 | Wrong grant_type | grant_type: "authorization_code" | 400 |
| O-6 | Missing client_id | no client_id field | 400 |
| O-7 | Rate limited | 11th request same client_id/min | 429 |
| O-8 | `touchLastUsed` called | valid credentials | lastUsedAt updated |

**Test file:** `geo/__tests__/v1-audit.test.ts`

Mock: `@/lib/api-auth`, `@/lib/db`, `@/lib/qstash`

| ID | Scenario | Input | Expected |
|----|----------|-------|----------|
| A-1 | New domain, valid JWT | valid token + url | 201, audit_id, free_run_number=1 |
| A-2 | Missing Authorization | no header | 401 |
| A-3 | Invalid token | bad JWT | 401 |
| A-4 | Missing scope | token lacks audit:write | 403 |
| A-5 | SSRF url | url=http://169.254.169.254 | 400 |
| A-6 | Domain exists, run=1, complete | re-submit same domain | 409 with audit_id |
| A-7 | Domain exhausted (run=2, used=true) | re-submit | 402 with credits_purchase_url |
| A-8 | Domain in-progress | re-submit | 200 with existing audit_id |
| A-9 | crawlLimit set to 50 | new domain | inserted row has crawlLimit=50 |

**Test file:** `geo/__tests__/v1-audit-get.test.ts`

| ID | Scenario | Input | Expected |
|----|----------|-------|----------|
| G-1 | Audit found, complete | valid JWT + id | 200, full JSON shape |
| G-2 | Audit not found | unknown id | 404 |
| G-3 | Wrong team | other team's site | 403 |
| G-4 | MCP format via ?format=mcp | format=mcp param | MCP tool_result JSON |
| G-5 | MCP format via Accept header | Accept: application/mcp+json | MCP tool_result JSON |
| G-6 | Incomplete audit | pipelineStatus=pending | status=pending, scorecard=null |

**Test file:** `geo/__tests__/v1-verify.test.ts`

| ID | Scenario | Input | Expected |
|----|----------|-------|----------|
| V-1 | Valid first run verify | freeRunNumber=1, used=false | 200, status=pending, run_number=2 |
| V-2 | Already on run 2 | freeRunNumber=2 | 400 |
| V-3 | Already used | freeOptimizationUsed=true | 400 |
| V-4 | Audit not complete yet | pipelineStatus=pending | 400 |
| V-5 | Wrong team | other team's site | 403 |
| V-6 | previousRunSnapshot saved | valid verify | previousRunSnapshot = prior geoScorecard |

**Test file:** `geo/__tests__/mcp-formatter.test.ts`

| ID | Scenario | Input | Expected |
|----|----------|-------|----------|
| M-1 | Complete audit | site with geoScorecard + llmsTxt | MCP tool_result with text + resource |
| M-2 | Incomplete audit | pipelineStatus=pending | single text content item |
| M-3 | Missing llmsTxt | site without generatedLlmsTxt | resource item omitted |

**Test file:** `geo/__tests__/api-clients-db.test.ts`

Mock: `@/lib/db`, `bcryptjs`

| ID | Function | Scenario | Expected |
|----|----------|----------|----------|
| D-1 | `createApiClient` | valid input | row inserted, returns client_id + secret (plaintext) |
| D-2 | `verifyApiClientSecret` | correct secret | returns true |
| D-3 | `verifyApiClientSecret` | wrong secret | returns false |
| D-4 | `revokeApiClient` | valid call | revokedAt updated |
| D-5 | `listApiClientsForTeam` | team with 2 clients | returns 2 rows |

**Coverage target:** ≥85% line coverage on all new `lib/` files.

---

## d) Integration Test Plan

**Test file:** `geo/__tests__/integration/api-v1-flow.test.ts`

These tests exercise the full chain against a real (test) DB or a closely mocked DB chain.

| ID | Scenario | Steps | Expected |
|----|----------|-------|----------|
| I-1 | Full OAuth → audit submit → poll flow | (1) create apiClient row, (2) POST token, (3) POST audit, (4) GET audit | All 3 steps succeed with correct shapes |
| I-2 | Free tier gate enforcement | Submit same domain 3× | 3rd returns 402 |
| I-3 | Token expiry | Use JWT with exp = now-1 | GET audit → 401 |
| I-4 | Revoked client token | Revoke client after issuing token, use old JWT | GET audit → 401 (token invalid after revocation — note: since stateless JWT, this requires checking revokedAt against token iat — spec for ScriptDev: add revokedAt check in verifyApiToken by comparing against client lookup OR simply accept blast radius is 1hr until expiry; document this tradeoff) |
| I-5 | Scope mismatch | Token with only audit:read attempts POST /audit | 403 |
| I-6 | MCP round-trip | POST audit, GET audit?format=mcp when complete | Valid MCP tool_result |

---

## e) Profiling Requirements

**What to measure:**
- `POST /api/oauth/token`: end-to-end latency (bcrypt compare is the bottleneck)
- `GET /api/v1/audit/{id}`: DB query latency + MCP formatting time

**Baseline expectations:**
- `POST /api/oauth/token`: p50 ≤ 300ms (bcrypt cost factor 12 = ~200ms CPU), p99 ≤ 600ms
- `GET /api/v1/audit/{id}` JSON: p50 ≤ 50ms, p99 ≤ 150ms
- `GET /api/v1/audit/{id}` MCP: p50 ≤ 80ms (includes formatting), p99 ≤ 200ms

**Profiling approach:**
- `console.time`/`console.timeEnd` around bcrypt compare in token endpoint (remove in prod or gate behind `LOG_LEVEL=debug`)
- Log `x-vercel-id` and response time in each route handler for cold start tracking
- Recommended tool: Vercel Speed Insights + manual `Date.now()` timing in `api-auth.ts`

---

## f) Load Test Plan

**Tool:** k6 (script in `scripts/load-test-v1-api.js`)

### Scenario 1 — OAuth token endpoint

- 50 concurrent VUs, 60s duration
- Each VU: POST /api/oauth/token once per 5s
- Success criteria: p95 ≤ 500ms, p99 ≤ 800ms, error rate < 1%

### Scenario 2 — GET audit polling (WordPress plugin simulation)

- 200 concurrent VUs (simulates 200 active WP installs polling)
- Each VU: GET /api/v1/audit/{id} every 5s for 2 min
- Success criteria: p95 ≤ 200ms, p99 ≤ 400ms, error rate < 0.5%

### Scenario 3 — Rate limit validation

- 15 VUs hitting POST /api/oauth/token with same client_id within 60s
- Expected: first 10 → 200, remainder → 429
- Success criteria: rate limiter fires correctly with no DB errors

**Resource bounds:**
- DB connections: ≤ 80 concurrent (Supabase free tier limit: 100)
- Memory: no increase beyond baseline on GET endpoints (no large allocations)

---

## g) Logging & Instrumentation

### Events to log (structured JSON via `console.log(JSON.stringify({...}))`)

| Event key | When | Fields |
|-----------|------|--------|
| `oauth_token_issued` | Token issued | `{ event, clientId, teamId, scopes }` |
| `oauth_token_rejected` | Invalid credentials | `{ event, clientId, reason: "not_found"|"revoked"|"bad_secret" }` |
| `v1_audit_submitted` | New audit via API | `{ event, auditId, domain, teamId, clientId, freeRunNumber }` |
| `v1_audit_free_tier_block` | 3rd run attempt | `{ event, domain, teamId, clientId }` |
| `v1_verify_triggered` | Second run triggered | `{ event, auditId, domain, teamId }` |
| `v1_rate_limit_exceeded` | Token rate limit hit | `{ event, clientId, count }` |

### Metrics to emit

- Count of `oauth_token_issued` per day → tracks API adoption
- Count of `v1_audit_submitted` per day → tracks WP plugin installs initiating audits
- Count of `v1_audit_free_tier_block` → free tier conversion pressure signal

### Log level guidance

- **INFO**: `oauth_token_issued`, `v1_audit_submitted`, `v1_verify_triggered`
- **WARN**: `oauth_token_rejected`, `v1_rate_limit_exceeded`, `v1_audit_free_tier_block`
- **ERROR**: any unhandled exception in route handlers (with stack trace)

---

## h) Acceptance Criteria

- [ ] `POST /api/oauth/token` with valid client_id + client_secret returns signed JWT with correct shape (sub, team_id, scopes, exp)
- [ ] Invalid/revoked credentials return 401; rate limit (>10/min same client_id) returns 429
- [ ] `POST /api/v1/audit` with valid JWT creates a geoSite row with crawlLimit=50, freeRunNumber=1, apiClientId set
- [ ] Third submission for same domain returns 402 with `credits_purchase_url`
- [ ] `GET /api/v1/audit/{id}` returns full result when pipeline is complete
- [ ] `GET /api/v1/audit/{id}?format=mcp` returns valid MCP tool_result JSON
- [ ] `POST /api/v1/audit/{id}/verify` triggers second run, sets freeOptimizationUsed=true, saves previousRunSnapshot
- [ ] `GET /api/v1/mcp` returns MCP manifest with OAuth config and 4 tools — no auth required
- [ ] `GET /api/v1/account` returns credit_balance and free_optimization_domains count
- [ ] Dashboard API Access section lists clients and exposes Generate/Revoke actions
- [ ] New apiClients row: client_secret shown once in UI, only hash stored in DB
- [ ] WordPress plugin: Install → settings → test connection → run audit → scorecard renders → apply → verify → before/after comparison — zero JS console errors
- [ ] "Powered by Flowblinq" toggle defaults to OFF
- [ ] All WP HTTP calls use `wp_remote_post()`/`wp_remote_get()` — no curl, no background wp-cron calls without user action
- [ ] Migration `0002_api_clients.sql` runs cleanly against existing schema
- [ ] All unit tests pass. Coverage ≥85% on `lib/api-auth.ts` and `lib/db/api-clients.ts`
- [ ] `bcryptjs` and `jose` added to `package.json` dependencies

---

## Notes for ScriptDev

1. **bcryptjs vs jsonwebtoken**: Use `bcryptjs` for secret hashing (pure JS, no native bindings). Use `jose` for JWT (JOSE spec, edge-safe). Do NOT use `jsonwebtoken` — it does not work in Next.js edge runtime.

2. **Revocation + stateless JWT**: JWT tokens are stateless with 1hr expiry. A revoked client's existing tokens remain valid until expiry. This is acceptable given the 1hr TTL — document this in code comments. If synchronous revocation is required later, add a `revokedAt` check inside `verifyApiToken` by doing a DB lookup on the `sub` claim.

3. **crawlLimit=50 on free tier**: The `geoSites.crawlLimit` column already exists. The pipeline runner already reads `crawlLimit` to cap scraping. No runner changes needed — just set `crawlLimit: 50` on insert in `app/api/v1/audit/route.ts`.

4. **WordPress plugin directory location**: `wordpress-plugin/flowblinq-geo/` at repo root. Not inside `geo/` (the Next.js app). Add to `.gitignore` exclusions: none needed — include in repo.

5. **`previousRunSnapshot` for before/after**: `geoSites.previousRunSnapshot` column already exists in schema. On `verify` call, copy current `geoScorecard` into `previousRunSnapshot` before re-running.

6. **SSRF protection**: Reuse the `PRIVATE_RANGES` constant from `app/api/sites/route.ts` in `app/api/v1/audit/route.ts`. Extract to `lib/ssrf.ts` for shared use (optional refactor — only do this if both files need the same list; otherwise inline).

7. **Middleware ALWAYS_ALLOWED**: Add `/api/oauth/token` and `/api/v1/` to the allowlist. JWT auth is enforced per-route, not in middleware — keeps the middleware lean.

8. **Dashboard team auth**: The `/api/teams/{teamId}/api-clients` routes must use the existing Supabase session auth pattern (check `x-user-id` header injected by Supabase middleware), not JWT. Look at `app/api/teams/route.ts` for the pattern.
