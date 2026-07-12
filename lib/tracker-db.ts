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
  trackerArticles,
  citationChecks,
  aiSearchSnapshots,
  type TrackerClient,
  type TrackerRun,
  type CitationCheckStatus,
} from "@/lib/db/schema";
// Pure URL helpers from the engine's matcher. These are canonical-key functions
// (no tracker.* schema imports), so importing them here does NOT trip the
// architecture gate (which scans for tracker* SCHEMA symbols, not these).
import { normalizeArticleUrl, extractRegistrableDomain } from "@/lib/engine/url-matcher";
import type {
  TrackerCompetitor,
  TrackerPlatform,
  TrackerPromptCategory,
  TrackerRunFrequency,
  TrackerRunScope,
} from "@/lib/types/tracker";
import { and, asc, desc, eq, gte, inArray, isNull, like, lt, ne, or, sql } from "drizzle-orm";
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
  // Verify ownership FIRST so we never touch another org's rows, then delete the
  // client's tracker.articles explicitly. Prod DOES have articles_client_id_fkey
  // ON DELETE CASCADE (verified against pg_constraint 2026-07-11), so this is
  // belt-and-suspenders: deleteBrand stays correct even against a database
  // missing that FK, at the cost of one no-op delete inside the transaction.
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(trackerClients)
      .where(and(eq(trackerClients.id, clientId), eq(trackerClients.orgId, orgIdForTeam(teamId))))
      .returning({ id: trackerClients.id });
    if (deleted.length === 0) return false;
    await tx.delete(trackerArticles).where(eq(trackerArticles.clientId, clientId));
    return true;
  });
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
  totalCitations: number;      // cited URLs that passed verification (dead + hallucinated excluded)
  brandCitations: number;      // citations of the brand's domain (incl. subdomains)
  competitorCitations: number; // citations of named competitor domains
  brandCitationRate: number | null; // fraction of answered replies citing the brand; null without a domain
  /** Citations whose page never mentions the brand — flagged by the guard, excluded above. */
  hallucinatedCitations: number;
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

  // Citations flagged by the verification guard don't count: a dead link or a
  // page that never mentions the brand is not a citation worth reporting.
  const counted = sql`(${citationChecks.status} IS NULL OR ${citationChecks.status} NOT IN ('dead', 'no_mention'))`;
  const citeRows = await db
    .select({
      runId: trackerCitations.runId,
      total: sql<number>`count(*) filter (where ${counted})::int`,
      brand: sql<number>`count(*) filter (where ${brandCond} AND ${counted})::int`,
      competitor: sql<number>`count(*) filter (where (${compCond}) AND ${counted})::int`,
      brandPairs: sql<number>`count(distinct (${trackerCitations.promptVersionId}, ${trackerCitations.platform})) filter (where ${brandCond} AND ${counted})::int`,
      hallucinated: sql<number>`count(*) filter (where ${citationChecks.status} = 'no_mention')::int`,
    })
    .from(trackerCitations)
    .leftJoin(citationChecks, eq(citationChecks.citationId, trackerCitations.id))
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
        hallucinatedCitations: c?.hallucinated ?? 0,
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
  /** Which models cited this page. */
  platforms: string[];
  /** Verification verdict (hallucination guard); null = not yet checked. */
  check: CitationCheckStatus | null;
}

const CHECK_RANK: Record<CitationCheckStatus, number> = {
  dead: 0,
  no_mention: 1,
  unverifiable: 2,
  verified: 3,
};

