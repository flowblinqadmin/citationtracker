// AI Citation Tracker — chunked run execution
//
// Submits a client's active prompt library (verbatim) to each platform, captures
// full responses + cited URLs, matches the URLs to the client's article list,
// and persists responses + citations. Designed to resume: it skips
// (promptVersion × platform) pairs already persisted for the run, and re-enqueues
// itself with a cursor when it approaches the worker's time budget.
//
// Reproducibility rule (PCG brief): if a prompt returns NO citations on the first
// attempt, it is re-run once; both attempts are stored. Metrics read whichever
// attempt produced citations.

import { db } from "@/lib/db";
import {
  trackerRuns,
  trackerResponses,
  trackerCitations,
  trackerArticles,
  trackerClients,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  queryOpenAI,
  queryPerplexity,
  queryGoogle,
  queryAnthropic,
  MODELS,
  type ProviderQueryResult,
} from "@/lib/engine/providers";
import {
  buildMatchContext,
  matchCitation,
  resolveRedirects,
  isBrandMentioned,
} from "@/lib/engine/url-matcher";
import { getActivePromptVersions, type ActivePromptVersion } from "@/lib/engine/run-create";
import { recomputeAndStoreRunMetrics } from "@/lib/engine/run-metrics";
import {
  TRACKER_PLATFORMS,
  TRACKER_BATCH_SIZE,
  TRACKER_BATCH_DELAY_MS,
  TRACKER_MAX_TOKENS,
} from "@/lib/config";
import type { TrackerPlatform, TrackerRunScope, TrackerSentiment } from "@/lib/types/tracker";
import { classifyBrandSentiment } from "@/lib/engine/sentiment";

const QUERY_FNS: Record<TrackerPlatform, (p: string, o?: { systemPrompt?: string | null; maxTokens?: number }) => Promise<ProviderQueryResult>> = {
  perplexity: queryPerplexity,
  openai: queryOpenAI,
  google: queryGoogle,
  anthropic: queryAnthropic,
};

const MODEL_FOR: Record<TrackerPlatform, string> = {
  perplexity: MODELS.perplexity,
  openai: MODELS.openai,
  google: MODELS.google,
  anthropic: MODELS.anthropic,
};

/**
 * Team-org (citations microservice) runs also query Claude; PCG's fixed
 * three-platform methodology is unchanged.
 */
export function platformsForOrg(orgId: string | undefined): TrackerPlatform[] {
  return orgId?.startsWith("team_") ? [...TRACKER_PLATFORMS, "anthropic"] : [...TRACKER_PLATFORMS];
}

export interface RunChunkResult {
  status: "complete" | "paused" | "skipped";
  cursor: number;       // next cursor if paused
  processed: number;    // work items processed this invocation
}

type QueryFn = (p: string, o?: { systemPrompt?: string | null; maxTokens?: number }) => Promise<ProviderQueryResult>;

/**
 * Injectable dependencies — defaults are the real provider clients + redirect
 * resolver. Tests inject deterministic mocks to exercise the engine without
 * external API calls.
 */
export interface RunnerDeps {
  queryFns?: Partial<Record<TrackerPlatform, QueryFn>>;
  resolveRedirectsFn?: typeof resolveRedirects;
  classifySentimentFn?: typeof classifyBrandSentiment;
}

export interface WorkItem {
  pv: ActivePromptVersion;
  platform: TrackerPlatform;
}

/**
 * R17: Resume state for a (promptVersionId, platform) pair.
 * - maxAttempt: the highest attempt number already persisted
 * - attempt1HadCitations: true when attempt-1 returned at least one URL
 *
 * Skip rules:
 *  - attempt1HadCitations → fully done (no re-run needed)
 *  - maxAttempt >= 2        → both attempts recorded, done
 *  - maxAttempt === 1 && !attempt1HadCitations → attempt-2 still needed
 */
interface DoneState {
  maxAttempt: number;
  attempt1HadCitations: boolean;
}

