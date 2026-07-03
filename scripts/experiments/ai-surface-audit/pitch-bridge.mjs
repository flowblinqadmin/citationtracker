#!/usr/bin/env node
/**
 * pitch-bridge.mjs — Bridge experiment results to pitchgen pipeline
 *
 * Takes AI surface experiment data (signals + visibility) for each merchant
 * and generates GEO audit JSON files compatible with the pitchgen system.
 * Then calls pitchgen to produce HTML pitch decks.
 *
 * Usage:
 *   node --env-file=.env.local scripts/experiments/ai-surface-audit/pitch-bridge.mjs
 *   node --env-file=.env.local scripts/experiments/ai-surface-audit/pitch-bridge.mjs --domain apollohospitals.com
 *   node --env-file=.env.local scripts/experiments/ai-surface-audit/pitch-bridge.mjs --tier lookalike --vertical healthcare
 *
 * Requires: Python 3 + pitchgen at /Users/adithya/Code/Cofounder/tools/pitchgen/
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");
const AUDIT_DIR = join(RESULTS_DIR, "audit-jsons");
const PITCH_DIR = join(RESULTS_DIR, "pitches");
const PITCHGEN = "/Users/adithya/Code/Cofounder/tools/pitchgen/generate_pitch.py";

mkdirSync(AUDIT_DIR, { recursive: true });
mkdirSync(PITCH_DIR, { recursive: true });

// ── Vertical → pitchgen industry mapping ─────────────────────────────────────

const VERTICAL_TO_INDUSTRY = {
  healthcare: "healthcare",
  bespoke_tailoring: "ecommerce",
  electronics_repair: "ecommerce",
  pr_agency: "saas",
  cloud_finops: "saas",
  snack_brand: "ecommerce",
  mortgage_broker: "fintech",
  wellness: "healthcare",
  social_media_agency: "saas",
  office_supplies: "ecommerce",
};

// ── Convert experiment signals to pitchgen-compatible GEO audit JSON ─────────

function buildAuditJson(merchant, signals, visibility) {
  const domain = merchant.domain;
  const score = signals?.overallScore ?? signals?.schemaScore ?? merchant.geoScore ?? 0;
  const pagesAudited = signals?.totalPages ?? signals?.crawledPages ?? 20;

  // Build issues from signal gaps
  const issues = [];

  if (signals) {
    if (!signals.hasProductSchema && !signals.hasOrgSchema) {
      issues.push({
        name: "No machine-readable business identity",
        severity: "high",
        time_estimate: "30 min",
        description: "AI tools cannot identify what this business does, where it operates, or what services it offers.",
      });
    }
    if (!signals.hasReviewSchema && !signals.hasAnyReviews) {
      issues.push({
        name: "No review or rating signals for AI",
        severity: "high",
        time_estimate: "1 hour",
        description: "AI shopping agents cannot cite customer reviews or ratings when recommending this business.",
      });
    }
    if (!signals.hasFAQSchema && !signals.hasFAQContent) {
      issues.push({
        name: "No FAQ content formatted for AI",
        severity: "medium",
        time_estimate: "2 hours",
        description: "Missing FAQ content means AI cannot answer common questions about the business directly.",
      });
    }
    if (!signals.hasLlmsTxt) {
      issues.push({
        name: "No AI context file (llms.txt)",
        severity: "medium",
        time_estimate: "15 min",
        description: "No llms.txt file to guide AI crawlers on what the business does and what pages matter.",
      });
    }
    if (signals.allowsAIBots === false) {
      issues.push({
        name: "AI bots blocked in robots.txt",
        severity: "high",
        time_estimate: "5 min",
        description: "The site actively blocks AI crawlers, making it invisible to AI shopping platforms.",
      });
    }
    if (signals.freshnessScore !== undefined && signals.freshnessScore < 50) {
      issues.push({
        name: "Outdated content — no current year mentions",
        severity: "medium",
        time_estimate: "1 hour",
        description: "Content appears stale. AI platforms favor fresh, recently updated information.",
      });
    }
    if (!signals.hasShippingInfo && !signals.hasReturnPolicy) {
      issues.push({
        name: "No shipping or return policy visible to AI",
        severity: "low",
        time_estimate: "30 min",
        description: "AI shopping agents look for commerce trust signals like shipping and return information.",
      });
    }
  }

  // Add visibility data as context
  const visibilitySummary = {};
  if (visibility) {
    for (const v of visibility) {
      visibilitySummary[v.surface] = `${v.visibilityScore}%`;
    }
  }

  // Compute projected score
  const projectedScore = Math.min(100, score + Math.round(issues.length * 8));

  return {
    domain,
    score: Math.round(score),
    max_score: 100,
    pages_audited: pagesAudited,
    audit_date: new Date().toISOString().split("T")[0],
    issues,
    projected_score_after_fixes: `${projectedScore}+`,
    ai_surface_visibility: visibilitySummary,
    competitor_visibility: merchant.competitors || [],
  };
}

// ── Generate pitch for a single merchant ─────────────────────────────────────

function generatePitchForMerchant(merchant, signals, visibility) {
  const domain = merchant.domain;
  const slug = domain.replace(/\./g, "-");
  const industry = VERTICAL_TO_INDUSTRY[merchant.vertical] || "ecommerce";

  // 1. Write audit JSON
  const auditJson = buildAuditJson(merchant, signals, visibility);
  const auditPath = join(AUDIT_DIR, `${slug}.json`);
  writeFileSync(auditPath, JSON.stringify(auditJson, null, 2));
  console.log(`  Audit JSON: ${auditPath}`);

  // 2. Build customer name from domain
  const customerName = domain
    .replace(/\.(com|com\.au|in|au|org|io|co|net|sh|app)$/, "")
    .replace(/^www\./, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());

  // 3. Call pitchgen
  const outputPath = join(PITCH_DIR, `${slug}-pitch.html`);
  const cmd = `cd /Users/adithya/Code/Cofounder/tools/pitchgen && python3 generate_pitch.py --customer "${customerName}" --industry ${industry} --geo-audit "${auditPath}" --output "${outputPath}"`;

  console.log(`  Generating pitch for ${customerName} (${industry})...`);
  try {
    const output = execSync(cmd, {
      timeout: 120000,
      encoding: "utf-8",
      env: { ...process.env },
    });
    console.log(`  ${output.trim().split("\n").pop()}`);
    return outputPath;
  } catch (e) {
    console.error(`  ERROR: ${e.message.split("\n").slice(0, 3).join("\n")}`);
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let filterDomain = null;
  let filterTier = null;
  let filterVertical = null;
  let maxPitches = 5;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--domain": filterDomain = args[++i]; break;
      case "--tier": filterTier = args[++i]; break;
      case "--vertical": filterVertical = args[++i]; break;
      case "--max": maxPitches = parseInt(args[++i], 10); break;
    }
  }

  // Load cohort
  const cohort = JSON.parse(readFileSync(join(__dirname, "merchant-cohort.json"), "utf-8"));

  // Load cached signals and probes if available
  let signals = {};
  let probes = {};
  try { signals = JSON.parse(readFileSync(join(RESULTS_DIR, "signals.json"), "utf-8")); } catch {}
  try { probes = JSON.parse(readFileSync(join(RESULTS_DIR, "probes.json"), "utf-8")); } catch {}

  // Also check test-run results
  try {
    const testRun = JSON.parse(readFileSync(join(RESULTS_DIR, "test-run-healthcare.json"), "utf-8"));
    for (const r of testRun.results || []) {
      if (r.signals && !signals[r.domain]) signals[r.domain] = r.signals;
    }
  } catch {}

  // Filter merchants
  let merchants = cohort.cohort;
  if (filterDomain) merchants = merchants.filter(m => m.domain === filterDomain);
  if (filterTier) merchants = merchants.filter(m => m.tier === filterTier);
  if (filterVertical) merchants = merchants.filter(m => m.vertical === filterVertical);
  merchants = merchants.slice(0, maxPitches);

  console.log(`\n═════════════════════════════════════════════════`);
  console.log(`  Pitch Generation — ${merchants.length} merchants`);
  console.log(`═════════════════════════════════════════════════\n`);

  const generated = [];
  for (const merchant of merchants) {
    console.log(`\n── ${merchant.domain} (${merchant.tier}) ──`);
    const sig = signals[merchant.domain] || null;
    const vis = probes[merchant.domain] || null;
    const path = generatePitchForMerchant(merchant, sig, vis);
    if (path) generated.push({ domain: merchant.domain, path });
  }

  // Summary
  console.log(`\n═════════════════════════════════════════════════`);
  console.log(`  Generated ${generated.length}/${merchants.length} pitches`);
  console.log(`  Output: ${PITCH_DIR}/`);
  for (const g of generated) {
    console.log(`    ${g.domain} → ${g.path.split("/").pop()}`);
  }
  console.log(`═════════════════════════════════════════════════\n`);
}

main();
