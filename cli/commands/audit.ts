import type { FlowblinqClient } from '@/lib/flowblinq-client'
import { FlowblinqApiError } from '@/lib/flowblinq-client'
import { printKv, printScore, printProgress, printError, jsonOut } from '../format'

const USAGE = `Usage: flowblinq audit <submit|status|wait|run|verify> [url|audit-id]`

export async function runAudit(
  subcommand: string,
  args: string[],
  client: FlowblinqClient,
  json: boolean
): Promise<void> {
  try {
    switch (subcommand) {
      case 'submit': {
        const url = args[0]
        if (!url) { printError('Missing URL argument'); process.exit(1) }
        const response = await client.submitAudit({ url })
        if (json) {
          jsonOut(response)
        } else {
          printKv([
            ['Audit ID', response.auditId],
            ['Status',   response.status],
            ['Run',      `${response.freeRunNumber} of 2 (free tier)`],
            ['ETA',      `~${response.estimatedCompletionSeconds}s`],
          ])
        }
        break
      }

      case 'status': {
        const auditId = args[0]
        if (!auditId) { printError('Missing audit-id argument'); process.exit(1) }
        const response = await client.getAudit(auditId)
        if (json) {
          jsonOut(response)
        } else {
          printKv([
            ['Audit ID', response.auditId],
            ['Domain',   response.domain],
            ['Status',   response.status],
            ['Score',    response.overallScore != null ? String(response.overallScore) : '—'],
          ])
        }
        break
      }

      case 'wait': {
        const auditId = args[0]
        if (!auditId) { printError('Missing audit-id argument'); process.exit(1) }
        await waitForAudit(client, auditId, json)
        break
      }

      case 'run': {
        const url = args[0]
        if (!url) { printError('Missing URL argument'); process.exit(1) }
        const domain = new URL(url).hostname.replace(/^www\./, '')
        process.stdout.write(`Submitting audit for ${domain}...\n`)
        const submitResult = await client.submitAudit({ url })
        process.stdout.write(`Audit ID: ${submitResult.auditId}\n`)
        process.stdout.write('Waiting for completion (timeout: 7 min)...\n')
        await waitForAudit(client, submitResult.auditId, json)
        break
      }

      case 'verify': {
        const auditId = args[0]
        if (!auditId) { printError('Missing audit-id argument'); process.exit(1) }
        const response = await client.verifyAudit(auditId)
        if (json) {
          jsonOut(response)
        } else {
          printKv([
            ['Triggered re-audit for', auditId],
            ['New Audit ID',           response.auditId],
            ['Run',                    '2 of 2 (free tier)'],
          ])
          process.stdout.write(`Use \`flowblinq audit wait ${response.auditId}\` to poll for results.\n`)
        }
        break
      }

      default:
        process.stdout.write(USAGE + '\n')
        process.exit(1)
    }
  } catch (err) {
    if (err instanceof FlowblinqApiError) {
      if (err.code === 'poll_timeout') {
        printError('Timed out waiting for audit to complete.')
        process.exit(3)
      }
      if (err.code === 'pipeline_failed') {
        printError('Audit pipeline failed.')
        process.exit(2)
      }
      if (err.code === 'auth_failed') {
        printError(`${err.status}: ${err.message}`)
        process.exit(1)
      }
      printError(`${err.status}: ${err.message}`)
      process.exit(2)
    }
    throw err
  }
}

async function waitForAudit(
  client: FlowblinqClient,
  auditId: string,
  json: boolean
): Promise<void> {
  process.stdout.write(`Waiting for audit ${auditId}...\n`)
  const startMs = Date.now()
  const result = await client.pollAudit(auditId, {
    intervalMs: 5_000,
    timeoutMs: 840_000,
    onProgress: (r) => printProgress(Date.now() - startMs, r.status),
  })
  process.stdout.write('\n')
  if (json) {
    jsonOut(result)
  } else {
    printScore(result)
    if (result.freeRunNumber === 1) {
      process.stdout.write(`\nRun \`flowblinq audit verify ${auditId}\` to trigger post-opt re-audit.\n`)
    }
  }
}
