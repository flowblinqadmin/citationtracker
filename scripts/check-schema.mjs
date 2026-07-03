import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL_UNPOOLED);
const domain = process.argv[2] || "scaleunlock.com";
const [r] = await sql`SELECT domain, pipeline_status, generated_schema_blocks FROM geo_sites WHERE domain = ${domain}`;
if (!r) { console.error("not found"); process.exit(1); }
console.warn("status:", r.pipeline_status);
console.warn(JSON.stringify(r.generated_schema_blocks, null, 2));
