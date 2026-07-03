/**
 * Auth integration tests — A-1 through A-8
 *
 * Tests the OAuth token endpoint and JWT validation on v1 routes.
 * Uses globalThis.__API_CLIENT_QA__ from setup.ts (provisioned fresh credential).
 *
 * A-4 (revoked client) and A-8 (rate limit) each use a SEPARATE isolated
 * credential provisioned in beforeAll to avoid interfering with the shared QA
 * credential used concurrently by other test files (e.g. audit-flow.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { FlowblinqClient, FlowblinqApiError } from "@/lib/flowblinq-client";

// ─── Shared client (from setup.ts) ───────────────────────────────────────────

let client: FlowblinqClient;
let baseUrl: string;
let teamId: string;

beforeAll(() => {
  const qa = globalThis.__API_CLIENT_QA__;
  if (!qa) throw new Error("API_CLIENT_QA not initialised — check setup.ts");

  baseUrl = qa.baseUrl;
  teamId = qa.teamId;
  client = new FlowblinqClient({
    clientId: qa.clientId,
    clientSecret: qa.clientSecret,
    baseUrl: qa.baseUrl,
  });
});

// ─── A-1 through A-7 ─────────────────────────────────────────────────────────

describe("Auth: valid credentials", () => {
  it("A-1: valid credentials → getAccount() succeeds with correct shape", async () => {
    const account = await client.getAccount();

    expect(typeof account.teamId).toBe("string");
    expect(account.teamId).toBe(teamId);
    expect(typeof account.creditBalance).toBe("number");
    expect(account.creditBalance).toBeGreaterThanOrEqual(0);
    expect(typeof account.creditsPurchaseUrl).toBe("string");
    expect(account.creditsPurchaseUrl).toContain("flowblinq.com");
  });
});

// ─── A-4: Revoked client — isolated credential ───────────────────────────────
// Uses a SEPARATE credential so revoking it never interferes with the shared
// QA credential used by concurrent test files (e.g. audit-flow.test.ts F-2).

let a4ClientId: string;
let a4Secret: string;
let a4RowId: string;

beforeAll(async () => {
  const supabase = createClient(
    process.env.TEST_SUPABASE_URL!,
    process.env.TEST_SUPABASE_SERVICE_KEY!
  );
  a4RowId = nanoid();
  a4ClientId = "test_rev_" + nanoid(12);
  a4Secret = nanoid(32);
  const hash = await bcrypt.hash(a4Secret, 12);
  const { error } = await supabase.from("api_clients").insert({
    id: a4RowId,
    team_id: globalThis.__API_CLIENT_QA__.teamId,
    client_id: a4ClientId,
    client_secret_hash: hash,
    name: `revocation-test-${Date.now()}`,
    scopes: ["account:read"],
    created_at: new Date().toISOString(),
  });
  if (error) throw new Error(`A-4 setup failed: ${error.message}`);
});

afterAll(async () => {
  const supabase = createClient(
    process.env.TEST_SUPABASE_URL!,
    process.env.TEST_SUPABASE_SERVICE_KEY!
  );
  await supabase.from("api_clients").delete().eq("id", a4RowId);
});

describe("Auth: invalid credentials", () => {
  it("A-2: wrong client_secret → FlowblinqApiError status=401", async () => {
    const badClient = new FlowblinqClient({
      clientId: globalThis.__API_CLIENT_QA__.clientId,
      clientSecret: "definitely-wrong-secret-here",
      baseUrl,
    });

    await expect(badClient.getAccount()).rejects.toMatchObject({
      name: "FlowblinqApiError",
      status: 401,
    });
  });

  it("A-3: unknown client_id → FlowblinqApiError status=401", async () => {
    const unknownClient = new FlowblinqClient({
      clientId: "nonexistent-client-id-xyz",
      clientSecret: "any-secret",
      baseUrl,
    });

    await expect(unknownClient.getAccount()).rejects.toMatchObject({
      name: "FlowblinqApiError",
      status: 401,
    });
  });

  it("A-4: revoked client → FlowblinqApiError status=401", async () => {
    // Uses an isolated credential (a4ClientId) — never touches the shared QA credential.
    const supabase = createClient(
      process.env.TEST_SUPABASE_URL!,
      process.env.TEST_SUPABASE_SERVICE_KEY!
    );

    // Revoke the isolated credential
    await supabase
      .from("api_clients")
      .update({ revoked_at: new Date().toISOString() })
      .eq("client_id", a4ClientId);

    // Fresh client instance (no cached token) using the isolated credential
    const revokedClient = new FlowblinqClient({
      clientId: a4ClientId,
      clientSecret: a4Secret,
      baseUrl,
    });

    let caughtError: unknown = null;
    try {
      await revokedClient.getAccount();
    } catch (e) {
      caughtError = e;
    } finally {
      // Restore just in case (afterAll will delete, but keep state clean)
      await supabase
        .from("api_clients")
        .update({ revoked_at: null })
        .eq("client_id", a4ClientId);
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError).toBeInstanceOf(FlowblinqApiError);
    expect((caughtError as FlowblinqApiError).status).toBe(401);
  });
});

describe("Auth: JWT claims inspection", () => {
  it("A-5: JWT payload contains team_id and scopes fields", async () => {
    // Force token acquisition
    await client.getAccount();

    // Access tokenCache (private — cast via unknown)
    const cache = (client as unknown as { tokenCache: { value: string } | null }).tokenCache;
    expect(cache).not.toBeNull();

    const token = cache!.value;
    const parts = token.split(".");
    expect(parts).toHaveLength(3);

    // Decode JWT payload (base64url → JSON)
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;

    expect(payload.team_id).toBe(teamId);
    expect(Array.isArray(payload.scopes)).toBe(true);
    expect((payload.scopes as string[]).length).toBeGreaterThan(0);
    expect((payload.scopes as string[])).toContain("audit:read");
  });
});

describe("Auth: expired and missing tokens", () => {
  it("A-6: expired JWT in Authorization header → 401", async () => {
    // A pre-expired JWT signed with wrong key — just needs to be syntactically valid
    // We use a known-expired token structure (HS256, exp in past)
    // Crafted manually: header.payload.wrongsig
    const expiredHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url"
    );
    const expiredPayload = Buffer.from(
      JSON.stringify({
        sub: "fake-client",
        team_id: teamId,
        scopes: ["audit:read"],
        iat: Math.floor(Date.now() / 1000) - 7200,
        exp: Math.floor(Date.now() / 1000) - 3600,
      })
    ).toString("base64url");
    const fakeExpiredJwt = `${expiredHeader}.${expiredPayload}.invalidsignature`;

    const res = await fetch(`${baseUrl}/api/v1/account`, {
      headers: { Authorization: `Bearer ${fakeExpiredJwt}` },
    });

    expect(res.status).toBe(401);
  });

  it("A-7: no Authorization header → 401", async () => {
    const res = await fetch(`${baseUrl}/api/v1/account`);
    expect(res.status).toBe(401);
  });
});

// ─── A-8: Rate limit — isolated credential ───────────────────────────────────

describe("Auth: rate limiting (isolated credential)", () => {
  let isolatedClientId: string;
  let isolatedSecret: string;
  let isolatedRowId: string;

  beforeAll(async () => {
    // Provision a fresh credential just for this test to avoid polluting the shared one
    const supabase = createClient(
      process.env.TEST_SUPABASE_URL!,
      process.env.TEST_SUPABASE_SERVICE_KEY!
    );

    isolatedRowId = nanoid();
    isolatedClientId = "test_rl_" + nanoid(12);
    isolatedSecret = nanoid(32);
    const hash = await bcrypt.hash(isolatedSecret, 12);

    const { error } = await supabase.from("api_clients").insert({
      id: isolatedRowId,
      team_id: globalThis.__API_CLIENT_QA__.teamId,
      client_id: isolatedClientId,
      client_secret_hash: hash,
      name: `rate-limit-test-${Date.now()}`,
      scopes: ["audit:read"],
      created_at: new Date().toISOString(),
    });
    if (error) throw new Error(`A-8 setup failed: ${error.message}`);
  });

  afterAll(async () => {
    const supabase = createClient(
      process.env.TEST_SUPABASE_URL!,
      process.env.TEST_SUPABASE_SERVICE_KEY!
    );
    await supabase.from("api_clients").delete().eq("id", isolatedRowId);
  });

  it("A-8: 11 sequential token requests with same client_id — first 10 succeed, 11th is 429", async () => {
    const results: number[] = [];

    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${baseUrl}/api/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: isolatedClientId,
          client_secret: isolatedSecret,
        }),
      });
      results.push(res.status);
    }

    // First 10 must be 200
    expect(results.slice(0, 10).every((s) => s === 200)).toBe(true);
    // 11th must be 429
    expect(results[10]).toBe(429);
  });
});
