/**
 * ES-087 — consecutive-bad-request blocking integration tests
 *
 * Spec-first (RED until route + migration land).
 *
 * Covers TS-087 §5 criteria #16, #17:
 *   #16 — 21st consecutive bad request triggers 401 client_blocked;
 *         subsequent valid requests also blocked until manual unblock.
 *   #17 — any 2xx interspersed resets the consecutive counter.
 *
 * Uses an isolated api_client per test so the shared QA credential is never
 * poisoned by the block state (that would break every other integration test).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";

function supabaseAdmin() {
  return createClient(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_SERVICE_KEY!);
}

async function getBearer(clientId: string, clientSecret: string, baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  if (!res.ok) throw new Error(`oauth failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function apiGet(bearer: string, baseUrl: string, params: Record<string, string>) {
  const url = new URL(`${baseUrl}/api/v1/page_views`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetch(url, { headers: { authorization: `Bearer ${bearer}` } });
}

async function provisionIsolatedClient(teamId: string, baseUrl: string) {
  const rowId = nanoid();
  const clientId = "test_pvblock_" + nanoid(12);
  const secret = nanoid(32);
  await supabaseAdmin().from("api_clients").insert({
    id: rowId,
    team_id: teamId,
    client_id: clientId,
    client_secret_hash: await bcrypt.hash(secret, 12),
    name: `pv-block-${Date.now()}`,
    scopes: ["pageviews:read"],
    created_at: new Date().toISOString(),
  });
  const bearer = await getBearer(clientId, secret, baseUrl);
  return { rowId, clientId, secret, bearer };
}

let baseUrl: string;
let teamId: string;
let domain: string;
let slug: string;
let siteId: string;

beforeAll(async () => {
  const qa = globalThis.__API_CLIENT_QA__;
  if (!qa) throw new Error("__API_CLIENT_QA__ missing");
  baseUrl = qa.baseUrl;
  teamId = qa.teamId;
  domain = `pv-block-${nanoid(6)}.example.com`;
  slug = `pv-block-slug-${nanoid(6)}`;
  siteId = nanoid();
  await supabaseAdmin().from("geo_sites").insert({
    id: siteId, team_id: teamId, domain, slug,
    created_at: new Date().toISOString(),
  });
});

afterAll(async () => {
  await supabaseAdmin().from("geo_sites").delete().eq("id", siteId);
});

describe("TS-087 #16 — 21st consecutive bad request triggers client_blocked", () => {
  let client: Awaited<ReturnType<typeof provisionIsolatedClient>>;

  beforeAll(async () => { client = await provisionIsolatedClient(teamId, baseUrl); });
  afterAll(async () => {
    await supabaseAdmin().from("api_clients").delete().eq("id", client.rowId);
  });

  it("fires 20 bad requests, then 21st returns 401 client_blocked", async () => {
    // 20 × bad_cursor (malformed base64)
    for (let i = 0; i < 20; i++) {
      const res = await apiGet(client.bearer, baseUrl, { domain, cursor: "!!!invalid!!!" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("bad_cursor");
    }
    // 21st — still malformed, but now should block
    const res21 = await apiGet(client.bearer, baseUrl, { domain, cursor: "!!!invalid!!!" });
    expect(res21.status).toBe(401);
    expect((await res21.json()).error).toBe("client_blocked");

    // And a subsequently VALID request also returns 401 client_blocked (block persists)
    const resValid = await apiGet(client.bearer, baseUrl, { domain });
    expect(resValid.status).toBe(401);
    expect((await resValid.json()).error).toBe("client_blocked");

    // Verify DB state: blocked_at set, consecutive_bad_requests >= 21
    const { data } = await supabaseAdmin()
      .from("api_clients")
      .select("blocked_at, consecutive_bad_requests")
      .eq("id", client.rowId)
      .single();
    expect(data?.blocked_at).not.toBeNull();
    expect(Number(data?.consecutive_bad_requests)).toBeGreaterThanOrEqual(21);
  }, 60_000);
});

describe("TS-087 #17 — interspersed 2xx resets consecutive counter", () => {
  let client: Awaited<ReturnType<typeof provisionIsolatedClient>>;

  beforeAll(async () => { client = await provisionIsolatedClient(teamId, baseUrl); });
  afterAll(async () => {
    await supabaseAdmin().from("api_clients").delete().eq("id", client.rowId);
  });

  it("15 bad + 1 valid + 15 bad does NOT trigger block (counter reset)", async () => {
    for (let i = 0; i < 15; i++) {
      const r = await apiGet(client.bearer, baseUrl, { domain, cursor: "!!!invalid!!!" });
      expect(r.status).toBe(400);
    }
    const rOk = await apiGet(client.bearer, baseUrl, { domain });
    expect(rOk.status).toBe(200);

    for (let i = 0; i < 15; i++) {
      const r = await apiGet(client.bearer, baseUrl, { domain, cursor: "!!!invalid!!!" });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe("bad_cursor"); // never client_blocked
    }

    // DB: blocked_at remains NULL, consecutive count <= 15
    const { data } = await supabaseAdmin()
      .from("api_clients")
      .select("blocked_at, consecutive_bad_requests")
      .eq("id", client.rowId)
      .single();
    expect(data?.blocked_at).toBeNull();
    expect(Number(data?.consecutive_bad_requests)).toBeLessThanOrEqual(15);
  }, 60_000);
});
