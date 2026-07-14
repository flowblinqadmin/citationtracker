// Billed-mode auth for the agent one-shot surface.
//
// The one-shot endpoint (POST /api/agent/one-shot-citation) has TWO callers:
//   1. The agent-storefront x402 gateway — Bearer AGENT_SERVICE_TOKEN, UNBILLED
//      (x402 collects the spend upstream). Handled by lib/agent-auth.ts.
//   2. A geo v1 customer with an API JWT — BILLED here against their geo team's
//      credit balance. Handled by this module.
//
// The JWT is the SAME token geo mints in lib/api-auth.ts (verified there for
// geo's own /api/v1/* routes). We mirror geo's verification byte-for-byte so a
// token that geo accepts, this service accepts:
//   - alg HS256, shared secret API_JWT_SECRET (openssl rand -hex 32)
//   - claims: sub (clientId), team_id, scopes[], iat, exp
// Cross-project shared secrets are established practice in this repo (CRON_SECRET
// is shared with geo); API_JWT_SECRET must EQUAL geo's for this to verify.
//
// Fail-closed: an unset/too-short secret does NOT throw at import (that would
// take down the unbilled service-token path too). It resolves to a 503 at
// request time, distinguishing "service not provisioned for billing" from
// "caller sent a bad token" (401) and "caller lacks the scope" (403).

import { jwtVerify } from "jose";

/** Scope a billed one-shot caller must hold. Same scope geo's /api/v1/audit uses. */
export const REQUIRED_SCOPE = "audit:write";

// Mirror of geo's API_JWT_SECRET floor. openssl rand -hex 32 → 64 hex chars.
const MIN_SECRET_LEN = 32;

export interface BilledTokenPayload {
  /** clientId (geo nanoid(24)). */
  sub: string;
  /** geo team the credits are debited against. */
  team_id: string;
  scopes: string[];
  iat: number;
  exp: number;
}

/**
 * Discriminated auth outcome. The route maps each failure to an HTTP status:
 *   unprovisioned → 503, invalid → 401, forbidden → 403.
 * `ok` carries the verified team_id + scopes for billing.
 */
export type BilledAuthResult =
  | { ok: true; payload: BilledTokenPayload }
  | { ok: false; kind: "unprovisioned" }
  | { ok: false; kind: "invalid" }
  | { ok: false; kind: "forbidden" };

/** Extract the Bearer token from an Authorization header, or "" if absent. */
function bearerToken(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Verify a geo v1 customer API JWT and require the audit:write scope.
 *
 * Returns a discriminated result rather than throwing so the route can map
 * kinds → statuses without a try/catch ladder. A malformed/expired/bad-signature
 * token is `invalid` (401); a valid token missing the scope is `forbidden` (403);
 * an unset secret is `unprovisioned` (503).
 */
export async function verifyBilledAuth(req: Request): Promise<BilledAuthResult> {
  const secret = process.env.API_JWT_SECRET;
  if (typeof secret !== "string" || secret.trim().length < MIN_SECRET_LEN) {
    return { ok: false, kind: "unprovisioned" };
  }

  const token = bearerToken(req);
  if (!token) return { ok: false, kind: "invalid" };

  let payload: BilledTokenPayload;
  try {
    const key = new TextEncoder().encode(secret);
    const { payload: raw } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    // Shape guard: geo always mints these; a token missing them is not one of
    // ours and must not bill an undefined team.
    if (
      typeof raw.sub !== "string" ||
      typeof raw.team_id !== "string" ||
      !Array.isArray(raw.scopes)
    ) {
      return { ok: false, kind: "invalid" };
    }
    payload = {
      sub: raw.sub,
      team_id: raw.team_id as string,
      scopes: raw.scopes as string[],
      iat: raw.iat as number,
      exp: raw.exp as number,
    };
  } catch {
    // Bad signature, expired (exp), malformed — all indistinguishable-by-design 401s.
    return { ok: false, kind: "invalid" };
  }

  if (!payload.scopes.includes(REQUIRED_SCOPE)) {
    return { ok: false, kind: "forbidden" };
  }

  return { ok: true, payload };
}

/** True when the request carries a Bearer token at all (either auth mode). */
export function hasBearer(req: Request): boolean {
  return (req.headers.get("authorization") ?? "").startsWith("Bearer ");
}
