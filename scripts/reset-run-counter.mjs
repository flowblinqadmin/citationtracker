import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL_UNPOOLED);
const domain = process.argv[2];
if (!domain) { console.error("Usage: node --env-file=.env.local scripts/reset-run-counter.mjs <domain>"); process.exit(1); }
const [r] = await sql`SELECT id, domain, manual_runs_this_month FROM geo_sites WHERE domain = ${domain}`;
if (!r) { console.error("not found"); process.exit(1); }
console.warn(`Resetting run counter for ${r.domain} (was: ${r.manual_runs_this_month})`);
await sql`UPDATE geo_sites SET manual_runs_this_month = 0, manual_runs_reset_at = NOW(), updated_at = NOW() WHERE id = ${r.id}`;
console.warn("Done.");
