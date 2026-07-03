/** Known AI crawler User-Agent patterns — these are the consumers we WANT */
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
