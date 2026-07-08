// QStash publish to THIS service's worker.
//
// The target is CITATIONS_WORKER_BASE — the direct vercel.app URL including
// the /citations basePath, never the geo rewrite: geo must not sit in the
// execution loop, and QStash signature verification is exact-URL. Retries: 0 —
// the tracker-run cron's stale recovery is the retry path (geo's contract,
// unchanged).
//
// QStash accounts are regional: QSTASH_URL must point at the account's
// endpoint (qstash-us-east-1.upstash.io) or publishes 404 (bit us live).

import { CITATIONS_WORKER_BASE } from "@/lib/config";
import { getCronSecret } from "@/lib/cron-auth";

export interface TrackerJobPayload {
  runId: string;
  clientId: string;
  cursor?: number;
}

export function trackerWorkerUrl(): string {
  return `${CITATIONS_WORKER_BASE}/api/cron/tracker-worker`;
}

export async function enqueueTrackerJob(
  payload: TrackerJobPayload,
  delaySeconds = 0,
): Promise<void> {
  const workerUrl = trackerWorkerUrl();
  const body = JSON.stringify(payload);
  const qstashToken = process.env.QSTASH_TOKEN;

  if (qstashToken) {
    const qstashBase = process.env.QSTASH_URL ?? "https://qstash.upstash.io";
    const res = await fetch(`${qstashBase}/v2/publish/${workerUrl}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${qstashToken}`,
        "Content-Type": "application/json",
        "Upstash-Retries": "0",
        ...(delaySeconds > 0 ? { "Upstash-Delay": `${delaySeconds}s` } : {}),
      },
      body,
    });
    if (!res.ok) throw new Error(`QStash publish failed: ${res.status}`);
    return;
  }

  // No QSTASH_TOKEN. In a DEPLOYED environment this is env drift, not local dev:
  // the direct fallback below is fire-and-forget on a lambda that freezes right
  // after the response, so the worker call frequently never lands — the run
  // would be debited and never executed, with no error surfaced (the run
  // route's refund path only fires when enqueue THROWS). Fail loud instead so
  // the caller refunds and the misconfig is caught. (QStash also can't sign the
  // request without a token, so there is no safe deployed path here anyway.)
  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    throw new Error("QSTASH_TOKEN is required in deployed environments — refusing the unreliable direct-call fallback");
  }

  // Local dev fallback: call the worker directly, fire-and-forget (a chunk can
  // run for minutes; QStash delivery is async too, so callers must not depend
  // on completion). Auth via the shared cron secret.
  if (delaySeconds > 0) await new Promise((r) => setTimeout(r, delaySeconds * 1000));
  void fetch(workerUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${getCronSecret()}`, "Content-Type": "application/json" },
    body,
  }).catch((err) => console.error(`[engine/enqueue] direct worker call failed for ${payload.runId}:`, err));
}
