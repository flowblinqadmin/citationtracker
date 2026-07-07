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
import { executeTrackerRun, failRun } from "@/lib/engine/runner";
import { enqueueTrackerJob, trackerWorkerUrl, type TrackerJobPayload } from "@/lib/engine/enqueue";
import { cronBearerValid } from "@/lib/cron-auth";
import { TRACKER_WORKER_DEADLINE_MS } from "@/lib/config";

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

  const deadline = Date.now() + TRACKER_WORKER_DEADLINE_MS;
  try {
    const result = await executeTrackerRun(runId, clientId, cursor, deadline);
    if (result.status === "paused") {
      // Re-enqueue from where we stopped.
      await enqueueTrackerJob({ runId, clientId, cursor: result.cursor });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[tracker-worker] run failed:", runId, message);
    await failRun(runId, message).catch(() => {});
    // 200 so QStash (retries=0) does not retry; the cron re-enqueues stale runs.
    return NextResponse.json({ ok: false, error: message });
  }
}
