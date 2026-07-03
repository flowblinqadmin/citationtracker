/**
 * Sanitize untrusted string values before embedding them in LLM prompts.
 * Prevents prompt injection via newlines, quote injection, and instruction smuggling.
 */
export function sanitizeForPrompt(value: string | null | undefined, maxLen = 500): string {
  if (!value) return "";
  return value
    .replace(/[\r\n]+/g, " ")        // no newlines — prevent instruction injection
    .replace(/["""]/g, "'")          // normalize smart/double quotes
    .replace(/[`]/g, "'")            // normalize backticks
    .trim()
    .substring(0, maxLen);
}
