/**
 * Global setup for API client integration tests (ES-021).
 *
 * beforeAll (setup):
 *   1. Validate required env vars
 *   2. Warm up Vercel (GET /api/v1/mcp — no auth, warms cold start)
 *   3. Provision a fresh apiClient row in DB via Supabase service role
 *      (or use TEST_CLIENT_ID/TEST_CLIENT_SECRET if provided as override)
 *   4. Export credentials to globalThis.__API_CLIENT_QA__
 *
 * afterAll (teardown):
 *   1. Delete all geoSite rows with apiClientId = provisioned clientId
 *   2. Delete the provisioned apiClient row (if we created it)
 *   3. Log cleanup summary
 */

import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";

// Temp file path shared between globalSetup (main process) and setupFiles (worker process)
export const QA_CREDS_TMP = "/tmp/vitest-flowblinq-api-client-qa.json";
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";

// Load .env.test in globalSetup context (vitest test.env only reaches workers, not globalSetup)
try {
  const envPath = resolve(process.cwd(), ".env.test");
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
} catch {
  // .env.test not present — env vars must be set externally
}

// ─── Types ────────────────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __API_CLIENT_QA__: {
    clientId: string;
    clientSecret: string;
    teamId: string;
    baseUrl: string;
    /** true if we created the credential in setup (false = using env override) */
    provisioned: boolean;
    /** internal DB row id for cleanup */
    dbRowId: string | null;
  };
}

// ─── Required env vars ───────────────────────────────────────────────────────

const REQUIRED_ENV = [
  "TEST_BASE_URL",
  "TEST_SUPABASE_URL",
  "TEST_SUPABASE_SERVICE_KEY",
  "TEST_TEAM_ID",
] as const;

// ─── Setup ───────────────────────────────────────────────────────────────────

