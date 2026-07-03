import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL_UNPOOLED);
const domain = process.argv[2];
if (!domain) { console.error("Usage: node --env-file=.env.local scripts/clear-bad-schema.mjs <domain>"); process.exit(1); }
const [r] = await sql`SELECT id, domain, generated_schema_blocks FROM geo_sites WHERE domain = ${domain}`;
if (!r) { console.error("not found"); process.exit(1); }
console.warn("Clearing schema blocks for", r.domain);
await sql`UPDATE geo_sites SET generated_schema_blocks = NULL, generated_llms_txt = NULL, generated_llms_full_txt = NULL, generated_business_json = NULL, recommendations = NULL, executive_summary = NULL, pipeline_status = 'failed', updated_at = NOW() WHERE id = ${r.id}`;
console.warn("Done — generated files cleared. Site can retry audit when the site is back online.");
