/**
 * Credit balance management for bulk-csv-qa integration tests.
 * Uses Supabase service key to directly set credit balances for test setup.
 */

import { createClient } from "@supabase/supabase-js";

function getSupabaseAdmin() {
  const url = process.env.TEST_SUPABASE_URL;
  const key = process.env.TEST_SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("TEST_SUPABASE_URL and TEST_SUPABASE_SERVICE_KEY must be set");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Read the current credit balance for a team.
 */
export async function getCredits(teamId: string): Promise<number> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("teams")
    .select("credit_balance")
    .eq("id", teamId)
    .single();
  if (error) throw new Error(`getCredits(${teamId}): ${error.message}`);
  return (data as { credit_balance: number }).credit_balance;
}

/**
 * Set credit balance to a specific amount.
 * Records a test_seed credit transaction for traceability.
 */
export async function seedCredits(teamId: string, amount: number): Promise<void> {
  const sb = getSupabaseAdmin();
  const current = await getCredits(teamId);

  // Update balance
  const { error: updateErr } = await sb
    .from("teams")
    .update({ credit_balance: amount })
    .eq("id", teamId);
  if (updateErr) throw new Error(`seedCredits update: ${updateErr.message}`);

  // Record transaction for auditability
  const { error: txErr } = await sb.from("credit_transactions").insert({
    id: `test-seed-${Date.now()}`,
    team_id: teamId,
    site_id: null,
    type: "test_seed",
    credits_changed: amount - current,
    balance_before: current,
    balance_after: amount,
    created_at: new Date().toISOString(),
  });
  // Non-fatal — if credit_transactions has constraints that reject test_seed, skip
  if (txErr) {
    console.warn(`seedCredits: could not insert test_seed transaction: ${txErr.message}`);
  }
}

/**
 * Restore credits to a known amount after a test run.
 * Use in afterAll to prevent credit leakage between test tiers.
 */
export async function restoreCredits(teamId: string, amount: number): Promise<void> {
  return seedCredits(teamId, amount);
}

/**
 * Assert the credit balance equals expected within a tolerance.
 * Used for L7 / S6 credit reconciliation assertions.
 */
export function assertCreditBalance(
  actual: number,
  expected: number,
  toleranceCredits = 1,
  label = ""
): void {
  const diff = Math.abs(actual - expected);
  if (diff > toleranceCredits) {
    throw new Error(
      `${label} Credit balance mismatch: actual=${actual}, expected=${expected}, diff=${diff} (tolerance=${toleranceCredits})`
    );
  }
}
