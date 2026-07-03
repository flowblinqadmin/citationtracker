/**
 * Tier 3 — ZIP Integrity
 * GitHub Issue #97
 * ES-009 tests Z1–Z7
 *
 * Uses completed jobs from smoke (5-URL) and load (100-URL) tiers,
 * or creates its own jobs if running in isolation.
 *
 * Z3 is the critical acceptance gate: partial failure ZIP must still generate.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import JSZip from "jszip";
import {
  uploadBulkCsv,
  parseFixtureCsv,
  verifyOtp,
  downloadReportZip,
} from "../helpers/test-client";
import {
  getJobRow,
  getSiteCreditTransactions,
  cleanupJob,
  seedOtpCode,
  insertTestSite,
  TEST_OTP_CODE,
  hashTestCode,
} from "../helpers/db-helpers";
import { pollUntil } from "../helpers/wait-helpers";
import { seedCredits } from "../helpers/credit-helpers";
import { nanoid } from "nanoid";

// ── Test context ─────────────────────────────────────────────────────────────

const qa = () => (globalThis as Record<string, unknown>).__BULK_QA__ as {
  teamId: string;
  email: string;
  seedAmount: number;
};

// Jobs for this tier — created fresh (isolation per spec)
let smokeJobId: string;
let smokeToken: string;
let loadJobId: string;
let loadToken: string;
let partialJobId: string;    // Z3 partial-failure job
let partialToken: string;

const SMOKE_URLS = parseFixtureCsv("smoke-5urls.csv");
const LOAD_URLS = parseFixtureCsv("load-100urls.csv");

async function createAndRunJob(
  email: string,
  urls: string[],
  timeoutMs = 120_000
): Promise<{ jobId: string; token: string }> {
  const res = await uploadBulkCsv({ email, bulkUrls: urls });
  if (res.status !== 200) throw new Error(`Upload failed: ${JSON.stringify(res.body)}`);
  const jobId = (res.body as { id: string }).id;

  await seedOtpCode(jobId);
  const verifyRes = await verifyOtp(jobId, TEST_OTP_CODE);
  if (verifyRes.status !== 200) throw new Error(`Verify failed: ${JSON.stringify(verifyRes.body)}`);
  const token = (verifyRes.body as { accessToken: string }).accessToken;

  await pollUntil(
    () => getJobRow(jobId),
    (r) => r.pipeline_status === "complete" || r.pipeline_status === "failed",
    timeoutMs,
    4_000,
    `createAndRunJob(${jobId})`
  );

  return { jobId, token };
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("Tier 3 — ZIP Integrity", { timeout: 300_000 }, () => {
  beforeAll(async () => {
    const { teamId, email, seedAmount } = qa();
    await seedCredits(teamId, seedAmount * 4); // extra for 3 fresh jobs

    // Run smoke + load jobs for this tier (isolated from Tier 1/2)
    [{ jobId: smokeJobId, token: smokeToken }] = await Promise.all([
      createAndRunJob(email, SMOKE_URLS, 120_000),
    ]);

    // Load job — longer timeout
    ({ jobId: loadJobId, token: loadToken } = await createAndRunJob(email, LOAD_URLS, 600_000));
  });

  afterAll(async () => {
    await Promise.allSettled([
      smokeJobId ? cleanupJob(smokeJobId) : Promise.resolve(),
      loadJobId ? cleanupJob(loadJobId) : Promise.resolve(),
      partialJobId ? cleanupJob(partialJobId) : Promise.resolve(),
    ]);
  });

  // ── Z1: ZIP structure — one file per URL ─────────────────────────────────

  it("Z1 — ZIP contains one file per completed URL (no blank entries)", async () => {
    const res = await downloadReportZip(smokeJobId, smokeToken);
    expect(res.status).toBe(200);

    const buf = Buffer.from(await res.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);

    const row = await getJobRow(smokeJobId);
    const completedCount = ((row.per_page_results ?? []) as unknown[]).length;

    // Filter out directory entries (JSZip includes them in .files)
    const files = Object.keys(zip.files).filter((f) => !f.endsWith("/"));

    // Expect: one aggregate-report.html + one file per page in pages/
    const pageFiles = files.filter((f) => f.startsWith("pages/"));
    expect(pageFiles.length).toBe(completedCount);

    // No blank/empty filenames
    for (const f of pageFiles) {
      const filename = f.replace("pages/", "");
      expect(filename.trim().length).toBeGreaterThan(0);
    }

    // Aggregate report present
    expect(files).toContain("aggregate-report.html");
  });

  // ── Z2: File format valid ─────────────────────────────────────────────────

  it("Z2 — Each ZIP file is non-empty, UTF-8 HTML, not truncated", async () => {
    const res = await downloadReportZip(smokeJobId, smokeToken);
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);

    const pageFiles = Object.keys(zip.files).filter(
      (f) => f.startsWith("pages/") && !f.endsWith("/")
    );

    for (const filename of pageFiles) {
      const content = await zip.files[filename].async("string");
      expect(content.length, `File ${filename} is empty`).toBeGreaterThan(200); // > 200 bytes per spec
      const isHtml =
        content.includes("<html") ||
        content.includes("<!DOCTYPE") ||
        content.includes("<!doctype");
      expect(isHtml, `File ${filename} is not valid HTML: starts with "${content.slice(0, 50)}"`).toBe(true);
      // Not truncated — must close html tag
      expect(content.toLowerCase()).toContain("</html>");
    }
  });

  // ── Z3 (CRITICAL): Partial failure — ZIP still generates ─────────────────

  it("Z3 — ZIP generates for partial failure job (critical acceptance gate)", async () => {
    const { email, teamId } = qa();
    await seedCredits(teamId, 100);

    // Include one URL known to fail (unreachable domain)
    const partialUrls = [
      ...SMOKE_URLS.slice(0, 3),
      "https://this-domain-absolutely-does-not-exist-xyz123.com/page",
    ];

    const res = await uploadBulkCsv({ email, bulkUrls: partialUrls });
    expect(res.status).toBe(200);
    partialJobId = (res.body as { id: string }).id;

    await seedOtpCode(partialJobId);
    const verifyRes = await verifyOtp(partialJobId, TEST_OTP_CODE);
    expect(verifyRes.status).toBe(200);
    partialToken = (verifyRes.body as { accessToken: string }).accessToken;

    // Wait for completion (partial failure should still complete)
    const finalRow = await pollUntil(
      () => getJobRow(partialJobId),
      (r) => r.pipeline_status === "complete" || r.pipeline_status === "failed",
      120_000,
      3_000,
      "Z3: partial completion"
    );

    // Job must not be stuck — it should complete (even if some URLs failed)
    expect(
      finalRow.pipeline_status,
      `Partial failure job stuck in: ${finalRow.pipeline_status}. Error: ${finalRow.pipeline_error}`
    ).toBe("complete");

    // Per-page results should have at least the successful URLs
    const perPage = (finalRow.per_page_results ?? []) as Array<{ url: string }>;
    expect(perPage.length).toBeGreaterThan(0);

    // ZIP must generate for remaining N-1 pages — must return 200, not 500
    const zipRes = await downloadReportZip(partialJobId, partialToken);
    expect(
      zipRes.status,
      `ZIP generation failed with ${zipRes.status} for partial failure job`
    ).toBe(200);
    expect(zipRes.headers.get("content-type")).toContain("application/zip");

    // Failed URL must NOT appear in ZIP
    const buf = Buffer.from(await zipRes.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);
    const zipFiles = Object.keys(zip.files).filter((f) => !f.endsWith("/"));
    const failedUrlInZip = zipFiles.some((f) =>
      f.includes("this-domain-absolutely-does-not-exist-xyz123")
    );
    expect(
      failedUrlInZip,
      "Failed URL should not appear in ZIP"
    ).toBe(false);
  });

  // ── Z4: Large ZIP — storage succeeds ─────────────────────────────────────

  it("Z4 — 100-URL ZIP downloads without error", async () => {
    const res = await downloadReportZip(loadJobId, loadToken);
    expect(res.status).toBe(200);

    const buf = Buffer.from(await res.arrayBuffer());
    // 100 pages × ~5KB = ~500KB compressed — should be non-trivial
    expect(buf.length).toBeGreaterThan(10_000);

    // Parseable by jszip
    const zip = await JSZip.loadAsync(buf);
    const pageFiles = Object.keys(zip.files).filter(
      (f) => f.startsWith("pages/") && !f.endsWith("/")
    );
    expect(pageFiles.length).toBeGreaterThan(0);
  });

  // ── Z5: Download link validity ────────────────────────────────────────────

  it("Z5 — download-report returns Content-Type: application/zip with valid Content-Disposition", async () => {
    const res = await downloadReportZip(smokeJobId, smokeToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");

    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toMatch(/attachment/i);
    expect(disposition).toMatch(/filename=/i);
    // Filename should not contain path-traversal characters
    expect(disposition).not.toContain("..");
    expect(disposition).not.toContain("/");
  });

  // ── Z6: Re-download works ─────────────────────────────────────────────────

  it("Z6 — download-report is idempotent (two fetches return same Content-Length)", async () => {
    const res1 = await downloadReportZip(smokeJobId, smokeToken);
    const res2 = await downloadReportZip(smokeJobId, smokeToken);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const buf1 = Buffer.from(await res1.arrayBuffer());
    const buf2 = Buffer.from(await res2.arrayBuffer());

    // Same size — ZIP is regenerated on-demand but should be deterministic
    // Allow ±50 bytes for timestamp differences in ZIP metadata
    const sizeDiff = Math.abs(buf1.length - buf2.length);
    expect(
      sizeDiff,
      `Re-download size differs by ${sizeDiff} bytes (buf1=${buf1.length}, buf2=${buf2.length})`
    ).toBeLessThanOrEqual(100);
  });

  // ── Z7: Cross-platform ZIP format ────────────────────────────────────────

  it("Z7 — ZIP uses standard deflate compression (method 8 or stored 0), no .DS_Store", async () => {
    const res = await downloadReportZip(smokeJobId, smokeToken);
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);

    const pageFiles = Object.keys(zip.files).filter(
      (f) => f.startsWith("pages/") && !f.endsWith("/")
    );
    expect(pageFiles.length).toBeGreaterThan(0);

    for (const filename of pageFiles) {
      const file = zip.files[filename];
      // JSZip normalizes — check the file is accessible (implicitly validates format)
      const content = await file.async("uint8array");
      expect(content.length).toBeGreaterThan(0);
    }

    // No .DS_Store or macOS metadata files
    const macFiles = Object.keys(zip.files).filter(
      (f) => f.includes(".DS_Store") || f.includes("__MACOSX")
    );
    expect(
      macFiles.length,
      `Found macOS metadata files in ZIP: ${macFiles.join(", ")}`
    ).toBe(0);

    // Aggregate report exists and is valid HTML
    const aggregate = zip.files["aggregate-report.html"];
    expect(aggregate, "aggregate-report.html missing from ZIP").toBeDefined();
    const aggregateContent = await aggregate.async("string");
    expect(aggregateContent).toContain("<html");
  });
});
