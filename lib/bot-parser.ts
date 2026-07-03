// Known AI crawler signatures → display name
const BOT_PATTERNS: [RegExp, string][] = [
  [/GPTBot/i, "GPTBot"],
  [/ChatGPT-User/i, "ChatGPT"],
  [/ClaudeBot/i, "ClaudeBot"],
  [/Claude-Web/i, "ClaudeBot"],
  [/PerplexityBot/i, "PerplexityBot"],
  [/GoogleExtended/i, "GoogleExtended"],
  [/Googlebot/i, "Googlebot"],
  [/Bingbot/i, "Bingbot"],
  [/cohere-ai/i, "CohereBot"],
  [/meta-externalagent/i, "MetaBot"],
  [/Applebot/i, "Applebot"],
  [/YouBot/i, "YouBot"],
  [/anthropic-ai/i, "AnthropicBot"],
  [/Omgili/i, "Omgili"],
  [/facebookexternalhit/i, "FacebookBot"],
  [/Twitterbot/i, "TwitterBot"],
  [/LinkedInBot/i, "LinkedInBot"],
];

export function parseBotName(userAgent: string | null): string {
  if (!userAgent) return "unknown";
  for (const [pattern, name] of BOT_PATTERNS) {
    if (pattern.test(userAgent)) return name;
  }
  return "unknown";
}
