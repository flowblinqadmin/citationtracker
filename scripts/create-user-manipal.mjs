/**
 * One-shot: provision manipal.appiness@gmail.com with a new team
 * (AppinessManipal, Starter-equivalent monthly credits = 1430, owner role).
 *
 * Mirrors the pattern in scripts/create-and-link-users.mjs but for a single
 * named user, with no orphan-site linking.
 *
 * Run: node scripts/create-user-manipal.mjs
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^"|"$/g, "");
  }
} catch {}

import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { nanoid } from "nanoid";

const EMAIL = "manipal.appiness@gmail.com";
const TEAM_NAME = "AppinessManipal";
const CREDITS = 1430;

const _pg = postgres(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL, { max: 1, prepare: false });
const sql = (strings, ...values) => _pg(strings, ...values);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

console.log(`Provisioning ${EMAIL}...`);
console.log(`  Supabase URL: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`);
console.log(`  Team name:    ${TEAM_NAME}`);
console.log(`  Credits:      ${CREDITS}`);
console.log("");

// 1. Guard: user must not already exist
const { data: existing, error: listErr } = await supabase.auth.admin.listUsers();
if (listErr) { console.error("listUsers failed:", listErr); process.exit(1); }
if (existing?.users?.find(u => u.email === EMAIL)) {
  console.error(`ABORT: ${EMAIL} already exists in auth.users`);
  process.exit(1);
}

// 2. Guard: no team_members row for this email yet
const [existingMember] = await sql`
  SELECT id, team_id FROM team_members WHERE LOWER(email) = LOWER(${EMAIL}) LIMIT 1
`;
if (existingMember) {
  console.error(`ABORT: team_members row already exists for ${EMAIL} (team_id=${existingMember.team_id})`);
  process.exit(1);
}

// 3. Create Supabase auth user (passwordless, email pre-confirmed → OTP sign-in)
const { data: created, error: createErr } = await supabase.auth.admin.createUser({
  email: EMAIL,
  email_confirm: true,
});
if (createErr) { console.error("createUser failed:", createErr); process.exit(1); }
const user = created.user;
console.log(`  Created auth user: ${user.id}`);

// 4. Create team + member + signup_bonus credit transaction
const teamId = nanoid();
await sql`
  INSERT INTO teams (id, name, owner_user_id, credit_balance, created_at, updated_at)
  VALUES (${teamId}, ${TEAM_NAME}, ${user.id}, ${CREDITS}, NOW(), NOW())
`;
console.log(`  Created team:      ${teamId} (${TEAM_NAME})`);

await sql`
  INSERT INTO team_members (id, team_id, user_id, email, role, created_at)
  VALUES (${nanoid()}, ${teamId}, ${user.id}, ${EMAIL}, 'owner', NOW())
`;
console.log(`  Created team_member as owner`);

await sql`
  INSERT INTO credit_transactions (id, team_id, type, pages_consumed, credits_changed, balance_before, balance_after, created_at)
  VALUES (${nanoid()}, ${teamId}, 'signup_bonus', 0, ${CREDITS}, 0, ${CREDITS}, NOW())
`;
console.log(`  Recorded credit_transaction: +${CREDITS} (signup_bonus)`);

console.log("\nDone.");
process.exit(0);
