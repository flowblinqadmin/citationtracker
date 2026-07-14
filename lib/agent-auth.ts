// Bearer-token auth for the agent one-shot surface.
//
// The agent one-shot endpoint (POST /api/agent/one-shot-citation) is called by
// a SINGLE trusted upstream: the agent-storefront x402 gateway. It authenticates
// with a static shared secret, AGENT_SERVICE_TOKEN, distinct from CRON_SECRET
// (that one is shared with geo for cron/worker traffic — the agent surface must
// not widen its blast radius).
//
// Contract:
//   - No / malformed Bearer, or token mismatch  → 401 (bad auth)
//   - AGENT_SERVICE_TOKEN env unset/too-short   → 503 (service misconfigured)
// Distinguishing 503 from 401 lets the storefront tell "I sent the wrong token"
// from "the citation service isn't provisioned yet".
//
// Comparison is constant-time (crypto.timingSafeEqual) to avoid leaking the
// token length/prefix via response timing. Length is compared first — length is
// not secret, and timingSafeEqual throws on unequal-length buffers.

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";

// A short token would be brute-forceable; require a real secret. 32 chars is the
// output of `openssl rand -hex 16` (mirrors CRON_SECRET's floor).
const MIN_LEN = 32;

function isValidSecret(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.trim().length >= MIN_LEN;
}

/** Extract the Bearer token from an Authorization header, or "" if absent. */
function bearerToken(req: NextRequest | Request): string {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * True when AGENT_SERVICE_TOKEN is set to a real secret (≥ MIN_LEN). The core
 * agent surface is "provisioned" only then; an unset secret means the service
 * itself isn't stood up, which the route reports as 503 (distinct from a 401 bad
 * token) so the storefront can tell the two apart. Exposed for the dual-auth
 * route: the 503 must win before any billed-mode JWT attempt.
 */
export function agentServiceProvisioned(): boolean {
  return isValidSecret(process.env.AGENT_SERVICE_TOKEN);
}

/**
 * True when the caller's Bearer token constant-time-matches AGENT_SERVICE_TOKEN.
 * False when the secret is unset/too-short (callers needing the misconfig-vs-bad-
 * auth distinction use assertAgentAuth instead).
 */
export function agentBearerValid(req: NextRequest | Request): boolean {
  const secret = process.env.AGENT_SERVICE_TOKEN;
  if (!isValidSecret(secret)) return false;

  const supplied = bearerToken(req);
  const expected = secret.trim();
  // Length compare first: unequal length is a definite mismatch, and
  // timingSafeEqual requires equal-length buffers. Length is not secret.
  if (supplied.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

/**
 * Returns null when the caller is authorized; otherwise the NextResponse the
 * route should immediately return:
 *   - 503 when AGENT_SERVICE_TOKEN is unset/too-short (service not provisioned)
 *   - 401 on any missing/mismatched token
 *
 *   const denied = assertAgentAuth(req);
 *   if (denied) return denied;
 */
export function assertAgentAuth(req: NextRequest | Request): NextResponse | null {
  const secret = process.env.AGENT_SERVICE_TOKEN;
  if (!isValidSecret(secret)) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }
  if (!agentBearerValid(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
