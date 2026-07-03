/**
 * PDF Report HTML Generator
 *
 * Generates a self-contained HTML document for Puppeteer→PDF conversion.
 * Design: FlowBlinq Brand Book v3.0 — three-typeface system
 * (Instrument Serif headings, DM Sans body, JetBrains Mono labels/data),
 * parchment ground (#FAFAF8), brand gold/brick/sage semantic colors,
 * italic-gold emphasis on key metrics.
 * Voice: Plain language, no jargon. Respectful, direct.
 */

// ── Brand Book v3.0 design tokens ───────────────────────────────────────────
// Palette mirrors /tmp/brandbook-extract/tokens.ts; scoped to the constants
// the PDF needs. New tokens preserve prior semantic groups:
//   COPPER ⇒ GOLD      (signature accent, key metrics)
//   GREEN  ⇒ SAGE      (English Racing Green — proof, success)
//   ORANGE ⇒ GOLD      (warning tier in scoreColor — same gold serves
//                       "fair" since brick is reserved for failure)
//   RED    ⇒ BRICK     (Ferrari Racing Red — urgency, destructive)
//   TEXT   ⇒ INK       (charcoal #1A1A18)
//   T2     ⇒ INK2      (#5A5A56)
//   BORDER ⇒ CREASE    (#E8E6E1)
const GOLD      = "#C4841D";
const BRICK     = "#B5403A";
const SAGE      = "#3B7A4A";
const OLIVE     = "#5C6B3C";
const RUST      = "#8B4513";
const INK       = "#1A1A18";
const INK2      = "#5A5A56";
const INK3      = "#9A9A94";
const PAGE      = "#FAFAF8";
const WARM      = "#F5F3EF";
const CARD      = "#FFFFFF";
const CREASE    = "#E8E6E1";
const GOLD_WASH = "rgba(196,132,29,0.12)";
// Wash backgrounds — tinted surfaces for inline status callouts.
// Mirrors brandbook v3.0 *_WashBg variants in tokens.ts. Used for note-boxes,
// tier-tinted recommendation card backgrounds, and badge fills.
const BRICK_WASH = "rgba(181,64,58,0.10)";
const SAGE_WASH  = "rgba(59,122,74,0.10)";
const OLIVE_WASH = "rgba(92,107,60,0.10)";

// FlowBlinq logomark — full-color primary-dark variant (gold gradient ring
// + glow + charcoal core + gold center mark + light directional arrows).
// Sourced from /tmp/brandbook-extract/logo-primary-dark.svg.
//
// Returns the SVG with namespaced gradient + filter ids so multiple
// occurrences in the same rendered HTML (cover hero + every-page header)
// don't collide on duplicate ids. Pass a unique suffix per call site.
export function brandLogoSvg(suffix: string, sizePx = 100): string {
  const goldRingId = `goldRing-${suffix}`;
  const glowId = `glow-${suffix}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="${sizePx}" height="${sizePx}"><defs><linearGradient id="${goldRingId}" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#D4A04A"/><stop offset="50%" stop-color="${GOLD}"/><stop offset="100%" stop-color="#9A6510"/></linearGradient><filter id="${glowId}"><feGaussianBlur stdDeviation="6" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><g transform="translate(200,200)"><circle cx="0" cy="0" r="160" fill="${INK}"/><circle cx="0" cy="0" r="163" fill="none" stroke="rgba(196,132,29,0.35)" stroke-width="14"/><circle cx="0" cy="0" r="163" fill="none" stroke="rgba(196,132,29,0.20)" stroke-width="24"/><circle cx="0" cy="0" r="163" fill="none" stroke="url(#${goldRingId})" stroke-width="3.5" filter="url(#${glowId})"/><line x1="-155" y1="0" x2="-64" y2="-78" stroke="${PAGE}" stroke-width="14" stroke-linecap="round"/><line x1="-155" y1="0" x2="-64" y2="78" stroke="${PAGE}" stroke-width="14" stroke-linecap="round"/><line x1="155" y1="0" x2="64" y2="-78" stroke="${PAGE}" stroke-width="14" stroke-linecap="round"/><line x1="155" y1="0" x2="64" y2="78" stroke="${PAGE}" stroke-width="14" stroke-linecap="round"/><line x1="49" y1="-147" x2="-49" y2="147" stroke="${GOLD}" stroke-width="16" stroke-linecap="round"/><circle cx="0" cy="0" r="32" fill="${GOLD}"/><circle cx="0" cy="0" r="12" fill="${PAGE}"/></g></svg>`;
}

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Inline SVG icon helpers (Task 3a) ────────────────────────────────────────
// Chromium ships without emoji glyph coverage in the lambda environment, so
// U+2192 (→), ✅, ❌, ⚠️ all render as tofu (☐). Replace with inline SVGs
// that are guaranteed to render correctly regardless of font availability.

function svgCheck(color = SAGE, size = 14): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" style="vertical-align:middle;flex-shrink:0;" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="7"/><polyline points="5,8.5 7,10.5 11,6"/></svg>`;
}

function svgCross(color = BRICK, size = 14): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" style="vertical-align:middle;flex-shrink:0;" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="7"/><line x1="5.5" y1="5.5" x2="10.5" y2="10.5"/><line x1="10.5" y1="5.5" x2="5.5" y2="10.5"/></svg>`;
}

function svgWarn(color = GOLD, size = 14): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" style="vertical-align:middle;flex-shrink:0;" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2L14 13H2L8 2z"/><line x1="8" y1="7" x2="8" y2="9.5"/><circle cx="8" cy="11.5" r="0.5" fill="${color}" stroke="none"/></svg>`;
}

function svgChevron(color = GOLD, size = 12): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 12 12" style="vertical-align:middle;flex-shrink:0;" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,2 8,6 4,10"/></svg>`;
}

/** Convert basic markdown bold/italic to HTML */
function md(s: string): string {
  let out = esc(s);
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*(.+?)\*/g, "<em>$1</em>");
  out = out.replace(/\n/g, "<br>");
  return out;
}

function scoreColor(s: number): string {
  // Tier semantics preserved from the prior Apple-HIG palette:
  //   ≥75 → SAGE (proof / good)
  //   ≥50 → GOLD (warning / fair) — gold also serves as the warning tier
  //          since brick is reserved exclusively for failure (HP-prevented
  //          chromatic ambiguity that the prior orange/red split caused).
  //   <50 → BRICK (urgency / poor)
  return s >= 75 ? SAGE : s >= 50 ? GOLD : BRICK;
}

