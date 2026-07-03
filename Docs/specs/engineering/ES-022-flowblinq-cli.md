# ES-022: Flowblinq CLI

**Status:** Draft
**Author:** SpecMaster (2-specmaster)
**Date:** 2026-03-04
**Source TS:** TS-022-flowblinq-cli.md
**Priority:** P1
**Downstream:** ReviewMaster → ScriptDev

---

## a) Overview

A developer-facing CLI that wraps `FlowblinqClient` (ES-021). Reads credentials from flags → env → config file. Exposes all API operations as subcommands. No new dependencies, no build step.

**Current implementation state:**
- `FlowblinqClient` at `geo/lib/flowblinq-client/` exists (ES-021) — this CLI wraps it directly.
- `geo/cli/` does not exist yet.
- `tsx` is already available in the project (`ts-node`-compatible, no new dep needed — verify with `ls geo/node_modules/.bin/tsx`).
- `parseArgs` is available from Node.js built-in `node:util` (Node 18+).

**Scope:** Developer tool only. Not distributed via npm. Runs directly from the `geo/` repo via `npm run cli` or `npx tsx`.

---

## b) Implementation Requirements

### New Dependencies

None. Uses:
- `FlowblinqClient` from `@/lib/flowblinq-client` (already in project)
- `parseArgs` from `node:util` (Node 18+ built-in)
- `fs`, `path`, `os` from Node.js built-ins (config file loading)

### File Structure

```
geo/cli/
├── index.ts          # Entry point — arg parsing, routing, error handling
├── credentials.ts    # Credential discovery (flags → env → config file)
├── format.ts         # Human-readable output helpers
└── commands/
    ├── auth.ts       # auth test
    ├── audit.ts      # audit submit|status|wait|run|verify
    ├── account.ts    # account
    └── mcp.ts        # mcp
```

### `npm` script update (`geo/package.json`)

Add to `scripts`:
```json
"cli": "tsx cli/index.ts"
```

Usage: `npm run cli -- audit run https://example.com`

---

### New File: `geo/cli/credentials.ts`

```typescript
// Exports:
//   loadCredentials(parsed: ParsedArgs): FlowblinqClientConfig
//
// ParsedArgs = return type of parseArgs() from node:util
//
// Discovery order (first match wins):
//   1. parsed.values['client-id'] and parsed.values['client-secret'] (CLI flags)
//   2. process.env.FLOWBLINQ_CLIENT_ID and process.env.FLOWBLINQ_CLIENT_SECRET
//   3. Config file: try ~/.flowblinq/config.json first, then ./.flowblinq.json (CWD)
//
// Config file shape:
//   { client_id: string, client_secret: string, base_url?: string }
//
// base_url resolution (first match wins):
//   1. parsed.values['base-url'] flag
//   2. config file base_url field (if config file was used)
//   3. Defaults to 'https://geo.flowblinq.com' (FlowblinqClient default)
//
// If credentials not found after all three sources:
//   console.error() a multi-line setup message (see format below)
//   process.exit(1)
//
// Error message format:
//   Error: No credentials found.
//
//   Set up credentials using one of:
//     1. Flags:       flowblinq --client-id <id> --client-secret <secret> <command>
//     2. Environment: export FLOWBLINQ_CLIENT_ID=<id> FLOWBLINQ_CLIENT_SECRET=<secret>
//     3. Config file: echo '{"client_id":"<id>","client_secret":"<secret>"}' \
//                          > ~/.flowblinq/config.json
//
//   Get your credentials from: https://geo.flowblinq.com/dashboard
//
// Config file reading:
//   Use fs.readFileSync + JSON.parse. Wrap in try/catch — missing file is not an error,
//   only malformed JSON should print a warning.
//   Warn (but don't fail) if config file exists but is missing required fields.
```

**Type for internal use:**
```typescript
interface CliCredentials {
  clientId: string
  clientSecret: string
  baseUrl?: string
}
```

---

### New File: `geo/cli/format.ts`

