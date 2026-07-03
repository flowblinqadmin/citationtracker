/**
 * OpenAI-compatible routing helpers.
 *
 * Centralises the base URL, model resolution, and API key for every
 * OpenAI-compatible call in the pipeline. Set the environment variables below
 * to redirect all three call-sites to a local LM Studio server for testing:
 *
 *   LLM_LOCAL=1
 *   LLM_BASE_URL=http://localhost:4321/v1
 *   LLM_LOCAL_MODEL=google/gemma-4-12b   # optional, this is the default
 *
 * In production (none of those vars set) the helpers return the real OpenAI
 * endpoint and whatever model pin the call-site passes as `defaultModel`.
 */

import OpenAI from "openai";

/**
 * Base URL for OpenAI-compatible completions endpoints.
 * Defaults to the real OpenAI API; override with LLM_BASE_URL for local routing.
 */
export function openAILikeBaseUrl(): string {
  return process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
}

/**
 * Returns true when the pipeline is configured to route to a local LLM.
 * True when either LLM_LOCAL=1 or LLM_BASE_URL is explicitly set.
 */
export function isLocalLLM(): boolean {
  return process.env.LLM_LOCAL === "1" || Boolean(process.env.LLM_BASE_URL);
}

/**
 * Resolves the model to use for a given call site.
 *
 * When routing to a local LLM, returns the local model name (from
 * LLM_LOCAL_MODEL, defaulting to "google/gemma-4-12b") regardless of what
 * the call site specifies — local servers typically only serve one model.
 *
 * In production, returns `defaultModel` unchanged (preserving FIX-026 pins).
 *
 * @param defaultModel  The production model pin (e.g. "gpt-5.4", "gpt-5.4-mini").
 */
export function resolveOpenAIModel(defaultModel: string): string {
  if (isLocalLLM()) {
    return process.env.LLM_LOCAL_MODEL ?? "google/gemma-4-12b";
  }
  return defaultModel;
}

/**
 * Returns the API key to use.
 *
 * LM Studio ignores the key but the OpenAI client requires a non-empty string.
 * Falls back to "local" when routing locally so no real key is needed.
 */
export function openAIApiKey(): string {
  return (
    process.env.OPENAI_API_KEY ??
    (isLocalLLM() ? "local" : "")
  );
}

/**
 * Creates an OpenAI client wired to the correct base URL and API key.
 * Drop-in replacement for `new OpenAI({ apiKey: process.env.OPENAI_API_KEY })`.
 */
export function createOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: openAIApiKey(),
    baseURL: openAILikeBaseUrl(),
  });
}
