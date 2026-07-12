// Platform display labels + canonical ordering, shared across the brand-detail
// UI (BrandDetail, TrackedUrlsEditor). Pure client-safe consts — one source of
// truth so the ChatGPT/Perplexity/Gemini/Claude mapping never drifts.
export const PLATFORM_LABEL: Record<string, string> = {
  openai: "ChatGPT",
  perplexity: "Perplexity",
  google: "Gemini",
  anthropic: "Claude",
};

export const PLATFORM_ORDER = ["openai", "perplexity", "google", "anthropic"];
