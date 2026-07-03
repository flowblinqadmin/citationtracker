/**
 * ES-090 IT14 — IP hash backfill parity.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, closeDb, eq } from "./_setup";
import { randomUUID } from "node:crypto";

beforeAll(() => {
  if (!process.env.IP_HASH_KEY) process.env.IP_HASH_KEY = "es090-it14-key";
});
afterAll(async () => { await closeDb(); });

describe("ES-090 IT14 — backfill --commit writes ip_hash + nulls ip", () => {
  it("inserts 10 logs pre-migration → backfill → ip_hash set, ip null", async () => {
    const { geoCrawlLogs } = await import("@/lib/db/schema");

    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = randomUUID();
      ids.push(id);
      await db.insert(geoCrawlLogs).values({
        id,
        siteId: "fake-site-it14",
        ip: `203.0.113.${i + 1}`,
        // ipHash intentionally absent — backfill must populate.
        userAgent: `it14-ua-${i}`,
        createdAt: new Date(),
      } as Record<string, unknown>);
    }

    const script = await import("@/scripts/backfill-ip-hash");
    type RunBackfill = (opts: { commit: boolean; batchSize?: number }) => Promise<{ scanned: number; updated: number }>;
    const result = await (script as { runBackfill: RunBackfill }).runBackfill({ commit: true, batchSize: 100 });

    expect(result.updated).toBeGreaterThanOrEqual(10);

    for (const id of ids) {
      const [row] = await db.select().from(geoCrawlLogs).where(eq(geoCrawlLogs.id, id));
      expect((row as Record<string, unknown>).ipHash).toBeTruthy();
      expect((row as Record<string, unknown>).ip).toBeNull();
    }
  }, 60_000);
});
