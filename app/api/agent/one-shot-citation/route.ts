// POST /api/agent/one-shot-citation — stateless one-shot citation run.
//
// The agent-facing surface. An AI agent submits a brand domain + up to 3 prompts
// and receives, in a SINGLE request, each prompt×model response with brand-mention
// + citation extraction and a share-of-voice summary. NO run rows, NO QStash, NO
// resume: the whole fan-out completes inside this one request (see lib/engine/
// one-shot.ts).
//
// DUAL AUTH (the request/response contract is FIXED for existing callers; billed
// mode only ADDS two fields to the success body):
//   1. Bearer AGENT_SERVICE_TOKEN  → UNBILLED. The agent-storefront x402 gateway;
//      spend is collected upstream by x402. Constant-time compared (lib/agent-auth).
//      Existing behavior, unchanged.
//   2. Bearer <geo v1 customer API JWT>  → BILLED against the token's geo team.
//      HS256 / API_JWT_SECRET / scope audit:write, mirrored from geo's
//      lib/api-auth.ts (lib/agent-billing-auth). Debits geo credits before
//      execution; refunds on failure / for models that couldn't run.
//   Order: service-token match FIRST (constant-time), else JWT verify, else 401.
//   Admitted by the default-deny middleware via a PUBLIC_PATHS entry — both
//   modes do their own Bearer auth (no Supabase session), see middleware.ts.
//
// BILLING (billed mode only): cost = prompts × Σ PLATFORM_CREDITS[model] over the
// requested models — the SAME per-model source of truth the brand-run route uses
// (lib/pricing.ts: Claude/anthropic = 4, the other three = 2; NOT a flat ×2). A
// 1-prompt × 4-model run = 2+2+2+4 = 10 credits. Debited BEFORE execution against
// the token's team via the shared credit ledger (lib/credits.ts →
// public.credit_transactions; NO tracker.* rows, NO orgs row — a billed one-shot
// is pure public.* billing). Idempotency key is a synthetic osc_<nanoid> site_id
// under the EXISTING citation_run / citation_run_refund partial-unique-index types
// (no new ledger types, no migration). Insufficient balance → 402. Full refund if
// execution throws; partial refund = prompts × Σ PLATFORM_CREDITS[missing model]
// when unconfigured provider keys mean fewer models ran than were billed (so a
// missing Claude refunds 4, not 2).
//
// RATE LIMIT: in-memory token bucket (lib/agent-rate-limit.ts), 30/hr. Unbilled
// mode keys on the service token; billed mode keys on the team id ("team:<id>").

