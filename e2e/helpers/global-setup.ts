// E2E global setup — runs against geo's LOCAL Supabase stack (supabase start
// in ../geo), which mirrors production's shared-project model: same GoTrue,
// same Postgres this service shares with geo.
//
// Seeds a user + team + credits, signs in via @supabase/ssr itself (so the
// session cookies have exactly the format the middleware reads), and writes a
// Playwright storageState.
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { mkdirSync, writeFileSync } from "node:fs";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export const E2E = {
  email: "cite-e2e@flowblinq.test",
  password: "cite-e2e-password-1",
  teamId: "tm_cite_e2e",
  storageState: ".playwright/storage-state.json",
  dbUrl: DB_URL,
} as const;

export default async function globalSetup() {
  // 1. Seed user in GoTrue (idempotent).
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const created = await admin.auth.admin.createUser({
    email: E2E.email,
    password: E2E.password,
    email_confirm: true,
  });
  let userId = created.data.user?.id;
  if (!userId) {
    const { data } = await admin.auth.admin.listUsers();
    userId = data.users.find((u) => u.email === E2E.email)?.id;
  }
  if (!userId) throw new Error(`E2E setup: could not create/find user (${created.error?.message})`);

  // 2. Seed team + membership + credits; wipe this team's prior e2e data.
  const sql = postgres(DB_URL, { max: 1 });
  await sql`DELETE FROM tracker.orgs WHERE id = ${"team_" + E2E.teamId}`;
  await sql`DELETE FROM credit_transactions WHERE team_id = ${E2E.teamId}`;
  await sql`DELETE FROM rate_limits WHERE key LIKE ${"cite-run:" + E2E.teamId + "%"}`;
  await sql`DELETE FROM team_members WHERE team_id = ${E2E.teamId}`;
  await sql`DELETE FROM teams WHERE id = ${E2E.teamId}`;
  await sql`INSERT INTO teams (id, name, owner_user_id, credit_balance) VALUES (${E2E.teamId}, 'Cite E2E', ${userId}, 20)`;
  await sql`INSERT INTO team_members (id, team_id, user_id, email, role) VALUES ('tmm_cite_e2e', ${E2E.teamId}, ${userId}, ${E2E.email}, 'owner')`;
  await sql.end();

  // 3. Sign in through @supabase/ssr so IT mints the session cookies.
  const jar: { name: string; value: string }[] = [];
  const ssr = createServerClient(SUPABASE_URL, ANON_KEY, {
    cookies: {
      getAll: () => jar,
      setAll: (cookies) => {
        for (const c of cookies) jar.push({ name: c.name, value: c.value });
      },
    },
  });
  const { error } = await ssr.auth.signInWithPassword({ email: E2E.email, password: E2E.password });
  if (error) throw new Error(`E2E setup: sign-in failed: ${error.message}`);
  if (jar.length === 0) throw new Error("E2E setup: sign-in set no cookies");

  mkdirSync(".playwright", { recursive: true });
  writeFileSync(
    E2E.storageState,
    JSON.stringify({
      cookies: jar.map((c) => ({
        name: c.name,
        value: c.value,
        domain: "127.0.0.1",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 3600,
        httpOnly: false,
        secure: false,
        sameSite: "Lax" as const,
      })),
      origins: [],
    }),
  );
}
