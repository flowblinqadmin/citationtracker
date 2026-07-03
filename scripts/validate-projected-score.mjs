/**
 * Validate computeProjectedScore() against real DB data.
 *
 * Usage:
 *   DATABASE_URL_UNPOOLED=... node scripts/validate-projected-score.mjs
 *
 * Shows per-pillar boosts for each site that has generated assets,
 * so we can verify the quality+coverage formula gives honest deltas.
 */
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL_UNPOOLED);

// Replicate PILLAR_CEILINGS from assembler.ts
const PILLAR_CEILINGS = {
  licensing_signals:   95,
  structured_data:     88,
  faq_coverage:        85,
  entity_definitions:  80,
  contact_trust:       78,
  metadata_freshness:  78,
  evidence_statistics: 75,
  author_authority:    68,
  content_structure:   72,
};

// Replicate GEO_PILLAR_WEIGHTS from assembler.ts (match geo-analyzer)
const GEO_PILLAR_WEIGHTS = {
  author_authority:         4.9,
  faq_coverage:             4.5,
  structured_data:          4.6,
  content_structure:        4.1,
  contact_trust:            4.3,
  evidence_statistics:      4.0,
  metadata_freshness:       3.7,
  entity_definitions:       3.6,
  semantic_html:            3.2,
  internal_linking:         2.8,
  multi_format:             2.6,
  licensing_signals:        2.5,
  cta_structure:            2.4,
  competitive_positioning:  2.1,
  content_freshness:        1.9,
  brand_authority:          1.8,
};

