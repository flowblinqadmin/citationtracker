import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL_UNPOOLED);
const domain = process.argv[2];
if (!domain) { console.error("Usage: node --env-file=.env.local scripts/trigger-pipeline.mjs <domain>"); process.exit(1); }
const [r] = await sql`SELECT id, domain, access_token, pipeline_status FROM geo_sites WHERE domain = ${domain}`;
if (!r) { console.error("not found"); process.exit(1); }
console.warn(`Site: ${r.domain} | status: ${r.pipeline_status} | token: ${r.access_token}`);

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://geo.flowblinq.com";
const url = `${appUrl}/api/sites/${r.id}/regenerate`;
console.warn(`POST ${url}`);
const res = await fetch(url, {
  method: "POST",
  headers: { "Authorization": `Bearer ${r.access_token}`, "Content-Type": "application/json" },
});
const body = await res.json();
console.warn(`Response ${res.status}:`, JSON.stringify(body));