Output formatting utilities. All functions write to `process.stdout` (or `process.stderr` for errors). The `--json` flag bypasses these in favour of `JSON.stringify`.

```typescript
// printKv(pairs: Array<[label: string, value: string]>): void
//   Prints aligned key-value lines. Pad labels to the longest label length.
//   Example output:
//     Team ID:      team_abc123
//     Credits:      95
//     Free domains: 3

// printScore(audit: AuditResponse): void
//   Prints:
//     Score: 72/100
//     (blank line)
//     Pillars:
//       <pillarName padded>  <score>/100    (sorted descending by score)
//     (blank line)
//     Files:
//       llms.txt      <url>
//       business.json <url>
//       schema.json   <url>
//   Omit any file URL that is null.

// printProgress(elapsedMs: number, status: string): void
//   Prints one line (no newline unless status changes):
//     t+<seconds>s  status=<status>
//   Writes to stdout. Caller controls when to call this (e.g. from onProgress callback).

// printError(message: string): void
//   Writes to stderr: "Error: <message>"

// printSuccess(message: string): void
//   Writes to stdout: "✓ <message>"

// jsonOut(data: unknown): void
//   JSON.stringify(data, null, 2) to stdout + newline.
//   Used when --json flag is set.
```

---

### New File: `geo/cli/commands/auth.ts`

```typescript
// Exports: runAuth(subcommand: string, client: FlowblinqClient, json: boolean): Promise<void>
//
// Subcommands:
//   'test':
//     - client.getAccount()
//     - If json: jsonOut({ ok: true, teamId, creditBalance })
//     - If not json: printSuccess(`Connected — team: ${teamId} | credits: ${creditBalance}`)
//     - On FlowblinqApiError: printError(err.message), process.exit(2)
//
//   unknown subcommand: print usage, process.exit(1)
//
// Usage line: "Usage: flowblinq auth <test>"
```

---

### New File: `geo/cli/commands/audit.ts`

```typescript
// Exports: runAudit(subcommand: string, args: string[], client: FlowblinqClient, json: boolean): Promise<void>
//
// Subcommands:
//
//   'submit' <url>:
//     - Validate url present, else printError + exit(1)
//     - client.submitAudit({ url })
//     - If json: jsonOut(response)
//     - If not json: printKv([
//         ['Audit ID', response.auditId],
//         ['Status',   response.status],
//         ['Run',      `${response.freeRunNumber} of 2 (free tier)`],
//         ['ETA',      `~${response.estimatedCompletionSeconds}s`],
//       ])
//
//   'status' <audit-id>:
//     - Validate audit-id present, else exit(1)
//     - client.getAudit(auditId)
//     - If json: jsonOut(response)
//     - If not json: printKv([
//         ['Audit ID', response.auditId],
//         ['Domain',   response.domain],
//         ['Status',   response.status],
//         ['Score',    response.overallScore != null ? String(response.overallScore) : '—'],
//       ])
//
//   'wait' <audit-id>:
//     - Validate audit-id present, else exit(1)
//     - Print: "Waiting for audit <auditId>..."
//     - const startMs = Date.now()
//     - client.pollAudit(auditId, {
//         intervalMs: 5000,
//         timeoutMs: 420_000,  // 7 min
//         onProgress: (r) => printProgress(Date.now() - startMs, r.status),
//       })
//     - On resolve: print blank line, then printScore(result)
//       Also print: "\nRun `flowblinq audit verify <auditId>` to trigger post-opt re-audit."
//       (only if result.freeRunNumber === 1)
//     - If json: jsonOut(result) instead of printScore
//     - On FlowblinqApiError code='poll_timeout': printError('Timed out...'), exit(3)
//     - On FlowblinqApiError code='pipeline_failed': printError('Audit pipeline failed'), exit(2)
//
//   'run' <url>:
//     - Validate url present, else exit(1)
//     - Print: "Submitting audit for <domain>..." (extract domain from url)
//     - submitResult = await client.submitAudit({ url })
//     - Print: "Audit ID: <auditId>"
//     - Print: "Waiting for completion (timeout: 7 min)..."
//     - Then behave identically to 'wait' for the returned auditId
//
//   'verify' <audit-id>:
//     - Validate audit-id present, else exit(1)
//     - client.verifyAudit(auditId)
//     - If json: jsonOut(response)
//     - If not json: printKv([
//         ['Triggered re-audit for', auditId],
//         ['New Audit ID', response.auditId],
//         ['Run', '2 of 2 (free tier)'],
//       ])
//       Then print: "Use `flowblinq audit wait ${response.auditId}` to poll for results."
//
//   unknown subcommand: print usage, exit(1)
//
// Error handling for all subcommands:
//   Catch FlowblinqApiError:
//     - printError(`${err.status}: ${err.message}`)
//     - exit(2) for API errors (status > 0)
//     - exit(1) for auth errors (code='auth_failed')
```

