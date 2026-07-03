"use client";

import { useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Cell, LabelList,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
} from "recharts";
import { ResponsiveContainer } from "recharts";
import { type CitationCheckResult, type CitationCheckScore, type PillarQA, type PillarQASample } from "@/lib/types/citation";
import type { CompetitorCitationData } from "@/lib/types/citation";

// ── Design tokens (warm-light, matches ResultsDashboard) ───────────────────
const TEXT    = "#1c1917";
const TEXT_2  = "#78716c";
const TEXT_3  = "#a8a29e";
const BORDER  = "rgba(0,0,0,0.07)";
const TRACK   = "#e8e5e0";
const GREEN   = "#16a34a";
const AMBER   = "#d97706";
const RED     = "#dc2626";
const ACCENT  = "#b45309";

// ── V2 buyer-facing pillars (7 pillars from citation check seed templates) ─
const V2_BUYER_PILLARS = [
  "competitive_positioning",
  "offering_clarity",
  "evidence_statistics",
  "contact_trust",
  "author_authority",
  "licensing_signals",
  "cta_structure",
];

// ── Pillar labels ──────────────────────────────────────────────────────────
const PILLAR_LABELS: Record<string, string> = {
  author_authority:        "Authority",
  competitive_positioning: "Positioning",
  offering_clarity:        "Clarity",
  faq_coverage:            "FAQ",
  evidence_statistics:     "Evidence",
  contact_trust:           "Trust",
  content_freshness:       "Freshness",
  structured_data:         "Structured",
  entity_definitions:      "Entities",
  metadata_freshness:      "Meta",
  semantic_html:           "Semantic",
  multi_format:            "Formats",
  licensing_signals:       "Licensing",
  internal_linking:        "Linking",
  content_structure:       "Structure",
  cta_structure:           "CTA",
};
const PILLARS = Object.keys(PILLAR_LABELS);

// ── Helpers ────────────────────────────────────────────────────────────────

function pillarColor(score: number): string {
  if (score === 0) return TEXT_3;
  if (score < 20) return RED;
  if (score < 60) return AMBER;
  return GREEN;
}

function priorityDotColor(score: number): string {
  if (score === 0) return TEXT_3;
  if (score < 20) return RED;
  if (score < 60) return AMBER;
  return GREEN;
}

const SECTION_HEADING: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: TEXT_3,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  margin: "0 0 12px",
};

// ── Arc gauge helpers ──────────────────────────────────────────────────────

function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const startRad = (startDeg * Math.PI) / 180;
  const endRad   = (endDeg   * Math.PI) / 180;
  const x1 = cx + r * Math.cos(startRad);
  const y1 = cy + r * Math.sin(startRad);
  const x2 = cx + r * Math.cos(endRad);
  const y2 = cy + r * Math.sin(endRad);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
}

export function ScoreArc({ value, label, size = 80 }: { value: number; label: string; size?: number }) {
  const r          = (size - 8) / 2;
  const cx         = size / 2;
  const cy         = size / 2;
  const startAngle = 150;          // 7 o'clock
  const endAngle   = 390;          // 5 o'clock — 240° sweep
  const sweepAngle = endAngle - startAngle;

  const trackPath = describeArc(cx, cy, r, startAngle, endAngle);
  const valueEnd  = startAngle + (value / 100) * sweepAngle;
  const valuePath = describeArc(cx, cy, r, startAngle, Math.max(startAngle + 1, valueEnd));

  const color = value >= 60 ? GREEN : value >= 20 ? AMBER : RED;

  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
      background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12,
      padding: "16px 20px 12px",
      boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
    }}>
      <svg
        data-testid="score-arc"
        role="img"
        aria-label={`${label}: ${value}%`}
        width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      >
        <title>{label}: {value}%</title>
        <path d={trackPath} fill="none" stroke={TRACK} strokeWidth={6} strokeLinecap="round" />
        {value > 0 && (
          <path d={valuePath} fill="none" stroke={color} strokeWidth={6} strokeLinecap="round" />
        )}
        <text
          x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
          fill={color} fontSize={20} fontWeight={700} fontFamily="system-ui"
        >
          {value}%
        </text>
      </svg>
      <span style={{ fontSize: 11, fontWeight: 500, color: TEXT_2 }}>{label}</span>
    </div>
  );
}

