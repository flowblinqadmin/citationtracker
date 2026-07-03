# Flowblinq API Reference

**Base URL:** `https://geo.flowblinq.com`
**Version:** v1
**Auth:** OAuth 2.0 — Client Credentials

---

## Overview

The Flowblinq API gives you programmatic access to the same GEO (Generative Engine Optimisation) analysis engine that powers the Flowblinq web product. Submit any URL, receive a full 16-pillar GEO scorecard, and retrieve the optimisation assets (llms.txt, business.json, schema blocks) that make your content legible to AI systems like ChatGPT, Perplexity, and Claude.

The API is MCP-compatible from day one — AI agents and tools that speak the Model Context Protocol can discover and invoke it without custom integration code.

---

## User Flow

```
1. Create API credentials in your Flowblinq dashboard
        ↓
2. Exchange credentials for an access token
        ↓
3. Submit a URL for GEO analysis
        ↓
4. Poll until complete, retrieve scorecard + assets
        ↓
5. Apply optimisations, then trigger a verification re-audit
        ↓
6. Compare before/after scores
```

---

## Step 1 — Create API Credentials

Log in to your Flowblinq dashboard at `https://geo.flowblinq.com/dashboard`.

Navigate to **Settings → API Access** and click **Generate new key**.

You will be shown your credentials **once** — copy and store them securely:

| Field | Example | Description |
|-------|---------|-------------|
| `client_id` | `fq_live_a8x9k2m4n7p3` | Public identifier. Safe to include in config files. |
| `client_secret` | `sk_7fGh2...` | Secret key. Never commit to source control. |

To revoke a key at any time, return to API Access and click **Revoke**.

---

## Step 2 — Authentication

The Flowblinq API uses the **OAuth 2.0 Client Credentials** grant. Exchange your `client_id` and `client_secret` for a short-lived access token, then include it on every subsequent request.

### `POST /api/oauth/token`

**No authentication required on this endpoint.**

**Request**

```http
POST /api/oauth/token
Content-Type: application/json

{
  "grant_type": "client_credentials",
  "client_id": "fq_live_a8x9k2m4n7p3",
  "client_secret": "sk_7fGh2..."
}
```

**Response — `200 OK`**

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "audit:read audit:write account:read"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `access_token` | `string` | JWT to include in all API requests |
| `token_type` | `"Bearer"` | Always `Bearer` |
| `expires_in` | `number` | Seconds until the token expires (3600 = 1 hour) |
| `scope` | `string` | Space-separated list of granted permissions |

**Using the token**

Include the token in the `Authorization` header on every request:

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Tokens expire after **1 hour**. Request a new one using the same credentials — there is no refresh token flow.

**Errors**

| Status | Meaning |
|--------|---------|
| `401` | Invalid `client_id` or `client_secret` |
| `401` | Credentials have been revoked |
| `429` | More than 10 token requests per minute from this `client_id` |

---

## Step 3 — Submit an Audit

### `POST /api/v1/audit`

**Required scope:** `audit:write`

Submit a URL for GEO analysis. The audit runs asynchronously — this endpoint returns immediately with an `audit_id` you use to poll for results.

**Request**

```http
POST /api/v1/audit
Authorization: Bearer <token>
Content-Type: application/json

{
  "url": "https://example.com"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | Yes | The URL to audit. Must be a valid `https://` URL. |

**Response — `200 OK`**

```json
{
  "audit_id": "site_k9m3x7p2",
  "status": "pending",
  "free_tier": true,
  "free_run_number": 1,
  "estimated_completion_seconds": 120
}
```

| Field | Type | Description |
|-------|------|-------------|
| `audit_id` | `string` | Use this to poll for results |
| `status` | `"pending"` | Audit has been queued |
| `free_tier` | `boolean` | `true` if this run is counted against your free allocation |
| `free_run_number` | `1 \| 2` | `1` = baseline audit, `2` = post-optimisation re-audit |
| `estimated_completion_seconds` | `number` | Approximate time to completion |

