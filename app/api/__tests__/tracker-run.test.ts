// Scheduler cron — team-org scoping is the critical property under test: PCG's
// clients/runs share these tables and must never be scheduled, recovered, or
// enqueued by this service. Purge is the one deliberately GLOBAL job.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import * as tdb from "@/lib/tracker-db";
import { sql, eq } from "drizzle-orm";

const enqueueMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/engine/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/engine/enqueue")>();
  return { ...actual, enqueueTrackerJob: (...args: unknown[]) => enqueueMock(...args) };
});

import { GET } from "@/app/api/cron/tracker-run/route";

const SECRET = "cron-secret-0123456789abcdef0123456789abcdef";
const dbUrl = process.env.TEST_DATABASE_URL;

const tick = (auth = true) =>
  GET(
    new NextRequest("http://x/api/cron/tracker-run", {
      headers: auth ? { authorization: `Bearer ${SECRET}` } : {},
    }),
  );

describe.skipIf(!dbUrl)("GET /api/cron/tracker-run (Postgres)", () => {
  const TEAM = "tm_sched";
  const USER = "user_sched";
  const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  beforeEach(async () => {
    process.env.CRON_SECRET = SECRET;
    enqueueMock.mockClear();
    await db.execute(sql`DELETE FROM tracker.orgs`);
    await db.delete(schema.teams).where(eq(schema.teams.id, TEAM));
    await db.insert(schema.teams).values({ id: TEAM, name: "Sched", ownerUserId: USER, creditBalance: 100 });

    // PCG-like org with a DUE client + prompt — must be invisible to this cron.
    await db.execute(sql`INSERT INTO tracker.orgs (id, name) VALUES ('org_pcg', 'PCG')`);
    await db.execute(sql`
      INSERT INTO tracker.clients (id, org_id, name, status, run_frequency, next_run_at)
      VALUES ('tc_pcg', 'org_pcg', 'PCG Client', 'active', 'monthly', ${PAST})
    `);
    await db.execute(sql`INSERT INTO tracker.prompts (id, client_id, name, category) VALUES ('tp_pcg', 'tc_pcg', 'P', 'brand')`);
    await db.execute(sql`INSERT INTO tracker.prompt_versions (id, prompt_id, version, text) VALUES ('tpv_pcg', 'tp_pcg', 1, 'x')`);
  });

  async function seedTeamBrand(frequency: "weekly" | "monthly" = "monthly") {
    const brand = await tdb.createBrand(TEAM, "Sched", { name: "Acme", domain: "acme.com", runFrequency: frequency });
    await tdb.createPrompt(TEAM, brand.id, { name: "P1", category: "brand", text: "best acme?" });
    await db.execute(sql`UPDATE tracker.clients SET next_run_at = ${PAST} WHERE id = ${brand.id}`);
    return brand.id;
  }

  it("401 without the cron secret", async () => {
    const res = await tick(false);
    expect(res.status).toBe(401);
  });

  it("starts a due team client: run created, next_run_at advanced, worker enqueued", async () => {
    const clientId = await seedTeamBrand("monthly");
    const res = await tick();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.started).toBe(1);
    expect(body.errors).toEqual([]);

    const runs = await tdb.listRuns(TEAM, clientId);
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe("scheduled");
    expect(enqueueMock).toHaveBeenCalledWith({ runId: runs[0].id, clientId, cursor: 0 });

    // Compare inside Postgres — raw timestamp columns are tz-naive and JS-side
    // Date comparisons drift by the host offset.
    const [client] = (await db.execute(
      sql`SELECT (next_run_at > now()) AS advanced FROM tracker.clients WHERE id = ${clientId}`,
    )) as unknown as Array<{ advanced: boolean }>;
    expect(client.advanced).toBe(true);
  });

  it("NEVER schedules or enqueues PCG's due clients", async () => {
    const res = await tick();
    expect(res.status).toBe(200);
    expect((await res.json()).started).toBe(0);
    expect(enqueueMock).not.toHaveBeenCalled();

    const pcgRuns = (await db.execute(
      sql`SELECT id FROM tracker.runs WHERE client_id = 'tc_pcg'`,
    )) as unknown as unknown[];
    expect(pcgRuns).toHaveLength(0);
    // and its next_run_at was not advanced (still in the past = still due)
    const [pcg] = (await db.execute(
      sql`SELECT (next_run_at < now()) AS still_due FROM tracker.clients WHERE id = 'tc_pcg'`,
    )) as unknown as Array<{ still_due: boolean }>;
    expect(pcg.still_due).toBe(true);
  });

  it("is idempotent per (client, period): a re-due tick never duplicates the scheduled run", async () => {
    const clientId = await seedTeamBrand();
    await tick();
    // Force the client due again within the same period.
    await db.execute(sql`UPDATE tracker.clients SET next_run_at = ${PAST} WHERE id = ${clientId}`);
    await tick();
    const runs = await tdb.listRuns(TEAM, clientId);
    expect(runs.filter((r) => r.kind === "scheduled")).toHaveLength(1);
  });

  it("recovers stale team runs from their cursor — but not PCG's", async () => {
    const clientId = await seedTeamBrand();
    const staleAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // > 2h window
    await db.execute(sql`
      INSERT INTO tracker.runs (id, client_id, org_id, period, kind, status, cursor, created_at)
      VALUES ('tr_stale_team', ${clientId}, ${"team_" + TEAM}, '2026-07', 'manual', 'running', 7, ${staleAt}),
             ('tr_stale_pcg', 'tc_pcg', 'org_pcg', '2026-07', 'manual', 'running', 3, ${staleAt})
    `);
    // make the team client not due so job A stays quiet
    await db.execute(sql`UPDATE tracker.clients SET next_run_at = now() + interval '1 day' WHERE id = ${clientId}`);

    const res = await tick();
    const body = await res.json();
    expect(body.recovered).toBe(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith({ runId: "tr_stale_team", clientId, cursor: 7 });
  });

  it("purges 13-month-old response bodies GLOBALLY (PCG included), keeps recent ones", async () => {
    const clientId = await seedTeamBrand();
    await db.execute(sql`UPDATE tracker.clients SET next_run_at = now() + interval '1 day' WHERE id = ${clientId}`);
    const oldDate = new Date();
    oldDate.setUTCMonth(oldDate.getUTCMonth() - 13);
    const old = oldDate.toISOString();
    await db.execute(sql`
      INSERT INTO tracker.runs (id, client_id, org_id, period, kind, status)
      VALUES ('tr_purge_pcg', 'tc_pcg', 'org_pcg', '2025-05', 'manual', 'complete')
    `);
    await db.execute(sql`
      INSERT INTO tracker.responses (id, run_id, client_id, prompt_version_id, platform, attempt, created_at)
      VALUES ('trr_old', 'tr_purge_pcg', 'tc_pcg', 'tpv_pcg', 'openai', 1, ${old}),
             ('trr_new', 'tr_purge_pcg', 'tc_pcg', 'tpv_pcg', 'openai', 2, now())
    `);

    const res = await tick();
    const body = await res.json();
    expect(body.purgedResponses).toBe(1);
    const left = (await db.execute(
      sql`SELECT id FROM tracker.responses WHERE run_id = 'tr_purge_pcg'`,
    )) as unknown as Array<{ id: string }>;
    expect(left.map((r) => r.id)).toEqual(["trr_new"]);
  });

  it("skips enqueue for a due client with no active prompts", async () => {
    const brand = await tdb.createBrand(TEAM, "Sched", { name: "Empty", domain: "empty.com", runFrequency: "monthly" });
    await db.execute(sql`UPDATE tracker.clients SET next_run_at = ${PAST} WHERE id = ${brand.id}`);
    const res = await tick();
    const body = await res.json();
    expect(body.started).toBe(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
