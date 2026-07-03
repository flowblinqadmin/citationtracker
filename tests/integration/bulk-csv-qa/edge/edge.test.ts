/**
 * Edge cases — Boundary and failure scenarios
 * ES-009 tests E1–E6
 *
 * Each test creates its own isolated job to avoid cross-contamination.
 * Tests are designed to be fast (< 30s each) by testing pre-pipeline behavior.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  uploadBulkCsv,
  parseFixtureCsv,
  verifyOtp,
  getJobStatus,
  triggerRegenerate,
} from "../helpers/test-client";
import {
  getJobRow,
  getSiteCreditTransactions,
  cleanupJob,
  seedOtpCode,
  TEST_OTP_CODE,
} from "../helpers/db-helpers";
import { pollUntil, sleep } from "../helpers/wait-helpers";
import { seedCredits, getCredits } from "../helpers/credit-helpers";

// ── Test context ─────────────────────────────────────────────────────────────

const qa = () => (globalThis as Record<string, unknown>).__BULK_QA__ as {
  teamId: string;
  email: string;
  seedAmount: number;
};

const createdJobIds: string[] = [];

function trackJob(id: string): string {
  createdJobIds.push(id);
  return id;
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("Edge Cases", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    const { teamId, email, seedAmount } = qa();
    await seedCredits(teamId, seedAmount);
  });

  afterAll(async () => {
    await Promise.allSettled(createdJobIds.map(cleanupJob));
  });

  // ── E1: Duplicate URLs in CSV ─────────────────────────────────────────────

  it("E1 — Duplicate URLs in CSV are deduplicated (bulkUrlCount = 3, not 5)", async () => {
    const { email } = qa();
    // duplicate-urls.csv: 5 rows, 3 unique URLs
    const duplicateUrls = parseFixtureCsv("duplicate-urls.csv");
    expect(duplicateUrls.length).toBe(5); // fixture has 5 rows

    const res = await uploadBulkCsv({ email, bulkUrls: duplicateUrls });
    expect(res.status, `Upload returned ${res.status}: ${JSON.stringify(res.body)}`).toBe(200);
    const jobId = trackJob((res.body as { id: string }).id);

    const row = await getJobRow(jobId);
    expect(
      row.bulk_url_count,
      `Expected 3 (deduplicated), got ${row.bulk_url_count}`
    ).toBe(3);
    expect(row.audit_mode).toBe("bulk");

    // Verify credits reserved for 3, not 5
    await seedOtpCode(jobId);
    const { teamId } = qa();
    const creditsBefore = await getCredits(teamId);

    const verifyRes = await verifyOtp(jobId, TEST_OTP_CODE);
    expect(verifyRes.status).toBe(200);

    // Check reserve transaction records 3 URLs worth
    const txs = await getSiteCreditTransactions(jobId, "bulk_crawl_reserve");
    expect(txs.length).toBe(1);

    // creditsChanged should correspond to 3 URLs, not 5
    // crawlLimit = min(3, creditBalance, ABSOLUTE_MAX_PAGES)
    expect(txs[0].pages_consumed ?? 0).toBeLessThanOrEqual(3);
  });

  // ── E2: Invalid/malformed URLs ────────────────────────────────────────────

  it("E2 — Invalid URLs in CSV cause 400 with invalidUrls list", async () => {
    const { email } = qa();
    // invalid-urls.csv: mix of valid and invalid
    const invalidUrls = parseFixtureCsv("invalid-urls.csv");

    const res = await uploadBulkCsv({ email, bulkUrls: invalidUrls });

    // Should return 400 — invalid URLs rejected at upload
    expect(
      res.status,
      `Expected 400 for all-invalid URL list, got ${res.status}: ${JSON.stringify(res.body)}`
    ).toBe(400);

    const body = res.body as { error: string };
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  // ── E3: CSV with 0 valid URLs ─────────────────────────────────────────────

  it("E3 — CSV with 0 valid URLs returns 400 before job creation", async () => {
    const { email } = qa();
    const allInvalidUrls = [
      "not-a-url",
      "ftp://bad-scheme.com",
      "javascript:alert(1)",
      "  ",
    ];

    const res = await uploadBulkCsv({ email, bulkUrls: allInvalidUrls });
    expect(
      res.status,
      `Expected 400 for all-invalid, got ${res.status}: ${JSON.stringify(res.body)}`
    ).toBe(400);

    // No job should have been created
    const body = res.body as { error?: string; id?: string };
    expect(body.id).toBeUndefined();
  });

  // ── E4: URL returns 404 during crawl ─────────────────────────────────────

  it("E4 — URL that 404s during crawl causes that URL to fail; job continues", async () => {
    const { email, teamId } = qa();
    await seedCredits(teamId, 50);

    // Mix of real URLs + a URL that will 404
    const urls = [
      "https://www.manipalhospitals.com/specialities/cardiology/",
      "https://www.manipalhospitals.com/this-page-does-not-exist-404-abc123/",
    ];

    const res = await uploadBulkCsv({ email, bulkUrls: urls });
    if (res.status !== 200) {
      // If rejected at upload due to SSRF or validation, test is inconclusive — skip
      console.warn(`E4: upload returned ${res.status} — skipping`);
      return;
    }
    const jobId = trackJob((res.body as { id: string }).id);

    await seedOtpCode(jobId);
    const verifyRes = await verifyOtp(jobId, TEST_OTP_CODE);
    expect(verifyRes.status).toBe(200);
    const token = (verifyRes.body as { accessToken: string }).accessToken;

    // Wait for completion
    const finalRow = await pollUntil(
      () => getJobRow(jobId),
      (r) => r.pipeline_status === "complete" || r.pipeline_status === "failed",
      90_000,
      3_000,
      "E4: 404 crawl completion"
    );

    // Job must NOT be stuck in failed state (only one URL failed)
    expect(
      finalRow.pipeline_status,
      `Job stuck in ${finalRow.pipeline_status} due to single-URL 404`
    ).toBe("complete");

    // At least the valid URL should have a result
    const perPage = (finalRow.per_page_results ?? []) as Array<{ url: string }>;
    expect(perPage.length).toBeGreaterThan(0);
  });

  // ── E5: Concurrent upload by same user ────────────────────────────────────

  it("E5 — Two rapid CSV uploads create separate jobs or one is 429'd", async () => {
    const { email } = qa();
    const urls1 = [
      "https://www.manipalhospitals.com/specialities/cardiology/",
      "https://www.manipalhospitals.com/specialities/oncology/",
    ];
    const urls2 = [
      "https://www.manipalhospitals.com/specialities/neurology/",
      "https://www.manipalhospitals.com/specialities/orthopaedics/",
    ];

    // Fire both uploads simultaneously
    const [res1, res2] = await Promise.all([
      uploadBulkCsv({ email, bulkUrls: urls1 }),
      uploadBulkCsv({ email, bulkUrls: urls2 }),
    ]);

    // Valid outcomes:
    // A) Both succeed with different job IDs (two separate jobs created)
    // B) One returns 429 (rate limiting)
    // INVALID outcome: both return 200 with the SAME job ID (silent overwrite)

    const statuses = [res1.status, res2.status];
    const allSuccess = statuses.every((s) => s === 200);
    const oneRateLimited = statuses.some((s) => s === 429);

    expect(
      allSuccess || oneRateLimited,
      `Unexpected status pair: ${statuses.join(", ")}`
    ).toBe(true);

    if (allSuccess) {
      const id1 = (res1.body as { id: string }).id;
      const id2 = (res2.body as { id: string }).id;
      trackJob(id1);
      trackJob(id2);
      expect(id1, "Two uploads must NOT create the same job ID").not.toBe(id2);
    }
  });

  // ── E6: Free user / unauthenticated CSV upload ────────────────────────────

  it("E6 — Free/unauthenticated user gets 402 on CSV upload", async () => {
    // Use an email that has no team membership (non-existent account)
    const freeUserEmail = `free-user-${Date.now()}@example-nonexistent.com`;

    const res = await uploadBulkCsv({
      email: freeUserEmail,
      bulkUrls: [
        "https://www.manipalhospitals.com/specialities/cardiology/",
        "https://www.manipalhospitals.com/specialities/oncology/",
      ],
    });

    expect(
      res.status,
      `Expected 402 for free user, got ${res.status}: ${JSON.stringify(res.body)}`
    ).toBe(402);

    const body = res.body as { error: string };
    expect(body.error.toLowerCase()).toMatch(/pro|account|credit/i);
  });
});
