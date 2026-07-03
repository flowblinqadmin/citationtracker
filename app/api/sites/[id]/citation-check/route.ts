import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites, teams, creditTransactions, citationCheckResponses, citationCheckScores, auditPurchases } from "@/lib/db/schema";
import { eq, sql, gte, and, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { generatePrompts, extractTopCityNames } from "@/lib/services/citation-prompt-generator";
import { runCitationCheck, aggregateByDimension, aggregateCompetitorsByDimension, generateDominanceInsights } from "@/lib/services/citation-checker";
import { discoverRealPrompts } from "@/lib/services/real-prompt-discoverer";
// sync to geo_site_view handled by Postgres trigger
import { validateCrawlCoverage } from "@/lib/services/crawl-coverage-validator";
import { analyzeEnginePreferences } from "@/lib/services/engine-preference-analyzer";
import { type SSEEvent, type DiscoveredCompetitor, type UserCompetitor, type GeoVisibility, type CategoryVisibility, type TierVisibility, type VisibilityGapEntry } from "@/lib/types/citation";
import type { GeoTree, CategoryTree, GeoCategoryMapping } from "@/lib/types/trees";
import type { CrawlData, DiscoveryData } from "@/lib/services/geo-crawler";
import { extractTrees } from "@/lib/services/tree-extractor";
import { extractBrandKeywords, type BrandKeywords } from "@/lib/services/brand-detector";
import { extractCategoriesViaHaiku, type ExtractedCategories } from "@/lib/services/category-extractor";
import { ACTION_CREDITS } from "@/lib/config";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
// ES-086 AC-20: bumped from 300 to 600 to absorb worst-case ~405s extraction
// (200s Sonnet timeout + 200s gpt-5.4 fallback + 5s correction call). The
// per-call EXTRACTION_TIMEOUT_MS at lib/services/tree-extractor.ts:22 is now
// 200_000 (was 35_000) which means a single extraction can take up to ~200s.
export const maxDuration = 600;

const CITATION_CHECK_COST = ACTION_CREDITS.shareOfVoice;

// ── ES-086 AC-15 — non-NULL empty tree detection ────────────────────────────
//
// INLINE helper (NOT extracted to lib/) — single call site, narrow purpose,
// broader sharing is out of scope per HP-179. Catches four shapes:
//   1. NULL / undefined / non-object        → empty
//   2. leafCount === 0                       → empty
//   3. root.children is not an array         → empty (catches FIX-2 sentinel)
//   4. root.children is an empty array       → empty
function treeIsEmpty(t: unknown): boolean {
  if (!t || typeof t !== "object") return true;
  const obj = t as { leafCount?: unknown; root?: { children?: unknown } };
  if (obj.leafCount === 0) return true;
  if (!Array.isArray(obj.root?.children) || obj.root.children.length === 0) return true;
  return false;
}

// ── ES-086 AC-22 — re-extraction thundering-herd guard ──────────────────────
//
// In-process semaphore capping concurrent tree re-extractions to 3. Lives in
// this file (NOT a shared helper) per the v1 minimum implementation. Future
// iteration: replace with a Redis-backed counter using the existing Upstash
// pattern for cross-instance concurrency control.
const MAX_CONCURRENT_REEXTRACTIONS = 3;
let activeReextractions = 0;

// ES-086 AC-22 test hook: tests need to manipulate the in-process counter
// to exercise saturated / slot-available / failure paths. NOT for production
// use. Tests import via __test_internals.setActiveReextractions / getActive.
export const __test_internals = {
  setActiveReextractions(n: number) {
    activeReextractions = n;
  },
  getActiveReextractions() {
    return activeReextractions;
  },
};

interface RouteContext {
  params: Promise<{ id: string }>;
}

function sseMessage(event: SSEEvent): string {
  return `data: ${JSON.stringify({ type: event.type, ...event.data })}\n\n`;
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id: siteId } = await params;

  // ── Auth: accessToken (Bearer header or ?token= query param) ──────────
  const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? req.nextUrl.searchParams.get("token");
  // Fix #5: read purchaseToken from dedicated X-Purchase-Token header to avoid ambiguity with
  // the Authorization header (which carries the regular user accessToken). Falls back to
  // ?purchaseToken= query param for back-compat during the deploy window.
  const purchaseToken =
    req.headers.get("x-purchase-token") ??
    req.nextUrl.searchParams.get("purchaseToken");

  // GMC audit-purchase auth bypass (mirrors download-report/pdf-report pattern):
  // a valid purchaseToken bound to this siteId skips accessToken + rate limit
  // + credit gating. Used by the audit-purchase-finalize pipeline stage to run
  // citation check server-internally without HTTP credit deduction.
  let isPurchaseAuth = false;
  // For audit_purchase mode, citation_check_scores.team_id (NOT NULL) needs a
  // value — there's no real team. Aditya rule (2026-04-28): teamId is the
  // email username, i.e. customerEmail.split('@')[0]. So we capture
  // customerEmail in the same lookup that proves auth, then derive teamId
  // for the INSERT site below. citationCheckScores.team_id has no FK to
  // teams.id (verified in lib/db/schema.ts:386 — text("team_id").notNull()
  // with no .references()), so no auto-team-row creation needed.
  let purchaseTeamId: string | null = null;
  if (purchaseToken) {
    const [purchase] = await db
      .select({ id: auditPurchases.id, customerEmail: auditPurchases.customerEmail, purchaseTokenExpiresAt: auditPurchases.purchaseTokenExpiresAt })
      .from(auditPurchases)
      .where(and(eq(auditPurchases.purchaseToken, purchaseToken), eq(auditPurchases.siteId, siteId)));
    // Fix #32: enforce purchaseToken expiry (30-day TTL). NULL = legacy row, treat as expired.
    if (purchase && purchase.purchaseTokenExpiresAt && purchase.purchaseTokenExpiresAt >= new Date()) {
      if (purchase.customerEmail) {
        isPurchaseAuth = true;
        // L2 (2026-05-27 audit): previously sliced to email local-part,
        // which collided across domains (two `info@*` purchases shared a
        // team_id in citation_check_scores). Use auditPurchases.id —
        // globally unique, scoped per purchase.
        purchaseTeamId = purchase.id;
      }
    } else if (purchase) {
      return NextResponse.json({ error: "purchaseToken has expired" }, { status: 401 });
    }
  }

  if (!isPurchaseAuth && !token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  if (!isPurchaseAuth) {
    if (site.accessToken !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // ES-090 §b.2 CRIT-1: HP-197 — NULL tokenExpiresAt treated as expired.
    if (!site.tokenExpiresAt || site.tokenExpiresAt < new Date()) {
      return NextResponse.json(
        { error: "Unauthorized", code: "TOKEN_EXPIRED" },
        { status: 401 },
      );
    }
  }

  // ── GeoScorecard required ─────────────────────────────────────────────
  if (!site.geoScorecard) {
    return NextResponse.json(
      { error: "geo_analysis_required", message: "Run GEO analysis before checking AI visibility." },
      { status: 422 }
    );
  }

  // ── ES-090 §b.4 CRIT-3: rate-limit (MUST precede credit debit, U21) ──
  // Key scoped per-siteId; 1 call / 30s. Skipped for audit-purchase mode —
  // the finalize stage is itself idempotent + retry-bounded by QStash.
  if (!isPurchaseAuth) {
    const rl = await checkRateLimit(`citation_check:${siteId}`, 1, 30_000);
    if (!rl.allowed) {
      const retryAfterMs = Math.max(0, rl.resetAt - Date.now());
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);
      return NextResponse.json(
        { error: "Too Many Requests", retryAfterMs },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }
  }

  // ── Team / credit gate ────────────────────────────────────────────────
  // PAID-ONLY for non-audit-purchase mode: requires creditBalance >= CITATION_CHECK_COST.
  // audit_purchase already paid $10 upstream — no per-call credit deduction.
  if (!isPurchaseAuth) {
    if (!site.teamId) return NextResponse.json({ error: "Citation check requires a Pro account." }, { status: 402 });
    const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
    if (!team || team.creditBalance < CITATION_CHECK_COST) {
      return NextResponse.json({ error: "insufficient_credits" }, { status: 402 });
    }
  }

  // ── Provider availability check ───────────────────────────────────────
  const hasAnyProvider = !!(process.env.PERPLEXITY_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY);
  if (!hasAnyProvider) return NextResponse.json({ error: "No AI providers configured." }, { status: 422 });

  // ── Deduct credits upfront — skipped for audit_purchase mode ──────────
  if (!isPurchaseAuth && site.teamId) {
    const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
    if (team) {
      const teamId = site.teamId;
      const balanceBefore = team.creditBalance;
      const balanceAfter = team.creditBalance - CITATION_CHECK_COST;

      await db
        .update(teams)
        .set({ creditBalance: sql`${teams.creditBalance} - ${CITATION_CHECK_COST}` })
        .where(and(eq(teams.id, teamId), gte(teams.creditBalance, CITATION_CHECK_COST)));

      await db.insert(creditTransactions).values({
        id: nanoid(),
        teamId,
        siteId,
        type: "citation_check_debit",
        pagesConsumed: 0,
        creditsChanged: -CITATION_CHECK_COST,
        balanceBefore,
        balanceAfter,
      });

      console.info(`[citation-check] 5 credits deducted from teamId=${teamId}`);
    }
  }

  // ── SSE stream setup ──────────────────────────────────────────────────
  const encoder = new TextEncoder();
  const checkId = nanoid();
  const streamStart = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: SSEEvent) => controller.enqueue(encoder.encode(sseMessage(event)));

      try {
        send({ type: "start", data: { message: `Starting citation check for ${site.domain}` } });
        send({ type: "stage", data: { stage: "prompts", progress: 5, message: "Generating domain-aware prompts" } });

        // ── ES-086 — Lazy tree extraction rescue path ────────────────────────
        // AC-15: detect non-NULL empty trees structurally via treeIsEmpty(),
        //        not via JS truthiness. Catches the FIX-2 sentinel + emptyGeoTree().
        // AC-22: cap concurrent re-extractions at MAX_CONCURRENT_REEXTRACTIONS.
        //        Saturated path proceeds with empty trees + flags treeReextractionDeferred
        //        (NOT return early — credits are deducted upfront, see HP-181).
        // AC-23: success-path UPDATE has the isNull(geoTree) guard REMOVED so
        //        the rescue path can overwrite a prior FIX-2 sentinel.
        // AC-24: catch block does NOT write a sentinel. The next citation check
        //        sees the same NULL/empty state and tries again — semaphore caps
        //        the retry burst.
        let treeReextractionDeferred = false;
        if (
          (treeIsEmpty(site.geoTree) || treeIsEmpty(site.categoryTree)) &&
          site.crawlData &&
          site.discoveryData
        ) {
          if (activeReextractions >= MAX_CONCURRENT_REEXTRACTIONS) {
            console.info(JSON.stringify({
              event: "tree_reextraction_deferred",
              domain: site.domain,
              siteId,
              active: activeReextractions,
            }));
            treeReextractionDeferred = true;
            // Surface the deferred flag in the SSE stream early so the
            // dashboard can show its regenerating-data hint even if the
            // citation check itself fails downstream. The keyword
            // `treeReextractionDeferred` lives in the message string so the
            // SSEEvent type doesn't need a new field.
            send({
              type: "stage",
              data: {
                stage: "extracting-trees-deferred",
                progress: 7,
                message: "treeReextractionDeferred: dimensional data is regenerating in the background",
              },
            });
          } else {
            activeReextractions++;
            try {
              send({ type: "stage", data: { stage: "extracting-trees", progress: 7, message: "Building geographic & category intelligence" } });
              const crawl = site.crawlData as Record<string, unknown>;
              if (!crawl || !Array.isArray((crawl as Record<string, unknown>).pages)) {
                throw new Error("crawlData missing pages array");
              }
              const discovery = site.discoveryData as unknown as DiscoveryData;
              const reextractStart = Date.now();
              console.info(JSON.stringify({
                event: "tree_reextraction_triggered",
                domain: site.domain,
                siteId,
                prior_state: site.geoTree == null ? "null" : "empty_or_sentinel",
              }));
              // FIND-023: extractTrees now returns a discriminated outcome. On
              // all-providers-failed, throw into the existing catch below (which
              // logs and, per ES-086 AC-24, deliberately writes no sentinel) so
              // this secondary rescue path degrades cleanly without persisting a
              // hollow tree.
              const treeOutcome = await extractTrees(crawl as unknown as CrawlData, discovery, site.domain);
              if (!treeOutcome.ok) throw new Error(`tree extraction failed: ${treeOutcome.reason}`);
              const trees = treeOutcome.trees;
              // ES-086 AC-23: removed isNull(geoTree) guard so rescue path can
              // overwrite the FIX-2 sentinel from a prior failed extraction.
              // Without this, the UPDATE would match 0 rows once any sentinel
              // exists and the populated trees would never persist.
              await db.update(geoSites).set({
                geoTree: trees.geoTree,
                categoryTree: trees.categoryTree,
                geoCategoryMapping: trees.mapping,
              }).where(eq(geoSites.id, siteId));
              (site as Record<string, unknown>).geoTree = trees.geoTree;
              (site as Record<string, unknown>).categoryTree = trees.categoryTree;
              (site as Record<string, unknown>).geoCategoryMapping = trees.mapping;
              console.info(JSON.stringify({
                event: "tree_reextraction_complete",
                domain: site.domain,
                siteId,
                geoLeaves: trees.geoTree.leafCount,
                catLeaves: trees.categoryTree.leafCount,
                mappingEntries: trees.mapping.totalEntries,
                latencyMs: Date.now() - reextractStart,
              }));
            } catch (err) {
              console.warn(`[citation-check] ${site.domain}: lazy tree extraction failed: ${(err as Error).message}`);
              // ES-086 AC-24: do NOT write a sentinel. Post-AC-15 the rescue
              // trigger detects empty trees structurally via treeIsEmpty(), so
              // a "don't retry" marker is unnecessary. Writing the sentinel
              // would lock the row to a malformed shape AND prevent the rescue
              // path's UPDATE from overwriting it on the next attempt. The
              // AC-22 semaphore caps the retry burst.
            } finally {
              activeReextractions--;
            }
          }
        }

        // ── ES-059: Brand keyword extraction (lazy) ──────────────────────────
        let brandKeywords = site.brandKeywords as BrandKeywords | null;
        if (!brandKeywords) {
          const bj = site.generatedBusinessJson as Record<string, unknown> | null;
          brandKeywords = extractBrandKeywords(site.domain, bj);
          await db.update(geoSites)
            .set({ brandKeywords })
            .where(and(eq(geoSites.id, siteId), isNull(geoSites.brandKeywords)));
          console.info(`[citation-check] ${site.domain}: brand keywords extracted (${brandKeywords.keywords.length} keywords, ambiguous=${brandKeywords.isAmbiguous})`);
        }

        // ── ES-059: Category extraction (lazy) ───────────────────────────────
        let extractedCategories = site.extractedCategories as ExtractedCategories | null;
        if (!extractedCategories) {
          extractedCategories = await extractCategoriesViaHaiku(
            site.domain,
            site.siteType ?? null,
            site.generatedBusinessJson as Record<string, unknown> | null,
            site.generatedLlmsTxt ?? null,
            site.crawlData,
            site.categoryTree as CategoryTree | null,
          );
          await db.update(geoSites)
            .set({ extractedCategories })
            .where(and(eq(geoSites.id, siteId), isNull(geoSites.extractedCategories)));
          console.info(`[citation-check] ${site.domain}: categories extracted (${extractedCategories.categories.length} categories, noun="${extractedCategories.entityNoun}", source=${extractedCategories.source})`);
        }

        // ── AC19: Persist siteType from businessJson.geo_profile.industry ───
        if (!site.siteType) {
          const bjIndustry = (site.generatedBusinessJson as { geo_profile?: { industry?: string } } | null)
            ?.geo_profile?.industry?.trim();
          if (bjIndustry) {
            await db.update(geoSites).set({ siteType: bjIndustry }).where(eq(geoSites.id, siteId));
            (site as Record<string, unknown>).siteType = bjIndustry;
            console.info(`[citation-check] ${site.domain}: site_type from businessJson: "${bjIndustry}"`);
          }
        }

        // ── Lazy site_type extraction: derive from llms.txt or crawl content ──
        if (!site.siteType) {
          const llmsTxt = (site.generatedLlmsTxt as string | null) ?? "";
          const crawlPages = (site.crawlData as { pages?: Array<{ pageType?: string; content?: string }> } | null)?.pages;
          const homeContent = crawlPages?.find(p => p.pageType === "homepage")?.content?.slice(0, 300) ?? "";
          const aboutContent = crawlPages?.find(p => p.pageType === "about")?.content?.slice(0, 300) ?? "";
          const textToSearch = llmsTxt.slice(0, 600) + " " + homeContent + " " + aboutContent;

          const match = textToSearch.match(/(?:is\s+(?:a|an)\s+|specializes?\s+in\s+|provides?\s+|offers?\s+|focused?\s+on\s+)([^.\n]{10,80})/i);
          if (match) {
            const extracted = match[1].trim().replace(/\s+/g, ' ');
            await db.update(geoSites).set({ siteType: extracted }).where(eq(geoSites.id, siteId));
            (site as Record<string, unknown>).siteType = extracted;
            console.info(`[citation-check] ${site.domain}: site_type extracted: "${extracted}"`);
          }
        }

        // ── ES-056 C12: Discover real prompts (non-blocking fallback) ─────────
        let realPromptDiscovery: import("@/lib/types/citation").RealPromptDiscovery[] = [];
        try {
          const catTree = site.categoryTree as CategoryTree | null;
          if (catTree && catTree.leafCount > 0) {
            const cityNames = extractTopCityNames(site.geoTree as GeoTree | null, 3);
            realPromptDiscovery = await discoverRealPrompts(
              catTree,
              cityNames.length > 0 ? { cityNames } : undefined,
              site.domain,
            );
          }
        } catch (err) {
          console.warn(`[citation-prompts] ${site.domain}: real prompt discovery failed, proceeding without`);
        }

        const prompts = await generatePrompts({
          domain: site.domain,
          siteType: site.siteType,
          geoScorecard: site.geoScorecard,
          executiveSummary: site.executiveSummary,
          crawlData: site.crawlData,
          geoTree: site.geoTree as GeoTree | null,
          categoryTree: site.categoryTree as CategoryTree | null,
          geoCategoryMapping: site.geoCategoryMapping as GeoCategoryMapping | null,
          generatedLlmsTxt: site.generatedLlmsTxt,
          generatedBusinessJson: site.generatedBusinessJson,
          realPromptHints: realPromptDiscovery,
          extractedCategories,   // ES-059
        });
        prompts.forEach(({ prompt, pillar, type: promptType }, i) =>
          send({ type: "prompt-generated", data: { prompt, index: i + 1, total: prompts.length, pillar, promptType } })
        );

        send({ type: "stage", data: { stage: "querying", progress: 15, message: "Querying AI providers" } });
        console.info(`[citation-check] ${site.domain} checkId=${checkId} starting`);

        const discoveredCompetitors = (site.discoveredCompetitors ?? []) as DiscoveredCompetitor[];
        const userCompetitors = (site.userCompetitors ?? []) as UserCompetitor[];

        // Merge: user competitors first (category: "direct"), then discovered
        const allCompetitors: DiscoveredCompetitor[] = [
          ...userCompetitors.map((c) => ({
            name: c.name,
            domain: c.domain,
            rank: 0,
            mentions: 0,
            category: "direct" as const,
          })),
          ...discoveredCompetitors,
        ];

        const categoryKeywords = extractedCategories?.categories ?? [];

        const result = await runCitationCheck(checkId, siteId, site.domain, prompts, {
          onAnalysisStart: (provider, prompt, promptIndex, totalPrompts, pillar, promptType) =>
            send({ type: "analysis-start", data: { provider, prompt, promptIndex, totalPrompts } }),
          onPartialResult: (provider, prompt, mentioned, position, sentiment) =>
            send({ type: "partial-result", data: { provider, prompt, mentioned, position, sentiment } }),
          onAnalysisComplete: (provider, prompt, status) =>
            send({ type: "analysis-complete", data: { provider, prompt, status } }),
        }, allCompetitors, brandKeywords, categoryKeywords, site.generatedLlmsTxt ?? null);

        send({ type: "stage", data: { stage: "persisting", progress: 90, message: "Saving results" } });

        // ── Tier 4: Competitive intelligence (ES-056 C11) ────────────────────
        // HP-157: pass allCompetitors so CompetitorEntry.domain can be populated
        // from the discovered-competitor source-of-truth instead of stuffing
        // the canonical brand name into the domain field.
        const { locationCompetitors, categoryCompetitors, dominanceMap } = aggregateCompetitorsByDimension(
          result.responses,
          prompts,
          site.domain,
          site.geoTree as GeoTree | null,
          site.categoryTree as CategoryTree | null,
          allCompetitors,
        );
        console.info(`[citation-check.location-competitors] ${site.domain}: locationCount=${locationCompetitors.length}`);
        console.info(`[citation-check.category-competitors] ${site.domain}: categoryCount=${categoryCompetitors.length}`);
        console.info(`[citation-check.dominance-map] ${site.domain}: entries=${dominanceMap.entries.length}`);

        // FIX-1: Generate dominance insights from the dominance map
        const dominanceInsights = generateDominanceInsights(
          dominanceMap,
          site.geoTree as GeoTree | null,
          site.categoryTree as CategoryTree | null,
        );

        // ── Tier 2: Dimensional aggregation (ES-054) ─────────────────────────
        const hasTreeData = site.geoTree || site.categoryTree;
        if (!hasTreeData) {
          console.log(`[citation-check] ${site.domain}: dimensional analysis skipped (no trees)`);
        }
        // aggregateByDimension handles null trees gracefully — still call it
        const { geoVisibility, categoryVisibility, tierVisibility } = aggregateByDimension(
          result.responses,
          prompts,
          site.geoTree as GeoTree | null,
          site.categoryTree as CategoryTree | null,
        );
        const visibilityGapAnalysis = generateVisibilityGapAnalysis(geoVisibility, categoryVisibility, tierVisibility);

        // avgImpressionShare: average of non-null impressionShare values from mentioned responses
        const mentionedWithShare = result.responses.filter(r => r.mentioned && r.impressionShare != null);
        const avgImpressionShare = mentionedWithShare.length > 0
          ? Math.round(mentionedWithShare.reduce((sum, r) => sum + (r.impressionShare ?? 0), 0) / mentionedWithShare.length)
          : null;

        // Crawl coverage report — store to geoSites if crawl data is available
        const crawlData = site.crawlData as CrawlData | null;
        const discoveryData = site.discoveryData as { totalPages: number } | null;
        if (crawlData && discoveryData) {
          const crawlCoverageReport = validateCrawlCoverage(
            { totalPages: discoveryData.totalPages },
            crawlData,
          );
          await db.update(geoSites)
            .set({ crawlCoverageReport })
            .where(eq(geoSites.id, siteId));
        }

        if (result.responses.length > 0) {
          await db.insert(citationCheckResponses).values(result.responses);
        }

        // V2 detection: indirect prompts have categoryId only in V2 path
        const promptArchitectureVersion = prompts.some(p => p.categoryId) ? 2 : 1;

        await db.insert(citationCheckScores).values({
          checkId,
          siteId,
          domain: site.domain,
          // GMC audit_purchase: derive teamId from customerEmail (Aditya rule
          // 2026-04-28). Non-purchase path uses the real site.teamId. The
          // NOT NULL column needs a value either way; the assert (!) on
          // site.teamId is preserved for the non-purchase path where the
          // earlier credit gate already ensured teamId is set.
          teamId: isPurchaseAuth ? purchaseTeamId! : site.teamId!,
          overallVisibility:    result.overallVisibility,
          bestProvider:         result.bestProvider,
          worstProvider:        result.worstProvider,
          avgPosition:          result.avgPosition,
          sentimentScore:       result.sentimentScore,
          providerResults:      result.providerResults,
          competitorVisibility: {},                    // deprecated
          competitorData:       result.competitorData,
          pillarVisibility:     result.pillarVisibility,
          pillarQA:             result.pillarQA,
          indirectVisibility:   result.indirectVisibility,
          brandKnowledge:       result.brandKnowledge,
          citationQualityScore: result.citationQualityScore,
          creditsUsed:          CITATION_CHECK_COST,
          promptsUsed:          prompts.map(p => p.prompt),
          promptMetadata:       prompts,
          geoVisibility,
          categoryVisibility,
          tierVisibility,
          avgImpressionShare,
          visibilityGapAnalysis,
          locationCompetitors:    locationCompetitors,
          categoryCompetitors:    categoryCompetitors,
          dominanceMap:           { ...dominanceMap, insights: dominanceInsights },
          realPromptDiscovery:        realPromptDiscovery.length > 0 ? realPromptDiscovery : null,
          promptArchitectureVersion,
        });

        const elapsedMs = Date.now() - streamStart;
        console.info(`[citation-check] ${site.domain} done: visibility=${result.overallVisibility}% in ${elapsedMs}ms`);

        send({
          type: "complete",
          data: {
            checkId,
            scores: {
              overallVisibility:    result.overallVisibility,
              indirectVisibility:   result.indirectVisibility,
              brandKnowledge:       result.brandKnowledge,
              citationQualityScore: result.citationQualityScore,
              bestProvider:         result.bestProvider,
              worstProvider:        result.worstProvider,
              avgPosition:          result.avgPosition,
              sentimentScore:       result.sentimentScore,
              competitorData:       result.competitorData,
              pillarVisibility:     result.pillarVisibility,
              pillarQA:             result.pillarQA,
              // TS-057 B1: Tier 2-4 dimensional intelligence fields
              geoVisibility,
              categoryVisibility,
              tierVisibility,
              avgImpressionShare,
              visibilityGapAnalysis,
              locationCompetitors,
              categoryCompetitors,
              dominanceMap: { ...dominanceMap, insights: dominanceInsights },
              realPromptDiscovery: realPromptDiscovery.length > 0 ? realPromptDiscovery : null,
              // ES-086 AC-22: surface the deferred flag so the dashboard can
              // show "Dimensional data is regenerating — your next citation
              // check will include geographic and category breakdowns."
              treeReextractionDeferred,
            },
            providerResults: result.providerResults,
            promptsUsed:     prompts.map(p => p.prompt),
            creditsUsed:     CITATION_CHECK_COST,
            promptArchitectureVersion,
          },
        });
        // ── ES-055 C10: Engine preference analysis (non-blocking) ──
        // PLATFORM: Vercel Node.js keeps process alive after response send (maxDuration).
        //           This will NOT work on AWS Lambda or standalone Node.js deployments.
        void Promise.race([
          analyzeEnginePreferences(site.domain, siteId).then(enginePreferences => {
            if (enginePreferences) {
              return db.update(geoSites)
                .set({ enginePreferences })
                .where(eq(geoSites.id, siteId));
            }
          }),
          new Promise<void>(resolve => setTimeout(resolve, 30_000)),
        ]).catch(err => {
          console.error(`[engine-prefs] fire-and-forget failed for ${site.domain}:`, err);
        });

      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        send({ type: "error", data: { message } });
        console.error("[citation-check] Error:", err);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
    },
  });
}