**Free tier**

Each domain receives **two free audits** — one baseline and one verification run after you apply optimisations. Additional runs require credits. See [Free Tier](#free-tier) for full details.

**Errors**

| Status | Meaning |
|--------|---------|
| `401` | Token missing or expired |
| `402` | Free audits exhausted for this domain. Response includes `credits_purchase_url`. |
| `422` | Invalid or non-HTTPS URL |

---

## Step 4 — Retrieve Results

### `GET /api/v1/audit/{audit_id}`

**Required scope:** `audit:read`

Poll this endpoint until `status` is `"complete"` or `"failed"`. We recommend polling every **5 seconds**.

**Request**

```http
GET /api/v1/audit/site_k9m3x7p2
Authorization: Bearer <token>
```

**Response — `200 OK` (in progress)**

```json
{
  "audit_id": "site_k9m3x7p2",
  "domain": "example.com",
  "status": "crawling",
  "overall_score": null,
  "free_run_number": 1,
  "scorecard": null,
  "recommendations": [],
  "executive_summary": null,
  "files": {
    "llms_txt_url": null,
    "business_json_url": null,
    "schema_json_url": null
  },
  "created_at": "2026-03-03T16:00:00Z",
  "completed_at": null
}
```

**Response — `200 OK` (complete)**

```json
{
  "audit_id": "site_k9m3x7p2",
  "domain": "example.com",
  "status": "complete",
  "overall_score": 62,
  "free_run_number": 1,
  "scorecard": {
    "technicalAccessibility": { "score": 8, "max": 10, "issues": ["No llms.txt found"] },
    "contentStructure":       { "score": 6, "max": 10, "issues": ["Missing FAQ schema"] },
    "entityClarity":          { "score": 5, "max": 10, "issues": ["Business entity not defined"] },
    "citationReadiness":      { "score": 7, "max": 10, "issues": [] }
  },
  "recommendations": [
    "Add an llms.txt file to declare your site's AI permissions and content index.",
    "Implement FAQ schema markup on your key landing pages.",
    "Define your business entity in business.json with NAP data and category tags."
  ],
  "executive_summary": "example.com scores 62/100 on GEO readiness. The site is partially crawlable by AI systems but lacks the structured signals needed for reliable citation. Priority actions: llms.txt, entity definition, FAQ schema.",
  "files": {
    "llms_txt_url": "https://geo.flowblinq.com/api/serve/example-com/llms.txt",
    "business_json_url": "https://geo.flowblinq.com/api/serve/example-com/business.json",
    "schema_json_url": "https://geo.flowblinq.com/api/serve/example-com/schema.json"
  },
  "created_at": "2026-03-03T16:00:00Z",
  "completed_at": "2026-03-03T16:02:14Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `audit_id` | `string` | Audit identifier |
| `domain` | `string` | Extracted domain from submitted URL |
| `status` | `string` | `pending` → `crawling` → `analyzing` → `generating` → `complete` \| `failed` |
| `overall_score` | `number \| null` | 0–100 GEO readiness score. `null` until complete. |
| `free_run_number` | `1 \| 2` | Which free run this represents |
| `scorecard` | `object \| null` | Per-pillar breakdown. `null` until complete. |
| `recommendations` | `string[]` | Ordered list of prioritised improvement actions |
| `executive_summary` | `string \| null` | Plain-English summary of findings |
| `files.llms_txt_url` | `string \| null` | Hosted llms.txt — link or serve directly from your domain |
| `files.business_json_url` | `string \| null` | Hosted business.json entity definition |
| `files.schema_json_url` | `string \| null` | Hosted JSON-LD schema blocks (backward compat). Prefer the unified tracking pixel: `<img src="https://geo.flowblinq.com/api/t/SLUG" width="1" height="1" alt="" style="position:absolute;opacity:0" />` — tracks visits and serves schema to bots automatically, no server-side fetch needed. |
| `created_at` | `string` | ISO 8601 timestamp |
| `completed_at` | `string \| null` | ISO 8601 timestamp. `null` until complete. |

**Pipeline status values**

| Status | Meaning |
|--------|---------|
| `pending` | Queued, not yet started |
| `crawling` | Fetching pages from your domain |
| `analyzing` | Running 16-pillar GEO analysis |
| `generating` | Building llms.txt, business.json, schema blocks |
| `complete` | All results available |
| `failed` | Pipeline error — retry by submitting the URL again |

**Errors**

| Status | Meaning |
|--------|---------|
| `401` | Token missing or expired |
| `404` | `audit_id` not found or does not belong to your team |

---

## Step 5 — Trigger Verification Re-Audit

After applying the optimisations (deploying llms.txt, adding schema blocks), trigger your second free run to measure improvement.

### `POST /api/v1/audit/{audit_id}/verify`

**Required scope:** `audit:write`

**Request**

```http
POST /api/v1/audit/site_k9m3x7p2/verify
Authorization: Bearer <token>
```

No request body required.

**Response — `200 OK`**

```json
{
  "audit_id": "site_k9m3x7p2",
  "status": "pending",
  "free_tier": true,
  "free_run_number": 2,
  "estimated_completion_seconds": 120
}
```

The `free_run_number: 2` confirms this is your post-optimisation run. Poll `/api/v1/audit/{audit_id}` as before. When complete, compare `overall_score` against your baseline run.

**Errors**

| Status | Meaning |
|--------|---------|
| `401` | Token missing or expired |
| `402` | Verification run already used for this domain |
| `404` | `audit_id` not found |
| `409` | Audit is not yet complete — cannot verify an in-progress audit |

---

## Step 6 — Check Account & Credits

### `GET /api/v1/account`

**Required scope:** `account:read`

**Request**

```http
GET /api/v1/account
Authorization: Bearer <token>
```

**Response — `200 OK`**

```json
{
  "team_id": "team_abc123",
  "credit_balance": 95,
  "free_optimization_domains": 3,
  "credits_purchase_url": "https://geo.flowblinq.com/pricing"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `team_id` | `string` | Your Flowblinq team identifier |
| `credit_balance` | `number` | Available credits for paid runs |
| `free_optimization_domains` | `number` | Domains that have used at least one free run |
| `credits_purchase_url` | `string` | Link to purchase additional credits |

---

## Free Tier

Every domain receives **two free audits** — scoped per domain, not per API client.

| Run | Triggered by | Purpose |
|-----|-------------|---------|
| Run 1 (`free_run_number: 1`) | `POST /api/v1/audit` | Baseline — your current GEO score |
| Run 2 (`free_run_number: 2`) | `POST /api/v1/audit/{id}/verify` | Verification — score after you apply optimisations |

Free-tier audits crawl up to **50 pages** (vs. 100 pages on paid runs). The scorecard is fully valid at this depth for most sites.

A third submission on the same domain returns `402 Payment Required` with a `credits_purchase_url` in the response body.

---

## MCP Integration

The Flowblinq API is compatible with the **Model Context Protocol (MCP)**. AI agents — Claude, Cursor, GPT-based tooling, and others — can discover and use Flowblinq as a native tool without custom integration code.

### Discovery

```http
GET /api/v1/mcp
```

No authentication required. Returns the MCP server manifest:

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
      "inputSchema": {
        "type": "object",
        "properties": {
          "url": { "type": "string", "description": "The URL to audit" }
        },
        "required": ["url"]
      }
    },
    {
      "name": "get_audit",
      "description": "Retrieve GEO audit results",
      "inputSchema": {
        "type": "object",
        "properties": {
          "audit_id": { "type": "string" },
          "format": { "type": "string", "enum": ["json", "mcp"] }
        },
        "required": ["audit_id"]
      }
    },
    {
      "name": "verify_optimization",
      "description": "Trigger post-optimisation re-audit",
      "inputSchema": {
        "type": "object",
        "properties": {
          "audit_id": { "type": "string" }
        },
        "required": ["audit_id"]
      }
    },
    {
      "name": "get_account",
      "description": "Get credit balance and usage",
      "inputSchema": {
        "type": "object",
        "properties": {}
      }
    }
  ]
}
```

### MCP-formatted audit response

Request an MCP `tool_result` instead of standard JSON by adding `?format=mcp`:

```http
GET /api/v1/audit/site_k9m3x7p2?format=mcp
Authorization: Bearer <token>
```

Or via the `Accept` header:

```http
Accept: application/mcp+json
```

**Response**

```json
{
  "type": "tool_result",
  "tool": "get_audit",
  "content": [
    {
      "type": "text",
      "text": "GEO audit for example.com — Score: 62/100\n\nTop recommendations:\n1. Add an llms.txt file to declare your site's AI permissions.\n2. Implement FAQ schema markup on key landing pages.\n3. Define your business entity in business.json."
    },
    {
      "type": "resource",
      "resource": {
        "uri": "https://geo.flowblinq.com/api/serve/example-com/llms.txt",
        "mimeType": "text/plain",
        "text": "# llms.txt\n\nUser-agent: *\nAllow: /\n\n## About\nExample Company — B2B SaaS..."
      }
    }
  ]
}
```

AI agents receive the score summary as readable text and the optimisation assets as inline resources — ready for direct use without additional requests.

---

## Error Reference

All errors follow a consistent shape:

```json
{
  "error": {
    "code": "insufficient_credits",
    "message": "Free audits exhausted for this domain. Purchase credits to continue.",
    "credits_purchase_url": "https://geo.flowblinq.com/pricing"
  }
}
```

| HTTP Status | Code | Meaning |
|-------------|------|---------|
| `400` | `invalid_request` | Malformed request body or missing required field |
| `401` | `invalid_credentials` | `client_id` or `client_secret` is incorrect |
| `401` | `token_expired` | Access token has expired — request a new one |
| `401` | `token_invalid` | Access token is malformed or revoked |
| `402` | `insufficient_credits` | Free tier exhausted; credits required |
| `403` | `insufficient_scope` | Token does not have the required scope for this endpoint |
| `404` | `not_found` | Audit ID does not exist or does not belong to your team |
| `409` | `conflict` | Operation not valid in current state (e.g. verifying an incomplete audit) |
| `422` | `invalid_url` | Submitted URL is not a valid `https://` URL |
| `429` | `rate_limited` | Exceeded 10 token requests per minute |
| `500` | `internal_error` | Flowblinq pipeline error — safe to retry |

