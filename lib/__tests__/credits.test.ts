// Pricing calculator + ledger idempotency.
//
// Calculator tests are pure. Ledger tests need Postgres — they run when
// TEST_DATABASE_URL points at a database with the shared schema applied
// (local Supabase: postgresql://postgres:postgres@127.0.0.1:54322/postgres)
// and skip otherwise. The Docker suite runs them via docker-compose services.
import { describe, it, expect, beforeEach } from "vitest";
import {
  MODEL_COST_ESTIMATES,
  CITATION_EXEC_MARGIN,
  CITATION_EXEC_PRICE_USD,
  CREDIT_USD,
  citationRunCredits,
  debitForRun,
  refundForRun,
  redebitForRun,
} from "@/lib/credits";
import { db } from "@/lib/db";
import { teams, creditTransactions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

describe("citationRunCredits", () => {
  it("prices a prompt-execution at the most expensive model × margin", () => {
    const maxCost = Math.max(...Object.values(MODEL_COST_ESTIMATES));
    expect(CITATION_EXEC_PRICE_USD).toBeCloseTo(maxCost * CITATION_EXEC_MARGIN, 10);
  });

  it("charges 30 prompts × 3 platforms at the flat rate, ceiled", () => {
    // 30 × 3 × $0.013 = $1.17 → 12 credits at $0.10/credit
    expect(citationRunCredits(30)).toBe(12);
  });

  it("floors at 1 credit", () => {
    expect(citationRunCredits(1)).toBe(1);
  });

  it("ceils fractional credits (never rounds down)", () => {
    for (const n of [1, 3, 7, 13, 30]) {
      const exact = (n * 3 * CITATION_EXEC_PRICE_USD) / CREDIT_USD;
      expect(citationRunCredits(n)).toBeGreaterThanOrEqual(exact);
    }
  });

  it("guarantees price ≥ cost × 1.3 for every model", () => {
    for (const cost of Object.values(MODEL_COST_ESTIMATES)) {
      expect(CITATION_EXEC_PRICE_USD).toBeGreaterThanOrEqual(cost * 1.3 - 1e-12);
    }
  });

  it("rejects non-positive prompt counts", () => {
    expect(() => citationRunCredits(0)).toThrow();
    expect(() => citationRunCredits(-1)).toThrow();
  });
});

// ── DB-backed ledger tests ──────────────────────────────────────────────────
const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)("ledger (Postgres)", () => {
  const TEAM = "team_credits_test";
  let runSeq = 0;
  const newRunId = () => `tr_test_${Date.now()}_${runSeq++}`;

  beforeEach(async () => {
    await db.delete(creditTransactions).where(eq(creditTransactions.teamId, TEAM));
    await db.delete(teams).where(eq(teams.id, TEAM));
    await db.insert(teams).values({
      id: TEAM, name: "Credits Test", ownerUserId: "u_test", creditBalance: 20,
    });
  });

  async function balance(): Promise<number> {
    const [t] = await db.select({ b: teams.creditBalance }).from(teams).where(eq(teams.id, TEAM));
    return t.b;
  }

  async function ledgerRows(runId: string) {
    return db.select().from(creditTransactions).where(eq(creditTransactions.siteId, runId));
  }

  it("debits exactly once and writes one ledger row", async () => {
    const runId = newRunId();
    const r = await debitForRun(TEAM, runId, 12);
    expect(r.applied).toBe(true);
    expect(await balance()).toBe(8);
    const rows = await ledgerRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].creditsChanged).toBe(-12);
    expect(rows[0].type).toBe("citation_run");
  });

  it("is idempotent — a second debit for the same run is a no-op", async () => {
    const runId = newRunId();
    await debitForRun(TEAM, runId, 12);
    const second = await debitForRun(TEAM, runId, 12);
    expect(second.applied).toBe(false);
    expect(second.reason).toBe("already_applied");
    expect(await balance()).toBe(8);
    expect(await ledgerRows(runId)).toHaveLength(1);
  });

  it("survives concurrent duplicate debits — one wins", async () => {
    const runId = newRunId();
    const results = await Promise.all([
      debitForRun(TEAM, runId, 12),
      debitForRun(TEAM, runId, 12),
      debitForRun(TEAM, runId, 12),
    ]);
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(await balance()).toBe(8);
    expect(await ledgerRows(runId)).toHaveLength(1);
  });

  it("rejects insufficient balance with no side effects", async () => {
    const runId = newRunId();
    const r = await debitForRun(TEAM, runId, 25);
    expect(r.applied).toBe(false);
    expect(r.reason).toBe("insufficient_credits");
    expect(r.balance).toBe(20);
    expect(await balance()).toBe(20);
    expect(await ledgerRows(runId)).toHaveLength(0);
  });

  it("allows post-hoc debit to drive the balance negative when forced", async () => {
    const runId = newRunId();
    const r = await debitForRun(TEAM, runId, 25, { allowNegative: true });
    expect(r.applied).toBe(true);
    expect(await balance()).toBe(-5);
  });

  it("refunds exactly once under concurrency", async () => {
    const runId = newRunId();
    await debitForRun(TEAM, runId, 12);
    const results = await Promise.all([
      refundForRun(TEAM, runId, 12),
      refundForRun(TEAM, runId, 12),
    ]);
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(await balance()).toBe(20);
    expect(await ledgerRows(runId)).toHaveLength(2); // debit + one refund
  });

  it("re-debits a refunded run exactly once (revival path)", async () => {
    const runId = newRunId();
    await debitForRun(TEAM, runId, 12);
    await refundForRun(TEAM, runId, 12);
    const results = await Promise.all([
      redebitForRun(TEAM, runId, 12),
      redebitForRun(TEAM, runId, 12),
    ]);
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(await balance()).toBe(8);
    expect(await ledgerRows(runId)).toHaveLength(3);
  });
});
