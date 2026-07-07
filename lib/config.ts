// Service configuration — single source of truth for magic numbers.

/** Deployed geo origin — login and buy-credits live there. */
export const GEO_ORIGIN = process.env.GEO_ORIGIN ?? "https://geo.flowblinq.com";

// ── Tracker engine (ported from geo — values must match geo's until its
// tracker is deleted, so a run started by one side resumes identically on the
// other during the transition window) ────────────────────────────────────────

/** Base platforms; team_* org runs add anthropic via platformsForOrg(). */
export const TRACKER_PLATFORMS = ["perplexity", "openai", "google"] as const;
export const TRACKER_RETENTION_MONTHS = 12;        // full response text retained 12 months
export const TRACKER_BATCH_SIZE = 10;              // parallel (promptVersion × platform) queries per batch
export const TRACKER_BATCH_DELAY_MS = 100;         // ms between batches (R31: avoid provider 429s)
export const TRACKER_MAX_TOKENS = 1024;            // full response text is stored, not just a list
export const TRACKER_STALE_RUN_HOURS = 2;          // a 'running' run older than this is re-enqueued by cron

/**
 * Worker time budget. The route exports `maxDuration` as a literal (Next.js
 * requires a statically-analyzable value) — keep it equal to this constant.
 * The runner re-enqueues its cursor before the deadline.
 */
const WORKER_MAX_DURATION_S = 800;
export const TRACKER_WORKER_DEADLINE_MS = (WORKER_MAX_DURATION_S - 15) * 1000;

/**
 * Public base URL of THIS service (direct Vercel URL incl. basePath — NOT the
 * geo rewrite; geo must never sit in the execution loop). QStash signs and
 * verifies against this exact URL.
 */
export const CITATIONS_WORKER_BASE =
  process.env.CITATIONS_WORKER_BASE ?? "https://citationtracker.vercel.app/citations";
