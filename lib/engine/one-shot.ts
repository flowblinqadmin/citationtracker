// Stateless one-shot citation run — the engine behind
// POST /api/agent/one-shot-citation.
//
// This is the agent-facing surface: an AI agent (via the agent-storefront x402
// gateway) submits a brand domain + up to 3 prompts and gets back, in a SINGLE
// request, each prompt×model response with brand-mention + citation extraction,
// plus a share-of-voice summary — with NO database writes and NO run rows.
//
// It reuses the exact engine internals the persisted tracker uses:
//   - lib/engine/providers.ts        the four provider query functions + MODELS
//   - GROUNDED_CITATION_SYSTEM_PROMPT the anti-hallucination steering (runner.ts)
//   - isBrandMentioned                brand-mention detection (url-matcher.ts)
//   - extractRegistrableDomain        registrable-domain matching (url-matcher.ts)
//   - resolveRedirects                Gemini/AMP redirect unwrapping (url-matcher.ts)
// so a one-shot answer is byte-for-byte comparable to a stored tracker run for
// the same prompt/model.
//
// Billing lives UPSTREAM on agent-storefront (x402, $0.20 per prompt×model —
// CE-parity with CREDITS_PER_PROMPT_MODEL=2 at CREDIT_USD=$0.10). There is no
// credit logic here; this module only executes and scores.

import {
  queryOpenAI,
  queryAnthropic,
  queryPerplexity,
  queryGoogle,
  type ProviderQueryResult,
  type ProviderQueryOpts,
} from "@/lib/engine/providers";
import {
  isBrandMentioned,
  extractRegistrableDomain,
  resolveRedirects,
} from "@/lib/engine/url-matcher";
import { GROUNDED_CITATION_SYSTEM_PROMPT } from "@/lib/engine/runner";
import { TRACKER_MAX_TOKENS } from "@/lib/config";

// ── Public contract types (mirror the agent-storefront contract) ──────────────

/**
 * The four models the agent may request. `gemini` is the public alias for the
 * engine's internal `google` platform (the Gemini 3.5 Flash model); everything
 * else is 1:1. Kept as a public-facing enum so the API surface never leaks the
 * internal platform key.
 */
export const AGENT_MODELS = ["openai", "anthropic", "perplexity", "gemini"] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

/** Internal engine platform key for each public agent model. */
type EnginePlatform = "openai" | "anthropic" | "perplexity" | "google";

const MODEL_TO_PLATFORM: Record<AgentModel, EnginePlatform> = {
  openai: "openai",
  anthropic: "anthropic",
  perplexity: "perplexity",
  gemini: "google",
};

/** Env var whose presence marks a provider as configured (skip if missing). */
const KEY_ENV_FOR: Record<AgentModel, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export interface AgentCompetitor {
  name: string;
  /** Already normalized to a bare hostname by the route's zod schema. */
  domain: string;
}

export interface OneShotInput {
  /** Bare brand domain (normalized upstream). */
  brandDomain: string;
  /** 1–3 prompts (enforced upstream). */
  prompts: string[];
  /** Subset of AGENT_MODELS; defaults to all four. */
  models?: AgentModel[];
  /** Up to 5 named competitors for share-of-voice (normalized upstream). */
  competitors?: AgentCompetitor[];
}

export interface OneShotCitation {
  url: string;
  title?: string;
}

export interface OneShotResult {
  prompt: string;
  model: AgentModel;
  /** First ~500 chars of the model's answer. */
  response_excerpt: string;
  brand_mentioned: boolean;
  citations: OneShotCitation[];
}

export interface ShareOfVoiceEntry {
  domain: string;
  share: number;
}

export interface ShareOfVoice {
  brand: number;
  competitors: ShareOfVoiceEntry[];
}

export interface OneShotSummary {
  /** Fraction of (prompt×model) answers that mentioned the brand. */
  mention_rate: number;
  /** Public model names actually executed (excludes unconfigured + skipped). */
  models_run: AgentModel[];
  /** Present only when at least one citation matched brand or a competitor. */
  share_of_voice?: ShareOfVoice;
}

export interface OneShotResponse {
  results: OneShotResult[];
  summary: OneShotSummary;
  /** Requested models whose provider key env was missing → not executed. */
  unconfigured_models: AgentModel[];
}

/**
 * Injectable engine dependencies. Defaults are the real provider clients +
 * redirect resolver; tests (and the E2E_FAKE_PROVIDERS seam) inject
 * deterministic stubs so the SAME code path runs with no keys or network —
 * mirroring the runner's RunnerDeps pattern.
 */
