/**
 * ES-090 IT13 — account deletion full sweep.
 *
 * Deletes owner; verifies cascade on geo_sites; anonymization on crawl logs;
 * audit-log row written; idempotency.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, seedSite, closeDb, eq } from "./_setup";

beforeAll(() => { if (!process.env.NEXT_PUBLIC_APP_URL) process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; });
afterAll(async () => { await closeDb(); });

describe("ES-090 IT13 — DELETE /api/account end-to-end", () => {
  it("cascades sites, anonymizes crawl logs, writes admin_audit_log, idempotent", async () => {
    const site = await seedSite({ withTeam: true });

    // Pretend the owner has a Supabase session — Phase A relies on a test
    // helper that accepts a Bearer token + email via header.
    const url = `${process.env.NEXT_PUBLIC_APP_URL}/api/account`;
    const headers = {
      "content-type": "application/json",
      "x-test-actor-email": site.ownerEmail,
      cookie: "sb-access-token=test",
    };
    const body = JSON.stringify({ confirmation: "DELETE_MY_ACCOUNT" });

    const r1 = await fetch(url, { method: "DELETE", headers, body });
    expect(r1.status).toBe(200);
    const j1 = await r1.json() as { ok: boolean };
    expect(j1.ok).toBe(true);

    // Cascade: geo_sites row gone.
    const { geoSites, adminAuditLog, geoCrawlLogs } = await import("@/lib/db/schema");
    const remaining = await db.select().from(geoSites).where(eq(geoSites.id, site.id));
    expect(remaining.length).toBe(0);

    // Anonymization: any crawl logs for this team have ip / ip_hash / user_agent null.
    const logs = await db.select().from(geoCrawlLogs).where(eq(geoCrawlLogs.teamId, site.teamId!));
    for (const l of logs) {
      expect((l as Record<string, unknown>).ip).toBeNull();
      expect((l as Record<string, unknown>).ipHash).toBeNull();
    }

    // Audit row.
    const audits = await db.select().from(adminAuditLog).where(eq(adminAuditLog.actorEmail, site.ownerEmail));
    expect(audits.some((a) => a.action === "account_deletion")).toBe(true);

    // Idempotent — second DELETE returns 404.
    const r2 = await fetch(url, { method: "DELETE", headers, body });
    expect(r2.status).toBe(404);
  }, 30_000);
});
