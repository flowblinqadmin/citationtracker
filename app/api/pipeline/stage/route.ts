/**
 * POST /api/pipeline/stage
 *
 * Auth: QStash upstash-signature header, OR Authorization: Bearer <CRON_SECRET>
 *       for local dev and the cron safety-net.
 *
 * Always returns 200 — failures are written to DB. Returning non-200 would cause
 * QStash to retry, potentially re-crawling the same site (retries: 0 prevents this,
 * but defense-in-depth is to always return 200).
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { Receiver } from "@upstash/qstash";
import { db } from "@/lib/db";
import { geoSites, teams, creditTransactions, firecrawlJobs, auditPurchases, citationCheckScores } from "@/lib/db/schema";
import { eq, sql, and, isNull, isNotNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  discoverSite,
  detectFlowblinqAssets,
  computeChunks,
  mapDocumentToPage,
  normalizeUrlForComparison,
  scoreCrawlQuality,
  classifyPageType,
  type FcDoc,
  type CrawledPage,
  type CrawlData,
  type DiscoveryData,
} from "@/lib/services/geo-crawler";
import { FirecrawlAppV1 } from "@mendable/firecrawl-js";
import { gatherCompetitiveIntel } from "@/lib/services/competitive-intel";
import { analyzeGeoGaps, type GeoScorecard } from "@/lib/services/geo-analyzer";
import { autoDiscoverBrandPages } from "@/lib/services/auto-discover-brand-pages";
import {
  generateLlmsTxt,
  generateBusinessJson,
  generateSitewideSchemaBlocks,
  generatePerPageFaqBlocks,
  generateArticleBlocks,
  generateRobotsTxtBlock,
  sanitizeLlmsTxt,
  sanitizeBusinessJson,
  RetryValidationExhausted,
} from "@/lib/services/content-generator";
import { assembleResults, checkGeneratedContent, checkExecutiveSummary } from "@/lib/services/assembler";
import { sendCompletionEmail, sendPipelineFailedEmail, sendAuditPurchaseDeliveryEmail, sendAuditPurchaseFailedEmail, sendInternalPaymentAlert } from "@/lib/email";
import { renderAuditPdfBuffer } from "@/lib/services/audit-pdf-handler";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { extractPerPageVulnerabilities } from "@/lib/services/per-page-analyzer";
import { generatePerPageFixes, type PerPageFix } from "@/lib/services/page-fix-generator";
import { computeImplementationTracking, type ImplementationStatus } from "@/lib/services/implementation-tracker";
import { bulkCreditsRequired, POLL_CHUNK_INTERVAL_S, POLL_CHUNK_CIRCUIT_BREAKER_MS } from "@/lib/config";
import Stripe from "stripe";
import { enqueueStage, type StagePayload, type PipelineStage, type GenerateChunkType } from "@/lib/qstash";
import { getCrawlMode, type CrawlMode } from "@/lib/crawl-mode";
import { extractTrees } from "@/lib/services/tree-extractor";
import { detectArchitecture, prioritizeUrls } from "@/lib/services/crawl-prioritizer";
import { aggregateStrategyReport } from "@/lib/services/content-strategy-scorer";
// sync to geo_site_view handled by Postgres trigger — no application sync needed

/** One-way hash for PII redaction in structured logs (Fix I / Fix #30). */
function emailHash(email: string): string {
  return createHash("sha256").update(email).digest("hex").slice(0, 16);
}

// discover:        Firecrawl mapUrl (~15s) + light page classification — 60s is comfortable
// crawl-fanout:    submit Firecrawl batch jobs + enqueue poll-chunk jobs — 120s for large sites
// poll-chunk:      Firecrawl status check (~2s) + fan-in counter — 30s
// merge-crawl:     flatten chunks + quality check + write crawlData — 30s
// research:        Claude API competitive intel (~30s) — 60s
// analyze:         Claude API 8-pillar analysis (~45s) — 120s
// generate-fanout: fan out 5 generate-chunk messages — <5s
// generate-chunk:  one asset type (llms|business|schema-*), each ~30s — well within 105s
// assemble:        Claude API executive summary (~30s) + bulk reconciliation — 90s
// Issue R (2026-04-27): bumped 300 → 800 (Pro plan Fluid Compute ceiling).
// 300s could not fit a sequential Sonnet (200s) + OpenAI (200s) chain in
// extract-trees on slow Anthropic days; outer stageTimeout fired before
// OpenAI could complete, marking the pipeline failed despite a valid
// fallback being available. 800s gives headroom for the worst-case 3-attempt
// chain (Sonnet temp=0 → Sonnet temp=0.3 → OpenAI = up to 600s) plus
// validation + DB-write tail. citation-check at 600s already proves Pro
// supports >300s.
export const maxDuration = 800;

// ── Helpers ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ResearchData = any;

interface ChangeLogEntry {
  runAt: string;
  overallScore: number;
  projectedScore: number;
  crawlQuality: {
    goodPages: number;
    errorPages: number;
    coverageScore: number;
    blockedByAntiBot: boolean;
    usable: boolean;
  };
  pillarScores: Record<string, number>;
}

async function updateStatus(
  siteId: string,
  status: string,
  extra?: Record<string, unknown>
): Promise<void> {
  await db
    .update(geoSites)
    .set({ pipelineStatus: status, updatedAt: new Date(), ...extra })
    .where(eq(geoSites.id, siteId));
}

/**
 * markFailed wrapped with one retry on the DB-write itself. If the first call
 * throws (transient DB outage), wait 1s and retry; on the second failure
 * re-throw so the outer catch can log it and the QStash redelivery can take
 * another attempt. Bounded — total retries (markFailed × 2) × QStash retry
 * cap (typically 3) keeps blast radius finite.
 *
 * AC-B1-3 retry-then-rethrow relies on QStash retry cap (typically 3);
 * compound retry count is bounded.
 */
async function markFailedWithRetry(siteId: string, error: unknown): Promise<void> {
  try {
    await markFailed(siteId, error);
  } catch (firstErr) {
    console.error(`[stage] markFailed failed for site ${siteId}, retrying once:`, firstErr);
    await new Promise((r) => setTimeout(r, 1000));
    await markFailed(siteId, error);
  }
}