function scoreTier(s: number): string {
  if (s >= 75) return "Good";
  if (s >= 50) return "Fair";
  if (s >= 25) return "Weak";
  return "Poor";
}

function formatDate(iso: string | null): string {
  if (!iso) return "N/A";
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

// ── Pillar explainers (plain language) ───────────────────────────────────────

const PILLAR_EXPLAINERS: Record<string, string> = {
  "structured_data": "AI tools read hidden labels on your website to quickly understand what your business does, where you're located, and what you offer.",
  "entity_definitions": "AI needs to clearly understand what your business is — your name, what you do, where you operate.",
  "content_depth": "AI tools prefer websites that explain things thoroughly. Thin content makes it harder for AI to recommend you.",
  "topical_authority": "This measures whether your website consistently covers your area of expertise.",
  "citation_readiness": "How easily AI can pull out key facts and quotes from your content.",
  "competitive_positioning": "How clearly your website communicates what makes you different from competitors.",
  "freshness": "AI tools prefer up-to-date information. Stale content gets ranked below fresher competitors.",
  "technical_seo": "Page speed, mobile-friendliness, proper headings — the basics that let AI tools read your site properly.",
  "internal_linking": "Good internal links help AI understand how your pages relate to each other and which are most important.",
  "evidence_statistics": "Sites that include concrete numbers and evidence get cited more often by AI.",
  "brand_signals": "How recognizable your brand is across the web. AI recommends businesses it sees mentioned in trusted places.",
  "user_experience": "How easy your site is to use. AI hesitates to send people to sites with a poor experience.",
  "multimedia_content": "Images, videos, and other media help AI understand your content better.",
  "local_relevance": "How well your website signals to AI tools which locations you serve.",
  "trust_signals": "Reviews, testimonials, certifications — trust indicators that make AI confident recommending you.",
  "content_structure": "Well-organized content with clear headings makes it easier for AI to extract information.",
};

// ── Types ────────────────────────────────────────────────────────────────────

interface Pillar {
  pillar: string;
  pillarName: string;
  score: number;
  findings: string;
  recommendation: string;
  priority: string;
}

interface Recommendation {
  rank?: number;
  title: string;
  description?: string;
  impact?: string;
  effort?: string;
  pillar: string;
  specificAction?: string;
  estimatedBoost: string;
  priority: string;
}

interface ProviderResult {
  provider: string;
  visibilityScore: number;
  mentionCount: number;
  totalQueries: number;
}

interface CompetitorData { name: string; shareOfVoice: number; }
interface GeoVis { geoId: string; geoName: string; visibility: number; }
interface CatVis { categoryId: string; categoryName: string; visibility: number; }
interface TierVis { tier: string; mentionCount: number; promptCount: number; visibility: number; }

interface PerPageEntry {
  url: string;
  pageType: string;
  title: string;
  health: "good" | "needs-work" | "poor";
  vulnerabilities: Array<{ pillar: string; pillarName: string; severity: string; finding: string }>;
  suggestedTitle?: string | null;
  suggestedMetaDescription?: string | null;
  h1Fix?: string | null;
  pillarFixes?: Array<{ pillarName: string; fix: string }>;
  schemaBlocks?: string[];
}

interface PdfReportData {
  domain: string;
  overallScore: number | null;
  pillars: Pillar[];
  recommendations: Recommendation[];
  executiveSummary: string | null;
  lastCrawlAt: string | null;
  pageCount: number;
  overallVisibility: number | null;
  citationRate: number | null;
  citationQualityScore: number | null;
  providerResults: ProviderResult[];
  competitorData: CompetitorData[];
  pillarVisibility: Record<string, number>;
  geoVisibility: GeoVis[];
  categoryVisibility: CatVis[];
  tierVisibility: TierVis[];
  ourSOV: number | null;
  reportUrl: string;
  perPageBreakdown?: PerPageEntry[];
  projectedScore?: number | null;
  hasLlmsTxt?: boolean;
  hasRobotsTxt?: boolean;
  hasBusinessJson?: boolean;
  stalePageCount?: number;
  /** Task 4: when set, renders a thank-you cover panel above the executive summary. */
  coverPanel?: {
    reportUrl: string;
    installUrl: string;
  };
}

export type { PdfReportData };

// ── HTML Generator ───────────────────────────────────────────────────────────

export function generatePdfReportHtml(data: PdfReportData): string {
  const {
    domain, overallScore, pillars, recommendations, executiveSummary,
    lastCrawlAt, pageCount, overallVisibility, citationRate, citationQualityScore,
    providerResults, competitorData, pillarVisibility, geoVisibility,
    categoryVisibility, tierVisibility, ourSOV, reportUrl,
    perPageBreakdown, projectedScore, hasLlmsTxt, hasRobotsTxt, hasBusinessJson, stalePageCount,
    coverPanel,
  } = data;

  const criticalCount = pillars.filter(p => p.score < 25 || p.priority === "critical").length;

  // Provider aggregation
  const providerAggMap = new Map<string, { mentionCount: number; totalQueries: number }>();
  for (const p of providerResults) {
    const key = p.provider.toLowerCase().includes("perplexity") ? "Perplexity"
      : p.provider.toLowerCase().includes("openai") || p.provider.toLowerCase().includes("gpt") ? "OpenAI"
      : p.provider.toLowerCase().includes("anthropic") || p.provider.toLowerCase().includes("claude") ? "Anthropic"
      : p.provider.charAt(0).toUpperCase() + p.provider.slice(1);
    const existing = providerAggMap.get(key);
    if (!existing) providerAggMap.set(key, { mentionCount: p.mentionCount, totalQueries: p.totalQueries });
    else { existing.mentionCount += p.mentionCount; existing.totalQueries += p.totalQueries; }
  }
  const providerLine = Array.from(providerAggMap.entries())
    .map(([name, v]) => `${name} ${v.mentionCount}/${v.totalQueries}`)
    .join(" · ");

  // Sort recs
  const sortOrder: Record<string, number> = { critical: 0, HIGH: 0, high: 1, MED: 2, med: 2, medium: 2, LOW: 3, low: 3 };
  const sortedRecs = [...recommendations].sort((a, b) => (sortOrder[a.priority] ?? 4) - (sortOrder[b.priority] ?? 4));

  // Group recs
  const recGroups = [
    { label: "Critical", recs: sortedRecs.filter(r => r.priority === "critical") },
    { label: "High", recs: sortedRecs.filter(r => ["HIGH", "high"].includes(r.priority)) },
    { label: "Medium", recs: sortedRecs.filter(r => ["MED", "med", "medium"].includes(r.priority)) },
    { label: "Low", recs: sortedRecs.filter(r => ["LOW", "low"].includes(r.priority)) },
  ].filter(g => g.recs.length > 0);

  const SHORT_NAMES: Record<string, string> = {
    "evidence_statistics": "Evidence",
    "entity_definitions": "Entities",
    "competitive_positioning": "Positioning",
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>GEO Audit Report — ${esc(domain)}</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:opsz,wght@9..40,300..600&family=JetBrains+Mono:wght@300;400;500;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  /* Brand Book v3.0 — three-typeface system. Instrument Serif for hero
     + section headings (weight 400; serif weight is the visual weight).
     DM Sans for body. JetBrains Mono for labels, data, and overlines
     (uppercase tracked). Italic + gold for rhetorical emphasis on key
     metrics. Pages render on parchment ground (#FAFAF8). */
  html, body, p, li { orphans: 3; widows: 3; }
  body {
    font-family: 'DM Sans', system-ui, sans-serif;
    font-weight: 300;
    color: ${INK}; background: ${PAGE}; font-size: 12px; line-height: 1.55;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  /* Headings: Instrument Serif. Avoid orphaning a heading at page bottom
     away from its content. */
  h1, h2, h3, .section-title {
    font-family: 'Instrument Serif', Georgia, serif;
    font-weight: 400;
    page-break-after: avoid; break-after: avoid;
  }
  /* Mono utility classes — applied to labels, kicker overlines, data. */
  .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
  .data { font-family: 'JetBrains Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
  .overline { font-family: 'JetBrains Mono', ui-monospace, monospace; font-weight: 400; letter-spacing: 4px; text-transform: uppercase; color: ${OLIVE}; font-size: 10px; }
  /* Brandbook italic-gold emphasis pattern. */
  em.gold { color: ${GOLD}; font-style: italic; font-weight: 400; }
  .page { max-width: 800px; margin: 0 auto; }

  /* Task 3c: clamp card and table width so padding never causes right-edge overflow in Puppeteer. */
  .card, table { max-width: 100%; }

  /* Pagination: keep small atoms together (single bar/row/pillar/kpi).
     Task 3c: .card also gets break-inside: avoid so pillar cards don't
     split across pages. */
  .pillar-block, .bar-row, .kpi-row { break-inside: avoid; }

  .card {
    background: ${CARD}; border: 1px solid ${CREASE}; border-radius: 10px;
    padding: 16px 18px; margin-bottom: 10px;
    break-inside: avoid; page-break-inside: avoid;
  }

  /* Section overline — brandbook v3.0 mono-tracked uppercase, olive. */
  .label {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px; font-weight: 400; color: ${OLIVE}; text-transform: uppercase;
    letter-spacing: 4px; margin-bottom: 12px;
    page-break-after: avoid; break-after: avoid;
  }

  .note {
    font-size: 11px; color: ${INK2}; line-height: 1.55; margin-bottom: 12px;
  }

  .bar-row { display: flex; align-items: center; margin-bottom: 5px; gap: 8px; }
  .bar-lbl {
    font-size: 11px; font-weight: 600; color: ${INK}; width: 100px; text-align: right;
    flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .bar-track { flex: 1; height: 12px; background: ${CREASE}; border-radius: 3px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; }
  .bar-val { font-family: 'JetBrains Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; font-size: 11px; font-weight: 500; color: ${INK}; width: 34px; text-align: right; flex-shrink: 0; }

  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }

  .pillar-block { padding: 8px 0; border-bottom: 1px solid ${CREASE}; break-inside: avoid; }
  .pillar-row { display: flex; align-items: center; gap: 8px; }
  .p-name { font-size: 12px; font-weight: 600; color: ${INK}; width: 150px; flex-shrink: 0; }
  .p-bar { flex: 1; height: 6px; background: ${CREASE}; border-radius: 3px; overflow: hidden; }
  .p-bar-fill { height: 100%; border-radius: 3px; }
  .p-score { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 13px; font-weight: 500; width: 28px; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .p-tier {
    font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 3px;
    width: 42px; text-align: center; flex-shrink: 0;
  }
  .p-detail { font-size: 11px; color: ${INK}; margin-top: 3px; line-height: 1.5; }
  .p-fix { font-size: 11px; color: ${GOLD}; margin-top: 2px; }

  .rec-card {
    border: 1px solid ${CREASE}; border-radius: 8px; padding: 12px 16px;
    margin-bottom: 6px; break-inside: avoid;
  }
  .rec-hdr { display: flex; align-items: center; gap: 8px; }
  .rec-badge {
    font-size: 9px; font-weight: 700; padding: 2px 5px; border-radius: 3px;
    flex-shrink: 0; text-align: center;
  }
  .rec-title { font-size: 12px; font-weight: 600; color: ${INK}; flex: 1; }
  .rec-time { font-size: 10px; color: ${INK2}; flex-shrink: 0; }
  .rec-action {
    background: ${GOLD_WASH}; border-radius: 6px; padding: 8px 12px; margin-top: 6px;
    font-size: 11px; line-height: 1.5; color: ${INK};
  }
  .rec-boost { font-size: 10px; color: ${SAGE}; font-weight: 600; margin-top: 4px; }

  .note-box {
    background: ${GOLD_WASH}; border: 1px solid ${CREASE}; border-radius: 8px;
    padding: 12px 16px; margin-bottom: 14px; break-inside: avoid;
    border-left: 3px solid ${GOLD};
  }
  .note-box p { font-size: 11px; color: ${INK}; line-height: 1.5; }

  table.t { width: 100%; border-collapse: collapse; }
  table.t th {
    font-size: 9px; font-weight: 700; color: ${INK2}; text-transform: uppercase;
    letter-spacing: 0.4px; text-align: left; padding: 0 0 6px; border-bottom: 1px solid ${CREASE};
  }
  table.t td { padding: 5px 0; border-bottom: 1px solid ${CREASE}; font-size: 12px; }

  .footer {
    text-align: center; font-size: 10px; color: ${INK2}; padding: 20px 0 0;
    border-top: 1px solid ${CREASE}; margin-top: 28px;
  }

  .kpi-row { display: flex; gap: 10px; margin-bottom: 10px; }
  .kpi-row .card { flex: 1; }
</style>
</head>
<body>
<div class="page">

  <!-- ══════════════════════════════════════════════════════════════════════════ -->
  <!-- COVER — sober, data-forward -->
  <!-- ══════════════════════════════════════════════════════════════════════════ -->

  <div style="padding: 32px 0 24px;">
    <div style="display: flex; align-items: center; gap: 14px; margin-bottom: 20px;">
      <div style="width: 36px; height: 36px; flex-shrink: 0;">${brandLogoSvg('cover', 36)}</div>
      <div class="overline">Flowblinq · GEO Audit</div>
    </div>
    <h1 style="font-size: 32px; font-weight: 400; letter-spacing: -0.5px; line-height: 1.15; margin-bottom: 8px;">AI Visibility Report for <em class="gold">${esc(domain)}</em></h1>
    <div class="mono" style="font-size: 11px; color: ${INK2}; letter-spacing: 0.4px;">${pageCount} pages analyzed · ${formatDate(lastCrawlAt)}</div>
  </div>

  <!-- Key metrics — brandbook v3.0 stat-strip pattern. Grid with 1px gap on
       crease background creates clean inner separators. Each card has a
       3px left accent in semantic color (sage / gold / brick by tier),
       JetBrains-Mono colored number, DM Sans description, mono /100 unit. -->
  ${(() => {
    const sov = ourSOV;
    const stats = [
      { label: "GEO Score",       value: overallScore != null ? String(overallScore) : "—", unit: "/100", color: overallScore != null ? scoreColor(overallScore) : INK3 },
      { label: "AI Visibility",   value: overallVisibility != null ? String(overallVisibility) : "—", unit: overallVisibility != null ? "%" : "", color: overallVisibility != null ? scoreColor(overallVisibility) : INK3 },
      { label: "Citation Rate",   value: citationRate !== null ? String(citationRate) : "—", unit: citationRate !== null ? "%" : "", color: citationRate !== null ? scoreColor(citationRate) : INK3 },
      { label: "Share of Voice",  value: sov !== null ? String(sov) : "—", unit: sov !== null ? "%" : "", color: GOLD },
      { label: "Critical Issues", value: String(criticalCount), unit: "", color: criticalCount > 0 ? BRICK : SAGE },
    ];
    return `
  <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 1px; background: ${CREASE}; border: 1px solid ${CREASE}; border-radius: 4px; overflow: hidden; margin-bottom: 20px;">
    ${stats.map(s => `
    <div style="background: ${CARD}; padding: 22px 18px 20px; position: relative;">
      <div style="position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: ${s.color};"></div>
      <div class="overline" style="font-size: 8.5px; letter-spacing: 1.2px; margin-bottom: 10px; white-space: nowrap;">${s.label}</div>
      <div style="font-family: 'JetBrains Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; font-size: 28px; font-weight: 700; color: ${s.color}; line-height: 1;">${s.value}<span style="font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 13px; font-weight: 400; color: ${INK3}; margin-left: 2px;">${s.unit}</span></div>
    </div>`).join("")}
  </div>`;
  })()}
  ${providerLine ? `<div class="mono" style="font-size: 10px; color: ${INK2}; margin: 0 0 20px; letter-spacing: 0.4px;">Per provider: ${providerLine}</div>` : ""}

  <!-- Score projection + AI readiness checklist -->
  ${projectedScore != null && projectedScore > (overallScore ?? 0) ? `
  <div style="background: ${SAGE_WASH}; border: 1px solid ${CREASE}; border-left: 3px solid ${SAGE}; border-radius: 6px; padding: 14px 16px; margin-bottom: 16px; display: flex; align-items: center; gap: 16px;">
    <div>
      <div style="font-size: 10px; font-weight: 600; color: ${INK2}; text-transform: uppercase; letter-spacing: 0.4px;">If you implement all fixes</div>
      <div style="display: flex; align-items: baseline; gap: 8px; margin-top: 4px;">
        <span style="font-size: 14px; color: ${INK2};">${overallScore ?? 0}</span>
        ${svgChevron(INK2, 14)}
        <span style="font-size: 22px; font-weight: 800; color: ${SAGE};">${projectedScore}</span>
        <span style="font-size: 12px; color: ${SAGE}; font-weight: 600;">+${projectedScore - (overallScore ?? 0)} points</span>
      </div>
    </div>
  </div>` : ""}

  <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 20px;">
    <div style="border: 1px solid ${CREASE}; border-radius: 6px; padding: 10px 12px;">
      <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
        ${hasLlmsTxt ? svgCheck() : svgCross()}
        <span style="font-size: 11px; font-weight: 700;">llms.txt</span>
      </div>
      <div style="font-size: 10px; color: ${INK2}; line-height: 1.4;">${hasLlmsTxt ? "Present — AI models can discover your site structure." : "Missing — AI models can&#x27;t find a machine-readable site map."}</div>
    </div>
    <div style="border: 1px solid ${CREASE}; border-radius: 6px; padding: 10px 12px;">
      <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
        ${hasBusinessJson ? svgCheck() : svgCross()}
        <span style="font-size: 11px; font-weight: 700;">business.json</span>
      </div>
      <div style="font-size: 10px; color: ${INK2}; line-height: 1.4;">${hasBusinessJson ? "Present — structured business data available to AI." : "Missing — AI has no structured way to read your business info."}</div>
    </div>
    ${stalePageCount !== undefined ? `<div style="border: 1px solid ${CREASE}; border-radius: 6px; padding: 10px 12px;">
      <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
        ${stalePageCount === 0 ? svgCheck() : svgWarn()}
        <span style="font-size: 11px; font-weight: 700;">Content Freshness</span>
      </div>
      <div style="font-size: 10px; color: ${INK2}; line-height: 1.4;">${stalePageCount === 0 ? "All pages have recent dates." : `${stalePageCount} pages have stale or missing dates. AI deprioritizes outdated content.`}</div>
    </div>` : ""}
  </div>

  <!-- ══════════════════════════════════════════════════════════════════════════ -->
  <!-- COMPETITOR BENCHMARK HERO -->
  <!-- ══════════════════════════════════════════════════════════════════════════ -->

  ${competitorData.length > 0 ? (() => {
    const topComp = competitorData[0];
    const gap = topComp ? Math.round(topComp.shareOfVoice - (ourSOV ?? 0)) : 0;
    const totalQueries = providerResults.reduce((s, p) => s + p.totalQueries, 0);
    const oursAtLeastTop = (ourSOV ?? 0) >= (topComp?.shareOfVoice ?? 0);
    const youColor = oursAtLeastTop ? SAGE : BRICK;
    // Bug fix: drop the prior 'margin: 0 -32px 24px' negative margin —
    // it extended the band beyond the .page wrapper (max-width 800px),
    // and Puppeteer's A4 viewport (~595pt usable width inside Pdf margins)
    // clipped the leftmost ~32px of the row contents (the bar-track + the
    // first character of the domain label). Block now fits inside the
    // page; padding re-stated explicitly so visual rhythm matches the
    // surrounding content.
    return `
  <div style="background: ${WARM}; padding: 24px 24px 22px; margin: 0 0 24px; position: relative; overflow: hidden; border-left: 3px solid ${GOLD}; border-radius: 0 4px 4px 0;">
    <div class="overline" style="margin-bottom: 12px;">Competitor Benchmark</div>
    <div style="font-family: 'Instrument Serif', Georgia, serif; font-size: 18px; font-weight: 400; line-height: 1.4; margin-bottom: 20px; max-width: 540px; color: ${INK};">
      ${topComp ? `When AI platforms recommend this category, <em class="gold">${esc(topComp.name)}</em> appears <strong style="color: ${BRICK};">${topComp.shareOfVoice}%</strong> of the time. You: <strong style="color: ${youColor};">${ourSOV ?? 0}%</strong>.` : 'No competitor data available for this audit.'}
    </div>

    <!-- SOV bar chart -->
    <div style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <div class="mono" style="width: 110px; font-size: 10px; color: ${GOLD}; font-weight: 500; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${esc(domain)}</div>
        <div style="flex: 1; background: ${CREASE}; height: 18px; border-radius: 2px; overflow: hidden;">
          <div style="width: ${Math.min(ourSOV ?? 0, 100)}%; height: 100%; background: ${GOLD}; border-radius: 2px;"></div>
        </div>
        <div class="data" style="width: 40px; font-size: 10px; font-weight: 500; color: ${GOLD}; text-align: right;">${ourSOV ?? 0}%</div>
      </div>
      ${competitorData.slice(0, 4).map(c => `
      <div style="display: flex; align-items: center; gap: 10px;">
        <div class="mono" style="width: 110px; font-size: 10px; color: ${INK2}; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${esc(c.name)}</div>
        <div style="flex: 1; background: ${CREASE}; height: 18px; border-radius: 2px; overflow: hidden;">
          <div style="width: ${Math.min(c.shareOfVoice, 100)}%; height: 100%; background: ${c.shareOfVoice > (ourSOV ?? 0) ? BRICK : SAGE}; border-radius: 2px;"></div>
        </div>
        <div class="data" style="width: 40px; font-size: 10px; font-weight: 500; color: ${INK}; text-align: right;">${c.shareOfVoice}%</div>
      </div>`).join("")}
    </div>

    <!-- KPI row — same 4 stats, brandbook stat-strip on warm ground -->
    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: ${CREASE}; border: 1px solid ${CREASE}; border-radius: 3px; overflow: hidden; margin-top: 14px;">
      <div style="background: ${CARD}; padding: 12px 14px; border-left: 3px solid ${GOLD};">
        <div class="data" style="font-size: 16px; font-weight: 700; color: ${GOLD};">${ourSOV ?? 0}%</div>
        <div style="font-size: 9px; color: ${INK2}; margin-top: 2px;">Your visibility</div>
      </div>
      <div style="background: ${CARD}; padding: 12px 14px; border-left: 3px solid ${BRICK};">
        <div class="data" style="font-size: 16px; font-weight: 700; color: ${BRICK};">${topComp?.shareOfVoice ?? 0}%</div>
        <div style="font-size: 9px; color: ${INK2}; margin-top: 2px;">Top competitor</div>
      </div>
      <div style="background: ${CARD}; padding: 12px 14px; border-left: 3px solid ${gap > 0 ? BRICK : SAGE};">
        <div class="data" style="font-size: 16px; font-weight: 700; color: ${gap > 0 ? BRICK : SAGE};">${gap > 0 ? '-' : '+'}${Math.abs(gap)}pp</div>
        <div style="font-size: 9px; color: ${INK2}; margin-top: 2px;">Gap</div>
      </div>
      <div style="background: ${CARD}; padding: 12px 14px; border-left: 3px solid ${OLIVE};">
        <div class="data" style="font-size: 16px; font-weight: 700; color: ${OLIVE};">${totalQueries}</div>
        <div style="font-size: 9px; color: ${INK2}; margin-top: 2px;">Queries tested</div>
      </div>
    </div>
  </div>`;
  })() : ""}

  <!-- ══════════════════════════════════════════════════════════════════════════ -->
  <!-- THANK-YOU COVER PANEL (Task 4 — purchase auth only) -->
  <!-- ══════════════════════════════════════════════════════════════════════════ -->

  ${coverPanel ? `
  <div style="background: ${WARM}; border: 1px solid ${CREASE}; border-left: 3px solid ${GOLD}; border-radius: 0 6px 6px 0; padding: 22px 24px; margin-bottom: 20px;">
    <div style="font-family: 'Instrument Serif', Georgia, serif; font-size: 20px; font-weight: 400; color: ${INK}; margin-bottom: 6px;">Thank you for your purchase.</div>
    <div style="font-size: 12px; color: ${INK2}; line-height: 1.6; margin-bottom: 16px;">Below is your full AI Visibility Audit for <strong>${esc(domain)}</strong>, generated ${formatDate(new Date().toISOString())}.</div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 20px; max-width: 400px;">
      <div style="background: ${CARD}; border: 1px solid ${CREASE}; border-radius: 6px; padding: 10px 14px; text-align: center;">
        <div style="font-size: 11px; font-weight: 600; color: ${GOLD};">Track this site weekly</div>
        <div style="font-size: 10px; color: ${INK3}; margin-top: 2px;">geo.flowblinq.com</div>
      </div>
      <div style="background: ${CARD}; border: 1px solid ${CREASE}; border-radius: 6px; padding: 10px 14px; text-align: center;">
        <div style="font-size: 11px; font-weight: 600; color: ${SAGE};">View interactive report</div>
        <div style="font-size: 10px; color: ${INK3}; margin-top: 2px;">Full analytics dashboard</div>
      </div>
    </div>

    <div>
      <div class="overline" style="margin-bottom: 10px;">What FlowBlinq fixes for you</div>
      <table class="t" style="max-width: 360px;">
        <tbody>
          <tr>
            <td style="font-weight: 600; width: 140px;">llms.txt</td>
            <td style="color: ${SAGE}; font-weight: 600;">Auto-published</td>
          </tr>
          <tr>
            <td style="font-weight: 600;">schema.org blocks</td>
            <td style="color: ${SAGE}; font-weight: 600;">Auto-injected</td>
          </tr>
          <tr>
            <td style="font-weight: 600; border-bottom: none;">business.json</td>
            <td style="color: ${SAGE}; font-weight: 600; border-bottom: none;">Auto-generated</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
  ` : ""}

  <!-- ══════════════════════════════════════════════════════════════════════════ -->
  <!-- EXECUTIVE SUMMARY -->
  <!-- ══════════════════════════════════════════════════════════════════════════ -->

  ${executiveSummary ? `
  <div class="label">Summary</div>
  <div style="font-size: 12px; line-height: 1.7; color: ${INK}; margin-bottom: 20px;">${md(executiveSummary)}</div>
  ` : ""}

  <!-- ══════════════════════════════════════════════════════════════════════════ -->
  <!-- OVERVIEW — 2-col: stacked charts (left) + critical issues (right) -->
  <!-- ══════════════════════════════════════════════════════════════════════════ -->

  <div class="label">Overview</div>

  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; align-items: start;">
    <!-- Citation Visibility by Theme -->
    <div class="card">
      <div class="label">Citation Visibility by Theme</div>
      <div class="note" style="margin-bottom: 8px;">Topics where AI tools are least likely to recommend you represent your highest-leverage improvement areas.</div>
      ${Object.keys(pillarVisibility).length > 0 ? Object.entries(pillarVisibility).sort((a, b) => a[1] - b[1]).slice(0, 8).map(([theme, pct]) => {
        const barClr = pct < 30 ? BRICK : pct < 50 ? GOLD : pct < 70 ? GOLD : SAGE;
        const displayName = SHORT_NAMES[theme] ?? theme.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        return `<div class="bar-row">
          <span class="bar-lbl">${esc(displayName)}</span>
          <div class="bar-track"><div class="bar-fill" style="width: ${pct}%; background: ${barClr};"></div></div>
          <span class="bar-val">${pct}%</span>
        </div>`;
      }).join("") : `<div class="note">No citation data available.</div>`}
    </div>

    <!-- Critical Issues -->
    <div class="card">
      <div class="label">Critical Issues <span style="font-weight: 500; color: ${INK2};">(${criticalCount} of ${pillars.length})</span></div>
      <div class="note" style="margin-bottom: 8px;">The audit areas with the most room for improvement — addressing these yields the highest return on effort.</div>
      ${criticalCount > 0 ? `
      <table class="t">
        <thead><tr><th>Area</th><th style="text-align: right; width: 40px;">Score</th><th style="padding-left: 10px;">Finding</th></tr></thead>
        <tbody>
          ${pillars.filter(p => p.score < 25 || p.priority === "critical").slice(0, 10).map(p => `
          <tr>
            <td style="font-weight: 600;">${esc(p.pillarName)}</td>
            <td style="font-weight: 700; color: ${p.score < 35 ? BRICK : GOLD}; text-align: right;">${p.score}</td>
            <td style="font-size: 11px; color: ${INK}; padding-left: 10px;">${esc(p.findings)}</td>
          </tr>`).join("")}
        </tbody>
      </table>` : `<div class="note">${pillars.length === 0 ? "No audit data." : "No critical issues found."}</div>`}
    </div>
  </div>

  <!-- Geographic Performance (full width) -->
  <div class="card" style="margin-bottom: 10px;">
    <div class="label">Geographic Performance</div>
    <div class="note" style="margin-bottom: 8px;">Visibility across the regions your business serves — gaps here mean potential customers in those areas aren't finding you through AI.</div>
    ${geoVisibility.length > 0 ? `<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 4px;">` + geoVisibility.slice(0, 8).map(g => `
    <div class="bar-row">
      <span class="bar-lbl" style="width: 80px;">${esc(g.geoName)}</span>
      <div class="bar-track"><div class="bar-fill" style="width: ${g.visibility}%; background: ${OLIVE}; opacity: 0.7;"></div></div>
      <span class="bar-val">${g.visibility}%</span>
    </div>`).join("") + `</div>` : `<div class="note">No geographic data.</div>`}
  </div>

  <!-- Category Performance + Buyer Intent (side by side) -->
  <div class="two-col">
    <div class="card">
      <div class="label">Category Performance</div>
      <div class="note" style="margin-bottom: 8px;">How strongly AI tools associate your business with each service category you offer.</div>
      ${categoryVisibility.length > 0 ? categoryVisibility.slice(0, 5).map(c => `
      <div class="bar-row">
        <span class="bar-lbl" style="width: 80px;">${esc(c.categoryName)}</span>
        <div class="bar-track"><div class="bar-fill" style="width: ${c.visibility}%; background: ${GOLD};"></div></div>
        <span class="bar-val">${c.visibility}%</span>
      </div>`).join("") : `<div class="note">No category data.</div>`}
    </div>
    ${tierVisibility.length > 0 ? `
    <div class="card">
      <div class="label">Buyer Intent Coverage</div>
      <div class="note" style="margin-bottom: 8px;">Your visibility at each stage of the buyer's journey — from early research to purchase-ready queries.</div>
      <div style="display: flex; gap: 12px;">
        ${tierVisibility.map(t => `
        <div style="flex: 1; text-align: center;">
          <div style="font-size: 9px; font-weight: 600; color: ${INK2}; text-transform: uppercase; letter-spacing: 0.3px;">${t.tier.charAt(0).toUpperCase() + t.tier.slice(1)}</div>
          <div style="font-size: 16px; font-weight: 800; margin: 2px 0;">${t.visibility}%</div>
          <div style="font-size: 9px; color: ${INK2};">${t.mentionCount}/${t.promptCount}</div>
        </div>`).join("")}
      </div>
    </div>` : `<div></div>`}
  </div>

  <!-- ══════════════════════════════════════════════════════════════════════════ -->
  <!-- PILLAR BREAKDOWN — compact, finding-forward, flows naturally -->
  <!-- ══════════════════════════════════════════════════════════════════════════ -->

  <div class="label" style="margin-top: 16px;">Detailed Pillar Breakdown</div>
  <div class="note">Your website is scored across ${pillars.length} areas that affect how AI tools understand and recommend your business. Each pillar below shows your score, what we found, and a suggested fix.</div>

  ${pillars.map(p => {
    const tier = scoreTier(p.score);
    const barClr = p.score < 35 ? BRICK : p.score < 55 ? GOLD : SAGE;
    const tierBg = tier === "Poor" ? BRICK_WASH : tier === "Weak" ? GOLD_WASH : SAGE_WASH;
    const tierClr = tier === "Poor" ? BRICK : tier === "Weak" ? GOLD : SAGE;
    const linkedRec = sortedRecs.find(r => r.pillar === p.pillar);
    return `
    <div class="card" style="padding: 10px 16px;">
      <div class="pillar-row">
        <span class="p-name">${esc(p.pillarName)}</span>
        <div class="p-bar"><div class="p-bar-fill" style="width: ${p.score}%; background: ${barClr};"></div></div>
        <span class="p-score">${p.score}</span>
        <span class="p-tier" style="background: ${tierBg}; color: ${tierClr};">${tier}</span>
      </div>
      ${p.findings ? `<div class="p-detail">${esc(p.findings)}</div>` : ""}
      ${linkedRec && linkedRec.title.toLowerCase().trim().replace(/[.,:;!?]+$/, "") !== p.pillarName.toLowerCase().trim().replace(/[.,:;!?]+$/, "")
        ? `<div class="p-fix" style="display:flex;align-items:center;gap:4px;">${svgChevron()} <span>${esc(linkedRec.title)}</span></div>`
        : ""}
    </div>`;
  }).join("")}

  <!-- ══════════════════════════════════════════════════════════════════════════ -->
  <!-- RECOMMENDATIONS -->
  <!-- ══════════════════════════════════════════════════════════════════════════ -->

  <div class="label" style="margin-top: 16px;">Recommendations</div>
  <div class="note">Specific actions to improve how AI tools see your business, sorted by expected impact.</div>

  ${recGroups.map(group => `
  <div style="font-size: 11px; font-weight: 700; color: ${INK}; text-transform: uppercase; letter-spacing: 0.4px; margin: 14px 0 6px;">${group.label} Priority (${group.recs.length})</div>
  ${group.recs.map(r => {
    const effortMap: Record<string, string> = { low: "~30 min", medium: "1–2 hrs", high: "half day" };
    const timeStr = r.effort ? (effortMap[r.effort] ?? r.effort) : null;
    const badgeClr = r.priority === "critical" ? BRICK : ["HIGH", "high"].includes(r.priority) ? GOLD : ["MED", "med", "medium"].includes(r.priority) ? GOLD : INK2;
    const badgeBg = r.priority === "critical" ? BRICK_WASH : ["HIGH", "high"].includes(r.priority) ? GOLD_WASH : ["MED", "med", "medium"].includes(r.priority) ? GOLD_WASH : CREASE;
    return `
    <div class="rec-card">
      <div class="rec-hdr">
        <span class="rec-badge" style="background: ${badgeBg}; color: ${badgeClr};">
          ${r.priority === "critical" ? "CRIT" : r.priority === "medium" ? "MED" : (r.priority ?? "low").toUpperCase()}
        </span>
        <span class="rec-title">${esc(r.title)}</span>
        ${timeStr ? `<span class="rec-time">${timeStr}</span>` : ""}
      </div>
      ${r.specificAction ? `<div class="rec-action"><strong>What to do:</strong> ${esc(r.specificAction)}</div>` : ""}
      ${r.estimatedBoost ? `<div class="rec-boost">Expected improvement: ${esc(String(r.estimatedBoost))}</div>` : ""}
    </div>`;
  }).join("")}`).join("")}

  <!-- ══════════════════════════════════════════════════════════════════════════ -->
  <!-- PER-PAGE BREAKDOWN — what's missing on each page -->
  <!-- ══════════════════════════════════════════════════════════════════════════ -->

  ${perPageBreakdown && perPageBreakdown.length > 0 ? `
  <div class="label">Page-by-Page Breakdown</div>
  <div class="note" style="margin-bottom: 12px;">${perPageBreakdown.length} pages analyzed. Each entry shows what AI models can't find or parse on that page, and the specific fix.</div>

  ${perPageBreakdown.slice(0, 50).map((page, idx) => {
    const healthClr = page.health === "poor" ? BRICK : page.health === "needs-work" ? GOLD : SAGE;
    const healthLabel = page.health === "poor" ? "Poor" : page.health === "needs-work" ? "Needs Work" : "Good";
    const shortUrl = page.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const hasFixes = page.suggestedTitle || page.suggestedMetaDescription || page.h1Fix || (page.pillarFixes && page.pillarFixes.length > 0);
    return `
    <div style="border: 1px solid ${CREASE}; border-radius: 6px; padding: 12px 14px; margin-bottom: 6px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
        <div style="font-size: 11px; font-weight: 700; color: ${INK}; max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(shortUrl)}</div>
        <span style="font-size: 9px; font-weight: 600; padding: 2px 8px; border-radius: 3px; background: ${healthClr}20; color: ${healthClr};">${healthLabel}</span>
      </div>
      <div style="font-size: 10px; color: ${INK2}; margin-bottom: 6px;">${esc(page.pageType)} · ${esc(page.title)}</div>

      ${page.vulnerabilities.length > 0 ? `
      <div style="font-size: 9px; font-weight: 600; color: ${BRICK}; text-transform: uppercase; letter-spacing: 0.5px; margin: 6px 0 4px;">Missing / Issues</div>
      ${page.vulnerabilities.slice(0, 5).map(v => `
      <div style="font-size: 10px; color: ${INK}; line-height: 1.5; padding-left: 8px; border-left: 2px solid ${v.severity === 'critical' ? BRICK : v.severity === 'high' ? GOLD : GOLD}; margin-bottom: 4px;">
        <strong>${esc(v.pillarName)}:</strong> ${esc(v.finding)}
      </div>`).join("")}` : ""}

      ${hasFixes ? `
      <div style="font-size: 9px; font-weight: 600; color: ${SAGE}; text-transform: uppercase; letter-spacing: 0.5px; margin: 6px 0 4px;">Fixes</div>
      ${page.suggestedTitle ? `<div style="font-size: 10px; color: ${INK}; line-height: 1.5; padding-left: 8px; border-left: 2px solid ${SAGE}; margin-bottom: 4px;"><strong>Title:</strong> ${esc(page.suggestedTitle)}</div>` : ""}
      ${page.suggestedMetaDescription ? `<div style="font-size: 10px; color: ${INK}; line-height: 1.5; padding-left: 8px; border-left: 2px solid ${SAGE}; margin-bottom: 4px;"><strong>Meta:</strong> ${esc(page.suggestedMetaDescription)}</div>` : ""}
      ${page.h1Fix ? `<div style="font-size: 10px; color: ${INK}; line-height: 1.5; padding-left: 8px; border-left: 2px solid ${SAGE}; margin-bottom: 4px;"><strong>H1:</strong> ${esc(page.h1Fix)}</div>` : ""}
      ${(page.pillarFixes ?? []).slice(0, 3).map(f => `<div style="font-size: 10px; color: ${INK}; line-height: 1.5; padding-left: 8px; border-left: 2px solid ${SAGE}; margin-bottom: 4px;"><strong>${esc(f.pillarName)}:</strong> ${esc(f.fix)}</div>`).join("")}` : ""}

      ${page.schemaBlocks && page.schemaBlocks.length > 0 ? `
      <div style="font-size: 9px; font-weight: 600; color: ${OLIVE}; text-transform: uppercase; letter-spacing: 0.5px; margin: 6px 0 4px;">Schema — Ready to Deploy</div>
      ${page.schemaBlocks.slice(0, 2).map(block => `<div style="font-size: 9px; font-family: 'SF Mono', 'JetBrains Mono', monospace; background: ${WARM}; border: 1px solid ${CREASE}; border-radius: 4px; padding: 6px 8px; margin-bottom: 4px; white-space: pre-wrap; overflow: hidden; max-height: 80px; line-height: 1.4; color: ${INK};">${esc(block.length > 300 ? block.slice(0, 300) + "..." : block)}</div>`).join("")}
      ${page.schemaBlocks.length > 2 ? `<div style="font-size: 9px; color: ${INK2};">+${page.schemaBlocks.length - 2} more schema blocks</div>` : ""}` : ""}
    </div>`;
  }).join("")}
  ${perPageBreakdown.length > 50 ? `<div class="note" style="margin-top: 8px;">Showing 50 of ${perPageBreakdown.length} pages. Full breakdown available in the ZIP report.</div>` : ""}
  ` : ""}

  <!-- ══════════════════════════════════════════════════════════════════════════ -->
  <!-- WHAT'S NEXT — UPSELL CTA -->
  <!-- ══════════════════════════════════════════════════════════════════════════ -->

  <!-- CTA: lightened to brand WARM ground per Aditya 2026-04-29 brand-discipline pass.
       Three options as stat-strip (white surfaces / 1px-gap crease separators /
       3px top semantic accents), wrapped in a WARM band with gold-italic
       headline. Drops negative margins to avoid the SoV-style left clipping. -->
  <div style="background: ${WARM}; padding: 30px 28px 26px; margin: 28px 0 24px; position: relative; overflow: hidden; border-left: 3px solid ${GOLD}; border-radius: 0 4px 4px 0;">
    <div style="font-family: 'Instrument Serif', Georgia, serif; font-size: 22px; font-weight: 400; font-style: italic; margin-bottom: 22px; color: ${INK};">What happens <em class="gold">next.</em></div>

    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1px; background: ${CREASE}; border: 1px solid ${CREASE}; border-radius: 3px; overflow: hidden;">
      <div style="background: ${CARD}; padding: 18px 18px; border-top: 3px solid ${OLIVE};">
        <div style="font-family: 'DM Sans', system-ui, sans-serif; font-size: 12px; font-weight: 500; color: ${INK}; margin-bottom: 8px;">Fix it yourself</div>
        <div style="font-size: 11px; color: ${INK2}; line-height: 1.6;">The recommendations above are actionable. Average fix time: 4–6 hours. No developer needed for most changes.</div>
      </div>
      <div style="background: ${CARD}; padding: 18px 18px; border-top: 3px solid ${GOLD};">
        <div style="font-family: 'DM Sans', system-ui, sans-serif; font-size: 12px; font-weight: 500; color: ${INK}; margin-bottom: 8px;">Track your progress</div>
        <div style="font-size: 11px; color: ${INK2}; line-height: 1.6;">Get continuous monitoring with weekly re-audits. Track competitors. Get alerts when your score changes. <strong style="color: ${GOLD};">$99/mo</strong></div>
      </div>
      <div style="background: ${CARD}; padding: 18px 18px; border-top: 3px solid ${SAGE};">
        <div style="font-family: 'DM Sans', system-ui, sans-serif; font-size: 12px; font-weight: 500; color: ${INK}; margin-bottom: 8px;">Let us build it</div>
        <div style="font-size: 11px; color: ${INK2}; line-height: 1.6;">FlowBlinq builds your AI commerce layer. Schema, structured data, citation optimization. <strong style="color: ${SAGE};">hello@flowblinq.com</strong></div>
      </div>
    </div>

    <div class="mono" style="font-size: 9px; color: ${INK3}; letter-spacing: 2px; margin-top: 18px; text-align: center; text-transform: uppercase;">flowblinq.com/pricing</div>
  </div>

  <!-- ══════════════════════════════════════════════════════════════════════════ -->
  <!-- CLOSING PROJECTED LIFT PANEL (Task 4) -->
  <!-- ══════════════════════════════════════════════════════════════════════════ -->

  ${projectedScore != null && projectedScore > (overallScore ?? 0) ? `
  <div style="background: ${SAGE_WASH}; border: 1px solid ${CREASE}; border-left: 3px solid ${SAGE}; border-radius: 0 6px 6px 0; padding: 18px 24px; margin: 0 0 20px;">
    <div style="font-size: 10px; font-weight: 600; color: ${INK2}; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 8px;">Estimated lift</div>
    <div style="display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px;">
      <span style="font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 22px; font-weight: 700; color: ${INK2};">${overallScore ?? 0}</span>
      ${svgChevron(INK2, 14)}
      <span style="font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 28px; font-weight: 800; color: ${SAGE};">${projectedScore}</span>
      <span style="font-size: 13px; color: ${SAGE}; font-weight: 600;">(+${projectedScore - (overallScore ?? 0)} points)</span>
    </div>
    <div style="font-size: 11px; color: ${INK2};">FlowBlinq auto-installs the fixes above this week.</div>
  </div>
  ` : ""}

  <!-- ══════════════════════════════════════════════════════════════════════════ -->
  <!-- FOOTER -->
  <!-- ══════════════════════════════════════════════════════════════════════════ -->

  <div class="footer">
    <div style="font-size: 10px; font-weight: 700; letter-spacing: 3px; color: ${GOLD};">FLOWBLINQ GEO</div>
    <div style="margin-top: 4px;">Generated ${formatDate(new Date().toISOString())} · ${esc(domain)} · www.flowblinq.com</div>
  </div>

</div>
</body>
</html>`;
}
