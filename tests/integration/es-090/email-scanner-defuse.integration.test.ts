/**
 * ES-090 IT10b — email-scanner defuse (ChangedSpec per HP-202).
 *
 * Simulates a Gmail/Outlook scanner hitting /auth/exchange?code=<code> without
 * a matching Supabase session or active OTP. Per HP-202 defuse chain:
 *   1. Scanner GET wins atomic UPDATE → redeemedAt set.
 *   2. Proof-of-email fails → CAS revert → redeemedAt back to null.
 *   3. Real user subsequent GET (with matching session) → succeeds.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeDb } from "./_setup";

beforeAll(() => { if (!process.env.NEXT_PUBLIC_APP_URL) process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; });
afterAll(async () => { await closeDb(); });

describe("ES-090 IT10b — Scanner consume does not invalidate the code", () => {
  it("scanner click → proof-mismatch CAS revert → real user can still redeem", async () => {
    const { createExchangeCode } = await import("@/lib/services/exchange-code");
    const TARGET_EMAIL = "user-defuse@example.test";
    const issued = await createExchangeCode({
      email: TARGET_EMAIL,
      payload: { accessToken: "site-tok-it10b" },
      ttlSeconds: 7 * 86_400,
    });

    // Step 1: scanner request — no cookies, no OTP session.
    const scannerRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/auth/exchange?code=${issued.code}`, {
      redirect: "manual",
      headers: { "user-agent": "GoogleImageProxy (gmail scanner)" },
    });
    // Scanner must NOT receive a Set-Cookie (no auth session created).
    const scannerSetCookie = scannerRes.headers.get("set-cookie") ?? "";
    expect(scannerSetCookie, "scanner must not receive auth cookie").not.toMatch(/flowblinq_site_token=/);
    expect(scannerSetCookie, "scanner must not receive Supabase session cookie").not.toMatch(/sb-[^=]+auth-token/);
    // Scanner response: 401 (non-enumerable reason per spec b.12).
    expect(scannerRes.status).toBe(401);

    // Step 2: real user click — with active-OTP session for TARGET_EMAIL.
    // Test hook must exist on the handler to inject a proof-of-email source.
    const userRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/auth/exchange?code=${issued.code}`, {
      redirect: "manual",
      headers: { "x-test-proof-email": TARGET_EMAIL },
    });
    expect([302, 303, 307, 308]).toContain(userRes.status);
    const userSetCookie = userRes.headers.get("set-cookie") ?? "";
    expect(userSetCookie).toMatch(/flowblinq_site_token=/);
  }, 30_000);
});
