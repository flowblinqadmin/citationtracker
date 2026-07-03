# TS-019: Flowblinq Public API + WordPress Plugin

**Status:** Draft
**Author:** CoFounder
**Date:** 2026-03-03
**Downstream:** SpecMaster → ReviewMaster → ScriptDev

---

## Context

Flowblinq's GEO capabilities currently exist only as a web product accessed via a browser. This TS specifies extending them into a public API with OAuth 2.0 authentication (MCP-compatible from day one), a versioned REST interface, and a WordPress plugin as the first external consumer. The goal is to turn WordPress's 43% market share into a customer acquisition channel — every free-tier install is a domain in Flowblinq's system and a user in the funnel.

The initiative starts with GEO. The ACP product follows the same methodology later with no architectural changes.

---

## Free Tier Model (Critique + Spec)

### What the user proposed
- One-time GEO optimization per domain, free forever
- Two audit reports: baseline (before) + post-optimization (after)
- Optimization assets (llms.txt, business.json, schema blocks) hosted on Flowblinq forever
- Any subsequent re-optimization requires credits purchased on flowblinq.com

### Critique

**Strengths:**
- "Forever free hosting" is a marginal cost (text files, ~10KB per domain). At 100k domains, this is a rounding error on storage.
- Two reports is the right story arc: "here's how broken you are → here's what we fixed → pay us to keep improving." This is a demo, not just a free tier.
- Domain-scoped (not credit-scoped) free tier eliminates the credit farming abuse vector entirely.

**Risks to resolve in this spec:**
1. **Two pipeline runs cost real compute** — one run = Firecrawl scrape + Gemini analysis + Claude assembly. Two free runs per domain means Flowblinq eats ~2× LLM + crawl cost per acquisition. At scale, this is a CAC line item. Recommend: cap free crawl depth at 50 pages for both free runs (vs. the 100-page default for paid). Scorecard is still valid; cost is halved.
2. **"After optimization" requires implementation by the user** — the system needs to know when to trigger the second run. Options: (a) user-initiated ("I've made the changes, re-audit now"), (b) time-delayed (auto re-crawl after 7 days). Recommend: user-initiated via plugin button ("Verify my changes") — this also creates an engagement event.
3. **Free tier state machine** — need a DB flag (`freeOptimizationUsed: boolean`) on `geoSites` to know which run is the "after" and to block a third free run. This is a new column.
4. **WordPress auto-injection** — the WP plugin can directly inject the schema blocks, add the llms.txt `<link>` tag, and register the business.json endpoint. If the plugin implements the changes automatically, the "after" audit becomes a proof-of-value moment. This should be v0.1, not deferred.

---

## Architecture Overview

```
WordPress Plugin (PHP)
    ↓  client_id + client_secret
POST /api/oauth/token  →  JWT access token (1hr)
    ↓  Authorization: Bearer <jwt>
/api/v1/*  (versioned public API)
    ↓  same as today
Existing pipeline (QStash, Firecrawl, Gemini, Claude)
    ↓
/api/serve/[slug]/*  (existing, unchanged)

AI Agent (Claude, Cursor, etc.)
    ↓  OAuth 2.0 (MCP spec)
/api/v1/mcp  →  MCP-formatted tool responses
```

---

## Layer 1: OAuth 2.0 Auth Server

### New DB Table: `apiClients`

```typescript
{
  id: text (PK, nanoid),
  teamId: text (FK → teams),
  clientId: text (unique, nanoid(24)),      // public identifier
  clientSecretHash: text,                    // bcrypt hash of secret
  name: text,                               // e.g. "WordPress Plugin"
  scopes: text[],                           // ["audit:read", "audit:write", "account:read"]
  lastUsedAt: timestamp,
  revokedAt: timestamp (nullable),
  createdAt: timestamp,
}
```

### New Endpoint: `POST /api/oauth/token`

**Request:**
```json
{
  "grant_type": "client_credentials",
  "client_id": "fq_live_abc123",
  "client_secret": "sk_abc..."
}
```

**Response:**
```json
{
  "access_token": "<signed JWT>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "audit:read audit:write account:read"
}
```

