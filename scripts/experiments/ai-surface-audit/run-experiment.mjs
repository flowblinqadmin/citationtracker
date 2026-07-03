#!/usr/bin/env node
/**
 * run-experiment.mjs — AI Shopping Surface Ranking Factor Experiment
 *
 * Audits 5 AI shopping surfaces to reverse-engineer what signals determine
 * merchant/product visibility. Cross-references with FlowBlinq instrumentability.
 *
 * Usage:
 *   node --env-file=.env.local scripts/experiments/ai-surface-audit/run-experiment.mjs
 *
 * Options:
 *   --merchants N          Limit to first N merchants (default: all)
 *   --surfaces S1,S2       Comma-separated surface filter (default: all)
 *   --skip-crawl           Skip signal extraction (use cached signals.json)
 *   --skip-probes          Skip surface probing (use cached probes.json)
 *   --output DIR           Output directory (default: scripts/experiments/ai-surface-audit/results/)
 *   --queries-per-vertical N  Queries per vertical (default: 5)
 *
 * Required env vars:
 *   OPENAI_API_KEY, PERPLEXITY_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY
 *   FIRECRAWL_API_KEY (for signal extraction)
 *   BRAVE_API_KEY (optional, for Rufus simulation)
 *   TOGETHER_API_KEY (optional, for Meta AI via Llama 4)
 *
 * Cost estimate (full run, 20 merchants):
 *   Signal extraction: ~$2 (Firecrawl, 100 pages)
 *   Surface probes: ~$8 (5 surfaces × 20 merchants × 5 queries = 500 API calls)
 *   Total: ~$10 per full run
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SURFACES, probeMerchant } from "./surface-probes.mjs";
import { crawlAndExtractSignals } from "./signal-extractor.mjs";
import {
  computeCorrelations, buildInstrumentabilityMatrix, buildCrossSurfaceSummary,
  generateReport, generateMarkdownReport, generateMerchantProfileMd,
  generateSurfaceDeepDiveMd,
} from "./correlator.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Parse CLI args ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    merchantLimit: null,
    surfaceFilter: null,
    skipCrawl: false,
    skipProbes: false,
    outputDir: join(__dirname, "results"),
    queriesPerVertical: 5,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--merchants":
        opts.merchantLimit = parseInt(args[++i], 10);
        break;
      case "--surfaces":
        opts.surfaceFilter = args[++i].split(",");
        break;
      case "--skip-crawl":
        opts.skipCrawl = true;
        break;
      case "--skip-probes":
        opts.skipProbes = true;
        break;
      case "--output":
        opts.outputDir = args[++i];
        break;
      case "--queries-per-vertical":
        opts.queriesPerVertical = parseInt(args[++i], 10);
        break;
    }
  }

  return opts;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const startTime = Date.now();

  console.log("═".repeat(60));
  console.log("  AI Shopping Surface Ranking Factor Experiment");
  console.log("═".repeat(60));
  console.log("");

  // Load cohort and queries
  const cohort = JSON.parse(readFileSync(join(__dirname, "merchant-cohort.json"), "utf-8"));
  const queryBank = JSON.parse(readFileSync(join(__dirname, "shopping-queries.json"), "utf-8"));

  let merchants = cohort.cohort;
  if (opts.merchantLimit) {
    merchants = merchants.slice(0, opts.merchantLimit);
  }

  console.log(`Merchants: ${merchants.length}`);
  console.log(`Surfaces: ${opts.surfaceFilter ? opts.surfaceFilter.join(", ") : "all 5"}`);
  console.log(`Queries per vertical: ${opts.queriesPerVertical}`);
  console.log("");

  // Ensure output directory
  mkdirSync(opts.outputDir, { recursive: true });

  // ── Phase 1: Signal Extraction ───────────────────────────────────────────

  let signalData;
  const signalCachePath = join(opts.outputDir, "signals.json");

  if (opts.skipCrawl && existsSync(signalCachePath)) {
    console.log("Phase 1: Loading cached signals...");
    signalData = JSON.parse(readFileSync(signalCachePath, "utf-8"));
  } else {
    console.log("Phase 1: Extracting signals from merchant sites...");
    signalData = {};

    for (const merchant of merchants) {
      try {
        console.log(`\n[${Object.keys(signalData).length + 1}/${merchants.length}] ${merchant.domain}`);
        const signals = await crawlAndExtractSignals(merchant.domain);
        signalData[merchant.domain] = signals;

        // Save incrementally
        writeFileSync(signalCachePath, JSON.stringify(signalData, null, 2));
      } catch (e) {
        console.error(`  ERROR extracting signals from ${merchant.domain}: ${e.message}`);
        signalData[merchant.domain] = { domain: merchant.domain, error: e.message };
      }
    }
    console.log(`\nPhase 1 complete. ${Object.keys(signalData).length} merchants crawled.`);
  }

  // ── Phase 2: Surface Probing ─────────────────────────────────────────────

  let probeData;
  const probeCachePath = join(opts.outputDir, "probes.json");

  if (opts.skipProbes && existsSync(probeCachePath)) {
    console.log("\nPhase 2: Loading cached probe results...");
    probeData = JSON.parse(readFileSync(probeCachePath, "utf-8"));
  } else {
    console.log("\nPhase 2: Probing AI shopping surfaces...");
    probeData = {};

    for (const merchant of merchants) {
      const vertical = merchant.vertical;
      const queries = (queryBank.queries[vertical] || []).slice(0, opts.queriesPerVertical);

      if (queries.length === 0) {
        console.log(`  Skipping ${merchant.domain}: no queries for vertical '${vertical}'`);
        continue;
      }

      try {
        console.log(`\n[${Object.keys(probeData).length + 1}/${merchants.length}] ${merchant.domain} (${vertical}, ${queries.length} queries)`);
        const results = await probeMerchant(merchant.domain, queries);

        // Filter surfaces if specified
        const filtered = opts.surfaceFilter
          ? results.filter(r => opts.surfaceFilter.includes(r.surface))
          : results;

        probeData[merchant.domain] = filtered;

        // Save incrementally
        writeFileSync(probeCachePath, JSON.stringify(probeData, null, 2));

        // Print quick summary
        for (const r of filtered) {
          const emoji = r.visibilityScore >= 60 ? "🟢" : r.visibilityScore >= 20 ? "🟡" : "🔴";
          console.log(`  ${emoji} ${r.label}: ${r.visibilityScore}% (${r.mentionCount}/${r.totalQueries} mentions)`);
        }
      } catch (e) {
        console.error(`  ERROR probing ${merchant.domain}: ${e.message}`);
        probeData[merchant.domain] = [];
      }

      // Rate limit between merchants
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log(`\nPhase 2 complete. ${Object.keys(probeData).length} merchants probed.`);
  }

  // ── Phase 3: Correlation Analysis ────────────────────────────────────────

  console.log("\nPhase 3: Computing correlations...");

  // Build merged data structure
  const mergedMerchants = merchants
    .filter(m => signalData[m.domain] && !signalData[m.domain].error && probeData[m.domain])
    .map(m => ({
      domain: m.domain,
      vertical: m.vertical,
      platform: m.platform,
      signals: signalData[m.domain],
      visibility: probeData[m.domain].map(v => ({
        surface: v.surface,
        visibilityScore: v.visibilityScore,
        mentionCount: v.mentionCount,
        avgPosition: v.avgPosition,
      })),
    }));

  if (mergedMerchants.length < 5) {
    console.error(`\nInsufficient data: only ${mergedMerchants.length} merchants have both signals and probes.`);
    console.error("Need at least 5 for meaningful correlation. Run without --skip-crawl and --skip-probes.");
    process.exit(1);
  }

  const correlations = computeCorrelations(mergedMerchants);
  const instrumentability = buildInstrumentabilityMatrix(correlations);
  const crossSurface = buildCrossSurfaceSummary(correlations);

  // ── Phase 4: Generate Reports ────────────────────────────────────────────

  console.log("\nPhase 4: Generating reports...");

  const dateStr = new Date().toISOString().split("T")[0];

  // Deliverables directories
  const cofounderDeliverables = "/Users/adithya/Code/Cofounder/deliverables/tech";
  const geoResultsDir = opts.outputDir;
  const merchantProfilesDir = join(geoResultsDir, "merchant-profiles");
  const surfaceDivesDir = join(geoResultsDir, "surface-deep-dives");
  mkdirSync(merchantProfilesDir, { recursive: true });
  mkdirSync(surfaceDivesDir, { recursive: true });
  mkdirSync(cofounderDeliverables, { recursive: true });

  // 1. Plain text report (legacy)
  const report = generateReport(correlations, instrumentability, crossSurface, mergedMerchants);
  const reportPath = join(geoResultsDir, `ranking-factors-${dateStr}.txt`);
  writeFileSync(reportPath, report);
  console.log(`  TXT report: ${reportPath}`);

  // 2. Master markdown report
  const mdReport = generateMarkdownReport(correlations, instrumentability, crossSurface, mergedMerchants);
  const mdPath = join(geoResultsDir, `ranking-factors-${dateStr}.md`);
  writeFileSync(mdPath, mdReport);
  console.log(`  MD report: ${mdPath}`);

  // Copy master report to Cofounder deliverables
  const cofounderMdPath = join(cofounderDeliverables, `ai-surface-ranking-factors-${dateStr}.md`);
  writeFileSync(cofounderMdPath, mdReport);
  console.log(`  Cofounder deliverable: ${cofounderMdPath}`);

  // 3. Per-merchant signal profiles
  for (const m of mergedMerchants) {
    const profileMd = generateMerchantProfileMd(m);
    const profilePath = join(merchantProfilesDir, `${m.domain.replace(/\./g, "-")}.md`);
    writeFileSync(profilePath, profileMd);
  }
  console.log(`  Merchant profiles: ${merchantProfilesDir}/ (${mergedMerchants.length} files)`);

  // 4. Per-surface deep dives
  for (const [surfaceName, surfaceData] of Object.entries(correlations)) {
    const diveMd = generateSurfaceDeepDiveMd(surfaceName, surfaceData, instrumentability);
    const divePath = join(surfaceDivesDir, `${surfaceName}.md`);
    writeFileSync(divePath, diveMd);
  }
  console.log(`  Surface deep dives: ${surfaceDivesDir}/ (${Object.keys(correlations).length} files)`);

  // 5. Machine-readable JSON
  const fullResults = {
    meta: {
      experimentDate: new Date().toISOString(),
      merchantCount: mergedMerchants.length,
      surfaceCount: Object.keys(correlations).length,
      runtime: `${Math.round((Date.now() - startTime) / 1000)}s`,
    },
    correlations,
    instrumentability,
    crossSurfaceSummary: crossSurface,
    merchantScores: mergedMerchants.map(m => ({
      domain: m.domain,
      vertical: m.vertical,
      platform: m.platform,
      signalSummary: {
        schemaScore: m.signals.schemaScore,
        contentScore: m.signals.contentScore,
        freshnessScore: m.signals.freshnessScore,
        reviewPlatformCount: m.signals.reviewPlatformCount,
        hasLlmsTxt: m.signals.hasLlmsTxt,
        allowsAIBots: m.signals.allowsAIBots,
      },
      visibility: m.visibility,
    })),
  };

  const jsonPath = join(geoResultsDir, `ranking-factors-${dateStr}.json`);
  writeFileSync(jsonPath, JSON.stringify(fullResults, null, 2));
  console.log(`  JSON: ${jsonPath}`);

  // 6. Append to tracking history (cumulative over time)
  appendTrackingHistory(geoResultsDir, cofounderDeliverables, dateStr, mergedMerchants, correlations, crossSurface, instrumentability);

  // Print summary
  console.log("\n" + "═".repeat(60));
  console.log("  EXPERIMENT COMPLETE");
  console.log("═".repeat(60));
  console.log(`  Runtime: ${Math.round((Date.now() - startTime) / 1000)}s`);
  console.log(`  Merchants: ${mergedMerchants.length}`);
  console.log(`  Surfaces: ${Object.keys(correlations).length}`);
  console.log("");

  // Top 5 findings
  console.log("  TOP 5 RANKING FACTORS (cross-surface):");
  for (const sig of crossSurface.slice(0, 5)) {
    console.log(`    ${sig.label}: avg r=${sig.avgCorrelation > 0 ? "+" : ""}${sig.avgCorrelation.toFixed(3)} (${sig.consistency}% consistent)`);
  }

  console.log("");
  console.log("  TOP 5 FLOWBLINQ OPPORTUNITIES:");
  for (const opp of instrumentability.slice(0, 5)) {
    console.log(`    ${opp.signal} on ${opp.surface} (impact: ${opp.impactScore}, effort: ${opp.effort})`);
  }

  console.log("");
  console.log("  FILES GENERATED:");
  console.log(`    ${mdPath}`);
  console.log(`    ${cofounderMdPath}`);
  console.log(`    ${merchantProfilesDir}/ (${mergedMerchants.length} profiles)`);
  console.log(`    ${surfaceDivesDir}/ (${Object.keys(correlations).length} deep dives)`);
  console.log(`    ${join(geoResultsDir, "tracking-history.md")} (cumulative)`);
  console.log("");
}

// ── Tracking history (cumulative across runs) ────────────────────────────────

function appendTrackingHistory(geoResultsDir, cofounderDeliverables, dateStr, merchants, correlations, crossSurface, instrumentability) {
  const historyPath = join(geoResultsDir, "tracking-history.md");
  const cofounderHistoryPath = join(cofounderDeliverables, "ai-surface-ranking-tracking.md");

  // Build this run's entry
  const entry = [];
  entry.push(`## Run: ${dateStr}`);
  entry.push("");
  entry.push(`**Merchants:** ${merchants.length} | **Surfaces:** ${Object.keys(correlations).length}`);
  entry.push("");

  // Per-surface avg visibility
  entry.push("### Surface Visibility Averages");
  entry.push("");
  entry.push("| Surface | Avg Visibility |");
  entry.push("|---------|---------------|");
  for (const [surface, data] of Object.entries(correlations)) {
    entry.push(`| ${surface} | ${data.avgVisibility}% |`);
  }
  entry.push("");

  // Per-merchant visibility
  entry.push("### Merchant Scores");
  entry.push("");
  entry.push("| Domain | ChatGPT | Perplexity | Google | Meta AI | Rufus | Avg |");
  entry.push("|--------|---------|------------|--------|---------|-------|-----|");
  const sorted = [...merchants].sort((a, b) => {
    const avgA = a.visibility.reduce((s, v) => s + v.visibilityScore, 0) / a.visibility.length;
    const avgB = b.visibility.reduce((s, v) => s + v.visibilityScore, 0) / b.visibility.length;
    return avgB - avgA;
  });
  for (const m of sorted) {
    const scores = {};
    for (const v of m.visibility) scores[v.surface] = v.visibilityScore;
    const avg = Math.round(m.visibility.reduce((s, v) => s + v.visibilityScore, 0) / m.visibility.length);
    entry.push(`| ${m.domain} | ${scores.chatgpt_shopping ?? 0}% | ${scores.perplexity_shopping ?? 0}% | ${scores.google_ai_overview ?? 0}% | ${scores.meta_ai ?? 0}% | ${scores.amazon_rufus ?? 0}% | **${avg}%** |`);
  }
  entry.push("");

  // Top 5 factors
  entry.push("### Top Ranking Factors");
  entry.push("");
  for (const sig of crossSurface.slice(0, 5)) {
    const dir = sig.avgCorrelation > 0 ? "+" : "";
    entry.push(`- **${sig.label}**: avg r=${dir}${sig.avgCorrelation.toFixed(3)} (${sig.consistency}% consistent)`);
  }
  entry.push("");

  // Top 5 FlowBlinq opportunities
  entry.push("### Top FlowBlinq Opportunities");
  entry.push("");
  for (const opp of instrumentability.slice(0, 5)) {
    entry.push(`- **${opp.signal}** on ${opp.surface} (impact: ${opp.impactScore}, effort: ${opp.effort})`);
  }
  entry.push("");
  entry.push("---");
  entry.push("");

  const entryStr = entry.join("\n");

  // Read existing history or create header
  let existingHistory = "";
  try {
    existingHistory = readFileSync(historyPath, "utf-8");
  } catch {
    existingHistory = `# AI Shopping Surface Ranking — Tracking History\n\nCumulative results from recurring experiment runs. Each entry records per-surface visibility averages, per-merchant scores, and top ranking factors. Compare across runs to detect shifts in AI surface behavior.\n\n---\n\n`;
  }

  // Append new entry
  const updatedHistory = existingHistory + entryStr;
  writeFileSync(historyPath, updatedHistory);

  // Mirror to Cofounder deliverables
  writeFileSync(cofounderHistoryPath, updatedHistory);

  console.log(`  Tracking history updated: ${historyPath}`);
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
