import type { FlowblinqClient } from '@/lib/flowblinq-client'
import { FlowblinqApiError } from '@/lib/flowblinq-client'
import { printError, printSuccess, jsonOut } from '../format'

export async function runAuth(
  subcommand: string,
  client: FlowblinqClient,
  json: boolean
): Promise<void> {
  if (subcommand === 'test') {
    try {
      const account = await client.getAccount()
      if (json) {
        jsonOut({ ok: true, teamId: account.teamId, creditBalance: account.creditBalance })
      } else {
        printSuccess(`Connected — team: ${account.teamId} | credits: ${account.creditBalance}`)
      }
    } catch (err) {
      if (err instanceof FlowblinqApiError) {
        printError(err.message)
        process.exit(2)
      }
      throw err
    }
  } else {
    process.stdout.write('Usage: flowblinq auth <test>\n')
    process.exit(1)
  }
}
