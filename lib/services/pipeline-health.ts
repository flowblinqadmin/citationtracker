import { db } from "@/lib/db";
import {
  pipelineHealthState,
  geoSites,
  firecrawlJobs,
  citationCheckResponses,
  citationCheckScores,
  type NewPipelineHealthState,
} from "@/lib/db/schema";
import { sendInternalPipelineHealthAlert, type PipelineHealthCategory } from "@/lib/email";
import { and, eq, gte, lt, sql } from "drizzle-orm";

// Cooldown — don't re-alert on the same key inside this window. Set per-category
// so a daily-cadence problem (provider key rotation) doesn't spam, but a
// fast-moving problem (no scores in 6h) still gets re-flagged if it persists.
const COOLDOWN_MS: Record<PipelineHealthCategory, number> = {
  provider: 12 * 60 * 60 * 1000, // 12h
  "audit-stuck": 24 * 60 * 60 * 1000, // 24h per site
  "all-quiet": 6 * 60 * 60 * 1000, // 6h
};

// Window for "audit-stuck": only complain about sites within this age band.
// Lower bound prevents false positives on audits still in flight; upper bound
// prevents re-alerting on long-known broken sites.
const AUDIT_STUCK_MIN_AGE_MS = 30 * 60 * 1000;
const AUDIT_STUCK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// All-quiet threshold — if no citation_check_scores rows in this window, alert.
const ALL_QUIET_THRESHOLD_MS = 6 * 60 * 60 * 1000;

export interface PipelineHealthRunResult {
  providersChecked: number;
  providersFailed: string[];
  stuckSites: Array<{ siteId: string; domain: string }>;
  allQuiet: boolean;
  alertsSent: number;
  alertsSuppressed: number;
}

interface AlertableEvent {
  key: string;
  category: PipelineHealthCategory;
  severity: "warn" | "critical";
  summary: string;
  details: Array<[string, string]>;
}

/**
 * Dedupe gate. Returns true if we should fire the alert (and records the
 * timestamp); false if we're still in the cooldown window for this key.
 *
 * Uses an upsert with a conditional update so the check and the write happen
 * in a single round-trip — two cron instances firing at once can't both
 * decide to send the same alert.
 */
async function shouldAlert(
  key: string,
  cooldownMs: number,
  payload: unknown,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - cooldownMs);
  const row: NewPipelineHealthState = {
    key,
    lastAlertedAt: new Date(),
    payload: payload as NewPipelineHealthState["payload"],
  };
  // Upsert; only update last_alerted_at when the existing row is older than
  // the cooldown cutoff. Returning rows means the update fired -> alert.
  const updated = await db
    .insert(pipelineHealthState)
    .values(row)
    .onConflictDoUpdate({
      target: pipelineHealthState.key,
      set: { lastAlertedAt: row.lastAlertedAt, payload: row.payload },
      where: lt(pipelineHealthState.lastAlertedAt, cutoff),
    })
    .returning({ key: pipelineHealthState.key });
  return updated.length > 0;
}

// ── Provider health probe ───────────────────────────────────────────────────

interface ProviderProbeResult {
  name: string;
  ok: boolean;
  status?: number;
  error?: string;
}

