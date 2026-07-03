/**
 * ES-090 HP-206 — legacy `generateExchangeCode` regression guard.
 *
 * ChangedSpec §b.12 introduces DB-backed createExchangeCode/redeemExchangeCode
 * as ADDITIVE APIs — the legacy stateless-JWT `generateExchangeCode` stays
 * untouched in ES-090 scope. This guard ensures:
 *
 *   1. The function still exists and is callable.
 *   2. It returns a `string` (JWT), NOT the `{ code, expiresAt }` object shape
 *      the new API uses. A regression that silently renames / reshapes the
 *      legacy return would silently break 4 call sites.
 *   3. The JWT's `exp - iat` is 60 seconds (±5s tolerance) — the legacy TTL
 *      contract. A regression that bumps this breaks the 60s-window
 *      assumption in verify/consent/otp-verify.
 *   4. The 4 existing legacy call sites still import cleanly (spec §b.12
 *      preamble enumerates them).
 */
import { describe, it, expect } from "vitest";
import { SignJWT, jwtVerify } from "jose";

const LEGACY_CALL_SITES = [
  "@/app/api/sites/[id]/verify/route",
  "@/app/api/sites/[id]/consent/route",
  "@/app/api/auth/otp/verify/route",
  "@/app/api/pipeline/stage/route",
] as const;

describe("ES-090 HP-206 — legacy generateExchangeCode regression guard", () => {
  it("generateExchangeCode is still a function (not renamed / not removed)", async () => {
    const mod = await import("@/lib/services/exchange-code");
    expect(typeof (mod as unknown as { generateExchangeCode?: unknown }).generateExchangeCode)
      .toBe("function");
  });

  it("generateExchangeCode returns a string (JWT), not the new { code, expiresAt } shape", async () => {
    process.env.API_JWT_SECRET = "test-secret-do-not-use-in-prod-32b!!";
    const { generateExchangeCode } = await import("@/lib/services/exchange-code");
    const out = await (generateExchangeCode as unknown as (p: Record<string, unknown>) => Promise<unknown>)({
      accessToken: "at",
      refreshToken: "rt",
      redirect: "/sites/x",
      siteToken: "st",
      siteId: "x",
    });
    expect(typeof out, "legacy return shape must remain a string JWT").toBe("string");
    // Defensive: ensure it's NOT the new-API object shape.
    expect(out, "legacy return must NOT be reshaped to { code, expiresAt }")
      .not.toHaveProperty("code");
    expect(out, "legacy return must NOT be reshaped to { code, expiresAt }")
      .not.toHaveProperty("expiresAt");
  });

  it("generateExchangeCode JWT has exp - iat === 60s (±5s tolerance)", async () => {
    process.env.API_JWT_SECRET = "test-secret-do-not-use-in-prod-32b!!";
    const { generateExchangeCode } = await import("@/lib/services/exchange-code?hp206-ttl");
    const jwt = await (generateExchangeCode as unknown as (p: Record<string, unknown>) => Promise<string>)({
      accessToken: "at",
      refreshToken: "rt",
      redirect: "/sites/x",
      siteToken: "st",
      siteId: "x",
    });
    const secret = new TextEncoder().encode(process.env.API_JWT_SECRET);
    const { payload } = await jwtVerify(jwt, secret);
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    const ttl = (payload.exp as number) - (payload.iat as number);
    // Legacy contract: 60s window per TS-090 §4 / §b.12 preamble.
    expect(ttl, `legacy JWT TTL expected 60s (±5), got ${ttl}`).toBeGreaterThanOrEqual(55);
    expect(ttl, `legacy JWT TTL expected 60s (±5), got ${ttl}`).toBeLessThanOrEqual(65);
    // Silence the unused-import TS warning for SignJWT on some toolchains.
    void SignJWT;
  });

  it("all 4 legacy call sites still import cleanly (no build break from exchange-code edits)", async () => {
    for (const path of LEGACY_CALL_SITES) {
      // We don't execute the handler — just verify the module resolves.
      // Any TS/runtime import-time error will throw here and RED the test.
      await expect(import(path)).resolves.toBeDefined();
    }
  });
});