**JWT payload:**
```json
{
  "sub": "client_id",
  "team_id": "team_abc",
  "scopes": ["audit:read", "audit:write", "account:read"],
  "iat": 1234567890,
  "exp": 1234571490
}
```

**Implementation notes:**
- Sign with `JOSE` library (already available in Next.js edge runtime) using `API_JWT_SECRET` env var
- Verify client_secret with bcrypt compare (`bcryptjs`, add to deps)
- Rate limit: 10 token requests/min per client_id (use existing `rateLimits` table)
- No token storage — stateless JWT validation in middleware

### Auth Middleware (API routes)

New middleware branch for `/api/v1/*`:
- Reads `Authorization: Bearer <token>`
- Validates JWT signature + expiry
- Extracts `team_id` and `scopes`
- Injects as request headers (same pattern as existing Supabase middleware: `x-api-team-id`, `x-api-scopes`)
- Separate from Supabase session auth — these are parallel auth paths

### Dashboard UI: API Keys Section

New section in `/app/dashboard/` — "API Access":
- List existing clients (name, client_id, created, last used)
- "Generate new key" → show client_id + client_secret once (not stored, only hash stored)
- "Revoke" button → sets `revokedAt`

---

## Layer 2: Public API Routes (`/api/v1/`)

All routes require `Authorization: Bearer <jwt>`. Scopes enforced per endpoint.

### `POST /api/v1/audit`
**Scope:** `audit:write`

Submits a URL for GEO audit. For free-tier clients, enforces domain deduplication and free run state.

**Request:**
```json
{
  "url": "https://example.com",
  "mode": "single" | "bulk",
  "urls": ["..."]  // only for bulk
}
```

**Response:**
```json
{
  "audit_id": "site_abc123",
  "status": "pending",
  "free_tier": true,
  "free_run_number": 1,   // 1 = baseline, 2 = post-optimization
  "estimated_completion_seconds": 120
}
```

**Free tier logic:**
- Check `geoSites` for existing domain under this team
- If none: create site, `freeOptimizationUsed = false`, `freeRunNumber = 1`
- If exists + `freeOptimizationUsed = false` + `freeRunNumber = 1`: allow second run, set `freeRunNumber = 2`
- If exists + `freeOptimizationUsed = true` + `freeRunNumber = 2`: reject with 402, return credits purchase URL
- Crawl depth capped at 50 pages for both free runs

### `GET /api/v1/audit/{id}`
**Scope:** `audit:read`

Poll audit status and retrieve results.

**Response (JSON):**
```json
{
  "audit_id": "site_abc123",
  "domain": "example.com",
  "status": "complete",
  "overall_score": 62,
  "free_run_number": 1,
  "scorecard": { ... },         // GeoScorecard shape (existing)
  "recommendations": [ ... ],
  "executive_summary": "...",
  "files": {
    "llms_txt_url": "https://geo.flowblinq.com/api/serve/example-com/llms.txt",
    "business_json_url": "...",
    "schema_json_url": "..."
  },
  "created_at": "...",
  "completed_at": "..."
}
```

**MCP output** (via `Accept: application/mcp+json` or `?format=mcp`):
```json
{
  "type": "tool_result",
  "tool": "get_audit",
  "content": [
    {
      "type": "text",
      "text": "GEO audit for example.com — Score: 62/100\n\nTop issues:\n1. ..."
    },
    {
      "type": "resource",
      "resource": {
        "uri": "https://geo.flowblinq.com/api/serve/example-com/llms.txt",
        "mimeType": "text/plain",
        "text": "..."   // inline content for MCP consumers
      }
    }
  ]
}
```

### `POST /api/v1/audit/{id}/verify`
**Scope:** `audit:write`

Triggers the "after optimization" second run (user-initiated).

**Request:** `{}` (no body — audit_id in path is sufficient)

**Validation:**
- `freeRunNumber` must be 1 and `freeOptimizationUsed` must be false
- Sets `freeOptimizationUsed = true`, enqueues pipeline re-run

### `GET /api/v1/account`
**Scope:** `account:read`

Returns team credit balance and usage.

**Response:**
```json
{
  "team_id": "...",
  "credit_balance": 95,
  "free_optimization_domains": 3,
  "credits_purchase_url": "https://geo.flowblinq.com/pricing"
}
```