---

## Quick Start

A complete flow from credentials to results in under 30 lines:

```typescript
const BASE = 'https://geo.flowblinq.com'

// 1. Get access token
const tokenRes = await fetch(`${BASE}/api/oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    grant_type: 'client_credentials',
    client_id: process.env.FLOWBLINQ_CLIENT_ID,
    client_secret: process.env.FLOWBLINQ_CLIENT_SECRET,
  }),
})
const { access_token } = await tokenRes.json()
const headers = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' }

// 2. Submit audit
const { audit_id } = await fetch(`${BASE}/api/v1/audit`, {
  method: 'POST', headers,
  body: JSON.stringify({ url: 'https://example.com' }),
}).then(r => r.json())

// 3. Poll until complete
let result
do {
  await new Promise(r => setTimeout(r, 5000))
  result = await fetch(`${BASE}/api/v1/audit/${audit_id}`, { headers }).then(r => r.json())
} while (result.status !== 'complete' && result.status !== 'failed')

console.log(`Score: ${result.overall_score}/100`)
console.log(`llms.txt: ${result.files.llms_txt_url}`)
```

---

## Scopes Reference

| Scope | Grants access to |
|-------|-----------------|
| `audit:write` | Submit audits, trigger verification runs |
| `audit:read` | Read audit status and results |
| `account:read` | Read credit balance and usage |

All keys generated from the dashboard receive all three scopes by default.

---

*Flowblinq API v1 — [geo.flowblinq.com](https://geo.flowblinq.com)*
