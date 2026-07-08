// Tracker worker — executes (and resumes) a run on THIS service.
//
// Ported from geo's /api/tracker/worker. Auth: QStash upstash-signature
// (verified against the exact public worker URL) OR Bearer CRON_SECRET
// (constant-time; used by the local-dev direct fallback and manual ops).
// Lives under /api/cron/ so the default-deny middleware admits it without a
// session — auth is enforced here, not there.
//
// Long runs re-enqueue themselves with a cursor before the maxDuration
// ceiling. Fatal errors mark the run failed and return HTTP 200 {ok:false}:
// QStash publishes with retries:0, and the tracker-run cron's stale recovery
// is the retry path — a 5xx here would buy nothing.
import { NextRequest, NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { executeTrackerRun, failRun, type RunnerDeps } from "@/lib/engine/runner";
import { enqueueTrackerJob, trackerWorkerUrl, type TrackerJobPayload } from "@/lib/engine/enqueue";
import { runOrgId } from "@/lib/tracker-db";
import { cronBearerValid } from "@/lib/cron-auth";
import { TRACKER_WORKER_DEADLINE_MS } from "@/lib/config";

/** True in a deployed environment (Vercel or an explicit production build). */
function isDeployed(): boolean {
  return !!process.env.VERCEL || process.env.NODE_ENV === "production";
}

/**
 * E2E seam (E2E_FAKE_PROVIDERS=1, set only by playwright.config.ts):
 * deterministic provider stubs so Playwright exercises the REAL runner —
 * worklist, persistence, matching, sentiment, metrics — without provider keys
 * or network. The stub echoes the prompt (so prompts containing the brand
 * name register as brand mentions) and always cites one page on the e2e
 * brand's domain plus one third-party page.
 *
 * FAIL-SAFE: the seam writes fabricated data into the SHARED prod tables, so it
 * is refused in any deployed environment — a stray flag there falls back to
 * REAL providers (never faked data) and screams in the logs, rather than
 * failing runs closed.
 */
function e2eDeps(): RunnerDeps {
  if (process.env.E2E_FAKE_PROVIDERS !== "1") return {};
  if (isDeployed()) {
    console.error(
      "[tracker-worker] E2E_FAKE_PROVIDERS set in a DEPLOYED environment — ignoring; using real providers",
    );
    return {};
  }
  console.warn("[tracker-worker] E2E_FAKE_PROVIDERS active — fixture providers (local test only)");
  const fake = async (prompt: string) => ({
    text: `1. Options for "${prompt.slice(0, 120)}" — e2e provider fixture.`,
    responseTimeMs: 5,
    citedUrls: ["https://acme-e2e.com/reviews/best-tools", "https://thirdparty.example/roundup"],
  });
  return {
    queryFns: { perplexity: fake, openai: fake, google: fake, anthropic: fake },
    resolveRedirectsFn: async (url: string) => url,
    classifySentimentFn: async () => "positive" as const,
  };
}

// Keep equal to WORKER_MAX_DURATION_S in lib/config.ts (Next.js requires a
// statically-analyzable literal here).
export const maxDuration = 800;

async function verifyAuth(req: NextRequest, rawBody: string): Promise<boolean> {
  if (cronBearerValid(req)) return true;

  const sig = req.headers.get("upstash-signature");
  if (!sig) return false;
  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim();
  const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY?.trim();
  if (!currentKey || !nextKey) return false;
  try {
    const receiver = new Receiver({ currentSigningKey: currentKey, nextSigningKey: nextKey });
    await receiver.verify({ signature: sig, body: rawBody, url: trackerWorkerUrl() });
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  if (!(await verifyAuth(req, rawBody))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: TrackerJobPayload;
  try {
    payload = JSON.parse(rawBody) as TrackerJobPayload;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  const { runId, clientId, cursor = 0 } = payload;
  if (!runId || !clientId) {
    return NextResponse.json({ error: "runId and clientId required" }, { status: 400 });
  }

  // Tenancy guard at the execution boundary: CE must NEVER execute a non-team
  // (PCG) run on its own provider keys, whatever the enqueue path. The invariant
  // is enforced at every enqueue site too, but CRON_SECRET is shared with geo —
  // this closes the trust boundary against a misdirected/hostile authed caller.
  // (null = run not found → let executeTrackerRun no-op it as 'skipped'.)
  const orgId = await runOrgId(runId);
  if (orgId && !orgId.startsWith("team_")) {
    console.error("[tracker-worker] refusing non-team run:", runId, orgId);
    return NextResponse.json({ ok: false, error: "non-team run refused" });
  }

  const deadline = Date.now() + TRACKER_WORKER_DEADLINE_MS;

  let result;
  try {
    result = await executeTrackerRun(runId, clientId, cursor, deadline, undefined, e2eDeps());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[tracker-worker] run failed:", runId, message);
    await failRun(runId, message).catch(() => {});
    // 200 so QStash (retries=0) does not retry; the cron re-enqueues stale runs.
    return NextResponse.json({ ok: false, error: message });
  }

  if (result.status === "paused") {
    // Re-enqueue from where we stopped. A publish failure here must NOT fail the
    // run: execution succeeded and the run is still 'running' with every
    // completed pair persisted, so stale recovery will re-enqueue it. Calling
    // failRun would strand that work AND trigger a full refund in reconcile.
    try {
      await enqueueTrackerJob({ runId, clientId, cursor: result.cursor });
    } catch (enqErr) {
      console.error(
        "[tracker-worker] self-resume enqueue failed; leaving run for stale recovery:",
        runId,
        enqErr instanceof Error ? enqErr.message : String(enqErr),
      );
      return NextResponse.json({ ok: false, status: "paused", cursor: result.cursor, resumeDeferred: true });
    }
  }
  return NextResponse.json({ ok: true, ...result });
}