/**
 * Deterministic worklist: prompt versions × platforms, stable order. An
 * optional scope narrows it to a subset of versions and/or platforms
 * (citations microservice single-prompt / single-platform runs); empty scope
 * arrays are ignored so a malformed scope can never empty a run.
 */
export function buildWorklist(
  promptVersions: ActivePromptVersion[],
  scope?: TrackerRunScope | null,
  basePlatforms: readonly TrackerPlatform[] = TRACKER_PLATFORMS,
): WorkItem[] {
  const versionFilter = scope?.promptVersionIds?.length ? new Set(scope.promptVersionIds) : null;
  const platforms = scope?.platforms?.length
    ? basePlatforms.filter((p) => scope.platforms!.includes(p))
    : basePlatforms;
  const sorted = promptVersions
    .filter((pv) => !versionFilter || versionFilter.has(pv.promptVersionId))
    .sort((a, b) =>
      a.promptVersionId < b.promptVersionId ? -1 : a.promptVersionId > b.promptVersionId ? 1 : 0,
    );
  const out: WorkItem[] = [];
  for (const pv of sorted) {
    for (const platform of platforms.length ? platforms : basePlatforms) out.push({ pv, platform });
  }
  return out;
}

/**
 * Execute (or resume) a run. Returns when complete or when the deadline forces a
 * pause (the caller re-enqueues with the returned cursor).
 *
 * @param deadlineEpochMs absolute time (Date.now()-based) to stop before.
 */
export async function executeTrackerRun(
  runId: string,
  clientId: string,
  startCursor: number,
  deadlineEpochMs: number,
  now: () => number = () => Date.now(),
  deps: RunnerDeps = {},
): Promise<RunChunkResult> {
  const [run] = await db.select().from(trackerRuns).where(eq(trackerRuns.id, runId));
  if (!run || run.status === "complete" || run.status === "failed") {
    return { status: "skipped", cursor: startCursor, processed: 0 };
  }

  // Mark running (idempotent) + stamp startedAt once.
  await db
    .update(trackerRuns)
    .set({ status: "running", startedAt: run.startedAt ?? new Date() })
    .where(eq(trackerRuns.id, runId));

  const [client] = await db.select().from(trackerClients).where(eq(trackerClients.id, clientId));
  const promptVersions = await getActivePromptVersions(clientId);
  const worklist = buildWorklist(promptVersions, run.scope, platformsForOrg(client?.orgId));

  // Build the match context from the client's articles + competitor domains.
  const articles = await db
    .select({ id: trackerArticles.id, normalizedUrl: trackerArticles.normalizedUrl })
    .from(trackerArticles)
    .where(eq(trackerArticles.clientId, clientId));
  const competitorDomains = (client?.competitors ?? []).map((c) => c.domain);
  const matchCtx = buildMatchContext(articles, competitorDomains);
  const redirectCache = new Map<string, string>();

  // R17: Resume idempotency — build an attempt-aware map of (pvId|platform) state.
  // We need `attempt` and `citedUrls` to determine whether attempt-2 is still needed.
  const existing = await db
    .select({
      promptVersionId: trackerResponses.promptVersionId,
      platform: trackerResponses.platform,
      attempt: trackerResponses.attempt,
      citedUrls: trackerResponses.citedUrls,
    })
    .from(trackerResponses)
    .where(eq(trackerResponses.runId, runId));

  const donePairs = new Map<string, DoneState>();
  for (const e of existing) {
    const key = `${e.promptVersionId}|${e.platform}`;
    const prev = donePairs.get(key);
    const attempt1HadCitations =
      (prev?.attempt1HadCitations ?? false) ||
      (e.attempt === 1 && (e.citedUrls?.length ?? 0) > 0);
    const maxAttempt = Math.max(prev?.maxAttempt ?? 0, e.attempt);
    donePairs.set(key, { maxAttempt, attempt1HadCitations });
  }

  const modelsUsed: Record<string, string> = { ...(run.modelsUsed ?? {}) };
  let processed = 0;

  for (let i = startCursor; i < worklist.length; i += TRACKER_BATCH_SIZE) {
    if (now() >= deadlineEpochMs) {
      return { status: "paused", cursor: i, processed };
    }
    const batch = worklist.slice(i, i + TRACKER_BATCH_SIZE);
    await Promise.all(
      batch.map(async (item) => {
        const key = `${item.pv.promptVersionId}|${item.platform}`;
        const state = donePairs.get(key);

        // R17: fully done when attempt-1 had citations OR both attempts are recorded.
        if (state && (state.attempt1HadCitations || state.maxAttempt >= 2)) return;

        modelsUsed[item.platform] = MODEL_FOR[item.platform];

        // R17: if attempt-1 already ran with 0 citations, skip straight to attempt-2.
        const startAttempt = state?.maxAttempt === 1 ? 2 : 1;
        await processWorkItem(runId, clientId, client, item, matchCtx, redirectCache, deps, startAttempt);
        processed++;
      }),
    );

    // R31: throttle between batches to avoid 429s on provider APIs.
    if (i + TRACKER_BATCH_SIZE < worklist.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, TRACKER_BATCH_DELAY_MS));
    }
  }

  // R12: Mark complete BEFORE attempting metrics recompute so that a transient
  // metrics failure never leaves the run stuck in a non-recoverable "failed"
  // state when all citations are already persisted.
  await db
    .update(trackerRuns)
    .set({ status: "complete", completedAt: new Date(), cursor: worklist.length, modelsUsed })
    .where(eq(trackerRuns.id, runId));

  // R12: Wrap metrics recompute in its own try/catch. A transient failure here
  // is recoverable (the run is already "complete"; the cron / a manual re-invoke
  // can call recomputeAndStoreRunMetrics again).
  try {
    await recomputeAndStoreRunMetrics(runId);
  } catch (metricsErr) {
    console.error(
      "[tracker/runner] metrics recompute failed (run marked complete — recompute manually):",
      runId,
      metricsErr,
    );
  }

  return { status: "complete", cursor: worklist.length, processed };
}

