"use client";

import { useState } from "react";
import type { ChangeLogEntry } from "../types";
import { BORDER, GREEN, ORANGE, RED, T2, T3, TEXT, formatDate } from "../design-tokens";

interface HistoryTabProps {
  changeLog: ChangeLogEntry[];
  isMobile: boolean;
}

// ── Score history chart ───────────────────────────────────────────────────────

function ScoreChart({ entries, isMobile }: { entries: ChangeLogEntry[]; isMobile: boolean }) {
  if (entries.length === 0) return null;

  const HEIGHT = 120;
  const LABEL_W = 32; // y-axis label column width
  const POINT_R = 5;
  const chartW = isMobile ? 280 : 480;
  const innerW = chartW - LABEL_W;
  const PAD_TOP = 10;
  const PAD_BOTTOM = 20; // space for x-axis dates

  // Trend colour
  const first = entries[0].overallScore;
  const last = entries[entries.length - 1].overallScore;
  const trendColor = last > first ? GREEN : last < first ? RED : T3;

  // Map score (0-100) → y pixel (top = high score)
  const toY = (score: number) =>
    PAD_TOP + ((100 - score) / 100) * (HEIGHT - PAD_TOP - PAD_BOTTOM);

  // Map index → x pixel
  const toX = (i: number) =>
    entries.length === 1
      ? LABEL_W + innerW / 2
      : LABEL_W + (i / (entries.length - 1)) * innerW;

  const points = entries.map((e, i) => ({ x: toX(i), y: toY(e.overallScore), entry: e }));

  // SVG polyline points string
  const linePoints = points.map(p => `${p.x},${p.y}`).join(" ");

  const yTicks = [0, 25, 50, 75, 100];

  return (
    <div style={{ marginBottom: 24, overflowX: "auto" }}>
      <svg
        width={chartW}
        height={HEIGHT}
        style={{ display: "block", fontFamily: "inherit" }}
        aria-label="Score history chart"
      >
        {/* Y-axis grid lines and labels */}
        {yTicks.map(tick => {
          const y = toY(tick);
          return (
            <g key={tick}>
              <line
                x1={LABEL_W}
                y1={y}
                x2={chartW}
                y2={y}
                stroke={BORDER}
                strokeWidth={1}
                strokeDasharray={tick === 0 ? "none" : "3 3"}
              />
              <text
                x={LABEL_W - 6}
                y={y + 4}
                textAnchor="end"
                fontSize={10}
                fill={T3}
              >
                {tick}
              </text>
            </g>
          );
        })}

        {/* Trend line connecting dots */}
        {points.length > 1 && (
          <polyline
            points={linePoints}
            fill="none"
            stroke={trendColor}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.7}
          />
        )}

        {/* Dots + x-axis date labels */}
        {points.map((p, i) => {
          const score = p.entry.overallScore;
          const dotColor = score >= 75 ? GREEN : score >= 50 ? ORANGE : RED;
          // Show date only for first, last, and middle (to avoid crowding)
          const showLabel =
            entries.length <= 4 ||
            i === 0 ||
            i === entries.length - 1 ||
            i === Math.floor(entries.length / 2);
          const rawDate = new Date(p.entry.runAt);
          const label = rawDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
          return (
            <g key={p.entry.runAt}>
              <circle cx={p.x} cy={p.y} r={POINT_R} fill={dotColor} stroke="#fff" strokeWidth={1.5} />
              {showLabel && (
                <text
                  x={p.x}
                  y={HEIGHT - 4}
                  textAnchor="middle"
                  fontSize={9}
                  fill={T2}
                >
                  {label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Pillar delta row ──────────────────────────────────────────────────────────

function PillarDeltas({
  current,
  previous,
}: {
  current: Record<string, number>;
  previous: Record<string, number> | null;
}) {
  if (!previous) {
    // First run — just show all pillars as baselines
    return (
      <div style={{ padding: "10px 16px 12px", background: "#f9f9fb", borderTop: "1px solid #f0f0f2" }}>
        <div style={{ fontSize: 11, color: T3, marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Baseline scores
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
          {Object.entries(current).map(([pillar, score]) => (
            <span key={pillar} style={{ fontSize: 12, color: T2 }}>
              <span style={{ color: TEXT, fontWeight: 600 }}>{score}</span> {pillar}
            </span>
          ))}
        </div>
      </div>
    );
  }

  const allPillars = Array.from(new Set([...Object.keys(current), ...Object.keys(previous)]));
  const deltas = allPillars
    .map(p => ({ pillar: p, delta: (current[p] ?? 0) - (previous[p] ?? 0) }))
    .filter(d => d.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)); // biggest change first

  const unchanged = allPillars.filter(
    p => (current[p] ?? 0) - (previous[p] ?? 0) === 0
  );

  if (deltas.length === 0) {
    return (
      <div style={{ padding: "10px 16px 12px", background: "#f9f9fb", borderTop: "1px solid #f0f0f2" }}>
        <span style={{ fontSize: 12, color: T3 }}>No pillar changes this run.</span>
      </div>
    );
  }

  return (
    <div style={{ padding: "10px 16px 12px", background: "#f9f9fb", borderTop: "1px solid #f0f0f2" }}>
      <div style={{ fontSize: 11, color: T3, marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        Pillar changes
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
        {deltas.map(({ pillar, delta }) => (
          <span key={pillar} style={{ fontSize: 12 }}>
            <span
              style={{
                fontWeight: 700,
                color: delta > 0 ? GREEN : RED,
                marginRight: 3,
              }}
            >
              {delta > 0 ? `+${delta}` : String(delta)}
            </span>
            <span style={{ color: TEXT }}>{pillar}</span>
          </span>
        ))}
        {unchanged.length > 0 && (
          <span style={{ fontSize: 12, color: T3 }}>
            {unchanged.join(", ")} unchanged
          </span>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function HistoryTab({ changeLog, isMobile }: HistoryTabProps) {
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());

  // Sort ascending by runAt so deltas compare chronologically
  const sorted = [...changeLog].sort(
    (a, b) => new Date(a.runAt).getTime() - new Date(b.runAt).getTime()
  );

  function toggleRow(i: number) {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  if (sorted.length === 0) {
    return (
      <div>
        <div style={{ textAlign: "center", padding: "60px 20px" }}>
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke={T3} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 16 }}>
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>No history yet</div>
          <div style={{ fontSize: 13, color: T2, maxWidth: 360, margin: "0 auto" }}>
            Run your first GEO audit to start tracking your score over time.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Score history chart */}
      <ScoreChart entries={sorted} isMobile={isMobile} />

      {/* Column headers */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 0 8px",
          gap: isMobile ? 8 : 16,
          borderBottom: `2px solid ${BORDER}`,
        }}
      >
        {!isMobile && (
          <span style={{ fontSize: 11, fontWeight: 700, width: 140, flexShrink: 0, color: T3, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Date
          </span>
        )}
        <span style={{ fontSize: 11, fontWeight: 700, width: isMobile ? 36 : 50, flexShrink: 0, color: T3, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Score
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, width: isMobile ? 40 : 60, flexShrink: 0, color: T3, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Change
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, flex: 1, color: T3, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          {isMobile ? "" : "Trend"}
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, width: 20, flexShrink: 0 }} />
      </div>

      {/* Rows */}
      {sorted.map((entry, i) => {
        const prev = i > 0 ? sorted[i - 1] : null;
        const delta = prev != null ? entry.overallScore - prev.overallScore : null;
        const deltaClass = delta == null ? "flat" : delta > 0 ? "up" : delta < 0 ? "dn" : "flat";
        const barColor = entry.overallScore >= 75 ? GREEN : entry.overallScore >= 50 ? ORANGE : RED;
        const isExpanded = expandedRows.has(i);

        return (
          <div key={entry.runAt} style={{ borderBottom: `1px solid #f0f0f2` }}>
            {/* Main row — clickable */}
            <div
              onClick={() => toggleRow(i)}
              style={{
                display: "flex",
                alignItems: "center",
                padding: "12px 0",
                gap: isMobile ? 8 : 16,
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              {!isMobile && (
                <span style={{ fontSize: 13, fontWeight: 600, width: 140, flexShrink: 0 }}>
                  {formatDate(entry.runAt)}
                </span>
              )}
              <span style={{ fontSize: isMobile ? 16 : 20, fontWeight: 700, width: isMobile ? 36 : 50, flexShrink: 0 }}>
                {entry.overallScore}
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  width: isMobile ? 40 : 60,
                  flexShrink: 0,
                  color: deltaClass === "up" ? GREEN : deltaClass === "dn" ? RED : T3,
                }}
              >
                {delta == null ? "—" : delta > 0 ? `+${delta}` : String(delta)}
              </span>
              <div style={{ flex: 1, height: 6, background: "#f0f0f2", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ width: `${entry.overallScore}%`, height: "100%", borderRadius: 3, background: barColor }} />
              </div>
              {/* Chevron */}
              <svg
                width={14}
                height={14}
                viewBox="0 0 24 24"
                fill="none"
                stroke={T3}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                  flexShrink: 0,
                  transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
                  transition: "transform 0.15s ease",
                }}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>

            {/* Expanded pillar detail */}
            {isExpanded && (
              <PillarDeltas
                current={entry.pillarScores}
                previous={prev ? prev.pillarScores : null}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
