import type { PerPageResult } from "./per-page-analyzer";
import type { PerPageFix } from "./page-fix-generator";
import type { ImplementationStatus } from "./implementation-tracker";

// ── Types ──

interface SiteForReport {
  domain: string;
  geoScorecard: {
    overallScore: number;
    pillars: Array<{
      pillarName: string;
      score: number;
      priority: string;
    }>;
    topThreeImprovements: string[];
  };
  executiveSummary: string;
}

// ── Shared styles ──

const BRAND_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=DM+Sans:wght@400;500;600;700&display=swap');
  body {
    font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    background: #0a0e1a;
    color: #f1f5f9;
    margin: 0;
    padding: 24px;
    line-height: 1.6;
  }
  .container { max-width: 820px; margin: 0 auto; }
  h1 {
    font-family: 'DM Sans', sans-serif;
    font-size: 26px;
    font-weight: 700;
    color: #f1f5f9;
    border-bottom: 2px solid #f97316;
    padding-bottom: 12px;
    margin-bottom: 24px;
  }
  h2 {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-top: 32px;
    margin-bottom: 12px;
  }
  .card {
    background: #151d2e;
    border: 1px solid #1e293b;
    border-radius: 10px;
    padding: 20px 24px;
    margin: 16px 0;
  }
  .label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: #64748b;
    margin-bottom: 6px;
  }
  .score { font-family: 'DM Sans', sans-serif; font-size: 56px; font-weight: 800; text-align: center; margin: 24px 0; letter-spacing: -0.02em; }
  .score.good  { color: #22c55e; }
  .score.fair  { color: #f97316; }
  .score.poor  { color: #ef4444; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; font-family: 'JetBrains Mono', monospace; letter-spacing: 0.03em; text-transform: uppercase; }
  .badge.critical   { background: rgba(239,68,68,0.15);  color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
  .badge.high       { background: rgba(249,115,22,0.15); color: #fb923c; border: 1px solid rgba(249,115,22,0.3); }
  .badge.medium     { background: rgba(234,179,8,0.15);  color: #facc15; border: 1px solid rgba(234,179,8,0.3); }
  .badge.low        { background: rgba(59,130,246,0.15); color: #60a5fa; border: 1px solid rgba(59,130,246,0.3); }
  .badge.good       { background: rgba(34,197,94,0.15);  color: #86efac; border: 1px solid rgba(34,197,94,0.3); }
  .badge.needs-work { background: rgba(234,179,8,0.15);  color: #facc15; border: 1px solid rgba(234,179,8,0.3); }
  .badge.poor       { background: rgba(239,68,68,0.15);  color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 13px; }
  th { color: #64748b; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; font-family: 'JetBrains Mono', monospace; background: #0f1623; }
  tr:hover td { background: #1a2236; }
  .vuln {
    background: #151d2e;
    border: 1px solid #1e293b;
    border-left: 3px solid #f97316;
    border-radius: 8px;
    padding: 16px 18px;
    margin: 10px 0;
  }
  .footer {
    text-align: center;
    color: #475569;
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
    margin-top: 48px;
    padding-top: 16px;
    border-top: 1px solid #1e293b;
  }
  a { color: #f97316; text-decoration: none; }
  a:hover { text-decoration: underline; }
`;

// ── Per-page HTML ──

export function generatePerPageHtml(result: PerPageResult, domain: string, perPageFix?: PerPageFix, implStatus?: ImplementationStatus): string {
  const healthClass = result.overallPageHealth;
  const vulnHtml =
    result.vulnerabilities.length === 0
      ? '<p style="color: #86efac;">No vulnerabilities detected. This page looks good.</p>'
      : result.vulnerabilities
          .map(
            (v) => `
        <div class="vuln">
          <span class="badge ${v.severity}">${v.severity.toUpperCase()}</span>
          <strong style="margin-left: 8px;">${escapeHtml(v.pillarName)}</strong>
          <p style="margin: 8px 0 4px; color: #d4d4d4;">${escapeHtml(v.finding)}</p>
          <p style="margin: 0; color: #a3a3a3; font-size: 14px;">→ ${escapeHtml(v.recommendation)}</p>
        </div>
      `
          )
          .join("");

  // Suggested Fixes section
  let fixesHtml = "";
  if (perPageFix) {
    const fixItems: string[] = [];
    if (perPageFix.suggestedTitle) {
      const badge = implStatus?.fixes.find(f => f.fixType === "title")?.implemented
        ? '<span class="badge good" style="float:right">Implemented</span>'
        : implStatus ? '<span class="badge critical" style="float:right">Not yet</span>' : "";
      fixItems.push(`<div class="vuln"><strong>Title</strong>${badge}<p style="margin:4px 0;color:#a3a3a3;font-size:13px">Current: ${escapeHtml(perPageFix.currentTitle || "(none)")}</p><p style="margin:4px 0;color:#d4d4d4">Suggested: ${escapeHtml(perPageFix.suggestedTitle)}</p></div>`);
    }
    if (perPageFix.suggestedMetaDescription) {
      fixItems.push(`<div class="vuln"><strong>Meta Description</strong><p style="margin:4px 0;color:#d4d4d4">${escapeHtml(perPageFix.suggestedMetaDescription)}</p></div>`);
    }
    if (perPageFix.h1Fix) {
      const badge = implStatus?.fixes.find(f => f.fixType === "h1")?.implemented
        ? '<span class="badge good" style="float:right">Implemented</span>'
        : implStatus ? '<span class="badge critical" style="float:right">Not yet</span>' : "";
      fixItems.push(`<div class="vuln"><strong>H1</strong>${badge}<p style="margin:4px 0;color:#d4d4d4">${escapeHtml(perPageFix.h1Fix)}</p></div>`);
    }
    if (perPageFix.headingFixes) {
      fixItems.push(`<div class="vuln"><strong>Heading Structure</strong><p style="margin:4px 0;color:#d4d4d4">${escapeHtml(perPageFix.headingFixes)}</p></div>`);
    }
    for (const pf of perPageFix.pillarFixes) {
      fixItems.push(`<div class="vuln"><span class="badge medium">${escapeHtml(pf.pillarName)}</span> <span style="font-size:12px;color:#a3a3a3;margin-left:6px">Site-side change</span><p style="margin:8px 0 0;color:#d4d4d4">${escapeHtml(pf.fix)}</p></div>`);
    }
    if (perPageFix.matchedSchemaBlocks.length > 0) {
      fixItems.push(`<div class="vuln"><strong>Recommended Schema</strong><p style="margin:4px 0;color:#d4d4d4">${perPageFix.matchedSchemaBlocks.map(escapeHtml).join(", ")}</p></div>`);
    }
    if (fixItems.length > 0) {
      fixesHtml = `<h2>Suggested Fixes (${fixItems.length})</h2>${fixItems.join("")}`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GEO Audit: ${escapeHtml(result.url)}</title>
  <style>${BRAND_STYLES}</style>
</head>
<body>
  <div class="container">
    <h1>Page Audit: ${escapeHtml(result.title)}</h1>
    <p style="color: #a3a3a3;">${escapeHtml(result.url)}</p>
    <p>Page type: <strong>${escapeHtml(result.pageType)}</strong> &nbsp; Health: <span class="badge ${healthClass}">${result.overallPageHealth}</span></p>
    <h2>Vulnerabilities (${result.vulnerabilities.length})</h2>
    ${vulnHtml}
    ${fixesHtml}
    <div class="footer">
      Generated by <a href="https://geo.flowblinq.com">FlowBlinq GEO</a> for ${escapeHtml(domain)}
    </div>
  </div>
</body>
</html>`;
}

// ── Aggregate HTML ──

export function generateAggregateHtml(
  site: SiteForReport,
  perPageResults: PerPageResult[],
  implementationStatus?: ImplementationStatus[],
  perPageFixes?: PerPageFix[]
): string {
  const scoreClass =
    site.geoScorecard.overallScore >= 80
      ? "good"
      : site.geoScorecard.overallScore >= 50
        ? "fair"
        : "poor";

  const pillarRows = site.geoScorecard.pillars
    .slice()
    .sort((a, b) => a.score - b.score)
    .map((p) => {
      const cls = p.score >= 80 ? "good" : p.score >= 50 ? "fair" : "poor";
      return `<tr><td>${escapeHtml(p.pillarName)}</td><td><span class="badge ${cls}">${p.score}/100</span></td><td>${escapeHtml(p.priority)}</td></tr>`;
    })
    .join("");

  const healthDist = {
    good: perPageResults.filter((r) => r.overallPageHealth === "good").length,
    "needs-work": perPageResults.filter((r) => r.overallPageHealth === "needs-work").length,
    poor: perPageResults.filter((r) => r.overallPageHealth === "poor").length,
  };

  const topRecs = site.geoScorecard.topThreeImprovements
    .map((r) => `<li>${escapeHtml(r)}</li>`)
    .join("");

  // Fix implementation summary
  let implSummaryHtml = "";
  if (implementationStatus && implementationStatus.length > 0) {
    const totalFixes = implementationStatus.reduce((s, r) => s + r.totalFixes, 0);
    const totalImpl = implementationStatus.reduce((s, r) => s + r.implementedCount, 0);
    implSummaryHtml = `<h2>Fix Implementation Summary</h2>
    <p><strong>${totalImpl} of ${totalFixes}</strong> suggested fixes implemented across ${implementationStatus.length} pages.</p>`;
  }

  // Per-page fix count distribution
  let fixDistHtml = "";
  if (perPageFixes && perPageFixes.length > 0) {
    const fixCounts = perPageFixes.map((f) => {
      let count = 0;
      if (f.suggestedTitle) count++;
      if (f.suggestedMetaDescription) count++;
      if (f.h1Fix) count++;
      if (f.headingFixes) count++;
      count += f.pillarFixes.length;
      count += f.matchedSchemaBlocks.length;
      return count;
    });
    const zero = fixCounts.filter((c) => c === 0).length;
    const low = fixCounts.filter((c) => c >= 1 && c <= 2).length;
    const high = fixCounts.filter((c) => c >= 3).length;
    fixDistHtml = `<h2>Fix Distribution (${perPageFixes.length} pages analyzed)</h2>
    <table>
      <tr><th>Fix Count</th><th>Pages</th></tr>
      <tr><td>No fixes needed</td><td>${zero}</td></tr>
      <tr><td>1–2 fixes</td><td>${low}</td></tr>
      <tr><td>3+ fixes</td><td>${high}</td></tr>
    </table>`
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GEO Audit Report: ${escapeHtml(site.domain)}</title>
  <style>${BRAND_STYLES}</style>
</head>
<body>
  <div class="container">
    <div class="label">GEO AUDIT REPORT</div>
    <h1>GEO Audit Report: ${escapeHtml(site.domain)}</h1>
    <div class="card">
      <div class="score ${scoreClass}">${site.geoScorecard.overallScore}/100</div>
      <h2>Executive Summary</h2>
      <p>${escapeHtml(site.executiveSummary)}</p>
    </div>
    <div class="card">
      <h2>Pillar Scores</h2>
      <table>
        <tr><th>Pillar</th><th>Score</th><th>Priority</th></tr>
        ${pillarRows}
      </table>
    </div>
    <div class="card">
      <h2>Page Health Distribution (${perPageResults.length} pages)</h2>
      <table>
        <tr><th>Status</th><th>Count</th></tr>
        <tr><td><span class="badge good">Good</span></td><td>${healthDist.good}</td></tr>
        <tr><td><span class="badge needs-work">Needs Work</span></td><td>${healthDist["needs-work"]}</td></tr>
        <tr><td><span class="badge poor">Poor</span></td><td>${healthDist.poor}</td></tr>
      </table>
    </div>
    ${implSummaryHtml}
    ${fixDistHtml}
    <div class="card">
      <h2>Top Recommendations</h2>
      <ol>${topRecs}</ol>
    </div>
    <div class="footer">
      Generated by <a href="https://geo.flowblinq.com">FlowBlinq GEO</a> — AI Visibility Intelligence by FlowBlinq &mdash; ${new Date().toISOString().split("T")[0]}
    </div>
  </div>
</body>
</html>`;
}

// ── Helpers ──

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
