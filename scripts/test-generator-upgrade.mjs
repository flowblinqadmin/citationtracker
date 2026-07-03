/**
 * Test script: compare old vs new generated assets for a site already in the DB.
 *
 * Usage:
 *   DATABASE_URL_UNPOOLED=... OPENAI_API_KEY=... node scripts/test-generator-upgrade.mjs [domain]
 */

import { neon } from "@neondatabase/serverless";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";

const execAsync = promisify(exec);
const domain = process.argv[2] || "healthfutures.io";
const sql = neon(process.env.DATABASE_URL_UNPOOLED);
const CWD = process.cwd();

console.log(`\n=== GEO Generator Upgrade Test: ${domain} ===\n`);

// 1. Load existing data from DB
const [row] = await sql`
  SELECT domain, crawl_data, geo_scorecard, generated_llms_txt, generated_schema_blocks, generated_business_json
  FROM geo_sites
  WHERE domain = ${domain}
  LIMIT 1
`;

if (!row) { console.error(`Site not found: ${domain}`); process.exit(1); }
const { crawl_data: crawlData, geo_scorecard: geoScorecard } = row;
if (!crawlData || !geoScorecard) { console.error("Missing crawl_data or geo_scorecard. Run pipeline first."); process.exit(1); }

console.log(`Loaded: ${crawlData.pages?.length ?? 0} pages, overall score: ${geoScorecard.overallScore}`);
console.log();