---

### New File: `geo/cli/commands/account.ts`

```typescript
// Exports: runAccount(client: FlowblinqClient, json: boolean): Promise<void>
//
// - client.getAccount()
// - If json: jsonOut(response)
// - If not json: printKv([
//     ['Team ID',      response.teamId],
//     ['Credits',      String(response.creditBalance)],
//     ['Free domains', String(response.freeOptimizationDomains)],
//     ['Purchase URL', response.creditsPurchaseUrl],
//   ])
// - On FlowblinqApiError: printError, exit(2)
```

---

### New File: `geo/cli/commands/mcp.ts`

```typescript
// Exports: runMcp(client: FlowblinqClient, json: boolean): Promise<void>
//
// - client.getMcpManifest()
// - If json: jsonOut(manifest)
// - If not json:
//     printKv([
//       ['Protocol', `${manifest.protocol} v${manifest.version}`],
//       ['Tools',    manifest.tools.map(t => t.name).join(', ')],
//       ['Auth',     `${manifest.auth.type} ${manifest.auth.grantType}`],
//       ['Token URL', manifest.auth.tokenUrl],
//     ])
```

---

### New File: `geo/cli/index.ts`

Entry point. Owns argument parsing and routing.

```typescript
#!/usr/bin/env tsx
// ^ shebang for direct execution

import { parseArgs } from 'node:util'
import { FlowblinqClient } from '@/lib/flowblinq-client'
import { loadCredentials } from './credentials'
import { printError } from './format'
import { runAuth } from './commands/auth'
import { runAudit } from './commands/audit'
import { runAccount } from './commands/account'
import { runMcp } from './commands/mcp'

// Argument spec for parseArgs:
const options = {
  'client-id':     { type: 'string' as const },
  'client-secret': { type: 'string' as const },
  'base-url':      { type: 'string' as const },
  'json':          { type: 'boolean' as const, default: false },
  'help':          { type: 'boolean' as const, default: false },
}

// parseArgs with allowPositionals: true
// parsed.positionals[0] = command (e.g. 'audit', 'auth', 'account', 'mcp')
// parsed.positionals[1] = subcommand or first positional arg (e.g. 'run', 'submit', url)
// parsed.positionals[2] = second positional arg (e.g. audit-id or url)

// If --help or no command: print usage and exit(0)
// Usage text:
//   flowblinq <command> [subcommand] [args] [options]
//
//   Commands:
//     auth test                     Verify credentials
//     audit submit <url>            Submit URL for audit
//     audit status <audit-id>       Get audit status
//     audit wait <audit-id>         Poll until complete
//     audit run <url>               Submit + wait in one command
//     audit verify <audit-id>       Trigger post-optimization re-audit
//     account                       Show credit balance
//     mcp                           Show MCP server manifest
//
//   Options:
//     --client-id <id>              API client ID
//     --client-secret <secret>      API client secret
//     --base-url <url>              API base URL (default: https://geo.flowblinq.com)
//     --json                        Output raw JSON
//     --help                        Show this help

// Routing:
//   command='auth'    → runAuth(positionals[1], client, json)
//   command='audit'   → runAudit(positionals[1], positionals.slice(2), client, json)
//   command='account' → runAccount(client, json)
//   command='mcp'     → runMcp(client, json)
//   unknown command   → printError + exit(1)

// Error boundary:
//   Wrap main() in .catch((err) => { printError(err.message); process.exit(1) })
//   This catches unexpected errors (network down, etc.) cleanly.

// Note: loadCredentials() is called BEFORE creating FlowblinqClient.
// If no credentials found, loadCredentials() calls process.exit(1) internally.
```

