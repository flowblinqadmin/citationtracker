// AI Citation Tracker — recompute + persist a run's metrics
//
// Shared by the Phase 3 worker (on run completion) and the citation-review route
// (when a partial match is confirmed/rejected). Loads everything a run needs,
// runs the pure computeRunMetrics, and writes the aggregate onto tracker.runs.

import { db } from "@/lib/db";
import {
  trackerRuns,
  trackerResponses,
  trackerCitations,
  trackerArticles,
  trackerClients,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { computeRunMetrics, type MetricsResponseRow, type MetricsCitationRow, type MetricsArticleRow } from "@/lib/engine/metrics";
import type { TrackerCompetitor, TrackerRunMetrics } from "@/lib/types/tracker";

/**
 * Recompute the metrics for a run from its stored responses + citations and
 * persist them on the run row. Returns the metrics (or null if the run is gone).
 *
 * `promptVersionIds` (the rate denominator) is taken from the run's distinct
 * response prompt versions — every active prompt version is queried at least
 * once per platform, so this equals the run's prompt count.
 */
export async function recomputeAndStoreRunMetrics(runId: string): Promise<TrackerRunMetrics | null> {
  const [run] = await db.select().from(trackerRuns).where(eq(trackerRuns.id, runId));
  if (!run) return null;

  const responses = await db
    .select({
      promptVersionId: trackerResponses.promptVersionId,
      platform: trackerResponses.platform,
      brandMentioned: trackerResponses.brandMentioned,
      // R04: fetch error so we can exclude errored responses from rate denominators.
      error: trackerResponses.error,
    })
    .from(trackerResponses)
    .where(eq(trackerResponses.runId, runId));

  const citations = await db
    .select({
      promptVersionId: trackerCitations.promptVersionId,
      platform: trackerCitations.platform,
      matchType: trackerCitations.matchType,
      reviewStatus: trackerCitations.reviewStatus,
      articleId: trackerCitations.articleId,
      competitorDomain: trackerCitations.competitorDomain,
    })
    .from(trackerCitations)
    .where(eq(trackerCitations.runId, runId));

  const articles = await db
    .select({
      id: trackerArticles.id,
      url: trackerArticles.url,
      outlet: trackerArticles.outlet,
      headline: trackerArticles.headline,
      publishedAt: trackerArticles.publishedAt,
    })
    .from(trackerArticles)
    .where(eq(trackerArticles.clientId, run.clientId));

  const [client] = await db
    .select({ competitors: trackerClients.competitors })
    .from(trackerClients)
    .where(eq(trackerClients.id, run.clientId));
  const competitors: TrackerCompetitor[] = client?.competitors ?? [];

  // R04: Exclude errored responses from the rate denominator. A provider outage
  // inserts rows with error != null and brandMentioned=false / no citations. If we
  // counted those, a full-platform outage would fabricate a 0% rate instead of
  // signalling a data gap. Only successfully-measured prompt versions contribute to
  // the denominator, so a genuine 0% (model truly doesn't cite you) is
  // distinguishable from a 0% caused by an API error.
  const successfulResponses = responses.filter((r) => !r.error);

  // Distinct prompt versions with at least one successful response = rate denominator.
  const derivedPvIds = [...new Set(successfulResponses.map((r) => r.promptVersionId))];

  // R10: After the 12-month response-body retention purge, trackerResponses rows are
  // hard-deleted but trackerCitations and the run row itself survive. If we recompute
  // after purge (e.g. a late citation-review PATCH) `derivedPvIds` is empty and we
  // would overwrite the run's metrics with all-zero rates. Guard by falling back to
  // the authoritative `run.promptsTotal` stored at run creation: synthesise placeholder
  // IDs of the correct count so computeRunMetrics sees the right denominator.
  // Two distinct "empty derivedPvIds" cases must NOT be conflated:
  //  - responses purged (responses.length === 0): R10 — preserve the denominator
  //    from the authoritative run.promptsTotal so a late recompute (e.g. a
  //    citation-review PATCH past the 12-month retention) doesn't zero history.
  //  - responses exist but ALL errored (responses.length > 0): R04 — provider
  //    outage is a DATA GAP, not a measured 0%. Empty denominator → promptsTotal=0
  //    so "couldn't measure" is distinguishable from a genuine 0% citation rate.
  const promptVersionIds =
    derivedPvIds.length > 0
      ? derivedPvIds
      : responses.length === 0
        ? Array.from({ length: run.promptsTotal ?? 0 }, (_, i) => `__purged_${i}`)
        : [];

  // Break down by the platforms this run actually queried (team-org runs
  // include anthropic; PCG runs stay at the three launch platforms).
  const runPlatforms = [...new Set(responses.map((r) => r.platform))];

  const metrics = computeRunMetrics({
    ...(runPlatforms.length > 0 ? { platforms: runPlatforms } : {}),
    promptVersionIds,
    // Pass only successful responses so errored rows don't inflate brand-mention
    // numerators with spurious false values.
    responses: successfulResponses as MetricsResponseRow[],
    citations: citations as MetricsCitationRow[],
    articles: articles as MetricsArticleRow[],
    competitors,
    period: run.period,
  });

  await db.update(trackerRuns).set({ metrics }).where(eq(trackerRuns.id, runId));
  return metrics;
}
