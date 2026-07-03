// Pure pricing — NO server imports (client components use this for cost
// previews; lib/credits.ts uses it for actual billing).
//
// Flat USD price per prompt-execution pegged to the MOST EXPENSIVE model ×
// margin, charged for all 3 platforms geo's worker queries — every run is
// profitable regardless of which model answers best.

// Estimated USD cost of one prompt-execution (1 prompt × 1 model, ~1k tokens
// out). Perplexity dominates via per-search fees. Review quarterly against
// provider pricing (see CLAUDE.md).
export const MODEL_COST_ESTIMATES = {
  openai: 0.002,     // gpt-5.4-mini
  perplexity: 0.010, // sonar (incl. search fee)
  google: 0.001,     // gemini flash
} as const;

export const CITATION_EXEC_MARGIN = 1.3;
export const CREDIT_USD = 0.1; // geo: $10 per 100-credit pack
export const ALL_PLATFORM_COUNT = 3;

export const CITATION_EXEC_PRICE_USD =
  Math.max(...Object.values(MODEL_COST_ESTIMATES)) * CITATION_EXEC_MARGIN;

/**
 * Credits charged for one run of `numPrompts` prompts on `platformCount`
 * platforms (default: all 3). Per prompt-execution the price is flat
 * (priciest model × margin), so a single prompt on a single model is the
 * smallest billable unit — 1 credit.
 */
export function citationRunCredits(numPrompts: number, platformCount = ALL_PLATFORM_COUNT): number {
  if (!Number.isInteger(numPrompts) || numPrompts <= 0) {
    throw new Error(`citationRunCredits: numPrompts must be a positive integer, got ${numPrompts}`);
  }
  if (!Number.isInteger(platformCount) || platformCount < 1 || platformCount > ALL_PLATFORM_COUNT) {
    throw new Error(`citationRunCredits: platformCount must be 1–${ALL_PLATFORM_COUNT}, got ${platformCount}`);
  }
  const usd = numPrompts * platformCount * CITATION_EXEC_PRICE_USD;
  return Math.max(1, Math.ceil(usd / CREDIT_USD));
}