async function markFailed(siteId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[stage] Marking site ${siteId} failed:`, message);

  // Fetch site to check for reserved credits to refund
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  const reserved = (site?.creditsReserved as number | null) ?? 0;

  await db
    .update(geoSites)
    .set({
      pipelineStatus: "failed",
      pipelineError: message,
      creditsReserved: null,
      crawlJobIds: null,
      crawlChunksDone: null,
      crawlChunksTotal: null,
      crawlChunkResults: null,
      updatedAt: new Date(),
    })
    .where(eq(geoSites.id, siteId));

  // Refund reserved credits on failure
  if (reserved > 0 && site?.teamId) {
    const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
    if (team) {
      const balanceBefore = team.creditBalance;
      await db.update(teams)
        .set({ creditBalance: sql`${teams.creditBalance} + ${reserved}`, updatedAt: new Date() })
        .where(eq(teams.id, site.teamId));
      await db.insert(creditTransactions).values({
        id: nanoid(),
        teamId: site.teamId,
        siteId,
        type: "crawl_refund",
        pagesConsumed: 0,
        creditsChanged: reserved,
        balanceBefore,
        balanceAfter: balanceBefore + reserved,
        createdAt: new Date(),
      });
      console.warn(`[stage] Refunded ${reserved} credits to team ${site.teamId} (pipeline failed)`);
    }
  }

  // Non-blocking failure email
  if (site?.ownerEmail) {
    const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
    sendPipelineFailedEmail(site.ownerEmail, site.domain ?? siteId, `${appBase}/dashboard`)
      .catch((e) => console.warn("[stage] Pipeline failure email failed:", e));
  }

  // Task 7.5 — audit_purchase failure path: update purchase status, refund, alert + email
  try {
    const [failedPurchase] = await db
      .select()
      .from(auditPurchases)
      .where(eq(auditPurchases.siteId, siteId));

    if (failedPurchase && failedPurchase.status !== "delivered" && failedPurchase.status !== "refunded") {
      // Fix F: DB-level CAS guard — atomically transition status from "failed" (or similar) to
      // "refund_pending" before calling Stripe. QStash retries would otherwise re-issue the refund
      // and re-send the customer email on every retry invocation.
      // We can only set "failed" first (status update), then attempt CAS to "refund_pending".
      await db.update(auditPurchases)
        .set({ status: "failed", updatedAt: new Date() })
        .where(and(eq(auditPurchases.id, failedPurchase.id), eq(auditPurchases.status, failedPurchase.status)));

      // CAS: only the invocation that wins the race from "failed" → "refund_pending" proceeds.
      // Use .returning() instead of rowCount — PgBouncer/Drizzle-postgres doesn't populate rowCount
      // on UPDATE, causing the ?? 1 fallback to always pass. Array length is the unambiguous truth.
      const updated = await db.update(auditPurchases)
        .set({ status: "refund_pending", updatedAt: new Date() })
        .where(and(eq(auditPurchases.id, failedPurchase.id), eq(auditPurchases.status, "failed")))
        .returning({ id: auditPurchases.id });

      if (updated.length !== 1) {
        // Another invocation already owns this refund path — skip to prevent duplicate email + refund
        console.warn(JSON.stringify({ event: "audit_purchase_refund_skip_cas_lost", siteId, purchaseId: failedPurchase.id }));
      } else {
        // Internal ops alert
        sendInternalPaymentAlert({
          customerEmail: failedPurchase.customerEmail,
          type: "audit_purchase_failed",
          domain: failedPurchase.domain ?? undefined,
          note: `Pipeline markFailed for siteId=${siteId}`,
          timestamp: new Date().toISOString(),
        }).catch((e) => console.warn("[stage] audit_purchase_failed alert failed:", e));

        // Customer email: apology + refund notice (before Stripe call so customer isn't left hanging)
        if (failedPurchase.domain) {
          sendAuditPurchaseFailedEmail(failedPurchase.customerEmail, failedPurchase.domain, failedPurchase.amountCents ?? 1000)
            .catch((e) => console.warn("[stage] audit purchase failed email failed:", e));
        }

        // Issue Stripe refund (server-side only)
        if (failedPurchase.stripePaymentIntentId) {
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");
          try {
            // Fix H: pin refund amount to amountCents so Stripe Tax portion stays with Stripe
            const refund = await stripe.refunds.create({
              payment_intent: failedPurchase.stripePaymentIntentId,
              amount: failedPurchase.amountCents ?? 1000,
            });
            console.log(JSON.stringify({ event: "audit_purchase_refund_issued", refundId: refund.id, amountCents: failedPurchase.amountCents ?? 1000 }));
            // Note: the subsequent charge.refunded webhook will flip status to "refunded" — idempotent
          } catch (refundErr) {
            console.error(`[stage] Stripe refund FAILED for audit purchase ${failedPurchase.id}:`, refundErr);
            sendInternalPaymentAlert({
              customerEmail: failedPurchase.customerEmail,
              type: "audit_purchase_refund_failed",
              domain: failedPurchase.domain ?? undefined,
              note: `Stripe refund call failed: ${String(refundErr).slice(0, 200)}`,
              timestamp: new Date().toISOString(),
            }).catch((e) => console.warn("[stage] refund_failed alert failed:", e));
          }
        }
      }
    }
  } catch (auditPurchaseErr) {
    console.error(`[stage] audit_purchase failure-path handling failed for siteId=${siteId}:`, auditPurchaseErr);
  }
}

/**
 * Retries `fn()` up to `maxAttempts` times, calling `check()` after each attempt.
 *
 * @throws {RetryValidationExhausted} when the validator fails on the final attempt
 *   (regardless of `maxAttempts`). Callers must allow this throw to propagate so
 *   the stage-level retry / markFailed logic can handle it. Catching and swallowing
 *   the throw at the call site WILL persist invalid data — see TS-082 §2.3 for
 *   the production incident this prevents.
 *
 * @see ES-082 §3.2 AC-4/5/6
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  check: (result: T) => { passed: boolean; failures: string[] },
  maxAttempts = 3
): Promise<T> {
  let lastFailures: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fn();
    const { passed, failures } = check(result);
    if (passed) {
      if (attempt > 1) console.warn(`[stage] ${label} passed on attempt ${attempt}`);
      return result;
    }
    lastFailures = failures;
    console.warn(`[stage] ${label} check failed (attempt ${attempt}/${maxAttempts}): ${failures.join("; ")}`);
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  // ES-082 §3.2 AC-4/5/6 — unified throw on final-attempt validation failure.
  // Replaces the previous silent fall-through "using best result" path which
  // corrupted data (Manipal incident — see TS-082 §2.3).
  console.warn(JSON.stringify({
    event: "withRetry_validation_exhausted",
    label,
    attempts: maxAttempts,
    failures: lastFailures,
    max_attempts: maxAttempts,
  }));
  throw new RetryValidationExhausted(label, maxAttempts, lastFailures);
}

// Stage-level deadline: fires 15 s before Vercel's 120 s hard kill so the
// catch block in POST() can run markFailed() before the process is terminated.
//
// Stage-level deadline must fire ~15s BEFORE the function-level maxDuration
// declared at the top of this file, so the catch block in POST() can run
// markFailed() before Vercel's hard kill terminates the process.
//
// Issue Q (2026-04-10): bumped 600_000 → 285_000 + maxDuration 120 → 300.
// Root cause: Issue M raised STAGE_TIMEOUT_MS to 600_000 (10 min) but left
// maxDuration at 120s, so the internal Promise.race timer was useless —
// Vercel killed the function at 120s before the internal timer ever fired.
// Customer site -GzFX1KcKhmN0W_1t8SmY went stuck for 15+ min at "extracting"
// because Manipal's extract-trees on Sonnet took >120s, hit Vercel's hard
// kill, no markFailed ran, status stayed at "extracting" forever (QStash
// configured with retries: 0). Confirmed via QStash event API: state=ERROR,
// responseStatus=504, responseBody="FUNCTION_INVOCATION_TIMEOUT".
//
// Issue R (2026-04-27): bumped 285_000 → 785_000 alongside maxDuration 300 →
// 800. Manipalhospitals.com Q1p8tJeIQyHWmbe6TDCfD failed at 23:23:54 UTC with
// "extract-trees stage timed out after 285s" after 3 retries because:
//   - Sonnet attempt1 (200s ceiling) hit its own internal timeout
//   - classifySonnetError → schema/network/other → attempt2 fires
//   - attempt2 also burns ~200s before OpenAI gets to run
//   - 285s outer budget can't fit attempt1 (200s) + attempt2 (200s) + OpenAI
//     (200s) = 600s sequential. Outer timeout fires before OpenAI completes.
// 785s gives the full 3-attempt chain room to run, leaving 15s buffer for
// markFailed before Vercel's 800s hard kill.
//
// Paired with removing extract-trees from retryableStages (line 1364) — with
// 785s of internal budget, the handler's 3-attempt fallback chain handles
// transient failures. Stage-level retries on top would re-burn the same
// budget on the same failure mode (3× compute, same outcome).
const STAGE_TIMEOUT_MS = 785_000;
function stageTimeout(stage: string): Promise<never> {
  return new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`${stage} stage timed out after ${STAGE_TIMEOUT_MS / 1000}s`)),
      STAGE_TIMEOUT_MS
    )
  );
}

// ── Stage handlers ────────────────────────────────────────────────────────────

/**
 * Resolve the page budget for the discover stage (BUG-001 / FIX-007).
 *
 * The StagePayload union now makes maxPages a compile-time requirement on
 * enqueue('discover'), but the payload reaches this handler as JSON off QStash
 * (types erased) and legacy queued messages may predate the union — so we
 * still defend at runtime. Trust an explicit positive payload budget; else
 * fall back to the budget persisted on the row (site.crawlLimit); else throw
 * so the POST handler's catch marks the audit failed. We NEVER silently fall
 * back to FREE_MAX_PAGES — that fallback was the literal Pro-20-pages bug.
 */
function resolveDiscoverBudget(
  siteId: string,
  payloadMaxPages: number | undefined,
  crawlLimit: number | null,
): number {
  if (typeof payloadMaxPages === "number" && payloadMaxPages > 0) return payloadMaxPages;
  if (typeof crawlLimit === "number" && crawlLimit > 0) return crawlLimit;
  throw new Error(
    `[stage:discover] site=${siteId}: no page budget resolved ` +
      `(payload.maxPages and site.crawlLimit both absent/non-positive). ` +
      `Refusing to silently cap at the free-tier limit.`,
  );
}

async function handleDiscover(siteId: string, domain: string, payloadMaxPages: number | undefined): Promise<void> {
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) throw new Error("Site not found");

  const maxPages = resolveDiscoverBudget(siteId, payloadMaxPages, site.crawlLimit as number | null);

  // Snapshot previous run before overwriting (for diff view)
  const hasPreviousRun = site.geoScorecard != null;
  const previousRunSnapshot = hasPreviousRun ? {
    snapshotAt: new Date().toISOString(),
    geoScorecard: site.geoScorecard,
    executiveSummary: site.executiveSummary,
    generatedLlmsTxt: site.generatedLlmsTxt,
    generatedBusinessJson: site.generatedBusinessJson,
    generatedSchemaBlocks: site.generatedSchemaBlocks,
    recommendations: site.recommendations,
  } : null;
  const shareToken = site.shareToken ?? nanoid(24);

  // Snapshot per-page fixes for implementation tracking on re-audit
  const previousPerPageFixes = site.perPageFixes ? { previousPerPageFixes: site.perPageFixes } : {};

  await updateStatus(siteId, "discovery");
  const discoveryData = await discoverSite(domain, maxPages);

  // C1: Prioritize URLs based on site architecture
  const architecture = detectArchitecture(discoveryData.urls);
  const prioritizedUrls = prioritizeUrls(discoveryData.urls, architecture, site.siteType ?? undefined, maxPages);
  discoveryData.urls = prioritizedUrls;
  (discoveryData as any).siteArchitecture = architecture;
  discoveryData.totalPages = prioritizedUrls.length;

  await updateStatus(siteId, "discovery", {
    discoveryData: discoveryData as unknown as Record<string, unknown>,
    shareToken,
    ...(previousRunSnapshot
      ? { previousRunSnapshot: previousRunSnapshot as unknown as Record<string, unknown> }
      : {}),
    ...previousPerPageFixes,
  });

  console.warn(`[stage:discover] ${domain}: ${Object.keys(discoveryData.pageMap).length} pages mapped, ${prioritizedUrls.length} URLs prioritized`);
  await enqueueStage({ siteId, domain, stage: "crawl-fanout" });
}

// FIND-SILENTFAILURE-018: minimum fraction of crawl chunks that must successfully
// submit to Firecrawl before the pipeline proceeds. Below this, the crawl would
// deliver a heavily-partial audit (most pages never crawled) as "complete".
const CRAWL_FANOUT_MIN_SUBMIT_RATIO = 0.5;

async function handleCrawlFanout(siteId: string, domain: string): Promise<void> {
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) throw new Error("Site not found");

  let urls: string[];
  let pageMap: Record<string, string>;
  let autoDiscoveredCount = 0; // ES-083 AC-8

  if (site.auditMode === "bulk") {
    // ES-B10 AC-B10-4: URL source ordering for in-place rerun:
    //   1. retrySubsetUrls (non-null, non-empty) — retry-failed run picks
    //      only the previously-failed subset.
    //   2. bulkUrls — full re-audit (regenerate or initial bulk).
    //   3. discoveryData.urls — single-mode (handled below).
    // autoDiscoverBrandPages only fires on full bulk re-audits, NOT on
    // retry-failed runs (the retry subset is the user's intent; widening
    // it would charge for URLs they did not ask to retry).
    const retrySubset = (site.retrySubsetUrls as string[] | null) ?? null;
    const isRetryFailedRun =
      site.currentRunKind === "retry-failed" && Array.isArray(retrySubset) && retrySubset.length > 0;

    const sourceUrls = isRetryFailedRun
      ? (retrySubset as string[])
      : ((site.bulkUrls as string[] | null) ?? []);
    const crawlLimit = (site.crawlLimit as number | null) ?? sourceUrls.length;
    let urlsToProcess = sourceUrls.slice(0, crawlLimit);

    // ES-083 AC-9 + AC-10 + AC-11: auto-discover brand-level pages BEFORE
    // building pageMap. Fail-soft per AC-11. ES-B10 AC-B10-4: skip on
    // retry-failed runs.
    let autoDiscovered: string[] = [];
    if (!isRetryFailedRun) {
      try {
        const discoveryStart = Date.now();
        autoDiscovered = await autoDiscoverBrandPages(urlsToProcess);
        const discoveryMs = Date.now() - discoveryStart;
        console.info(JSON.stringify({
          event: "bulk_auto_discover_complete",
          domain,
          added: autoDiscovered.length,
          latencyMs: discoveryMs,
        }));
      } catch (err) {
        console.warn(JSON.stringify({
          event: "bulk_auto_discover_failed",
          domain,
          errMsg: (err as Error).message ?? String(err),
        }));
        autoDiscovered = [];
      }
    }

    autoDiscoveredCount = autoDiscovered.length;
    urlsToProcess = [...urlsToProcess, ...autoDiscovered];

    pageMap = {};
    // ES-085 §b.1 Hypothesis A fix: classify each URL via classifyPageType
    // (was hardcoded to "other" pre-ES-085 — that one-line regression
    // suppressed dimensional intelligence on every bulk audit). The classifier
    // is the same one single-mode discoverSite uses, so bulk and single
    // modes now produce equivalent pageMap structures.
    for (const url of urlsToProcess) pageMap[url] = classifyPageType(url);

    // Issue-A fix: populate FlowBlinq-asset detection fields that bulk-mode was
    // missing entirely. Pre-fix this synthetic object hardcoded
    // hasLlmsTxt/hasUcp/hasSitemap/hasRobots to false and omitted
    // ownLlmsTxt / flowblinqGeneratedSchemaBlocks / installedFromFlowblinq /
    // wwwRedirectStatus, causing every bulk-audit customer to score as if they
    // had no FlowBlinq integration installed (the geo-analyzer prompt at
    // geo-analyzer.ts:277-291 reads these fields to surface "GEO files
    // published by this site" to the LLM). Single-mode discoverSite() always
    // populated them via the same helper now extracted to detectFlowblinqAssets.
    //
    // Issue-J fix (2026-04-10): derive the probe hostname from the customer's
    // uploaded URLs, not the bare `geo_sites.domain` column. Bulk customers
    // frequently upload URLs under a canonical www. variant (Manipal is the
    // reference case — all 255 URLs are www.manipalhospitals.com) while the
    // domain column stores the bare form. Probing the bare host can fail
    // entirely if the bare hostname has no HTTPS listener — Manipal's bare
    // domain returns HTTP 000 (connection timeout) on every request, while
    // www.manipalhospitals.com serves llms.txt / sitemap.xml / robots.txt
    // normally. Single-mode discoverSite dodges this because it crawls the
    // site first and follows redirects to find the canonical hostname before
    // probing. Bulk-mode skips the crawl and must derive the canonical host
    // from the URL list the customer uploaded. Fallback to the bare `domain`
    // column if parsing fails.
    const probeHost = (() => {
      try {
        const first = urlsToProcess[0];
        if (!first) return domain;
        return new URL(first).hostname;
      } catch {
        return domain;
      }
    })();
    const flowblinqAssets = await detectFlowblinqAssets(probeHost);

    const syntheticDiscovery: DiscoveryData = {
      urls: urlsToProcess,
      pageMap: pageMap as Record<string, import("@/lib/services/geo-crawler").PageType>,
      hasLlmsTxt: flowblinqAssets.hasLlmsTxt,
      hasUcp: flowblinqAssets.hasUcp,
      hasSitemap: flowblinqAssets.hasSitemap,
      hasRobots: flowblinqAssets.hasRobots,
      totalPages: urlsToProcess.length,
      ownLlmsTxt: flowblinqAssets.finalLlmsTxt,
      ownSchemaJson: flowblinqAssets.finalSchemaJson,
      ownBusinessJson: flowblinqAssets.finalBusinessJson,
      flowblinqGeneratedSchemaBlocks: flowblinqAssets.flowblinqGeneratedSchemaBlocks,
      installedFromFlowblinq: flowblinqAssets.installedFromFlowblinq,
      wwwRedirectStatus: flowblinqAssets.wwwRedirectStatus,
      sitemapStale: false,
      urlsNotInSitemap: [],
      // FIND-033: carry the tri-state fetch-failure flags into bulk-mode too.
      llmsTxtFetchFailed: flowblinqAssets.llmsTxtFetchFailed,
      schemaFetchFailed: flowblinqAssets.schemaFetchFailed,
      businessFetchFailed: flowblinqAssets.businessFetchFailed,
    };
    await db.update(geoSites).set({
      discoveryData: syntheticDiscovery as unknown as Record<string, unknown>,
      // ES-083 AC-8: persist count alongside discoveryData (single transaction).
      autoDiscoveredUrlCount: autoDiscoveredCount,
      updatedAt: new Date(),
    }).where(eq(geoSites.id, siteId));
    urls = urlsToProcess;
  } else {
    const discoveryData = site.discoveryData as DiscoveryData | null;
    if (!discoveryData) throw new Error("No discovery data — discover stage may not have completed");
    urls = Object.keys(discoveryData.pageMap);
    pageMap = discoveryData.pageMap as Record<string, string>;
  }

  const { numChunks, chunkSize } = computeChunks(urls.length);
  if (numChunks === 0) throw new Error("No URLs to crawl");

  // Write fan-out coordination state before submitting chunks.
  // crawlChunksTotal is set UP-FRONT to numChunks (poll-first, tunnel-independent):
  // in LOCAL_PIPELINE mode enqueueStage runs the poll-chunk inline DURING this
  // loop, so the fan-in counter must see a non-zero total before the first poll
  // runs — otherwise done increments against total=0 and merge-crawl never fires
  // (the bulk-audit stall). Failed submissions are fanned-in immediately in the
  // catch below so done can still reach total. Prod (async QStash) is unaffected.
  await db.update(geoSites).set({
    pipelineStatus: "crawling",
    crawlChunksDone: 0,
    crawlChunksTotal: numChunks,
    crawlChunkResults: null,
    crawlFailedUrls: null,
    crawlStartedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(geoSites.id, siteId));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fc = new FirecrawlAppV1({ apiKey: process.env.FIRECRAWL_API_KEY! }) as any;

  let successfulChunks = 0;
  const submissionFailedUrls: string[] = [];

  for (let i = 0; i < numChunks; i++) {
    const chunkUrls = urls.slice(i * chunkSize, (i + 1) * chunkSize);
    if (chunkUrls.length === 0) continue; // ceil() rounding can produce empty trailing chunks
    try {
      // Perf: use Firecrawl webhook instead of poll-chunk loop (HP perf review Fix 2).
      // Falls back to poll-chunk if PIPELINE_CALLBACK_URL is not set.
      const callbackBase = process.env.PIPELINE_CALLBACK_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
      const webhookUrl = callbackBase ? `${callbackBase}/api/pipeline/crawl-webhook` : "";
      // C3: CRON_SECRET is validated at module load by lib/cron-auth.ts;
      // import via getCronSecret() to make the dependency explicit and avoid
      // silent `?? ""` fallbacks that mask misconfiguration.
      const { getCronSecret } = await import("@/lib/cron-auth");
      const webhookConfig = webhookUrl ? {
        url: webhookUrl,
        headers: { "x-webhook-secret": getCronSecret() },
        metadata: { siteId, domain, chunkIndex: String(i) },
        events: ["completed" as const, "failed" as const],
      } : undefined;

      const result = await fc.asyncBatchScrapeUrls(
        chunkUrls,
        { formats: ["markdown", "rawHtml"] },
        undefined, // idempotencyKey
        webhookConfig,
      ) as { id: string };
      const fcJobId = result.id;

      await db.insert(firecrawlJobs).values({
        id: nanoid(),
        siteId,
        firecrawlJobId: fcJobId,
        chunkIndex: i,
        urlCount: chunkUrls.length,
        status: "scraping",
        urlsSubmitted: chunkUrls,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Always enqueue poll-chunk as a safety net — if the webhook fires first
      // the poll will find the chunk already fan-in'd and no-op. If the webhook
      // fails (tunnel down, Firecrawl delivery error), the poll recovers.
      await enqueueStage({
        siteId,
        domain,
        stage: "poll-chunk",
        chunkIndex: i,
        firecrawlJobId: fcJobId,
      }, POLL_CHUNK_INTERVAL_S);

      successfulChunks++;
      console.warn(`[stage:crawl-fanout] ${domain}: chunk ${i}/${numChunks} submitted (${chunkUrls.length} URLs, job ${fcJobId}, webhook=${!!webhookConfig})`);
    } catch (err) {
      console.error(`[stage:crawl-fanout] ${domain}: chunk ${i} submission failed:`, err);
      submissionFailedUrls.push(...chunkUrls);
      // No poll-chunk was enqueued for this chunk — fan it in NOW (as abandoned)
      // so `done` can still reach `total` (= numChunks, set up-front). fanInChunk
      // is atomic, so exactly one caller (this catch OR a poll) observes
      // done===total — no double merge. Only trigger merge if at least one chunk
      // succeeded; an all-failed crawl is handled by markFailed after the loop.
      const { done, total } = await fanInChunk(siteId, [], chunkUrls);
      if (done === total && successfulChunks > 0) {
        await enqueueStage({ siteId, domain, stage: "merge-crawl" });
      }
    }
  }

  if (successfulChunks === 0) {
    await markFailed(siteId, `All ${numChunks} chunk submissions failed for ${domain}`);
    return;
  }

  // FIND-SILENTFAILURE-018: fail loudly when only a minority of chunks submitted.
  // Failed-chunk URLs land in crawlFailedUrls, but the audit would otherwise be
  // driven to "complete" missing the bulk of the site's pages. merge-crawl's
  // scoreCrawlQuality gate only sees the pages that DID crawl, so it cannot tell
  // that most chunks never ran — this is the loud signal for that case.
  if (successfulChunks / numChunks < CRAWL_FANOUT_MIN_SUBMIT_RATIO) {
    await markFailed(
      siteId,
      `Crawl submission incomplete: only ${successfulChunks}/${numChunks} chunks submitted ` +
        `for ${domain} (${submissionFailedUrls.length} URLs not crawled). ` +
        `Refusing to deliver a heavily-partial audit.`,
    );
    return;
  }

  // total was set up-front to numChunks; submission-failed chunks were fanned-in
  // (and their URLs recorded) in the catch above, so done still reaches total.
  console.warn(`[stage:crawl-fanout] ${domain}: ${successfulChunks}/${numChunks} chunks submitted, ${submissionFailedUrls.length} URLs failed at submission`);
}

async function fanInChunk(
  siteId: string,
  pages: CrawledPage[],
  failedUrls: string[] = []
): Promise<{ done: number; total: number }> {
  const pagesJson = JSON.stringify(pages);
  const failedJson = JSON.stringify(failedUrls);
  const result = await db.execute(sql`
    UPDATE geo_sites
    SET
      crawl_chunk_results = COALESCE(crawl_chunk_results, '[]'::jsonb) || ${pagesJson}::jsonb,
      crawl_chunks_done = crawl_chunks_done + 1,
      crawl_failed_urls = COALESCE(crawl_failed_urls, '[]'::jsonb) || ${failedJson}::jsonb,
      updated_at = NOW()
    WHERE id = ${siteId}
    RETURNING crawl_chunks_done AS done, crawl_chunks_total AS total
  `);
  const row = (result as unknown as Array<{ done: number; total: number }>)[0];
  return { done: row?.done ?? 0, total: row?.total ?? 0 };
}

async function handlePollChunk(
  siteId: string,
  domain: string,
  chunkIndex: number,
  firecrawlJobId: string
): Promise<void> {
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) throw new Error("Site not found");

  // Circuit breaker: 20-minute hard limit per chunk
  const crawlStartedAt = site.crawlStartedAt ? new Date(site.crawlStartedAt as Date) : new Date();
  if (Date.now() - crawlStartedAt.getTime() > POLL_CHUNK_CIRCUIT_BREAKER_MS) {
    // FIND-SILENTFAILURE-017: on the per-chunk timeout, RECORD the abandoned
    // chunk's URLs as failed (previously fanInChunk([]) dropped them silently,
    // so a timed-out chunk's pages vanished and the audit reported partial
    // results as complete with no trace of the loss).
    const [timedOutJob] = await db.select().from(firecrawlJobs)
      .where(eq(firecrawlJobs.firecrawlJobId, firecrawlJobId));
    const abandonedUrls = (timedOutJob?.urlsSubmitted as string[] | null) ?? [];
    console.error(JSON.stringify({
      event: "poll_chunk_circuit_breaker",
      siteId,
      domain,
      chunkIndex,
      firecrawlJobId,
      abandonedUrlCount: abandonedUrls.length,
      timeoutMs: POLL_CHUNK_CIRCUIT_BREAKER_MS,
    }));
    const { done, total } = await fanInChunk(siteId, [], abandonedUrls);

    // A sole timed-out chunk means the whole crawl produced nothing — fail
    // loudly instead of advancing an empty crawl to merge (which would carry a
    // 0-page crawl forward as a finished audit attempt).
    if (total <= 1) {
      await markFailed(
        siteId,
        `Crawl timed out: chunk ${chunkIndex} for ${domain} exceeded the per-chunk limit with no pages retrieved`,
      );
      return;
    }

    // Multi-chunk: surviving chunks proceed; the abandoned URLs are now recorded
    // in crawlFailedUrls and merge-crawl's scoreCrawlQuality gate decides whether
    // the remaining pages are usable or the audit must fail.
    if (done === total) await enqueueStage({ siteId, domain, stage: "merge-crawl" });
    return;
  }

  const discoveryData = site.discoveryData as DiscoveryData | null;
  const pageMap = discoveryData?.pageMap ?? {};

  // Lookup job row for context (urlsSubmitted, etc.)
  const [jobRow] = await db.select().from(firecrawlJobs)
    .where(eq(firecrawlJobs.firecrawlJobId, firecrawlJobId));

  // Idempotency: if the webhook already processed this chunk, skip.
  // The webhook sets firecrawl_jobs.status = 'completed' and does the fan-in.
  if (jobRow?.status === "completed") {
    console.warn(`[stage:poll-chunk] ${domain} chunk ${chunkIndex}: already completed (webhook), skipping`);
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fc = new FirecrawlAppV1({ apiKey: process.env.FIRECRAWL_API_KEY! }) as any;
  const status = await fc.checkBatchScrapeStatus(firecrawlJobId) as { status: string; data?: unknown[] };

  if (status.status !== "completed") {
    // Still in progress — re-enqueue with POLL_CHUNK_INTERVAL_S delay
    await enqueueStage(
      { siteId, domain, stage: "poll-chunk", chunkIndex, firecrawlJobId },
      POLL_CHUNK_INTERVAL_S
    );
    return;
  }

  // Map Firecrawl docs to CrawledPage objects
  const docs = (status.data ?? []) as FcDoc[];
  const pages = docs
    .map((d) => mapDocumentToPage(d, pageMap as Record<string, import("@/lib/services/geo-crawler").PageType>))
    .filter((p): p is CrawledPage => p !== null);

  // Compute page-level failures: URLs Firecrawl attempted but didn't return as usable pages
  // FIX-032: compare on normalized URLs -- Firecrawl returns post-redirect
  // forms that never string-match the submitted URLs.
  const successfulUrls = new Set(pages.map((p) => normalizeUrlForComparison(p.url)));
  const pageFailedUrls = ((jobRow?.urlsSubmitted as string[] | null) ?? [])
    .filter((u) => !successfulUrls.has(normalizeUrlForComparison(u)));

  // Update firecrawl_jobs row
  if (jobRow) {
    await db.update(firecrawlJobs)
      .set({ status: "completed", urlsCompleted: pages.map((p) => p.url), updatedAt: new Date() })
      .where(eq(firecrawlJobs.firecrawlJobId, firecrawlJobId));
  }

  // Atomic fan-in: increment done counter, append pages and page-level failed URLs
  const { done, total } = await fanInChunk(siteId, pages, pageFailedUrls);
  console.warn(`[stage:poll-chunk] ${domain} chunk ${chunkIndex}: ${pages.length} pages, fan-in ${done}/${total}`);

  if (done === total) {
    // Perf: inline merge-crawl here instead of a separate QStash hop (HP perf review Fix 3)
    await handleMergeCrawl(siteId, domain);
  }
}

async function handleMergeCrawl(siteId: string, domain: string): Promise<void> {
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) throw new Error("Site not found");

  const chunkResults = (site.crawlChunkResults as CrawledPage[][] | null) ?? [];
  const rawPages = chunkResults.flat();

  // Deduplicate by URL — keep the best entry per URL (prefer hasStructuredData,
  // then longest content). Chunks can overlap, and www/non-www can both appear.
  const pageMap = new Map<string, CrawledPage>();
  for (const p of rawPages) {
    const existing = pageMap.get(p.url);
    if (!existing) {
      pageMap.set(p.url, p);
    } else {
      const better = (p.hasStructuredData && !existing.hasStructuredData)
        || (p.hasStructuredData === existing.hasStructuredData && p.content.length > existing.content.length);
      if (better) pageMap.set(p.url, p);
    }
  }
  // Filter out pages from external domains (discovery can follow links to other sites)
  const domainBase = domain.replace(/^www\./, "");
  const newPages = Array.from(pageMap.values()).filter(p => {
    try {
      const host = new URL(p.url).hostname.replace(/^www\./, "");
      return host === domainBase;
    } catch { return false; }
  });

  // B10.1: retry-failed merges new pages with prior crawlData so the parent's
  // already-successful pages survive. Other run kinds replace crawlData as before.
  let crawlData: CrawlData;
  if (site.currentRunKind === "retry-failed") {
    const priorSnapshot = (site.previousRunSnapshot as { crawlData?: CrawlData } | null) ?? null;
    const priorCrawlData = priorSnapshot?.crawlData;
    const priorPages = priorCrawlData?.pages ?? [];
    const priorFailedUrls = priorCrawlData?.failedUrls ?? [];
    const priorCreditLimitedUrls = priorCrawlData?.creditLimitedUrls ?? [];
    const retrySubset = (site.retrySubsetUrls as string[] | null) ?? [];
    const recoveredUrls = new Set(newPages.map((p) => p.url));
    const stillFailedFromRetry = retrySubset.filter((u) => !recoveredUrls.has(u));
    const priorFailedNotInRetry = priorFailedUrls.filter((u) => !retrySubset.includes(u));
    crawlData = {
      domain,
      pages: [...priorPages, ...newPages],
      failedUrls: [...priorFailedNotInRetry, ...stillFailedFromRetry],
      creditLimitedUrls: priorCreditLimitedUrls,
      totalCrawled: priorPages.length + newPages.length,
    } as CrawlData;
    console.warn(`[stage:merge-crawl] ${domain} retry-failed merge: ${priorPages.length} prior + ${newPages.length} retry = ${crawlData.pages.length} total; ${stillFailedFromRetry.length}/${retrySubset.length} retry URLs still failing`);
  } else {
    crawlData = { domain, pages: newPages, totalCrawled: newPages.length };
  }

  const crawlQuality = scoreCrawlQuality(crawlData);
  if (!crawlQuality.usable) {
    // Bulk partial: proceed if we got some usable pages
    if (site.auditMode === "bulk" && crawlQuality.goodPages > 0) {
      console.warn(`[stage:merge-crawl] ${domain} bulk — partial: ${crawlQuality.goodPages} usable pages`);
    } else {
      await markFailed(siteId, `Crawl quality too low: ${crawlQuality.issues.join("; ")}. Got ${crawlQuality.goodPages} usable pages.`);
      return;
    }
  }

  // FIX-030 (2026-06-09): dedup crawl_failed_urls against newPages URLs.
  // fanInChunk appends per-chunk failures without cross-chunk dedup, so a URL
  // that failed in chunk A but succeeded in chunk B (or recovered via retry)
  // stayed in crawl_failed_urls AND landed in per_page_results -- dashboards
  // reported the same URL as both succeeded and failed.
  // FIX-032: normalized comparison here too, else post-redirect URL forms
  // keep every recovered URL in the failure list.
  const recoveredUrlSet = new Set(newPages.map((p) => normalizeUrlForComparison(p.url)));
  const rawFailedUrls = (site.crawlFailedUrls as string[] | null) ?? [];
  const dedupedFailedUrls = Array.from(new Set(rawFailedUrls.filter((u) => !recoveredUrlSet.has(normalizeUrlForComparison(u)))));

  await db.update(geoSites).set({
    crawlData: crawlData as unknown as Record<string, unknown>,
    crawlJobIds: null,
    crawlChunkResults: null,
    crawlFailedUrls: dedupedFailedUrls,
    updatedAt: new Date(),
  }).where(eq(geoSites.id, siteId));

  // Reset fan-in counter before dispatching parallel stages
  await db.execute(sql`UPDATE geo_sites SET pre_analyze_done = 0 WHERE id = ${siteId}`);

  console.warn(`[stage:merge-crawl] ${domain}: ${crawlData.pages.length} pages merged from ${chunkResults.length} chunks`);
  // Perf: dispatch extract-trees and research in parallel (HP perf review Fix 1).
  // Both only need crawlData (available now). analyze waits for both via fan-in.
  await Promise.all([
    enqueueStage({ siteId, domain, stage: "extract-trees" }),
    enqueueStage({ siteId, domain, stage: "research" }),
  ]);
}

// ── Fan-in: extract-trees + research → analyze (HP perf review Fix 1) ────────
// Both stages run in parallel after merge-crawl. Whichever finishes second
// enqueues analyze. Uses an atomic counter to prevent double-enqueue races.
// pre_analyze_done starts at 0. Each completing stage increments it atomically.
// The one that sees count=2 enqueues analyze. The other sees count=1 and waits.
async function tryEnqueueAnalyze(siteId: string, domain: string, caller: string): Promise<void> {
  const result = await db.execute(sql`
    UPDATE geo_sites
    SET pre_analyze_done = COALESCE(pre_analyze_done, 0) + 1, updated_at = NOW()
    WHERE id = ${siteId}
    RETURNING pre_analyze_done AS count
  `);
  const count = (result as unknown as Array<{ count: number }>)[0]?.count ?? 0;

  if (count >= 2) {
    console.warn(`[fan-in] ${domain}: both extract-trees and research done (triggered by ${caller}), enqueuing analyze`);
    await enqueueStage({ siteId, domain, stage: "analyze" });
  } else {
    console.warn(`[fan-in] ${domain}: ${caller} done (${count}/2), waiting for the other`);
  }
}

// ── C2+C3: Extract geographic + category trees from crawl data ───────────────

async function handleExtractTrees(siteId: string, domain: string): Promise<void> {
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) throw new Error("Site not found");

  if (!site.crawlData) {
    console.error(`[extract-trees] ${domain}: no crawlData, skipping`);
    // Mark extract-trees as "done" (failed) so fan-in can proceed
    await db.update(geoSites).set({ treeExtractionFailedAt: new Date(), updatedAt: new Date() }).where(eq(geoSites.id, siteId));
    await tryEnqueueAnalyze(siteId, domain, "extract-trees-skip");
    return;
  }

  await updateStatus(siteId, "extracting");

  // ES-084 AC-3: try/catch around the extract call so failures can wire the
  // tree_extraction_failed_at timestamp for operator monitoring. The throw
  // is re-thrown so the outer stage retry / markFailed logic still fires.
  try {
    const outcome = await Promise.race([
      extractTrees(
        site.crawlData as CrawlData,
        site.discoveryData as DiscoveryData,
        domain,
        site.siteType ?? undefined
      ),
      stageTimeout("extract-trees"),
    ]);

    // FIND-023: all-providers-failed is now a discriminated failure, not a
    // hollow empty-tree "success". Throw so the catch below sets
    // treeExtractionFailedAt and re-throws into the stage markFailed/refund path.
    if (!outcome.ok) throw new Error(`tree extraction failed: ${outcome.reason}`);
    const result = outcome.trees;

    await db.update(geoSites).set({
      geoTree: result.geoTree,
      categoryTree: result.categoryTree,
      geoCategoryMapping: result.mapping,
      pipelineStatus: "researching",
      updatedAt: new Date(),
    }).where(eq(geoSites.id, siteId));

    console.info(`[extract-trees] ${domain}: geoLeafCount=${result.geoTree.leafCount}, catLeafCount=${result.categoryTree.leafCount}, mappingEntries=${result.mapping.totalEntries}`);
  } catch (err) {
    // ES-084 AC-3: set the failure timestamp for operator monitoring.
    // No production code consumes this field — rescue trigger uses ES-086
    // AC-15 treeIsEmpty structure detection. Preserved for SQL diagnostics.
    console.warn(`[extract-trees] ${domain}: failed — ${(err as Error).message ?? String(err)}`);
    await db.update(geoSites).set({
      treeExtractionFailedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(geoSites.id, siteId));
    // Re-throw so the outer stage retry / markFailed logic fires.
    throw err;
  }

  // Perf: fan-in with research (HP perf review Fix 1).
  // Check if research already completed — if so, trigger analyze.
  await tryEnqueueAnalyze(siteId, domain, "extract-trees");
}

async function handleResearch(siteId: string, domain: string): Promise<void> {
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) throw new Error("Site not found");

  const crawlData = site.crawlData as CrawlData;
  const homepageContent = crawlData.pages.find((p) => p.pageType === "homepage")?.content ?? "";
  const aboutContent = crawlData.pages.find((p) => p.pageType === "about")?.content ?? "";
  const businessDescription = (homepageContent + " " + aboutContent).substring(0, 500);

  await updateStatus(siteId, "researching");
  let researchData: Awaited<ReturnType<typeof gatherCompetitiveIntel>>;
  try {
    researchData = await Promise.race([
      gatherCompetitiveIntel(domain, businessDescription, crawlData),
      stageTimeout("research"),
    ]);
  } catch (err) {
    // Perplexity or network failure — degrade gracefully so the rest of the pipeline runs
    console.error(`[stage:research] gatherCompetitiveIntel failed for ${domain}, using empty intel:`, err);
    researchData = {
      topCompetitors: [],
      brandPerception: "",
      competitivePosition: "",
      competitorGeoStatus: [],
      industryContext: "",
      groundTruthIndustry: { industry: null, source: "none" as const, schemaTypes: [], confidence: "low" as const },
    };
  }
  await updateStatus(siteId, "researching", { researchData });

  // Perf: fan-in with extract-trees (HP perf review Fix 1).
  // Check if extract-trees already completed — if so, trigger analyze.
  await tryEnqueueAnalyze(siteId, domain, "research");
}

async function handleAnalyze(siteId: string, domain: string): Promise<void> {
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) throw new Error("Site not found");

  const crawlData = site.crawlData as CrawlData;
  const researchData = site.researchData as ResearchData;
  const discoveryData = (site.discoveryData as DiscoveryData | null) ?? ({} as DiscoveryData);
  const previousScorecard =
    (site.previousRunSnapshot as { geoScorecard?: GeoScorecard } | null)?.geoScorecard ?? undefined;

  // ── ES-055 C8: pre-compute content strategy for Gemini context ──
  const contentStrategyForAnalysis = crawlData ? aggregateStrategyReport(crawlData.pages) : null;

  await updateStatus(siteId, "analyzing");
  // Issue-C fix: pass site.geoTree to analyzeGeoGaps so scoreGeographicSignals
  // can read it (Signal 8 — counts city-level nodes with evidence URLs).
  // The geo_tree column is populated by the extract-trees stage which runs
  // before analyze in the pipeline sequence.
  const siteGeoTree = (site.geoTree as import("@/lib/types/trees").GeoTree | null) ?? null;
  const geoScorecard = await Promise.race([
    analyzeGeoGaps(crawlData, researchData, discoveryData, previousScorecard, contentStrategyForAnalysis, siteGeoTree),
    stageTimeout("analyze"),
  ]);

  // Establish baseline on first successful run
  let baselineScorecard = site.baselineScorecard;
  if (!baselineScorecard) {
    const snapshot = site.previousRunSnapshot as { geoScorecard?: unknown } | null;
    baselineScorecard = (snapshot?.geoScorecard ?? geoScorecard) as Record<string, unknown>;
  }

  await updateStatus(siteId, "analyzing", { geoScorecard, baselineScorecard });
  // Perf: inline generate-fanout here instead of a separate QStash hop (HP perf review Fix 3)
  await handleGenerateFanout(siteId, domain);
}

// ── Generate fan-out (mirrors crawl-fanout pattern) ───────────────────────────

const GENERATE_CHUNK_TYPES: GenerateChunkType[] = ["llms", "business", "schema-sitewide", "schema-faq", "schema-article", "page-fixes"];

async function fanInGenerateChunk(siteId: string): Promise<{ done: number; total: number }> {
  const result = await db.execute(sql`
    UPDATE geo_sites
    SET
      generate_chunks_done = generate_chunks_done + 1,
      updated_at = NOW()
    WHERE id = ${siteId}
    RETURNING generate_chunks_done AS done, generate_chunks_total AS total
  `);
  const row = (result as unknown as Array<{ done: number; total: number }>)[0];
  return { done: row?.done ?? 0, total: row?.total ?? 0 };
}

/** Atomically append schema blocks to generated_schema_blocks AND increment the fan-in counter. */
async function fanInSchemaChunk(siteId: string, blocks: unknown[]): Promise<{ done: number; total: number }> {
  const blocksJson = JSON.stringify(blocks);
  const result = await db.execute(sql`
    UPDATE geo_sites
    SET
      generated_schema_blocks = COALESCE(generated_schema_blocks, '[]'::jsonb) || ${blocksJson}::jsonb,
      generate_chunks_done = generate_chunks_done + 1,
      updated_at = NOW()
    WHERE id = ${siteId}
    RETURNING generate_chunks_done AS done, generate_chunks_total AS total
  `);
  const row = (result as unknown as Array<{ done: number; total: number }>)[0];
  return { done: row?.done ?? 0, total: row?.total ?? 0 };
}

async function handleGenerateFanout(siteId: string, domain: string): Promise<void> {
  const total = GENERATE_CHUNK_TYPES.length;
  await updateStatus(siteId, "generating", {
    generateChunksTotal: total,
    generateChunksDone: 0,
    generatedSchemaBlocks: null, // clean slate for atomic accumulation by schema sub-chunks
  });
  await Promise.all(
    GENERATE_CHUNK_TYPES.map((chunkType) =>
      enqueueStage({ siteId, domain, stage: "generate-chunk", generateChunkType: chunkType })
    )
  );
  console.warn(`[stage:generate-fanout] ${domain}: fanned out ${total} generate chunks`);
}

async function handleGenerateChunk(
  siteId: string,
  domain: string,
  chunkType: GenerateChunkType
): Promise<void> {
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) throw new Error("Site not found");

  const crawlData = site.crawlData as CrawlData;
  const researchData = site.researchData as ResearchData;
  const geoScorecard = site.geoScorecard as GeoScorecard;

  switch (chunkType) {
    case "llms": {
      const result = await Promise.race([
        withRetry(
          "generateLlmsTxt",
          () => generateLlmsTxt(domain, crawlData, geoScorecard),
          (r) => {
            const txt = r.llmsTxt;
            const failures: string[] = [];
            if (!txt || txt.length < 200) failures.push("llmsTxt too short");
            else {
              if (!/^# .+/m.test(txt)) failures.push("llmsTxt missing title");
              if (!/^> .+/m.test(txt)) failures.push("llmsTxt missing summary");
            }
            return { passed: failures.length === 0, failures };
          },
          1 // ES-082: throws RetryValidationExhausted on validation failure → propagates to outer try/catch in POST() which calls markFailed() which triggers stage-level retry via the existing retryStage path.
        ),
        stageTimeout("generate-chunk[llms]"),
      ]);
      await db.update(geoSites)
        .set({
          generatedLlmsTxt: sanitizeLlmsTxt(result.llmsTxt),
          generatedLlmsFullTxt: sanitizeLlmsTxt(result.llmsFullTxt),
          updatedAt: new Date(),
        })
        .where(eq(geoSites.id, siteId));
      break;
    }
    case "business": {
      const result = await Promise.race([
        withRetry(
          "generateBusinessJson",
          () => generateBusinessJson(domain, crawlData, geoScorecard, researchData),
          (r) => {
            const bj = r as Record<string, unknown>;
            const failures: string[] = [];
            if (Object.keys(bj ?? {}).length < 4) failures.push("businessJson has fewer than 4 keys");
            return { passed: failures.length === 0, failures };
          },
          2 // ES-082: throws on final-attempt failure (was silent fall-through pre-ES-082). 2 attempts max — OpenAI calls can take 30-40s each.
        ),
        stageTimeout("generate-chunk[business]"),
      ]);
      await db.update(geoSites)
        .set({
          generatedBusinessJson: sanitizeBusinessJson(result) as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(geoSites.id, siteId));
      break;
    }
    case "schema-sitewide": {
      // sitewide blocks + synchronous robots.txt block
      const sitewideBlocks = await Promise.race([
        generateSitewideSchemaBlocks(domain, crawlData, geoScorecard),
        stageTimeout("generate-chunk[schema-sitewide]"),
      ]);
      const robotsBlock = generateRobotsTxtBlock(domain);
      const { done, total } = await fanInSchemaChunk(siteId, [...sitewideBlocks, robotsBlock]);
      console.warn(`[stage:generate-chunk] ${domain} chunk=schema-sitewide: fan-in ${done}/${total}`);
      if (done === total) await enqueueStage({ siteId, domain, stage: "assemble" });
      return;
    }
    case "schema-faq": {
      const faqBlocks = await Promise.race([
        generatePerPageFaqBlocks(domain, crawlData),
        stageTimeout("generate-chunk[schema-faq]"),
      ]);
      const { done, total } = await fanInSchemaChunk(siteId, faqBlocks);
      console.warn(`[stage:generate-chunk] ${domain} chunk=schema-faq: fan-in ${done}/${total}`);
      if (done === total) await enqueueStage({ siteId, domain, stage: "assemble" });
      return;
    }
    case "schema-article": {
      const articleBlocks = await Promise.race([
        generateArticleBlocks(domain, crawlData),
        stageTimeout("generate-chunk[schema-article]"),
      ]);
      const { done, total } = await fanInSchemaChunk(siteId, articleBlocks);
      console.warn(`[stage:generate-chunk] ${domain} chunk=schema-article: fan-in ${done}/${total}`);
      if (done === total) await enqueueStage({ siteId, domain, stage: "assemble" });
      return;
    }
    case "page-fixes": {
      const schemaBlocks = (site.generatedSchemaBlocks ?? []) as Array<{ "@type"?: string; pageTarget?: string }>;
      const isPaid = site.teamId != null;
      const fixes = await Promise.race([
        generatePerPageFixes(domain, crawlData, geoScorecard, schemaBlocks, isPaid),
        stageTimeout("generate-chunk[page-fixes]"),
      ]);
      await db.update(geoSites)
        .set({
          perPageFixes: fixes as unknown as Record<string, unknown>[],
          updatedAt: new Date(),
        })
        .where(eq(geoSites.id, siteId));
      console.warn(JSON.stringify({ event: "page_fixes_generated", siteId, domain, fixCount: fixes.length, isPaid }));
      break;
    }
    default:
      throw new Error(`Unknown generate chunk type: ${chunkType}`);
  }

  // Atomic fan-in for llms and business chunks — last chunk to finish triggers assemble.
  // Schema sub-chunks return early above (they use fanInSchemaChunk which combines append + increment).
  const { done, total } = await fanInGenerateChunk(siteId);
  console.warn(`[stage:generate-chunk] ${domain} chunk=${chunkType}: fan-in ${done}/${total}`);
  if (done === total) {
    await enqueueStage({ siteId, domain, stage: "assemble" });
  }
}

async function handleAssemble(siteId: string, domain: string): Promise<void> {
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) throw new Error("Site not found");

  // NEW-L-01 / NEW-AI-02 idempotency guard: if the site is already complete,
  // skip all work including the credit refund. A stale cron re-enqueue on an
  // already-completed assembling site must not re-refund credits a second time.
  if (site.pipelineStatus === "complete") {
    console.warn(`[stage:assemble] ${domain} (${siteId}): already complete — skipping re-entry`);
    return;
  }

  const crawlData = site.crawlData as CrawlData;
  const researchData = site.researchData as ResearchData;
  const geoScorecard = site.geoScorecard as GeoScorecard;
  const discoveryData = site.discoveryData as DiscoveryData | null;

  // Reconstruct generatedContent from DB fields (each was saved by the generate stage)
  const generatedContent = {
    llmsTxt: site.generatedLlmsTxt ?? "",
    llmsFullTxt: site.generatedLlmsFullTxt ?? "",
    businessJson: site.generatedBusinessJson,
    schemaBlocks: site.generatedSchemaBlocks,
  } as ResearchData;

  const isPaidUser = site.teamId != null;
  await updateStatus(siteId, "assembling");
  // ES-082 §b.5 / AC-16: checkExecutiveSummary returns a raw boolean. Adapter
  // converts it to the {passed, failures} shape that withRetry now requires.
  // Without this, the unified throw in withRetry would fire on every assemble
  // attempt because `passed` would be undefined.
  // ES-082: throws on final-attempt failure. assembleResults validator was a
  // raw boolean — adapted here so the unified throw fires only on real failure.
  //
  // Round 2 TS fix (2026-04-10): checkExecutiveSummary already returns a
  // ContentCheckResult with the { passed, failures } shape withRetry expects,
  // so pass the result through directly. The previous code assigned the
  // WHOLE ContentCheckResult object to a variable named `ok` and then treated
  // it as a boolean — objects are always truthy, so the failures array was
  // silently always empty and the validator never tripped on real failures.
  const assemblyResult = await Promise.race([
    withRetry(
      "assembleResults",
      () => assembleResults(domain, crawlData, geoScorecard, generatedContent, researchData, isPaidUser),
      (r) => checkExecutiveSummary(r.executiveSummary),
    ),
    stageTimeout("assemble"),
  ]);
  if (isPaidUser) {
    console.warn(JSON.stringify({ event: "tone_shift_applied", siteId, domain, isPaidUser }));
  }

  const projectedBoost = geoScorecard.pillars
    .filter((p) => p.score < 80)
    .slice(0, 5)
    .reduce((sum, p) => {
      if (p.priority === "critical") return sum + 10;
      if (p.priority === "high") return sum + 5;
      return sum + 2;
    }, 0);
  const projectedScore = Math.min(100, geoScorecard.overallScore + projectedBoost);

  const now = new Date();
  const nextCrawl = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const crawlQuality = scoreCrawlQuality(crawlData);
  const prevChangeLog = (site.changeLog as ChangeLogEntry[] | null) ?? [];
  const newEntry: ChangeLogEntry = {
    runAt: now.toISOString(),
    overallScore: geoScorecard.overallScore,
    projectedScore,
    crawlQuality: {
      goodPages: crawlQuality.goodPages,
      errorPages: crawlQuality.errorPages,
      coverageScore: crawlQuality.coverageScore,
      blockedByAntiBot: crawlQuality.blockedByAntiBot,
      usable: crawlQuality.usable,
    },
    pillarScores: Object.fromEntries(geoScorecard.pillars.map((p) => [p.pillar, p.score])),
  };
  const updatedChangeLog: ChangeLogEntry[] = [...prevChangeLog, newEntry].slice(-52);

  // ── ES-055 C8: Content strategy scoring ──
  const contentStrategyScores = crawlData ? aggregateStrategyReport(crawlData.pages) : null;
  if (contentStrategyScores) {
    console.info(JSON.stringify({
      event: "content-strategy.scored",
      domain,
      pagesTotal: contentStrategyScores.quotations.pagesTotal,
      avgQuotationScore: contentStrategyScores.quotations.overallScore,
      avgStatisticsScore: contentStrategyScores.statistics.overallScore,
      avgCitationScore: contentStrategyScores.citations.overallScore,
    }));
  }

  // ── Per-page analysis for ALL audit modes ──
  let perPageUpdates: Record<string, unknown> = {};
  if (crawlData) {
    const scorecardForAnalysis = geoScorecard as { pillars: Array<{ pillar: string; impactedPages?: string[] }> };
    const perPageResults = extractPerPageVulnerabilities(crawlData, scorecardForAnalysis);
    perPageUpdates = {
      perPageResults: perPageResults as unknown as Record<string, unknown>[],
    };
  }

  // ── Implementation tracking for re-audits ──
  const previousFixes = site.previousPerPageFixes as PerPageFix[] | null;
  let implementationStatusUpdates: Record<string, unknown> = {};
  if (previousFixes?.length && crawlData) {
    const implementationStatus: ImplementationStatus[] = computeImplementationTracking(previousFixes, crawlData);
    implementationStatusUpdates = {
      implementationStatus: implementationStatus as unknown as Record<string, unknown>[],
    };
    console.warn(JSON.stringify({
      event: "implementation_tracking_complete",
      siteId,
      domain,
      totalFixes: implementationStatus.reduce((s, r) => s + r.totalFixes, 0),
      implementedCount: implementationStatus.reduce((s, r) => s + r.implementedCount, 0),
    }));
  }

  // ── Bulk post-processing: credit reconciliation + URL classification ──
  let bulkUpdates: Record<string, unknown> = {};
  if (site.auditMode === "bulk" && crawlData) {
    // B10.1: for retry-failed runs, handleMergeCrawl already produced the
    // authoritative failedUrls + creditLimitedUrls by merging with the prior
    // crawlData. Don't re-classify against bulkUrls (which would treat 222 of
    // the 255 URLs as "failed this run" since only ~33 were actually retried).
    let crawlDataWithFailed: CrawlData;
    let failedUrls: string[];
    let creditLimitedUrls: string[];
    if (site.currentRunKind === "retry-failed") {
      crawlDataWithFailed = crawlData;
      failedUrls = (crawlData.failedUrls as string[] | undefined) ?? [];
      creditLimitedUrls = (crawlData.creditLimitedUrls as string[] | undefined) ?? [];
    } else {
      // Classify uncrawled URLs into two buckets:
      //   failedUrls        — within the crawl limit but blocked/errored
      //   creditLimitedUrls — beyond the crawl limit, never attempted
      const allBulkUrls = (site.bulkUrls as string[] | null) ?? [];
      const crawlLimitVal = (site.crawlLimit as number | null) ?? allBulkUrls.length;
      const urlsAttempted = allBulkUrls.slice(0, crawlLimitVal);
      const crawledUrlSet = new Set(crawlData.pages.map((p) => p.url));
      failedUrls = urlsAttempted.filter((u) => !crawledUrlSet.has(u));
      creditLimitedUrls = allBulkUrls.slice(crawlLimitVal);
      crawlDataWithFailed = { ...crawlData, failedUrls, creditLimitedUrls };
    }

    const actualPagesCrawled = crawlData.pages.length;
    const actualCredits = bulkCreditsRequired(actualPagesCrawled);
    // NEW-L-01: read reservedCredits from site row. If it is already null the
    // refund was already processed on a prior assemble invocation — skip to
    // prevent a double-refund on cron re-entry (assembling → cron re-enqueues
    // assemble → same site row is still "assembling" → refund runs again).
    const reservedCredits = (site.creditsReserved as number | null) ?? 0;
    const refundAlreadyProcessed = site.creditsReserved === null || site.creditsReserved === 0;

    if (!refundAlreadyProcessed && actualCredits < reservedCredits && site.teamId) {
      const refundCredits = reservedCredits - actualCredits;
      await db.transaction(async (tx) => {
        // NEW-L-01: atomically clear creditsReserved inside the same transaction
        // so a concurrent assemble invocation that reads the row after this
        // commit sees creditsReserved=null and skips the refund.
        await tx.update(geoSites)
          .set({ creditsReserved: null, updatedAt: new Date() })
          .where(and(eq(geoSites.id, siteId), isNotNull(geoSites.creditsReserved)));

        const updated = await tx.update(teams)
          .set({ creditBalance: sql`${teams.creditBalance} + ${refundCredits}` })
          .where(eq(teams.id, site.teamId!))
          .returning({ newBalance: teams.creditBalance });

        if (updated.length > 0) {
          const newBalance = updated[0].newBalance;
          await tx.insert(creditTransactions).values({
            id: nanoid(),
            teamId: site.teamId!,
            siteId,
            type: "bulk_crawl_refund",
            pagesConsumed: actualPagesCrawled,
            creditsChanged: refundCredits,
            balanceBefore: newBalance - refundCredits,
            balanceAfter: newBalance,
            createdAt: now,
          });
        }
      });
      console.warn(JSON.stringify({ event: "bulk_credit_refund", siteId, teamId: site.teamId, refundAmount: refundCredits }));
    } else if (!refundAlreadyProcessed && actualCredits > reservedCredits && site.teamId) {
      // FIND-SILENTFAILURE-039: over-consumption — the crawl used MORE credits
      // than were reserved. Reconciliation was refund-only, so the extra usage
      // was never recorded and the ledger silently diverged from true usage. We
      // emit a loud, greppable reconciliation-mismatch alert rather than
      // auto-debiting: the audit is already delivered and this reconciliation is
      // not idempotent across assemble retries, so an auto-debit could
      // double-charge the customer. Ops reconciles from this alert.
      console.error(JSON.stringify({
        event: "credit_reconciliation_mismatch",
        mode: "bulk",
        siteId,
        teamId: site.teamId,
        reservedCredits,
        actualCredits,
        overConsumedCredits: actualCredits - reservedCredits,
        actualPagesCrawled,
      }));
    }

    console.warn(JSON.stringify({ event: "bulk_crawl_complete", siteId, actualPages: actualPagesCrawled, failedUrls: failedUrls.length, reservedCredits, actualCredits }));
    bulkUpdates = {
      crawlData: crawlDataWithFailed as unknown as Record<string, unknown>,
    };
  }

  // ── Single-site credit reconciliation: refund unused reserved credits ──
  // NEW-L-01: the outer guard `site.creditsReserved &&` already skips when
  // creditsReserved is null (already processed or never reserved), making this
  // branch naturally idempotent for re-entry.
  if (site.auditMode !== "bulk" && site.creditsReserved && site.teamId && crawlData) {
    const actualPagesCrawled = crawlData.pages.length;
    const actualCredits = bulkCreditsRequired(actualPagesCrawled);
    const reservedCredits = (site.creditsReserved as number | null) ?? 0;

    if (actualCredits < reservedCredits) {
      const refundCredits = reservedCredits - actualCredits;
      await db.transaction(async (tx) => {
        // NEW-L-01: atomically clear creditsReserved so a concurrent or
        // cron-retried assemble invocation cannot double-refund.
        await tx.update(geoSites)
          .set({ creditsReserved: null, updatedAt: new Date() })
          .where(and(eq(geoSites.id, siteId), isNotNull(geoSites.creditsReserved)));

        const updated = await tx.update(teams)
          .set({ creditBalance: sql`${teams.creditBalance} + ${refundCredits}` })
          .where(eq(teams.id, site.teamId!))
          .returning({ newBalance: teams.creditBalance });

        if (updated.length > 0) {
          const newBalance = updated[0].newBalance;
          await tx.insert(creditTransactions).values({
            id: nanoid(),
            teamId: site.teamId!,
            siteId,
            type: "crawl_refund",
            pagesConsumed: actualPagesCrawled,
            creditsChanged: refundCredits,
            balanceBefore: newBalance - refundCredits,
            balanceAfter: newBalance,
            createdAt: now,
          });
        }
      });
      console.warn(JSON.stringify({ event: "crawl_credit_refund", siteId, teamId: site.teamId, reserved: reservedCredits, actual: actualCredits, refund: refundCredits }));
    } else if (actualCredits > reservedCredits) {
      // FIND-SILENTFAILURE-039: over-consumption on a single-site audit. Same
      // rationale as the bulk branch — alert loudly instead of auto-debiting a
      // non-idempotent reconciliation. site.teamId is guaranteed truthy by the
      // enclosing guard.
      console.error(JSON.stringify({
        event: "credit_reconciliation_mismatch",
        mode: "single",
        siteId,
        teamId: site.teamId,
        reservedCredits,
        actualCredits,
        overConsumedCredits: actualCredits - reservedCredits,
        actualPagesCrawled,
      }));
    }
  }

  // ── NEW-P-01: Subscription-pages reconciliation ──────────────────────────────
  // Subscription pages are charged up-front (monthlyPagesUsed += subscriptionPagesReserved).
  // On under-crawl, return the unused portion back to monthlyPagesUsed so the customer
  // doesn't permanently lose their allowance.
  //
  // Budget split: subscription pages are "used first". If actualPagesCrawled <
  // subscriptionPagesReserved, only subscription pages were used and we return
  // (subscriptionPagesReserved - actual). If actual >= subscriptionPagesReserved,
  // all subscription pages were used — no return needed from this path (credit
  // reconciliation above already handles any credit overflow).
  //
  // Idempotency: mirrors creditsReserved pattern — subscriptionPagesReserved = 0
  // (or null) means already reconciled; skip on re-entry. The completion write below
  // also zeros it unconditionally as a belt-and-braces guard.
  if (crawlData && site.teamId) {
    const reservedSubPages = (site.subscriptionPagesReserved as number | null) ?? 0;
    const subAlreadyReconciled = !reservedSubPages || reservedSubPages <= 0;

    if (!subAlreadyReconciled) {
      const actualPagesCrawled = crawlData.pages.length;
      // Subscription pages are "used first": actual pages consumed from the
      // subscription allowance = min(actual, reserved). Pages beyond the
      // subscription cap came from credits (handled above).
      const actualSubPagesUsed = Math.min(actualPagesCrawled, reservedSubPages);
      const subPagesToReturn = reservedSubPages - actualSubPagesUsed;

      if (subPagesToReturn > 0) {
        // Atomic: CAS-clear subscriptionPagesReserved (prevents double-return on
        // re-entry) + decrement monthlyPagesUsed, floored at 0.
        await db.transaction(async (tx) => {
          const cleared = await tx
            .update(geoSites)
            .set({ subscriptionPagesReserved: 0, updatedAt: new Date() })
            .where(and(eq(geoSites.id, siteId), sql`subscription_pages_reserved > 0`))
            .returning({ id: geoSites.id });

          if (cleared.length === 0) {
            // Another invocation already cleared it — skip.
            return;
          }

          await tx
            .update(teams)
            .set({
              // Floor at 0: GREATEST prevents underflow if a prior bug or manual
              // correction already decremented monthlyPagesUsed below reserved.
              monthlyPagesUsed: sql`GREATEST(0, ${teams.monthlyPagesUsed} - ${subPagesToReturn})`,
              updatedAt: new Date(),
            })
            .where(eq(teams.id, site.teamId!));
        });

        console.warn(JSON.stringify({
          event: "subscription_pages_reconciliation",
          siteId,
          teamId: site.teamId,
          reservedSubPages,
          actualPagesCrawled,
          actualSubPagesUsed,
          subPagesToReturn,
        }));
      } else {
        // All reserved subscription pages were actually used — just clear the
        // reservation marker so re-entry skips this block.
        await db
          .update(geoSites)
          .set({ subscriptionPagesReserved: 0, updatedAt: new Date() })
          .where(and(eq(geoSites.id, siteId), sql`subscription_pages_reserved > 0`));
      }
    }
  }

  // Compute hallucination risk score (0-100) from grounding corrections
  const groundingCorrections = (geoScorecard as any)._groundingCorrections as Array<{ pillar: string }> | undefined;
  const groundingCorrectionCount = groundingCorrections?.length ?? 0;
  // Each correction = ~20 risk points, capped at 100
  const hallucinationRisk = Math.min(100, groundingCorrectionCount * 20);

  await db.update(geoSites).set({
    recommendations: {
      ...assemblyResult,
      projectedScore,
      projectedBoost,
    } as unknown as Record<string, unknown>,
    executiveSummary: assemblyResult.executiveSummary,
    hallucinationRisk,
    platformDetected: discoveryData?.hasLlmsTxt ? "has-llms-txt" : "no-llms-txt",
    pipelineStatus: "complete",
    pipelineError: null,
    lastCrawlAt: now,
    nextCrawlAt: nextCrawl,
    changeLog: updatedChangeLog as unknown as Record<string, unknown>[],
    crawlJobIds: null,
    // NEW-L-01: clear creditsReserved unconditionally on the completion write so
    // any cron-driven assemble re-entry reads null and skips the refund entirely.
    // The reconciliation blocks above already cleared it inside their transaction,
    // but if no refund was needed (actualCredits >= reservedCredits) creditsReserved
    // would remain non-null and a re-entry would re-run the reconciliation path.
    creditsReserved: null,
    // NEW-P-01: belt-and-braces clear of subscriptionPagesReserved on completion.
    // The reconciliation block above already zeroed it, but this guarantees that
    // re-entry (pipelineStatus=complete guard fires first) never sees a stale value.
    subscriptionPagesReserved: 0,
    crawlCount: sql`coalesce(${geoSites.crawlCount}, 0) + 1`,
    updatedAt: now,
    ...(contentStrategyScores ? { contentStrategyScores } : {}),
    ...perPageUpdates,
    ...implementationStatusUpdates,
    ...bulkUpdates,
  }).where(eq(geoSites.id, siteId));

  const [completedSite] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (completedSite?.ownerEmail && completedSite.accessToken) {
    await sendCompletionEmail(
      completedSite.ownerEmail,
      domain,
      siteId,
      completedSite.accessToken,
      geoScorecard.overallScore,
      projectedScore,
      // ES-083 AC-12: surface the auto-discovered URL count in the email when > 0
      (completedSite.autoDiscoveredUrlCount as number | null) ?? 0,
    );
  }

  // GMC audit purchase: kick off the finalize stage (competitor discovery +
  // citation check + delivery email). Marketing copy promises competitor
  // benchmark + 120-query AI citation check; assemble alone doesn't produce
  // those, so the delivery email must wait. The finalize stage is idempotent
  // and gates email send on auditPurchases.pdfDeliveredAt.
  try {
    const [purchase] = await db
      .select()
      .from(auditPurchases)
      .where(eq(auditPurchases.siteId, siteId));
    if (purchase && purchase.status !== "delivered") {
      await enqueueStage({ siteId, domain, stage: "audit-purchase-finalize" });
      console.warn(`[stage:assemble] ${domain} — enqueued audit-purchase-finalize for emailHash:${emailHash(purchase.customerEmail)}`);
    }
  } catch (purchaseErr) {
    console.error(`[stage:assemble] ${domain} — audit-purchase-finalize enqueue failed:`, purchaseErr);
  }

  console.warn(`[stage:assemble] ${domain} — complete. Score: ${geoScorecard.overallScore} → projected: ${projectedScore}`);
}

// ── audit-purchase-finalize ───────────────────────────────────────────────
//
// Post-assemble enrichment for $10 GMC audit purchases. Marketing copy
// promises three things on top of the basic 16-pillar audit: competitor
// benchmark / Share of Voice, 120-query AI citation check, and a PDF report.
// The basic pipeline (assemble → done) doesn't produce competitor or
// citation data, so the PDF was rendering empty sections.
//
// This stage runs AFTER assemble for audit_purchase rows. It:
//   1. Runs competitor discovery via internal HTTP call (uses ?purchaseToken
//      auth bypass added to /api/sites/[id]/competitor-discovery — no
//      credit deduction).
//   2. Runs citation check via internal HTTP call (same purchaseToken
//      bypass; skips rate limit + credit gate).
//   3. Sends sendAuditPurchaseDeliveryEmail with the purchaseToken-bearing
//      PDF link.
//   4. Marks auditPurchases.pdfDeliveredAt to gate against double-send.
//
// Idempotency:
//   - Returns early if pdfDeliveredAt is already set.
//   - Skips competitor discovery if discoveredCompetitors already populated.
//   - Skips citation check if a citationCheckScores row already exists.
// All three guards mean a stage retry (QStash retries=0 + cron safety net)
// never double-charges work that's already done.
async function handleAuditPurchaseFinalize(siteId: string, domain: string): Promise<void> {
  const [purchase] = await db
    .select()
    .from(auditPurchases)
    .where(eq(auditPurchases.siteId, siteId));

  if (!purchase) {
    console.warn(`[stage:audit-purchase-finalize] ${domain} — no auditPurchases row for siteId=${siteId}; skipping`);
    return;
  }

  // Idempotency gate: already delivered → no-op.
  if (purchase.pdfDeliveredAt) {
    console.warn(`[stage:audit-purchase-finalize] ${domain} — already delivered at ${purchase.pdfDeliveredAt.toISOString()}; skipping`);
    return;
  }

  const callbackBase =
    process.env.QSTASH_CALLBACK_BASE
    ?? process.env.PIPELINE_CALLBACK_URL
    ?? process.env.NEXT_PUBLIC_APP_URL
    ?? "http://localhost:3000";
  const purchaseToken = purchase.purchaseToken;

  // Step 1 — competitor discovery (idempotent: skip if already populated).
  const [siteForDiscovery] = await db
    .select({ discoveredCompetitors: geoSites.discoveredCompetitors, userCompetitors: geoSites.userCompetitors })
    .from(geoSites)
    .where(eq(geoSites.id, siteId));
  const discovered = (siteForDiscovery?.discoveredCompetitors ?? []) as unknown[];
  const userCompetitors = (siteForDiscovery?.userCompetitors ?? []) as unknown[];
  if (discovered.length === 0 && userCompetitors.length === 0) {
    try {
      const discoveryUrl = `${callbackBase}/api/sites/${siteId}/competitor-discovery`;
      console.warn(`[stage:audit-purchase-finalize] ${domain} — calling competitor-discovery`);
      const resp = await fetch(discoveryUrl, {
        method: "POST",
        headers: { "X-Purchase-Token": purchaseToken },
      });
      if (resp.body) {
        // Drain SSE stream to completion.
        const reader = resp.body.getReader();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
      if (!resp.ok) {
        console.warn(`[stage:audit-purchase-finalize] ${domain} — competitor-discovery returned ${resp.status}; continuing`);
      }
    } catch (err) {
      console.error(`[stage:audit-purchase-finalize] ${domain} — competitor-discovery failed:`, err);
      // Soft-fail: continue to citation check + email — partial PDF is still
      // worth delivering vs no email at all. PDF section will say
      // "No competitor data available" — same as pre-fix behavior.
    }
  } else {
    console.warn(`[stage:audit-purchase-finalize] ${domain} — competitor discovery skipped (already populated: ${discovered.length} discovered, ${userCompetitors.length} user)`);
  }

  // Step 2 — citation check (idempotent: skip if a row already exists).
  const existingScores = await db
    .select({ checkId: citationCheckScores.checkId })
    .from(citationCheckScores)
    .where(eq(citationCheckScores.siteId, siteId))
    .limit(1);
  if (existingScores.length === 0) {
    try {
      const checkUrl = `${callbackBase}/api/sites/${siteId}/citation-check`;
      console.warn(`[stage:audit-purchase-finalize] ${domain} — calling citation-check`);
      const resp = await fetch(checkUrl, {
        method: "POST",
        headers: { "X-Purchase-Token": purchaseToken },
      });
      if (resp.body) {
        const reader = resp.body.getReader();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
      if (!resp.ok) {
        console.warn(`[stage:audit-purchase-finalize] ${domain} — citation-check returned ${resp.status}; continuing`);
      }
    } catch (err) {
      console.error(`[stage:audit-purchase-finalize] ${domain} — citation-check failed:`, err);
      // Soft-fail same rationale as discovery.
    }
  } else {
    console.warn(`[stage:audit-purchase-finalize] ${domain} — citation check skipped (${existingScores.length} score row already exists)`);
  }

  // Step 3 — fetch the assembled scorecard for the email score number + top pillars (B4).
  const [siteFinal] = await db
    .select({ geoScorecard: geoSites.geoScorecard })
    .from(geoSites)
    .where(eq(geoSites.id, siteId));
  const scorecard = (siteFinal?.geoScorecard ?? null) as { overallScore?: number; pillars?: Array<{ pillarName: string; score: number }> } | null;
  const overallScore = scorecard?.overallScore ?? 0;

  // Task B4 — derive top-3 lowest-scoring pillar names for the install-CTA copy.
  // Sorted ascending by score; top 3 weakest pillars surface highest-impact work.
  // Guard against malformed scorecard shapes — fall back to [] so the email CTA
  // degrades gracefully to "Open your dashboard".
  let topPillars: string[] = [];
  try {
    const pillars = Array.isArray(scorecard?.pillars) ? scorecard!.pillars : [];
    topPillars = pillars
      .filter((p) => typeof p.score === "number" && typeof p.pillarName === "string")
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map((p) => p.pillarName);
  } catch (scorecardErr) {
    console.warn(`[stage:audit-purchase-finalize] ${domain} — pillar extraction failed (topPillars=[]):`, scorecardErr);
  }

  // Task B1 — render PDF buffer before delivery email.
  // If rendering fails: alert ops, mark failed, send customer failure email, skip delivery.
  let pdfBuffer: { buffer: Buffer; filename: string };
  try {
    pdfBuffer = await renderAuditPdfBuffer(siteId, { purchaseToken });
  } catch (pdfErr) {
    console.error(`[stage:audit-purchase-finalize] ${domain} — PDF render failed; routing through markFailed for refund:`, pdfErr);
    await markFailed(siteId, pdfErr);
    return;
  }

  // Task B3 — magic-link expiry check + regenerate before delivery.
  // If the stored link is expired (or null), try to regenerate. Non-fatal if it fails.
  let freshMagicLink: string | undefined;
  try {
    const now = Date.now();
    const linkExpired =
      !purchase.magicLink ||
      !purchase.magicLinkExpiresAt ||
      purchase.magicLinkExpiresAt.getTime() <= now;

    if (!linkExpired && purchase.magicLink) {
      // Still valid — use as-is.
      freshMagicLink = purchase.magicLink;
    } else {
      // Regenerate.
      const supaAdmin = getSupabaseAdmin();
      if (supaAdmin) {
        const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
        const { data: linkData, error: linkErr } = await supaAdmin.auth.admin.generateLink({
          type: "magiclink",
          email: purchase.customerEmail,
          options: { redirectTo: `${appBase}/dashboard?onboard=install` },
        });
        if (linkErr) {
          console.warn(`[stage:audit-purchase-finalize] ${domain} — magic link regeneration failed (continuing without):`, linkErr.message);
        } else {
          freshMagicLink = linkData?.properties?.action_link ?? undefined;
          if (freshMagicLink) {
            // Stamp the fresh link + new expiry. Do NOT log freshMagicLink.
            await db
              .update(auditPurchases)
              .set({
                magicLink: freshMagicLink,
                magicLinkExpiresAt: new Date(now + 60 * 60 * 1000),
                updatedAt: new Date(),
              })
              .where(eq(auditPurchases.id, purchase.id));
            console.warn(`[stage:audit-purchase-finalize] ${domain} — magic link regenerated`);
          }
        }
      } else {
        console.warn(`[stage:audit-purchase-finalize] ${domain} — supaAdmin unavailable; magic link skipped`);
      }
    }
  } catch (linkErr) {
    console.warn(`[stage:audit-purchase-finalize] ${domain} — magic link handling threw (continuing without):`, linkErr);
    freshMagicLink = undefined;
  }

  // Step 4 — write pdfDeliveredAt via CAS FIRST, then send delivery email,
  // then scrub the magic-link ONLY after email succeeds.
  //
  // Ordering rationale (Fix B2):
  //   1. pdfDeliveredAt CAS write — commits the idempotency marker before any
  //      side-effect. If the process crashes after this point, the QStash retry
  //      gate (pdfDeliveredAt != NULL) prevents a duplicate delivery email.
  //   2. Delivery email send — the magic-link is still present in DB, so a
  //      crashed-then-retried invocation can read it from the re-fetched row.
  //      The idempotency gate stops the retry before it reaches the email send.
  //   3. Scrub magicLink ONLY on email-send success — if the email fails we
  //      preserve the link so operators can resend manually. A retry would be
  //      stopped by the pdfDeliveredAt gate anyway, so there is no double-send
  //      risk in leaving the link in place.
  //
  //   Old (Bravo) order — scrub BEFORE pdfDeliveredAt — was wrong: a crash
  //   between steps would leave pdfDeliveredAt unset, so QStash would retry,
  //   regenerate a fresh magic-link, and send a second delivery email.
  const updated = await db
    .update(auditPurchases)
    .set({ status: "delivered", pdfDeliveredAt: new Date(), updatedAt: new Date() })
    .where(and(eq(auditPurchases.id, purchase.id), isNull(auditPurchases.pdfDeliveredAt)));

  // If updated returns rowCount=0, another in-flight retry already won the race.
  // (drizzle's update return shape varies by driver; we re-read to confirm.)
  const [confirm] = await db.select({ pdfDeliveredAt: auditPurchases.pdfDeliveredAt }).from(auditPurchases).where(eq(auditPurchases.id, purchase.id));
  if (!confirm?.pdfDeliveredAt) {
    console.warn(`[stage:audit-purchase-finalize] ${domain} — pdfDeliveredAt write failed; skipping email send to avoid duplicate`);
    return;
  }

  try {
    const siteUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com"}/sites/${siteId}?token=${purchaseToken}`;
    await sendAuditPurchaseDeliveryEmail(
      purchase.customerEmail,
      domain,
      pdfBuffer,
      { magicLink: freshMagicLink, overallScore, topPillars, siteUrl },
    );
    console.warn(`[stage:audit-purchase-finalize] ${domain} — delivery email sent to emailHash:${emailHash(purchase.customerEmail)}`);

    // Scrub magicLink AFTER successful email delivery — preserve for manual
    // resend if email send throws. No double-send risk: the pdfDeliveredAt gate
    // stops any retry before it reaches the email send.
    await db
      .update(auditPurchases)
      .set({ magicLink: null, magicLinkExpiresAt: null, updatedAt: new Date() })
      .where(eq(auditPurchases.id, purchase.id));
  } catch (emailErr) {
    console.error(`[stage:audit-purchase-finalize] ${domain} — delivery email failed:`, emailErr);
    // Email failed but pdfDeliveredAt is already set — acceptable. Operator
    // can resend manually using the preserved magicLink; the pdfDeliveredAt
    // marker prevents automated retries from re-sending.
    sendInternalPaymentAlert({
      customerEmail: purchase.customerEmail,
      type: "audit_purchase_failed",
      domain,
      note: `Delivery email failed (pdfDeliveredAt committed; magicLink preserved for manual resend): ${emailErr instanceof Error ? emailErr.message : String(emailErr)}`,
      timestamp: new Date().toISOString(),
    }).catch((e) => console.warn("[stage] email-fail ops alert failed:", e));
    void updated;
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function verifyAuth(req: NextRequest, rawBody: string): Promise<boolean> {
  const secret = req.headers.get("authorization")?.replace("Bearer ", "");
  if (process.env.CRON_SECRET && secret === process.env.CRON_SECRET) return true;

  const sig = req.headers.get("upstash-signature");
  if (!sig) return false;

  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim();
  const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY?.trim();
  if (!currentKey || !nextKey) return false;

  try {
    const receiver = new Receiver({ currentSigningKey: currentKey, nextSigningKey: nextKey });
    const baseUrl =
      process.env.PIPELINE_CALLBACK_URL ??
      process.env.NEXT_PUBLIC_APP_URL ??
      `https://${req.headers.get("host")}`;
    const url = `${baseUrl}/api/pipeline/stage`;
    await receiver.verify({ signature: sig, body: rawBody, url });
    return true;
  } catch {
    return false;
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  if (!(await verifyAuth(req, rawBody))) {
    console.error("[stage] Unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: StagePayload;
  try {
    payload = JSON.parse(rawBody) as StagePayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Stage-specific fields (maxPages, chunkIndex, firecrawlJobId,
  // generateChunkType) live on individual StagePayload union members and are
  // read after narrowing on payload.stage in the switch below — destructuring
  // them up here would not type-check against the discriminated union.
  const { siteId, domain, stage, stageRetryCount, runNumber } = payload;

  if (!siteId || !domain || !stage) {
    return NextResponse.json({ error: "siteId, domain, and stage are required" }, { status: 400 });
  }

  // ES-B10 AC-B10-6 — QStash idempotency. When the payload carries a
  // runNumber, compare it to the site's currentRunNumber and silently
  // ack-with-200 on mismatch — the message is stale (from an aborted prior
  // run) and must not re-execute pipeline work against the new in-place
  // state. A missing runNumber is treated as 'no idempotency requested'
  // for legacy compatibility.
  if (typeof runNumber === "number") {
    const [staleCheck] = await db
      .select({
        currentRunNumber: geoSites.currentRunNumber,
        pipelineStatus: geoSites.pipelineStatus,
      })
      .from(geoSites)
      .where(eq(geoSites.id, siteId));
    const currentRunNumber = staleCheck?.currentRunNumber ?? 1;
    if (runNumber !== currentRunNumber) {
      // FIND-SILENTFAILURE-022: a stale message (runNumber != currentRunNumber)
      // is ack-dropped so it cannot execute against the new in-place run. The
      // orphan risk is when the CURRENT run has no live message AND the row is
      // non-terminal — the audit would then stall forever. We do NOT re-enqueue
      // here: at ack-drop time we cannot tell whether the current run already
      // has a live driver, so an immediate re-enqueue could create a DUPLICATE
      // driver (double fan-out). The correct, staleness-gated recovery is the
      // cron safety-net (app/api/cron/process-queue), which re-enqueues only
      // sites demonstrably stuck. We log the non-terminal case at error level so
      // an orphaned run is observable rather than silent.
      const status = staleCheck?.pipelineStatus ?? null;
      const terminal = status === "complete" || status === "failed";
      const log = terminal ? console.warn : console.error;
      log(JSON.stringify({
        event: "stage_runNumber_mismatch",
        siteId,
        stage,
        payloadRunNumber: runNumber,
        currentRunNumber,
        pipelineStatus: status,
        action: "ack_drop",
        recovery: terminal ? "none_needed" : "cron_safety_net",
      }));
      return NextResponse.json({ ok: true, dropped: "stale_run" });
    }
  }

  console.warn(`[stage] Starting stage=${stage} siteId=${siteId} domain=${domain} runNumber=${runNumber ?? "n/a"}`);

  try {
    switch (payload.stage) {
      case "discover":
        await handleDiscover(siteId, domain, payload.maxPages);
        break;
      case "crawl-fanout":
        await handleCrawlFanout(siteId, domain);
        break;
      case "poll-chunk":
        await handlePollChunk(siteId, domain, payload.chunkIndex, payload.firecrawlJobId);
        break;
      case "merge-crawl":
        await handleMergeCrawl(siteId, domain);
        break;
      case "extract-trees":
        await handleExtractTrees(siteId, domain);
        break;
      case "research":
        await handleResearch(siteId, domain);
        break;
      case "analyze":
        await handleAnalyze(siteId, domain);
        break;
      case "generate":           // legacy alias
      case "generate-fanout":
        await handleGenerateFanout(siteId, domain);
        break;
      case "generate-chunk":
        await handleGenerateChunk(siteId, domain, payload.generateChunkType);
        break;
      case "assemble":
        await handleAssemble(siteId, domain);
        break;
      case "audit-purchase-finalize":
        await handleAuditPurchaseFinalize(siteId, domain);
        break;
      default:
        // FIND-SILENTFAILURE-016: an unknown stage must THROW so it flows into
        // the catch -> markFailed. Previously it only console.error'd, fell out
        // of the switch, and returned 200 — QStash (retries=0) dropped the
        // message and the audit froze in-progress forever with no failed status.
        throw new Error(`Unknown pipeline stage: ${stage}`);
    }
  } catch (err) {
    // AI stages are safe to retry — no side-effects beyond DB reads/writes and LLM API calls.
    // generate-fanout is NOT retried: it enqueues generate-chunk messages (duplicate fan-out risk).
    // Crawl/discover stages are NOT retried: they fire Firecrawl jobs.
    // extract-trees is NOT retried (Issue R, 2026-04-27): the handler already
    // has a 3-attempt internal fallback (Sonnet temp=0 → Sonnet temp=0.3 →
    // OpenAI). Adding 2 stage-level retries on top multiplies the same flaky
    // chain by 3× — burning 3× compute and 3× the LLM bill on the exact same
    // failure mode. With STAGE_TIMEOUT_MS=785_000 (above), the internal chain
    // has room to complete. If it still fails, retrying won't help.
    const retryableStages: PipelineStage[] = ["research", "analyze", "generate-chunk", "assemble"];
    const MAX_STAGE_RETRIES = 2;
    const retryCount = stageRetryCount ?? 0;

    if (retryableStages.includes(stage as PipelineStage) && retryCount < MAX_STAGE_RETRIES) {
      const nextRetry = retryCount + 1;
      const delaySeconds = 30 * nextRetry; // 30s, then 60s
      console.warn(`[stage] Stage ${stage} failed for site ${siteId} (attempt ${nextRetry}/${MAX_STAGE_RETRIES}), retrying in ${delaySeconds}s:`, err);
      try {
        await enqueueStage({ ...payload, stageRetryCount: nextRetry }, delaySeconds);
      } catch (enqueueErr) {
        console.error(`[stage] Failed to re-enqueue retry for site ${siteId}:`, enqueueErr);
        // AC-B1-3: replace the swallowing `.catch(() => {})` with a
        // retry-once-then-rethrow helper. If markFailed itself fails twice
        // (DB outage), let the throw bubble out — QStash redelivery will
        // re-fire the stage and the next attempt's outer catch tries again.
        // Compound retry count is bounded by QStash's own retry cap.
        await markFailedWithRetry(siteId, err);
      }
    } else {
      console.error(`[stage] Stage ${stage} permanently failed for site ${siteId}:`, err);
      // AC-B1-3 / AC-B1-4: same retry-then-rethrow shape on the permanent
      // failure path so a transient DB blip doesn't leave the row in a
      // non-terminal state.
      await markFailedWithRetry(siteId, err);
    }
  }

  // AC-B1-7 safety net: before signaling QStash success, verify the row is
  // in a terminal state (`complete` or `failed`) OR is the documented
  // pre-state of the next stage in the pipeline (e.g. `extracting`,
  // `researching`, `analyzing`, `generating`, `assembling` while the next
  // stage is mid-flight). If the row is `pending` after we ran a stage,
  // some inner handler must have silently returned without writing a
  // status — flip it to `failed` so the dashboard never shows zombie-
  // pending. This is a belt-and-braces guard, NOT the primary contract.
  try {
    const [row] = await db
      .select({ status: geoSites.pipelineStatus })
      .from(geoSites)
      .where(eq(geoSites.id, siteId));
    const status = row?.status ?? null;
    const ALLOWED_NON_TERMINAL: ReadonlyArray<string> = [
      "discovery",
      "crawling",
      "extracting",
      "researching",
      "analyzing",
      "generating",
      "assembling",
    ];
    const TERMINAL: ReadonlyArray<string> = ["complete", "failed"];
    if (status && !TERMINAL.includes(status) && !ALLOWED_NON_TERMINAL.includes(status)) {
      console.error(
        `[stage] AC-B1-7 safety-net: stage=${stage} site=${siteId} exited with non-terminal status=${status}; flipping to failed`,
      );
      await markFailedWithRetry(
        siteId,
        new Error(`Pipeline exited stage=${stage} without writing terminal status (saw '${status}')`),
      );
    }
  } catch (safetyErr) {
    console.error(`[stage] AC-B1-7 safety-net check failed for site ${siteId}:`, safetyErr);
  }

  // Always return 200 — QStash must not retry
  return NextResponse.json({ ok: true });
}
