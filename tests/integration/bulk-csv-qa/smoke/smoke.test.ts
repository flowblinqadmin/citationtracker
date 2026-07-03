/**
 * Tier 1 — Smoke: 5-URL end-to-end correctness
 * GitHub Issue #95
 * ES-009 tests S1–S7
 *
 * ROUTE NOTE: ES-009 spec references /api/bulk-audit/* routes.
 * Actual implementation (ES-005) uses /api/sites/* with bulkUrls param.
 * All tests below use the actual routes. See test-client.ts for mapping.
 *
 * Timeout budget: 120 seconds.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  uploadBulkCsv,
  parseFixtureCsv,
  verifyOtp,
  getJobStatus,
  clearResponseLog,
  getResponseLog,
} from "../helpers/test-client";
import {
  getJobRow,
  getSiteCreditTransactions,
  cleanupJob,
  seedOtpCode,
  TEST_OTP_CODE,
} from "../helpers/db-helpers";
import { pollUntil, timed } from "../helpers/wait-helpers";
import { getCredits, seedCredits, assertCreditBalance } from "../helpers/credit-helpers";
import { PAGES_PER_CREDIT } from "../../../../lib/config";

// ── Test context ─────────────────────────────────────────────────────────────

const qa = () => (globalThis as Record<string, unknown>).__BULK_QA__ as {
  teamId: string;
  email: string;
  seedAmount: number;
};

let jobId: string;
let accessToken: string;
let creditsBefore: number;
let uploadElapsedMs: number;
let completionElapsedMs: number;

const SMOKE_URLS = parseFixtureCsv("smoke-5urls.csv");
const SMOKE_URL_COUNT = 5;

// ── Suite ────────────────────────────────────────────────────────────────────

describe("Tier 1 — Smoke: 5-URL end-to-end", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    const { teamId, email, seedAmount } = qa();
    await seedCredits(teamId, seedAmount);
    creditsBefore = await getCredits(teamId);
    clearResponseLog();
  });

  afterAll(async () => {
    if (jobId) await cleanupJob(jobId);
  });

  // ── S1: Upload ───────────────────────────────────────────────────────────

  it("S1 — Upload valid 5-URL CSV returns 200 with siteId", async () => {
    const { email } = qa();
    const { result, elapsedMs } = await timed(() =>
      uploadBulkCsv({ email, bulkUrls: SMOKE_URLS })
    );
    uploadElapsedMs = elapsedMs;

    expect(result.status, `Upload returned ${result.status}: ${JSON.stringify(result.body)}`).toBe(200);
    const body = result.body as { id: string };
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
    jobId = body.id;

    // Verify DB row created
    const row = await getJobRow(jobId);
    expect(row.audit_mode).toBe("bulk");
    expect(row.bulk_url_count).toBe(SMOKE_URL_COUNT);
    expect(row.pipeline_status).toBe("pending");
    expect(row.email_verified).toBe(false);
  });

  // ── S2: Pipeline fan-out (not serial) ────────────────────────────────────

  it("S2 — Pipeline fan-out: crawl begins within 10s of OTP verify", async () => {
    // Seed OTP + verify to start the crawl
    await seedOtpCode(jobId);
    const verifyRes = await verifyOtp(jobId, TEST_OTP_CODE);
    expect(verifyRes.status, `Verify returned ${verifyRes.status}: ${JSON.stringify(verifyRes.body)}`).toBe(200);

    const body = verifyRes.body as { accessToken: string };
    accessToken = body.accessToken;
    expect(typeof accessToken).toBe("string");

    // Wait up to 10s for pipelineStatus to leave "pending"
    const row = await pollUntil(
      () => getJobRow(jobId),
      (r) => r.pipeline_status !== "pending",
      10_000,
      1_000,
      "S2: pipeline start"
    );

    // Status should be "crawling" (bulk skips discovery)
    expect(["crawling", "analyzing", "complete"]).toContain(row.pipeline_status);
  });

  // ── S3: All URLs reach completed ─────────────────────────────────────────

  it("S3 — All 5 URLs reach completed within 120s", async () => {
    const { result: finalRow, elapsedMs } = await timed(() =>
      pollUntil(
        () => getJobRow(jobId),
        (r) => r.pipeline_status === "complete" || r.pipeline_status === "failed",
        115_000,
        3_000,
        "S3: completion"
      )
    );
    completionElapsedMs = elapsedMs;

    expect(
      finalRow.pipeline_status,
      `Pipeline ended in unexpected state: ${finalRow.pipeline_status}. Error: ${finalRow.pipeline_error}`
    ).toBe("complete");

    console.info(
      `[THROUGHPUT] 5-URL smoke: ${completionElapsedMs}ms | ` +
      `${((SMOKE_URL_COUNT / completionElapsedMs) * 60_000).toFixed(1)} urls/min`
    );
  });

  // ── S4: Audit output per URL present ─────────────────────────────────────

  it("S4 — Per-page results present in DB for completed job", async () => {
    const row = await getJobRow(jobId);
    expect(row.pipeline_status).toBe("complete");

    const perPage = (row.per_page_results ?? []) as Array<{ url: string; vulnerabilities: unknown[] }>;
    expect(perPage.length).toBeGreaterThan(0);

    // Each result must have url and vulnerabilities array
    for (const result of perPage) {
      expect(typeof result.url).toBe("string");
      expect(result.url.startsWith("https://")).toBe(true);
      expect(Array.isArray(result.vulnerabilities)).toBe(true);
    }
  });

  // ── S5: No Vercel function timeouts ──────────────────────────────────────

  it("S5 — No HTTP 504 timeouts during smoke run", () => {
    const log = getResponseLog();
    const timeouts = log.filter((r) => r.status === 504);
    expect(
      timeouts.length,
      `Got ${timeouts.length} HTTP 504 timeout(s): ${JSON.stringify(timeouts)}`
    ).toBe(0);
  });

  // ── S6: Credit reserve → reconcile ───────────────────────────────────────

  it("S6 — Credit reserve and reconcile transactions recorded", async () => {
    const { teamId } = qa();

    // Check reserve transaction
    const reserveTxs = await getSiteCreditTransactions(jobId, "bulk_crawl_reserve");
    expect(reserveTxs.length, "Expected exactly one bulk_crawl_reserve transaction").toBe(1);
    const reserveTx = reserveTxs[0];
    expect(reserveTx.credits_changed).toBeLessThan(0); // credits reduced

    // Check reconciliation: either bulk_crawl_refund (if < reserved) or nothing
    const allTxs = await getSiteCreditTransactions(jobId);
    const txTypes = allTxs.map((t) => t.type);
    expect(txTypes).toContain("bulk_crawl_reserve");

    // Final balance: should be creditsBefore minus actual pages used / PAGES_PER_CREDIT
    const row = await getJobRow(jobId);
    const perPageResults = (row.per_page_results ?? []) as unknown[];
    const actualPagesUsed = perPageResults.length;
    const expectedCreditsUsed = Math.ceil(actualPagesUsed / PAGES_PER_CREDIT);
    const finalBalance = await getCredits(teamId);

    assertCreditBalance(
      finalBalance,
      creditsBefore - expectedCreditsUsed,
      1, // ±1 credit rounding tolerance
      "S6"
    );
  });

  // ── S7: Job overall status = completed ───────────────────────────────────

  it("S7 — GET /api/sites/[id]?token returns status=complete", async () => {
    const res = await getJobStatus(jobId, accessToken);
    expect(res.status).toBe(200);
    const body = res.body as { pipelineStatus: string };
    expect(body.pipelineStatus).toBe("complete");
  });
});
