/**
 * ES-082 — typed errors for the llms.txt generation pipeline.
 *
 * - LlmsGenerationLengthExhausted: thrown by content-generator.ts when
 *   OpenAI returns empty content with finish_reason="length" (the model
 *   burned its budget on internal reasoning and emitted nothing). The
 *   silent fall-through this replaces is the Manipal data corruption bug.
 *
 * - RetryValidationExhausted: thrown by withRetry in pipeline/stage/route.ts
 *   when validation fails on the FINAL attempt, regardless of maxAttempts.
 *   Replaces the silent "using best result" fall-through.
 *
 * Both are re-exported from content-generator.ts (no logic change there)
 * so callers in app/api/pipeline/stage/route.ts can do
 *   import { LlmsGenerationLengthExhausted, RetryValidationExhausted }
 *     from "@/lib/services/content-generator";
 */

/** Thrown when an OpenAI completion exhausts its token budget without emitting content. */
export class LlmsGenerationLengthExhausted extends Error {
  readonly call: "short" | "full";
  readonly finishReason: string;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly maxCompletionTokens: number;
  constructor(args: {
    call: "short" | "full";
    finishReason: string;
    completionTokens: number;
    reasoningTokens: number;
    maxCompletionTokens: number;
  }) {
    super(
      `[generateLlmsTxt:${args.call}] OpenAI returned empty content with finish_reason="${args.finishReason}" ` +
      `(completion=${args.completionTokens}, reasoning=${args.reasoningTokens}, budget=${args.maxCompletionTokens}). ` +
      `Likely reasoning-burn — see TS-082 §2.2.`
    );
    this.name = "LlmsGenerationLengthExhausted";
    this.call = args.call;
    this.finishReason = args.finishReason;
    this.completionTokens = args.completionTokens;
    this.reasoningTokens = args.reasoningTokens;
    this.maxCompletionTokens = args.maxCompletionTokens;
  }
}

/** Thrown by `withRetry` when validation fails on the final attempt. */
export class RetryValidationExhausted extends Error {
  readonly label: string;
  readonly attempts: number;
  readonly failures: string[];
  constructor(label: string, attempts: number, failures: string[]) {
    super(`[withRetry] ${label} validation failed on final attempt ${attempts}: ${failures.join("; ")}`);
    this.name = "RetryValidationExhausted";
    this.label = label;
    this.attempts = attempts;
    this.failures = failures;
  }
}