// 2. Show OLD state
const oldLlms = row.generated_llms_txt ?? "";
console.log("=== OLD llms.txt — Key Concepts section ===");
const oldConcepts = oldLlms.match(/## Key Concepts[\s\S]*?(?=\n##|$)/)?.[0] ?? "(not found)";
console.log(oldConcepts.substring(0, 800));
console.log();

console.log("=== OLD schema block types ===");
const oldBlocks = Array.isArray(row.generated_schema_blocks) ? row.generated_schema_blocks : [];
console.log(oldBlocks.map(b => b.type).join(", ") || "(none)");
console.log("Total:", oldBlocks.length, "blocks");
console.log();

console.log("=== OLD business.json — geo_profile fields ===");
const oldGeo = row.generated_business_json?.geo_profile ?? {};
console.log("Fields:", Object.keys(oldGeo).join(", "));
console.log("author_profiles:", JSON.stringify(oldGeo.author_profiles ?? "(not present)"));
console.log("editorial_standards:", JSON.stringify(oldGeo.editorial_standards ?? "(not present)"));
console.log();

// 3. Run NEW generator — write runner script inside CWD so relative imports work
const safeDomain = domain.replace(/[^a-z0-9]/gi, "_");
const tmpCrawl   = join(CWD, `scripts/.tmp-crawl-${safeDomain}.json`);
const tmpScore   = join(CWD, `scripts/.tmp-score-${safeDomain}.json`);
const tmpOut     = join(CWD, `scripts/.tmp-out-${safeDomain}.json`);
const tmpRunner  = join(CWD, `scripts/.tmp-runner-${safeDomain}.ts`);

writeFileSync(tmpCrawl, JSON.stringify(crawlData));
writeFileSync(tmpScore, JSON.stringify(geoScorecard));

// Wrap in async IIFE — tsx CJS mode doesn't support top-level await
writeFileSync(tmpRunner, `
import { generateContent } from "../lib/services/content-generator";
import { readFileSync, writeFileSync } from "fs";

(async () => {
  const crawlData = JSON.parse(readFileSync(${JSON.stringify(tmpCrawl)}, "utf8"));
  const geoScorecard = JSON.parse(readFileSync(${JSON.stringify(tmpScore)}, "utf8"));
  const competitiveIntel = { industryContext: "technology", brandPerception: "", competitorGeoStatus: [] };

  const result = await generateContent(${JSON.stringify(domain)}, crawlData, competitiveIntel, geoScorecard);
  writeFileSync(${JSON.stringify(tmpOut)}, JSON.stringify(result, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
`);

console.log("=== RUNNING NEW GENERATOR ===");
console.log("(Makes real OpenAI API calls — ~30 seconds)\n");

const cleanup = () => {
  [tmpCrawl, tmpScore, tmpOut, tmpRunner].forEach(f => { try { if (existsSync(f)) unlinkSync(f); } catch {} });
};

try {
  const { stdout, stderr } = await execAsync(
    `npx tsx "${tmpRunner}"`,
    { cwd: CWD, env: { ...process.env }, timeout: 120000 }
  );
  if (stdout.trim()) console.log("[runner]", stdout.trim());
  if (stderr.trim()) console.error("[stderr]", stderr.substring(0, 300));

  const newResult = JSON.parse(readFileSync(tmpOut, "utf8"));

  // 4. Show NEW state
  const newLlms = newResult.llmsTxt ?? "";

  console.log("=== NEW llms.txt — Key Concepts section ===");
  const newConcepts = newLlms.match(/## Key Concepts[\s\S]*?(?=\n##|$)/)?.[0] ?? "(not found)";
  console.log(newConcepts.substring(0, 1200));
  console.log();

  const newTeam = newLlms.match(/## Team[\s\S]*?(?=\n##|$)/)?.[0];
  if (newTeam) {
    console.log("=== NEW llms.txt — Team section (NEW — author_authority target) ===");
    console.log(newTeam.substring(0, 600));
    console.log();
  }

  const newEvidence = newLlms.match(/## Evidence[\s\S]*?(?=\n##|$)/)?.[0];
  if (newEvidence) {
    console.log("=== NEW llms.txt — Evidence section (NEW — evidence_statistics target) ===");
    console.log(newEvidence.substring(0, 600));
    console.log();
  }

  console.log("=== NEW schema block types ===");
  const newBlocks = Array.isArray(newResult.schemaBlocks) ? newResult.schemaBlocks : [];
  console.log(newBlocks.map(b => b.type).join(", ") || "(none)");
  console.log("Total:", newBlocks.length, "blocks");
  console.log();

  const personBlocks = newBlocks.filter(b => b.type === "Person");
  if (personBlocks.length > 0) {
    console.log("=== NEW Person schema blocks (author_authority target) ===");
    personBlocks.forEach(b => console.log(JSON.stringify(b.jsonLd, null, 2).substring(0, 500)));
    console.log();
  }

  const definedTermBlocks = newBlocks.filter(b => b.type === "DefinedTerm");
  if (definedTermBlocks.length > 0) {
    console.log("=== NEW DefinedTerm schema blocks (entity_definitions target) ===");
    definedTermBlocks.slice(0, 2).forEach(b => console.log(JSON.stringify(b.jsonLd, null, 2).substring(0, 400)));
    console.log();
  }

  const speakableBlock = newBlocks.find(b => b.type === "WebPage" && b.name?.includes("Speakable"));
  if (speakableBlock) {
    console.log("=== NEW SpeakableSpecification block ===");
    console.log(JSON.stringify(speakableBlock.jsonLd, null, 2));
    console.log();
  }

  const robotsBlock = newBlocks.find(b => b.type === "RobotsTxt");
  if (robotsBlock) {
    console.log("=== NEW RobotsTxt block (licensing_signals target) ===");
    console.log(robotsBlock.instructions?.substring(0, 700));
    console.log();
  }

  console.log("=== NEW business.json — geo_profile fields ===");
  const newGeo = newResult.businessJson?.geo_profile ?? {};
  console.log("Fields:", Object.keys(newGeo).join(", "));
  console.log("author_profiles:", JSON.stringify(newGeo.author_profiles ?? "(not present)").substring(0, 400));
  console.log("editorial_standards:", JSON.stringify(newGeo.editorial_standards ?? "(not present)").substring(0, 300));
  console.log();

  console.log("=== SUMMARY ===");
  console.log(`Schema blocks: ${oldBlocks.length} → ${newBlocks.length}`);
  const newTypes = newBlocks.map(b => b.type).filter(t => !["Organization","BreadcrumbList","WebPage","Article","FAQPage"].includes(t));
  console.log("New block types:", newTypes.join(", ") || "(none)");
  console.log("Key Concepts extractable format:", newConcepts.includes("is a") || newConcepts.includes("refers to") ? "✓ YES" : "✗ NO");
  console.log("Team section present:", newTeam ? "✓ YES" : "✗ NO");
  console.log("Evidence section present:", newEvidence ? "✓ YES" : "✗ NO");
  console.log("author_profiles in business.json:", Array.isArray(newGeo.author_profiles) ? `✓ YES (${newGeo.author_profiles.length} profiles)` : "✗ NO");

} catch (err) {
  console.error("Generator run failed:", err.message);
  if (err.stderr) console.error(err.stderr.substring(0, 500));
} finally {
  cleanup();
}