**Exit code summary:**

| Code | When |
|------|------|
| 0 | Success |
| 1 | Credential error, missing args, unknown command |
| 2 | API error (non-2xx, auth failure after retry) |
| 3 | Poll timeout |

---

## c) Unit Test Plan

**Test file:** `geo/__tests__/cli-credentials.test.ts`

Tests `credentials.ts` in isolation (no network).

| ID | Scenario | Expected |
|----|----------|----------|
| R-1 | Flags present (`--client-id`, `--client-secret`) | Returns config with flag values |
| R-2 | Flags absent, env vars set | Returns config from env vars |
| R-3 | Flags and env absent, `~/.flowblinq/config.json` exists with valid content | Returns config from file |
| R-4 | Flags and env absent, `~/.flowblinq/config.json` missing, `.flowblinq.json` in CWD exists | Returns config from CWD file |
| R-5 | Flags present override env vars | Flag values win |
| R-6 | No credentials in any source | `process.exit(1)` called |
| R-7 | `--base-url` flag present | Returned config has baseUrl set |
| R-8 | Config file has `base_url` field, no flag | Returned config has baseUrl from file |
| R-9 | Config file exists but malformed JSON | Prints warning, falls through to exit(1) |

Mock `process.exit` with `vi.spyOn(process, 'exit')`. Mock `fs.readFileSync` for file cases. Mock `process.env` by setting/restoring in `beforeEach`/`afterEach`.

**Test file:** `geo/__tests__/cli-format.test.ts`

Tests `format.ts` output helpers.

| ID | Scenario | Expected |
|----|----------|----------|
| F-1 | `printKv` with 3 pairs | Stdout lines match key-value format, labels aligned |
| F-2 | `printKv` with long label | All labels padded to longest |
| F-3 | `printError` | Written to stderr, prefixed "Error:" |
| F-4 | `printSuccess` | Written to stdout, prefixed "✓" |
| F-5 | `jsonOut` with object | `JSON.stringify(obj, null, 2)` written to stdout |
| F-6 | `printProgress` | Stdout contains `t+Xs` and `status=<value>` |

Capture stdout/stderr by replacing `process.stdout.write` and `process.stderr.write` with `vi.fn()` in each test.

**Coverage target:** ≥85% on `cli/credentials.ts` and `cli/format.ts`.

The commands (`auth.ts`, `audit.ts`, `account.ts`, `mcp.ts`) are thin wrappers around `FlowblinqClient` — covered by the integration tests rather than unit tests to avoid excessive mocking depth.

---

## d) Integration Test Plan

**Test file:** `geo/__tests__/cli-smoke.test.ts`

Uses `child_process.spawnSync` to run the CLI as a subprocess. Mocks credentials via env vars. Mocks network by pointing `FLOWBLINQ_BASE_URL` to a local test server (or uses `vi.stubGlobal` on fetch — whichever is simpler given the CLI runs in a subprocess).

**Approach:** Given the CLI runs as a subprocess, use env var injection and a **real** test credential (same pattern as integration test suite). Run only against live Vercel when `TEST_BASE_URL` is set; skip otherwise.

