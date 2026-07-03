"use client";

import { type CitationCheckScore } from "@/lib/types/citation";
import { type ProviderResult } from "@/lib/types/citation";

// ── Design tokens (warm-light, matches ResultsDashboard) ───────────────────
const TEXT    = "#1c1917";
const TEXT_2  = "#78716c";
const TEXT_3  = "#a8a29e";
const BORDER  = "rgba(0,0,0,0.07)";
const CARD    = "#ffffff";
const TRACK   = "rgba(0,0,0,0.05)";
const GREEN   = "#16a34a";
const AMBER   = "#d97706";
const RED     = "#dc2626";

const SECTION_HEADING: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: TEXT_3,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  margin: "0 0 12px",
};

interface CitationHistoryProps {
  history: CitationCheckScore[];
  domain: string;
}

function buildSparklinePath(values: number[]): string {
  if (values.length < 2) return "";
  const w = 300 - 20;
  const h = 60 - 20;
  const points = values.map((v, i) => {
    const x = 10 + (i / (values.length - 1)) * w;
    const y = 10 + (1 - v / 100) * h;
    return `${x},${y}`;
  });
  return `M ${points.join(" L ")}`;
}

export function CitationHistory({ history, domain }: CitationHistoryProps) {
  if (history.length === 0) {
    return (
      <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 24, textAlign: "center", color: TEXT_2, fontSize: 14 }}>
        No citation checks yet. Run your first check to start tracking AI visibility.
      </div>
    );
  }

  // ── Sub-section A: Visibility Sparkline ───────────────────────────────
  // HP-253: canonical SOV is indirectVisibility. Historical rows pre-fb1d6a0
  // (~2026-05-03) populate only overallVisibility (legacy all-queries metric)
  // — fall back to it so the sparkline doesn't collapse to 0 for old data.
  // The tooltip annotation below acknowledges the legacy/canonical mix.
  const visibilityOf = (h: { indirectVisibility?: number | null; overallVisibility: number }) =>
    h.indirectVisibility || h.overallVisibility;
  const chronological = [...history].reverse();
  const sparklineValues = chronological.map(visibilityOf);
  const first = visibilityOf(chronological[0]);
  const latest = visibilityOf(chronological[chronological.length - 1]);
  const trendColor = latest > first ? GREEN : latest < first ? RED : AMBER;
  const allZero = sparklineValues.every(v => v === 0);
  const sparklinePath = buildSparklinePath(sparklineValues);

  // ── Sub-section B: Provider Aggregation ───────────────────────────────
  type ProviderAgg = { totalVisibility: number; checksWithMention: number; totalChecks: number };
  const agg: Record<string, ProviderAgg> = {};

  for (const check of history) {
    const results = (check.providerResults as ProviderResult[] | null) ?? [];
    for (const pr of results) {
      if (!agg[pr.provider]) agg[pr.provider] = { totalVisibility: 0, checksWithMention: 0, totalChecks: 0 };
      agg[pr.provider].totalVisibility += pr.visibilityScore;
      agg[pr.provider].checksWithMention += pr.mentionCount > 0 ? 1 : 0;
      agg[pr.provider].totalChecks += 1;
    }
  }

  const sortedProviders = Object.entries(agg)
    .map(([provider, data]) => ({
      provider,
      avgVisibility: data.totalChecks > 0 ? Math.round(data.totalVisibility / data.totalChecks) : 0,
      checksWithMention: data.checksWithMention,
      totalChecks: data.totalChecks,
    }))
    .sort((a, b) => b.avgVisibility - a.avgVisibility);

  // ── Sub-section D: Top Competitors Aggregation ─────────────────────────
  const compAgg: Record<string, { total: number; appearances: number }> = {};

  for (const check of history) {
    const cv = (check.competitorVisibility as Record<string, number> | null) ?? {};
    for (const [comp, pct] of Object.entries(cv)) {
      if (!compAgg[comp]) compAgg[comp] = { total: 0, appearances: 0 };
      compAgg[comp].total += pct;
      compAgg[comp].appearances += 1;
    }
  }

  const ranked = Object.entries(compAgg)
    .map(([comp, { total, appearances }]) => ({ comp, avg: Math.round(total / appearances) }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 5);

  const thStyle: React.CSSProperties = { textAlign: "left", padding: "8px 12px", color: TEXT_2, fontWeight: 500, fontSize: 12 };
  const tdStyle: React.CSSProperties = { padding: "10px 12px", fontSize: 13, color: TEXT };

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>

      {/* ── A: Sparkline ──────────────────────────────────────────────── */}
      {history.length === 1 ? (
        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 16, marginBottom: 24, color: TEXT_2, fontSize: 13 }}>
          Only 1 check — run another to see trend.
        </div>
      ) : (
        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 16, marginBottom: 24 }}>
          <div style={{ color: TEXT_3, fontSize: 11, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Visibility Trend for {domain}
          </div>
          <svg viewBox="0 0 300 60" width="100%" style={{ display: "block" }}>
            {(() => {
              // B8: Calculate grid lines from actual data (min/median/max)
              const toY = (v: number) => 10 + (1 - v / 100) * (60 - 20);
              const sorted = [...sparklineValues].sort((a, b) => a - b);
              const minV    = sorted[0];
              const maxV    = sorted[sorted.length - 1];
              const medianV = sorted[Math.floor(sorted.length / 2)];
              const raw = [
                { y: toY(minV),    label: `${minV}%` },
                { y: toY(medianV), label: `${medianV}%` },
                { y: toY(maxV),    label: `${maxV}%` },
              ];
              // Deduplicate: remove entries within 3px of a prior entry
              const gridLines = raw.filter((g, i, arr) =>
                !arr.slice(0, i).some(prev => Math.abs(prev.y - g.y) < 3)
              );
              return gridLines.map((g) => (
                <g key={g.label}>
                  <line x1={10} y1={g.y} x2={290} y2={g.y} stroke={BORDER} strokeWidth={0.5} />
                  <text x={6} y={g.y + 3} fill={TEXT_3} fontSize={7} textAnchor="end">{g.label}</text>
                </g>
              ));
            })()}
            {allZero ? (
              <>
                <line x1={10} y1={50} x2={290} y2={50} stroke={TEXT_3} strokeWidth={1.5} />
                <text x={150} y={45} textAnchor="middle" fill={TEXT_3} fontSize={9}>No mentions recorded</text>
              </>
            ) : (
              <>
                <path d={sparklinePath} stroke={trendColor} strokeWidth={1.5} fill="none" />
                {chronological.map((record, i) => {
                  const x = 10 + (i / (sparklineValues.length - 1)) * (300 - 20);
                  const v = visibilityOf(record);
                  const y = 10 + (1 - v / 100) * (60 - 20);
                  const dateLabel = new Date(record.createdAt!).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
                  return (
                    <circle key={record.checkId ?? i} cx={x} cy={y} r={3} fill={trendColor}>
                      <title>{dateLabel}: {v}%</title>
                    </circle>
                  );
                })}
              </>
            )}
          </svg>
        </div>
      )}

      {/* ── B: History Table ──────────────────────────────────────────── */}
      <h3 style={SECTION_HEADING}>Check History</h3>
      <div style={{ overflowX: "auto", marginBottom: 32 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
              {["Date", "Visibility %", "Best Provider", "Average Position", "Sentiment", "Credits Used"].map(h => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {history.flatMap((row, i) => {
              const next = history[i + 1];
              let delta: string | null = null;
              let deltaColor = TEXT_3;
              if (next !== undefined) {
                const diff = visibilityOf(row) - visibilityOf(next);
                if (diff > 0) { delta = "▲"; deltaColor = GREEN; }
                else if (diff < 0) { delta = "▼"; deltaColor = RED; }
                else { delta = "—"; }
              }
              const sentimentScore = row.sentimentScore ?? 0;
              const sentiment = sentimentScore > 0 ? "Positive" : sentimentScore < 0 ? "Negative" : "Neutral";
              const dateStr = new Date(row.createdAt!).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
              const thisIsV2 = (row as { promptArchitectureVersion?: number }).promptArchitectureVersion === 2;
              const nextIsNotV2 = next !== undefined && (next as { promptArchitectureVersion?: number }).promptArchitectureVersion !== 2;
              const rowEl = (
                <tr key={row.checkId ?? i} style={{ borderBottom: `1px solid ${TRACK}` }}>
                  <td style={tdStyle}>{dateStr}</td>
                  <td style={tdStyle}>
                    {visibilityOf(row)}%{" "}
                    {delta && <span style={{ color: deltaColor, marginLeft: 4 }}>{delta}</span>}
                  </td>
                  <td style={{ ...tdStyle, color: TEXT_2 }}>{row.bestProvider ?? "—"}</td>
                  <td style={{ ...tdStyle, color: TEXT_2 }}>{row.avgPosition ?? "—"}</td>
                  <td style={{ ...tdStyle, color: sentimentScore > 0 ? GREEN : sentimentScore < 0 ? RED : TEXT_3 }}>{sentiment}</td>
                  <td style={{ ...tdStyle, color: TEXT_2 }}>{row.creditsUsed ?? "—"}</td>
                </tr>
              );
              if (!(thisIsV2 && nextIsNotV2)) return [rowEl];
              return [
                rowEl,
                <tr key={`v1v2-banner-${i}`}>
                  <td colSpan={6} style={{
                    padding: "8px 12px",
                    background: `${AMBER}08`,
                    borderTop: `1px solid ${AMBER}30`,
                    borderBottom: `1px solid ${AMBER}30`,
                    fontSize: 11,
                    color: AMBER,
                    fontWeight: 500,
                  }}>
                    Measurement upgraded — scores after this date use improved prompts
                  </td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>

      {/* ── C: Provider Consistency Table ──────────────────────────────── */}
      {sortedProviders.length > 0 && (
        <>
          <h3 style={SECTION_HEADING}>Provider Consistency</h3>
          <div style={{ overflowX: "auto", marginBottom: 32 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                  {["Provider", "Avg Visibility %", "Checks With Mention", "Total Checks"].map(h => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedProviders.map(p => (
                  <tr key={p.provider} style={{ borderBottom: `1px solid ${TRACK}` }}>
                    <td style={{ ...tdStyle, textTransform: "capitalize", fontWeight: 600 }}>{p.provider}</td>
                    <td style={tdStyle}>{p.avgVisibility}%</td>
                    <td style={{ ...tdStyle, color: TEXT_2 }}>{p.checksWithMention}</td>
                    <td style={{ ...tdStyle, color: TEXT_2 }}>{p.totalChecks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── D: Top Competitors ─────────────────────────────────────────── */}
      <h3 style={SECTION_HEADING}>Top Competitors (History)</h3>
      {ranked.length === 0 ? (
        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 16, color: TEXT_2, fontSize: 13 }}>
          No competitors detected across your citation history.
        </div>
      ) : (
        <ul style={{ padding: "0 0 0 16px", marginBottom: 24 }}>
          {ranked.map(({ comp, avg }) => (
            <li key={comp} style={{ color: TEXT_2, marginBottom: 6, fontSize: 13 }}>
              <strong style={{ color: TEXT }}>{comp}</strong> — {avg}% avg visibility
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
