// Billing reconciliation — every run gets billed exactly once, whatever
// created or revived it.
import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { GET } from "@/app/api/cron/reconcile/route";
import { sql, eq } from "drizzle-orm";

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)("GET /api/cron/reconcile (Postgres)", () => {
  const TEAM = "tm_reconcile";
  const ORG = `team_${TEAM}`;
  let runSeq = 0;

  const call = () =>
    GET(new NextRequest("http://x/api/cron/reconcile", {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    }));

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM tracker.orgs`);
    await db.delete(schema.creditTransactions).where(eq(schema.creditTransactions.teamId, TEAM));
    await db.delete(schema.teams).where(eq(schema.teams.id, TEAM));
    await db.insert(schema.teams).values({ id: TEAM, name: "Reconcile", ownerUserId: "u", creditBalance: 100 });
    await db.execute(sql`INSERT INTO tracker.orgs (id, name) VALUES (${ORG}, 'Reconcile')`);
    await db.execute(sql`INSERT INTO tracker.clients (id, org_id, name) VALUES ('tc_rec', ${ORG}, 'Brand')`);
  });

  async function seedRun(status: string, promptsTotal: number | null = 10): Promise<string> {
    const id = `tr_rec_${Date.now()}_${runSeq++}`;
    await db.execute(sql`
      INSERT INTO tracker.runs (id, client_id, org_id, period, kind, status, prompts_total)
      VALUES (${id}, 'tc_rec', ${ORG}, '2026-07', 'scheduled', ${status}, ${promptsTotal})
    `);
    return id;
  }

  async function balance(): Promise<number> {
    const [t] = await db.select({ b: schema.teams.creditBalance }).from(schema.teams).where(eq(schema.teams.id, TEAM));
    return t.b;
  }

  it("401 without the cron secret", async () => {
    const res = await GET(new NextRequest("http://x/api/cron/reconcile"));
    expect(res.status).toBe(401);
  });

  it("debits an uncharged scheduled run post-hoc (10 prompts × 4 models → 100 credits)", async () => {
    await seedRun("complete");
    const res = await call();
    expect((await res.json()).debited).toBe(1);
    expect(await balance()).toBe(0);
  });

  it("prices an uncharged SCOPED run per prompt like any other (10 prompts × 1 base model → 20 credits)", async () => {
    const id = `tr_rec_scoped_${runSeq++}`;
    await db.execute(sql`
      INSERT INTO tracker.runs (id, client_id, org_id, period, kind, status, prompts_total, scope)
      VALUES (${id}, 'tc_rec', ${ORG}, '2026-07', 'manual', 'complete', 10, '{"platforms":["google"]}'::jsonb)
    `);
    const res = await call();
    expect((await res.json()).debited).toBe(1);
    // Per prompt × per model: 10 prompts × 1 base platform (2 credits) → 20 credits
    expect(await balance()).toBe(80);
  });

  it("prices a scoped Claude (anthropic) run at the premium 4 credits/prompt (10 prompts → 40 credits)", async () => {
    const id = `tr_rec_scoped_claude_${runSeq++}`;
    await db.execute(sql`
      INSERT INTO tracker.runs (id, client_id, org_id, period, kind, status, prompts_total, scope)
      VALUES (${id}, 'tc_rec', ${ORG}, '2026-07', 'manual', 'complete', 10, '{"platforms":["anthropic"]}'::jsonb)
    `);
    const res = await call();
    expect((await res.json()).debited).toBe(1);
    expect(await balance()).toBe(60);
  });

  it("is idempotent — a second pass changes nothing", async () => {
    await seedRun("complete");
    await call();
    const second = await (await call()).json();
    expect(second).toMatchObject({ debited: 0, refunded: 0, redebited: 0 });
    expect(await balance()).toBe(0);
  });

  it("drives the balance negative rather than skipping billing", async () => {
    await db.update(schema.teams).set({ creditBalance: 1 }).where(eq(schema.teams.id, TEAM));
    await seedRun("complete");
    await call();
    expect(await balance()).toBe(-99);
  });

  it("refunds a charged run that failed", async () => {
    const runId = await seedRun("running");
    await call(); // debit while running
    expect(await balance()).toBe(0);
    await db.execute(sql`UPDATE tracker.runs SET status = 'failed' WHERE id = ${runId}`);
    const res = await (await call()).json();
    expect(res.refunded).toBe(1);
    expect(await balance()).toBe(100);
  });

  it("never charges an uncharged failed run", async () => {
    await seedRun("failed");
    const res = await (await call()).json();
    expect(res).toMatchObject({ debited: 0, refunded: 0 });
    expect(await balance()).toBe(100);
  });

  it("re-debits a refunded run that geo revived and completed", async () => {
    const runId = await seedRun("running");
    await call(); // debit
    await db.execute(sql`UPDATE tracker.runs SET status = 'failed' WHERE id = ${runId}`);
    await call(); // refund
    expect(await balance()).toBe(100);
    await db.execute(sql`UPDATE tracker.runs SET status = 'complete' WHERE id = ${runId}`);
    const res = await (await call()).json();
    expect(res.redebited).toBe(1);
    expect(await balance()).toBe(0);
    // And it stays settled on the next pass.
    const final = await (await call()).json();
    expect(final).toMatchObject({ debited: 0, refunded: 0, redebited: 0 });
  });

  it("skips unpriceable runs (no promptsTotal) instead of guessing", async () => {
    await seedRun("complete", null);
    const res = await (await call()).json();
    expect(res).toMatchObject({ debited: 0, skipped: 1 });
    expect(await balance()).toBe(100);
  });

  it("never touches runs in non-team orgs (PCG)", async () => {
    await db.execute(sql`INSERT INTO tracker.orgs (id, name) VALUES ('org_pcg', 'PCG')`);
    await db.execute(sql`INSERT INTO tracker.clients (id, org_id, name) VALUES ('tc_pcg', 'org_pcg', 'PCG Client')`);
    await db.execute(sql`
      INSERT INTO tracker.runs (id, client_id, org_id, period, kind, status, prompts_total)
      VALUES ('tr_pcg_1', 'tc_pcg', 'org_pcg', '2026-07', 'scheduled', 'complete', 30)
    `);
    const res = await (await call()).json();
    expect(res.runs).toBe(0);
    const ledger = await db
      .select()
      .from(schema.creditTransactions)
      .where(eq(schema.creditTransactions.siteId, "tr_pcg_1"));
    expect(ledger).toEqual([]);
  });
});
