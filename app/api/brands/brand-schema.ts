import { z } from "zod";

const competitorSchema = z.object({
  name: z.string().min(1).max(100),
  domain: z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/i, "invalid domain"),
});

export const brandInputSchema = z.object({
  name: z.string().min(1).max(100),
  domain: z.string().max(253).regex(/^[a-z0-9.-]*$/i, "invalid domain").optional(),
  competitors: z.array(competitorSchema).max(10).optional(),
  runFrequency: z.enum(["manual", "weekly", "monthly"]).optional(),
});

/** Optional "Run now" body — narrow the run to specific prompts / platforms. */
export const runScopeSchema = z.object({
  promptIds: z.array(z.string().min(1).max(64)).min(1).max(30).optional(),
  platforms: z.array(z.enum(["openai", "perplexity", "google"])).min(1).max(3).optional(),
});
