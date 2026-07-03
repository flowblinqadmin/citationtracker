/**
 * Free tier gate tests — T-1 through T-5.
 *
 * Tests the domain-scoped free tier: each domain gets 2 free pipeline runs
 * (run 1 = baseline, run 2 = post-optimization verification).
 *
 * T-1 validates the state machine submission step using a synthetic domain
 * (no actual pipeline run triggered).
 *
 * T-2 runs the full cycle on a REAL domain (TEST_FREE_TIER_DOMAIN):
 *   submit run1 → poll to complete → verifyAudit → poll run2 to complete.
 * T-2 can take up to 10 minutes (two full pipeline runs).
 *
 * T-3 verifies that a third submission on the same domain returns 402.
 * T-5 verifies that a different domain gets a fresh freeRunNumber=1.
 *
 * Required env vars:
 *   TEST_FREE_TIER_DOMAIN — a real, scrapeable URL distinct from TEST_AUDIT_DOMAIN
 *     (so free-tier tests don't collide with audit-flow.test.ts).
 *     Falls back to TEST_AUDIT_DOMAIN if not set (risk of 409 collision).
 *
 * All geoSite rows created during this suite are cleaned up by setup.ts teardown.
 *
 * Uses globalThis.__API_CLIENT_QA__ from setup.ts.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { nanoid } from "nanoid";
import { FlowblinqClient, FlowblinqApiError } from "@/lib/flowblinq-client";
import type { AuditResponse } from "@/lib/flowblinq-client";

// ─── Shared state ─────────────────────────────────────────────────────────────

let client: FlowblinqClient;
let freeTierDomain: string;

/** auditId for completed run1 — used in T-3 (re-submit same domain). */
let run1AuditId: string;
/** Resolved run1 result. */
let run1Completed: AuditResponse;
/** The 402 error caught in T-3, used by T-4. */
let tier402Error: FlowblinqApiError | null = null;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(() => {
  const qa = globalThis.__API_CLIENT_QA__;
  if (!qa) throw new Error("API_CLIENT_QA not initialised — check setup.ts");

  freeTierDomain =
    process.env.TEST_FREE_TIER_DOMAIN ??
    process.env.TEST_AUDIT_DOMAIN ??
    "https://example.com";

  client = new FlowblinqClient({
    clientId: qa.clientId,
    clientSecret: qa.clientSecret,
    baseUrl: qa.baseUrl,
  });
});

// ─── T-1: Initial submission ──────────────────────────────────────────────────

describe("Free tier: initial submission", () => {
  it(
    "T-1: new domain submission returns freeRunNumber=1 and freeTier=true",
    async () => {
      // Synthetic domain that passes SSRF check (not IP/localhost) but
      // won't run a real pipeline. We're testing the state machine step only.
      const fakeDomain = `https://api-test-t1-${nanoid(8)}.example.com`;
      const result = await client.submitAudit({ url: fakeDomain });

      expect(result.freeRunNumber).toBe(1);
      expect(result.freeTier).toBe(true);
      expect(typeof result.auditId).toBe("string");
      expect(result.auditId.length).toBeGreaterThan(0);
      expect(result.status).toBe("pending");
    }
  );
});

// ─── T-2 / T-3 / T-4: Full free tier cycle on real domain ────────────────────

describe("Free tier: full two-run cycle", () => {
  it(
    "T-2: run1 completes → verifyAudit freeRunNumber=2 → run2 completes",
    async () => {
      // Submit run1
      const run1Submit = await client.submitAudit({ url: freeTierDomain });
      run1AuditId = run1Submit.auditId;
      expect(run1Submit.freeRunNumber).toBe(1);
      console.log(`[T-2] run1 auditId=${run1AuditId} domain=${freeTierDomain}`);

      // Poll run1 to completion
      run1Completed = await client.pollAudit(run1AuditId, {
        timeoutMs: 300_000,
        intervalMs: 5_000,
        onProgress: (r) => console.log(`[T-2] run1 status=${r.status}`),
      });
      expect(run1Completed.status).toBe("complete");
      console.log(`[T-2] run1 complete. Triggering verifyAudit...`);

      // Trigger run2 (post-optimization verification)
      const run2Submit = await client.verifyAudit(run1AuditId);
      expect(run2Submit.freeRunNumber).toBe(2);
      expect(run2Submit.status).toBe("pending");
      console.log(`[T-2] run2 auditId=${run2Submit.auditId}`);

      // Poll run2 to completion (so T-3 can assert 402 on next submit)
      const run2Completed = await client.pollAudit(run2Submit.auditId, {
        timeoutMs: 300_000,
        intervalMs: 5_000,
        onProgress: (r) => console.log(`[T-2] run2 status=${r.status}`),
      });
      expect(run2Completed.status).toBe("complete");
      console.log("[T-2] run2 complete — domain is now free-tier-exhausted.");
    },
    600_000 // 10 min: covers two full pipeline runs
  );

  it(
    "T-3: submitting same domain after both runs → FlowblinqApiError status=402",
    async () => {
      let caught: unknown = null;

      try {
        await client.submitAudit({ url: freeTierDomain });
      } catch (err) {
        caught = err;
      }

      expect(caught).not.toBeNull();
      expect(caught).toBeInstanceOf(FlowblinqApiError);
      const apiErr = caught as FlowblinqApiError;
      expect(apiErr.status).toBe(402);

      // Store for T-4
      tier402Error = apiErr;
    }
  );

  it(
    "T-4: 402 error code indicates free tier exhaustion, or account reflects upgrade path",
    async () => {
      if (tier402Error) {
        // The error code should indicate free tier exhaustion
        expect(tier402Error.code).toMatch(/free_tier|insufficient_credits|tier/i);
      } else {
        // Fallback: verify the account response provides the upgrade URL
        const account = await client.getAccount();
        expect(account.creditsPurchaseUrl).toMatch(/flowblinq\.com/);
      }
    }
  );
});

// ─── T-5: Domain scoping ──────────────────────────────────────────────────────

describe("Free tier: domain scoping", () => {
  it(
    "T-5: different domain gets fresh freeRunNumber=1 (free tier is domain-scoped)",
    async () => {
      // A different fake domain — same client, but different domain → fresh free run
      const freshDomain = `https://api-test-t5-${nanoid(8)}.example.com`;
      const result = await client.submitAudit({ url: freshDomain });

      expect(result.freeRunNumber).toBe(1);
      expect(result.freeTier).toBe(true);
    }
  );
});
