/**
 * ES-090 IT13b — In-flight pipeline + DELETE race (ChangedSpec per HP-198).
 *
 * Scenario: Start a long pipeline stage → trigger DELETE /api/account →
 * verify stage handler sees the tombstone and returns 200 (not 5xx / FK error).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, seedSite, closeDb, eq } from "./_setup";

beforeAll(() => { if (!process.env.NEXT_PUBLIC_APP_URL) process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; });
afterAll(async () => { await closeDb(); });

describe("ES-090 IT13b — In-flight pipeline handler tombstone behavior", () => {
  it("stage handler hit with site.pipeline_status='deleting' returns 200 skipped, no FK errors", async () => {
    const site = await seedSite({ withTeam: true, pipelineStatus: "deleting" });

    const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/pipeline/stage`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.CRON_SECRET ?? "test"}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ siteId: site.id, stage: "discover" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { skipped?: string };
    expect(body.skipped).toBe("site-deleting");
  }, 30_000);

  it("full DELETE /api/account run while a stage is mid-flight — no 5xx from stage, no FK violation", async () => {
    const site = await seedSite({ withTeam: true, pipelineStatus: "queued" });

    // Kick off DELETE + a stage POST at the same time.
    const [deleteRes, stageRes] = await Promise.all([
      fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/account`, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-test-actor-email": site.ownerEmail,
          cookie: "sb-access-token=test",
        },
        body: JSON.stringify({ confirmation: "DELETE_MY_ACCOUNT" }),
      }),
      fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/pipeline/stage`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.CRON_SECRET ?? "test"}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ siteId: site.id, stage: "discover" }),
      }),
    ]);

    // DELETE must succeed (200) or cleanly idempotent 404.
    expect([200, 404]).toContain(deleteRes.status);
    // Stage must NOT be 5xx — expect 200 (tombstone early-exit) or 401 (if site already gone).
    expect(stageRes.status).not.toBeGreaterThanOrEqual(500);
  }, 45_000);
});
