// E2E global setup — runs against geo's LOCAL Supabase stack (supabase start
// in ../geo), which mirrors production's shared-project model: same GoTrue,
// same Postgres this service shares with geo.
//
// Seeds one user + team + credits PER SPEC FILE (spec files run in parallel
// workers against one dev server — a shared team means one file's balance
// mutations and brand creations race the other's assertions), signs each in
// via @supabase/ssr itself (so the session cookies have exactly the format
// the middleware reads), and writes a Playwright storageState per team.
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
  memberId: "tmm_cite_e2e",
  storageState: ".playwright/storage-state.json",
  dbUrl: DB_URL,
} as const;

// Isolated identity for onboarding.spec.ts — it rewrites its team's balance
// and creates brands, which must never disturb citation-flow's pristine team.
export const E2E_ONBOARDING = {
  email: "cite-e2e-onboarding@flowblinq.test",
  password: "cite-e2e-password-1",
  teamId: "tm_cite_onb_e2e",
  memberId: "tmm_cite_onb_e2e",
  storageState: ".playwright/storage-state-onboarding.json",
  dbUrl: DB_URL,
} as const;

type SeedTarget = typeof E2E | typeof E2E_ONBOARDING;

async function seedTeamWithSession(target: SeedTarget) {
  // 1. Seed user in GoTrue (idempotent).
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const created = await admin.auth.admin.createUser({
    email: target.email,
    password: target.password,
    email_confirm: true,
  });
  let userId = created.data.user?.id;
  if (!userId) {
    const { data } = await admin.auth.admin.listUsers();
    userId = data.users.find((u) => u.email === target.email)?.id;
  }
  if (!userId) throw new Error(`E2E setup: could not create/find user (${created.error?.message})`);

  // 2. Seed team + membership + credits; wipe this team's prior e2e data.
  const sql = postgres(DB_URL, { max: 1 });
  await sql`DELETE FROM tracker.orgs WHERE id = ${"team_" + target.teamId}`;
  await sql`DELETE FROM credit_transactions WHERE team_id = ${target.teamId}`;
  await sql`DELETE FROM rate_limits WHERE key LIKE ${"cite-run:" + target.teamId + "%"}`;
  await sql`DELETE FROM team_members WHERE team_id = ${target.teamId}`;
  await sql`DELETE FROM teams WHERE id = ${target.teamId}`;
  await sql`INSERT INTO teams (id, name, owner_user_id, credit_balance) VALUES (${target.teamId}, 'Cite E2E', ${userId}, 20)`;
  await sql`INSERT INTO team_members (id, team_id, user_id, email, role) VALUES (${target.memberId}, ${target.teamId}, ${userId}, ${target.email}, 'owner')`;
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
  const { error } = await ssr.auth.signInWithPassword({ email: target.email, password: target.password });
  if (error) throw new Error(`E2E setup: sign-in failed: ${error.message}`);
  if (jar.length === 0) throw new Error("E2E setup: sign-in set no cookies");

  mkdirSync(".playwright", { recursive: true });
  writeFileSync(
    target.storageState,
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

export default async function globalSetup() {
  await seedTeamWithSession(E2E);
  await seedTeamWithSession(E2E_ONBOARDING);
}