/** Pessimistic reduce of a page's citation verdicts (dead wins over verified). */
function worstCheck(statuses: Array<string | null> | null): CitationCheckStatus | null {
  let worst: CitationCheckStatus | null = null;
  for (const s of statuses ?? []) {
    if (!s || !(s in CHECK_RANK)) continue;
    const status = s as CitationCheckStatus;
    if (worst === null || CHECK_RANK[status] < CHECK_RANK[worst]) worst = status;
  }
  return worst;
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
      count: sql<number>`count(distinct ${trackerCitations.id})::int`,
      url: sql<string>`min(coalesce(${trackerCitations.resolvedUrl}, ${trackerCitations.rawUrl}))`,
      platforms: sql<Array<string | null> | null>`array_agg(distinct ${trackerCitations.platform}) filter (where ${trackerCitations.platform} is not null)`,
      checks: sql<Array<string | null> | null>`array_agg(distinct ${citationChecks.status}) filter (where ${citationChecks.status} is not null)`,
    })
    .from(trackerCitations)
    .leftJoin(citationChecks, eq(citationChecks.citationId, trackerCitations.id))
    .where(and(eq(trackerCitations.runId, runId), eq(trackerCitations.clientId, clientId)))
    .groupBy(trackerCitations.normalizedUrl, trackerCitations.domain)
    .orderBy(sql`count(distinct ${trackerCitations.id}) desc`, asc(trackerCitations.normalizedUrl))
    .limit(limit);
  return rows
    .filter((r) => r.domain !== "" && !REDIRECT_HOSTS.includes(r.domain))
    .map(({ checks, platforms, ...r }) => ({
      ...r,
      platforms: (platforms ?? []).filter((p): p is string => !!p),
      brand: !!brandDomain && (r.domain === brandDomain || r.domain.endsWith(`.${brandDomain}`)),
      check: worstCheck(checks),
    }))
    // A dead link or a page that never mentions the brand is not a source.
    .filter((r) => r.check !== "dead" && r.check !== "no_mention");
}

// ── Citation verification (hallucination guard) ─────────────────────────────

export interface UncheckedCitation {
  citationId: string;
  runId: string;
  clientId: string;
  url: string;
  /** Brand keywords the cited page must mention: stored keywords + name + domain stem. */
  keywords: string[];
}

/**
 * Team-org citations (last 90 days) with no verification verdict yet — the
 * hourly sweep's worklist. Never returns PCG citations.
 */
export async function listUncheckedTeamCitations(limit: number): Promise<UncheckedCitation[]> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      citationId: trackerCitations.id,
      runId: trackerCitations.runId,
      clientId: trackerCitations.clientId,
      url: sql<string>`coalesce(${trackerCitations.resolvedUrl}, ${trackerCitations.rawUrl})`,
      name: trackerClients.name,
      domain: trackerClients.domain,
      brandKeywords: trackerClients.brandKeywords,
    })
    .from(trackerCitations)
    .innerJoin(trackerClients, eq(trackerCitations.clientId, trackerClients.id))
    .leftJoin(citationChecks, eq(citationChecks.citationId, trackerCitations.id))
    .where(
      and(
        like(trackerClients.orgId, "team\\_%"),
        isNull(citationChecks.citationId),
        gte(trackerCitations.createdAt, cutoff),
      ),
    )
    .orderBy(desc(trackerCitations.createdAt))
    .limit(limit);
  return rows.map((r) => {
    const stem = r.domain?.replace(/^www\./, "").split(".")[0];
    const keywords = [...new Set([...(r.brandKeywords?.keywords ?? []), r.name, stem].filter((k): k is string => !!k))];
    return { citationId: r.citationId, runId: r.runId, clientId: r.clientId, url: r.url, keywords };
  });
}

export interface CitationCheckInput {
  citationId: string;
  runId: string;
  clientId: string;
  url: string;
  status: CitationCheckStatus;
  httpStatus?: number;
  brandMatched?: boolean;
  via?: "fetch" | "crawler";
}

/** Record verdicts — first verdict wins (idempotent re-sweeps). */
export async function recordCitationChecks(checks: CitationCheckInput[]): Promise<void> {
  if (checks.length === 0) return;
  await db
    .insert(citationChecks)
    .values(
      checks.map((c) => ({
        citationId: c.citationId,
        runId: c.runId,
        clientId: c.clientId,
        url: c.url,
        status: c.status,
        httpStatus: c.httpStatus ?? null,
        brandMatched: c.brandMatched ?? null,
        via: c.via ?? null,
      })),
    )
    .onConflictDoNothing({ target: citationChecks.citationId });
}

