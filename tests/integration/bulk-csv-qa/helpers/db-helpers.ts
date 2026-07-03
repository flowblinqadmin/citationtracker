/**
 * Direct Supabase DB access for bulk-csv-qa integration tests.
 * Uses the service-role key to bypass RLS — never use in production code.
 *
 * Provides OTP bypass: we insert a site row with a known sha256-hashed code,
 * then call POST /api/sites/[id]/verify with the plaintext code.
 */

import { createClient } from "@supabase/supabase-js";
import * as crypto from "crypto";
import type { PerPageResult } from "../../../../lib/services/per-page-analyzer";

// ── Supabase client ─────────────────────────────────────────────────────────

function getSupabaseAdmin() {
  const url = process.env.TEST_SUPABASE_URL;
  const key = process.env.TEST_SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("TEST_SUPABASE_URL and TEST_SUPABASE_SERVICE_KEY must be set in .env.test");
  }
  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface GeoSitesRow {
  id: string;
  domain: string;
  slug: string;
  owner_email: string;
  team_id: string | null;
  email_verified: boolean;
  pipeline_status: string;
  audit_mode: string | null;
  bulk_urls: string[] | null;
  bulk_url_count: number | null;
  crawl_limit: number | null;
  credits_reserved: number | null;
  per_page_results: PerPageResult[] | null;
  report_zip_url: string | null;
  access_token: string | null;
  verification_code: string | null;
  code_expires_at: string | null;
  pipeline_error: string | null;
  created_at: string;
}

export interface CreditTransaction {
  id: string;
  team_id: string;
  site_id: string | null;
  type: string;
  credits_changed: number;
  pages_consumed: number | null;
  balance_before: number;
  balance_after: number;
  created_at: string;
}

// ── OTP helpers ─────────────────────────────────────────────────────────────

/** The test OTP code we use for all integration test sites */
export const TEST_OTP_CODE = "847291";

/** sha256 hash of TEST_OTP_CODE — matches hashCode() in lib/email.ts */
export function hashTestCode(): string {
  return crypto.createHash("sha256").update(TEST_OTP_CODE).digest("hex");
}

// ── Query helpers ───────────────────────────────────────────────────────────

export async function getJobRow(jobId: string): Promise<GeoSitesRow> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("geo_sites")
    .select("*")
    .eq("id", jobId)
    .single();
  if (error) throw new Error(`getJobRow(${jobId}): ${error.message}`);
  return data as GeoSitesRow;
}

export async function getUrlResults(jobId: string): Promise<PerPageResult[]> {
  const row = await getJobRow(jobId);
  return (row.per_page_results as PerPageResult[]) ?? [];
}

export async function getCreditBalance(teamId: string): Promise<number> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("teams")
    .select("credit_balance")
    .eq("id", teamId)
    .single();
  if (error) throw new Error(`getCreditBalance(${teamId}): ${error.message}`);
  return (data as { credit_balance: number }).credit_balance;
}

export async function getCreditTransactions(
  teamId: string,
  type?: string
): Promise<CreditTransaction[]> {
  const sb = getSupabaseAdmin();
  let q = sb
    .from("credit_transactions")
    .select("*")
    .eq("team_id", teamId)
    .order("created_at", { ascending: false });
  if (type) {
    q = q.eq("type", type);
  }
  const { data, error } = await q;
  if (error) throw new Error(`getCreditTransactions(${teamId}): ${error.message}`);
  return data as CreditTransaction[];
}

/**
 * Get credit transactions scoped to a specific site.
 */
export async function getSiteCreditTransactions(
  siteId: string,
  type?: string
): Promise<CreditTransaction[]> {
  const sb = getSupabaseAdmin();
  let q = sb
    .from("credit_transactions")
    .select("*")
    .eq("site_id", siteId)
    .order("created_at", { ascending: false });
  if (type) {
    q = q.eq("type", type);
  }
  const { data, error } = await q;
  if (error) throw new Error(`getSiteCreditTransactions(${siteId}): ${error.message}`);
  return data as CreditTransaction[];
}

/**
 * Seed the verificationCode on an existing site with a known test code.
 * Extends expiry to 15 minutes. Used to bypass OTP email in tests.
 */
export async function seedOtpCode(siteId: string): Promise<void> {
  const sb = getSupabaseAdmin();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const { error } = await sb
    .from("geo_sites")
    .update({
      verification_code: hashTestCode(),
      code_expires_at: expiresAt,
      email_verified: false,
    })
    .eq("id", siteId);
  if (error) throw new Error(`seedOtpCode(${siteId}): ${error.message}`);
}

/**
 * Wait until pipelineStatus transitions to one of the target statuses.
 * Polls directly against DB — faster than HTTP polling for test setup.
 */
export async function waitForPipelineStatus(
  siteId: string,
  targetStatuses: string[],
  timeoutMs = 120_000,
  intervalMs = 3_000
): Promise<GeoSitesRow> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await getJobRow(siteId);
    if (targetStatuses.includes(row.pipeline_status)) return row;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const row = await getJobRow(siteId);
  throw new Error(
    `waitForPipelineStatus(${siteId}): timeout after ${timeoutMs}ms, current status: ${row.pipeline_status}`
  );
}

/**
 * Delete a geoSites row and any associated storage files.
 * Also deletes credit_transactions for this site to avoid test pollution.
 */
export async function cleanupJob(jobId: string): Promise<void> {
  const sb = getSupabaseAdmin();
  // Delete credit transactions first (FK)
  await sb.from("credit_transactions").delete().eq("site_id", jobId);
  // Delete site row
  const { error } = await sb.from("geo_sites").delete().eq("id", jobId);
  if (error) console.warn(`cleanupJob(${jobId}): ${error.message}`);
}

/**
 * Find the test team ID by the test user's email (via team_members).
 */
export async function getTestTeamId(email: string): Promise<string> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("team_members")
    .select("team_id")
    .eq("email", email.toLowerCase())
    .single();
  if (error) throw new Error(`getTestTeamId(${email}): ${error.message}`);
  return (data as { team_id: string }).team_id;
}

/**
 * Direct insert of a geoSites row for test setup.
 * Returns the inserted row's id.
 */
export async function insertTestSite(row: Partial<GeoSitesRow> & { id: string; domain: string; slug: string; owner_email: string }): Promise<string> {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("geo_sites").insert({
    pipeline_status: "pending",
    email_verified: false,
    audit_mode: "bulk",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...row,
  });
  if (error) throw new Error(`insertTestSite: ${error.message}`);
  return row.id;
}
