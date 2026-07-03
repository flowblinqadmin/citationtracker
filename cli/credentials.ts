import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

interface CliCredentials {
  clientId: string
  clientSecret: string
  baseUrl?: string
}

interface ConfigFile {
  client_id?: string
  client_secret?: string
  base_url?: string
}

type ParsedValues = {
  'client-id'?: string | undefined
  'client-secret'?: string | undefined
  'base-url'?: string | undefined
  [key: string]: string | boolean | undefined
}

function readConfigFile(filePath: string): ConfigFile | null {
  try {
    const raw = readFileSync(filePath, 'utf8') as string
    return JSON.parse(raw) as ConfigFile
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null  // file missing — not an error
    }
    // Malformed JSON or other read error
    console.warn(`Warning: could not parse config file ${filePath}: ${(err as Error).message}`)
    return null
  }
}

export function loadCredentials(parsed: { values: ParsedValues }): CliCredentials {
  const flags = parsed.values

  // 1. CLI flags
  if (flags['client-id'] && flags['client-secret']) {
    return {
      clientId: flags['client-id'] as string,
      clientSecret: flags['client-secret'] as string,
      baseUrl: flags['base-url'] as string | undefined,
    }
  }

  // 2. Environment variables
  const envId = process.env.FLOWBLINQ_CLIENT_ID
  const envSecret = process.env.FLOWBLINQ_CLIENT_SECRET
  if (envId && envSecret) {
    return {
      clientId: envId,
      clientSecret: envSecret,
      baseUrl: flags['base-url'] as string | undefined,
    }
  }

  // 3. Config files — try ~/.flowblinq/config.json first, then ./.flowblinq.json
  const homeConfig = readConfigFile(path.join(homedir(), '.flowblinq', 'config.json'))
  const cwdConfig = readConfigFile(path.join(process.cwd(), '.flowblinq.json'))

  const fileConfig = homeConfig ?? cwdConfig

  if (fileConfig) {
    if (!fileConfig.client_id || !fileConfig.client_secret) {
      console.warn('Warning: config file found but missing client_id or client_secret fields.')
    } else {
      return {
        clientId: fileConfig.client_id,
        clientSecret: fileConfig.client_secret,
        baseUrl: (flags['base-url'] as string | undefined) ?? fileConfig.base_url,
      }
    }
  }

  // No credentials found
  console.error(
    'Error: No credentials found.\n\n' +
    'Set up credentials using one of:\n' +
    '  1. Flags:       flowblinq --client-id <id> --client-secret <secret> <command>\n' +
    '  2. Environment: export FLOWBLINQ_CLIENT_ID=<id> FLOWBLINQ_CLIENT_SECRET=<secret>\n' +
    '  3. Config file: echo \'{"client_id":"<id>","client_secret":"<secret>"}\' > ~/.flowblinq/config.json\n\n' +
    'Get your credentials from: https://geo.flowblinq.com/dashboard'
  )
  process.exit(1)
}
