// Known AI-crawler UA allowlist.
//
// Ported verbatim from geo/lib/crawler-allowlist.ts — used by the track-slug
// handler to decide which response variant to emit. AI crawlers receive the
// schema-injection JS / llms.txt / business.json that customers expect them
// to ingest; visitor browsers receive the beacon-only response.
//
// Pure regex — no Deno-incompatible APIs. Keep in sync with the Next.js list.

export const AI_CRAWLER_UA_PATTERNS = [
  /GPTBot/i,
  /ClaudeBot/i,
  /PerplexityBot/i,
  /Googlebot/i,
  /GoogleExtended/i,
  /Bingbot/i,
  /Applebot/i,
  /cohere-ai/i,
  /meta-externalagent/i,
  /Bytespider/i,
  /CCBot/i,
];

export function isKnownAICrawler(userAgent: string): boolean {
  return AI_CRAWLER_UA_PATTERNS.some((p) => p.test(userAgent));
}
