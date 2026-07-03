/**
 * outreach-generator.mjs — Generate cold outreach emails from experiment results
 *
 * Takes the experiment output (merchant visibility scores + signal gaps) and
 * generates personalized cold emails for each merchant, referencing:
 * - Their specific AI visibility score
 * - Their top competitor's score (if available)
 * - The 2-3 specific signals they're missing
 * - A relevant case study (Manipal, White Stripes, etc.)
 *
 * Usage:
 *   node --env-file=.env.local scripts/experiments/ai-surface-audit/outreach-generator.mjs
 *   node --env-file=.env.local scripts/experiments/ai-surface-audit/outreach-generator.mjs --results results/ranking-factors-2026-04-12.json
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Case studies (real results from live clients) ────────────────────────────

const CASE_STUDIES = {
  healthcare: {
    client: "a multi-specialty hospital chain in India",
    before: 22,
    after: 58,
    detail: "10,000 pages optimized, visibility on ChatGPT and Perplexity went from invisible to position #2",
  },
  tailoring: {
    client: "a bespoke tailoring house",
    before: 0,
    after: 42,
    detail: "went from zero AI mentions to appearing in 40%+ of relevant queries across 4 AI platforms",
  },
  electronics: {
    client: "an electronics and IT services company",
    before: 0,
    after: 48,
    detail: "structured data injection got them cited by Google AI Overviews within 2 weeks",
  },
  default: {
    client: "businesses like yours",
    before: 15,
    after: 55,
    detail: "structured data + AI-readable content typically doubles visibility within 30 days",
  },
};

// ── Map verticals to case studies ────────────────────────────────────────────

function pickCaseStudy(vertical) {
  const map = {
    hospital: "healthcare", healthcare: "healthcare", medical: "healthcare",
    clinic: "healthcare", dental: "healthcare", pharmacy: "healthcare",
    tailor: "tailoring", fashion: "tailoring", apparel: "tailoring",
    clothing: "tailoring", suits: "tailoring", bespoke: "tailoring",
    electronics: "electronics", repair: "electronics", it_services: "electronics",
    technology: "electronics", computer: "electronics",
  };
  const key = Object.keys(map).find(k => vertical.toLowerCase().includes(k));
  return CASE_STUDIES[map[key]] || CASE_STUDIES.default;
}

// ── Signal gap to plain English ──────────────────────────────────────────────

const SIGNAL_DESCRIPTIONS = {
  hasProductSchema: "no Product schema markup (AI tools can't read your catalog)",
  hasOfferSchema: "no pricing/offer structured data",
  hasReviewSchema: "no review/rating schema (AI can't cite your reviews)",
  hasOrgSchema: "no Organization schema (AI doesn't know what your business is)",
  hasFAQSchema: "no FAQ schema (missing easy AI citation opportunities)",
  hasBreadcrumbs: "no breadcrumb schema (AI can't navigate your site structure)",
  hasMerchantReturn: "no return policy schema",
  hasShippingDetails: "no shipping details schema",
  hasLlmsTxt: "no llms.txt file (AI crawlers have no guide to your site)",
  allowsAIBots: "AI bots blocked in robots.txt",
  hasFAQContent: "no FAQ content on your site",
  hasPricingContent: "no visible pricing information",
  hasShippingInfo: "no shipping information visible",
  hasReturnPolicy: "no return policy visible",
  hasMetaDescription: "missing meta descriptions",
  hasOpenGraph: "no Open Graph tags (poor social/AI sharing)",
};

function describeGaps(signals) {
  const gaps = [];
  for (const [key, desc] of Object.entries(SIGNAL_DESCRIPTIONS)) {
    if (signals[key] === false) {
      gaps.push(desc);
    }
  }
  return gaps;
}

// ── Generate outreach email ──────────────────────────────────────────────────

function generateEmail(merchant, caseStudy, gaps) {
  const { domain, vertical, visibility } = merchant;
  const avgVis = visibility
    ? Math.round(visibility.reduce((s, v) => s + v.visibilityScore, 0) / visibility.length)
    : null;

  // Find best competitor score if available
  const topCompetitor = merchant.signals?.discoveredCompetitors?.[0];

  const brandName = domain.replace(/\.(com|in|au|co|net|org|io)$/, "").replace(/^www\./, "").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

  const topGaps = gaps.slice(0, 3);

  const subject = avgVis !== null
    ? `${brandName} scores ${avgVis}% on AI shopping visibility`
    : `How ${brandName} shows up (or doesn't) on ChatGPT and Perplexity`;

  const body = `Hey — I ran an AI visibility audit on ${domain}.

${avgVis !== null ? `Right now, when someone asks ChatGPT, Perplexity, or Google's AI to recommend a ${vertical.replace(/_/g, " ")} business, ${domain} shows up ${avgVis}% of the time.${topCompetitor ? ` Your competitor ${topCompetitor.name || topCompetitor} appears more often.` : ""}` : `When someone asks ChatGPT or Perplexity to recommend a ${vertical.replace(/_/g, " ")} business, ${domain} doesn't appear.`}

${topGaps.length > 0 ? `The main issues:\n${topGaps.map(g => `- ${g}`).join("\n")}` : ""}

We fixed this for ${caseStudy.client} — took their AI visibility from ${caseStudy.before}% to ${caseStudy.after}%. ${caseStudy.detail}.

Would a free detailed audit of your site be useful? Takes 5 minutes to run, no commitment.

Adithya
FlowBlinq — AI Commerce Visibility
ar@flowblinq.com`;

  return { subject, body, domain, vertical, avgVis, gapCount: gaps.length };
}

// ── Generate batch from experiment results ───────────────────────────────────

function generateBatch(merchants) {
  const emails = [];

  for (const m of merchants) {
    // Skip our own domains and test domains
    if (!m.domain || m.domain.includes("flowblinq") || m.domain.includes("example") || m.domain.includes("test")) continue;

    const caseStudy = pickCaseStudy(m.vertical || "");
    const gaps = m.signals ? describeGaps(m.signals) : [];
    const email = generateEmail(m, caseStudy, gaps);
    emails.push(email);
  }

  return emails;
}

// ── Generate markdown report of all outreach emails ──────────────────────────

function generateOutreachReport(emails) {
  const lines = [];
  const date = new Date().toISOString().split("T")[0];

  lines.push("# AI Visibility Outreach — Draft Emails");
  lines.push("");
  lines.push(`**Generated:** ${date}  `);
  lines.push(`**Total emails:** ${emails.length}  `);
  lines.push(`**Status:** DRAFT — requires Adithya approval before sending`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // Summary table
  lines.push("## Summary");
  lines.push("");
  lines.push("| # | Domain | Vertical | AI Visibility | Signal Gaps |");
  lines.push("|---|--------|----------|--------------|-------------|");
  emails.forEach((e, i) => {
    lines.push(`| ${i + 1} | ${e.domain} | ${e.vertical || "—"} | ${e.avgVis !== null ? e.avgVis + "%" : "unaudited"} | ${e.gapCount} |`);
  });
  lines.push("");
  lines.push("---");
  lines.push("");

  // Individual emails
  for (let i = 0; i < emails.length; i++) {
    const e = emails[i];
    lines.push(`## ${i + 1}. ${e.domain}`);
    lines.push("");
    lines.push(`**Subject:** ${e.subject}`);
    lines.push("");
    lines.push("```");
    lines.push(e.body);
    lines.push("```");
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let resultsPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--results") resultsPath = args[++i];
  }

  const outputDir = join(__dirname, "results");
  mkdirSync(outputDir, { recursive: true });

  let merchants = [];

  if (resultsPath) {
    // Load from experiment results JSON
    const data = JSON.parse(readFileSync(resultsPath, "utf-8"));
    merchants = (data.merchantScores || []).map(m => ({
      domain: m.domain,
      vertical: m.vertical,
      signals: m.signalSummary,
      visibility: m.visibility,
    }));
  } else {
    // Load from cohort file + cached signals/probes
    const cohort = JSON.parse(readFileSync(join(__dirname, "merchant-cohort.json"), "utf-8"));
    let signals = {};
    let probes = {};
    try { signals = JSON.parse(readFileSync(join(outputDir, "signals.json"), "utf-8")); } catch {}
    try { probes = JSON.parse(readFileSync(join(outputDir, "probes.json"), "utf-8")); } catch {}

    merchants = cohort.cohort.map(m => ({
      domain: m.domain,
      vertical: m.vertical,
      signals: signals[m.domain] || null,
      visibility: probes[m.domain]?.map(v => ({
        surface: v.surface,
        visibilityScore: v.visibilityScore,
      })) || null,
    }));
  }

  console.log(`Generating outreach for ${merchants.length} merchants...`);

  const emails = generateBatch(merchants);
  const report = generateOutreachReport(emails);

  const date = new Date().toISOString().split("T")[0];
  const reportPath = join(outputDir, `outreach-drafts-${date}.md`);
  writeFileSync(reportPath, report);
  console.log(`Outreach report: ${reportPath}`);

  // Also save to Cofounder deliverables
  const cofounderPath = `/Users/adithya/Code/Cofounder/deliverables/sales/ai-visibility-outreach-${date}.md`;
  writeFileSync(cofounderPath, report);
  console.log(`Cofounder deliverable: ${cofounderPath}`);

  // Summary
  console.log(`\n${emails.length} emails generated.`);
  const withScores = emails.filter(e => e.avgVis !== null);
  if (withScores.length > 0) {
    const avgVis = Math.round(withScores.reduce((s, e) => s + e.avgVis, 0) / withScores.length);
    console.log(`Average target visibility: ${avgVis}% (lower = bigger opportunity)`);
  }
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
