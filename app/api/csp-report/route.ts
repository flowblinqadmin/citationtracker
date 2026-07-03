/**
 * ES-090 §b.7 L-2 HP-190 — CSP violation report ingest.
 *
 * Browsers POST CSP violations here (via `report-uri` + `report-to`) and we
 * scrub PII before forwarding to Sentry. Query strings and fragments are
 * stripped from every URL-like field because browsers send reports directly
 * — bypassing the Sentry SDK's `beforeSend`, so scrubbing must happen here.
 *
 * Always returns 204 (including on malformed JSON) — 4xx would surface as
 * uncaught errors in the browser console for no operational benefit.
 */

import { NextRequest, NextResponse } from "next/server";
// Sentry SDK ships in PR#2+ (OBS-1). Stub until then.
const captureMessage: (msg: string, ctx?: unknown) => void = () => {};
import { checkRateLimit } from "@/lib/rate-limit";

type CspReportBody = Record<string, unknown>;

/** Strip ?query and #fragment from a URL-like string. Preserves path. */
function stripUriPii(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  // Two fast paths: URL() handles absolute; for relative we split manually.
  const q = raw.indexOf("?");
  const h = raw.indexOf("#");
  const cut = [q, h].filter((i) => i >= 0);
  if (cut.length === 0) return raw;
  return raw.slice(0, Math.min(...cut));
}

const URI_FIELDS = ["document-uri", "blocked-uri", "referrer", "source-file"];

function scrubReport(report: CspReportBody): CspReportBody {
  const out: CspReportBody = { ...report };
  for (const key of URI_FIELDS) {
    if (key in out) out[key] = stripUriPii(out[key]);
  }
  return out;
}

function reportToSentry(report: CspReportBody): void {
  const scrubbed = scrubReport(report);
  const directive = String(scrubbed["violated-directive"] ?? "unknown");
  const disposition = String(scrubbed["disposition"] ?? "enforce");
  captureMessage(`csp-violation: ${directive}`, {
    level: "warning",
    tags: { directive, disposition },
    contexts: { csp: scrubbed },
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── HP-225: per-IP rate-limit before any payload parsing or Sentry call.
  // Browsers will generate CSP reports at high volume if something breaks
  // (e.g. a misconfigured third-party script fires 1 report per page view).
  // 100 requests / 60s per IP keeps Sentry quota intact. Silent 204 on deny
  // per HP's reco — no attacker signal about the gate.
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const rl = await checkRateLimit(`csp_report:${ip}`, 100, 60_000);
  if (!rl.allowed) return new NextResponse(null, { status: 204 });

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    // Malformed — swallow silently.
    return new NextResponse(null, { status: 204 });
  }

  // Legacy report-uri shape: { "csp-report": {...} }
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "csp-report" in payload &&
    typeof (payload as Record<string, unknown>)["csp-report"] === "object"
  ) {
    const r = (payload as Record<string, unknown>)["csp-report"] as CspReportBody;
    reportToSentry(r);
    return new NextResponse(null, { status: 204 });
  }

  // Modern report-to shape: array of { type, body }
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (
        entry &&
        typeof entry === "object" &&
        "body" in entry &&
        typeof (entry as Record<string, unknown>).body === "object"
      ) {
        reportToSentry((entry as Record<string, unknown>).body as CspReportBody);
      }
    }
    return new NextResponse(null, { status: 204 });
  }

  // Unknown shape — accept silently; CSP reports aren't worth error-logging.
  return new NextResponse(null, { status: 204 });
}
