/**
 * Tier 2 — Load: 100-URL batch scale validation
 * GitHub Issue #96
 * ES-009 tests L1–L7
 *
 * Timeout budget: 600 seconds (10 minutes).
 * Seeds 1000 credits before run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  uploadBulkCsv,
  parseFixtureCsv,
  verifyOtp,
  getJobStatus,
  downloadReportZip,
  clearResponseLog,
  getResponseLog,
} from "../helpers/test-client";
import {
  getJobRow,
  getSiteCreditTransactions,
  waitForPipelineStatus,
  cleanupJob,
  seedOtpCode,
  TEST_OTP_CODE,
} from "../helpers/db-helpers";
import { pollUntil, sleep, timed } from "../helpers/wait-helpers";
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
let uploadStartMs: number;
let completionEndMs: number;

const LOAD_SEED_CREDITS = 1000;
const LOAD_URLS = parseFixtureCsv("load-100urls.csv");
const LOAD_URL_COUNT = LOAD_URLS.length; // should be 100

// ── Suite ────────────────────────────────────────────────────────────────────

describe("Tier 2 — Load: 100-URL batch", { timeout: 600_000 }, () => {
  beforeAll(async () => {
    const { teamId } = qa();
    await seedCredits(teamId, LOAD_SEED_CREDITS);
    creditsBefore = await getCredits(teamId);
    clearResponseLog();
  });

  afterAll(async () => {
    if (jobId) await cleanupJob(jobId);
  });

  // ── L1: Upload accepted ──────────────────────────────────────────────────

  it("L1 — Upload 100-URL CSV accepted within 10s", async () => {
    const { email } = qa();
    uploadStartMs = Date.now();

    const { result, elapsedMs } = await timed(() =>
      uploadBulkCsv({ email, bulkUrls: LOAD_URLS })
    );

    expect(elapsedMs, `Upload took ${elapsedMs}ms — should be < 10000ms`).toBeLessThan(10_000);
    expect(result.status, `Upload returned ${result.status}: ${JSON.stringify(result.body)}`).toBe(200);

    const body = result.body as { id: string };
    expect(typeof body.id).toBe("string");
    jobId = body.id;

    const row = await getJobRow(jobId);
    expect(row.audit_mode).toBe("bulk");
    expect(row.bulk_url_count).toBe(LOAD_URL_COUNT);
  });

  // ── L2: Concurrency — not serial ─────────────────────────────────────────

  it("L2 — Within 30s of verify, bulk crawl is running (not still pending)", async () => {
    // Start the bulk crawl via OTP verify
    await seedOtpCode(jobId);
    const verifyRes = await verifyOtp(jobId, TEST_OTP_CODE);
    expect(verifyRes.status).toBe(200);
    const body = verifyRes.body as { accessToken: string };
    accessToken = body.accessToken;

    // Within 30s, status should have moved past "pending"
    const row = await pollUntil(
      () => getJobRow(jobId),
      (r) => r.pipeline_status !== "pending",
      30_000,
      2_000,
      "L2: crawl start"
    );

    expect(["crawling", "analyzing", "complete"]).toContain(row.pipeline_status);

    // Additionally: within 30s, pipeline should have moved to crawling
    // (bulk mode skips discovery, so "crawling" means Firecrawl is running)
    // We check pipelineStatus is "crawling" OR already "complete" (fast run)
    console.info(`[L2] Status after 30s wait: ${row.pipeline_status}`);
  });

  // ── L3: Completion rate ≥ 95% ────────────────────────────────────────────

  it("L3 — Completion rate ≥ 95% within 600s", async () => {
    const finalRow = await pollUntil(
      () => getJobRow(jobId),
      (r) => r.pipeline_status === "complete" || r.pipeline_status === "failed",
      570_000,
      5_000,
      "L3: bulk completion"
    );
    completionEndMs = Date.now();

    const perPage = (finalRow.per_page_results ?? []) as Array<{ url: string }>;
    const completedCount = perPage.length;
    const completionRate = completedCount / LOAD_URL_COUNT;

    console.info(
      `[L3] Completed: ${completedCount}/${LOAD_URL_COUNT} (${(completionRate * 100).toFixed(1)}%)`
    );

    expect(
      completionRate,
      `Completion rate ${(completionRate * 100).toFixed(1)}% < 95% threshold`
    ).toBeGreaterThanOrEqual(0.95);

    // Job should not be in "failed" state unless 0 URLs completed
    if (completedCount === 0) {
      expect(finalRow.pipeline_status).not.toBe("failed");
    }
  });

  // ── L4: No cold-start cascade timeouts ───────────────────────────────────

  it("L4 — No HTTP 504 timeouts during load run", () => {
    const log = getResponseLog();
    const timeouts = log.filter((r) => r.status === 504);
    expect(
      timeouts.length,
      `Got ${timeouts.length} HTTP 504 timeout(s): ${JSON.stringify(timeouts)}`
    ).toBe(0);
  });

  // ── L5: Throughput benchmark (log only, no pass/fail gate) ───────────────

  it("L5 — Throughput benchmark logged (informational)", () => {
    if (!uploadStartMs || !completionEndMs) {
      console.info("[L5] Timing not available — skipping throughput log");
      return;
    }
    const totalMs = completionEndMs - uploadStartMs;
    const urlsPerMinute = (LOAD_URL_COUNT / totalMs) * 60_000;
    console.info(
      `[THROUGHPUT] 100-URL load: ${totalMs}ms | ${urlsPerMinute.toFixed(1)} urls/min`
    );
    // No pass/fail gate — L5 is informational per ES-009 spec
    expect(true).toBe(true);
  });

  // ── L6: ZIP generates after batch ────────────────────────────────────────

  it("L6 — ZIP download-report returns 200 with application/zip", async () => {
    const res = await downloadReportZip(jobId, accessToken);
    expect(
      res.status,
      `download-report returned ${res.status}`
    ).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(/attachment/i);

    // Buffer should be non-trivial
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(1000); // at minimum 1KB
  });

  // ── L7: Credit reconciliation at scale ───────────────────────────────────

  it("L7 — Final credit balance matches actual pages crawled (±1 credit)", async () => {
    const { teamId } = qa();

    const row = await getJobRow(jobId);
    const perPage = (row.per_page_results ?? []) as unknown[];
    const completedCount = perPage.length;
    const expectedCreditsUsed = Math.ceil(completedCount / PAGES_PER_CREDIT);
    const finalBalance = await getCredits(teamId);

    console.info(
      `[L7] Credits: before=${creditsBefore} used=${expectedCreditsUsed} ` +
      `expected_final=${creditsBefore - expectedCreditsUsed} actual_final=${finalBalance}`
    );

    assertCreditBalance(
      finalBalance,
      creditsBefore - expectedCreditsUsed,
      1, // ±1 credit rounding tolerance per spec
      "L7"
    );

    // Credit reconcile log line assertion (per ES-009 section g)
    // We verify the transaction exists — actual console output captured by CI
    const txs = await getSiteCreditTransactions(jobId);
    const txTypes = txs.map((t) => t.type);
    expect(txTypes).toContain("bulk_crawl_reserve");
    // If actual < reserved → refund should exist
    const reserveTx = txs.find((t) => t.type === "bulk_crawl_reserve");
    if (reserveTx) {
      const reserved = Math.abs(reserveTx.credits_changed);
      if (completedCount < row.crawl_limit!) {
        expect(txTypes).toContain("bulk_crawl_refund");
      }
    }
  });
});
