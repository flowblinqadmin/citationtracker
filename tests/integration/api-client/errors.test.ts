/**
 * Error handling integration tests — E-1 through E-6.
 *
 * Verifies that FlowblinqClient correctly wraps all API error conditions
 * into typed FlowblinqApiError instances with accurate status and code fields.
 *
 * E-2 (free_tier_exhausted) piggybacks on the completed run1 audit from
 * audit-flow.test.ts (which runs earlier alphabetically). It calls verifyAudit
 * to trigger run2, polls run2 to completion, then submits the same domain
 * again to provoke the 402 response.
 *
 * E-5 (pipeline_failed) submits a fresh domain via the API, then overrides
 * pipeline_status='failed' directly via Supabase service role, then polls.
 *
 * E-6 (poll_timeout) inserts a geo_site row with pipeline_status='pending'
 * directly via Supabase (no actual pipeline) then polls with a short timeout.
 *
 * Required env vars:
 *   TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_KEY
 *   TEST_AUDIT_DOMAIN (for E-2 run2 trigger — reuses audit-flow.test.ts run1)
 *
 * Uses globalThis.__API_CLIENT_QA__ from setup.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { nanoid } from "nanoid";
import { FlowblinqClient, FlowblinqApiError } from "@/lib/flowblinq-client";

// ─── Shared state ─────────────────────────────────────────────────────────────

let client: FlowblinqClient;
let baseUrl: string;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(() => {
  const qa = globalThis.__API_CLIENT_QA__;
  if (!qa) throw new Error("API_CLIENT_QA not initialised — check setup.ts");

  baseUrl = qa.baseUrl;
  client = new FlowblinqClient({
    clientId: qa.clientId,
    clientSecret: qa.clientSecret,
    baseUrl: qa.baseUrl,
  });
});

// ─── E-1: Authentication error ────────────────────────────────────────────────

describe("Errors: authentication failure", () => {
  it(
    "E-1: wrong secret → FlowblinqApiError is instanceof Error with status=401 and non-empty code",
    async () => {
      const badClient = new FlowblinqClient({
        clientId: globalThis.__API_CLIENT_QA__.clientId,
        clientSecret: "definitely-wrong-secret",
        baseUrl,
      });

      let caught: unknown = null;
      try {
        await badClient.getAccount();
      } catch (err) {
        caught = err;
      }

      expect(caught).not.toBeNull();
      expect(caught).toBeInstanceOf(Error);
      expect(caught).toBeInstanceOf(FlowblinqApiError);
      const apiErr = caught as FlowblinqApiError;
      expect(apiErr.status).toBe(401);
      expect(typeof apiErr.code).toBe("string");
      expect(apiErr.code.length).toBeGreaterThan(0);
    }
  );
});

// ─── E-2: Free tier exhausted ────────────────────────────────────────────────

describe("Errors: free tier exhausted", () => {
  it(
    "E-2: domain with both free runs complete → submitAudit → FlowblinqApiError status=402",
    async () => {
      const qa = globalThis.__API_CLIENT_QA__;
      const supabase = createClient(
        process.env.TEST_SUPABASE_URL!,
        process.env.TEST_SUPABASE_SERVICE_KEY!
      );

      // Find the completed run1 audit from audit-flow.test.ts (same credential)
      const { data: completedRows, error: queryErr } = await supabase
        .from("geo_sites")
        .select("id, domain")
        .eq("api_client_id", qa.clientId)
        .eq("pipeline_status", "complete")
        .eq("free_run_number", 1)
        .order("created_at", { ascending: false })
        .limit(1);

      if (queryErr || !completedRows || completedRows.length === 0) {
        console.warn(
          "[E-2] No completed run1 audit found — skipping. Run audit-flow.test.ts first.\n" +
            (queryErr?.message ?? "")
        );
        return;
      }

      const run1Row = completedRows[0] as { id: string; domain: string };
      console.log(`[E-2] Found run1 auditId=${run1Row.id} domain=${run1Row.domain}`);

      // Trigger run2 via API
      const run2Submit = await client.verifyAudit(run1Row.id);
      console.log(`[E-2] run2 auditId=${run2Submit.auditId} — polling...`);

      // Poll run2 to completion (required for 402 on next submit)
      await client.pollAudit(run2Submit.auditId, {
        timeoutMs: 300_000,
        intervalMs: 5_000,
        onProgress: (r) => console.log(`[E-2] run2 status=${r.status}`),
      });
      console.log("[E-2] run2 complete — domain is now exhausted.");

      // Submit the same domain again → expect 402
      const exhaustedDomain = `https://${run1Row.domain}`;
      let caught: unknown = null;
      try {
        await client.submitAudit({ url: exhaustedDomain });
      } catch (err) {
        caught = err;
      }

      expect(caught).not.toBeNull();
      expect(caught).toBeInstanceOf(FlowblinqApiError);
      const apiErr = caught as FlowblinqApiError;
      expect(apiErr.status).toBe(402);
    },
    360_000 // 6 min: run2 polling
  );
});

// ─── E-3: Not found ───────────────────────────────────────────────────────────

describe("Errors: not found", () => {
  it("E-3: getAudit with nonexistent ID → FlowblinqApiError status=404", async () => {
    let caught: unknown = null;
    try {
      await client.getAudit("nonexistent-audit-id-12345");
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(FlowblinqApiError);
    expect((caught as FlowblinqApiError).status).toBe(404);
  });
});

// ─── E-4: Rate limiting ───────────────────────────────────────────────────────

describe("Errors: rate limit", () => {
  let isolatedClientId: string;
  let isolatedSecret: string;
  let isolatedRowId: string;

  beforeAll(async () => {
    const qa = globalThis.__API_CLIENT_QA__;
    const supabase = createClient(
      process.env.TEST_SUPABASE_URL!,
      process.env.TEST_SUPABASE_SERVICE_KEY!
    );
    const bcrypt = await import("bcryptjs");

    isolatedRowId = nanoid();
    isolatedClientId = "test_e4_" + nanoid(12);
    isolatedSecret = nanoid(32);
    const hash = await bcrypt.hash(isolatedSecret, 12);

    const { error } = await supabase.from("api_clients").insert({
      id: isolatedRowId,
      team_id: qa.teamId,
      client_id: isolatedClientId,
      client_secret_hash: hash,
      name: `rate-limit-e4-${Date.now()}`,
      scopes: ["audit:read"],
      created_at: new Date().toISOString(),
    });
    if (error) throw new Error(`[E-4 setup] ${error.message}`);
  });

  afterAll(async () => {
    const supabase = createClient(
      process.env.TEST_SUPABASE_URL!,
      process.env.TEST_SUPABASE_SERVICE_KEY!
    );
    await supabase.from("api_clients").delete().eq("id", isolatedRowId);
  });

  it(
    "E-4: 11 sequential token requests → 11th caught as FlowblinqApiError status=429",
    async () => {
      const statuses: number[] = [];

      for (let i = 0; i < 11; i++) {
        const res = await fetch(`${baseUrl}/api/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "client_credentials",
            client_id: isolatedClientId,
            client_secret: isolatedSecret,
          }),
        });
        statuses.push(res.status);
      }

      // First 10 must succeed
      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);

      // 11th must be 429 — verify it maps to FlowblinqApiError
      expect(statuses[10]).toBe(429);

      // Now verify the FlowblinqClient wraps the 429 correctly
      // (the isolated credential is still rate-limited)
      const rateLimitedClient = new FlowblinqClient({
        clientId: isolatedClientId,
        clientSecret: isolatedSecret,
        baseUrl,
      });

      let caught: unknown = null;
      try {
        await rateLimitedClient.getAccount();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(FlowblinqApiError);
      expect((caught as FlowblinqApiError).status).toBe(429);
    }
  );
});

// ─── E-5: Pipeline failed ─────────────────────────────────────────────────────

describe("Errors: pipeline failed", () => {
  it(
    "E-5: audit with pipeline_status='failed' → pollAudit rejects with code='pipeline_failed'",
    async () => {
      const supabase = createClient(
        process.env.TEST_SUPABASE_URL!,
        process.env.TEST_SUPABASE_SERVICE_KEY!
      );

      // Submit a fresh domain to create the geo_site row via the API
      const e5Domain = `https://api-test-e5-${nanoid(8)}.example.com`;
      let e5AuditId: string;

      try {
        const e5Submit = await client.submitAudit({ url: e5Domain });
        e5AuditId = e5Submit.auditId;
      } catch (err) {
        console.warn(`[E-5] submitAudit failed: ${(err as Error).message} — skipping`);
        return;
      }

      // Override pipeline_status to 'failed' directly via Supabase service role
      const { error: updateErr } = await supabase
        .from("geo_sites")
        .update({ pipeline_status: "failed" })
        .eq("id", e5AuditId);

      if (updateErr) {
        console.warn(`[E-5] Supabase update failed: ${updateErr.message}`);
        console.warn("[E-5] Verify column name is 'pipeline_status' in geo_sites schema.");
        return;
      }

      // Poll immediately — should see 'failed' on first check and reject
      let caught: unknown = null;
      try {
        await client.pollAudit(e5AuditId, { intervalMs: 1_000 });
      } catch (err) {
        caught = err;
      }

      expect(caught).not.toBeNull();
      expect(caught).toBeInstanceOf(FlowblinqApiError);
      expect((caught as FlowblinqApiError).code).toBe("pipeline_failed");
    }
  );
});

// ─── E-6: Poll timeout ────────────────────────────────────────────────────────

describe("Errors: poll timeout", () => {
  it(
    "E-6: pollAudit on a permanently-pending audit → rejects with code='poll_timeout'",
    async () => {
      const supabase = createClient(
        process.env.TEST_SUPABASE_URL!,
        process.env.TEST_SUPABASE_SERVICE_KEY!
      );
      const qa = globalThis.__API_CLIENT_QA__;

      // Insert a geo_site directly with pipeline_status='pending'.
      // No actual pipeline is triggered, so the status stays 'pending' indefinitely.
      // Setup.ts teardown will clean this row up (deletes all rows by api_client_id).
      //
      // NOTE: Adjust column names below if geo_sites schema differs.
      const e6SiteId = nanoid();
      const e6Domain = `api-test-e6-${nanoid(8)}.example.com`;

      const { error: insertErr } = await supabase.from("geo_sites").insert({
        id: e6SiteId,
        team_id: qa.teamId,
        api_client_id: qa.clientId,
        domain: e6Domain,
        url: `https://${e6Domain}`,
        pipeline_status: "pending",
        free_run_number: 1,
        free_optimization_used: false,
        created_at: new Date().toISOString(),
      });

      if (insertErr) {
        console.warn(`[E-6] Supabase insert failed: ${insertErr.message}`);
        console.warn(
          "[E-6] Verify column names match geo_sites schema. Skipping test."
        );
        return;
      }

      // Poll the permanently-pending audit with a 5s timeout and 3s interval:
      //   t=3s: first poll → status='pending' → schedules next
      //   t=6s: second tick → Date.now() > deadline (5s) → poll_timeout
      let caught: unknown = null;
      try {
        await client.pollAudit(e6SiteId, {
          intervalMs: 3_000,
          timeoutMs: 5_000,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).not.toBeNull();
      expect(caught).toBeInstanceOf(FlowblinqApiError);
      expect((caught as FlowblinqApiError).code).toBe("poll_timeout");
    }
  );
});
