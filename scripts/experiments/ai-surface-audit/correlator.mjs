/**
 * correlator.mjs — Correlate merchant signals with AI surface visibility
 *
 * Takes signal data + visibility data for all merchants and computes:
 * 1. Per-signal correlation with visibility (per surface)
 * 2. Ranking factor importance weights
 * 3. FlowBlinq instrumentability matrix
 * 4. Actionable recommendations
 */

// ── Correlation math ─────────────────────────────────────────────────────────

/**
 * Pearson correlation coefficient between two arrays.
 * Returns value between -1 and 1. null if arrays are constant.
 */
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  if (den === 0) return null;
  return num / den;
}

/**
 * Point-biserial correlation: boolean signal vs continuous visibility.
 * Equivalent to Pearson with 0/1 encoding.
 */
function pointBiserial(booleans, continuous) {
  const xs = booleans.map(b => b ? 1 : 0);
  return pearson(xs, continuous);
}

// ── Signal definitions (what to extract from merchant signals) ───────────────

const BOOLEAN_SIGNALS = [
  { key: "hasProductSchema", label: "Product Schema", category: "schema", instrumentable: true, effort: "low" },
  { key: "hasOfferSchema", label: "Offer/AggregateOffer Schema", category: "schema", instrumentable: true, effort: "low" },
  { key: "hasReviewSchema", label: "Review/Rating Schema", category: "schema", instrumentable: true, effort: "medium" },
  { key: "hasOrgSchema", label: "Organization Schema", category: "schema", instrumentable: true, effort: "low" },
  { key: "hasFAQSchema", label: "FAQ Schema", category: "schema", instrumentable: true, effort: "low" },
  { key: "hasBreadcrumbs", label: "BreadcrumbList Schema", category: "schema", instrumentable: true, effort: "low" },
  { key: "hasSearchAction", label: "SearchAction Schema", category: "schema", instrumentable: true, effort: "medium" },
  { key: "hasMerchantReturn", label: "MerchantReturnPolicy Schema", category: "schema", instrumentable: true, effort: "low" },
  { key: "hasShippingDetails", label: "ShippingDetails Schema", category: "schema", instrumentable: true, effort: "low" },
  { key: "hasLlmsTxt", label: "llms.txt Present", category: "crawlability", instrumentable: true, effort: "low" },
  { key: "hasSitemap", label: "Sitemap.xml Present", category: "crawlability", instrumentable: true, effort: "low" },
  { key: "hasRobotsTxt", label: "Robots.txt Present", category: "crawlability", instrumentable: true, effort: "low" },
  { key: "allowsAIBots", label: "AI Bots Allowed (robots.txt)", category: "crawlability", instrumentable: true, effort: "low" },
  { key: "blocksGPTBot", label: "Blocks GPTBot", category: "crawlability", instrumentable: true, effort: "low" },
  { key: "blocksCCBot", label: "Blocks CCBot", category: "crawlability", instrumentable: true, effort: "low" },
  { key: "blocksPerplexityBot", label: "Blocks PerplexityBot", category: "crawlability", instrumentable: true, effort: "low" },
  { key: "hasAnyReviews", label: "Any Review Presence", category: "reviews", instrumentable: false, effort: "n/a" },
  { key: "hasFAQContent", label: "FAQ Content", category: "content", instrumentable: true, effort: "medium" },
  { key: "hasComparisonContent", label: "Comparison Content", category: "content", instrumentable: true, effort: "medium" },
  { key: "hasPricingContent", label: "Pricing Visible", category: "content", instrumentable: true, effort: "low" },
  { key: "hasShippingInfo", label: "Shipping Info Visible", category: "content", instrumentable: true, effort: "low" },
  { key: "hasReturnPolicy", label: "Return Policy Visible", category: "content", instrumentable: true, effort: "low" },
  { key: "hasCanonicalTag", label: "Canonical Tag", category: "technical", instrumentable: true, effort: "low" },
  { key: "hasMetaDescription", label: "Meta Description", category: "technical", instrumentable: true, effort: "low" },
  { key: "hasOpenGraph", label: "Open Graph Tags", category: "technical", instrumentable: true, effort: "low" },
  { key: "mentionsCurrentYear", label: "Mentions Current Year", category: "freshness", instrumentable: true, effort: "low" },
];

