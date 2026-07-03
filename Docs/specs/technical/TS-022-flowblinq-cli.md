# TS-022: Flowblinq CLI

**Status:** Draft
**Author:** CoFounder
**Date:** 2026-03-04
**Downstream:** SpecMaster → ReviewMaster → ScriptDev

---

## Context

The `FlowblinqClient` TypeScript library (ES-021) requires code to use — callers must
instantiate the class and pass credentials explicitly. This creates friction for:

- Developers testing the API from their terminal
- Shell scripts and CI/CD pipelines
- Quick dogfooding during development

This TS specifies a `flowblinq` CLI that wraps the existing library, reads credentials
from the environment or a config file, and exposes all API operations as subcommands.

**Scope:** Developer tool only. Not distributed via npm registry initially — lives in the
`geo/` repo as a local script runnable via `npx tsx` or `ts-node`. Distribution via npm
is out of scope for this TS.

---

## Credential Discovery (priority order)

1. **Flags** — `--client-id`, `--client-secret` (explicit, highest priority)
2. **Environment variables** — `FLOWBLINQ_CLIENT_ID`, `FLOWBLINQ_CLIENT_SECRET`
3. **Config file** — `~/.flowblinq/config.json` or `.flowblinq.json` in CWD

Config file format:
```json
{
  "client_id": "fq_live_abc123",
  "client_secret": "sk_abc...",
  "base_url": "https://geo.flowblinq.com"
}
```

If credentials are not found in any source, print a helpful error with setup instructions
and exit 1.

---

## Commands

### `flowblinq auth test`
Verify credentials are working. Calls `getAccount()` internally.

```
$ flowblinq auth test
✓ Connected — team: team_abc123 | credits: 95
```

### `flowblinq audit submit <url>`
Submit a URL for GEO audit.

```
$ flowblinq audit submit https://example.com
Submitted audit for example.com
Audit ID: site_abc123
Status:   pending
Run:      1 of 2 (free tier)
ETA:      ~120s
```

### `flowblinq audit status <audit-id>`
Get current audit status (single poll, no waiting).

```
$ flowblinq audit status site_abc123
Audit ID: site_abc123
Domain:   example.com
Status:   running (crawling)
Score:    —
```

### `flowblinq audit wait <audit-id>`
Poll until complete or failed. Shows live progress. Prints full result on completion.

```
$ flowblinq audit wait site_abc123
Waiting for audit site_abc123...
  t+5s   status=running
  t+10s  status=running
  t+45s  status=complete

Score: 72/100

Pillars:
  Structured Data    88/100
  Content Clarity    71/100
  Citation Signals   65/100
  ...

Files:
  llms.txt      https://geo.flowblinq.com/api/serve/example-com/llms.txt
  business.json https://geo.flowblinq.com/api/serve/example-com/business.json

Run `flowblinq audit verify site_abc123` to trigger the post-optimization re-audit.
```

### `flowblinq audit run <url>`
Submit + wait in one command (convenience wrapper for `submit` + `wait`).

```
$ flowblinq audit run https://example.com
Submitting audit for example.com...
Audit ID: site_abc123
Waiting for completion (timeout: 7 min)...
  t+5s   status=running
  ...
  t+45s  status=complete

Score: 72/100
...
```

### `flowblinq audit verify <audit-id>`
Trigger the post-optimization second run.

```
$ flowblinq audit verify site_abc123
Triggered re-audit for site_abc123
New Audit ID: site_def456
Run: 2 of 2 (free tier)
Use `flowblinq audit wait site_def456` to poll for results.
```

### `flowblinq account`
Show team credit balance and usage.

```
$ flowblinq account
Team ID:      team_abc123
Credits:      95
Free domains: 3
Purchase URL: https://geo.flowblinq.com/pricing
```

### `flowblinq mcp`
Print the MCP server manifest (useful for debugging MCP integrations).

```
$ flowblinq mcp
Protocol: mcp v1.0
Tools: run_audit, get_audit, verify_optimization, get_account
Auth: oauth2 client_credentials
Token URL: https://geo.flowblinq.com/api/oauth/token
```

---

## Global Flags

| Flag | Description |
|------|-------------|
| `--client-id <id>` | Override credential discovery |
| `--client-secret <secret>` | Override credential discovery |
| `--base-url <url>` | Override API base URL (default: https://geo.flowblinq.com) |
| `--json` | Output raw JSON instead of formatted text |
| `--help` | Show help |

The `--json` flag makes every command emit machine-readable JSON to stdout (useful for
piping into `jq`).

---

## Implementation

### File Location
```
geo/cli/
├── index.ts          # Entry point — parses argv, routes to subcommands
├── credentials.ts    # Credential discovery (flags → env → config file)
├── commands/
│   ├── auth.ts       # auth test
│   ├── audit.ts      # audit submit|status|wait|run|verify
│   ├── account.ts    # account
│   └── mcp.ts        # mcp
└── format.ts         # Human-readable formatting helpers
```

### Runtime
- Uses the existing `FlowblinqClient` from `@/lib/flowblinq-client`
- Argument parsing: `parseArgs` from Node.js built-in `node:util` (no external deps)
- No build step required — run directly via `npx tsx geo/cli/index.ts <command>`
- Add `npm` script: `"cli": "tsx cli/index.ts"` → `npm run cli audit run https://example.com`

### Exit Codes
| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Credential error / missing config |
| 2 | API error (non-2xx response) |
| 3 | Poll timeout |

---

## Acceptance Criteria

1. `flowblinq auth test` with valid credentials exits 0 and prints team info
2. `flowblinq auth test` with invalid credentials exits 1 with a clear error message
3. `flowblinq audit run https://example.com` submits, polls, and prints score on completion
4. `--json` flag on any command emits valid JSON to stdout
5. Missing credentials (no flags, no env, no config file) exits 1 with setup instructions
6. `flowblinq audit wait` shows live progress lines during polling
7. `flowblinq account` shows correct credit balance matching the API response

---

## Out of Scope

- npm registry distribution (future TS)
- `flowblinq config set` interactive credential setup wizard (future TS)
- Bulk audit submission (future TS)
- Shell completion scripts (future TS)
