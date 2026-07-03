/**
 * One-time migration: link geo_sites rows that have ownerEmail but no teamId
 * to the matching team via teamMembers.email lookup.
 *
 * Run: node scripts/link-orphan-sites.mjs
 * Requires DATABASE_URL_UNPOOLED in environment (or .env.local loaded).
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse .env.local manually — no dotenv dependency needed
try {
  const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^"|"$/g, "");
  }
} catch { /* .env.local not found, rely on existing env */ }

import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL_UNPOOLED);

async function main() {
  // Find all orphan sites (no teamId)
  const orphans = await sql`
    SELECT id, domain, owner_email
    FROM geo_sites
    WHERE team_id IS NULL
    ORDER BY created_at ASC
  `;

  console.log(`Found ${orphans.length} orphan site(s)`);
  if (orphans.length === 0) return;

  let linked = 0;
  let skipped = 0;

  for (const site of orphans) {
    // Find team membership by email
    const [member] = await sql`
      SELECT tm.team_id, tm.user_id
      FROM team_members tm
      WHERE LOWER(tm.email) = LOWER(${site.owner_email})
      LIMIT 1
    `;

    if (!member) {
      console.log(`  SKIP ${site.domain} (${site.owner_email}) — no team member found`);
      skipped++;
      continue;
    }

    // Check if teamDomains row already exists
    const [existing] = await sql`
      SELECT id FROM team_domains
      WHERE site_id = ${site.id}
      LIMIT 1
    `;

    if (existing) {
      // Just update geo_sites to point at the team
      await sql`
        UPDATE geo_sites
        SET team_id = ${member.team_id}, user_id = ${member.user_id}
        WHERE id = ${site.id}
      `;
      console.log(`  RELINK ${site.domain} → team ${member.team_id} (domain row existed)`);
    } else {
      // Full link: update geo_sites + insert teamDomains
      await sql`
        UPDATE geo_sites
        SET team_id = ${member.team_id}, user_id = ${member.user_id}
        WHERE id = ${site.id}
      `;

      const nanoid = (await import("nanoid")).nanoid;
      await sql`
        INSERT INTO team_domains (id, team_id, site_id, domain, added_by_user_id, created_at)
        VALUES (
          ${nanoid()},
          ${member.team_id},
          ${site.id},
          ${site.domain},
          ${member.user_id},
          NOW()
        )
        ON CONFLICT DO NOTHING
      `;
      console.log(`  LINKED ${site.domain} → team ${member.team_id}`);
    }

    linked++;
  }

  console.log(`\nDone: ${linked} linked, ${skipped} skipped`);
}

main().catch((err) => { console.error(err); process.exit(1); });
