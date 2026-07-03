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
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL_UNPOOLED);

console.log("=== teams ===");
const teams = await sql`SELECT id, name, owner_user_id, credit_balance FROM teams`;
teams.forEach(t => console.log(t.id, t.name, t.owner_user_id, t.credit_balance));

console.log("\n=== team_members ===");
const members = await sql`SELECT id, team_id, user_id, email, role FROM team_members`;
members.forEach(m => console.log(m.team_id, m.user_id, m.email, m.role));

console.log("\n=== team_domains ===");
const domains = await sql`SELECT td.team_id, td.domain, td.site_id FROM team_domains td ORDER BY td.team_id`;
domains.forEach(d => console.log(d.team_id, d.domain, d.site_id));