function computeBoosts(sc, llmsTxt, llmsFullTxt, schemaBlocks, businessJson) {
  const schemaTypes = new Set(schemaBlocks.map(b => b.type));
  const geoProfile = businessJson?.geo_profile ?? {};

  const hasOrganizationSchema = schemaTypes.has("Organization");
  const hasBreadcrumbSchema   = schemaTypes.has("BreadcrumbList");
  const hasFaqPageSchema      = schemaTypes.has("FAQPage");
  const hasArticleSchema      = schemaTypes.has("Article");
  const hasPersonSchema       = schemaTypes.has("Person");
  const hasDefinedTermSchema  = schemaTypes.has("DefinedTerm");
  const hasRobotsTxtBlock     = schemaTypes.has("RobotsTxt");
  const hasSpeakableSchema    = schemaTypes.has("WebPage") &&
    schemaBlocks.some(b => b.type === "WebPage" && b.name?.toLowerCase().includes("speakable"));
  const hasLlmsTxt            = llmsTxt.length > 200;
  const hasLlmsFullTxt        = llmsFullTxt.length > 200;
  const hasKeyConceptsDefs    = /## Key Concepts/i.test(llmsTxt) &&
    (llmsTxt.includes("is a") || llmsTxt.includes("refers to"));
  const hasTeamSection        = /## Team/i.test(llmsTxt) || /## Team/i.test(llmsFullTxt);
  const hasPersonProfiles     = Array.isArray(geoProfile.author_profiles) &&
    geoProfile.author_profiles.length > 0;
  const hasEditorialStandards = typeof geoProfile.editorial_standards === "object" &&
    geoProfile.editorial_standards !== null;
  const hasEvidenceSection    = /## Evidence/i.test(llmsFullTxt);
  const hasBusinessJson       = Object.keys(businessJson ?? {}).length >= 4;

  const pillarBoosts = {};

  // structured_data
  {
    const articleCount   = schemaBlocks.filter(b => b.type === "Article").length;
    const faqSchemaCount = schemaBlocks.filter(b => b.type === "FAQPage").length;
    let boost = 0;
    if (hasOrganizationSchema) boost += 6;
    if (hasBreadcrumbSchema)   boost += 4;
    if (hasSpeakableSchema)    boost += 2;
    if (faqSchemaCount >= 1)   boost += 5;
    if (faqSchemaCount >= 3)   boost += 3;
    if (articleCount >= 1)     boost += 3;
    if (articleCount >= 5)     boost += 3;
    if (hasDefinedTermSchema)  boost += 3;
    pillarBoosts["structured_data"] = boost;
  }

  // licensing_signals
  {
    const llmsLineCount  = llmsTxt.split("\n").filter(l => l.trim()).length;
    const llmsHasSections = hasLlmsTxt &&
      /## About/i.test(llmsTxt) && /## Key Concepts/i.test(llmsTxt) &&
      /## Products|## Services/i.test(llmsTxt);
    const llmsHasContact  = hasLlmsTxt && /## Contact/i.test(llmsTxt);
    let boost = 0;
    if (hasLlmsTxt && llmsLineCount >= 10) boost += 8;
    if (llmsHasSections)                   boost += 7;
    if (llmsHasContact)                    boost += 3;
    if (hasLlmsFullTxt)                    boost += 8;
    if (hasBusinessJson)                   boost += 5;
    if (hasRobotsTxtBlock)                 boost += 9;
    pillarBoosts["licensing_signals"] = boost;
  }

  // entity_definitions
  {
    const conceptMatches  = llmsTxt.match(/\*\*[^*]+\*\*[:\s]+(?:is (?:a |an |the )|refers to )/gi) ?? [];
    const extractableCount = conceptMatches.length;
    const definedTermCount = schemaBlocks.filter(b => b.type === "DefinedTerm").length;
    let boost = 0;
    if (extractableCount >= 1) boost += 4;
    if (extractableCount >= 3) boost += 4;
    if (extractableCount >= 5) boost += 3;
    if (definedTermCount >= 1) boost += 5;
    if (definedTermCount >= 3) boost += 4;
    pillarBoosts["entity_definitions"] = boost;
  }

  // faq_coverage
  {
    const faqBlocks    = schemaBlocks.filter(b => b.type === "FAQPage");
    const faqBlockCount = faqBlocks.length;
    const totalFaqPairs = faqBlocks.reduce((sum, b) => {
      const main = b.jsonLd?.mainEntity;
      return sum + (Array.isArray(main) ? main.length : 0);
    }, 0);
    let boost = 0;
    if (faqBlockCount >= 1)  boost += 6;
    if (faqBlockCount >= 3)  boost += 5;
    if (faqBlockCount >= 6)  boost += 4;
    if (totalFaqPairs >= 5)  boost += 4;
    if (totalFaqPairs >= 15) boost += 3;
    pillarBoosts["faq_coverage"] = boost;
  }

  // author_authority
  {
    const personBlocks = schemaBlocks.filter(b => b.type === "Person");
    const personCount  = personBlocks.length;
    const personWithLinkedIn = personBlocks.filter(b => {
      const sameAs = b.jsonLd?.sameAs;
      return Array.isArray(sameAs) ? sameAs.some(s => String(s).includes("linkedin")) :
        typeof sameAs === "string" && sameAs.includes("linkedin");
    }).length;
    let boost = 0;
    if (personCount >= 1)        boost += 5;
    if (personCount >= 2)        boost += 3;
    if (personWithLinkedIn >= 1) boost += 4;
    if (hasPersonProfiles)       boost += 3;
    if (hasTeamSection)          boost += 3;
    if (hasEditorialStandards) {
      const certs     = geoProfile.editorial_standards?.certifications;
      const hasCerts  = Array.isArray(certs) && certs.length > 0;
      boost += hasCerts ? 3 : 1;
    }
    pillarBoosts["author_authority"] = boost;
  }

  // contact_trust
  {
    const orgBlock   = schemaBlocks.find(b => b.type === "Organization");
    const orgJld     = orgBlock?.jsonLd ?? {};
    const hasContactPoint = Boolean(orgJld?.contactPoint);
    const hasSameAs  = Array.isArray(orgJld?.sameAs) && orgJld.sameAs.length >= 2;
    const certs      = geoProfile.editorial_standards?.certifications;
    const certCount  = Array.isArray(certs) ? certs.length : 0;
    let boost = 0;
    if (hasOrganizationSchema) boost += 3;
    if (hasContactPoint)       boost += 5;
    if (hasSameAs)             boost += 3;
    if (hasBusinessJson)       boost += 3;
    if (certCount >= 1)        boost += 4;
    if (certCount >= 2)        boost += 2;
    pillarBoosts["contact_trust"] = boost;
  }

  // evidence_statistics
  {
    const evidenceSection = llmsFullTxt.match(/## Evidence[\s\S]*?(?=\n##|$)/i)?.[0] ?? "";
    const sourcedStats    = (evidenceSection.match(/\(Source:/gi) ?? []).length;
    const preciseNumbers  = (evidenceSection.match(/\d+\.?\d*\s*%|\$[\d,]+|\d+[xX]\s/g) ?? []).length;
    let boost = 0;
    if (hasEvidenceSection) boost += 4;
    if (sourcedStats >= 1)  boost += 4;
    if (sourcedStats >= 3)  boost += 3;
    if (preciseNumbers >= 2) boost += 2;
    if (hasLlmsFullTxt)     boost += 2;
    pillarBoosts["evidence_statistics"] = boost;
  }

  // metadata_freshness
  {
    const hasYear         = hasLlmsTxt && /20\d\d/.test(llmsTxt);
    const hasSpecificDate = hasLlmsTxt && /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+20\d\d|20\d\d-\d{2}-\d{2}/i.test(llmsTxt);
    const bizLastUpdated  = businessJson?.last_updated;
    const hasLastUpdated  = typeof bizLastUpdated === "string" && bizLastUpdated.length > 0;
    let boost = 0;
    if (hasYear)         boost += 3;
    if (hasSpecificDate) boost += 3;
    if (hasLastUpdated)  boost += 3;
    pillarBoosts["metadata_freshness"] = boost;
  }

  // content_structure
  {
    const aboutSection  = llmsTxt.match(/## About[\s\S]*?(?=\n##|$)/i)?.[0] ?? "";
    const firstSentence = aboutSection.split(/[.!?]/)[0] ?? "";
    const isAnswerFirst = firstSentence.length > 20 && firstSentence.length < 200;
    let boost = 0;
    if (isAnswerFirst)                    boost += 3;
    if (/## Key Concepts/i.test(llmsTxt)) boost += 2;
    pillarBoosts["content_structure"] = boost;
  }

  return pillarBoosts;
}

function projectedScore(sc, pillarBoosts) {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const pillar of sc.pillars) {
    const weight    = GEO_PILLAR_WEIGHTS[pillar.pillar] ?? 3.0;
    const rawBoost  = pillarBoosts[pillar.pillar] ?? 0;
    const ceiling   = PILLAR_CEILINGS[pillar.pillar] ?? pillar.score;
    const projected = Math.max(pillar.score, Math.min(ceiling, pillar.score + rawBoost));
    totalWeight += weight;
    weightedSum += projected * weight;
  }
  const fromPillars = Math.min(100, Math.round(weightedSum / totalWeight));
  return Math.max(sc.overallScore, fromPillars);
}

// Load sites that have already had assets generated
const rows = await sql`
  SELECT
    domain,
    geo_scorecard,
    generated_llms_txt,
    generated_schema_blocks,
    generated_business_json,
    pipeline_status
  FROM geo_sites
  WHERE geo_scorecard IS NOT NULL
    AND pipeline_status = 'complete'
  ORDER BY updated_at DESC
  LIMIT 10
`;

console.log(`\nValidating projected score across ${rows.length} sites\n`);
console.log("=".repeat(90));

for (const row of rows) {
  const sc           = row.geo_scorecard;
  const llmsTxt      = row.generated_llms_txt     ?? "";
  const llmsFullTxt  = "";  // not stored separately; Evidence section in llmsTxt for existing
  const schemaBlocks = Array.isArray(row.generated_schema_blocks) ? row.generated_schema_blocks : [];
  const businessJson = row.generated_business_json ?? {};

  const boosts       = computeBoosts(sc, llmsTxt, llmsFullTxt, schemaBlocks, businessJson);
  const projected    = projectedScore(sc, boosts);

  // Old blind formula for comparison
  const oldProjected = Math.min(100, Math.round(sc.overallScore * 1.35 + 10));

  console.log(`\n${row.domain}  (current: ${sc.overallScore} | old formula: ${oldProjected} | new formula: ${projected})`);

  // Show per-pillar breakdown for pillars with boosts or notable scores
  const pillarMap = Object.fromEntries(sc.pillars.map(p => [p.pillar, p.score]));
  const boostedPillars = Object.entries(boosts).filter(([, b]) => b > 0);

  if (boostedPillars.length === 0) {
    console.log("  (no generated assets found — no boosts applied)");
  } else {
    for (const [pillar, rawBoost] of boostedPillars) {
      const current  = pillarMap[pillar] ?? 0;
      const ceiling  = PILLAR_CEILINGS[pillar] ?? current;
      const proj     = Math.max(current, Math.min(ceiling, current + rawBoost));
      const delta    = proj - current;
      console.log(`  ${pillar.padEnd(25)} ${String(current).padStart(3)} → ${String(proj).padStart(3)}  (+${delta} boost:${rawBoost} ceil:${ceiling})`);
    }
  }

  // Schema types present
  const types = schemaBlocks.map(b => b.type).join(", ");
  console.log(`  Schema types: [${types || "none"}]`);
  // Key asset presence
  const flags = [
    llmsTxt.length > 200    ? "llms.txt"    : null,
    schemaBlocks.some(b => b.type === "RobotsTxt") ? "robots.txt" : null,
    Object.keys(businessJson).length >= 4 ? "business.json" : null,
  ].filter(Boolean);
  console.log(`  Assets: ${flags.join(", ") || "none"}`);
}

console.log("\n" + "=".repeat(90));
console.log("Done.\n");