/** url → verdict for a run's citations (keys match the served citedUrls). */
export async function listRunCitationChecks(
  teamId: string,
  clientId: string,
  runId: string,
): Promise<Record<string, CitationCheckStatus>> {
  const brand = await getBrand(teamId, clientId);
  if (!brand) return {};
  const rows = await db
    .select({ url: citationChecks.url, status: citationChecks.status })
    .from(citationChecks)
    .where(and(eq(citationChecks.runId, runId), eq(citationChecks.clientId, clientId)));
  const map: Record<string, CitationCheckStatus> = {};
  for (const r of rows) {
    // Pessimistic on conflicts between duplicate URLs: dead wins, then no_mention.
    const prev = map[r.url];
    if (!prev || CHECK_RANK[r.status] < CHECK_RANK[prev]) map[r.url] = r.status;
  }
  return map;
}

// ── AI Search (Google AI Overview) snapshots ─────────────────────────────────

export interface StaleAiSearchPrompt {
  promptId: string;
  clientId: string;
  query: string;
  keywords: string[];
}

/**
 * Active team-org prompts whose latest AI-search snapshot is older than a day
 * (or missing) — the hourly sweep's worklist.
 */
export async function listStaleAiSearchPrompts(limit: number): Promise<StaleAiSearchPrompt[]> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const latest = db
    .select({
      promptId: aiSearchSnapshots.promptId,
      lastChecked: sql<Date>`max(${aiSearchSnapshots.checkedAt})`.as("last_checked"),
    })
    .from(aiSearchSnapshots)
    .groupBy(aiSearchSnapshots.promptId)
    .as("latest");
  const rows = await db
    .select({
      promptId: trackerPrompts.id,
      clientId: trackerPrompts.clientId,
      name: trackerClients.name,
      domain: trackerClients.domain,
      brandKeywords: trackerClients.brandKeywords,
      version: trackerPromptVersions.version,
      text: trackerPromptVersions.text,
      lastChecked: latest.lastChecked,
    })
    .from(trackerPrompts)
    .innerJoin(trackerClients, eq(trackerPrompts.clientId, trackerClients.id))
    .innerJoin(trackerPromptVersions, eq(trackerPromptVersions.promptId, trackerPrompts.id))
    .leftJoin(latest, eq(latest.promptId, trackerPrompts.id))
    .where(
      and(
        like(trackerClients.orgId, "team\\_%"),
        eq(trackerPrompts.status, "active"),
        sql`(${latest.lastChecked} IS NULL OR ${latest.lastChecked} < ${cutoff.toISOString()})`,
      ),
    )
    .orderBy(desc(trackerPromptVersions.version))
    .limit(limit * 3); // multiple versions per prompt — filtered to latest below
  const byPrompt = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!byPrompt.has(r.promptId)) byPrompt.set(r.promptId, r); // versions sorted desc
  }
  return [...byPrompt.values()].slice(0, limit).map((r) => {
    const stem = r.domain?.replace(/^www\./, "").split(".")[0];
    const keywords = [...new Set([...(r.brandKeywords?.keywords ?? []), r.name, stem].filter((k): k is string => !!k))];
    return { promptId: r.promptId, clientId: r.clientId, query: r.text, keywords };
  });
}

export interface AiSearchSnapshotInput {
  promptId: string;
  clientId: string;
  query: string;
  present: boolean;
  brandMentioned: boolean | null;
  overviewText: string | null;
  citedUrls: Array<{ url: string; label: string }>;
}

export async function recordAiSearchSnapshots(snaps: AiSearchSnapshotInput[]): Promise<void> {
  if (snaps.length === 0) return;
  await db.insert(aiSearchSnapshots).values(
    snaps.map((s) => ({
      id: `ais_${nanoid()}`,
      promptId: s.promptId,
      clientId: s.clientId,
      query: s.query,
      present: s.present,
      brandMentioned: s.brandMentioned,
      overviewText: s.overviewText,
      citedUrls: s.citedUrls,
    })),
  );
}

export interface AiSearchRow {
  promptId: string;
  promptText: string;
  present: boolean;
  brandMentioned: boolean | null;
  citedUrls: Array<{ url: string; label: string }>;
  checkedAt: Date | null;
}

