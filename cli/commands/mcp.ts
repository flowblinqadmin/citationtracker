import type { FlowblinqClient } from '@/lib/flowblinq-client'
import { FlowblinqApiError } from '@/lib/flowblinq-client'
import { printKv, printError, jsonOut } from '../format'

export async function runMcp(client: FlowblinqClient, json: boolean): Promise<void> {
  try {
    const manifest = await client.getMcpManifest()
    if (json) {
      jsonOut(manifest)
    } else {
      printKv([
        ['Protocol',  `${manifest.protocol} v${manifest.version}`],
        ['Tools',     manifest.tools.map(t => t.name).join(', ')],
        ['Auth',      `${manifest.auth.type} ${manifest.auth.grantType}`],
        ['Token URL', manifest.auth.tokenUrl],
      ])
    }
  } catch (err) {
    if (err instanceof FlowblinqApiError) {
      printError(err.message)
      process.exit(2)
    }
    throw err
  }
}
