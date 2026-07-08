// Pure pricing — NO server imports (client components use this for cost
// previews; lib/credits.ts uses it for actual billing).
//
// Pricing is flat: 2 credits per prompt PER MODEL queried. A full 4-platform
// run of one prompt = 8 credits; scoping to one model = 2 credits. Simple to
// predict, and comfortably above cost: the priciest execution (claude +
// web searches, ~$0.026) is well under the $0.20 two credits sell for — a wide
// margin that also absorbs the re-run-once, sentiment, and Firecrawl
// verification/AI-search costs a run incurs beyond the primary call.

// Estimated USD cost of one prompt-execution (1 prompt × 1 model, ~1k tokens
// out). Perplexity dominates via per-search fees. Review quarterly against
// provider pricing (see CLAUDE.md) — the margin test fails if CREDITS_PER_PROMPT
// stops covering cost × margin.
export const MODEL_COST_ESTIMATES = {
  openai: 0.002,     // gpt-5.4-mini
  perplexity: 0.010, // sonar (incl. search fee)
  google: 0.001,     // gemini flash
  anthropic: 0.026,  // claude-haiku-4.5 + up to 2 web searches ($0.01 each)
} as const;

export const CITATION_EXEC_MARGIN = 1.3;
export const CREDIT_USD = 0.1; // geo: $10 per 100-credit pack
const ALL_PLATFORM_COUNT = 4;

/** Flat price: 2 credits per prompt per model queried. */
export const CREDITS_PER_PROMPT_MODEL = 2;

/**
 * Credits charged for one run of `numPrompts` prompts on `platformCount`
 * models (default: all 3). 1 prompt × 1 model is the smallest billable unit.
 */
export function citationRunCredits(numPrompts: number, platformCount = ALL_PLATFORM_COUNT): number {
  if (!Number.isInteger(numPrompts) || numPrompts <= 0) {
    throw new Error(`citationRunCredits: numPrompts must be a positive integer, got ${numPrompts}`);
  }
  if (!Number.isInteger(platformCount) || platformCount < 1 || platformCount > ALL_PLATFORM_COUNT) {
    throw new Error(`citationRunCredits: platformCount must be 1–${ALL_PLATFORM_COUNT}, got ${platformCount}`);
  }
  return numPrompts * platformCount * CREDITS_PER_PROMPT_MODEL;
}