export interface OneShotDeps {
  queryFns?: Partial<Record<EnginePlatform, (p: string, o?: ProviderQueryOpts) => Promise<ProviderQueryResult>>>;
  resolveRedirectsFn?: typeof resolveRedirects;
  now?: () => number;
}

const REAL_QUERY_FNS: Record<EnginePlatform, (p: string, o?: ProviderQueryOpts) => Promise<ProviderQueryResult>> = {
  openai: queryOpenAI,
  anthropic: queryAnthropic,
  perplexity: queryPerplexity,
  google: queryGoogle,
};

const EXCERPT_CHARS = 500;

/**
 * Total wall-clock budget for the whole fan-out. Kept below the route's
 * maxDuration so the handler always returns a body (never a platform 504). On
 * the deadline, in-flight and un-started (prompt×model) cells resolve to a
 * timeout result: empty text, no citations, brand_mentioned=false — the answer
 * is still well-formed, just sparser. A partial answer beats a 504.
 */
export const ONE_SHOT_TIME_BUDGET_MS = 55_000;

/**
 * Concurrency cap on simultaneous provider calls across the whole fan-out.
 * Max fan-out is 3 prompts × 4 models = 12 cells; a cap of 6 keeps us well
 * under provider burst limits while still finishing a full 12-cell run inside
 * the time budget (2 waves). Mirrors the runner's batch-of-10 intent at a
 * smaller, single-request scale.
 */
const ONE_SHOT_CONCURRENCY = 6;

/** True when the model's provider key is present in the environment. */
export function isModelConfigured(model: AgentModel): boolean {
  const env = process.env[KEY_ENV_FOR[model]];
  return typeof env === "string" && env.trim().length > 0;
}

/**
 * Which of the requested models are configured vs. not. Missing keys are
 * skipped (listed in unconfigured), never fatal — unless ALL are missing, which
 * the route turns into a 503.
 */
export function partitionModels(requested: AgentModel[]): {
  configured: AgentModel[];
  unconfigured: AgentModel[];
} {
  const configured: AgentModel[] = [];
  const unconfigured: AgentModel[] = [];
  for (const m of requested) {
    (isModelConfigured(m) ? configured : unconfigured).push(m);
  }
  return { configured, unconfigured };
}

// ── Share of AI voice ─────────────────────────────────────────────────────────
// Computed from the SAME responses (no extra provider calls), by registrable-
// domain matching over the citations already extracted — the stateless mirror of
// listRunsWithStats' brand/competitor citation counts over tracker.citations.
// A citation counts toward a party when its cited URL's registrable domain equals
// the party's domain OR is a subdomain of it (matching the DB's
// `domain = d OR domain LIKE '%.d'`).

const stripWww = (domain: string) => domain.trim().toLowerCase().replace(/^www\./, "");

/**
 * True when `citedDomain` (a registrable domain) equals `target` or is a
 * subdomain of it — the in-memory equivalent of the DB domainMatch helper.
 */
function domainMatches(citedDomain: string, target: string): boolean {
  return citedDomain === target || citedDomain.endsWith("." + target);
}

/**
 * Compute share of AI voice from the executed results. Returns undefined when no
 * citation matched the brand or any competitor (so the field is omitted rather
 * than reporting a meaningless all-zero split).
 */