/**
 * Anti-hallucination grounding for the citations microservice's runs: the
 * models were citing real pages about OTHER similarly-named products, and
 * constructing plausible-looking URLs from memory. PCG's runs keep a NULL
 * system prompt on purpose — they MEASURE natural platform behavior.
 */
export const GROUNDED_CITATION_SYSTEM_PROMPT =
  "When citing sources: only cite URLs that your web search actually returned. " +
  "Never construct, guess, or pattern-match a URL from memory. " +
  "If you cannot find a source that genuinely supports a claim, say you found no source rather than citing one. " +
  "Only discuss the specific brand or company named in the question — do not substitute information about similarly named products.";

/** Grounded prompts for team_* orgs only; PCG measurement runs stay untouched. */
export function systemPromptForOrg(orgId: string | undefined): string | null {
  return orgId?.startsWith("team_") ? GROUNDED_CITATION_SYSTEM_PROMPT : null;
}

/**
 * Query one (promptVersion × platform), apply re-run-once, persist response + citations.
 *
 * @param startAttempt  R17: pass 2 when attempt-1 is already persisted with 0 citations.
 */
async function processWorkItem(
  runId: string,
  clientId: string,
  client: { orgId: string; name: string; domain: string | null; brandKeywords: any } | undefined,
  item: WorkItem,
  matchCtx: ReturnType<typeof buildMatchContext>,
  redirectCache: Map<string, string>,
  deps: RunnerDeps,
  startAttempt: 1 | 2 = 1,
): Promise<void> {
  const queryFn = deps.queryFns?.[item.platform] ?? QUERY_FNS[item.platform];
  const opts = { systemPrompt: systemPromptForOrg(client?.orgId), maxTokens: TRACKER_MAX_TOKENS };

  if (startAttempt === 1) {
    const attempt1 = await runOneAttempt(runId, clientId, client, item, 1, queryFn, opts, matchCtx, redirectCache, deps);

    // Re-run once if the first attempt succeeded but returned NO citations.
    if (!attempt1.error && attempt1.citedCount === 0) {
      await runOneAttempt(runId, clientId, client, item, 2, queryFn, opts, matchCtx, redirectCache, deps);
    }
  } else {
    // R17: attempt-1 already persisted with 0 citations — run attempt-2 only.
    await runOneAttempt(runId, clientId, client, item, 2, queryFn, opts, matchCtx, redirectCache, deps);
  }
}

