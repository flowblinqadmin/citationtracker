import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL_UNPOOLED);
const domain = process.argv[2] || "scaleunlock.com";
const [r] = await sql`SELECT id, domain, pipeline_status, pipeline_error, discovery_data, crawl_data, updated_at FROM geo_sites WHERE domain = ${domain}`;
if (!r) { console.error("not found"); process.exit(1); }
console.warn("status:", r.pipeline_status);
console.warn("error:", r.pipeline_error);
console.warn("discovery urls:", r.discovery_data?.urls?.length, JSON.stringify(r.discovery_data?.urls));
console.warn("crawl pages:", r.crawl_data?.pages?.length);
(r.crawl_data?.pages ?? []).forEach(p => console.warn("  page:", p.url, "| content len:", p.content?.length, "| title:", p.title));
console.warn("updated_at:", r.updated_at);
