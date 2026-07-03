/**
 * Pre-flight guardrails for chatbot messages.
 * Runs before any LLM call to reject jailbreaks and off-topic queries at zero cost.
 */

const JAILBREAK_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+(instructions|prompts|rules)/i,
  /you\s+are\s+now\s+/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /act\s+as\s+(if\s+you\s+are|a\s+)/i,
  /reveal\s+your\s+(system\s+)?prompt/i,
  /show\s+me\s+your\s+(instructions|rules|prompt)/i,
  /what\s+are\s+your\s+(instructions|rules|system\s+prompt)/i,
  /forget\s+(your\s+)?(instructions|rules|training)/i,
  /override\s+(your\s+)?(instructions|rules|restrictions)/i,
  /disregard\s+(your\s+)?(instructions|rules|previous)/i,
  /bypass\s+(your\s+)?(filters|restrictions|guardrails)/i,
  /do\s+anything\s+now/i,
  /jailbreak/i,
  /DAN\s+mode/i,
];

const OFF_TOPIC_PATTERNS = [
  /\b(bitcoin|crypto|nft|blockchain|forex|stock\s+market)\b/i,
  /\b(recipe|cooking|food|restaurant)\b/i,
  /\b(weather|forecast|temperature)\b/i,
  /\b(politics|election|democrat|republican|liberal|conservative)\b/i,
  /\b(dating|relationship|love|marriage)\b/i,
  /\b(medical|diagnosis|symptoms|prescription|medication)\b/i,
  /\b(homework|essay|thesis|assignment)\b/i,
];

// Topics that SHOULD be allowed (override off-topic if matched)
const ALLOWED_TOPIC_PATTERNS = [
  /\b(seo|geo|audit|score|pillar|recommendation|structured\s+data|schema|json-?ld)\b/i,
  /\b(llms\.txt|robots\.txt|meta\s+tag|sitemap|crawl|index)\b/i,
  /\b(wordpress|shopify|wix|squarespace|webflow|next\.?js|drupal|magento)\b/i,
  /\b(credit|pricing|plan|subscription|upgrade|billing|payment)\b/i,
  /\b(website|domain|page|url|traffic|visibility|citation)\b/i,
  /\b(ai\s+agent|chatgpt|perplexity|gemini|claude|gptbot)\b/i,
  /\b(download|report|zip|pdf|setup|deploy|implement)\b/i,
  /\b(dashboard|tab|scorecard|overview|history)\b/i,
];

const MAX_MESSAGE_LENGTH = 2000;

const REFUSAL_MESSAGE =
  "I can only help with questions about your GEO audit, AI visibility optimization, implementing website improvements, and navigating the GEO portal. Is there something about your audit results or website I can help with?";

export interface GuardrailResult {
  allowed: boolean;
  refusalMessage?: string;
}

export function checkGuardrails(message: string): GuardrailResult {
  // Normalize Unicode (NFKC) to defeat homoglyph attacks (e.g., Cyrillic 'е' for Latin 'e')
  const normalized = message.normalize("NFKC");

  // Empty or too long
  if (!normalized.trim()) {
    return { allowed: false, refusalMessage: "Please enter a message." };
  }

  if (normalized.length > MAX_MESSAGE_LENGTH) {
    return {
      allowed: false,
      refusalMessage: `Messages are limited to ${MAX_MESSAGE_LENGTH} characters. Please shorten your question.`,
    };
  }

  // Jailbreak detection — always block
  for (const pattern of JAILBREAK_PATTERNS) {
    if (pattern.test(normalized)) {
      return { allowed: false, refusalMessage: REFUSAL_MESSAGE };
    }
  }

  // Off-topic detection — only block if no allowed topic is also present
  const isOffTopic = OFF_TOPIC_PATTERNS.some((p) => p.test(normalized));
  const isOnTopic = ALLOWED_TOPIC_PATTERNS.some((p) => p.test(normalized));

  if (isOffTopic && !isOnTopic) {
    return { allowed: false, refusalMessage: REFUSAL_MESSAGE };
  }

  return { allowed: true };
}

// ── Navigation intent classifier ────────────────────────────────────────────

import type { ViewContext } from "./system-prompt";

/**
 * Detect "what am I looking at?" / "explain this page" intent.
 * When viewContext is non-null AND query is a short context question,
 * the chatbot should answer from view context regardless of retrieval tier.
 */
export function navIntent(
  query: string,
  viewContext: ViewContext | null,
): { isNav: boolean } {
  if (!viewContext) return { isNav: false };
  if (query.length > 80) return { isNav: false };
  const normalized = query.trim().toLowerCase();
  const NAV_PATTERNS = [
    /\b(what|where|why|which)\s+(am i|is this|does this|do i|are these|can i)\b/,
    /\b(explain|describe|tell me|show me)\s+(this|here|what|where)\b/,
    /\bnavigate\b|\bfind\b|\bwhats? (this|here|on this)\b/,
    /\b(am i|are we|did i)\s+(seeing|on|in)\b/,
  ];
  const isNav = NAV_PATTERNS.some((p) => p.test(normalized));
  return { isNav };
}
