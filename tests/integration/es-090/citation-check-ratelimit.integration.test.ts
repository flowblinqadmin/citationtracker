/**
 * ES-090 IT4 — citation-check rate-limit under concurrency.
 *
 * Phase A (RED): 5 parallel POSTs to citation-check on the same siteId.
 * Spec: exactly 1 returns 200, 4 return 429, exactly 1 credit_transactions row.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { db, seedSite, cleanupSite, closeDb, eq } from "./_setup";
import { creditTransactions } from "@/lib/db/schema";

const created: string[] = [];

beforeAll(() => { if (!process.env.NEXT_PUBLIC_APP_URL) process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; });
afterEach(async () => {
  while (created.length) {
    const id = created.pop()!;
    try { await cleanupSite(id); } catch { /* ignore */ }
  }
});
afterAll(async () => { await closeDb(); });

describe("ES-090 IT4 — citation-check rate-limit under 5x parallel", () => {
  it("exactly 1 returns 200, 4 return 429, credit deducted exactly once", async () => {
    const site = await seedSite({ withTeam: true });
    created.push(site.id);

    // geoScorecard column required to pass the 422 gate at line 86.
    const { geoSites } = await import("@/lib/db/schema");
    await db.update(geoSites).set({ geoScorecard: { overallScore: 50 } } as Record<string, unknown>).where(eq(geoSites.id, site.id));

    const url = `${process.env.NEXT_PUBLIC_APP_URL}/api/sites/${site.id}/citation-check?token=${site.accessToken}`;
    const responses = await Promise.all(Array.from({ length: 5 }, () => fetch(url, { method: "POST" })));
    const statuses = responses.map((r) => r.status);
    const ok = statuses.filter((s) => s === 200).length;
    const tooMany = statuses.filter((s) => s === 429).length;
    expect(ok).toBe(1);
    expect(tooMany).toBe(4);

    const debits = await db.select().from(creditTransactions).where(eq(creditTransactions.teamId, site.teamId!));
    expect(debits.length).toBe(1);
  }, 30_000);
});