export async function setup(): Promise<void> {
  // 1. Validate env vars
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `API client integration tests: missing required env vars: ${missing.join(", ")}\n` +
        "Copy geo/tests/integration/api-client/.env.test.example to geo/.env.test and fill in values."
    );
  }

  const baseUrl = process.env.TEST_BASE_URL!;
  const supabaseUrl = process.env.TEST_SUPABASE_URL!;
  const supabaseKey = process.env.TEST_SUPABASE_SERVICE_KEY!;
  const teamId = process.env.TEST_TEAM_ID!;

  const supabase = createClient(supabaseUrl, supabaseKey);

  // 2. Warm up Vercel (cold start prevention)
  console.log("[setup] Warming up Vercel...");
  const warmStart = Date.now();
  try {
    const warmRes = await fetch(`${baseUrl}/api/v1/mcp`, { signal: AbortSignal.timeout(30_000) });
    const warmMs = Date.now() - warmStart;
    if (!warmRes.ok) {
      console.warn(`[setup] Warm-up returned ${warmRes.status} — proceeding anyway`);
    } else {
      console.log(`[setup] Vercel warm in ${warmMs}ms`);
      if (warmMs > 10_000) {
        console.warn("[setup] Cold start detected (>10s). First test may be slow.");
      }
    }
  } catch (err) {
    console.warn("[setup] Warm-up failed — network issue?", err);
  }

  // 3. Pre-test cleanup: delete existing geo_sites for test domains (idempotent runs)
  const testDomainUrls = [
    process.env.TEST_AUDIT_DOMAIN,
    process.env.TEST_FREE_TIER_DOMAIN,
  ].filter(Boolean) as string[];

  const testDomainHostnames = testDomainUrls.map((u) => {
    try { return new URL(u).hostname; } catch { return u; }
  });

  if (testDomainHostnames.length > 0) {
    // Find site IDs to delete
    const { data: siteRows } = await supabase
      .from("geo_sites")
      .select("id")
      .in("domain", testDomainHostnames)
      .eq("team_id", teamId);

    if (siteRows && siteRows.length > 0) {
      const siteIds = siteRows.map((r: { id: string }) => r.id);

      // Delete team_domains rows first (FK constraint: team_domains.site_id → geo_sites.id)
      await supabase.from("team_domains").delete().in("site_id", siteIds);

      // Now delete the geo_sites rows
      const { count: cleanCount, error: cleanError } = await supabase
        .from("geo_sites")
        .delete({ count: "exact" })
        .in("id", siteIds);

      if (cleanError) {
        console.warn(`[setup] Domain cleanup failed: ${cleanError.message}`);
      } else {
        console.log(`[setup] Pre-test cleanup: removed ${cleanCount ?? 0} stale geo_sites rows`);
      }
    } else {
      console.log("[setup] Pre-test cleanup: no stale rows found");
    }
  }

  // 4. Check for manual override credentials
  if (process.env.TEST_CLIENT_ID && process.env.TEST_CLIENT_SECRET) {
    console.log("[setup] Using provided TEST_CLIENT_ID/TEST_CLIENT_SECRET (skipping provisioning)");
    const creds = {
      clientId: process.env.TEST_CLIENT_ID,
      clientSecret: process.env.TEST_CLIENT_SECRET,
      teamId,
      baseUrl,
      provisioned: false,
      dbRowId: null,
    };
    globalThis.__API_CLIENT_QA__ = creds;
    writeFileSync(QA_CREDS_TMP, JSON.stringify(creds));
    return;
  }

  // 4. Provision a fresh apiClient row
  console.log("[setup] Provisioning fresh apiClient credential...");

  const rowId = nanoid();
  const clientId = "test_" + nanoid(16);
  const clientSecret = nanoid(32);
  const clientSecretHash = await bcrypt.hash(clientSecret, 12);

  const { error: insertError } = await supabase.from("api_clients").insert({
    id: rowId,
    team_id: teamId,
    client_id: clientId,
    client_secret_hash: clientSecretHash,
    name: `integration-test-${Date.now()}`,
    scopes: ["audit:read", "audit:write", "account:read"],
    created_at: new Date().toISOString(),
  });

  if (insertError) {
    throw new Error(`[setup] Failed to provision apiClient: ${insertError.message}`);
  }

  console.log(`[setup] Provisioned apiClient: ${clientId}`);

  const creds = {
    clientId,
    clientSecret,
    teamId,
    baseUrl,
    provisioned: true,
    dbRowId: rowId,
  };
  globalThis.__API_CLIENT_QA__ = creds;
  // Write to temp file so setupFiles (worker process) can read it into globalThis
  writeFileSync(QA_CREDS_TMP, JSON.stringify(creds));
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

export async function teardown(): Promise<void> {
  const qa = globalThis.__API_CLIENT_QA__;
  if (!qa) {
    console.warn("[teardown] No __API_CLIENT_QA__ found — skipping cleanup");
    return;
  }

  const supabase = createClient(
    process.env.TEST_SUPABASE_URL!,
    process.env.TEST_SUPABASE_SERVICE_KEY!
  );

  // Delete all geoSite rows created by this test run
  const { count: siteCount, error: siteError } = await supabase
    .from("geo_sites")
    .delete({ count: "exact" })
    .eq("api_client_id", qa.clientId);

  if (siteError) {
    console.error(`[teardown] Failed to delete geo_sites: ${siteError.message}`);
  } else {
    console.log(`[teardown] Deleted ${siteCount ?? 0} geo_sites for clientId=${qa.clientId}`);
  }

  // Delete the provisioned apiClient row (only if we created it)
  if (qa.provisioned && qa.dbRowId) {
    const { error: clientError } = await supabase
      .from("api_clients")
      .delete()
      .eq("id", qa.dbRowId);

    if (clientError) {
      console.error(`[teardown] Failed to delete api_clients row: ${clientError.message}`);
    } else {
      console.log(`[teardown] Deleted apiClient row: ${qa.dbRowId}`);
    }
  }

  // Remove temp credentials file
  try { unlinkSync(QA_CREDS_TMP); } catch { /* already gone */ }

  console.log("[teardown] Cleanup complete.");
}