/** Latest snapshot per active prompt for a brand (org-scoped). */
export async function latestAiSearchForBrand(teamId: string, clientId: string): Promise<AiSearchRow[]> {
  const brand = await getBrand(teamId, clientId);
  if (!brand) return [];
  const prompts = await listPrompts(teamId, clientId);
  if (prompts.length === 0) return [];
  const snaps = await db
    .select()
    .from(aiSearchSnapshots)
    .where(and(eq(aiSearchSnapshots.clientId, clientId), inArray(aiSearchSnapshots.promptId, prompts.map((p) => p.promptId))))
    .orderBy(desc(aiSearchSnapshots.checkedAt));
  const latest = new Map<string, (typeof snaps)[number]>();
  for (const s of snaps) {
    if (!latest.has(s.promptId)) latest.set(s.promptId, s);
  }
  return prompts.flatMap((p) => {
    const s = latest.get(p.promptId);
    if (!s) return [];
    return [{
      promptId: p.promptId,
      promptText: p.text,
      present: s.present,
      brandMentioned: s.brandMentioned,
      citedUrls: s.citedUrls ?? [],
      checkedAt: s.checkedAt,
    }];
  });
}

// ── Tracked publicity URLs (stored AS tracker.articles rows, source='manual') ─
// Teams add press/blog/launch URLs they're doing PR on; the engine already loads
// tracker.articles per client on every run and stamps each citation's match_type
// + article_id (lib/engine/runner.ts). For the UI we compute citation stats LIVE
// at query time by matching tracker.citations against the tracked URLs' normalized
// keys (not the stored match_type) — so URLs added AFTER a run light up
// retroactively (same pattern as competitor stats over tracker.citations).

export const MAX_TRACKED_URLS = 50;

export interface TrackedUrl {
  id: string;
  url: string;
  normalizedUrl: string;
  createdAt: Date | null;
}

/** The team's tracked publicity URLs for a brand, org-scoped. */
export async function listTrackedUrls(teamId: string, clientId: string): Promise<TrackedUrl[]> {
  const brand = await getBrand(teamId, clientId);
  if (!brand) return [];
  const rows = await db
    .select({
      id: trackerArticles.id,
      url: trackerArticles.url,
      normalizedUrl: trackerArticles.normalizedUrl,
      createdAt: trackerArticles.createdAt,
    })
    .from(trackerArticles)
    // source='manual' only: team-entered tracked URLs. Any other source (e.g. a
    // future CSV import) must be invisible here and survive the full-replace.
    .where(and(eq(trackerArticles.clientId, clientId), eq(trackerArticles.source, "manual")))
    .orderBy(asc(trackerArticles.createdAt));
  return rows;
}

export interface ReplaceTrackedUrlsResult {
  urls: TrackedUrl[];
  /** Input entries that could not be parsed into a canonical URL key. */
  rejected: string[];
}

/**
 * Full-replace the brand's tracked URLs (like the competitor save). Each input
 * is normalized to its canonical key; unparseable inputs are surfaced in
 * `rejected` and skipped. Deduped by normalized key. Capped at MAX_TRACKED_URLS.
 * Delete-then-insert runs in one transaction. Returns null on cross-org access.
 */
export async function replaceTrackedUrls(
  teamId: string,
  clientId: string,
  urls: string[],
): Promise<ReplaceTrackedUrlsResult | null> {
  const brand = await getBrand(teamId, clientId);
  if (!brand) return null;

  const rejected: string[] = [];
  const seen = new Set<string>();
  const toInsert: Array<{ url: string; normalizedUrl: string }> = [];
  for (const raw of urls) {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed) continue;
    const normalized = normalizeArticleUrl(trimmed);
    if (!normalized) {
      rejected.push(raw);
      continue;
    }
    if (seen.has(normalized)) continue; // dedupe by canonical key
    seen.add(normalized);
    if (toInsert.length >= MAX_TRACKED_URLS) {
      throw new Error(`A brand can track at most ${MAX_TRACKED_URLS} URLs`);
    }
    toInsert.push({ url: trimmed, normalizedUrl: normalized });
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(trackerArticles)
      .where(and(eq(trackerArticles.clientId, clientId), eq(trackerArticles.source, "manual")));
    if (toInsert.length > 0) {
      await tx.insert(trackerArticles).values(
        toInsert.map((u) => ({
          id: `ta_${nanoid()}`,
          clientId,
          url: u.url,
          normalizedUrl: u.normalizedUrl,
          source: "manual",
        })),
      );
    }
  });

  return { urls: await listTrackedUrls(teamId, clientId), rejected };
}