| ID | Command | Expected |
|----|---------|----------|
| S-1 | `npm run cli -- auth test` (valid creds) | exit 0, stdout contains "Connected" |
| S-2 | `npm run cli -- auth test` (invalid creds) | exit 2, stderr contains "Error:" |
| S-3 | `npm run cli -- account --json` | exit 0, stdout is valid JSON with `teamId` field |
| S-4 | `npm run cli -- mcp --json` | exit 0, stdout is valid JSON with `tools` array |
| S-5 | No credentials | exit 1, stderr contains "No credentials found" |
| S-6 | Unknown command | exit 1, stderr contains "Error:" |

These 6 smoke tests run with `TEST_BASE_URL` set in env. They are excluded from `npm test` and run as part of `npm run test:integration:api` (appended to that suite) or standalone.

---

## e) Profiling Requirements

Not applicable — developer tool. Performance is not a constraint; it's as fast as `FlowblinqClient`.

---

## f) Load Test Plan

Not applicable.

---

## g) Logging & Instrumentation

No logging — this is a CLI tool. All output is structured human-readable text or `--json` output. Errors go to stderr. Normal output goes to stdout (pipeable).

---

## h) Acceptance Criteria

- [ ] `npm run cli -- auth test` with valid credentials exits 0, prints team ID and credit balance
- [ ] `npm run cli -- auth test` with invalid credentials exits 2, stderr has clear error
- [ ] `npm run cli -- audit run https://example.com` submits, shows progress lines, prints score
- [ ] `npm run cli -- audit wait <id>` shows `t+Xs status=...` lines during polling
- [ ] `npm run cli -- account --json` outputs valid JSON with `teamId`, `creditBalance`
- [ ] `npm run cli -- mcp --json` outputs valid JSON with `tools` array of 4 tools
- [ ] `--json` flag on every command emits parseable JSON (verify with `| python3 -m json.tool`)
- [ ] Missing credentials in all 3 sources → exit 1 with setup instructions mentioning all 3 methods
- [ ] `npm run cli -- --help` prints full usage and exits 0
- [ ] Unit tests pass: `cli-credentials.test.ts` (9 cases), `cli-format.test.ts` (6 cases)
- [ ] Coverage ≥85% on `cli/credentials.ts` and `cli/format.ts`
- [ ] `npm test` (unit suite) still passes — no regressions
- [ ] `cli` script added to `package.json`
- [ ] No new npm dependencies introduced

---

## Notes for ScriptDev

1. **`tsx` availability:** Verify `geo/node_modules/.bin/tsx` exists before writing the npm script. If tsx is not installed, add it as a dev dependency (`npm install -D tsx`). It is likely already present given the project uses TypeScript and Vitest.

2. **`parseArgs` positionals:** Use `allowPositionals: true` option. The routing logic is: `positionals[0]` = command, `positionals[1]` = subcommand (for `audit`) or ignored (for `account`, `mcp`). For `audit`, `positionals[2]` = the url or audit-id argument.

3. **`printProgress` output:** Write without a trailing newline, one line per call. Consider using `\r` (carriage return) to overwrite the same line in a terminal. However, keep it simple for v0.1: just `process.stdout.write('  t+' + Math.floor(elapsedMs/1000) + 's  status=' + status + '\n')`. The TS shows newline-per-line output.

4. **`audit run` domain extraction:** Use `new URL(url).hostname.replace(/^www\./, '')` to get the display domain name.

5. **Exit code 3 (poll timeout):** Only `audit wait` and `audit run` can produce this. All other commands either succeed or produce exit 2.

6. **`--json` flag routing:** Pass the `json` boolean down to all command handlers. Each handler checks it before calling any `format.ts` function. When `json=true`, call `jsonOut(rawApiResponse)` and return immediately — do not call any other format functions.

7. **Config file path:** Use `path.join(os.homedir(), '.flowblinq', 'config.json')` for the home dir path. Use `path.join(process.cwd(), '.flowblinq.json')` for the CWD path.

8. **Shebang:** Add `#!/usr/bin/env tsx` as the first line of `cli/index.ts`. This allows direct execution via `./cli/index.ts` if the user adds it to their PATH, but the primary usage is `npm run cli`.
