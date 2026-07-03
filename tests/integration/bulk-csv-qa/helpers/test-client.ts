/**
 * HTTP client wrapper for bulk-csv-qa integration tests.
 *
 * All requests target TEST_BASE_URL (default: http://localhost:3030).
 *
 * NOTE ON ROUTE MAPPING (ES-009 vs actual implementation):
 * ES-009 spec references /api/bulk-audit/{upload,process,status,zip} routes.
 * These do NOT exist on dev-an-m2-extended. The actual implementation (ES-005)
 * uses the existing /api/sites/* routes with bulk-mode extensions:
 *   - Upload:   POST /api/sites          { email, bulkUrls }
 *   - OTP auth: POST /api/sites/[id]/auth  { email }  → token
 *   - Verify:   POST /api/sites/[id]/verify { code }  → starts bulk crawl
 *   - Status:   GET  /api/sites/[id]?token  → { pipelineStatus, ... }
 *   - Download: GET  /api/sites/[id]/download-report?token
 * All tests in this suite use the actual routes.
 */

import * as fs from "fs";
import * as path from "path";

export const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3030";

// ── Response types ──────────────────────────────────────────────────────────

export interface UploadResponse {
  /** Site ID (maps to geoSites.id) — used as "jobId" in ES-009 nomenclature */
  id: string;
  message?: string;
}

export interface AuthResponse {
  token: string;
}

export interface VerifyResponse {
  success: boolean;
  siteId: string;
  accessToken: string;
}

export interface StatusResponse {
  id: string;
  pipelineStatus: "pending" | "discovery" | "crawling" | "analyzing" | "complete" | "failed";
  auditMode: string | null;
  bulkUrlCount: number | null;
  creditsReserved: number | null;
  crawlLimit: number | null;
  perPageResults: unknown[] | null;
  reportZipUrl: string | null;
}

export interface BulkUploadOptions {
  email: string;
  bulkUrls: string[];
}

// ── Request helpers ─────────────────────────────────────────────────────────

/** Track all HTTP responses for timeout checking */
const responseLog: { url: string; status: number; ts: number }[] = [];

export function getResponseLog() {
  return responseLog;
}

export function clearResponseLog() {
  responseLog.length = 0;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; body: T }> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });

  responseLog.push({ url, status: res.status, ts: Date.now() });

  let parsed: T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    parsed = (await res.json()) as T;
  } else {
    parsed = (await res.text()) as unknown as T;
  }
  return { status: res.status, body: parsed };
}

// ── Bulk audit API wrappers ─────────────────────────────────────────────────

/**
 * Step 1: Upload bulk URLs.
 * POST /api/sites { email, bulkUrls }
 * Returns siteId on 200. Returns raw { status, body } so callers can assert on error cases.
 */
export async function uploadBulkCsv(opts: BulkUploadOptions) {
  return request<UploadResponse | { error: string }>(
    "POST",
    "/api/sites",
    { email: opts.email, bulkUrls: opts.bulkUrls }
  );
}

/**
 * Parse a fixture CSV file and return the URL column values (skipping header).
 */
export function parseFixtureCsv(filename: string): string[] {
  const filepath = path.join(__dirname, "../fixtures", filename);
  const lines = fs.readFileSync(filepath, "utf-8").trim().split("\n");
  // Skip header row ("url")
  return lines.slice(1).map((l) => l.trim()).filter(Boolean);
}

/**
 * Step 2 (bypass OTP): GET access token by email match.
 * POST /api/sites/[id]/auth { email }
 * Used in tests where the site was created directly via DB (so no real OTP).
 */
export async function getAccessToken(siteId: string, email: string) {
  return request<AuthResponse | { error: string }>(
    "POST",
    `/api/sites/${siteId}/auth`,
    { email }
  );
}

/**
 * Step 3: Verify OTP + trigger bulk crawl.
 * POST /api/sites/[id]/verify { code }
 * In integration tests, use a known code seeded via db-helpers.
 */
export async function verifyOtp(siteId: string, code: string) {
  return request<VerifyResponse | { error: string }>(
    "POST",
    `/api/sites/${siteId}/verify`,
    { code }
  );
}

/**
 * Poll job status.
 * GET /api/sites/[id]?token=...
 */
export async function getJobStatus(siteId: string, token: string) {
  return request<StatusResponse | { error: string }>(
    "GET",
    `/api/sites/${siteId}?token=${encodeURIComponent(token)}`
  );
}

/**
 * Download the ZIP report buffer.
 * GET /api/sites/[id]/download-report?token=...
 * Returns raw Response so caller can check headers and read buffer.
 */
export async function downloadReportZip(siteId: string, token: string): Promise<Response> {
  const url = `${BASE_URL}/api/sites/${siteId}/download-report?token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  responseLog.push({ url, status: res.status, ts: Date.now() });
  return res;
}

/**
 * Attempt to regenerate a bulk site (should return 400).
 */
export async function triggerRegenerate(siteId: string, token: string) {
  return request<{ error: string }>(
    "POST",
    `/api/sites/${siteId}/regenerate`,
    {},
    { authorization: `Bearer ${token}` }
  );
}
