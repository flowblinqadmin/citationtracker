import type { FlowblinqClient } from '@/lib/flowblinq-client'
import { FlowblinqApiError } from '@/lib/flowblinq-client'
import { printKv, printError, jsonOut } from '../format'

export async function runAccount(client: FlowblinqClient, json: boolean): Promise<void> {
  try {
    const response = await client.getAccount()
    if (json) {
      jsonOut(response)
    } else {
      printKv([
        ['Team ID',      response.teamId],
        ['Credits',      String(response.creditBalance)],
        ['Free domains', String(response.freeOptimizationDomains)],
        ['Purchase URL', response.creditsPurchaseUrl],
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
