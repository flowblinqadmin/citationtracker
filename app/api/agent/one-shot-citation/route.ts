// POST /api/agent/one-shot-citation — stateless one-shot citation run.
//
// The agent-facing surface. An AI agent (via the agent-storefront x402 gateway)
// submits a brand domain + up to 3 prompts and receives, in a SINGLE request,
// each prompt×model response with brand-mention + citation extraction and a
// share-of-voice summary. NO database writes, NO run rows, NO QStash, NO resume:
// the whole fan-out completes inside this one request (see lib/engine/one-shot.ts).
//
// AUTH: Authorization: Bearer ${AGENT_SERVICE_TOKEN} (constant-time; 401 on bad
// token, 503 when the env is unset — service not provisioned). This surface is
// admitted by the default-deny middleware via an explicit PUBLIC_PATHS entry
// (it does its own Bearer auth — no Supabase session), see middleware.ts.
//
// PRICING / BILLING linkage (billing is UPSTREAM — none here): the storefront
// charges $0.20 per prompt×model via x402. That is CE-parity:
// CREDITS_PER_PROMPT_MODEL = 2 credits × CREDIT_USD = $0.10 = $0.20 (lib/pricing.ts).
// This route runs the same providers a paid tracker run would, so the storefront's
// per-cell price maps 1:1 to a stored credit run. This route MUST NOT debit,
// refund, or touch credits.
//
// RATE LIMIT: in-memory token bucket (lib/agent-rate-limit.ts), 30/hr keyed on
// the caller token. The DB-backed limiter is intentionally NOT used — it writes
// to the shared geo-owned public.rate_limits table, which this stateless surface
// must not do. The caller is a single trusted upstream; x402 is the real spend
// control.

import { NextRequest, NextResponse } from "next/server";
import { assertAgentAuth } from "@/lib/agent-auth";
import { checkAgentRateLimit } from "@/lib/agent-rate-limit";
import { oneShotSchema } from "@/app/api/agent/agent-schema";
import {
  AGENT_MODELS,
  partitionModels,
  runOneShot,
  type AgentModel,
  type OneShotDeps,
  type OneShotResponse,
} from "@/lib/engine/one-shot";
import { resolveRedirects } from "@/lib/engine/url-matcher";
import type { ProviderQueryResult } from "@/lib/engine/providers";

// The whole fan-out (≤ 3 prompts × 4 models) runs synchronously in this request.
// Keep above lib/engine/one-shot ONE_SHOT_TIME_BUDGET_MS (55s) so the engine's
// own deadline always fires first and returns a partial body, never a platform
// 504. 60s is the Vercel Pro default ceiling; Next.js requires a literal here.
export const maxDuration = 60;

/** Hard request-limit maxima (contract → 413 when exceeded). */
const MAX_PROMPTS = 3;
const MAX_COMPETITORS = 5;

/**
 * E2E / deterministic seam. When E2E_FAKE_PROVIDERS=1 (set only by
 * playwright.config.ts, never in a deployed env), inject fixture providers so
 * the REAL one-shot engine runs with no keys or network — mirroring the
 * tracker-worker's e2eDeps() fail-safe. Refused in any deployed environment.
 */
function e2eDeps(): OneShotDeps {
  if (process.env.E2E_FAKE_PROVIDERS !== "1") return {};
  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    console.error(
      "[agent/one-shot] E2E_FAKE_PROVIDERS set in a DEPLOYED environment — ignoring; using real providers",
    );
    return {};
  }
  console.warn("[agent/one-shot] E2E_FAKE_PROVIDERS active — fixture providers (local test only)");
  const fake = async (prompt: string): Promise<ProviderQueryResult> => ({
    text: `1. Options for "${prompt.slice(0, 120)}" — e2e provider fixture.`,
    responseTimeMs: 5,
    citedUrls: ["https://acme-e2e.com/reviews/best-tools", "https://thirdparty.example/roundup"],
  });
  return {
    queryFns: { perplexity: fake, openai: fake, google: fake, anthropic: fake },
    resolveRedirectsFn: async (url: string) => url,
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1) Auth (401 bad token / 503 unprovisioned) BEFORE reading the body.
  const denied = assertAgentAuth(req);
  if (denied) return denied;

  // 2) Rate limit — keyed on the caller token (single trusted upstream). We know
  //    the token is present and valid past assertAgentAuth; use it as the key.
  const token = (req.headers.get("authorization") ?? "").slice("Bearer ".length);
  const rate = checkAgentRateLimit(token);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded — try again later" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rate.resetAt - Date.now()) / 1000)) } },
    );
  }

  // 3) Parse body. Distinguish over-limit prompts/competitors (413) from other
  //    malformed input (400) by checking raw array lengths FIRST — otherwise
  //    zod's .max() would collapse "too many" into a generic 400.
  const rawBody: unknown = await req.json().catch(() => null);
  if (rawBody === null || typeof rawBody !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = rawBody as Record<string, unknown>;
  if (Array.isArray(body.prompts) && body.prompts.length > MAX_PROMPTS) {
    return NextResponse.json(
      { error: `Too many prompts (max ${MAX_PROMPTS})` },
      { status: 413 },
    );
  }
  if (Array.isArray(body.competitors) && body.competitors.length > MAX_COMPETITORS) {
    return NextResponse.json(
      { error: `Too many competitors (max ${MAX_COMPETITORS})` },
      { status: 413 },
    );
  }

  const parsed = oneShotSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // 4) Resolve requested models (default = all four) and split configured vs.
  //    unconfigured (missing provider key). Unconfigured are skipped, never
  //    fatal — unless ZERO are configured, which is a 503 (no provider keys).
  const requested: AgentModel[] = parsed.data.models ?? [...AGENT_MODELS];
  const { configured, unconfigured } = partitionModels(requested);
  if (configured.length === 0) {
    return NextResponse.json(
      { error: "No provider keys configured", unconfigured_models: unconfigured },
      { status: 503 },
    );
  }

  // 5) Execute the fan-out (concurrency-capped, time-budgeted) and score.
  const deps = e2eDeps();
  const { results, summary } = await runOneShot(
    {
      brandDomain: parsed.data.brandDomain,
      prompts: parsed.data.prompts,
      models: configured,
      competitors: parsed.data.competitors,
    },
    configured,
    // Default redirect resolver unless the seam injected one.
    { resolveRedirectsFn: resolveRedirects, ...deps },
  );

  const payload: OneShotResponse = { results, summary, unconfigured_models: unconfigured };
  return NextResponse.json(payload, { status: 200 });
}
