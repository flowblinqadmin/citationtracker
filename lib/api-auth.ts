import { SignJWT, jwtVerify } from "jose";

// ── API JWT Secret ────────────────────────────────────────────────────────────
// Generate with: openssl rand -hex 32
// Set API_JWT_SECRET in .env.local and Vercel project settings.
if (!process.env.API_JWT_SECRET) {
  throw new Error("API_JWT_SECRET env var is required");
}

const API_JWT_SECRET = new TextEncoder().encode(process.env.API_JWT_SECRET);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ApiTokenPayload {
  sub: string;       // clientId (nanoid(24))
  team_id: string;
  scopes: string[];
  iat: number;
  exp: number;
}

// ── signApiToken ──────────────────────────────────────────────────────────────

export async function signApiToken(payload: Omit<ApiTokenPayload, "iat" | "exp">): Promise<string> {
  return new SignJWT({ team_id: payload.team_id, scopes: payload.scopes })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(API_JWT_SECRET);
}

// ── verifyApiToken ────────────────────────────────────────────────────────────
// Edge-safe (jose only). Does NOT check revokedAt — callers must do that themselves
// if synchronous revocation is needed. Stateless JWT: revoked tokens remain valid
// up to 1hr after revocation (acceptable given TTL).

export async function verifyApiToken(token: string): Promise<ApiTokenPayload> {
  const { payload } = await jwtVerify(token, API_JWT_SECRET, { algorithms: ["HS256"] });
  return {
    sub: payload.sub as string,
    team_id: payload.team_id as string,
    scopes: payload.scopes as string[],
    iat: payload.iat as number,
    exp: payload.exp as number,
  };
}

// ── requireScope ─────────────────────────────────────────────────────────────

export function requireScope(scopes: string[], required: string): void {
  if (!scopes.includes(required)) {
    throw Object.assign(new Error("Insufficient scope"), { status: 403 });
  }
}
