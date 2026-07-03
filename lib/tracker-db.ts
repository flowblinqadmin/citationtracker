// The ONLY module allowed to touch tracker.* tables (grep gate in tests).
//
// Tenancy: one tracker.orgs row per geo team, id `team_<teamId>` — NO
// tracker.members rows, ever (members would grant access to geo's PCG tracker
// UI/routes; see CLAUDE.md geo contract). PCG's live data shares these tables,
// so every read and write here is scoped through the team's org id.
import { db } from "@/lib/db";
import {
  trackerOrgs,
  trackerClients,
  trackerPrompts,
  trackerPromptVersions,
  trackerRuns,
  trackerResponses,
  trackerCitations,
  type TrackerClient,
  type TrackerRun,
} from "@/lib/db/schema";
import type {
  TrackerCompetitor,
  TrackerPlatform,
  TrackerPromptCategory,
  TrackerRunFrequency,
  TrackerRunScope,
} from "@/lib/types/tracker";
import { and, asc, desc, eq, gte, inArray, like, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

const MAX_ACTIVE_PROMPTS = 30;
export const MAX_PROMPT_LENGTH = 500; // input tokens are user-controlled cost — bounded for flat pricing

const orgIdForTeam = (teamId: string) => `team_${teamId}`;

/** Get-or-create the team's org. Deterministic id makes this race-safe. */
export async function ensureOrgForTeam(teamId: string, teamName: string): Promise<string> {
  const orgId = orgIdForTeam(teamId);
  await db
    .insert(trackerOrgs)
    .values({ id: orgId, name: teamName })
    .onConflictDoNothing({ target: trackerOrgs.id });
  return orgId;
}

// ── Brands (tracker.clients scoped to the team's org) ───────────────────────

export interface BrandInput {
  name: string;
  domain?: string | null;
  competitors?: TrackerCompetitor[];
  runFrequency?: TrackerRunFrequency;
}

/** Mirror of geo's computeNextRunAt semantics (weekly = +7d, monthly = +1mo). */
function nextRunAtFor(frequency: TrackerRunFrequency, now = new Date()): Date | null {
  if (frequency === "manual") return null;
  const next = new Date(now);
  if (frequency === "weekly") next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

/** Brand-mention keywords geo's worker matches against (name + domain stem). */
function brandKeywordsFor(name: string, domain?: string | null) {
  const keywords = [name];
  const stem = domain?.replace(/^www\./, "").split(".")[0];
  if (stem && stem.toLowerCase() !== name.toLowerCase()) keywords.push(stem);
  return { keywords: keywords.sort((a, b) => b.length - a.length), isAmbiguous: false, source: "manual" as const };
}

export function listBrands(teamId: string): Promise<TrackerClient[]> {
  return db
    .select()
    .from(trackerClients)
    .where(eq(trackerClients.orgId, orgIdForTeam(teamId)))
    .orderBy(asc(trackerClients.createdAt));
}

export async function createBrand(teamId: string, teamName: string, input: BrandInput): Promise<TrackerClient> {
  const orgId = await ensureOrgForTeam(teamId, teamName);
  const frequency = input.runFrequency ?? "monthly";
  const [brand] = await db
    .insert(trackerClients)
    .values({
      id: `tc_${nanoid()}`,
      orgId,
      name: input.name,
      domain: input.domain ?? null,
      brandKeywords: brandKeywordsFor(input.name, input.domain),
      competitors: input.competitors ?? [],
      runFrequency: frequency,
      nextRunAt: nextRunAtFor(frequency),
      shareToken: nanoid(24),
    })
    .returning();
  return brand;
}

export async function getBrand(teamId: string, clientId: string): Promise<TrackerClient | null> {
  const [brand] = await db
    .select()
    .from(trackerClients)
    .where(and(eq(trackerClients.id, clientId), eq(trackerClients.orgId, orgIdForTeam(teamId))));
  return brand ?? null;
}

export async function updateBrand(
  teamId: string,
  clientId: string,
  patch: Partial<BrandInput>,
): Promise<TrackerClient | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.domain !== undefined) set.domain = patch.domain;
  if (patch.competitors !== undefined) set.competitors = patch.competitors;
  if (patch.name !== undefined || patch.domain !== undefined) {
    const current = await getBrand(teamId, clientId);
    if (!current) return null;
    set.brandKeywords = brandKeywordsFor(patch.name ?? current.name, patch.domain ?? current.domain);
  }
  if (patch.runFrequency !== undefined) {
    set.runFrequency = patch.runFrequency;
    set.nextRunAt = nextRunAtFor(patch.runFrequency);
  }
  const [updated] = await db
    .update(trackerClients)
    .set(set)
    .where(and(eq(trackerClients.id, clientId), eq(trackerClients.orgId, orgIdForTeam(teamId))))
    .returning();
  return updated ?? null;
}

