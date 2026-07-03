// Pure pricing — NO server imports (client components use this for cost
// previews; lib/credits.ts uses it for actual billing).
//
// Pricing is flat and per prompt: 1 credit per prompt per run, regardless of
// which platforms the run queries. Simple to predict, and comfortably above
// cost: the worst case (all 3 platforms) is ~$0.039 per prompt vs the $0.10
// a credit sells for.

// Estimated USD cost of one prompt-execution (1 prompt × 1 model, ~1k tokens
// out). Perplexity dominates via per-search fees. Review quarterly against
// provider pricing (see CLAUDE.md) — the margin test fails if CREDITS_PER_PROMPT
// stops covering cost × margin.
export const MODEL_COST_ESTIMATES = {
  openai: 0.002,     // gpt-5.4-mini
  perplexity: 0.010, // sonar (incl. search fee)
  google: 0.001,     // gemini flash
} as const;

export const CITATION_EXEC_MARGIN = 1.3;
export const CREDIT_USD = 0.1; // geo: $10 per 100-credit pack
const ALL_PLATFORM_COUNT = 3;

/** Flat price: 1 credit per prompt per run (platform choice doesn't change it). */
export const CREDITS_PER_PROMPT = 1;

/**
 * Credits charged for one run of `numPrompts` prompts. `platformCount` is the
 * selected platform subset (1–3) — validated because it scopes execution, but
 * it does not change the price.
 */
export function citationRunCredits(numPrompts: number, platformCount = ALL_PLATFORM_COUNT): number {
  if (!Number.isInteger(numPrompts) || numPrompts <= 0) {
    throw new Error(`citationRunCredits: numPrompts must be a positive integer, got ${numPrompts}`);
  }
  if (!Number.isInteger(platformCount) || platformCount < 1 || platformCount > ALL_PLATFORM_COUNT) {
    throw new Error(`citationRunCredits: platformCount must be 1–${ALL_PLATFORM_COUNT}, got ${platformCount}`);
  }
  return numPrompts * CREDITS_PER_PROMPT;
}
