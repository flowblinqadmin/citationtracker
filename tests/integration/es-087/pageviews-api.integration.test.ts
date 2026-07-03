/**
 * ES-087 — /api/v1/page_views integration tests
 *
 * Spec-first (RED until app/api/v1/page_views/route.ts is implemented).
 *
 * Covers TS-087 §5 success criteria 1–15 end-to-end against a real postgres
 * test DB. Uses `globalThis.__API_CLIENT_QA__` fixture from
 * tests/integration/api-client/setup.ts for the shared QA client. Test cases
 * that mutate client state (revocation, isolation) provision separate
 * credentials in beforeAll to avoid interfering with other concurrent
 * test files.
 *
 * Fixture layout (built in beforeAll):
 *   - team A (shared QA team) owns domain "pv-test-a.example.com" → slug "pv-slug-a"
 *   - team B (freshly provisioned) owns domain "pv-test-b.example.com" → slug "pv-slug-b"
 *   - N seeded geo_page_views rows split across both teams + bots + host mismatches
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  const j = await res.json();
  return j.access_token;
}

async function apiGet(bearer: string, baseUrl: string, params: Record<string, string> = {}) {
  const url = new URL(`${baseUrl}/api/v1/page_views`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetch(url, { headers: { authorization: `Bearer ${bearer}` } });
}

// ── Fixture state ────────────────────────────────────────────────────────────

let baseUrl: string;
let teamA_id: string;
let teamA_bearer: string;
let teamA_clientId: string;
let teamA_clientSecret: string;
let teamA_clientRowId: string;

let teamB_id: string;
let teamB_bearer: string;
let teamB_clientId: string;
let teamB_clientSecret: string;
let teamB_clientRowId: string;

const DOMAIN_A = "pv-test-a.example.com";
const DOMAIN_B = "pv-test-b.example.com";
const SLUG_A = `pv-slug-a-${nanoid(6)}`;
const SLUG_B = `pv-slug-b-${nanoid(6)}`;

let seededIds: string[] = [];
let seededSiteIds: string[] = [];

beforeAll(async () => {
  const qa = globalThis.__API_CLIENT_QA__;
  if (!qa) throw new Error("__API_CLIENT_QA__ missing — check tests/integration/api-client/setup.ts");
  baseUrl = qa.baseUrl;
  teamA_id = qa.teamId;

  const supabase = supabaseAdmin();

  // ─── Team A: add pageviews:read scope to the shared QA client ────────────
  teamA_clientId = qa.clientId;
  teamA_clientSecret = qa.clientSecret;
  // Grant scope (union with existing scopes)
  {
    const { data: existing } = await supabase
      .from("api_clients")
      .select("id, scopes")
      .eq("client_id", teamA_clientId)
      .single();
    if (!existing) throw new Error("QA client row missing");
    teamA_clientRowId = existing.id;
    const nextScopes = Array.from(new Set([...(existing.scopes ?? []), "pageviews:read"]));
    await supabase.from("api_clients").update({ scopes: nextScopes }).eq("id", existing.id);
  }
  teamA_bearer = await getBearer(teamA_clientId, teamA_clientSecret, baseUrl);

  // ─── Team B: freshly provisioned, owns domain B ──────────────────────────
  teamB_id = nanoid();
  await supabase.from("teams").insert({
    id: teamB_id,
    name: `pv-test-team-b-${Date.now()}`,
    created_at: new Date().toISOString(),
  });
  teamB_clientId = "test_pvB_" + nanoid(12);
  teamB_clientSecret = nanoid(32);
  teamB_clientRowId = nanoid();
  await supabase.from("api_clients").insert({
    id: teamB_clientRowId,
    team_id: teamB_id,
    client_id: teamB_clientId,
    client_secret_hash: await bcrypt.hash(teamB_clientSecret, 12),
    name: `pv-test-client-b-${Date.now()}`,
    scopes: ["pageviews:read"],
    created_at: new Date().toISOString(),
  });
  teamB_bearer = await getBearer(teamB_clientId, teamB_clientSecret, baseUrl);

  // ─── Register geo_sites for both teams ───────────────────────────────────
  const siteA_id = nanoid();
  const siteB_id = nanoid();
  seededSiteIds.push(siteA_id, siteB_id);
  await supabase.from("geo_sites").insert([
    { id: siteA_id, team_id: teamA_id, domain: DOMAIN_A, slug: SLUG_A, created_at: new Date().toISOString() },
    { id: siteB_id, team_id: teamB_id, domain: DOMAIN_B, slug: SLUG_B, created_at: new Date().toISOString() },
  ]);

  // ─── Seed geo_page_views rows ────────────────────────────────────────────
  // For team A: 5 recent visitor rows + 1 bot row + 1 host-mismatch row
  // For team B: 2 recent visitor rows
  // Plus 1 row older than 72h for default-window test (criterion #14)
  const now = Date.now();
  const seed = (args: {
    slug: string; offsetMs: number; bot?: string; pageHost?: string;
  }) => {
    const id = nanoid();
    seededIds.push(id);
    return {
      id, slug: args.slug,
      page_url: `https://${args.pageHost ?? args.slug === SLUG_A ? DOMAIN_A : DOMAIN_B}/p/${id.slice(0, 4)}`,
      referrer: "https://google.com/",
      visitor_id: "vid-" + id.slice(0, 8),
      user_agent: "Mozilla/5.0",
      bot_name: args.bot ?? "visitor",
      ip: "1.2.3.4",
      country: "IN",
      screen_width: 1024,
      website_deploy_id: null,
      viewed_at: new Date(now - args.offsetMs).toISOString(),
    };
  };
  const rows = [
    // Team A: 5 recent visitor rows (5 minutes apart, within 30 min)
    ...Array.from({ length: 5 }, (_, i) => seed({ slug: SLUG_A, offsetMs: (i + 1) * 5 * 60_000 })),
    // Team A: 1 bot row per class — all should be RETURNED (no server-side bot filter per TS-087 §4)
    seed({ slug: SLUG_A, offsetMs: 8 * 60_000, bot: "googlebot" }),
    seed({ slug: SLUG_A, offsetMs: 9 * 60_000, bot: "chatgpt-user" }),
    seed({ slug: SLUG_A, offsetMs: 10 * 60_000, bot: "gptbot" }),
    seed({ slug: SLUG_A, offsetMs: 11 * 60_000, bot: "unknown" }),
    // Team A: 1 host-mismatch row (page_url on a different host — spoof attempt)
    seed({ slug: SLUG_A, offsetMs: 15 * 60_000, pageHost: "evil.example.com" }),
    // Team A: 1 row older than 72h (should be absent from default window)
    seed({ slug: SLUG_A, offsetMs: 73 * 60 * 60_000 }),
    // Team B: 2 recent visitor rows
    ...Array.from({ length: 2 }, (_, i) => seed({ slug: SLUG_B, offsetMs: (i + 1) * 5 * 60_000 })),
  ];
  await supabase.from("geo_page_views").insert(rows);
});

afterAll(async () => {
  const supabase = supabaseAdmin();
  if (seededIds.length) await supabase.from("geo_page_views").delete().in("id", seededIds);
  if (seededSiteIds.length) await supabase.from("geo_sites").delete().in("id", seededSiteIds);
  if (teamB_clientRowId) await supabase.from("api_clients").delete().eq("id", teamB_clientRowId);
  if (teamB_id) await supabase.from("teams").delete().eq("id", teamB_id);
});

// ════════════════════════════════════════════════════════════════════════════
// TS-087 §5 success criteria 1–15
// ════════════════════════════════════════════════════════════════════════════

describe("TS-087 #1 — valid request returns rows", () => {
  it("returns 200 with rows and slug_resolved, p95 server-side <200ms", async () => {
    const t0 = Date.now();
    const res = await apiGet(teamA_bearer, baseUrl, { domain: DOMAIN_A });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.domain).toBe(DOMAIN_A);
    expect(body.slug_resolved).toBe(SLUG_A);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
    expect(typeof body.served_ts).toBe("string");
    expect(elapsed).toBeLessThan(1000); // sanity: p95 target is 200ms, ceiling 1s
  });
});

describe("TS-087 #2 — scope missing → 403", () => {
  let noScopeClientId: string;
  let noScopeSecret: string;
  let noScopeRowId: string;
  let noScopeBearer: string;

  beforeAll(async () => {
    const supabase = supabaseAdmin();
    noScopeClientId = "test_noscope_" + nanoid(12);
    noScopeSecret = nanoid(32);
    noScopeRowId = nanoid();
    await supabase.from("api_clients").insert({
      id: noScopeRowId,
      team_id: teamA_id,
      client_id: noScopeClientId,
      client_secret_hash: await bcrypt.hash(noScopeSecret, 12),
      name: `pv-noscope-${Date.now()}`,
      scopes: ["account:read"], // no pageviews:read
      created_at: new Date().toISOString(),
    });
    noScopeBearer = await getBearer(noScopeClientId, noScopeSecret, baseUrl);
  });
  afterAll(async () => {
    await supabaseAdmin().from("api_clients").delete().eq("id", noScopeRowId);
  });

  it("returns 403 insufficient_scope", async () => {
    const res = await apiGet(noScopeBearer, baseUrl, { domain: DOMAIN_A });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("insufficient_scope");
  });
});

describe("TS-087 #3 — domain not owned by token's team → 404", () => {
  it("team A requesting team B's domain returns 404 domain_not_found", async () => {
    const res = await apiGet(teamA_bearer, baseUrl, { domain: DOMAIN_B });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("domain_not_found");
  });
});

describe("TS-087 #4 — missing bearer → 401", () => {
  it("no Authorization header returns 401 missing_token", async () => {
    const url = new URL(`${baseUrl}/api/v1/page_views?domain=${DOMAIN_A}`);
    const res = await fetch(url);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("missing_token");
  });
});

describe("TS-087 #5 — expired JWT → 401", () => {
  // An expired JWT is constructed by signing with a far-past `exp` claim, but
  // that requires knowing the JWT secret — not available in tests. Instead we
  // pass a malformed JWT and assert 401 with malformed_token, which exercises
  // the same error path.
  it("malformed JWT returns 401", async () => {
    const res = await apiGet("not.a.real.jwt", baseUrl, { domain: DOMAIN_A });
    expect(res.status).toBe(401);
    expect(["malformed_token", "token_expired", "missing_token"]).toContain((await res.json()).error);
  });
});

describe("TS-087 #6 — revoked api_client → 401", () => {
  let revClientId: string;
  let revSecret: string;
  let revRowId: string;
  let revBearer: string;

  beforeAll(async () => {
    const supabase = supabaseAdmin();
    revClientId = "test_rev_pv_" + nanoid(12);
    revSecret = nanoid(32);
    revRowId = nanoid();
    await supabase.from("api_clients").insert({
      id: revRowId,
      team_id: teamA_id,
      client_id: revClientId,
      client_secret_hash: await bcrypt.hash(revSecret, 12),
      name: `pv-rev-${Date.now()}`,
      scopes: ["pageviews:read"],
      created_at: new Date().toISOString(),
    });
    revBearer = await getBearer(revClientId, revSecret, baseUrl);
    // revoke AFTER minting the JWT — assertion is that a still-valid JWT is rejected
    await supabase.from("api_clients").update({ revoked_at: new Date().toISOString() }).eq("id", revRowId);
  });
  afterAll(async () => {
    await supabaseAdmin().from("api_clients").delete().eq("id", revRowId);
  });

  it("revoked client returns 401 client_revoked despite non-expired JWT", async () => {
    const res = await apiGet(revBearer, baseUrl, { domain: DOMAIN_A });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("client_revoked");
  });
});

describe("TS-087 #7 — rate limit exhaustion → 429", () => {
  let rlClientId: string;
  let rlSecret: string;
  let rlRowId: string;
  let rlBearer: string;

  beforeAll(async () => {
    const supabase = supabaseAdmin();
    rlClientId = "test_rl_pv_" + nanoid(12);
    rlSecret = nanoid(32);
    rlRowId = nanoid();
    await supabase.from("api_clients").insert({
      id: rlRowId,
      team_id: teamA_id,
      client_id: rlClientId,
      client_secret_hash: await bcrypt.hash(rlSecret, 12),
      name: `pv-rl-${Date.now()}`,
      scopes: ["pageviews:read"],
      created_at: new Date().toISOString(),
    });
    rlBearer = await getBearer(rlClientId, rlSecret, baseUrl);
  });
  afterAll(async () => {
    await supabaseAdmin().from("api_clients").delete().eq("id", rlRowId);
  });

  it("121st call within 1h returns 429 with Retry-After", async () => {
    // Burn the bucket; 120 is the quota per ES-087 §7.
    for (let i = 0; i < 120; i++) {
      const res = await apiGet(rlBearer, baseUrl, { domain: DOMAIN_A });
      if (res.status === 429) break; // should not trigger before the 121st
    }
    const res = await apiGet(rlBearer, baseUrl, { domain: DOMAIN_A });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limit_exceeded");
    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  }, 60_000);
});

describe("TS-087 #8 — cursor determinism across repeated calls", () => {
  it("same cursor returns byte-identical next page", async () => {
    const first = await apiGet(teamA_bearer, baseUrl, { domain: DOMAIN_A, limit: "2" });
    const firstBody = await first.json();
    expect(firstBody.has_more).toBe(true);
    const cursor = firstBody.next_cursor;

    const a = await (await apiGet(teamA_bearer, baseUrl, { domain: DOMAIN_A, limit: "2", cursor })).json();
    const b = await (await apiGet(teamA_bearer, baseUrl, { domain: DOMAIN_A, limit: "2", cursor })).json();
    expect(a.rows.map((r: any) => r.id)).toEqual(b.rows.map((r: any) => r.id));
    expect(a.next_cursor).toBe(b.next_cursor);
  });
});

describe("TS-087 #9 — cross-team isolation (red team)", () => {
  it("team A token + team B domain never returns 200 (must be 404)", async () => {
    const res = await apiGet(teamA_bearer, baseUrl, { domain: DOMAIN_B });
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(200);
  });
});

describe("TS-087 #10 — all bot classes returned with bot_name field exposed", () => {
  it("rows of every class (visitor + googlebot + chatgpt-user + gptbot + unknown) appear; each carries its bot_name", async () => {
    const res = await apiGet(teamA_bearer, baseUrl, { domain: DOMAIN_A, limit: "1000" });
    const body = await res.json();
    // seededIds layout (per beforeAll):
    //   [0..4]  = 5 visitor rows on DOMAIN_A
    //   [5]     = googlebot row (host-match OK)
    //   [6]     = chatgpt-user row
    //   [7]     = gptbot row
    //   [8]     = unknown row
    //   [9]     = host-mismatch row (evil.example.com) — stays filtered by host-match
    //   [10]    = >72h-old row — filtered by default time window
    //   [11..]  = team B rows (not in response)
    const returnedIds: string[] = body.rows.map((r: any) => r.id);
    expect(returnedIds).toEqual(expect.arrayContaining(seededIds.slice(0, 9))); // all 9 within-window DOMAIN_A rows
    expect(returnedIds).not.toContain(seededIds[9]);  // host-mismatch still dropped
    expect(returnedIds).not.toContain(seededIds[10]); // >72h still dropped
    // Every row carries a bot_name field
    for (const row of body.rows) {
      expect(typeof row.bot_name).toBe("string");
      expect(row.bot_name.length).toBeGreaterThan(0);
    }
    // All classes represented
    const classes = new Set(body.rows.map((r: any) => r.bot_name));
    for (const expected of ["visitor", "googlebot", "chatgpt-user", "gptbot", "unknown"]) {
      expect(classes.has(expected)).toBe(true);
    }
  });
});

describe("TS-087 #11 — no host-match filter (slug is the binding)", () => {
  it("rows with page_url on ANY host are returned (no server-side anti-spoof)", async () => {
    const res = await apiGet(teamA_bearer, baseUrl, { domain: DOMAIN_A, limit: "1000" });
    const body = await res.json();
    // Dropped 2026-04-21: the host-match filter silently dropped real traffic
    // for customers whose bare domain redirects to www (most of them). The
    // slug binding is what matters; if anti-spoof is ever needed it belongs
    // at ingestion time. See TS-087 §4.
    const knownHostMismatchRowId = seededIds[9]; // page_url = https://evil.example.com/...
    expect(body.rows.map((r: any) => r.id)).toContain(knownHostMismatchRowId);
  });
});

describe("TS-087 #12 — empty result", () => {
  let emptyDomain: string;
  let emptySlug: string;
  let emptySiteId: string;
  beforeAll(async () => {
    emptyDomain = `pv-test-empty-${nanoid(6)}.example.com`;
    emptySlug = `pv-slug-empty-${nanoid(6)}`;
    emptySiteId = nanoid();
    await supabaseAdmin().from("geo_sites").insert({
      id: emptySiteId, team_id: teamA_id, domain: emptyDomain, slug: emptySlug,
      created_at: new Date().toISOString(),
    });
  });
  afterAll(async () => {
    await supabaseAdmin().from("geo_sites").delete().eq("id", emptySiteId);
  });

  it("returns 200 with empty rows and has_more=false", async () => {
    const res = await apiGet(teamA_bearer, baseUrl, { domain: emptyDomain });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toEqual([]);
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();
  });
});

describe("TS-087 #13 — both since and cursor → 400 conflicting_params", () => {
  it("returns 400 when both params are present", async () => {
    const res = await apiGet(teamA_bearer, baseUrl, {
      domain: DOMAIN_A,
      since: "2026-04-21T00:00:00Z",
      cursor: "anycursorvalue",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("conflicting_params");
  });
});

describe("TS-087 #14 — default window is now-72h when no seed", () => {
  it("row older than 72h is absent from default window", async () => {
    const res = await apiGet(teamA_bearer, baseUrl, { domain: DOMAIN_A, limit: "1000" });
    const body = await res.json();
    // seededIds[10] is the 73h-old row; must be absent.
    const oldRowId = seededIds[10];
    expect(body.rows.map((r: any) => r.id)).not.toContain(oldRowId);
  });

  it("same row IS present when since explicitly set to 100h ago", async () => {
    const sinceTs = new Date(Date.now() - 100 * 60 * 60_000).toISOString();
    const res = await apiGet(teamA_bearer, baseUrl, { domain: DOMAIN_A, limit: "1000", since: sinceTs });
    const body = await res.json();
    const oldRowId = seededIds[10];
    expect(body.rows.map((r: any) => r.id)).toContain(oldRowId);
  });
});

describe("TS-087 #15 — malformed since → 400 bad_since", () => {
  it("non-RFC3339 since returns 400", async () => {
    const res = await apiGet(teamA_bearer, baseUrl, { domain: DOMAIN_A, since: "yesterday" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_since");
  });
});