export function computeShareOfVoice(
  results: OneShotResult[],
  brandDomain: string,
  competitors: AgentCompetitor[],
): ShareOfVoice | undefined {
  const brand = stripWww(brandDomain);
  const compDomains = competitors.map((c) => stripWww(c.domain)).filter(Boolean);

  let brandCount = 0;
  const compCounts = new Map<string, number>(compDomains.map((d) => [d, 0]));

  for (const r of results) {
    for (const cite of r.citations) {
      const regd = extractRegistrableDomain(cite.url);
      if (!regd) continue;
      const cited = stripWww(regd);
      if (domainMatches(cited, brand)) brandCount++;
      for (const cd of compDomains) {
        if (domainMatches(cited, cd)) {
          compCounts.set(cd, (compCounts.get(cd) ?? 0) + 1);
        }
      }
    }
  }

  const total = brandCount + [...compCounts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return undefined;

  return {
    brand: brandCount / total,
    competitors: compDomains.map((d) => ({
      domain: d,
      share: (compCounts.get(d) ?? 0) / total,
    })),
  };
}

// ── Fan-out execution ─────────────────────────────────────────────────────────

interface Cell {
  prompt: string;
  model: AgentModel;
}

/**
 * Run one (prompt × model) cell: query the provider (grounded system prompt),
 * detect brand mention, resolve+title the cited URLs. Never throws — provider
 * or timeout errors resolve to an empty, well-formed result so one bad cell can
 * never fail the whole request.
 */
async function runCell(
  cell: Cell,
  brandDomain: string,
  deps: OneShotDeps,
): Promise<OneShotResult> {
  const platform = MODEL_TO_PLATFORM[cell.model];
  const queryFn = deps.queryFns?.[platform] ?? REAL_QUERY_FNS[platform];
  const resolveFn = deps.resolveRedirectsFn ?? resolveRedirects;
  const opts: ProviderQueryOpts = {
    systemPrompt: GROUNDED_CITATION_SYSTEM_PROMPT,
    maxTokens: TRACKER_MAX_TOKENS,
  };

  let provider: ProviderQueryResult;
  try {
    provider = await queryFn(cell.prompt, opts);
  } catch {
    provider = { text: "", responseTimeMs: 0, citedUrls: [] };
  }

  const brand_mentioned = isBrandMentioned(provider.text, brandDomain);

  // Resolve redirect wrappers (Gemini vertexaisearch, AMP, google.com/url) so
  // the returned URL is the real destination and domain matching is accurate.
  // Best-effort + de-duped by resolved URL.
  const redirectCache = new Map<string, string>();
  const seen = new Set<string>();
  const citations: OneShotCitation[] = [];
  for (const raw of provider.citedUrls) {
    let resolved = raw;
    try {
      resolved = await resolveFn(raw, { cache: redirectCache });
    } catch {
      resolved = raw;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    citations.push({ url: resolved });
  }

  return {
    prompt: cell.prompt,
    model: cell.model,
    response_excerpt: provider.text.slice(0, EXCERPT_CHARS),
    brand_mentioned,
    citations,
  };
}

/** A timeout result for a cell the budget did not allow to complete. */
function timedOutResult(cell: Cell): OneShotResult {
  return {
    prompt: cell.prompt,
    model: cell.model,
    response_excerpt: "",
    brand_mentioned: false,
    citations: [],
  };
}

/**
 * Execute the full prompt × model fan-out for the CONFIGURED models, honoring a
 * concurrency cap and a total time budget. Unconfigured models are not run here
 * (the caller partitions them out first and reports them in unconfigured_models).
 *
 * Time-budget behavior: a single deadline promise races the whole worker pool.
 * When it fires, cells still queued or in flight are filled with timedOutResult
 * so the response is always complete and well-formed — a partial answer, never
 * a 504.
 */
export async function runOneShot(
  input: OneShotInput,
  configuredModels: AgentModel[],
  deps: OneShotDeps = {},
): Promise<Omit<OneShotResponse, "unconfigured_models">> {
  const now = deps.now ?? (() => Date.now());
  const cells: Cell[] = [];
  for (const prompt of input.prompts) {
    for (const model of configuredModels) cells.push({ prompt, model });
  }

  // Result slots preserve input order (prompt-major, then model).
  const results: (OneShotResult | null)[] = new Array(cells.length).fill(null);

  const deadline = now() + ONE_SHOT_TIME_BUDGET_MS;
  let timedOut = false;

  // Bounded worker pool over a shared index — the classic concurrency cap.
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= cells.length) return;
      if (timedOut || now() >= deadline) {
        results[i] = timedOutResult(cells[i]);
        continue;
      }
      results[i] = await runCell(cells[i], input.brandDomain, deps);
    }
  }

  const poolSize = Math.min(ONE_SHOT_CONCURRENCY, cells.length || 1);
  const pool = Array.from({ length: poolSize }, () => worker());

  const budgetMs = Math.max(0, deadline - now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineGuard = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, budgetMs);
  });

  // Whichever finishes first: all workers drain, or the deadline fires. Either
  // way we then fill any still-null slot (in-flight cells the deadline cut off)
  // with a timeout result before returning.
  await Promise.race([Promise.all(pool), deadlineGuard]);
  if (timer) clearTimeout(timer);

  const finalResults: OneShotResult[] = results.map(
    (r, i) => r ?? timedOutResult(cells[i]),
  );

  const mentioned = finalResults.filter((r) => r.brand_mentioned).length;
  const mention_rate = finalResults.length ? mentioned / finalResults.length : 0;

  const share_of_voice = computeShareOfVoice(
    finalResults,
    input.brandDomain,
    input.competitors ?? [],
  );

  const summary: OneShotSummary = {
    mention_rate,
    models_run: configuredModels,
    ...(share_of_voice ? { share_of_voice } : {}),
  };

  return { results: finalResults, summary };
}
