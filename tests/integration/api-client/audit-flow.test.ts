/**
 * Full audit flow tests — F-1 through F-7.
 *
 * Submits a real audit against TEST_AUDIT_DOMAIN, polls until complete,
 * and validates the complete result shape including files and account.
 *
 * F-3 (pollAudit completion) is the long test — up to 5 min.
 * It includes one retry on TEST_AUDIT_DOMAIN_FALLBACK if the primary
 * pipeline run fails.
 *
 * Required env vars:
 *   TEST_AUDIT_DOMAIN — real, scrapeable URL (e.g. https://example.com)
 * Optional:
 *   TEST_AUDIT_DOMAIN_FALLBACK — used if the first pipeline attempt fails
 *
 * Uses globalThis.__API_CLIENT_QA__ from setup.ts.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { FlowblinqClient } from "@/lib/flowblinq-client";
import type { AuditResponse } from "@/lib/flowblinq-client";

// ─── Shared state ─────────────────────────────────────────────────────────────

let client: FlowblinqClient;
let teamId: string;
let auditDomain: string;

/** Set by F-1, consumed by F-2 through F-6. */
let auditId: string;
/** Set by F-3, consumed by F-4 through F-6. */
let completedAudit: AuditResponse;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(() => {
  const qa = globalThis.__API_CLIENT_QA__;
  if (!qa) throw new Error("API_CLIENT_QA not initialised — check setup.ts");

  teamId = qa.teamId;
  auditDomain = process.env.TEST_AUDIT_DOMAIN ?? "https://example.com";

  client = new FlowblinqClient({
    clientId: qa.clientId,
    clientSecret: qa.clientSecret,
    baseUrl: qa.baseUrl,
  });
});

// ─── F-1 / F-2: Submit ────────────────────────────────────────────────────────

describe("Audit flow: submit", () => {
  it("F-1: submitAudit returns auditId and status='pending'", async () => {
    const result = await client.submitAudit({ url: auditDomain });

    expect(typeof result.auditId).toBe("string");
    expect(result.auditId.length).toBeGreaterThan(0);
    expect(result.status).toBe("pending");
    expect(typeof result.estimatedCompletionSeconds).toBe("number");
    expect(result.estimatedCompletionSeconds).toBeGreaterThan(0);

    auditId = result.auditId;
    console.log(`[F-1] auditId=${auditId} domain=${auditDomain}`);
  });

  it("F-2: immediately getAudit returns pending or running (not complete)", async () => {
    const audit = await client.getAudit(auditId);
    expect(["pending", "running"]).toContain(audit.status);
  });
});

// ─── F-3: Poll to completion ──────────────────────────────────────────────────

describe("Audit flow: poll to completion", () => {
  it(
    "F-3: pollAudit resolves with status='complete' within 7 minutes",
    async () => {
      const startMs = Date.now();

      const tryPoll = async (id: string): Promise<AuditResponse> => {
        return client.pollAudit(id, {
          timeoutMs: 420_000,
          intervalMs: 5_000,
          onProgress: (r) => {
            const elapsed = Math.round((Date.now() - startMs) / 1000);
            console.log(`[F-3] t+${elapsed}s auditId=${id} status=${r.status}`);
          },
        });
      };

      try {
        completedAudit = await tryPoll(auditId);
      } catch (firstErr) {
        console.warn(
          "[F-3] First poll failed — retrying on fallback domain:",
          (firstErr as Error).message
        );
        const fallbackDomain =
          process.env.TEST_AUDIT_DOMAIN_FALLBACK ??
          process.env.TEST_AUDIT_DOMAIN ??
          "https://example.com";
        const retry = await client.submitAudit({ url: fallbackDomain });
        console.log(`[F-3] Retry auditId=${retry.auditId} domain=${fallbackDomain}`);
        completedAudit = await tryPoll(retry.auditId);
        auditId = retry.auditId;
      }

      const elapsed = Math.round((Date.now() - startMs) / 1000);
      console.log(`[F-3] Completed in ${elapsed}s. overallScore=${completedAudit.overallScore}`);

      expect(completedAudit.status).toBe("complete");
    },
    420_000 // Per-test timeout: 7 min (pipeline can run 5-6 min on large sites)
  );
});

// ─── F-4 / F-5 / F-6: Validate result ────────────────────────────────────────

describe("Audit flow: validate completed result", () => {
  it("F-4: overallScore is 0–100 and scorecard.pillars is non-empty", () => {
    expect(completedAudit.overallScore).not.toBeNull();
    expect(completedAudit.overallScore!).toBeGreaterThanOrEqual(0);
    expect(completedAudit.overallScore!).toBeLessThanOrEqual(100);

    expect(Array.isArray(completedAudit.scorecard?.pillars)).toBe(true);
    expect(completedAudit.scorecard!.pillars.length).toBeGreaterThan(0);

    // Each pillar has the expected shape
    for (const pillar of completedAudit.scorecard!.pillars) {
      expect(typeof pillar.pillar).toBe("string");
      expect(typeof pillar.score).toBe("number");
    }
  });

  it("F-5: files.llmsTxtUrl is a non-null https:// URL", () => {
    expect(completedAudit.files.llmsTxtUrl).not.toBeNull();
    expect(completedAudit.files.llmsTxtUrl!.startsWith("https://")).toBe(true);
  });

  it("F-6: fetching llmsTxtUrl returns 200 with valid llms.txt content", async () => {
    const url = completedAudit.files.llmsTxtUrl!;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("# "); // All valid llms.txt files start with a # heading
  });
});

// ─── F-7: Account ─────────────────────────────────────────────────────────────

describe("Audit flow: account verification", () => {
  it("F-7: getAccount returns matching teamId and non-negative creditBalance", async () => {
    const account = await client.getAccount();

    expect(account.teamId).toBe(teamId);
    expect(typeof account.creditBalance).toBe("number");
    expect(account.creditBalance).toBeGreaterThanOrEqual(0);
    expect(typeof account.creditsPurchaseUrl).toBe("string");
    expect(account.creditsPurchaseUrl.length).toBeGreaterThan(0);
  });
});
