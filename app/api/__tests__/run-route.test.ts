// The credit-gated run trigger — the money path.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import * as tdb from "@/lib/tracker-db";
import { POST } from "@/app/api/brands/[id]/run/route";
import { sql, eq } from "drizzle-orm";

// Identity arrives via middleware-stamped headers; mock the header store.
const headerStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => headerStore.get(k.toLowerCase()) ?? null }),
}));

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)("POST /api/brands/[id]/run (Postgres)", () => {
  const TEAM = "tm_run_route";
  const USER = "user_run_route";
  let clientId: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  const call = (body?: unknown) =>
    POST(
      new NextRequest("http://x/api/brands/x/run", {
        method: "POST",
        ...(body !== undefined
          ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
          : {}),
      }),
      { params: Promise.resolve({ id: clientId }) },
    );

  beforeEach(async () => {
    process.env.QSTASH_TOKEN = "qstash-test-token";
    headerStore.clear();
    headerStore.set("x-user-id", USER);
    headerStore.set("x-user-email", "run@test.com");
    headerStore.set("x-supabase-token", "tok");

    await db.execute(sql`DELETE FROM tracker.orgs`);
    await db.execute(sql`DELETE FROM rate_limits`);
    await db.delete(schema.creditTransactions).where(eq(schema.creditTransactions.teamId, TEAM));
    await db.delete(schema.teamMembers).where(eq(schema.teamMembers.teamId, TEAM));
    await db.delete(schema.teams).where(eq(schema.teams.id, TEAM));
    await db.insert(schema.teams).values({ id: TEAM, name: "Run Test", ownerUserId: USER, creditBalance: 20 });
    await db.insert(schema.teamMembers).values({ id: "tmm_1", teamId: TEAM, userId: USER, email: "run@test.com", role: "owner" });

    const brand = await tdb.createBrand(TEAM, "Run Test", { name: "Acme" });
    clientId = brand.id;
    // 10 prompts → ceil(10 × 3 × 0.013 / 0.10) = 4 credits
    for (let i = 0; i < 10; i++) {
      await tdb.createPrompt(TEAM, clientId, { name: `P${i}`, category: "brand", text: `prompt ${i}` });
    }

    fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  async function balance(): Promise<number> {
    const [t] = await db.select({ b: schema.teams.creditBalance }).from(schema.teams).where(eq(schema.teams.id, TEAM));
    return t.b;
  }

  it("debits, creates the run, and publishes to QStash with the worker URL", async () => {
    const res = await call();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.started).toBe(true);
    expect(body.credits).toBe(4);
    expect(await balance()).toBe(16);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("qstash.upstash.io/v2/publish/");
    expect(url).toContain("/api/tracker/worker");
    expect(init.headers.Authorization).toBe("Bearer qstash-test-token");
    const payload = JSON.parse(init.body);
    expect(payload).toEqual({ runId: body.run.id, clientId, cursor: 0 });
  });

  it("402 on insufficient credits with zero side effects", async () => {
    await db.update(schema.teams).set({ creditBalance: 2 }).where(eq(schema.teams.id, TEAM));
    const res = await call();
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body).toMatchObject({ error: "insufficient_credits", required: 4, balance: 2 });
    expect(body.buyCreditsUrl).toContain("/dashboard");
    expect(await balance()).toBe(2);
    const runs = await tdb.listRuns(TEAM, clientId);
    expect(runs).toEqual([]); // the provisional row was rolled back
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks the run failed and refunds when the publish fails", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const res = await call();
    expect(res.status).toBe(502);
    expect(await balance()).toBe(20); // refunded
    const runs = await tdb.listRuns(TEAM, clientId);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
  });

  it("returns the in-flight run instead of double-charging", async () => {
    const first = await call();
    expect(first.status).toBe(201);
    const second = await call();
    expect(second.status).toBe(200);
    expect((await second.json()).alreadyRunning).toBe(true);
    expect(await balance()).toBe(16); // charged once
  });

  it("double-submit race: concurrent POSTs yield exactly one charge and one run", async () => {
    const [a, b] = await Promise.all([call(), call()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBeLessThanOrEqual(201);
    expect(await balance()).toBe(16);
    const runs = await tdb.listRuns(TEAM, clientId);
    expect(runs.filter((r) => r.status === "pending")).toHaveLength(1);
  });

  it("401 without a session", async () => {
    headerStore.clear();
    const res = await call();
    expect(res.status).toBe(401);
    expect(await balance()).toBe(20);
  });

  it("404 for another team's brand, with no charge", async () => {
    await db.execute(sql`INSERT INTO tracker.orgs (id, name) VALUES ('org_other', 'Other')`);
    await db.execute(sql`INSERT INTO tracker.clients (id, org_id, name) VALUES ('tc_other', 'org_other', 'X')`);
    clientId = "tc_other";
    const res = await call();
    expect(res.status).toBe(404);
    expect(await balance()).toBe(20);
  });

  it("scoped run: single prompt on a single platform costs 1 credit and stores scope", async () => {
    const prompts = await tdb.listPrompts(TEAM, clientId);
    const res = await call({ promptIds: [prompts[0].promptId], platforms: ["google"] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.credits).toBe(1);
    expect(await balance()).toBe(19);
    expect(body.run.promptsTotal).toBe(1);
    expect(body.run.scope.platforms).toEqual(["google"]);
    expect(body.run.scope.promptVersionIds).toHaveLength(1);
    // worker payload is unchanged — geo reads scope from the run row
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toEqual({ runId: body.run.id, clientId, cursor: 0 });
  });

  it("400 on invalid scope with zero side effects", async () => {
    const res = await call({ promptIds: ["tp_not_mine"] });
    expect(res.status).toBe(400);
    expect(await balance()).toBe(20);
    expect(await tdb.listRuns(TEAM, clientId)).toEqual([]);
    const res2 = await call({ platforms: ["bing"] });
    expect(res2.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("429 over the per-team rate limit", async () => {
    // Exhaust the limit (10/h) — each call creates + leaves a completed run so
    // the in-flight dedupe doesn't mask the limiter.
    for (let i = 0; i < 10; i++) {
      const res = await call();
      const body = await res.json().catch(() => ({}));
      if (body.run?.id) {
        await db.execute(sql`UPDATE tracker.runs SET status = 'complete' WHERE id = ${body.run.id}`);
      }
    }
    const res = await call();
    expect(res.status).toBe(429);
  });
});
