// Trusted client IP resolution.
//
// Security: on Vercel, req.ip is set by the edge runtime from the
// connection-level peer address and CANNOT be spoofed by the client.
// `x-vercel-forwarded-for` is also set by Vercel infra (single hop, trusted).
// Plain `x-forwarded-for` is attacker-controlled — the client can send any
// value, defeating per-IP rate limits. Always prefer trusted sources.
//
// Audit ref: C4 — XFF spoof regression of c4f63eb (2026-05-27).

import type { NextRequest } from "next/server";

// Per-process random suffix used as the "unknown IP" fallback in local
// dev, so concurrent developers / requests don't all collide on a single
// `audit-ip:unknown` bucket and lock each other out. In production (Vercel)
// req.ip is always set, so this fallback never fires.
//
// Uses the Web Crypto global (crypto.getRandomValues) rather than Node's
// `crypto` module: client-ip.ts is imported by Edge-runtime routes
// (/api/t/[slug], /api/t/collect), where Node builtins are unavailable.
function devRandomSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const DEV_UNKNOWN_IP =
  process.env.NODE_ENV === "development"
    ? `local-${devRandomSuffix()}`
    : "unknown";

const UNKNOWN_IP = DEV_UNKNOWN_IP;

function firstHop(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.split(",")[0]?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Returns a best-effort client IP suitable for keying rate limits, audit
 * logs, and abuse signals. Never returns a value derived from raw
 * `x-forwarded-for` — that header is attacker-controlled.
 *
 * Order of trust:
 *   1. req.ip            — Vercel edge runtime, set from socket peer.
 *   2. x-vercel-forwarded-for — Vercel infra, single hop.
 *   3. x-real-ip         — common reverse-proxy header (nginx etc.).
 *   4. "unknown"         — fallback, all callers share one bucket. The
 *                          security guidance accepts this as the cost of
 *                          refusing to trust spoofable headers.
 */
export function getClientIp(req: NextRequest | Request): string {
  // Next 15 NextRequest exposes .ip directly on Vercel Edge / Node runtimes.
  const fromRuntime = (req as { ip?: string | null }).ip;
  if (fromRuntime && fromRuntime.length > 0) return fromRuntime;

  const headers = req.headers;
  const vercel = firstHop(headers.get("x-vercel-forwarded-for"));
  if (vercel) return vercel;

  const realIp = firstHop(headers.get("x-real-ip"));
  if (realIp) return realIp;

  return UNKNOWN_IP;
}

/**
 * Legacy callers used `x-forwarded-for` directly. This helper exists so we
 * have one place to verify the migration is complete — keep the export but
 * route it through getClientIp() so future audits cannot regress to XFF.
 */
export const getRequestIp = getClientIp;
