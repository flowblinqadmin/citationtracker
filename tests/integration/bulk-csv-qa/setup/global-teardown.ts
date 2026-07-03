/**
 * Global teardown for bulk-csv-qa integration tests.
 *
 * Runs once after all test files.
 * Cleans up geoSites rows, credit transactions, and storage files
 * created during the test run.
 */

import { createClient } from "@supabase/supabase-js";

function getSupabaseAdmin() {
  return createClient(
    process.env.TEST_SUPABASE_URL!,
    process.env.TEST_SUPABASE_SERVICE_KEY!,
    { auth: { persistSession: false } }
  );
}

export default async function globalTeardown() {
  const email = process.env.TEST_USER_EMAIL;
  if (!email) return;

  const sb = getSupabaseAdmin();
  console.info("[bulk-csv-qa] Global teardown: cleaning up test sites...");

  // Delete all geoSites rows owned by the test account
  // (credit_transactions have a FK on geo_sites.id — delete them first)
  const { data: sites } = await sb
    .from("geo_sites")
    .select("id")
    .eq("owner_email", email.toLowerCase());

  if (sites && sites.length > 0) {
    const ids = (sites as { id: string }[]).map((s) => s.id);
    // Delete credit transactions
    await sb.from("credit_transactions").delete().in("site_id", ids);
    // Delete sites
    await sb.from("geo_sites").delete().in("id", ids);
    console.info(`[bulk-csv-qa] Deleted ${ids.length} test site(s).`);
  } else {
    console.info("[bulk-csv-qa] No test sites to clean up.");
  }

  // Clean up Supabase Storage files (report ZIPs) if any
  // Storage bucket: "reports" or similar — adapt to actual bucket name if needed
  const { data: files } = await sb.storage.from("reports").list();
  if (files && files.length > 0) {
    const testFiles = files
      .filter((f) => f.name.includes("qa-bulk"))
      .map((f) => f.name);
    if (testFiles.length > 0) {
      await sb.storage.from("reports").remove(testFiles);
      console.info(`[bulk-csv-qa] Removed ${testFiles.length} test storage file(s).`);
    }
  }

  console.info("[bulk-csv-qa] Global teardown complete.");
}