export async function deleteBrand(teamId: string, clientId: string): Promise<boolean> {
  const deleted = await db
    .delete(trackerClients)
    .where(and(eq(trackerClients.id, clientId), eq(trackerClients.orgId, orgIdForTeam(teamId))))
    .returning({ id: trackerClients.id });
  return deleted.length > 0;
}

// ── Prompts (identity + immutable versions, geo's model) ────────────────────

export interface PromptWithText {
  promptId: string;
  name: string;
  category: TrackerPromptCategory;
  version: number;
  text: string;
}

async function requireBrand(teamId: string, clientId: string): Promise<TrackerClient> {
  const brand = await getBrand(teamId, clientId);
  if (!brand) throw new Error(`Brand not found: ${clientId}`);
  return brand;
}

function assertPromptText(text: string): void {
  if (text.length === 0 || text.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Prompt text must be 1–${MAX_PROMPT_LENGTH} characters`);
  }
}

export async function listPrompts(teamId: string, clientId: string): Promise<PromptWithText[]> {
  const brand = await getBrand(teamId, clientId);
  if (!brand) return [];
  const prompts = await db
    .select()
    .from(trackerPrompts)
    .where(and(eq(trackerPrompts.clientId, clientId), eq(trackerPrompts.status, "active")))
    .orderBy(asc(trackerPrompts.createdAt));
  if (prompts.length === 0) return [];
  const versions = await db
    .select()
    .from(trackerPromptVersions)
    .where(inArray(trackerPromptVersions.promptId, prompts.map((p) => p.id)))
    .orderBy(desc(trackerPromptVersions.version));
  const latest = new Map<string, { version: number; text: string }>();
  for (const v of versions) {
    if (!latest.has(v.promptId)) latest.set(v.promptId, { version: v.version, text: v.text });
  }
  return prompts.map((p) => ({
    promptId: p.id,
    name: p.name,
    category: p.category,
    version: latest.get(p.id)?.version ?? 0,
    text: latest.get(p.id)?.text ?? "",
  }));
}

async function countActivePrompts(clientId: string): Promise<number> {
  const rows = await db
    .select({ id: trackerPrompts.id })
    .from(trackerPrompts)
    .where(and(eq(trackerPrompts.clientId, clientId), eq(trackerPrompts.status, "active")));
  return rows.length;
}

export async function createPrompt(
  teamId: string,
  clientId: string,
  input: { name: string; category: TrackerPromptCategory; text: string },
): Promise<PromptWithText> {
  await requireBrand(teamId, clientId);
  assertPromptText(input.text);
  if ((await countActivePrompts(clientId)) >= MAX_ACTIVE_PROMPTS) {
    throw new Error(`A brand can have at most ${MAX_ACTIVE_PROMPTS} active prompts`);
  }
  const promptId = `tp_${nanoid()}`;
  await db.insert(trackerPrompts).values({ id: promptId, clientId, name: input.name, category: input.category });
  await db.insert(trackerPromptVersions).values({ id: `tpv_${nanoid()}`, promptId, version: 1, text: input.text });
  return { promptId, name: input.name, category: input.category, version: 1, text: input.text };
}

/** Editing text inserts a new immutable version (never mutates prior text). */
export async function updatePromptText(
  teamId: string,
  clientId: string,
  promptId: string,
  text: string,
): Promise<{ version: number } | null> {
  await requireBrand(teamId, clientId);
  assertPromptText(text);
  const [prompt] = await db
    .select()
    .from(trackerPrompts)
    .where(and(eq(trackerPrompts.id, promptId), eq(trackerPrompts.clientId, clientId)));
  if (!prompt) return null;
  const [latest] = await db
    .select({ version: trackerPromptVersions.version })
    .from(trackerPromptVersions)
    .where(eq(trackerPromptVersions.promptId, promptId))
    .orderBy(desc(trackerPromptVersions.version))
    .limit(1);
  const version = (latest?.version ?? 0) + 1;
  await db.insert(trackerPromptVersions).values({ id: `tpv_${nanoid()}`, promptId, version, text });
  return { version };
}

export async function archivePrompt(teamId: string, clientId: string, promptId: string): Promise<boolean> {
  const brand = await getBrand(teamId, clientId);
  if (!brand) return false;
  const updated = await db
    .update(trackerPrompts)
    .set({ status: "archived" })
    .where(and(eq(trackerPrompts.id, promptId), eq(trackerPrompts.clientId, clientId)))
    .returning({ id: trackerPrompts.id });
  return updated.length > 0;
}

// ── Runs ─────────────────────────────────────────────────────────────────────

/** Current calendar month as 'YYYY-MM' (UTC) — geo's period semantics. */
function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function listRuns(teamId: string, clientId: string): Promise<TrackerRun[]> {
  const brand = await getBrand(teamId, clientId);
  if (!brand) return [];
  return db
    .select()
    .from(trackerRuns)
    .where(eq(trackerRuns.clientId, clientId))
    .orderBy(desc(trackerRuns.createdAt))
    .limit(50); // the UI shows recent history; metrics blobs make rows heavy
}

/**
 * Brand-centric citation stats for a run. Geo's stored run.metrics match
 * citations against a PCG-style press-article list this service doesn't use
 * (everything lands "unmatched" → 0s), so citation figures are computed here
 * from tracker.citations by the brand's own domain instead.
 */
export interface RunCitationStats {
  totalCitations: number;      // every cited URL captured for the run
  brandCitations: number;      // citations of the brand's domain (incl. subdomains)
  competitorCitations: number; // citations of named competitor domains
  brandCitationRate: number | null; // fraction of answered replies citing the brand; null without a domain
}

export type RunWithStats = TrackerRun & { citationStats: RunCitationStats };

const stripWww = (domain: string) => domain.trim().toLowerCase().replace(/^www\./, "");

/** `domain = d OR domain LIKE '%.d'` — matches the domain and its subdomains. */
const domainMatch = (column: typeof trackerCitations.domain, domain: string) =>
  sql`(${column} = ${domain} OR ${column} LIKE ${"%." + domain})`;

export async function listRunsWithStats(teamId: string, clientId: string): Promise<RunWithStats[]> {
  const brand = await getBrand(teamId, clientId);
  if (!brand) return [];
  const runs = await listRuns(teamId, clientId);
  if (runs.length === 0) return [];

  const runIds = runs.map((r) => r.id);
  const brandDomain = brand.domain ? stripWww(brand.domain) : null;
  const competitorDomains = (brand.competitors ?? []).map((c) => stripWww(c.domain)).filter(Boolean);

  const brandCond = brandDomain ? domainMatch(trackerCitations.domain, brandDomain) : sql`false`;
  const compCond = competitorDomains.length
    ? sql.join(competitorDomains.map((d) => domainMatch(trackerCitations.domain, d)), sql` OR `)
    : sql`false`;

  const citeRows = await db
    .select({
      runId: trackerCitations.runId,
      total: sql<number>`count(*)::int`,
      brand: sql<number>`count(*) filter (where ${brandCond})::int`,
      competitor: sql<number>`count(*) filter (where (${compCond}))::int`,
      brandPairs: sql<number>`count(distinct (${trackerCitations.promptVersionId}, ${trackerCitations.platform})) filter (where ${brandCond})::int`,
    })
    .from(trackerCitations)
    .where(and(inArray(trackerCitations.runId, runIds), eq(trackerCitations.clientId, clientId)))
    .groupBy(trackerCitations.runId);

  const pairRows = await db
    .select({
      runId: trackerResponses.runId,
      pairs: sql<number>`count(distinct (${trackerResponses.promptVersionId}, ${trackerResponses.platform}))::int`,
    })
    .from(trackerResponses)
    .where(and(inArray(trackerResponses.runId, runIds), eq(trackerResponses.clientId, clientId)))
    .groupBy(trackerResponses.runId);

  const cites = new Map(citeRows.map((r) => [r.runId, r]));
  const pairs = new Map(pairRows.map((r) => [r.runId, r.pairs]));

  return runs.map((run) => {
    const c = cites.get(run.id);
    const answered = pairs.get(run.id) ?? 0;
    return {
      ...run,
      citationStats: {
        totalCitations: c?.total ?? 0,
        brandCitations: c?.brand ?? 0,
        competitorCitations: c?.competitor ?? 0,
        brandCitationRate:
          brandDomain && answered > 0 ? (c?.brandPairs ?? 0) / answered : null,
      },
    };
  });
}

export interface TopSource {
  /** Display label: the normalized URL (host/path, no protocol). */
  page: string;
  /** Working link: the redirect-resolved URL (falls back to the raw URL). */
  url: string;
  domain: string;
  count: number;
  brand: boolean;
}

// Gemini grounding returns vertexaisearch redirect URLs; geo resolves them
// before storing citations.domain, but if resolution ever fails the redirect
// host falls through — those links die, so never surface them as sources.
const REDIRECT_HOSTS = ["vertexaisearch.cloud.google.com"];

/** A run's most-cited PAGES (exact URLs, not just domains), most-cited first. */
export async function getRunTopSources(
  teamId: string,
  clientId: string,
  runId: string,
  limit = 10,
): Promise<TopSource[]> {
  const brand = await getBrand(teamId, clientId);
  if (!brand) return [];
  const brandDomain = brand.domain ? stripWww(brand.domain) : null;
  const rows = await db
    .select({
      page: trackerCitations.normalizedUrl,
      domain: trackerCitations.domain,
      count: sql<number>`count(*)::int`,
      url: sql<string>`min(coalesce(${trackerCitations.resolvedUrl}, ${trackerCitations.rawUrl}))`,
    })
    .from(trackerCitations)
    .where(and(eq(trackerCitations.runId, runId), eq(trackerCitations.clientId, clientId)))
    .groupBy(trackerCitations.normalizedUrl, trackerCitations.domain)
    .orderBy(sql`count(*) desc`, asc(trackerCitations.normalizedUrl))
    .limit(limit);
  return rows
    .filter((r) => r.domain !== "" && !REDIRECT_HOSTS.includes(r.domain))
    .map((r) => ({
      ...r,
      brand: !!brandDomain && (r.domain === brandDomain || r.domain.endsWith(`.${brandDomain}`)),
    }));
}

export type ManualRunResult =
  | { kind: "run"; run: TrackerRun; promptCount: number; platformCount: number }
  | { kind: "in_flight"; run: TrackerRun }
  | { kind: "no_prompts" }
  | { kind: "invalid_scope"; message: string }
  | { kind: "not_found" };

const ALL_PLATFORMS: TrackerPlatform[] = ["openai", "perplexity", "google"];

/** Prompt subset (by prompt identity) and/or platform subset for a manual run. */
export interface ManualRunScopeInput {
  promptIds?: string[];
  platforms?: TrackerPlatform[];
}

/**
 * Insert the manual run row (kind='manual', pending). The caller debits
 * credits BEFORE triggering geo's worker; on debit failure it deletes this row.
 * The in-flight check is a fast-path — the debit's unique ledger reference is
 * the real double-submit gate.
 *
 * `scopeInput` narrows the run to specific prompts and/or platforms. Prompt
 * ids are resolved to their LATEST version ids here (geo's runner filters its
 * worklist by run.scope.promptVersionIds); a full selection normalizes to a
 * NULL scope so unscoped runs stay byte-identical to geo's own.
 */
export async function createManualRunRow(
  teamId: string,
  clientId: string,
  scopeInput?: ManualRunScopeInput,
): Promise<ManualRunResult> {
  const brand = await getBrand(teamId, clientId);
  if (!brand) return { kind: "not_found" };

  const activePrompts = await db
    .select({ id: trackerPrompts.id })
    .from(trackerPrompts)
    .where(and(eq(trackerPrompts.clientId, clientId), eq(trackerPrompts.status, "active")));
  if (activePrompts.length === 0) return { kind: "no_prompts" };

  // Platforms: dedupe, validate, and drop the filter when it isn't narrowing.
  let platforms: TrackerPlatform[] | undefined;
  if (scopeInput?.platforms?.length) {
    const unique = [...new Set(scopeInput.platforms)];
    const unknown = unique.filter((p) => !ALL_PLATFORMS.includes(p));
    if (unknown.length > 0) {
      return { kind: "invalid_scope", message: `Unknown platforms: ${unknown.join(", ")}` };
    }
    if (unique.length < ALL_PLATFORMS.length) platforms = unique;
  }

  // Prompts: every id must be one of this brand's active prompts.
  let promptVersionIds: string[] | undefined;
  let promptCount = activePrompts.length;
  if (scopeInput?.promptIds?.length) {
    const activeIds = new Set(activePrompts.map((p) => p.id));
    const selected = [...new Set(scopeInput.promptIds)];
    const invalid = selected.filter((id) => !activeIds.has(id));
    if (invalid.length > 0) {
      return { kind: "invalid_scope", message: `Not active prompts of this brand: ${invalid.join(", ")}` };
    }
    if (selected.length < activePrompts.length) {
      const versions = await db
        .select({ id: trackerPromptVersions.id, promptId: trackerPromptVersions.promptId, version: trackerPromptVersions.version })
        .from(trackerPromptVersions)
        .where(inArray(trackerPromptVersions.promptId, selected))
        .orderBy(desc(trackerPromptVersions.version));
      const latest = new Map<string, string>();
      for (const v of versions) {
        if (!latest.has(v.promptId)) latest.set(v.promptId, v.id);
      }
      promptVersionIds = selected.map((id) => latest.get(id)!).filter(Boolean);
      if (promptVersionIds.length === 0) {
        return { kind: "invalid_scope", message: "Selected prompts have no versions" };
      }
      promptCount = promptVersionIds.length;
    }
  }

  const scope: TrackerRunScope | null =
    promptVersionIds || platforms
      ? { ...(promptVersionIds ? { promptVersionIds } : {}), ...(platforms ? { platforms } : {}) }
      : null;

  const [inflight] = await db
    .select()
    .from(trackerRuns)
    .where(and(eq(trackerRuns.clientId, clientId), inArray(trackerRuns.status, ["pending", "running"])))
    .orderBy(desc(trackerRuns.createdAt))
    .limit(1);
  if (inflight) return { kind: "in_flight", run: inflight };

  const [run] = await db
    .insert(trackerRuns)
    .values({
      id: `tr_${nanoid()}`,
      clientId,
      orgId: brand.orgId,
      period: currentPeriod(),
      kind: "manual",
      promptsTotal: promptCount,
      scope,
    })
    .returning();
  return { kind: "run", run, promptCount, platformCount: platforms?.length ?? ALL_PLATFORMS.length };
}

export async function markRunFailed(runId: string, error: string): Promise<void> {
  await db.update(trackerRuns).set({ status: "failed", error }).where(eq(trackerRuns.id, runId));
}

export async function deleteRunRow(runId: string): Promise<void> {
  await db.delete(trackerRuns).where(eq(trackerRuns.id, runId));
}

// ── Reconciliation (cron) ────────────────────────────────────────────────────

export interface ReconcileRun {
  run: TrackerRun;
  teamId: string;
}

/**
 * Runs belonging to this service's team-orgs (never PCG's), bounded to the
 * last 90 days — reconciliation states settle within hours, and an unbounded
 * scan would grow linearly forever on an hourly cron.
 */
export async function listTeamRuns(): Promise<ReconcileRun[]> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ run: trackerRuns, orgId: trackerOrgs.id })
    .from(trackerRuns)
    .innerJoin(trackerOrgs, eq(trackerRuns.orgId, trackerOrgs.id))
    .where(and(like(trackerOrgs.id, "team\\_%"), gte(trackerRuns.createdAt, cutoff)));
  return rows.map((r) => ({ run: r.run, teamId: r.orgId.slice("team_".length) }));
}

// ── Replies (full response text) ─────────────────────────────────────────────

export interface RunResponseRow {
  promptName: string;
  promptText: string;
  platform: string;
  model: string | null;
  attempt: number;
  responseText: string | null;
  citedUrls: string[];
  brandMentioned: boolean;
  sentiment: string | null;
  createdAt: Date | null;
}

/**
 * Swap each response's raw cited URLs for the redirect-resolved URLs geo
 * recorded on the citation rows. Gemini grounding URLs are signed redirects
 * that expire — a raw one with no recorded resolution is a dead link and is
 * dropped rather than served.
 */
async function resolveCitedUrls<T extends { responseId: string; citedUrls: string[] }>(
  rows: T[],
): Promise<Array<Omit<T, "responseId">>> {
  const ids = [...new Set(rows.map((r) => r.responseId))];
  const resolutions = ids.length
    ? await db
        .select({
          responseId: trackerCitations.responseId,
          rawUrl: trackerCitations.rawUrl,
          resolvedUrl: trackerCitations.resolvedUrl,
        })
        .from(trackerCitations)
        .where(inArray(trackerCitations.responseId, ids))
    : [];
  const byResponse = new Map<string, Map<string, string>>();
  for (const r of resolutions) {
    if (!r.responseId || !r.resolvedUrl) continue;
    if (!byResponse.has(r.responseId)) byResponse.set(r.responseId, new Map());
    byResponse.get(r.responseId)!.set(r.rawUrl, r.resolvedUrl);
  }
  const isDeadRedirect = (url: string) =>
    REDIRECT_HOSTS.some((h) => url.startsWith(`https://${h}/`) || url.startsWith(`http://${h}/`));
  return rows.map(({ responseId, ...row }) => ({
    ...row,
    citedUrls: (row.citedUrls ?? [])
      .map((u) => byResponse.get(responseId)?.get(u) ?? u)
      .filter((u) => !isDeadRedirect(u)),
  }));
}

/** A run's raw replies, joined with the exact prompt text that was asked. */
export async function listRunResponses(
  teamId: string,
  clientId: string,
  runId: string,
): Promise<RunResponseRow[]> {
  const brand = await getBrand(teamId, clientId);
  if (!brand) return [];
  const rows = await db
    .select({
      responseId: trackerResponses.id,
      promptName: trackerPrompts.name,
      promptText: trackerPromptVersions.text,
      platform: trackerResponses.platform,
      model: trackerResponses.model,
      attempt: trackerResponses.attempt,
      responseText: trackerResponses.responseText,
      citedUrls: trackerResponses.citedUrls,
      brandMentioned: trackerResponses.brandMentioned,
      sentiment: trackerResponses.sentiment,
      createdAt: trackerResponses.createdAt,
    })
    .from(trackerResponses)
    .innerJoin(trackerPromptVersions, eq(trackerResponses.promptVersionId, trackerPromptVersions.id))
    .innerJoin(trackerPrompts, eq(trackerPromptVersions.promptId, trackerPrompts.id))
    .where(and(eq(trackerResponses.runId, runId), eq(trackerResponses.clientId, clientId)))
    .orderBy(asc(trackerPrompts.createdAt), asc(trackerResponses.platform), asc(trackerResponses.attempt));
  return resolveCitedUrls(rows.map((r) => ({ ...r, citedUrls: r.citedUrls ?? [] })));
}

export interface PromptHistoryRow {
  runId: string;
  period: string;
  runCreatedAt: Date | null;
  version: number;
  promptText: string;
  platform: string;
  model: string | null;
  attempt: number;
  responseText: string | null;
  citedUrls: string[];
  brandMentioned: boolean;
  sentiment: string | null;
}

/**
 * One prompt's replies across ALL runs, oldest first — how the answers (and
 * the prompt's own wording, via version) evolved over time.
 */
export async function listPromptHistory(
  teamId: string,
  clientId: string,
  promptId: string,
): Promise<PromptHistoryRow[]> {
  const brand = await getBrand(teamId, clientId);
  if (!brand) return [];
  const [prompt] = await db
    .select({ id: trackerPrompts.id })
    .from(trackerPrompts)
    .where(and(eq(trackerPrompts.id, promptId), eq(trackerPrompts.clientId, clientId)));
  if (!prompt) return [];
  return db
    .select({
      responseId: trackerResponses.id,
      runId: trackerRuns.id,
      period: trackerRuns.period,
      runCreatedAt: trackerRuns.createdAt,
      version: trackerPromptVersions.version,
      promptText: trackerPromptVersions.text,
      platform: trackerResponses.platform,
      model: trackerResponses.model,
      attempt: trackerResponses.attempt,
      responseText: trackerResponses.responseText,
      citedUrls: trackerResponses.citedUrls,
      brandMentioned: trackerResponses.brandMentioned,
      sentiment: trackerResponses.sentiment,
    })
    .from(trackerResponses)
    .innerJoin(trackerPromptVersions, eq(trackerResponses.promptVersionId, trackerPromptVersions.id))
    .innerJoin(trackerRuns, eq(trackerResponses.runId, trackerRuns.id))
    .where(and(eq(trackerPromptVersions.promptId, promptId), eq(trackerResponses.clientId, clientId)))
    .orderBy(asc(trackerRuns.createdAt), asc(trackerResponses.platform), asc(trackerResponses.attempt))
    .then((rows) => resolveCitedUrls(rows.map((r) => ({ ...r, citedUrls: r.citedUrls ?? [] }))));
}
