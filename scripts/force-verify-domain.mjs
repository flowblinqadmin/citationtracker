/**
 * Manually mark a domain as verified in the database.
 * Run: node --env-file=.env.local scripts/force-verify-domain.mjs <domain>
 */
import { neon } from "@neondatabase/serverless";

const domain = process.argv[2];
if (!domain) {
  console.error("Usage: node --env-file=.env.local scripts/force-verify-domain.mjs <domain>");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL_UNPOOLED);

const [site] = await sql`SELECT id, domain, domain_verified FROM geo_sites WHERE domain = ${domain}`;
if (!site) {
  console.error(`No site found for domain: ${domain}`);
  process.exit(1);
}

console.warn(`Found site ${site.id} (${site.domain}) — domain_verified: ${site.domain_verified}`);

await sql`UPDATE geo_sites SET domain_verified = true, updated_at = NOW() WHERE id = ${site.id}`;

console.warn(`✓ domain_verified set to true for ${domain}`);
