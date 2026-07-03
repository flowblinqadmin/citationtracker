/**
 * Supabase admin client for E2E test cleanup.
 * Uses the local Supabase service role key (well-known default).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const LOCAL_SUPABASE_URL = "http://127.0.0.1:54321";
const LOCAL_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

let _client: SupabaseClient | null = null;

export function getAdminClient(): SupabaseClient {
  if (!_client) {
    _client = createClient(LOCAL_SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return _client;
}

/**
 * Delete a user by email from local Supabase auth.
 * Useful for test cleanup to avoid "user already exists" errors.
 */
export async function deleteUserByEmail(email: string): Promise<void> {
  const admin = getAdminClient();

  // List users and find by email
  const { data } = await admin.auth.admin.listUsers();
  const user = data?.users?.find((u) => u.email === email);

  if (user) {
    await admin.auth.admin.deleteUser(user.id);
  }
}