export interface TrackedUrlStats {
  /** Citations whose normalized_url equals this tracked URL's key (this exact page was cited). */
  exactCount: number;
  /** Distinct platforms citing this exact URL. */
  platforms: string[];
  /** Most recent citation of this exact URL. */
  lastCitedAt: Date | null;
  /** Citations sharing this URL's outlet domain but NOT the exact URL (outlet cited, different page). */
  domainCount: number;
}

/**
 * Per tracked URL, citation stats computed LIVE over tracker.citations for the
 * client — retroactive by construction (URLs added after a run still match past
 * citations). Guard-flagged citations (dead / no_mention in citation_checks) are
 * excluded with the SAME predicate as listRunsWithStats/getRunTopSources so the
 * numbers agree across the UI. exactCount and domainCount are disjoint: a
 * citation of the exact URL counts only toward exactCount, never domainCount.
 */
export async function getTrackedUrlStats(
  teamId: string,
  clientId: string,
): Promise<Record<string, TrackedUrlStats>> {
  const tracked = await listTrackedUrls(teamId, clientId);
  if (tracked.length === 0) return {};

  const normalizedKeys = [...new Set(tracked.map((t) => t.normalizedUrl))];
  const domains = [...new Set(tracked.map((t) => extractRegistrableDomain(t.normalizedUrl)).filter((d): d is string => !!d))];

  // Same exclusion predicate as the run stats: a dead link or a page that never
  // mentions the brand is not a citation worth reporting.
  const counted = sql`(${citationChecks.status} IS NULL OR ${citationChecks.status} NOT IN ('dead', 'no_mention'))`;

  // 1) Exact matches: group counted citations by normalized_url.
  const exactRows = await db
    .select({
      normalizedUrl: trackerCitations.normalizedUrl,
      count: sql<number>`count(distinct ${trackerCitations.id})::int`,
      platforms: sql<Array<string | null> | null>`array_agg(distinct ${trackerCitations.platform}) filter (where ${trackerCitations.platform} is not null)`,
      lastCitedAt: sql<Date | null>`max(${trackerCitations.createdAt})`,
    })
    .from(trackerCitations)
    .leftJoin(citationChecks, eq(citationChecks.citationId, trackerCitations.id))
    .where(
      and(
        eq(trackerCitations.clientId, clientId),
        inArray(trackerCitations.normalizedUrl, normalizedKeys),
        counted,
      ),
    )
    .groupBy(trackerCitations.normalizedUrl);
  const exactByKey = new Map(exactRows.map((r) => [r.normalizedUrl, r]));

  // 2) Domain matches, EXCLUDING exact-URL citations (outlet cited, different page).
  const domainRows = domains.length
    ? await db
        .select({
          domain: trackerCitations.domain,
          count: sql<number>`count(distinct ${trackerCitations.id})::int`,
        })
        .from(trackerCitations)
        .leftJoin(citationChecks, eq(citationChecks.citationId, trackerCitations.id))
        .where(
          and(
            eq(trackerCitations.clientId, clientId),
            inArray(trackerCitations.domain, domains),
            sql`${trackerCitations.normalizedUrl} NOT IN (${sql.join(normalizedKeys.map((k) => sql`${k}`), sql`, `)})`,
            counted,
          ),
        )
        .groupBy(trackerCitations.domain)
    : [];
  const domainByKey = new Map(domainRows.map((r) => [r.domain, r.count]));

  const out: Record<string, TrackedUrlStats> = {};
  for (const t of tracked) {
    const exact = exactByKey.get(t.normalizedUrl);
    const dom = extractRegistrableDomain(t.normalizedUrl);
    // max(timestamp) comes back as a string from the driver — coerce to Date.
    const last = exact?.lastCitedAt ?? null;
    out[t.id] = {
      exactCount: exact?.count ?? 0,
      platforms: (exact?.platforms ?? []).filter((p): p is string => !!p),
      lastCitedAt: last ? new Date(last) : null,
      domainCount: dom ? domainByKey.get(dom) ?? 0 : 0,
    };
  }
  return out;
}

export type ManualRunResult =
  | { kind: "run"; run: TrackerRun; promptCount: number; platformCount: number }
  | { kind: "in_flight"; run: TrackerRun }
  | { kind: "no_prompts" }
  | { kind: "invalid_scope"; message: string }
  | { kind: "not_found" };