### `GET /api/v1/mcp` (MCP Manifest)
**No auth required** — discovery endpoint

Returns MCP server manifest listing available tools:
```json
{
  "protocol": "mcp",
  "version": "1.0",
  "auth": {
    "type": "oauth2",
    "token_url": "https://geo.flowblinq.com/api/oauth/token",
    "grant_type": "client_credentials",
    "scopes": ["audit:read", "audit:write", "account:read"]
  },
  "tools": [
    {
      "name": "run_audit",
      "description": "Submit a URL for GEO analysis",
      "inputSchema": { ... }
    },
    {
      "name": "get_audit",
      "description": "Retrieve GEO audit results",
      "inputSchema": { ... }
    },
    {
      "name": "verify_optimization",
      "description": "Trigger post-optimization re-audit",
      "inputSchema": { ... }
    },
    {
      "name": "get_account",
      "description": "Get credit balance",
      "inputSchema": { ... }
    }
  ]
}
```

---

## Layer 3: WordPress Plugin

**Plugin name:** `Flowblinq GEO`
**Slug:** `flowblinq-geo` (permanent — choose carefully)
**License:** GPL v2+
**Plugin file:** `flowblinq-geo.php`

### File Structure
```
flowblinq-geo/
├── flowblinq-geo.php         # Main plugin file (headers, activation hook)
├── readme.txt                # WordPress.org directory listing
├── includes/
│   ├── class-api-client.php  # HTTP wrapper (uses wp_remote_post)
│   ├── class-admin-page.php  # WP admin settings + audit UI
│   └── class-injector.php    # Auto-inject schema blocks + llms.txt link tag
├── assets/
│   ├── admin.css
│   └── admin.js              # Poll audit status, render scorecard
└── languages/                # i18n pot file
```

### Settings Page (`Settings > Flowblinq GEO`)
- Client ID field
- Client Secret field (masked)
- "Test connection" button → calls `GET /api/v1/account`
- "Powered by Flowblinq" toggle (default: OFF — WP Rule 10)

### Audit Page (`Tools > GEO Audit`)
- Domain auto-populated from `get_site_url()`
- "Run Free Audit" button → `POST /api/v1/audit`
- Progress indicator (polls `GET /api/v1/audit/{id}` every 5s)
- Results panel: overall score, pillar breakdown, recommendations
- "Apply optimizations automatically" button → `class-injector.php` injects schema blocks into `wp_head`, registers llms.txt rewrite rule
- "Verify my changes" button (shown after apply) → `POST /api/v1/audit/{id}/verify`
- After second report: displays before/after score comparison
- "Improve my score further" → links to `https://geo.flowblinq.com/pricing`

### Auto-Injector (`class-injector.php`)
Adds to `wp_head`:
- JSON-LD schema blocks from `schemaBlocks`
- `<link rel="alternate" type="text/plain" href="/flowblinq-llms.txt">`

Registers rewrite rule for `/flowblinq-llms.txt` → serves content from Flowblinq API (proxied via plugin) or stores locally in `wp_options`.

### WP Rules Compliance Checklist
- Rule 5 (no trialware): free audit is fully functional ✓
- Rule 6 (SaaS permitted): plugin calls Flowblinq API ✓
- Rule 7 (no tracking): all calls are user-initiated ✓
- Rule 10 ("Powered by"): default OFF ✓
- Rule 13 (WP libraries): uses `wp_remote_post()` throughout ✓
- Rule 16 (complete at submission): ship only when full flow works end-to-end ✓

---

## Database Changes

| Table | Change | Reason |
|-------|--------|--------|
| `apiClients` | **New** | OAuth client credentials storage |
| `geoSites` | Add `freeOptimizationUsed: boolean` | Track free tier state |
| `geoSites` | Add `freeRunNumber: int (1\|2)` | Distinguish baseline vs post-opt run |
| `geoSites` | Add `apiClientId: text (nullable)` | Track which API client created this site |

No changes to `teams`, `creditTransactions`, or `teamMembers`.

---

## New Environment Variables

