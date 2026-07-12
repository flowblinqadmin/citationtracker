// Tracked publicity URLs API: GET (list + live stats) and PUT (full replace).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import * as tdb from "@/lib/tracker-db";
import { GET, PUT } from "@/app/api/brands/[id]/tracked-urls/route";
import { sql, eq } from "drizzle-orm";

// Identity arrives via middleware-stamped headers; mock the header store.
const headerStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => headerStore.get(k.toLowerCase()) ?? null }),
}));

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)("GET/PUT /api/brands/[id]/tracked-urls (Postgres)", () => {
  const TEAM = "tm_tracked_route";
  const USER = "user_tracked_route";
  let clientId: string;
  let promptVersionId: string;
  let runId: string;

  const getCall = () =>
    GET(new NextRequest("http://x/api/brands/x/tracked-urls"), { params: Promise.resolve({ id: clientId }) });

  const putCall = (body: unknown) =>
    PUT(
      new NextRequest("http://x/api/brands/x/tracked-urls", {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: clientId }) },
    );

  beforeEach(async () => {
    headerStore.clear();
    headerStore.set("x-user-id", USER);
    headerStore.set("x-user-email", "tracked@test.com");
    headerStore.set("x-supabase-token", "tok");

    await db.execute(sql`DELETE FROM tracker.orgs`);
    await db.delete(schema.creditTransactions).where(eq(schema.creditTransactions.teamId, TEAM));
    await db.delete(schema.teamMembers).where(eq(schema.teamMembers.teamId, TEAM));
    await db.delete(schema.teams).where(eq(schema.teams.id, TEAM));
    await db.insert(schema.teams).values({ id: TEAM, name: "Tracked", ownerUserId: USER, creditBalance: 100 });
    await db.insert(schema.teamMembers).values({ id: "tmm_tracked", teamId: TEAM, userId: USER, email: "tracked@test.com", role: "owner" });

    const brand = await tdb.createBrand(TEAM, "Tracked", { name: "Acme", domain: "acme.com" });
    clientId = brand.id;
    const p = await tdb.createPrompt(TEAM, clientId, { name: "P", category: "brand", text: "What is Acme?" });
    const [version] = await db
      .select()
      .from(schema.trackerPromptVersions)
      .where(eq(schema.trackerPromptVersions.promptId, p.promptId));
    promptVersionId = version.id;
    // A real run row — citations FK-reference it (go-live cascade FK is applied).
    const created = await tdb.createManualRunRow(TEAM, clientId);
    if (created.kind !== "run") throw new Error("setup: expected run");
    runId = created.run.id;
  });

  it("GET returns an empty list for a brand with no tracked URLs", async () => {
    const res = await getCall();
    expect(res.status).toBe(200);
    expect((await res.json()).urls).toEqual([]);
  });

  it("PUT stores URLs and GET returns them with live stats", async () => {
    // Citation exists first — stats must match retroactively.
    await db.insert(schema.trackerCitations).values({
      id: "cit_route", runId, clientId, promptVersionId, platform: "openai",
      rawUrl: "https://outlet.com/piece", normalizedUrl: "outlet.com/piece", domain: "outlet.com", matchType: "unmatched",
    });

    const putRes = await putCall({ urls: ["https://www.outlet.com/piece?utm_source=x", "not a url"] });
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.rejected).toEqual(["not a url"]);
    expect(putBody.urls).toHaveLength(1);
    expect(putBody.urls[0].stats.exactCount).toBe(1);
    expect(putBody.urls[0].stats.platforms).toEqual(["openai"]);

    const getRes = await getCall();
    const getBody = await getRes.json();
    expect(getBody.urls).toHaveLength(1);
    expect(getBody.urls[0].normalizedUrl).toBe("outlet.com/piece");
    expect(getBody.urls[0].stats.exactCount).toBe(1);
  });

  it("PUT is a full replace", async () => {
    await putCall({ urls: ["https://a.com/1", "https://b.com/2"] });
    const res = await putCall({ urls: ["https://c.com/3"] });
    const body = await res.json();
    expect(body.urls.map((u: { normalizedUrl: string }) => u.normalizedUrl)).toEqual(["c.com/3"]);
  });

  it("400 on zod rejection (>50 URLs, or over-length entry)", async () => {
    const many = Array.from({ length: 51 }, (_, i) => `https://o${i}.com/p`);
    expect((await putCall({ urls: many })).status).toBe(400);
    expect((await putCall({ urls: ["x".repeat(2049)] })).status).toBe(400);
    expect((await putCall({ notUrls: [] })).status).toBe(400);
  });

  it("401 without a session (GET and PUT)", async () => {
    headerStore.clear();
    expect((await getCall()).status).toBe(401);
    expect((await putCall({ urls: [] })).status).toBe(401);
  });

  it("404 for another team's brand (PUT), leaving it untouched", async () => {
    await db.execute(sql`INSERT INTO tracker.orgs (id, name) VALUES ('org_other_tracked', 'Other')`);
    await db.execute(sql`INSERT INTO tracker.clients (id, org_id, name) VALUES ('tc_other_tracked', 'org_other_tracked', 'X')`);
    await db.insert(schema.trackerArticles).values({
      id: "ta_other", clientId: "tc_other_tracked", url: "https://x.com/y", normalizedUrl: "x.com/y", source: "manual",
    });
    clientId = "tc_other_tracked";
    const res = await putCall({ urls: ["https://hacked.com/z"] });
    expect(res.status).toBe(404);
    // GET on a foreign brand returns an empty list (never leaks the article).
    const getRes = await getCall();
    expect((await getRes.json()).urls).toEqual([]);
    const [still] = await db.select().from(schema.trackerArticles).where(eq(schema.trackerArticles.id, "ta_other"));
    expect(still.normalizedUrl).toBe("x.com/y"); // unchanged
  });
});
