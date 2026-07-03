import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL_UNPOOLED);
const oldDomain = process.argv[2];
const newDomain = process.argv[3] ?? oldDomain;
if (!oldDomain) { console.error("Usage: node --env-file=.env.local scripts/reset-for-recrawl.mjs <domain> [new-domain]"); process.exit(1); }
const [r] = await sql`SELECT id, domain, slug FROM geo_sites WHERE domain = ${oldDomain}`;
if (!r) { console.error("not found"); process.exit(1); }
console.warn(`Resetting ${r.domain} (id: ${r.id}) → new domain: ${newDomain}`);
await sql`
  UPDATE geo_sites SET
    domain = ${newDomain},
    pipeline_status = 'pending',
    pipeline_error = NULL,
    crawl_data = NULL,
    crawl_job_ids = NULL,
    discovery_data = NULL,
    updated_at = NOW()
  WHERE id = ${r.id}
`;
console.warn("Done — ready to re-run audit.");