```env
API_JWT_SECRET=<32-byte random secret>   # Sign/verify API access tokens
```

---

## Files to Create / Modify

### Create (new)
| File | Purpose |
|------|---------|
| `app/api/oauth/token/route.ts` | OAuth token endpoint |
| `app/api/v1/audit/route.ts` | POST new audit |
| `app/api/v1/audit/[id]/route.ts` | GET audit status/results |
| `app/api/v1/audit/[id]/verify/route.ts` | POST trigger second run |
| `app/api/v1/account/route.ts` | GET credit balance |
| `app/api/v1/mcp/route.ts` | MCP manifest |
| `lib/api-auth.ts` | JWT sign/verify, scope enforcement |
| `lib/db/api-clients.ts` | DB queries for apiClients table |
| `drizzle/migrations/xxx_api_clients.sql` | Migration |
| `wordpress-plugin/flowblinq-geo/` | Full plugin directory |

### Modify (existing)
| File | Change |
|------|--------|
| `middleware.ts` | Add `/api/v1/*` branch → JWT auth path |
| `lib/db/schema.ts` | Add `apiClients` table, new columns on `geoSites` |
| `app/dashboard/page.tsx` | Add "API Access" section |
| `app/api/sites/route.ts` | Respect `apiClientId` and free tier caps when called via v1 API |

### Reuse (unchanged)
| File | What it provides |
|------|-----------------|
| `lib/pipeline/runner.ts` | Same pipeline — no changes needed |
| `app/api/serve/[slug]/*` | Public file serving — unchanged |
| `app/api/webhooks/stripe/route.ts` | Credits purchase — unchanged |
| `lib/email.ts` | Completion email — unchanged |
| `lib/db/schema.ts` (existing tables) | All existing tables unchanged |

---

## Acceptance Criteria

1. **OAuth flow:** `POST /api/oauth/token` with valid client_id + client_secret returns a signed JWT. Invalid credentials return 401. Revoked clients return 401.
2. **Audit via API:** `POST /api/v1/audit` with valid JWT submits a site and triggers the existing pipeline. Same result quality as web flow.
3. **Free tier gate:** Third run on same domain returns 402 with `credits_purchase_url`.
4. **MCP output:** `GET /api/v1/audit/{id}?format=mcp` returns valid MCP tool_result JSON.
5. **MCP manifest:** `GET /api/v1/mcp` returns valid MCP server manifest with OAuth config.
6. **WordPress plugin:** Install → enter credentials → run audit → see scorecard → apply optimizations → verify → see before/after — all within WP admin. Zero frontend errors.
7. **WP Rule compliance:** "Powered by" off by default. All HTTP via `wp_remote_post()`. No background calls without user action.
8. **Rate limiting:** More than 10 token requests/min per client_id → 429.

---

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| LLM cost for 2 free runs per domain | Medium | Cap free crawl at 50 pages |
| Free tier abuse via many domains | Low | Domain is the unit, not client |
| WP plugin review rejection | Low | Full compliance checklist in spec |
| MCP spec evolves before ship | Medium | Pin to MCP spec version, abstract behind `lib/mcp-formatter.ts` |
| JWT secret rotation disrupts active tokens | Low | 1hr expiry limits blast radius |

---

## Out of Scope (this TS)

- ACP product extension (follow-on TS)
- Web UI auth redesign (OTP stays for web users)
- Shopify / HubSpot / Webflow plugins (follow-on)
- Subscription billing model (credits-only for now)
- Plugin localization / i18n (v0.2)
- **Management API for programmatic credential issuance (v0.2)**

### Note on Management API (v0.2 design intent)

Credential issuance in v0.1 is dashboard-only (UI button → generates client_id + client_secret → user copies into plugin). This is correct for the WordPress use case — a one-time manual action per installation.

A Management API (`POST /api/v1/management/clients`) becomes necessary for the **agency / multi-tenant use case**: a web agency managing N client sites needs to programmatically provision a scoped key per client. This is the Stripe/Twilio pattern — a master key issues sub-keys with restricted scopes.

The `apiClients` table design already accommodates this. No architectural rework needed in v0.2 — just a new endpoint authenticated with a master credential tier. Do not build this in v0.1.