const CONTINUOUS_SIGNALS = [
  { key: "schemaCount", label: "Schema Type Count", category: "schema", instrumentable: true, effort: "medium" },
  { key: "schemaScore", label: "Schema Richness Score", category: "schema", instrumentable: true, effort: "medium" },
  { key: "reviewPlatformCount", label: "Review Platform Count", category: "reviews", instrumentable: false, effort: "n/a" },
  { key: "estimatedReviewCount", label: "Estimated Review Count", category: "reviews", instrumentable: false, effort: "n/a" },
  { key: "freshnessScore", label: "Content Freshness Score", category: "freshness", instrumentable: true, effort: "medium" },
  { key: "contentScore", label: "Content Quality Score", category: "content", instrumentable: true, effort: "medium" },
  { key: "maxWordCount", label: "Max Page Word Count", category: "content", instrumentable: true, effort: "medium" },
  { key: "socialChannelCount", label: "Social Channel Count", category: "social", instrumentable: false, effort: "n/a" },
];

// ── Main correlation engine ──────────────────────────────────────────────────

/**
 * Compute correlation matrix between signals and visibility across surfaces.
 *
 * @param {Array} merchants — Each has { domain, signals: {...}, visibility: [{ surface, visibilityScore }] }
 * @returns {Object} Correlation report
 */
export function computeCorrelations(merchants) {
  const surfaceNames = merchants[0]?.visibility?.map(v => v.surface) ?? [];
  const results = {};

  for (const surface of surfaceNames) {
    const visScores = merchants.map(m =>
      m.visibility.find(v => v.surface === surface)?.visibilityScore ?? 0
    );

    const signalCorrelations = [];

    // Boolean signals
    for (const sig of BOOLEAN_SIGNALS) {
      const values = merchants.map(m => m.signals[sig.key]);
      // Skip if all same value (no variance)
      if (values.every(v => v === values[0])) continue;
      const r = pointBiserial(values, visScores);
      if (r !== null) {
        signalCorrelations.push({
          signal: sig.key,
          label: sig.label,
          category: sig.category,
          type: "boolean",
          correlation: Math.round(r * 1000) / 1000,
          absCorrelation: Math.abs(Math.round(r * 1000) / 1000),
          instrumentable: sig.instrumentable,
          effort: sig.effort,
          presentCount: values.filter(Boolean).length,
          totalCount: values.length,
        });
      }
    }

    // Continuous signals
    for (const sig of CONTINUOUS_SIGNALS) {
      const values = merchants.map(m => m.signals[sig.key] ?? 0);
      if (values.every(v => v === values[0])) continue;
      const r = pearson(values, visScores);
      if (r !== null) {
        signalCorrelations.push({
          signal: sig.key,
          label: sig.label,
          category: sig.category,
          type: "continuous",
          correlation: Math.round(r * 1000) / 1000,
          absCorrelation: Math.abs(Math.round(r * 1000) / 1000),
          instrumentable: sig.instrumentable,
          effort: sig.effort,
          mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10,
          stdDev: Math.round(Math.sqrt(values.reduce((a, b) => a + (b - values.reduce((x, y) => x + y, 0) / values.length) ** 2, 0) / values.length) * 10) / 10,
        });
      }
    }

    // Sort by absolute correlation
    signalCorrelations.sort((a, b) => b.absCorrelation - a.absCorrelation);

    results[surface] = {
      surfaceLabel: surface,
      merchantCount: merchants.length,
      avgVisibility: Math.round(visScores.reduce((a, b) => a + b, 0) / visScores.length * 10) / 10,
      signals: signalCorrelations,
      topPositive: signalCorrelations.filter(s => s.correlation > 0).slice(0, 10),
      topNegative: signalCorrelations.filter(s => s.correlation < 0).slice(0, 5),
    };
  }

  return results;
}