// ── Custom radar tick: horizontal text + direct score label ────────────────

function HorizontalAxisTick({
  payload, x, y, cx, cy, radarData = [],
}: {
  payload?: { value: string };
  x?: number; y?: number; cx?: number; cy?: number;
  radarData?: Array<{ subject: string; score: number; fullMark: number }>;
}) {
  const px = x ?? 0; const py = y ?? 0; const pcx = cx ?? 0; const pcy = cy ?? 0;
  const score = radarData.find(d => d.subject === payload?.value)?.score ?? 0;
  const color = pillarColor(score);
  const dx = px - pcx; const dy = py - pcy;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const offsetX = px + (dx / dist) * 14;
  const offsetY = py + (dy / dist) * 8;
  const anchor = offsetX > pcx ? "start" : offsetX < pcx ? "end" : "middle";
  return (
    <g>
      <text x={offsetX} y={offsetY} textAnchor={anchor} fill={TEXT_3} fontSize={10} fontWeight={600} dominantBaseline="central">
        {payload?.value}
      </text>
      <text x={offsetX} y={offsetY + 12} textAnchor={anchor} fill={color} fontSize={9} fontWeight={700} dominantBaseline="central">
        {score}%
      </text>
    </g>
  );
}

// ── Props ──────────────────────────────────────────────────────────────────

interface GeoScorecardPillar {
  pillar: string;
  pillarName: string;
  score: number;
}

interface CitationAnalyticsProps {
  result: CitationCheckResult | CitationCheckScore | null;
  domain: string;
  geoScorecard?: { pillars: GeoScorecardPillar[] } | null;
}

// ── Type guards ────────────────────────────────────────────────────────────

function isCitationCheckResult(r: CitationCheckResult | CitationCheckScore): r is CitationCheckResult {
  return "scores" in r && typeof (r as CitationCheckResult).scores === "object";
}

function getScores(r: CitationCheckResult | CitationCheckScore) {
  if (isCitationCheckResult(r)) {
    return {
      indirectVisibility:   r.scores.indirectVisibility   ?? 0,
      brandKnowledge:       r.scores.brandKnowledge       ?? 0,
      citationQualityScore: r.scores.citationQualityScore ?? 0,
      pillarVisibility:     (r.scores.pillarVisibility ?? {}) as Record<string, number>,
      pillarQA:             (r.scores.pillarQA ?? {}) as Record<string, PillarQA>,
      competitorData:       (r.scores.competitorData ?? []) as CompetitorCitationData[],
    };
  }
  return {
    indirectVisibility:   r.indirectVisibility,
    brandKnowledge:       r.brandKnowledge,
    citationQualityScore: r.citationQualityScore,
    pillarVisibility:     (r.pillarVisibility ?? {}) as Record<string, number>,
    pillarQA:             (r.pillarQA ?? {}) as Record<string, PillarQA>,
    competitorData:       (r.competitorData ?? []) as CompetitorCitationData[],
  };
}

// ── Theme row with expandable Q&A accordion ────────────────────────────────

