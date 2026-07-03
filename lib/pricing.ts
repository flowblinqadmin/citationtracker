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
const PLATFORM_COUNT = 3; // geo's worker always queries all three

export const CITATION_EXEC_PRICE_USD =
  Math.max(...Object.values(MODEL_COST_ESTIMATES)) * CITATION_EXEC_MARGIN;

/** Credits charged for one run of `numPrompts` prompts across all platforms. */
export function citationRunCredits(numPrompts: number): number {
  if (!Number.isInteger(numPrompts) || numPrompts <= 0) {
    throw new Error(`citationRunCredits: numPrompts must be a positive integer, got ${numPrompts}`);
  }
  const usd = numPrompts * PLATFORM_COUNT * CITATION_EXEC_PRICE_USD;
  return Math.max(1, Math.ceil(usd / CREDIT_USD));
}