// ── FlowBlinq instrumentability matrix ───────────────────────────────────────

export function buildInstrumentabilityMatrix(correlations) {
  const matrix = [];

  for (const [surface, data] of Object.entries(correlations)) {
    for (const sig of data.signals) {
      if (sig.instrumentable && sig.absCorrelation >= 0.15) {
        matrix.push({
          surface,
          signal: sig.label,
          correlation: sig.correlation,
          effort: sig.effort,
          category: sig.category,
          // Impact score: |correlation| × effort multiplier
          impactScore: Math.round(sig.absCorrelation * (sig.effort === "low" ? 100 : sig.effort === "medium" ? 70 : 40)),
        });
      }
    }
  }

  // Sort by impact score (highest first)
  matrix.sort((a, b) => b.impactScore - a.impactScore);
  return matrix;
}

// ── Cross-surface ranking factor summary ─────────────────────────────────────

export function buildCrossSurfaceSummary(correlations) {
  // For each signal, average its correlation across all surfaces
  const signalMap = new Map();

  for (const [surface, data] of Object.entries(correlations)) {
    for (const sig of data.signals) {
      if (!signalMap.has(sig.signal)) {
        signalMap.set(sig.signal, {
          signal: sig.signal,
          label: sig.label,
          category: sig.category,
          instrumentable: sig.instrumentable,
          effort: sig.effort,
          surfaces: {},
        });
      }
      signalMap.get(sig.signal).surfaces[surface] = sig.correlation;
    }
  }

  const summary = [];
  for (const [, entry] of signalMap) {
    const correlations = Object.values(entry.surfaces);
    const avgCorr = correlations.reduce((a, b) => a + b, 0) / correlations.length;
    const maxCorr = Math.max(...correlations.map(Math.abs));
    const consistency = correlations.filter(c => Math.sign(c) === Math.sign(avgCorr)).length / correlations.length;

    summary.push({
      ...entry,
      avgCorrelation: Math.round(avgCorr * 1000) / 1000,
      maxAbsCorrelation: Math.round(maxCorr * 1000) / 1000,
      consistency: Math.round(consistency * 100),
      surfaceCount: correlations.length,
    });
  }

  summary.sort((a, b) => b.maxAbsCorrelation - a.maxAbsCorrelation);
  return summary;
}

// ── Generate human-readable report ───────────────────────────────────────────

