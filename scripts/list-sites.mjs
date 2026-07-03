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
const rows = await sql`SELECT id, domain, owner_email, pipeline_status, team_id FROM geo_sites ORDER BY created_at DESC`;
rows.forEach(r => console.log(`${r.owner_email} | ${r.domain} | ${r.pipeline_status} | teamId=${r.team_id}`));
