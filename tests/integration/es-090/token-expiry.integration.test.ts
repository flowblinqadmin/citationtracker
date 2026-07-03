/**
 * ES-090 IT1, IT2 — Token expiry E2E + regenerate flow.
 *
 * Phase A (RED): seedSite with explicit tokenExpiresAt fails until migration
 * lands the column. Once landed, fast-forwarding the row's expiry then hitting
 * the 4 gated routes must yield 401 + { code: "TOKEN_EXPIRED" }.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { db, seedSite, cleanupSite, closeDb, eq } from "./_setup";
import { geoSites, geoSiteView } from "@/lib/db/schema";

const created: string[] = [];

beforeAll(() => {
  if (!process.env.NEXT_PUBLIC_APP_URL) {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  }
});

afterEach(async () => {
  while (created.length) {
    const id = created.pop()!;
    try { await cleanupSite(id); } catch { /* ignore */ }
  }
});

afterAll(async () => { await closeDb(); });

const ROUTES = (id: string, token: string) => ({
  get:           { method: "GET",  path: `/api/sites/${id}?token=${token}` },
  citationCheck: { method: "POST", path: `/api/sites/${id}/citation-check?token=${token}` },
  competitor:    { method: "POST", path: `/api/sites/${id}/competitor-discovery?token=${token}` },
  regenerate:    { method: "POST", path: `/api/sites/${id}/regenerate?token=${token}` },
});

async function callRoute(method: string, path: string): Promise<{ status: number; body: unknown }> {
  const url = `${process.env.NEXT_PUBLIC_APP_URL}${path}`;
  const res = await fetch(url, { method });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

describe("ES-090 IT1 — Token expiry E2E across 4 gated routes", () => {
  it("expires the token, then all 4 routes return 401 with code: TOKEN_EXPIRED", async () => {
    const site = await seedSite({ withTeam: true });
    created.push(site.id);

    // Fast-forward the DB clock by setting tokenExpiresAt 1 second in the past.
    await db.update(geoSites)
      .set({ tokenExpiresAt: new Date(Date.now() - 1000) } as Record<string, unknown>)
      .where(eq(geoSites.id, site.id));

    const r = ROUTES(site.id, site.accessToken);
    for (const { method, path } of Object.values(r)) {
      const { status, body } = await callRoute(method, path);
      expect(status, `${method} ${path} status`).toBe(401);
      expect((body as { code?: string }).code, `${method} ${path} body.code`).toBe("TOKEN_EXPIRED");
    }
  }, 30_000);
});

describe("ES-090 HP-234 — U2e trigger-path propagation (geo_sites → geo_site_view)", () => {
  // HP-234 (new MINOR from HP Loop 2 spec re-review):
  //   citation-check/route.ts:9 says sync to geo_site_view is handled by a
  //   Postgres trigger. If that trigger is column-specific (explicit list)
  //   rather than row-wide (SELECT *), ALTER TABLE that adds
  //   token_expires_at leaves the view mirror stale — silent 401 storm on
  //   every authenticated request.
  //
  // This test pins the row-wide invariant: a raw `db.update(geoSites)` of
  // token_expires_at MUST propagate to geo_site_view without any
  // application-level sync call. If a future migration adds a
  // column-specific trigger that omits the new column, this test turns RED.
  it("U2e: raw db.update(geoSites).set(tokenExpiresAt) propagates to geoSiteView via Postgres trigger", async () => {
    const site = await seedSite({ withTeam: true });
    created.push(site.id);

    const futureExpiry = new Date(Date.now() + 7 * 86_400_000);

    // NO site-view-sync call — we're testing the DB-level trigger invariant,
    // not the application fallback path.
    await db.update(geoSites)
      .set({ tokenExpiresAt: futureExpiry } as Record<string, unknown>)
      .where(eq(geoSites.id, site.id));

    const [viewRow] = await db.select().from(geoSiteView)
      .where(eq(geoSiteView.siteId, site.id));

    expect(viewRow, "geo_site_view row must exist for seeded site").toBeDefined();
    const viewExpiry = (viewRow as { tokenExpiresAt?: Date | null }).tokenExpiresAt;
    expect(viewExpiry, "tokenExpiresAt must propagate to geo_site_view").toBeInstanceOf(Date);
    expect(viewExpiry!.getTime()).toBe(futureExpiry.getTime());
  }, 30_000);
});

describe("ES-090 IT2 — Regenerate rotates token + refreshes expiry", () => {
  it("old token rejected after regenerate; new token in response", async () => {
    const site = await seedSite({ withTeam: true });
    created.push(site.id);

    const oldToken = site.accessToken;
    const regenRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/sites/${site.id}/regenerate?token=${oldToken}`, { method: "POST" });
    expect(regenRes.status).toBe(200);
    const body = await regenRes.json() as { accessToken?: string };
    expect(body.accessToken).toBeTruthy();
    expect(body.accessToken).not.toBe(oldToken);

    // Old token must now 401 with TOKEN_EXPIRED or generic Unauthorized
    // (the pre-rotation expiry check makes either acceptable; spec-wise the
    // tokenExpiresAt of the old token row is now in the past).
    const oldCheck = await callRoute("GET", `/api/sites/${site.id}?token=${oldToken}`);
    expect(oldCheck.status).toBe(401);
  }, 30_000);
});