async function probeOpenAI(): Promise<ProviderProbeResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { name: "openai", ok: false, error: "OPENAI_API_KEY not set" };
  try {
    const r = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    return { name: "openai", ok: r.ok, status: r.status, error: r.ok ? undefined : await r.text() };
  } catch (e) {
    return { name: "openai", ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function probeAnthropic(): Promise<ProviderProbeResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { name: "anthropic", ok: false, error: "ANTHROPIC_API_KEY not set" };
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 4,
        messages: [{ role: "user", content: "ok" }],
      }),
    });
    return { name: "anthropic", ok: r.ok, status: r.status, error: r.ok ? undefined : await r.text() };
  } catch (e) {
    return { name: "anthropic", ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function probePerplexity(): Promise<ProviderProbeResult> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return { name: "perplexity", ok: false, error: "PERPLEXITY_API_KEY not set" };
  try {
    const r = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar",
        max_tokens: 16,
        messages: [{ role: "user", content: "ok" }],
      }),
    });
    return { name: "perplexity", ok: r.ok, status: r.status, error: r.ok ? undefined : await r.text() };
  } catch (e) {
    return { name: "perplexity", ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function probeGoogle(): Promise<ProviderProbeResult> {
  const key =
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    process.env.GOOGLE_API_KEY;
  if (!key) return { name: "google", ok: false, error: "GEMINI_API_KEY not set" };
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
    );
    return { name: "google", ok: r.ok, status: r.status, error: r.ok ? undefined : await r.text() };
  } catch (e) {
    return { name: "google", ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function checkProviders(): Promise<{
  results: ProviderProbeResult[];
  events: AlertableEvent[];
}> {
  const results = await Promise.all([
    probeOpenAI(),
    probeAnthropic(),
    probePerplexity(),
    probeGoogle(),
  ]);

  const events: AlertableEvent[] = results
    .filter((r) => !r.ok)
    .map((r) => ({
      key: `provider:${r.name}`,
      category: "provider",
      severity: "critical",
      summary: `${r.name} API failing (${r.status ?? "no response"})`,
      details: [
        ["Provider", r.name],
        ["Status", r.status ? String(r.status) : "no response"],
        ["Error", (r.error ?? "unknown").slice(0, 400)],
      ],
    }));

  return { results, events };
}

// ── Audit-stuck checker ─────────────────────────────────────────────────────

export async function checkStuckAudits(): Promise<{
  stuck: Array<{ siteId: string; domain: string; createdAt: Date }>;
  events: AlertableEvent[];
}> {
  const now = Date.now();
  // postgres-js doesn't bind Date params for parameterized template SQL —
  // pass ISO strings and let the server cast.
  const minCreatedAt = new Date(now - AUDIT_STUCK_MAX_AGE_MS).toISOString();
  const maxCreatedAt = new Date(now - AUDIT_STUCK_MIN_AGE_MS).toISOString();

  // Sites in the age band that have at least one completed firecrawl job but
  // zero citation_check_responses. Pulled as a single query with EXISTS /
  // NOT EXISTS subqueries.
  //
  // Free-tier gate: citation check only auto-fires for paid audits
  // (audit-purchase-finalize stage in app/api/pipeline/stage/route.ts).
  // Free signups intentionally never get a citation phase, so we exclude
  // them here — flagging them would be a permanent false positive. A site
  // counts as paid if either (a) its team is on a non-free subscription
  // tier, or (b) it has any audit_purchases row (one-off paid audits).
  const stuck = await db.execute<{
    site_id: string;
    domain: string;
    created_at: string;
  }>(sql`
    SELECT g.id AS site_id, g.domain, g.created_at
    FROM geo_sites g
    WHERE g.created_at >= ${minCreatedAt}::timestamptz
      AND g.created_at <= ${maxCreatedAt}::timestamptz
      AND (
        EXISTS (
          SELECT 1 FROM teams t
          WHERE t.id = g.team_id AND t.subscription_tier <> 'free'
        )
        OR EXISTS (
          SELECT 1 FROM audit_purchases ap
          WHERE ap.site_id = g.id
        )
      )
      AND EXISTS (
        SELECT 1 FROM firecrawl_jobs f
        WHERE f.site_id = g.id AND f.status = 'completed'
      )
      AND NOT EXISTS (
        SELECT 1 FROM citation_check_responses c
        WHERE c.site_id = g.id
      )
    ORDER BY g.created_at DESC
    LIMIT 50
  `);

  const rows = (stuck as unknown as { rows?: Array<{ site_id: string; domain: string; created_at: string }> }).rows
    ?? (stuck as unknown as Array<{ site_id: string; domain: string; created_at: string }>);

  const stuckList = rows.map((r) => ({
    siteId: r.site_id,
    domain: r.domain,
    createdAt: new Date(r.created_at),
  }));

  const events: AlertableEvent[] = stuckList.map((s) => ({
    key: `audit-stuck:${s.siteId}`,
    category: "audit-stuck",
    severity: "warn",
    summary: `${s.domain} — crawl done, citation phase never ran`,
    details: [
      ["Site ID", s.siteId],
      ["Domain", s.domain],
      ["Created", s.createdAt.toISOString()],
      ["Age", `${Math.round((now - s.createdAt.getTime()) / 60000)} min`],
    ],
  }));

  return { stuck: stuckList, events };
}

// ── All-quiet detector ──────────────────────────────────────────────────────

export async function checkAllQuiet(): Promise<{
  allQuiet: boolean;
  lastScoreAt: Date | null;
  events: AlertableEvent[];
}> {
  const threshold = new Date(Date.now() - ALL_QUIET_THRESHOLD_MS);

  const recent = await db
    .select({ createdAt: citationCheckScores.createdAt })
    .from(citationCheckScores)
    .where(gte(citationCheckScores.createdAt, threshold))
    .limit(1);

  if (recent.length > 0) {
    return { allQuiet: false, lastScoreAt: recent[0].createdAt ?? null, events: [] };
  }

  // No recent scores. Find the most recent one (could be days/weeks old) for context.
  const latest = await db
    .select({ createdAt: citationCheckScores.createdAt, domain: citationCheckScores.domain })
    .from(citationCheckScores)
    .orderBy(sql`${citationCheckScores.createdAt} DESC NULLS LAST`)
    .limit(1);

  const lastScoreAt = latest[0]?.createdAt ?? null;
  const lastDomain = latest[0]?.domain ?? "(none)";
  const hoursAgo = lastScoreAt
    ? Math.round((Date.now() - new Date(lastScoreAt).getTime()) / (60 * 60 * 1000))
    : null;

  const events: AlertableEvent[] = [
    {
      key: "all-quiet",
      category: "all-quiet",
      severity: "critical",
      summary: lastScoreAt
        ? `No citation scores in ${hoursAgo}h — last: ${lastDomain}`
        : `No citation scores ever recorded`,
      details: [
        ["Threshold", `${ALL_QUIET_THRESHOLD_MS / (60 * 60 * 1000)}h`],
        ["Last score at", lastScoreAt ? new Date(lastScoreAt).toISOString() : "never"],
        ["Last scored domain", lastDomain],
      ],
    },
  ];

  return { allQuiet: true, lastScoreAt, events };
}

// ── Runner ──────────────────────────────────────────────────────────────────

export async function runPipelineHealthChecks(): Promise<PipelineHealthRunResult> {
  const [providerCheck, stuckCheck, quietCheck] = await Promise.all([
    checkProviders(),
    checkStuckAudits(),
    checkAllQuiet(),
  ]);

  const allEvents: AlertableEvent[] = [
    ...providerCheck.events,
    ...stuckCheck.events,
    ...quietCheck.events,
  ];

  let alertsSent = 0;
  let alertsSuppressed = 0;

  for (const ev of allEvents) {
    const fire = await shouldAlert(ev.key, COOLDOWN_MS[ev.category], {
      severity: ev.severity,
      summary: ev.summary,
    });
    if (!fire) {
      alertsSuppressed++;
      continue;
    }
    await sendInternalPipelineHealthAlert({
      severity: ev.severity,
      category: ev.category,
      summary: ev.summary,
      details: ev.details,
    });
    alertsSent++;
  }

  return {
    providersChecked: providerCheck.results.length,
    providersFailed: providerCheck.results.filter((r) => !r.ok).map((r) => r.name),
    stuckSites: stuckCheck.stuck.map((s) => ({ siteId: s.siteId, domain: s.domain })),
    allQuiet: quietCheck.allQuiet,
    alertsSent,
    alertsSuppressed,
  };
}

// Exported for tests to suppress real network calls if needed
export const __test = {
  COOLDOWN_MS,
  AUDIT_STUCK_MIN_AGE_MS,
  AUDIT_STUCK_MAX_AGE_MS,
  ALL_QUIET_THRESHOLD_MS,
};