function ThemeRow({ pillar, score, label, qa, rank }: {
  pillar: string; score: number; label: string; qa: PillarQA | undefined; rank: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const color      = pillarColor(score);
  const dotColor   = priorityDotColor(score);
  const hasSamples = (qa?.samples?.length ?? 0) > 0;

  return (
    <div style={{
      borderBottom: `1px solid ${BORDER}`,
    }}>
      {/* Row header — always visible */}
      <button
        className="ca-interactive"
        onClick={() => hasSamples && setExpanded(e => !e)}
        tabIndex={hasSamples ? undefined : -1}
        aria-disabled={hasSamples ? undefined : "true"}
        style={{
          display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12,
          width: "100%", textAlign: "left",
          background: "none", border: "none",
          cursor: hasSamples ? "pointer" : "default",
          padding: "10px 12px",
        }}
      >
        {/* Priority dot */}
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          background: dotColor,
          flexShrink: 0,
        }} />

        {/* Rank number */}
        <span style={{ fontSize: 10, color: TEXT_3, width: 16, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
          {rank}
        </span>

        {/* Theme label */}
        <span
          className="ca-theme-row-label"
          title={label}
          style={{ fontSize: 12, fontWeight: 600, color: score === 0 ? TEXT_3 : TEXT, minWidth: 70, maxWidth: 120, flexShrink: 0 }}
        >
          {label}
        </span>

        {/* Score bar */}
        <div style={{ flex: 1, height: 4, background: TRACK, borderRadius: 2, minWidth: 0 }}>
          {score > 0 && (
            <div style={{ height: "100%", width: `${score}%`, background: color, borderRadius: 2, transition: "width 0.4s" }} />
          )}
        </div>

        {/* Score % */}
        <span style={{
          fontSize: 12, fontWeight: 700, color,
          fontVariantNumeric: "tabular-nums",
          width: 36, textAlign: "right", flexShrink: 0,
        }}>
          {score}%
        </span>

        {/* Competitor badge */}
        {qa?.topCompetitor && (
          <span className="ca-theme-competitor-badge" style={{
            fontSize: 9, fontWeight: 600, color: AMBER,
            background: AMBER + "18", border: `1px solid ${AMBER}30`,
            borderRadius: 4, padding: "1px 5px",
            maxWidth: 64, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            flexShrink: 0,
          }}>
            vs {qa.topCompetitor}
          </span>
        )}

        {/* Expand chevron */}
        {hasSamples && (
          <span style={{ fontSize: 9, color: TEXT_3, flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>
        )}
      </button>

      {/* Expandable Q&A panel */}
      {expanded && hasSamples && (
        <div style={{ padding: "0 12px 12px 36px", display: "flex", flexDirection: "column", gap: 10 }}>
          {qa!.samples.map((s: PillarQASample, i: number) => (
            <div key={i} style={{
              background: s.mentioned ? GREEN + "08" : RED + "06",
              border: `1px solid ${s.mentioned ? GREEN + "25" : RED + "20"}`,
              borderRadius: 6, padding: "8px 10px",
            }}>
              {/* Q */}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: TEXT_3, marginTop: 1, flexShrink: 0 }}>Q</span>
                <p style={{ margin: 0, fontSize: 11, color: TEXT, lineHeight: 1.5, fontStyle: "italic" }}>{s.question}</p>
              </div>
              {/* A */}
              {s.answer && (
                <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 6 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: TEXT_3, marginTop: 1, flexShrink: 0 }}>A</span>
                  <p style={{ margin: 0, fontSize: 11, color: TEXT_2, lineHeight: 1.6 }}>
                    {s.answer.length > 300 ? s.answer.slice(0, 300) + "…" : s.answer}
                  </p>
                </div>
              )}
              {/* Footer */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                <span style={{
                  fontSize: 9, fontWeight: 700,
                  color: s.mentioned ? GREEN : RED,
                  background: (s.mentioned ? GREEN : RED) + "15",
                  border: `1px solid ${(s.mentioned ? GREEN : RED) + "30"}`,
                  borderRadius: 4, padding: "1px 5px",
                }}>
                  {s.mentioned ? "✓ Cited" : "✗ Not cited"}
                </span>
                <span style={{ fontSize: 9, color: TEXT_3 }}>via {s.provider}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

export function CitationAnalytics({ result, domain, geoScorecard }: CitationAnalyticsProps) {
  if (!result) {
    return (
      <div style={{ textAlign: "center", color: TEXT_2, fontSize: 14, padding: "48px 0" }}>
        Run a citation check to see analytics.
      </div>
    );
  }

  const scores = getScores(result);

  // Extract providerResults from result (flat on CitationCheckScore, nested on CitationCheckResult)
  const providerResults: Array<{ provider: string; visibilityScore: number }> =
    isCitationCheckResult(result)
      ? ((result.scores as Record<string, unknown>).providerResults as Array<{ provider: string; visibilityScore: number }> ?? [])
      : (result.providerResults as Array<{ provider: string; visibilityScore: number }> ?? []);

  // ── V2 detection (works for both SSE CitationCheckResult and preloaded CitationCheckScore)
  const isV2 = (result as { promptArchitectureVersion?: number }).promptArchitectureVersion === 2;

  // ── Section A — Theme Visibility (ranked, worst first) ─────────────────
  const hasPillarStructure = Object.keys(scores.pillarVisibility).length > 0;

  // Sort ascending by score so worst themes appear first (highest priority)
  const rankedPillars = PILLARS
    .map(p => ({ key: p, label: PILLAR_LABELS[p], score: scores.pillarVisibility[p] ?? 0 }))
    .sort((a, b) => a.score - b.score);

  const zeroCount = rankedPillars.filter(p => p.score === 0).length;

  // V2: buyer-facing pillars only (7 pillars from citation check prompts)
  const rankedBuyerPillars = V2_BUYER_PILLARS
    .map(p => ({ key: p, label: PILLAR_LABELS[p], score: scores.pillarVisibility[p] ?? 0 }))
    .sort((a, b) => a.score - b.score);
  const buyerZeroCount = rankedBuyerPillars.filter(p => p.score === 0).length;

  const themeVisibility = isV2 ? (
    // V2 split view: "AI Citation Visibility" (7 buyer pillars from citation check)
    <div style={{ marginBottom: 32 }}>
      <h3 style={SECTION_HEADING}>AI Citation Visibility</h3>
      {hasPillarStructure ? (
        <>
          <p style={{ fontSize: 12, color: TEXT_2, margin: "0 0 6px", lineHeight: 1.5 }}>
            How visible <strong style={{ color: TEXT }}>{domain}</strong> is per buyer-facing topic.{" "}
            Click any theme to see sample Q&amp;A from AI providers.
          </p>
          <p style={{ fontSize: 11, color: TEXT_3, margin: "0 0 12px" }}>
            {rankedBuyerPillars.length} themes — focus on highlighted
          </p>
          <div style={{
            border: `1px solid ${BORDER}`,
            borderRadius: 10,
            overflow: "hidden",
            background: "#fff",
          }}>
            {rankedBuyerPillars.map((p, idx) => (
              <ThemeRow
                key={p.key}
                pillar={p.key}
                score={p.score}
                label={p.label}
                qa={scores.pillarQA[p.key]}
                rank={idx + 1}
              />
            ))}
          </div>
          {buyerZeroCount > 0 && (
            <p style={{ fontSize: 11, color: TEXT_3, margin: "8px 0 0", lineHeight: 1.5 }}>
              {buyerZeroCount} theme{buyerZeroCount > 1 ? "s" : ""} with no visibility — highest-priority GEO opportunities.
            </p>
          )}
        </>
      ) : (
        <p style={{ color: TEXT_2, fontSize: 13 }}>No pillar data yet. Run a citation check to see AI Citation Visibility.</p>
      )}
    </div>
  ) : (
    // V1 unified view: all 16 pillars
    <div style={{ marginBottom: 32 }}>
      <h3 style={SECTION_HEADING}>GEO Pillar Visibility</h3>
      {hasPillarStructure ? (
        <>
          <p style={{ fontSize: 12, color: TEXT_2, margin: "0 0 6px", lineHeight: 1.5 }}>
            How visible <strong style={{ color: TEXT }}>{domain}</strong> is per GEO topic area.{" "}
            Click any theme to see sample Q&amp;A from AI providers.
          </p>
          <p style={{ fontSize: 11, color: TEXT_3, margin: "0 0 12px" }}>
            {rankedPillars.length} themes — focus on highlighted
          </p>
          <div style={{
            border: `1px solid ${BORDER}`,
            borderRadius: 10,
            overflow: "hidden",
            background: "#fff",
          }}>
            {rankedPillars.map((p, idx) => (
              <ThemeRow
                key={p.key}
                pillar={p.key}
                score={p.score}
                label={p.label}
                qa={scores.pillarQA[p.key]}
                rank={idx + 1}
              />
            ))}
          </div>
          {zeroCount > 0 && (
            <p style={{ fontSize: 11, color: TEXT_3, margin: "8px 0 0", lineHeight: 1.5 }}>
              {zeroCount} theme{zeroCount > 1 ? "s" : ""} with no visibility — these are your highest-priority GEO opportunities.
            </p>
          )}
        </>
      ) : (
        <p style={{ color: TEXT_2, fontSize: 13 }}>No pillar data yet. Run a citation check to see GEO Pillar Visibility.</p>
      )}
    </div>
  );

  // ── V2: Content Quality Scores (from geoScorecard audit) ────────────────
  const contentQualitySection = isV2 && geoScorecard ? (
    <div style={{ marginBottom: 32 }}>
      <h3 style={SECTION_HEADING}>Content Quality Scores</h3>
      <p style={{ fontSize: 12, color: TEXT_2, margin: "0 0 12px", lineHeight: 1.5 }}>
        Based on content audit — all 16 GEO pillars scored deterministically.
      </p>
      <div style={{
        border: `1px solid ${BORDER}`,
        borderRadius: 10,
        overflow: "hidden",
        background: "#fff",
      }}>
        {[...geoScorecard.pillars]
          .sort((a, b) => a.score - b.score)
          .map((p, idx) => (
            <div key={p.pillar} style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "8px 12px",
              borderBottom: idx < geoScorecard.pillars.length - 1 ? `1px solid ${BORDER}` : "none",
            }}>
              <span style={{ fontSize: 10, color: TEXT_3, width: 16, flexShrink: 0 }}>{idx + 1}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: p.score === 0 ? TEXT_3 : TEXT, flex: "0 0 90px", flexShrink: 0 }}>
                {PILLAR_LABELS[p.pillar] ?? p.pillarName}
              </span>
              <div style={{ flex: 1, height: 4, background: TRACK, borderRadius: 2 }}>
                {p.score > 0 && (
                  <div style={{ height: "100%", width: `${p.score}%`, background: pillarColor(p.score), borderRadius: 2, transition: "width 0.4s" }} />
                )}
              </div>
              <span style={{ fontSize: 12, fontWeight: 700, color: pillarColor(p.score), width: 36, textAlign: "right", flexShrink: 0 }}>
                {p.score}
              </span>
            </div>
          ))}
      </div>
    </div>
  ) : null;

  // ── Section B — Radar chart ──────────────────────────────────────────────
  // B1: V2 uses 7 buyer pillars; V1 uses all 16. D1+D2: horizontal labels with direct scores.
  const activePillars = isV2 ? V2_BUYER_PILLARS : PILLARS;
  const radarData = activePillars.map(p => ({
    subject:  PILLAR_LABELS[p] ?? p,
    score:    scores.pillarVisibility[p] ?? 0,
    fullMark: 100,
  }));

  const radarChart = hasPillarStructure ? (
    <div style={{ marginBottom: 32 }}>
      <h3 style={SECTION_HEADING}>Theme Coverage</h3>
      <p style={{ fontSize: 12, color: TEXT_2, margin: "0 0 14px", lineHeight: 1.5 }}>
        {isV2
          ? "AI visibility across 7 buyer-facing themes. A wider shape means broader coverage."
          : "AI visibility across all 16 GEO themes. A wider shape means broader coverage."}
      </p>
      <div className="ca-radar-container" role="img" aria-label="Theme visibility radar chart" style={{ height: 340, width: "100%" }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={radarData} margin={{ top: 10, right: 30, bottom: 10, left: 30 }}>
          <PolarGrid stroke={BORDER} />
          <PolarAngleAxis
            dataKey="subject"
            tick={<HorizontalAxisTick radarData={radarData} />}
          />
          <PolarRadiusAxis
            angle={90}
            domain={[0, 100]}
            tick={{ fill: TEXT_3, fontSize: 9 }}
            tickCount={4}
            axisLine={false}
          />
          <Radar
            name="Visibility"
            dataKey="score"
            stroke={AMBER}
            fill={AMBER}
            fillOpacity={0.18}
            strokeWidth={2}
          />
        </RadarChart>
      </ResponsiveContainer>
      </div>
    </div>
  ) : null;

  // ── Section C — Competitor bars ────────────────────────────────────────
  // B9: Add brand as first bar with ACCENT color. Direct labels via LabelList.

  const brandName = domain.replace(/^www\./, "").replace(/\.(com|io|co|net|org).*$/, "") + " (you)";
  const brandEntry = {
    name:         brandName,
    shareOfVoice: scores.indirectVisibility,
    rankedAbove:  0,
    sentiment:    "positive" as const,
    isBrand:      true,
  };

  const competitorRows = scores.competitorData.length > 0
    ? [
        brandEntry,
        ...scores.competitorData
          .sort((a, b) => b.shareOfVoice - a.shareOfVoice)
          .slice(0, 7)
          .map(c => ({
            name:         c.name,
            shareOfVoice: c.shareOfVoice,
            rankedAbove:  c.rankedAbove,
            sentiment:    c.sentiment,
            isBrand:      false,
          })),
      ]
    : [];

  const competitorBars = competitorRows.length > 1 ? (
    <div style={{ marginBottom: 16 }}>
      <h3 style={SECTION_HEADING}>Competitor Share of Voice</h3>
      <p style={{ fontSize: 12, color: TEXT_2, margin: "0 0 14px", lineHeight: 1.5 }}>
        Share of Voice (SOV) — how often each domain appears in AI responses. Higher = more mindshare.
      </p>
      <div className="ca-competitor-chart" role="img" aria-label="Competitor share of voice" style={{ minWidth: 0 }}>
      <ResponsiveContainer width="100%" height={Math.max(160, competitorRows.length * 40)}>
        <BarChart data={competitorRows} layout="vertical" margin={{ left: 100, right: 48, top: 4, bottom: 4 }}>
          <XAxis type="number" domain={[0, 100]} tick={{ fill: TEXT_2, fontSize: 10 }} axisLine={{ stroke: BORDER }} tickLine={false} />
          <YAxis type="category" dataKey="name" tick={{ fill: TEXT_2, fontSize: 10 }} width={100} axisLine={false} tickLine={false} />
          <Bar dataKey="shareOfVoice" radius={[0, 4, 4, 0]}>
            <LabelList dataKey="shareOfVoice" position="right" fill={TEXT_2} fontSize={10} formatter={(v) => `${v}%`} />
            {competitorRows.map((entry, i) => (
              <Cell
                key={entry.name}
                fill={entry.isBrand ? ACCENT : entry.sentiment === "positive" ? GREEN : entry.sentiment === "negative" ? RED : AMBER}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      </div>
    </div>
  ) : null;

  return (
    <div style={{ paddingTop: 4 }}>
      <style>{`
        .ca-interactive { transition: background-color 0.15s ease; cursor: pointer; }
        .ca-interactive:hover { background-color: ${TRACK} !important; }
        .ca-interactive:active { background-color: rgba(0,0,0,0.06) !important; }
        @media (max-width: 640px) {
          .ca-radar-container { height: 260px !important; }
          .ca-competitor-chart { overflow-x: auto !important; }
          .ca-theme-row-label { min-width: 60px !important; max-width: 90px !important; white-space: normal !important; line-height: 1.3 !important; }
          .ca-theme-competitor-badge { display: block !important; margin-top: 2px; margin-left: 26px; }
          .ca-section-heading { font-size: 10px !important; margin-bottom: 8px !important; }
        }
        @media (max-width: 768px) {
          .ca-radar-container { height: 300px !important; }
        }
      `}</style>
      {/* B2/C2: Score Overview — arc gauges with visual containment */}
      <div style={{ marginBottom: 24 }}>
        <h3 style={SECTION_HEADING}>Score Overview</h3>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <ScoreArc value={scores.indirectVisibility}   label="Overall Visibility" />
          <ScoreArc value={scores.brandKnowledge}       label="Brand Knowledge" />
          <ScoreArc value={scores.citationQualityScore} label="Citation Quality" />
        </div>
      </div>
      {/* Provider Visibility — per-provider breakdown */}
      {providerResults.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={SECTION_HEADING}>Provider Visibility</h3>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {providerResults.map((p) => (
              <div key={p.provider} style={{ fontSize: 13, color: TEXT_2 }}>
                <strong style={{ color: TEXT }}>{p.provider}</strong>: {p.visibilityScore}%
              </div>
            ))}
          </div>
        </div>
      )}
      {themeVisibility}
      {contentQualitySection}
      {radarChart}
      {competitorBars}
    </div>
  );
}