export function generateReport(correlations, instrumentability, crossSurface, merchants) {
  const lines = [];
  const hr = "═".repeat(80);
  const thin = "─".repeat(80);

  lines.push(hr);
  lines.push("  AI SHOPPING SURFACE RANKING FACTOR AUDIT");
  lines.push(`  Generated: ${new Date().toISOString().split("T")[0]}`);
  lines.push(`  Merchants tested: ${merchants.length}`);
  lines.push(hr);
  lines.push("");

  // Per-surface results
  for (const [surface, data] of Object.entries(correlations)) {
    lines.push(thin);
    lines.push(`  ${surface.toUpperCase()} — Avg visibility: ${data.avgVisibility}%`);
    lines.push(thin);

    if (data.topPositive.length > 0) {
      lines.push("\n  TOP POSITIVE CORRELATORS (signal → higher visibility):");
      for (const sig of data.topPositive.slice(0, 8)) {
        const bar = "█".repeat(Math.round(sig.absCorrelation * 20));
        const inst = sig.instrumentable ? "✓ FB" : "  —";
        lines.push(`    ${bar.padEnd(20)} r=${sig.correlation > 0 ? "+" : ""}${sig.correlation.toFixed(3)}  ${inst}  ${sig.label}`);
      }
    }

    if (data.topNegative.length > 0) {
      lines.push("\n  TOP NEGATIVE CORRELATORS (signal → lower visibility):");
      for (const sig of data.topNegative.slice(0, 3)) {
        const bar = "░".repeat(Math.round(sig.absCorrelation * 20));
        const inst = sig.instrumentable ? "✓ FB" : "  —";
        lines.push(`    ${bar.padEnd(20)} r=${sig.correlation.toFixed(3)}  ${inst}  ${sig.label}`);
      }
    }
    lines.push("");
  }

  // Cross-surface summary
  lines.push(hr);
  lines.push("  CROSS-SURFACE RANKING FACTORS (averaged across all 5 surfaces)");
  lines.push(hr);
  lines.push("");
  lines.push("  Signal                              Avg r    Max |r|  Consistency  FB?");
  lines.push("  " + "─".repeat(76));

  for (const sig of crossSurface.slice(0, 20)) {
    const inst = sig.instrumentable ? "YES" : " — ";
    lines.push(
      `  ${sig.label.padEnd(38)} ${(sig.avgCorrelation > 0 ? "+" : "") + sig.avgCorrelation.toFixed(3).padStart(6)}   ${sig.maxAbsCorrelation.toFixed(3).padStart(6)}    ${String(sig.consistency + "%").padStart(4)}      ${inst}`
    );
  }

  // Instrumentability matrix (FlowBlinq product opportunities)
  lines.push("");
  lines.push(hr);
  lines.push("  FLOWBLINQ INSTRUMENTABILITY MATRIX");
  lines.push("  (Signals FlowBlinq can optimize, ranked by impact × ease)");
  lines.push(hr);
  lines.push("");
  lines.push("  Score  Surface               Signal                         Effort  Corr");
  lines.push("  " + "─".repeat(76));

  for (const item of instrumentability.slice(0, 25)) {
    lines.push(
      `  ${String(item.impactScore).padStart(5)}  ${item.surface.padEnd(22)} ${item.signal.padEnd(31)} ${item.effort.padEnd(7)} ${(item.correlation > 0 ? "+" : "") + item.correlation.toFixed(3)}`
    );
  }

  // Merchant scoreboard
  lines.push("");
  lines.push(hr);
  lines.push("  MERCHANT VISIBILITY SCOREBOARD");
  lines.push(hr);
  lines.push("");
  lines.push("  Domain                       ChatGPT  Perplx  Google  Meta   Rufus  Avg");
  lines.push("  " + "─".repeat(76));

  const sorted = [...merchants].sort((a, b) => {
    const avgA = a.visibility.reduce((s, v) => s + v.visibilityScore, 0) / a.visibility.length;
    const avgB = b.visibility.reduce((s, v) => s + v.visibilityScore, 0) / b.visibility.length;
    return avgB - avgA;
  });

  for (const m of sorted) {
    const scores = {};
    for (const v of m.visibility) scores[v.surface] = v.visibilityScore;
    const avg = Math.round(m.visibility.reduce((s, v) => s + v.visibilityScore, 0) / m.visibility.length);
    lines.push(
      `  ${m.domain.padEnd(30)} ${String(scores.chatgpt_shopping ?? 0).padStart(5)}%  ${String(scores.perplexity_shopping ?? 0).padStart(5)}%  ${String(scores.google_ai_overview ?? 0).padStart(5)}%  ${String(scores.meta_ai ?? 0).padStart(4)}%  ${String(scores.amazon_rufus ?? 0).padStart(4)}%  ${String(avg).padStart(3)}%`
    );
  }

  lines.push("");
  lines.push(hr);
  lines.push("  KEY FINDINGS FOR FLOWBLINQ PRODUCT");
  lines.push(hr);
  lines.push("");
  lines.push("  The following signals are both (a) strongly correlated with visibility");
  lines.push("  and (b) instrumentable by FlowBlinq's optimization service:");
  lines.push("");

  const topOpportunities = instrumentability.filter(i => i.impactScore >= 30).slice(0, 10);
  for (let i = 0; i < topOpportunities.length; i++) {
    const opp = topOpportunities[i];
    lines.push(`  ${i + 1}. ${opp.signal} (${opp.surface}, r=${opp.correlation > 0 ? "+" : ""}${opp.correlation.toFixed(3)}, effort: ${opp.effort})`);
  }

  lines.push("");
  lines.push("  �� FB = FlowBlinq can instrument this signal");
  lines.push("  r = Pearson correlation coefficient (-1 to +1)");
  lines.push("");

  return lines.join("\n");
}