// ── ES-054: Visibility Gap Analysis ─────────────────────────────────────────

/**
 * Generate gap entries for dimensions with visibility < 10%.
 * Sorted by worst visibility first, capped at 10 entries.
 */
export function generateVisibilityGapAnalysis(
  geoVisibility: GeoVisibility[],
  categoryVisibility: CategoryVisibility[],
  tierVisibility: TierVisibility[],
): VisibilityGapEntry[] {
  const entries: VisibilityGapEntry[] = [];

  for (const geo of geoVisibility) {
    if (geo.visibility < 10) {
      entries.push({
        dimension: "geo",
        id: geo.geoId,
        name: geo.geoName,
        visibility: geo.visibility,
        gap: `Your ${geo.geoName} presence is invisible to AI.`,
        recommendation: `Add structured data and FAQ content to ${geo.geoName} location pages.`,
      });
    }
  }

  for (const cat of categoryVisibility) {
    if (cat.visibility < 10) {
      entries.push({
        dimension: "category",
        id: cat.categoryId,
        name: cat.categoryName,
        visibility: cat.visibility,
        gap: `AI rarely recommends you for ${cat.categoryName}.`,
        recommendation: `Your ${cat.categoryName} pages lack expert quotes and case studies.`,
      });
    }
  }

  const tierLabels: Record<string, string> = {
    buy: "Buy",
    solve: "Solve",
    learn: "Learn",
  };
  const tierGapText: Record<string, string> = {
    buy: "AI doesn't recommend you for purchase-intent queries",
    solve: "AI doesn't connect your brand to problem-solving",
    learn: "AI doesn't cite your brand for informational queries",
  };
  const tierRecoText: Record<string, string> = {
    buy: "Strengthen product positioning and comparison content",
    solve: "Add how-to and use-case content for your service areas",
    learn: "Add educational content, guides, and thought leadership",
  };
  for (const tier of tierVisibility) {
    if (tier.visibility < 10) {
      entries.push({
        dimension: "tier",
        id: tier.tier,
        name: tierLabels[tier.tier] ?? tier.tier,
        visibility: tier.visibility,
        gap: tierGapText[tier.tier] ?? `Low ${tier.tier} intent visibility`,
        recommendation: tierRecoText[tier.tier] ?? "Add content targeting this intent tier",
      });
    }
  }

  // Sort by visibility ascending (worst gaps first)
  entries.sort((a, b) => a.visibility - b.visibility);

  // Cap at 10
  return entries.slice(0, 10);
}
