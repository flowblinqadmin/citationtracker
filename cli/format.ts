import type { AuditResponse } from '@/lib/flowblinq-client'

export function printKv(pairs: Array<[label: string, value: string]>): void {
  const maxLen = Math.max(...pairs.map(([label]) => label.length))
  for (const [label, value] of pairs) {
    process.stdout.write(`  ${label.padEnd(maxLen)}  ${value}\n`)
  }
}

export function printScore(audit: AuditResponse): void {
  process.stdout.write(`Score: ${audit.overallScore}/100\n\n`)

  if (audit.scorecard && audit.scorecard.pillars.length > 0) {
    process.stdout.write('Pillars:\n')
    const sorted = [...audit.scorecard.pillars].sort((a, b) => b.score - a.score)
    const maxPillarLen = Math.max(...sorted.map(p => p.pillarName.length))
    for (const pillar of sorted) {
      process.stdout.write(`  ${pillar.pillarName.padEnd(maxPillarLen)}  ${pillar.score}/100\n`)
    }
    process.stdout.write('\n')
  }

  const files: Array<[string, string]> = []
  if (audit.files.llmsTxtUrl) files.push(['llms.txt', audit.files.llmsTxtUrl])
  if (audit.files.businessJsonUrl) files.push(['business.json', audit.files.businessJsonUrl])
  if (audit.files.schemaJsonUrl) files.push(['schema.json', audit.files.schemaJsonUrl])

  if (files.length > 0) {
    process.stdout.write('Files:\n')
    const maxFileLen = Math.max(...files.map(([name]) => name.length))
    for (const [name, url] of files) {
      process.stdout.write(`  ${name.padEnd(maxFileLen)}  ${url}\n`)
    }
  }
}

export function printProgress(elapsedMs: number, status: string): void {
  process.stdout.write(`  t+${Math.floor(elapsedMs / 1000)}s  status=${status}\n`)
}

export function printError(message: string): void {
  process.stderr.write(`Error: ${message}\n`)
}

export function printSuccess(message: string): void {
  process.stdout.write(`✓ ${message}\n`)
}

export function jsonOut(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}
