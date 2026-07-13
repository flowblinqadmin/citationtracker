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
  CREDITS_PER_PROMPT_MODEL,
  PLATFORM_CREDITS,
  CREDIT_USD,
  citationRunCredits,
  debitForRun,
  refundForRun,
  redebitForRun,
} from "@/lib/credits";
import type { TrackerPlatform } from "@/lib/types/tracker";
import { db } from "@/lib/db";
import { teams, creditTransactions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

describe("citationRunCredits", () => {
  it("prices each base model at 2 credits per prompt and Claude at 4", () => {
    expect(citationRunCredits(1, ["openai"])).toBe(2);
    expect(citationRunCredits(1, ["perplexity"])).toBe(2);
    expect(citationRunCredits(1, ["google"])).toBe(2);
    expect(citationRunCredits(1, ["anthropic"])).toBe(4);
  });

  it("prices a full 4-model run at 10 credits per prompt (2+2+2+4)", () => {
    expect(citationRunCredits(1)).toBe(10); // default = all four models
    expect(citationRunCredits(15)).toBe(150);
    expect(citationRunCredits(30)).toBe(300);
  });

  it("sums the selected platforms' per-model prices", () => {
    expect(citationRunCredits(2, ["openai", "anthropic"])).toBe(12); // 2 × (2 + 4)
    expect(citationRunCredits(10, ["anthropic"])).toBe(40);
  });

  it("keeps EACH model's per-prompt price ≥ that model's cost × margin", () => {
    for (const platform of Object.keys(PLATFORM_CREDITS) as TrackerPlatform[]) {
      const costUsd = MODEL_COST_ESTIMATES[platform] * CITATION_EXEC_MARGIN;
      expect(PLATFORM_CREDITS[platform] * CREDIT_USD).toBeGreaterThanOrEqual(costUsd);
    }
  });

  it("keeps the flat base scalar at 2 (still multiplied by other callers)", () => {
    expect(CREDITS_PER_PROMPT_MODEL).toBe(2);
  });

  it("rejects non-positive or non-integer prompt counts", () => {
    expect(() => citationRunCredits(0)).toThrow();
    expect(() => citationRunCredits(-1)).toThrow();
    expect(() => citationRunCredits(1.5)).toThrow();
  });

  it("rejects an empty, oversized, duplicate, or unknown platform list", () => {
    expect(() => citationRunCredits(1, [])).toThrow();
    expect(() => citationRunCredits(1, ["openai", "openai"])).toThrow();
    expect(() =>
      citationRunCredits(1, ["openai", "perplexity", "google", "anthropic", "openai"]),
    ).toThrow();
    expect(() => citationRunCredits(1, ["bing" as TrackerPlatform])).toThrow();
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
