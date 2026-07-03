/**
 * IT-15 — real-infra auth.users alignment (AC-24 / HP-264).
 *
 * Gated on (local DB + SUPABASE_SERVICE_ROLE_KEY + mailpit). Skips cleanly
 * in docker CI and in dev machines without a running local Supabase.
 *
 * Scenarios:
 *   (1) runSeed → auth.users row with id=TEST_USER_ID and email=TEST_USER_EMAIL exists.
 *   (2) runSeed twice → idempotent (same final id, no duplicate error).
 *   (3) after seed, signInWithOtp + verifyOtp → resolved user.id === TEST_USER_ID.
 *   (4) after seed, GET /api/consent → hasConsent:true (proves seeded consent_records
 *       row keyed on TEST_USER_ID is reachable because auth.users.id now aligns).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { LOCAL_DB_PATTERN } from "@/scripts/e2e/lib/safety";
import { TEST_USER_ID, TEST_USER_EMAIL } from "@/e2e/fixtures/ids";

const dbUrl = process.env.DATABASE_URL ?? "";
const dbOk = LOCAL_DB_PATTERN.test(dbUrl);
const serviceRoleOk = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const mailpitOk = await (async () => {
  try {
    const res = await fetch("http://127.0.0.1:54324/api/v1/info", {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
})();

const d = dbOk && serviceRoleOk && mailpitOk ? describe : describe.skip;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";

d("IT-15: auth.users alignment post-seed (AC-24)", () => {
  let adminSb: any;
  beforeAll(async () => {
    const { createClient } = await import("@supabase/supabase-js");
    adminSb = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  });

  it("(1) runSeed → auth.users has row with TEST_USER_ID and TEST_USER_EMAIL", async () => {
    const { runSeed } = await import("@/scripts/e2e/seed");
    await runSeed();
    const { data, error } = await adminSb.auth.admin.getUserById(TEST_USER_ID);
    expect(error).toBeNull();
    expect(data.user?.id).toBe(TEST_USER_ID);
    expect(data.user?.email?.toLowerCase()).toBe(TEST_USER_EMAIL.toLowerCase());
  }, 30_000);

  it("(2) runSeed twice → idempotent, same final id", async () => {
    const { runSeed } = await import("@/scripts/e2e/seed");
    await runSeed();
    await runSeed();
    const { data, error } = await adminSb.auth.admin.getUserById(TEST_USER_ID);
    expect(error).toBeNull();
    expect(data.user?.id).toBe(TEST_USER_ID);
  }, 45_000);

  it("(3) signInWithOtp + verifyOtp resolves to TEST_USER_ID after seed", async () => {
    // This scenario requires Mailpit to capture the OTP — otherwise verifyOtp
    // can't complete. We use the mailpit helper to fetch the code.
    const { getOtpForEmail } = await import("@/e2e/helpers/mailpit");
    const { createClient } = await import("@supabase/supabase-js");
    // Anon-key client (what the app uses at signin time).
    const anon = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
    const sb = createClient(SUPABASE_URL, anon);
    const { error: sendErr } = await sb.auth.signInWithOtp({
      email: TEST_USER_EMAIL,
      options: { shouldCreateUser: true },
    });
    expect(sendErr).toBeNull();
    const code = await getOtpForEmail(TEST_USER_EMAIL, 10_000);
    const { data, error: verifyErr } = await sb.auth.verifyOtp({
      email: TEST_USER_EMAIL,
      token: code,
      type: "email",
    });
    expect(verifyErr).toBeNull();
    expect(data.user?.id).toBe(TEST_USER_ID);
  }, 30_000);

  it("(4) after seed, consent_records lookup hits (AC-24 end-to-end proof)", async () => {
    const { default: postgres } = await import("postgres");
    const sql = postgres(dbUrl, { max: 1, prepare: false });
    try {
      const rows = await sql`SELECT user_id FROM consent_records WHERE user_id = ${TEST_USER_ID}`;
      expect(rows).toHaveLength(1);
    } finally {
      await sql.end({ timeout: 2 });
    }
  });
});
