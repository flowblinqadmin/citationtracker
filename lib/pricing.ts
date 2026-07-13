// Pure pricing — NO server imports (client components use this for cost
// previews; lib/credits.ts uses it for actual billing).
//
// Pricing is per prompt PER MODEL: a base of 2 credits, except Claude
// (anthropic), which is premium at 4 (it runs a web-search tool and costs more
// per call). A full 4-model run of one prompt = 2+2+2+4 = 10 credits; scoping
// to one base model = 2, to Claude = 4. Predictable, and comfortably above
// cost — the per-model margin test guards every model, and the wider Claude
// margin also absorbs the re-run-once, sentiment, and Firecrawl
// verification/AI-search costs a run incurs beyond the primary call.
import type { TrackerPlatform } from "@/lib/types/tracker";

// Estimated USD cost of one prompt-execution (1 prompt × 1 model, ~1k tokens
// out). Perplexity dominates the base tier via per-search fees; Claude leads
// overall via web searches. Review quarterly against provider pricing (see
// CLAUDE.md) — the per-model margin test fails if PLATFORM_CREDITS stops
// covering cost × margin for any model.
export const MODEL_COST_ESTIMATES = {
  openai: 0.002,     // gpt-5.4-mini
  perplexity: 0.010, // sonar (incl. search fee)
  google: 0.001,     // gemini flash
  anthropic: 0.026,  // claude-haiku-4.5 + up to 2 web searches ($0.01 each)
} as const;

export const CITATION_EXEC_MARGIN = 1.3;
export const CREDIT_USD = 0.1; // geo: $10 per 100-credit pack

/**
 * Flat base price: 2 credits per prompt per model. Still the scalar other
 * callers multiply by (e.g. the agent one-shot surface); the per-model premium
 * lives in PLATFORM_CREDITS, so keep this name + value stable.
 */
export const CREDITS_PER_PROMPT_MODEL = 2;

/**
 * Per-model credit price PER PROMPT — the single source of truth for run
 * pricing. Claude (anthropic) is premium at 4; the other three sit at the base.
 */
export const PLATFORM_CREDITS: Record<TrackerPlatform, number> = {
  openai: CREDITS_PER_PROMPT_MODEL,
  perplexity: CREDITS_PER_PROMPT_MODEL,
  google: CREDITS_PER_PROMPT_MODEL,
  anthropic: 2 * CREDITS_PER_PROMPT_MODEL,
};

const ALL_PLATFORMS: readonly TrackerPlatform[] = ["openai", "perplexity", "google", "anthropic"];

/**
 * Credits charged for one run of `numPrompts` prompts across `platforms`
 * (default: all four models). Each prompt is priced per model via
 * PLATFORM_CREDITS — Claude costs 4, the rest 2. Platform identity is REQUIRED:
 * a bare model count can't distinguish the premium model, so pricing takes the
 * actual list. Validates a positive-int prompt count and 1–4 unique known
 * platforms; throws otherwise.
 */
export function citationRunCredits(
  numPrompts: number,
  platforms: readonly TrackerPlatform[] = ALL_PLATFORMS,
): number {
  if (!Number.isInteger(numPrompts) || numPrompts <= 0) {
    throw new Error(`citationRunCredits: numPrompts must be a positive integer, got ${numPrompts}`);
  }
  const unique = new Set(platforms);
  if (unique.size !== platforms.length) {
    throw new Error(`citationRunCredits: duplicate platforms in ${JSON.stringify(platforms)}`);
  }
  if (unique.size < 1 || unique.size > ALL_PLATFORMS.length) {
    throw new Error(`citationRunCredits: expected 1–${ALL_PLATFORMS.length} platforms, got ${unique.size}`);
  }
  let perPrompt = 0;
  for (const p of unique) {
    if (!ALL_PLATFORMS.includes(p)) {
      throw new Error(`citationRunCredits: unknown platform ${JSON.stringify(p)}`);
    }
    perPrompt += PLATFORM_CREDITS[p];
  }
  return numPrompts * perPrompt;
}
