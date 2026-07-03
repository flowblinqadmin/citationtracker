/**
 * One-time script: create Supabase users for orphan site owners and link their sites.
 * Run: node scripts/create-and-link-users.mjs
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

const _pg = postgres(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL, { max: 1, prepare: false });
// Wrap to match neon tagged-template API
const sql = (strings, ...values) => _pg(strings, ...values);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Find all orphan sites
const orphans = await sql`
  SELECT id, domain, owner_email
  FROM geo_sites
  WHERE team_id IS NULL
  ORDER BY owner_email, created_at ASC
`;

console.log(`Found ${orphans.length} orphan site(s)\n`);

// Group by email
const byEmail = {};
for (const site of orphans) {
  byEmail[site.owner_email] = byEmail[site.owner_email] ?? [];
  byEmail[site.owner_email].push(site);
}

for (const [email, sites] of Object.entries(byEmail)) {
  console.log(`Processing ${email} (${sites.length} site(s))...`);

  // Check if Supabase user already exists
  const { data: existing } = await supabase.auth.admin.listUsers();
  let user = existing?.users?.find(u => u.email === email);

  if (!user) {
    // Create Supabase user (no password — they'll use OTP to sign in)
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (error) {
      console.log(`  ERROR creating Supabase user: ${error.message}`);
      continue;
    }
    user = data.user;
    console.log(`  Created Supabase user: ${user.id}`);
  } else {
    console.log(`  Supabase user exists: ${user.id}`);
  }

  // Check if team_members row exists
  const [existingMember] = await sql`
    SELECT id, team_id FROM team_members WHERE LOWER(email) = LOWER(${email}) LIMIT 1
  `;

  let teamId;
  if (existingMember) {
    teamId = existingMember.team_id;
    // Update userId if missing
    await sql`
      UPDATE team_members SET user_id = ${user.id} WHERE id = ${existingMember.id} AND user_id IS NULL
    `;
    console.log(`  Using existing team: ${teamId}`);
  } else {
    // Create team + member
    teamId = nanoid();
    const teamName = email.split("@")[0] || "My Team";
    await sql`
      INSERT INTO teams (id, name, owner_user_id, credit_balance, created_at, updated_at)
      VALUES (${teamId}, ${teamName}, ${user.id}, 20, NOW(), NOW())
    `;
    await sql`
      INSERT INTO team_members (id, team_id, user_id, email, role, created_at)
      VALUES (${nanoid()}, ${teamId}, ${user.id}, ${email}, 'owner', NOW())
    `;
    await sql`
      INSERT INTO credit_transactions (id, team_id, type, pages_consumed, credits_changed, balance_before, balance_after, created_at)
      VALUES (${nanoid()}, ${teamId}, 'signup_bonus', 0, 20, 0, 20, NOW())
    `;
    console.log(`  Created new team: ${teamId}`);
  }

  // Link each orphan site
  for (const site of sites) {
    await sql`UPDATE geo_sites SET team_id = ${teamId}, user_id = ${user.id} WHERE id = ${site.id}`;

    const [existingDomain] = await sql`SELECT id FROM team_domains WHERE site_id = ${site.id} LIMIT 1`;
    if (!existingDomain) {
      await sql`
        INSERT INTO team_domains (id, team_id, site_id, domain, added_by_user_id, created_at)
        VALUES (${nanoid()}, ${teamId}, ${site.id}, ${site.domain}, ${user.id}, NOW())
        ON CONFLICT DO NOTHING
      `;
    }
    console.log(`  Linked: ${site.domain}`);
  }
}

console.log("\nDone.");
