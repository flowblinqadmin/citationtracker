/**
 * Unit tests for lib/api-auth.ts — JWT sign/verify + scope enforcement
 *
 * ES-019 Unit Test Plan (U-1 through U-8)
 *
 * signApiToken:
 *   U-1  Valid payload → returns string JWT
 *
 * verifyApiToken:
 *   U-2  Valid token → returns payload with correct sub/team_id/scopes
 *   U-3  Expired token → throws (JWTExpired or similar)
 *   U-4  Tampered signature → throws (JWSInvalid or similar)
 *   U-5  Token signed with wrong secret → throws
 *
 * requireScope:
 *   U-6  Scopes contains required → does not throw
 *   U-7  Scopes missing required → throws with 403 marker
 *
 * Module load guard:
 *   U-8  Missing API_JWT_SECRET env → throws at dynamic import
 *
 * NOTE: These tests use the REAL jose library (not mocked) to verify actual
 * JWT sign/verify behaviour. jose must be installed: npm install jose
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { SignJWT } from "jose";

// ─── Set env before module loads ─────────────────────────────────────────────
// vi.hoisted runs before module resolution — ensures API_JWT_SECRET is set
// when lib/api-auth.ts is first imported.
vi.hoisted(() => {
  process.env.API_JWT_SECRET = "deadbeef".repeat(8); // 64 hex chars = 32 bytes
});

// ─── Imports (after env is guaranteed set) ────────────────────────────────────
import {
  signApiToken,
  verifyApiToken,
  requireScope,
  type ApiTokenPayload,
} from "@/lib/api-auth";

// ─── Test constants ───────────────────────────────────────────────────────────

const TEST_SECRET = "deadbeef".repeat(8);

const SAMPLE_PAYLOAD: Omit<ApiTokenPayload, "iat" | "exp"> = {
  sub: "client-abc-123",
  team_id: "team-xyz-456",
  scopes: ["audit:read", "audit:write"],
};

// ─── signApiToken ─────────────────────────────────────────────────────────────

describe("signApiToken", () => {
  it("U-1: valid payload → returns string JWT with 3-part structure", async () => {
    const token = await signApiToken(SAMPLE_PAYLOAD);

    expect(typeof token).toBe("string");
    // JWT: header.payload.signature
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    // Each part is base64url-encoded (non-empty)
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
    expect(parts[2].length).toBeGreaterThan(0);
  });
});

// ─── verifyApiToken ───────────────────────────────────────────────────────────

describe("verifyApiToken", () => {
  let validToken: string;

  beforeAll(async () => {
    validToken = await signApiToken(SAMPLE_PAYLOAD);
  });

  it("U-2: valid token → returns payload with correct sub/team_id/scopes/iat/exp", async () => {
    const payload = await verifyApiToken(validToken);

    expect(payload.sub).toBe(SAMPLE_PAYLOAD.sub);
    expect(payload.team_id).toBe(SAMPLE_PAYLOAD.team_id);
    expect(payload.scopes).toEqual(SAMPLE_PAYLOAD.scopes);
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp).toBeGreaterThan(payload.iat);
    // exp should be approximately now + 3600s
    const approxExp = Math.floor(Date.now() / 1000) + 3600;
    expect(payload.exp).toBeGreaterThan(approxExp - 10);
    expect(payload.exp).toBeLessThanOrEqual(approxExp + 10);
  });

  it("U-3: expired token → throws (JWTExpired or similar)", async () => {
    const secret = new TextEncoder().encode(TEST_SECRET);
    const expiredToken = await new SignJWT({
      sub: "client-abc-123",
      team_id: "team-xyz-456",
      scopes: ["audit:read"],
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(secret);

    await expect(verifyApiToken(expiredToken)).rejects.toThrow();
  });

  it("U-4: tampered signature → throws (JWSInvalid or similar)", async () => {
    const parts = validToken.split(".");
    // Corrupt the signature by flipping the first character
    const firstChar = parts[2][0];
    const flippedChar = firstChar === "A" ? "B" : "A";
    parts[2] = flippedChar + parts[2].slice(1);
    const tamperedToken = parts.join(".");

    await expect(verifyApiToken(tamperedToken)).rejects.toThrow();
  });

  it("U-5: token signed with a different secret → throws", async () => {
    const wrongSecret = new TextEncoder().encode("wrongkey".repeat(8));
    const wrongToken = await new SignJWT({
      sub: "client-abc-123",
      team_id: "team-xyz-456",
      scopes: ["audit:read"],
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(wrongSecret);

    await expect(verifyApiToken(wrongToken)).rejects.toThrow();
  });
});

// ─── requireScope ─────────────────────────────────────────────────────────────

describe("requireScope", () => {
  it("U-6: scopes contains required scope → does not throw", () => {
    expect(() =>
      requireScope(["audit:read", "audit:write", "account:read"], "audit:write")
    ).not.toThrow();
  });

  it("U-6b: scopes contains required scope (first element) → does not throw", () => {
    expect(() => requireScope(["audit:read"], "audit:read")).not.toThrow();
  });

  it("U-7: scopes missing required scope → throws with 403 indication", () => {
    // Must throw
    expect(() => requireScope(["audit:read"], "audit:write")).toThrow();

    // Error should indicate forbidden / 403
    try {
      requireScope(["audit:read"], "audit:write");
    } catch (e: unknown) {
      const err = e as { message?: string; status?: number; statusCode?: number };
      const isForbidden =
        err.status === 403 ||
        err.statusCode === 403 ||
        (typeof err.message === "string" &&
          /403|forbidden|scope|insufficient/i.test(err.message));
      expect(isForbidden).toBe(true);
    }
  });

  it("U-7b: empty scopes array → throws for any required scope", () => {
    expect(() => requireScope([], "audit:read")).toThrow();
  });
});

// ─── Module load guard ────────────────────────────────────────────────────────

describe("Module load guard", () => {
  it("U-8: missing API_JWT_SECRET → throws at dynamic import", async () => {
    const saved = process.env.API_JWT_SECRET;
    delete process.env.API_JWT_SECRET;
    vi.resetModules();

    try {
      await expect(import("@/lib/api-auth")).rejects.toThrow();
    } finally {
      // Restore for any subsequent imports
      process.env.API_JWT_SECRET = saved;
      vi.resetModules();
    }
  });
});
