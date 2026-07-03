import { z } from "zod";

const competitorSchema = z.object({
  name: z.string().min(1).max(100),
  domain: z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/i, "invalid domain"),
});

export const brandInputSchema = z.object({
  name: z.string().min(1).max(100),
  // Required: brand-mention detection and citation matching are keyed on the
  // domain — without one, mentions/sentiment/citation rate are all dead.
  domain: z.string().min(3).max(253).regex(/^[a-z0-9.-]+$/i, "invalid domain"),
  competitors: z.array(competitorSchema).max(10).optional(),
  runFrequency: z.enum(["manual", "weekly", "monthly"]).optional(),
});

/** Optional "Run now" body — narrow the run to specific prompts / platforms. */
export const runScopeSchema = z.object({
  promptIds: z.array(z.string().min(1).max(64)).min(1).max(30).optional(),
  platforms: z.array(z.enum(["openai", "perplexity", "google", "anthropic"])).min(1).max(4).optional(),
});
