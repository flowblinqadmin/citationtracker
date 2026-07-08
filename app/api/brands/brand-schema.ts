import { z } from "zod";
import { normalizeDomain } from "@/lib/domain";

// Accept a domain in any human form (URL, www., trailing slash, mixed case) and
// canonicalize it to a bare hostname. Rejects only when there is no plausible
// hostname left. The stored value is always the normalized form.
const domainSchema = z.string().transform((raw, ctx) => {
  const d = normalizeDomain(raw);
  if (!d) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid domain" });
    return z.NEVER;
  }
  return d;
});

const competitorSchema = z.object({
  name: z.string().min(1).max(100),
  domain: domainSchema,
});

export const brandInputSchema = z.object({
  name: z.string().min(1).max(100),
  // Required: brand-mention detection and citation matching are keyed on the
  // domain — without one, mentions/sentiment/citation rate are all dead.
  domain: domainSchema,
  competitors: z.array(competitorSchema).max(10).optional(),
  runFrequency: z.enum(["manual", "weekly", "monthly"]).optional(),
});

/** Optional "Run now" body — narrow the run to specific prompts / platforms. */
export const runScopeSchema = z.object({
  promptIds: z.array(z.string().min(1).max(64)).min(1).max(30).optional(),
  platforms: z.array(z.enum(["openai", "perplexity", "google", "anthropic"])).min(1).max(4).optional(),
});