async function runOneAttempt(
  runId: string,
  clientId: string,
  client: { orgId: string; name: string; domain: string | null; brandKeywords: any } | undefined,
  item: WorkItem,
  attempt: number,
  queryFn: (p: string, o?: { systemPrompt?: string | null; maxTokens?: number }) => Promise<ProviderQueryResult>,
  opts: { systemPrompt: string | null; maxTokens: number },
  matchCtx: ReturnType<typeof buildMatchContext>,
  redirectCache: Map<string, string>,
  deps: RunnerDeps,
): Promise<{ error: boolean; citedCount: number }> {
  let result: ProviderQueryResult;
  let error: string | null = null;
  try {
    result = await queryFn(item.pv.text, opts);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    result = { text: "", responseTimeMs: 0, citedUrls: [] };
  }

  const brandMentioned = isBrandMentioned(result.text, client?.domain ?? null, client?.brandKeywords ?? undefined);

  // Sentiment: only for the citations microservice's tenants (team_* orgs) so
  // PCG's runs keep their existing cost/latency profile. Best-effort — null on
  // any classification failure.
  let sentiment: TrackerSentiment | null = null;
  if (!error && brandMentioned && client?.orgId?.startsWith("team_")) {
    const classify = deps.classifySentimentFn ?? classifyBrandSentiment;
    sentiment = await classify(client.name, result.text);
  }

  const responseId = `trr_${nanoid()}`;

  // R28: Wrap the response insert + all citation inserts in a single transaction.
  // If the citation loop throws, the response row is rolled back too — so donePairs
  // won't see a stale response on the next resume, and the item will be retried.
  // The response-level unique constraint (tracker_responses_run_pv_platform_attempt_uniq)
  // provides idempotency: if the response already exists the onConflictDoNothing
  // returns 0 rows and the entire unit is skipped.
  const citedCount = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(trackerResponses)
      .values({
        id: responseId,
        runId,
        clientId,
        promptVersionId: item.pv.promptVersionId,
        platform: item.platform,
        model: MODEL_FOR[item.platform],
        attempt,
        responseText: result.text,
        citedUrls: result.citedUrls,
        brandMentioned,
        sentiment,
        responseTimeMs: result.responseTimeMs,
        error,
      })
      .onConflictDoNothing()
      .returning({ id: trackerResponses.id });

    // If a concurrent/retry insert already wrote this attempt, don't duplicate citations.
    if (inserted.length === 0) return result.citedUrls.length;

    // Resolve + match each cited URL, persist citation rows.
    const resolveFn = deps.resolveRedirectsFn ?? resolveRedirects;
    for (const rawUrl of result.citedUrls) {
      const resolved = await resolveFn(rawUrl, { cache: redirectCache });
      const m = matchCitation(resolved, matchCtx);
      await tx.insert(trackerCitations).values({
        id: `trc_${nanoid()}`,
        responseId,
        runId,
        clientId,
        promptVersionId: item.pv.promptVersionId,
        platform: item.platform,
        rawUrl,
        resolvedUrl: resolved === rawUrl ? null : resolved,
        normalizedUrl: m.normalizedUrl ?? rawUrl,
        domain: m.domain ?? "",
        matchType: m.matchType,
        articleId: m.articleId,
        competitorDomain: m.competitorDomain,
        reviewStatus: m.matchType === "partial" ? "pending" : null,
      });
    }

    return result.citedUrls.length;
  });

  return { error: !!error, citedCount };
}

/** Mark a run failed with an error message (used by the worker on fatal errors). */
export async function failRun(runId: string, message: string): Promise<void> {
  await db
    .update(trackerRuns)
    .set({ status: "failed", error: message.slice(0, 500), completedAt: new Date() })
    .where(eq(trackerRuns.id, runId));
}
