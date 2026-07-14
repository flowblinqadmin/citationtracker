// Unit tests for the billed-mode JWT auth (lib/agent-billing-auth.ts).
//
// These mint tokens with jose exactly as geo's lib/api-auth.ts signApiToken does
// (HS256, sub/team_id/scopes claims, exp) so a token geo would issue verifies
// here. Pure crypto — no DB, no network.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SignJWT } from "jose";
import { verifyBilledAuth, hasBearer, REQUIRED_SCOPE } from "@/lib/agent-billing-auth";

const SECRET = "s".repeat(64); // ≥ 32; mirrors openssl rand -hex 32 (64 hex chars)
const WRONG_SECRET = "w".repeat(64);

let savedSecret: string | undefined;
beforeEach(() => {
  savedSecret = process.env.API_JWT_SECRET;
  process.env.API_JWT_SECRET = SECRET;
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.API_JWT_SECRET;
  else process.env.API_JWT_SECRET = savedSecret;
});

/** Mint a token the way geo's signApiToken does, with overridable claims/exp. */
async function mint(opts: {
  secret?: string;
  teamId?: string;
  scopes?: string[];
  sub?: string;
  expiresIn?: string;
  omitTeam?: boolean;
} = {}): Promise<string> {
  const key = new TextEncoder().encode(opts.secret ?? SECRET);
  const claims: Record<string, unknown> = { scopes: opts.scopes ?? [REQUIRED_SCOPE] };
  if (!opts.omitTeam) claims.team_id = opts.teamId ?? "team_abc";
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(opts.sub ?? "client_123")
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "1h")
    .sign(key);
}

function reqWith(token: string | null): Request {
  return new Request("http://x/api/agent/one-shot-citation", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("verifyBilledAuth", () => {
  it("accepts a valid token with audit:write and returns team_id", async () => {
    const r = await verifyBilledAuth(reqWith(await mint({ teamId: "team_xyz" })));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.team_id).toBe("team_xyz");
      expect(r.payload.scopes).toContain(REQUIRED_SCOPE);
      expect(r.payload.sub).toBe("client_123");
    }
  });

  it("rejects an expired token as invalid (401)", async () => {
    // Negative expiry → already expired at verify time.
    const token = await mint({ expiresIn: "-1h" });
    const r = await verifyBilledAuth(reqWith(token));
    expect(r).toEqual({ ok: false, kind: "invalid" });
  });

  it("rejects a bad signature (wrong secret) as invalid (401)", async () => {
    const token = await mint({ secret: WRONG_SECRET });
    const r = await verifyBilledAuth(reqWith(token));
    expect(r).toEqual({ ok: false, kind: "invalid" });
  });

  it("rejects a token missing the audit:write scope as forbidden (403)", async () => {
    const token = await mint({ scopes: ["audit:read"] });
    const r = await verifyBilledAuth(reqWith(token));
    expect(r).toEqual({ ok: false, kind: "forbidden" });
  });

  it("rejects a token with no team_id claim as invalid (won't bill an undefined team)", async () => {
    const token = await mint({ omitTeam: true });
    const r = await verifyBilledAuth(reqWith(token));
    expect(r).toEqual({ ok: false, kind: "invalid" });
  });

  it("rejects a missing Bearer as invalid", async () => {
    const r = await verifyBilledAuth(reqWith(null));
    expect(r).toEqual({ ok: false, kind: "invalid" });
  });

  it("reports unprovisioned when API_JWT_SECRET is unset", async () => {
    delete process.env.API_JWT_SECRET;
    const r = await verifyBilledAuth(reqWith("any.token.here"));
    expect(r).toEqual({ ok: false, kind: "unprovisioned" });
  });

  it("reports unprovisioned when API_JWT_SECRET is too short", async () => {
    process.env.API_JWT_SECRET = "short";
    const r = await verifyBilledAuth(reqWith("any.token.here"));
    expect(r).toEqual({ ok: false, kind: "unprovisioned" });
  });
});

describe("hasBearer", () => {
  it("true when a Bearer header is present", () => {
    expect(hasBearer(reqWith("x"))).toBe(true);
  });
  it("false when absent", () => {
    expect(hasBearer(reqWith(null))).toBe(false);
  });
});
