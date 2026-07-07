// Centralized Gemini / Google Generative AI key resolution.
//
// L3 audit fix (2026-05-27): five+ call sites used
//   process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? ""
// passing the empty string to `new GoogleGenerativeAI("")`, which
// constructs successfully and only fails at the actual API call. Centralize
// the resolution and throw on empty so the failure happens at construction
// time with a clear message, not deep inside the SDK.

/**
 * Returns the configured Gemini/Google API key. Throws at call time if
 * the key is missing — refuse to construct `new GoogleGenerativeAI("")`,
 * which would otherwise silently no-op until the actual API call hours
 * later. Callers that gate on `process.env.GEMINI_API_KEY` before invoking
 * never trip this throw; the safety net catches misconfigured deploys.
 */
export function getGoogleGenAIKey(): string {
  const k =
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY ??
    "";
  if (!k) {
    throw new Error(
      "GEMINI_API_KEY / GOOGLE_API_KEY is not configured — refuse to call the SDK with an empty key",
    );
  }
  return k;
}
