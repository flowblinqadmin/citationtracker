import { z } from "zod";
import { normalizeDomain } from "@/lib/domain";
import { AGENT_MODELS } from "@/lib/engine/one-shot";

// Domain coercion shared with the brand/competitor schemas: accept any human
// form (URL, www., trailing slash, mixed case) and canonicalize to a bare
// hostname; reject only when there is no plausible hostname left.
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

/**
 * Request body for POST /api/agent/one-shot-citation.
 *
 * Limits mirror the fixed agent-storefront contract:
 *   - prompts: 1–3 (413 when the route sees the count-limit distinctly; see route)
 *   - models:  any subset of the four public model names; defaults to all
 *   - competitors: up to 5 (413 when over)
 *
 * The route distinguishes malformed body (400) from over-limit prompts/
 * competitors (413) by re-checking the raw lengths BEFORE this schema's min/max
 * would collapse them into a generic 400 — see the route handler.
 */
export const oneShotSchema = z.object({
  brandDomain: domainSchema,
  prompts: z.array(z.string().min(1).max(2000)).min(1).max(3),
  models: z.array(z.enum(AGENT_MODELS)).min(1).optional(),
  competitors: z.array(competitorSchema).max(5).optional(),
});

export type OneShotBody = z.infer<typeof oneShotSchema>;