// ── Generate markdown reports ─────────��──────────────────────────────────────

/**
 * Master ranking-factors report as markdown.
 */
export function generateMarkdownReport(correlations, instrumentability, crossSurface, merchants) {
  const date = new Date().toISOString().split("T")[0];
  const lines = [];

  lines.push(`# AI Shopping Surface Ranking Factor Audit`);
  lines.push("");
  lines.push(`**Date:** ${date}  `);
  lines.push(`**Merchants tested:** ${merchants.length}  `);
  lines.push(`**Surfaces:** ChatGPT Shopping, Perplexity Shopping, Google AI Overviews, Meta AI, Amazon Rufus`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // ── Executive Summary ──────────────────────────────────────────────────────
  lines.push("## Executive Summary");
  lines.push("");
  lines.push("This experiment reverse-engineers what signals determine merchant visibility across 5 AI shopping surfaces. Each merchant's website was crawled for structured data, review presence, content quality, and crawlability signals, then probed with shopping-intent queries on each surface.");
  lines.push("");

  const topFactors = crossSurface.filter(s => s.maxAbsCorrelation >= 0.2).slice(0, 5);
  if (topFactors.length > 0) {
    lines.push("**Top ranking factors (cross-surface):**");
    lines.push("");
    for (const sig of topFactors) {
      const dir = sig.avgCorrelation > 0 ? "+" : "";
      const fb = sig.instrumentable ? " -- FlowBlinq can optimize" : "";
      lines.push(`- **${sig.label}**: avg r=${dir}${sig.avgCorrelation.toFixed(3)}, consistent across ${sig.consistency}% of surfaces${fb}`);
    }
    lines.push("");
  }

  const topOpps = instrumentability.filter(i => i.impactScore >= 25).slice(0, 5);
  if (topOpps.length > 0) {
    lines.push("**Top FlowBlinq product opportunities:**");
    lines.push("");
    for (const opp of topOpps) {
      lines.push(`- **${opp.signal}** on ${opp.surface} (impact score: ${opp.impactScore}, effort: ${opp.effort})`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  // ── Per-Surface Breakdown ───────────────────────────���──────────────────────
  lines.push("## Per-Surface Results");
  lines.push("");

  for (const [surface, data] of Object.entries(correlations)) {
    lines.push(`### ${surface.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}`);
    lines.push("");
    lines.push(`Average visibility: **${data.avgVisibility}%** across ${data.merchantCount} merchants.`);
    lines.push("");

    if (data.topPositive.length > 0) {
      lines.push("**Positive correlators** (signal present = higher visibility):");
      lines.push("");
      lines.push("| Signal | r | FlowBlinq? | Category |");
      lines.push("|--------|---|------------|----------|");
      for (const sig of data.topPositive.slice(0, 10)) {
        const fb = sig.instrumentable ? "Yes" : "No";
        lines.push(`| ${sig.label} | +${sig.correlation.toFixed(3)} | ${fb} | ${sig.category} |`);
      }
      lines.push("");
    }

    if (data.topNegative.length > 0) {
      lines.push("**Negative correlators** (signal present = lower visibility):");
      lines.push("");
      lines.push("| Signal | r | Category |");
      lines.push("|--------|---|----------|");
      for (const sig of data.topNegative.slice(0, 5)) {
        lines.push(`| ${sig.label} | ${sig.correlation.toFixed(3)} | ${sig.category} |`);
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");

  // ── Cross-Surface Ranking Factors ──────────────────────────────────────────
  lines.push("## Cross-Surface Ranking Factors");
  lines.push("");
  lines.push("Signals averaged across all 5 surfaces, sorted by max absolute correlation:");
  lines.push("");
  lines.push("| Signal | Avg r | Max |r| | Consistency | FlowBlinq? | Effort |");
  lines.push("|--------|-------|---------|-------------|------------|--------|");
  for (const sig of crossSurface.slice(0, 25)) {
    const dir = sig.avgCorrelation > 0 ? "+" : "";
    const fb = sig.instrumentable ? "Yes" : "No";
    const effort = sig.effort || "n/a";
    lines.push(`| ${sig.label} | ${dir}${sig.avgCorrelation.toFixed(3)} | ${sig.maxAbsCorrelation.toFixed(3)} | ${sig.consistency}% | ${fb} | ${effort} |`);
  }
  lines.push("");

  lines.push("---");
  lines.push("");

  // ── Instrumentability Matrix ─────────────────────────────────────��─────────
  lines.push("## FlowBlinq Instrumentability Matrix");
  lines.push("");
  lines.push("Signals that FlowBlinq can optimize, ranked by `|correlation| x ease`:");
  lines.push("");
  lines.push("| Impact | Surface | Signal | Effort | r |");
  lines.push("|--------|---------|--------|--------|---|");
  for (const item of instrumentability.slice(0, 25)) {
    const dir = item.correlation > 0 ? "+" : "";
    lines.push(`| ${item.impactScore} | ${item.surface} | ${item.signal} | ${item.effort} | ${dir}${item.correlation.toFixed(3)} |`);
  }
  lines.push("");

  lines.push("---");
  lines.push("");

  // ── Merchant Scoreboard ────────────────────────────────────────────────────
  lines.push("## Merchant Visibility Scoreboard");
  lines.push("");
  lines.push("| Domain | ChatGPT | Perplexity | Google | Meta AI | Rufus | Avg |");
  lines.push("|--------|---------|------------|--------|---------|-------|-----|");

  const sorted = [...merchants].sort((a, b) => {
    const avgA = a.visibility.reduce((s, v) => s + v.visibilityScore, 0) / a.visibility.length;
    const avgB = b.visibility.reduce((s, v) => s + v.visibilityScore, 0) / b.visibility.length;
    return avgB - avgA;
  });

  for (const m of sorted) {
    const scores = {};
    for (const v of m.visibility) scores[v.surface] = v.visibilityScore;
    const avg = Math.round(m.visibility.reduce((s, v) => s + v.visibilityScore, 0) / m.visibility.length);
    lines.push(`| ${m.domain} | ${scores.chatgpt_shopping ?? 0}% | ${scores.perplexity_shopping ?? 0}% | ${scores.google_ai_overview ?? 0}% | ${scores.meta_ai ?? 0}% | ${scores.amazon_rufus ?? 0}% | **${avg}%** |`);
  }
  lines.push("");

  lines.push("---");
  lines.push("");

  // ── Key Findings ───────────────────────────────────────────────────────────
  lines.push("## Key Findings for FlowBlinq Product");
  lines.push("");
  lines.push("Signals that are both **(a) strongly correlated with visibility** and **(b) instrumentable by FlowBlinq's optimization service**:");
  lines.push("");

  const topInstrumentable = instrumentability.filter(i => i.impactScore >= 25).slice(0, 10);
  for (let i = 0; i < topInstrumentable.length; i++) {
    const opp = topInstrumentable[i];
    const dir = opp.correlation > 0 ? "+" : "";
    lines.push(`${i + 1}. **${opp.signal}** -- ${opp.surface}, r=${dir}${opp.correlation.toFixed(3)}, effort: ${opp.effort}`);
  }
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("*Legend: r = Pearson correlation coefficient (-1 to +1). FlowBlinq? = can FlowBlinq instrument this signal for merchants.*");
  lines.push("");

  return lines.join("\n");
}

/**
 * Per-merchant signal profile as a standalone markdown file.
 */
export function generateMerchantProfileMd(merchant) {
  const date = new Date().toISOString().split("T")[0];
  const lines = [];
  const { domain, vertical, platform, signals, visibility } = merchant;

  lines.push(`# Merchant Signal Profile: ${domain}`);
  lines.push("");
  lines.push(`**Date:** ${date}  `);
  lines.push(`**Vertical:** ${vertical}  `);
  lines.push(`**Platform:** ${platform}  `);
  lines.push(`**Pages crawled:** ${signals.crawledPages ?? "N/A"}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // Visibility
  lines.push("## AI Surface Visibility");
  lines.push("");
  lines.push("| Surface | Visibility | Mentions | Avg Position |");
  lines.push("|---------|-----------|----------|-------------|");
  for (const v of visibility) {
    lines.push(`| ${v.surface.replace(/_/g, " ")} | **${v.visibilityScore}%** | ${v.mentionCount} | ${v.avgPosition ?? "N/A"} |`);
  }
  const avgVis = Math.round(visibility.reduce((s, v) => s + v.visibilityScore, 0) / visibility.length);
  lines.push(`| **Average** | **${avgVis}%** | | |`);
  lines.push("");

  // Schema signals
  lines.push("## Structured Data Signals");
  lines.push("");
  lines.push(`- **Schema types found:** ${(signals.schemaTypes || []).join(", ") || "None"}`);
  lines.push(`- **Schema richness score:** ${signals.schemaScore ?? 0}/100`);
  lines.push(`- Product schema: ${signals.hasProductSchema ? "Yes" : "No"}`);
  lines.push(`- Offer/pricing schema: ${signals.hasOfferSchema ? "Yes" : "No"}`);
  lines.push(`- Review/rating schema: ${signals.hasReviewSchema ? "Yes" : "No"}`);
  lines.push(`- Organization schema: ${signals.hasOrgSchema ? "Yes" : "No"}`);
  lines.push(`- FAQ schema: ${signals.hasFAQSchema ? "Yes" : "No"}`);
  lines.push(`- Breadcrumbs: ${signals.hasBreadcrumbs ? "Yes" : "No"}`);
  lines.push(`- MerchantReturnPolicy: ${signals.hasMerchantReturn ? "Yes" : "No"}`);
  lines.push(`- ShippingDetails: ${signals.hasShippingDetails ? "Yes" : "No"}`);
  lines.push("");

  // Review signals
  lines.push("## Review & Social Proof");
  lines.push("");
  lines.push(`- **Review platforms detected:** ${(signals.reviewPlatforms || []).join(", ") || "None"}`);
  lines.push(`- **Estimated review count:** ${signals.estimatedReviewCount ?? 0}`);
  lines.push(`- **Average rating:** ${signals.averageRating ?? "N/A"}`);
  lines.push(`- Social channels: ${signals.socialChannelCount ?? 0} (${[
    signals.hasFacebook && "Facebook",
    signals.hasInstagram && "Instagram",
    signals.hasTwitter && "Twitter/X",
    signals.hasYouTube && "YouTube",
    signals.hasTikTok && "TikTok",
  ].filter(Boolean).join(", ") || "None"})`);
  lines.push("");

  // Crawlability
  lines.push("## Crawlability & AI Access");
  lines.push("");
  lines.push(`- robots.txt: ${signals.hasRobotsTxt ? "Present" : "Missing"}`);
  lines.push(`- AI bots allowed: ${signals.allowsAIBots === true ? "Yes" : signals.allowsAIBots === false ? "No" : "Unknown"}`);
  lines.push(`- Blocks GPTBot: ${signals.blocksGPTBot ? "Yes" : "No"}`);
  lines.push(`- Blocks CCBot: ${signals.blocksCCBot ? "Yes" : "No"}`);
  lines.push(`- Blocks PerplexityBot: ${signals.blocksPerplexityBot ? "Yes" : "No"}`);
  lines.push(`- llms.txt: ${signals.hasLlmsTxt ? "Present" : "Missing"}`);
  lines.push(`- Sitemap: ${signals.hasSitemap ? `Present (${signals.sitemapUrlCount ?? "?"} URLs)` : "Missing"}`);
  lines.push("");

  // Content quality
  lines.push("## Content Quality");
  lines.push("");
  lines.push(`- **Content score:** ${signals.contentScore ?? 0}/100`);
  lines.push(`- **Freshness score:** ${signals.freshnessScore ?? 0}/100`);
  lines.push(`- Max page word count: ${signals.maxWordCount ?? 0}`);
  lines.push(`- FAQ content: ${signals.hasFAQContent ? "Yes" : "No"}`);
  lines.push(`- Comparison content: ${signals.hasComparisonContent ? "Yes" : "No"}`);
  lines.push(`- Pricing visible: ${signals.hasPricingContent ? "Yes" : "No"}`);
  lines.push(`- Shipping info: ${signals.hasShippingInfo ? "Yes" : "No"}`);
  lines.push(`- Return policy: ${signals.hasReturnPolicy ? "Yes" : "No"}`);
  lines.push("");

  // Technical
  lines.push("## Technical Signals");
  lines.push("");
  lines.push(`- Canonical tag: ${signals.hasCanonicalTag ? "Yes" : "No"}`);
  lines.push(`- Meta description: ${signals.hasMetaDescription ? "Yes" : "No"}`);
  lines.push(`- Open Graph: ${signals.hasOpenGraph ? "Yes" : "No"}`);
  lines.push(`- Viewport (mobile): ${signals.hasViewport ? "Yes" : "No"}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Per-surface deep-dive markdown (what each surface cares about).
 */
export function generateSurfaceDeepDiveMd(surfaceName, surfaceData, instrumentability) {
  const date = new Date().toISOString().split("T")[0];
  const lines = [];
  const label = surfaceName.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

  lines.push(`# ${label} -- Ranking Factor Deep Dive`);
  lines.push("");
  lines.push(`**Date:** ${date}  `);
  lines.push(`**Merchants tested:** ${surfaceData.merchantCount}  `);
  lines.push(`**Average visibility:** ${surfaceData.avgVisibility}%`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // What this surface favors
  lines.push("## What Drives Visibility");
  lines.push("");
  if (surfaceData.topPositive.length > 0) {
    lines.push("| Rank | Signal | Correlation | Category | FlowBlinq Can Optimize? |");
    lines.push("|------|--------|-------------|----------|------------------------|");
    surfaceData.topPositive.slice(0, 15).forEach((sig, i) => {
      const fb = sig.instrumentable ? "Yes" : "No";
      lines.push(`| ${i + 1} | ${sig.label} | +${sig.correlation.toFixed(3)} | ${sig.category} | ${fb} |`);
    });
    lines.push("");
  }

  // What hurts
  if (surfaceData.topNegative.length > 0) {
    lines.push("## What Hurts Visibility");
    lines.push("");
    lines.push("| Signal | Correlation | Category |");
    lines.push("|--------|-------------|----------|");
    for (const sig of surfaceData.topNegative.slice(0, 5)) {
      lines.push(`| ${sig.label} | ${sig.correlation.toFixed(3)} | ${sig.category} |`);
    }
    lines.push("");
  }

  // FlowBlinq opportunities for this surface
  const surfaceOpps = instrumentability.filter(i => i.surface === surfaceName);
  if (surfaceOpps.length > 0) {
    lines.push("## FlowBlinq Optimization Opportunities");
    lines.push("");
    lines.push("| Impact Score | Signal | Effort | Correlation |");
    lines.push("|-------------|--------|--------|-------------|");
    for (const opp of surfaceOpps.slice(0, 15)) {
      const dir = opp.correlation > 0 ? "+" : "";
      lines.push(`| ${opp.impactScore} | ${opp.signal} | ${opp.effort} | ${dir}${opp.correlation.toFixed(3)} |`);
    }
    lines.push("");
  }

  // All signals with data
  lines.push("## Full Signal Correlation Table");
  lines.push("");
  lines.push("| Signal | Type | Correlation | |r| | Category |");
  lines.push("|--------|------|-------------|-----|----------|");
  for (const sig of surfaceData.signals) {
    const dir = sig.correlation > 0 ? "+" : "";
    lines.push(`| ${sig.label} | ${sig.type} | ${dir}${sig.correlation.toFixed(3)} | ${sig.absCorrelation.toFixed(3)} | ${sig.category} |`);
  }
  lines.push("");

  return lines.join("\n");
}