const ALL_PLATFORMS: TrackerPlatform[] = ["openai", "perplexity", "google", "anthropic"];

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

/**
 * Mark a run complete with nothing executed — used by the scheduler when a due
 * client has zero active prompts. Leaving such a run 'pending' would let stale
 * recovery execute it (unbilled, since reconcile skips promptsTotal=0) and
 * would block the brand's manual runs via the in-flight check. Guarded to
 * pending so it never clobbers a run the worker is actively executing.
 */
export async function markRunCompleteIfPending(runId: string): Promise<void> {
  await db
    .update(trackerRuns)
    .set({ status: "complete", completedAt: new Date() })
    .where(and(eq(trackerRuns.id, runId), eq(trackerRuns.status, "pending")));
}

/**
 * The AUTHORITATIVE execution target of a run — its own org id and client id,
 * read from the run row (never trust the worker payload's clientId). The worker
 * uses this both to enforce the team-org guard AND to drive the runner, so a
 * caller holding the shared CRON_SECRET can't pair a team run id with a PCG
 * clientId to execute PCG prompts on our keys. null = run not found.
 */
export async function runExecTarget(runId: string): Promise<{ orgId: string; clientId: string } | null> {
  const [row] = await db
    .select({ orgId: trackerRuns.orgId, clientId: trackerRuns.clientId })
    .from(trackerRuns)
    .where(eq(trackerRuns.id, runId))
    .limit(1);
  return row ?? null;
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

// ── Scheduler (tracker-run cron) ─────────────────────────────────────────────
// Team-org scoping is load-bearing: PCG's clients/runs share these tables and
// must never be scheduled or recovered by this service (their prompts would
// execute on OUR provider keys).

export interface DueTeamClient {
  id: string;
  orgId: string;
  runFrequency: TrackerRunFrequency;
}

/** Active team-org clients whose next_run_at is due or never set. */
export async function listDueTeamClients(now: Date, limit: number): Promise<DueTeamClient[]> {
  return db
    .select({
      id: trackerClients.id,
      orgId: trackerClients.orgId,
      runFrequency: trackerClients.runFrequency,
    })
    .from(trackerClients)
    .where(
      and(
        like(trackerClients.orgId, "team\\_%"),
        eq(trackerClients.status, "active"),
        ne(trackerClients.runFrequency, "manual"),
        or(lt(trackerClients.nextRunAt, now), isNull(trackerClients.nextRunAt)),
      ),
    )
    .limit(limit);
}

/**
 * Advance next_run_at by the client's cadence. The cron calls this BEFORE
 * creating/enqueueing so a failure never re-picks the client every tick
 * (stale-run recovery is the retry path).
 */
export async function advanceClientNextRun(
  clientId: string,
  frequency: TrackerRunFrequency,
  now: Date,
): Promise<void> {
  await db
    .update(trackerClients)
    .set({ nextRunAt: nextRunAtFor(frequency, now), updatedAt: now })
    .where(eq(trackerClients.id, clientId));
}

export interface StaleTeamRun {
  id: string;
  clientId: string;
  cursor: number;
}

/** Team-org runs stuck 'running'/'pending' beyond the stale window. */
export async function listStaleTeamRuns(cutoff: Date, limit: number): Promise<StaleTeamRun[]> {
  return db
    .select({ id: trackerRuns.id, clientId: trackerRuns.clientId, cursor: trackerRuns.cursor })
    .from(trackerRuns)
    .where(
      and(
        like(trackerRuns.orgId, "team\\_%"),
        inArray(trackerRuns.status, ["running", "pending"]),
        lt(trackerRuns.createdAt, cutoff),
      ),
    )
    .limit(limit);
}

/**
 * 12-month response-body retention purge — deliberately GLOBAL (PCG rows
 * included): this service owns the shared table's hygiene once geo's tracker
 * cron is deleted. Citations carry denormalized run/client ids and survive
 * (their response FK is SET NULL, not CASCADE).
 */
export async function purgeOldResponses(cutoff: Date): Promise<number> {
  const purged = await db
    .delete(trackerResponses)
    .where(lt(trackerResponses.createdAt, cutoff))
    .returning({ id: trackerResponses.id });
  return purged.length;
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
