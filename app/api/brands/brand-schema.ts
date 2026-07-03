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