import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { agentBearerValid, agentServiceProvisioned } from "@/lib/agent-auth";
import { verifyBilledAuth } from "@/lib/agent-billing-auth";
import { checkAgentRateLimit } from "@/lib/agent-rate-limit";
import { debitForRun, refundForRun } from "@/lib/credits";
import { PLATFORM_CREDITS } from "@/lib/pricing";
import { oneShotSchema } from "@/app/api/agent/agent-schema";
import {
  AGENT_MODELS,
  MODEL_TO_PLATFORM,
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
 * Credits for `numPrompts` prompts across `models`, priced PER MODEL off the
 * SAME PLATFORM_CREDITS source-of-truth the brand-run route uses (Claude = 4,
 * the rest = 2) — not a flat ×2. Agent models map to engine platforms via
 * MODEL_TO_PLATFORM (gemini → google). Used for both the upfront debit (full
 * requested set) and partial refunds (the subset that couldn't run), so the
 * refund for a missing Claude is 4, not 2.
 */
function priceForModels(numPrompts: number, models: readonly AgentModel[]): number {
  const perPrompt = models.reduce((sum, m) => sum + PLATFORM_CREDITS[MODEL_TO_PLATFORM[m]], 0);
  return numPrompts * perPrompt;
}

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

/** Resolved caller identity: which auth mode admitted the request. */
type Caller =
  | { mode: "unbilled" }
  | { mode: "billed"; teamId: string };

/**
 * Dual-auth. Try the service-token first (constant-time), else the geo v1 JWT.
 * Returns the caller on success, or the NextResponse to return on failure.
 *
 * Precedence rationale: the service token is a single fixed secret compared in
 * constant time; a JWT verify is a signature check. Trying the service token
 * first keeps the hot (storefront) path cheap and its timing flat, and means a
 * caller presenting the service token is NEVER routed through billing.
 */
async function authenticate(req: NextRequest): Promise<Caller | NextResponse> {
  // 0) Core-service provisioning gate. If AGENT_SERVICE_TOKEN is unset, the agent
  //    surface itself is not stood up → 503, and this MUST win before any billed
  //    JWT attempt (preserves the pre-existing "service not provisioned" contract
  //    the storefront relies on to tell 503 apart from a 401 bad token).
  if (!agentServiceProvisioned()) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  // 1) Service token → unbilled. Constant-time; only true when the env secret is
  //    set AND matches. A non-matching token falls through to the JWT attempt.
  if (agentBearerValid(req)) return { mode: "unbilled" };

  // 2) Geo v1 customer JWT → billed.
  const billed = await verifyBilledAuth(req);
  if (billed.ok) return { mode: "billed", teamId: billed.payload.team_id };

  // 3) Neither. A valid-signature token that merely lacks the scope is a
  //    definite 403. Everything else — bad/expired/missing token, or billing not
  //    provisioned (API_JWT_SECRET unset) — is an indistinguishable 401. We do
  //    NOT surface "unprovisioned" as a distinct 503: a service-token-only
  //    deployment (no billing secret) must answer a wrong token with the exact
  //    same 401 it always did, never leak whether billing is configured.
  if (billed.kind === "forbidden") {
    return NextResponse.json({ error: "insufficient_scope" }, { status: 403 });
  }
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1) Auth (dual-mode). 401/403/503 on failure BEFORE reading the body.
  const caller = await authenticate(req);
  if (caller instanceof NextResponse) return caller;

  // 2) Rate limit — 30/hr. Unbilled keys on the service token (single trusted
  //    upstream); billed keys on the team id so each customer team gets its own
  //    window. Namespaced so the two key spaces can never collide.
  const rateKey =
    caller.mode === "billed"
      ? `team:${caller.teamId}`
      : (req.headers.get("authorization") ?? "").slice("Bearer ".length);
  const rate = checkAgentRateLimit(rateKey);
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

  const numPrompts = parsed.data.prompts.length;

  // 5) BILLED MODE: debit BEFORE execution. Price the FULL requested set PER
  //    MODEL off PLATFORM_CREDITS (brand-run parity: Claude 4, others 2 — never a
  //    flat ×2); any model that can't run (unconfigured key) is refunded below.
  //    NO tracker rows — pure public.credit_transactions billing keyed on a
  //    synthetic osc_ id.
  const billingId = caller.mode === "billed" ? `osc_${nanoid()}` : null;
  let creditsCharged = 0;
  if (caller.mode === "billed" && billingId) {
    const cost = priceForModels(numPrompts, requested);
    const debit = await debitForRun(caller.teamId, billingId, cost);
    if (!debit.applied) {
      // Only outcome here is insufficient funds — the osc_ id is unique per
      // request, so "already_applied" is unreachable.
      return NextResponse.json(
        {
          error: "insufficient_credits",
          required: cost,
          ...(typeof debit.balance === "number" ? { balance: debit.balance } : {}),
        },
        { status: 402 },
      );
    }
    creditsCharged = cost;
  }

  // 6) Execute the fan-out (concurrency-capped, time-budgeted) and score. In
  //    billed mode, a throw here must FULLY refund before surfacing the error.
  const deps = e2eDeps();
  let payload: OneShotResponse;
  try {
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
    payload = { results, summary, unconfigured_models: unconfigured };
  } catch (err) {
    if (caller.mode === "billed" && billingId && creditsCharged > 0) {
      // Full refund — best effort; a refund failure must not mask the exec error.
      await refundForRun(caller.teamId, billingId, creditsCharged).catch(() => {});
    }
    throw err;
  }

  // 7) BILLED MODE: partial refund for models we billed but couldn't run
  //    (unconfigured provider keys), then attach the billing fields. Refund
  //    reuses the SAME osc_ id under citation_run_refund — exactly-once by the
  //    ledger's partial unique index.
  if (caller.mode === "billed" && billingId) {
    // Price the ACTUAL missing models per-model (Claude refunds 4, not 2), not a
    // flat ×2 over a count — same PLATFORM_CREDITS source as the debit.
    const configuredSet = new Set<AgentModel>(configured);
    const missingModels = requested.filter((m) => !configuredSet.has(m));
    if (missingModels.length > 0) {
      const refund = priceForModels(numPrompts, missingModels);
      const r = await refundForRun(caller.teamId, billingId, refund);
      if (r.applied) creditsCharged -= refund;
    }

    const billedBody: OneShotResponse & { credits_charged: number; credits_remaining?: number } = {
      ...payload,
      credits_charged: creditsCharged,
    };
    // credits_remaining only when it's cheap — the last ledger op returned a
    // balance (refund path) or we do one lightweight fetch on the debit-only path.
    const remaining = await currentBalance(caller.teamId);
    if (typeof remaining === "number") billedBody.credits_remaining = remaining;

    return NextResponse.json(billedBody, { status: 200 });
  }

  return NextResponse.json(payload, { status: 200 });
}

/**
 * Best-effort team credit balance for the credits_remaining field. Never throws
 * (a read failure just omits the field — the charge already succeeded). Imported
 * lazily so the unbilled path never pulls the DB client into its module graph.
 */
async function currentBalance(teamId: string): Promise<number | undefined> {
  try {
    const { db } = await import("@/lib/db");
    const { teams } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select({ b: teams.creditBalance }).from(teams).where(eq(teams.id, teamId));
    return row?.b;
  } catch {
    return undefined;
  }
}
