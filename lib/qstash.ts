import { Client } from "@upstash/qstash";

export const qstash = new Client({ token: process.env.QSTASH_TOKEN! });

export type GenerateChunkType = "llms" | "business" | "schema-sitewide" | "schema-faq" | "schema-article" | "page-fixes";

export type PipelineStage =
  | "discover"
  | "crawl-fanout"      // replaces "crawl"
  | "poll-chunk"        // replaces "poll"
  | "merge-crawl"
  | "extract-trees"     // C2+C3: geo + category tree extraction (ES-053)
  | "research"
  | "analyze"
  | "generate"          // legacy alias → generate-fanout
  | "generate-fanout"   // fans out 3 generate-chunk messages
  | "generate-chunk"    // processes one asset type (llms | business | schema)
  | "assemble"
  | "audit-purchase-finalize"; // GMC: post-assemble enrichment for $10 audits — competitor discovery + citation check + delivery email

/**
 * Fields shared by every pipeline stage payload.
 *
 * stageRetryCount / runNumber are cross-cutting (retry bookkeeping +
 * ES-B10 AC-B10-6 QStash idempotency: stage handlers compare runNumber to
 * site.currentRunNumber and silently 200 on mismatch) so they live on the
 * base, present on all variants.
 */
interface StagePayloadBase {
  siteId: string;
  domain: string;
  stageRetryCount?: number;       // retry counter
  runNumber?: number;
}

/**
 * StagePayload is a discriminated union keyed on `stage` (BUG-001 / FIX-007).
 *
 * Each stage carries EXACTLY the fields it consumes, so a payload that omits a
 * load-bearing field is a compile error rather than something the handler
 * silently papers over with a wrong default:
 *   - discover REQUIRES maxPages — the page budget. Previously maxPages was
 *     optional on a flat type and the handler did `maxPages ?? FREE_MAX_PAGES`,
 *     so any enqueue path that forgot the budget silently crawled 20 pages and
 *     reported 'complete' (the literal Pro-20-pages symptom). Making it
 *     required forces every enqueue('discover') call site to pass the budget.
 *   - crawl-fanout does NOT consume a budget: the handler derives its working
 *     URL set from discoveryData (already capped at discover) / site.crawlLimit
 *     (bulk). maxPages is kept OPTIONAL and inert here only so existing callers
 *     that still pass it type-check; the handler ignores it.
 *   - poll-chunk REQUIRES chunkIndex + firecrawlJobId (was `?? 0` / `?? ""`).
 *   - generate-chunk REQUIRES generateChunkType (was `?? "llms"`).
 *   - the remaining stages carry only the base fields.
 */
export type StagePayload =
  | (StagePayloadBase & { stage: "discover"; maxPages: number })
  | (StagePayloadBase & { stage: "crawl-fanout"; maxPages?: number })
  | (StagePayloadBase & { stage: "poll-chunk"; chunkIndex: number; firecrawlJobId: string })
  | (StagePayloadBase & { stage: "generate-chunk"; generateChunkType: GenerateChunkType })
  | (StagePayloadBase & {
      stage:
        | "merge-crawl"
        | "extract-trees"
        | "research"
        | "analyze"
        | "generate"
        | "generate-fanout"
        | "assemble"
        | "audit-purchase-finalize";
    });

/**
 * Enqueue a pipeline stage via QStash.
 *
 * retries: 0 is critical — QStash must NOT auto-retry on non-200. All failures
 * are written to the DB. Re-runs are always user-initiated via /regenerate.
 * The cron safety-net will re-enqueue stale stages automatically.
 */
export async function enqueueStage(
  payload: StagePayload,
  delaySeconds = 0
): Promise<void> {
  // LOCAL_PIPELINE mode: call localhost directly, skip QStash entirely
  if (process.env.LOCAL_PIPELINE === "1") {
    if (delaySeconds > 0) await new Promise(r => setTimeout(r, delaySeconds * 1000));
    const localUrl = `${process.env.PIPELINE_CALLBACK_URL ?? "http://localhost:3050"}/api/pipeline/stage`;
    const cronSecret = process.env.CRON_SECRET;
    const resp = await fetch(localUrl, {
      method: "POST",
      headers: {
        ...(cronSecret ? { "Authorization": `Bearer ${cronSecret}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Local pipeline call failed (${resp.status}): ${text.slice(0, 200)}`);
    }
    return;
  }

  // Callback base precedence:
  //   QSTASH_CALLBACK_BASE (preferred — operator-set for ephemeral
  //     tunnels in local dev, see docs/local-dev-qstash.md)
  //   PIPELINE_CALLBACK_URL (legacy — kept for back-compat with existing
  //     .env.local / deploys that already set it)
  //   NEXT_PUBLIC_APP_URL (prod default)
  //   http://localhost:3000 (last-resort local fallback — QStash will 400
  //     on localhost callbacks, which is the exact failure that motivated
  //     OPT-A NODE_ENV-test bypass; the fallback exists only so the throw
  //     happens in QStash-land with a clear message rather than a TypeError).
  const callbackBase =
    process.env.QSTASH_CALLBACK_BASE
    ?? process.env.PIPELINE_CALLBACK_URL
    ?? process.env.NEXT_PUBLIC_APP_URL
    ?? "http://localhost:3000";
  await qstash.publishJSON({
    url: `${callbackBase}/api/pipeline/stage`,
    body: payload,
    ...(delaySeconds > 0 ? { delay: delaySeconds } : {}),
    retries: 0,
  });
}
