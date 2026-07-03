#!/usr/bin/env tsx
import { FlowblinqClient } from '@/lib/flowblinq-client'
import { loadCredentials } from './credentials'
import { printError } from './format'
import { runAuth } from './commands/auth'
import { runAudit } from './commands/audit'
import { runAccount } from './commands/account'
import { runMcp } from './commands/mcp'

// Minimal arg parser — avoids node:util parseArgs (Node 16.17+ only).
// Handles --flag, --flag=value, --flag value, and positional args.
function parseCliArgs(argv: string[]) {
  const values: Record<string, string | boolean | undefined> = {
    'client-id': undefined,
    'client-secret': undefined,
    'base-url': undefined,
    'json': false,
    'help': false,
  }
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('-')) {
      positionals.push(arg)
    } else if (arg === '--json') {
      values['json'] = true
    } else if (arg === '--help') {
      values['help'] = true
    } else if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=')
      if (eqIdx !== -1) {
        values[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1)
      } else {
        values[arg.slice(2)] = argv[++i]
      }
    }
  }
  return { values, positionals }
}

const USAGE = `flowblinq <command> [subcommand] [args] [options]

Commands:
  auth test                     Verify credentials
  audit submit <url>            Submit URL for audit
  audit status <audit-id>       Get audit status
  audit wait <audit-id>         Poll until complete
  audit run <url>               Submit + wait in one command
  audit verify <audit-id>       Trigger post-optimization re-audit
  account                       Show credit balance
  mcp                           Show MCP server manifest

Options:
  --client-id <id>              API client ID
  --client-secret <secret>      API client secret
  --base-url <url>              API base URL (default: https://geo.flowblinq.com)
  --json                        Output raw JSON
  --help                        Show this help
`

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2))

  const { values, positionals } = parsed
  const command = positionals[0]
  const json = values['json'] as boolean

  if (values['help'] || !command) {
    process.stdout.write(USAGE)
    process.exit(0)
  }

  const creds = loadCredentials(parsed)
  const client = new FlowblinqClient({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    baseUrl: creds.baseUrl,
  })

  switch (command) {
    case 'auth':
      await runAuth(positionals[1] ?? '', client, json)
      break
    case 'audit':
      await runAudit(positionals[1] ?? '', positionals.slice(2), client, json)
      break
    case 'account':
      await runAccount(client, json)
      break
    case 'mcp':
      await runMcp(client, json)
      break
    default:
      printError(`Unknown command: ${command}`)
      process.exit(1)
  }
}

main().catch((err: Error) => {
  printError(err.message)
  process.exit(1)
})
