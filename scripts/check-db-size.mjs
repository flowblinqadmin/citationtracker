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

const [dbSize] = await sql`SELECT pg_size_pretty(pg_database_size(current_database())) as size`;
console.log("Total DB size:", dbSize.size);

const tableSizes = await sql`
  SELECT relname as table, pg_size_pretty(pg_total_relation_size(relid)) as size,
    pg_total_relation_size(relid) as bytes
  FROM pg_catalog.pg_statio_user_tables
  ORDER BY pg_total_relation_size(relid) DESC
`;
tableSizes.forEach(t => console.log(`  ${t.table}: ${t.size}`));

const [siteCount] = await sql`SELECT COUNT(*) as count FROM geo_sites`;
const [completedCount] = await sql`SELECT COUNT(*) as count FROM geo_sites WHERE pipeline_status = 'complete'`;
const [avgSize] = await sql`
  SELECT pg_size_pretty(AVG(pg_column_size(geo_scorecard) + pg_column_size(generated_llms_txt) + pg_column_size(generated_schema_blocks))) as avg
  FROM geo_sites WHERE pipeline_status = 'complete'
`;
console.log(`\nTotal sites: ${siteCount.count}, completed: ${completedCount.count}`);
console.log(`Avg completed site payload size: ${avgSize.avg}`);
