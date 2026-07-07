// Cron / internal-webhook secret authentication.
//
// C3 audit fix (2026-05-27): fail-closed on unset / empty / too-short
// CRON_SECRET both at module load AND on every request.
//
// Why both layers:
//   - Module load (boot guard): if the deployed instance is misconfigured,
//     the process refuses to start. Catches the misconfig in the deploy
//     cycle, not silently at runtime.
//   - Per-request (runtime guard): defends against any future code path
//     that mutates process.env.CRON_SECRET after boot, and lets the test
//     suite drive misconfig scenarios. Without per-request re-validation,
//     an empty string set after boot would silently match an attacker's
//     empty Bearer token.
//
// 32 chars is the conventional output of `openssl rand -hex 16`. The
// existing API_JWT_SECRET uses 64 chars (hex 32); we accept anything ≥32.

import { NextResponse, type NextRequest } from "next/server";

const MIN_LEN = 32;

function isValid(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_LEN;
}

// No module-load assertion here: Next evaluates route modules during build,
// where env vars are absent. assertCronAuth/getCronSecret fail closed at
// request time instead (503 on misconfig).

/**
 * Returns the current CRON_SECRET. Re-reads process.env on each call so
 * test suites can mutate the env between requests; production callers see
 * the boot-time value unless it has been deliberately changed.
 *
 * Throws if the env was unset, emptied, or shortened post-boot — preserving
 * the fail-closed posture.
 */
export function getCronSecret(): string {
  const v = process.env.CRON_SECRET;
  if (!isValid(v)) {
    throw new Error(
      `CRON_SECRET env var must be at least ${MIN_LEN} characters`,
    );
  }
  return v;
}

/**
 * True when the caller's Bearer token matches CRON_SECRET. Constant-time-ish
 * compare (short-circuit on length mismatch is safe — length is not secret).
 * False when the secret is unset/invalid — callers that need to distinguish
 * misconfig (503) from bad auth (401) use assertCronAuth instead.
 */
export function cronBearerValid(req: NextRequest | Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!isValid(secret)) return false;

  const header = req.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (supplied.length !== secret.length) return false;

  let diff = 0;
  for (let i = 0; i < supplied.length; i++) {
    diff |= supplied.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Returns null when the caller's Bearer token matches CRON_SECRET; otherwise
 * a 401/503 NextResponse the route should immediately return.
 *
 *   const denied = assertCronAuth(req);
 *   if (denied) return denied;
 */
export function assertCronAuth(
  req: NextRequest | Request,
): NextResponse | null {
  // Runtime re-validation: empty/missing env at request time = 503
  // (service misconfigured). Distinguishing from 401 helps ops triage.
  const secret = process.env.CRON_SECRET;
  if (!isValid(secret)) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  if (!cronBearerValid(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
